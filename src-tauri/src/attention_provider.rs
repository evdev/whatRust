//! Bounded categorical decisions for Needs Attention. Provider answers are
//! untrusted suggestions. The caller owns message and obligation validation.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    sync::OnceLock,
    time::Duration,
};

pub(crate) const MAX_QUESTIONS: usize = 64;
pub(crate) const MAX_CHOICES: usize = 32;
pub(crate) const MAX_REQUEST_BYTES: usize = 24 * 1024;
const MAX_RESPONSE_BYTES: u64 = 512 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Provider {
    Openai,
    Gemini,
    Jev,
}

pub(crate) struct Question {
    pub name: String,
    pub instructions: String,
    pub choices: Vec<(String, String)>,
}

#[derive(Clone)]
pub(crate) struct Prepared {
    provider: Provider,
    body: String,
    choices: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct Answer {
    pub choice: String,
    pub probability: f64,
}

#[derive(Debug, Default)]
pub(crate) struct DecisionResult {
    pub answers: BTreeMap<String, Answer>,
    /// None means there is no authoritative usage count. A timed-out request
    /// can still be billed and should keep its reservation.
    pub input_tokens: Option<u64>,
    pub failure: Option<Failure>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Failure {
    InvalidRequest,
    InvalidResponse,
    Refused,
    Retryable,
    Throttled,
    Credentials,
    Credit,
}

impl Provider {
    pub(crate) fn key_id(self) -> &'static str {
        match self {
            Self::Openai => "attention_openai",
            Self::Gemini => "attention_gemini",
            Self::Jev => "attention_jev",
        }
    }

    pub(crate) fn model(self) -> &'static str {
        match self {
            Self::Openai => "gpt-6-luna",
            Self::Gemini => "gemini-decision-1",
            Self::Jev => "jev-1.14.0",
        }
    }

    pub(crate) fn rate_nanos_per_token(self) -> u64 {
        match self {
            Self::Openai | Self::Gemini => 100,
            Self::Jev => 42,
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::Openai => "https://api.openai.com/v1/decisions",
            Self::Gemini => "https://generativelanguage.googleapis.com/v1beta/decisions",
            Self::Jev => "https://api.typesafe.ai/v1/systemone",
        }
    }

    pub(crate) fn prepare(self, input: &str, questions: &[Question]) -> Result<Prepared, Failure> {
        if input.trim().is_empty()
            || input.len() > MAX_REQUEST_BYTES
            || !(1..=MAX_QUESTIONS).contains(&questions.len())
        {
            return Err(Failure::InvalidRequest);
        }
        let mut choices = BTreeMap::new();
        for question in questions {
            let allowed = validate_question(question)?;
            if choices.insert(question.name.clone(), allowed).is_some() {
                return Err(Failure::InvalidRequest);
            }
        }
        let model = self.model();
        let body = match self {
            Self::Openai => json!({
                "model": model,
                "input": input,
                "prompt_cache_options": { "mode": "explicit" },
                "questions": questions.iter().map(openai_question).collect::<Vec<_>>()
            }),
            Self::Gemini => json!({
                "model": model,
                "input": input,
                "questions": questions.iter().map(mapped_question).collect::<Map<_, _>>()
            }),
            Self::Jev => json!({
                "model": model,
                "state": input,
                "questions": questions.iter().map(mapped_question).collect::<Map<_, _>>()
            }),
        }
        .to_string();
        if body.len() > MAX_REQUEST_BYTES {
            return Err(Failure::InvalidRequest);
        }
        Ok(Prepared {
            provider: self,
            body,
            choices,
        })
    }
}

fn validate_question(question: &Question) -> Result<BTreeSet<String>, Failure> {
    let name = &question.name;
    if !(1..=64).contains(&name.len())
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        || question.instructions.trim().is_empty()
        || question.instructions.len() > MAX_REQUEST_BYTES
        || !(2..=MAX_CHOICES).contains(&question.choices.len())
    {
        return Err(Failure::InvalidRequest);
    }
    let mut allowed = BTreeSet::new();
    for (key, description) in &question.choices {
        if key.is_empty()
            || key.len() > 128
            || key.trim() != key
            || key
                .chars()
                .any(|ch| ch.is_control() || (ch.is_whitespace() && ch != ' '))
            || description.len() > MAX_REQUEST_BYTES
            || !allowed.insert(key.clone())
        {
            return Err(Failure::InvalidRequest);
        }
    }
    Ok(allowed)
}

fn openai_question(question: &Question) -> Value {
    let choices: Vec<_> = question
        .choices
        .iter()
        .map(|(value, description)| json!({ "value": value, "description": description }))
        .collect();
    json!({
        "name": question.name,
        "type": "choice",
        "instructions": question.instructions,
        "choices": choices,
    })
}

fn mapped_question(question: &Question) -> (String, Value) {
    let criteria: Map<_, _> = question
        .choices
        .iter()
        .map(|(value, description)| (value.clone(), json!(description)))
        .collect();
    (
        question.name.clone(),
        json!({ "type": "choice", "instructions": question.instructions, "criteria": criteria }),
    )
}

impl Prepared {
    pub(crate) fn upper_input_tokens(&self) -> u64 {
        // Reserve up to one token per serialized UTF-8 byte plus provider
        // framing. The normal measured count is considerably smaller.
        self.body.len() as u64 + 512 + self.choices.len() as u64 * 64
    }

    pub(crate) async fn execute(&self, key: &str) -> DecisionResult {
        if key.is_empty() || key.len() > 512 || key.bytes().any(|byte| !(33..=126).contains(&byte))
        {
            return failed(Failure::Credentials, Some(0));
        }
        let request = self.clone();
        let key = key.to_owned();
        tauri::async_runtime::spawn_blocking(move || request.send(&key))
            .await
            .unwrap_or_else(|_| failed(Failure::Retryable, None))
    }

    fn send(&self, key: &str) -> DecisionResult {
        static CLIENT: OnceLock<ureq::Agent> = OnceLock::new();
        let client = CLIENT.get_or_init(|| crate::llm::client(Duration::from_secs(30)));
        let request = client
            .post(self.provider.endpoint())
            .set("Content-Type", "application/json")
            .set("Accept", "application/json");
        let request = match self.provider {
            Provider::Gemini => request.set("x-goog-api-key", key),
            Provider::Openai | Provider::Jev => {
                request.set("Authorization", &format!("Bearer {key}"))
            }
        };
        let response = match request.send_string(&self.body) {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(_)) => return failed(Failure::Retryable, None),
        };
        let status = response.status();
        let mut bytes = Vec::new();
        let read = response
            .into_reader()
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut bytes);
        if read.is_err() {
            return failed(Failure::Retryable, None);
        }
        let body = if bytes.len() as u64 <= MAX_RESPONSE_BYTES {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        self.parse(status, &body)
    }

    fn parse(&self, status: u16, body: &Value) -> DecisionResult {
        let usage_field = match self.provider {
            Provider::Gemini => "total_input_tokens",
            Provider::Openai | Provider::Jev => "input_tokens",
        };
        let input_tokens = body["usage"][usage_field].as_u64();
        if !(200..300).contains(&status) {
            let failure = classify_status(status, body);
            // Definite HTTP rejections don't execute a decision. Preserve the
            // reservation when the server may have received and billed a call.
            let usage = if failure == Failure::Retryable {
                input_tokens
            } else {
                input_tokens.or(Some(0))
            };
            return failed(failure, usage);
        }
        let mut result = DecisionResult {
            input_tokens,
            ..DecisionResult::default()
        };
        let entries: Vec<_> = match self.provider {
            Provider::Openai => body["answers"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|answer| (answer["name"].as_str().unwrap_or_default(), answer))
                .collect(),
            Provider::Gemini | Provider::Jev => body["answers"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(name, answer)| (name.as_str(), answer))
                .collect(),
        };
        let mut seen = BTreeSet::new();
        let mut refused = 0;
        for (name, answer) in entries {
            if !seen.insert(name) {
                result.answers.remove(name);
                result.failure = Some(Failure::InvalidResponse);
                continue;
            }
            if self.choices.contains_key(name) && answer["type"].as_str() == Some("refusal") {
                refused += 1;
                continue;
            }
            let parsed = self
                .choices
                .get(name)
                .and_then(|allowed| parse_answer(answer, self.provider, allowed));
            match parsed {
                Some(answer) => {
                    result.answers.insert(name.to_owned(), answer);
                }
                None => result.failure = Some(Failure::InvalidResponse),
            }
        }
        if result.failure.is_none() && refused == self.choices.len() {
            result.failure = Some(Failure::Refused);
        } else if result.answers.len() != self.choices.len() {
            result.failure = Some(Failure::InvalidResponse);
        }
        result
    }
}

fn failed(failure: Failure, input_tokens: Option<u64>) -> DecisionResult {
    DecisionResult {
        failure: Some(failure),
        input_tokens,
        ..DecisionResult::default()
    }
}

fn parse_answer(answer: &Value, provider: Provider, allowed: &BTreeSet<String>) -> Option<Answer> {
    if answer["type"].as_str()? != "choice" {
        return None;
    }
    let choice = answer["choice"].as_str()?;
    let mut probabilities = BTreeMap::new();
    match provider {
        Provider::Openai => {
            for option in answer["probabilities"].as_array()? {
                let name = option["value"].as_str()?;
                if probabilities
                    .insert(name, probability(&option["probability"])?)
                    .is_some()
                {
                    return None;
                }
            }
        }
        Provider::Gemini | Provider::Jev => {
            for (name, value) in answer["probabilities"].as_object()? {
                probabilities.insert(name.as_str(), probability(value)?);
            }
        }
    }
    if probabilities.len() != allowed.len()
        || probabilities.keys().any(|name| !allowed.contains(*name))
    {
        return None;
    }
    let selected = *probabilities.get(choice)?;
    // Providers round their reported distributions. Accept small rounding
    // differences without treating confidence as probability for this label.
    let total: f64 = probabilities.values().sum();
    if (total - 1.0).abs() > 0.05 || probabilities.values().any(|value| *value > selected) {
        return None;
    }
    Some(Answer {
        choice: choice.to_owned(),
        probability: selected,
    })
}

fn probability(value: &Value) -> Option<f64> {
    value.as_f64().filter(|value| (0.0..=1.0).contains(value))
}

fn classify_status(status: u16, body: &Value) -> Failure {
    let error = &body["error"];
    let code = error["code"]
        .as_str()
        .or_else(|| error["type"].as_str())
        .unwrap_or_default();
    let invalid_google_key = error["details"].as_array().is_some_and(|details| {
        details.iter().any(|entry| {
            matches!(
                entry["reason"].as_str(),
                Some("API_KEY_INVALID" | "API_KEY_EXPIRED")
            )
        })
    });
    if matches!(status, 401 | 403) || invalid_google_key {
        return Failure::Credentials;
    }
    if status == 402
        || matches!(
            code,
            "credit_balance_exhausted" | "insufficient_quota" | "billing_hard_limit_reached"
        )
    {
        return Failure::Credit;
    }
    if status == 400
        && matches!(
            code,
            "safety" | "prohibited_content" | "blocklist" | "image_safety" | "content_blocked"
        )
    {
        return Failure::Refused;
    }
    match status {
        429 => Failure::Throttled,
        408 | 425 | 500..=599 => Failure::Retryable,
        _ => Failure::InvalidRequest,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(name: &str) -> Question {
        Question {
            name: name.into(),
            instructions: "Does the customer still need a reply?".into(),
            choices: vec![
                ("open".into(), "Clearly awaiting a reply".into()),
                ("unclear".into(), "No reliable evidence".into()),
            ],
        }
    }

    #[test]
    fn formats_and_reads_each_provider() {
        for provider in [Provider::Openai, Provider::Gemini, Provider::Jev] {
            let request = provider
                .prepare("Synthetic test chat", &[question("r1")])
                .unwrap();
            let body: Value = serde_json::from_str(&request.body).unwrap();
            assert_eq!(body["model"], provider.model());
            assert!(request.upper_input_tokens() > request.body.len() as u64);
            let raw = match provider {
                Provider::Openai => {
                    assert_eq!(body["input"], "Synthetic test chat");
                    assert_eq!(body["prompt_cache_options"]["mode"], "explicit");
                    assert_eq!(body["questions"][0]["name"], "r1");
                    assert_eq!(body["questions"][0]["choices"][0]["value"], "open");
                    json!({
                        "answers": [{"name":"r1", "type":"choice", "choice":"open", "confidence":0.97,
                            "probabilities":[{"value":"open","probability":0.91},{"value":"unclear","probability":0.09}]}],
                        "usage":{"input_tokens":123,"output_tokens":0}
                    })
                }
                Provider::Gemini | Provider::Jev => {
                    let (input, usage) = if provider == Provider::Gemini {
                        ("input", "total_input_tokens")
                    } else {
                        ("state", "input_tokens")
                    };
                    assert_eq!(body[input], "Synthetic test chat");
                    assert_eq!(
                        body["questions"]["r1"]["criteria"]["open"],
                        "Clearly awaiting a reply"
                    );
                    json!({
                        "answers":{"r1":{"type":"choice","choice":"open","confidence":0.97,
                            "probabilities":{"open":0.91,"unclear":0.09}}},
                        "usage":{(usage):123,"output_tokens":8}
                    })
                }
            };
            let result = request.parse(200, &raw);
            assert_eq!(result.failure, None);
            assert_eq!(result.input_tokens, Some(123));
            assert_eq!(
                result.answers["r1"],
                Answer {
                    choice: "open".into(),
                    probability: 0.91
                }
            );
        }
    }

    #[test]
    fn invalid_or_refused_answers_preserve_other_answers_and_usage() {
        let request = Provider::Openai
            .prepare(
                "Synthetic test chat",
                &[
                    question("r1"),
                    question("r2"),
                    question("r3"),
                    question("r4"),
                ],
            )
            .unwrap();
        let valid = json!({"type":"choice","choice":"open",
            "probabilities":[{"value":"open","probability":0.91},{"value":"unclear","probability":0.09}]});
        let first = |name: &str| {
            let mut answer = valid.clone();
            answer["name"] = json!(name);
            answer
        };
        let result = request.parse(200, &json!({
            "answers":[first("r1"), first("r2"), first("r2"),
                {"name":"r3","type":"refusal"},
                {"name":"r4","type":"choice","choice":"another-chat","probabilities":
                    [{"value":"another-chat","probability":1.0},{"value":"unclear","probability":0.0}]}
            ],
            "usage":{"input_tokens":305}
        }));
        assert_eq!(result.input_tokens, Some(305));
        assert_eq!(result.failure, Some(Failure::InvalidResponse));
        assert_eq!(result.answers.keys().collect::<Vec<_>>(), vec!["r1"]);
    }

    #[test]
    fn distinguishes_rejected_and_potentially_billed_calls() {
        let request = Provider::Gemini
            .prepare("Synthetic test chat", &[question("r1")])
            .unwrap();
        for (status, body, failure, usage) in [
            (
                400,
                json!({"error":{"details":[{"reason":"API_KEY_INVALID"}]}}),
                Failure::Credentials,
                Some(0),
            ),
            (
                429,
                json!({"error":{"code":"credit_balance_exhausted"}}),
                Failure::Credit,
                Some(0),
            ),
            (429, Value::Null, Failure::Throttled, Some(0)),
            (
                400,
                json!({"error":{"code":"safety"}}),
                Failure::Refused,
                Some(0),
            ),
            (
                400,
                json!({"error":{"code":"invalid_request"}}),
                Failure::InvalidRequest,
                Some(0),
            ),
            (408, Value::Null, Failure::Retryable, None),
            (503, Value::Null, Failure::Retryable, None),
        ] {
            let result = request.parse(status, &body);
            assert_eq!(result.failure, Some(failure));
            assert_eq!(result.input_tokens, usage);
        }
    }

    #[test]
    fn distinguishes_an_explicit_refusal_from_a_missing_response() {
        let request = Provider::Openai
            .prepare("Synthetic test chat", &[question("r1")])
            .unwrap();
        let result = request.parse(200, &json!({"answers":[{"name":"r1","type":"refusal"}]}));
        assert_eq!(result.failure, Some(Failure::Refused));
        assert_eq!(
            request.parse(200, &json!({})).failure,
            Some(Failure::InvalidResponse)
        );
    }

    #[test]
    fn bounds_inputs_and_rejects_duplicate_keys() {
        let provider = Provider::Jev;
        assert!(matches!(
            provider.prepare("text", &[question("r1"), question("r1")]),
            Err(Failure::InvalidRequest)
        ));
        let oversize = "a".repeat(MAX_REQUEST_BYTES);
        assert!(matches!(
            provider.prepare(&oversize, &[question("r1")]),
            Err(Failure::InvalidRequest)
        ));
        let mut duplicate = question("r1");
        duplicate.choices.push(duplicate.choices[0].clone());
        assert!(matches!(
            provider.prepare("text", &[duplicate]),
            Err(Failure::InvalidRequest)
        ));
    }
}

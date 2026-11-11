//! Retrieval for the stand-in. Voice-note transcripts are ranked for the
//! question in front of the model, then the closest ones are placed in the
//! prompt. Wording (BM25) always counts. Gemini and OpenRouter also embed the
//! transcripts, so a question finds a note that used different words. Anthropic
//! and the command-line stand-in have no embedding call, and a failed embedding
//! request leaves the wording rank in place.

use crate::jsonfile::Loaded;
use crate::llm::{self, Outbound};
use crate::settings::Settings;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

const GEMINI_EMBED: &str = "gemini-embedding-001";
const OPENROUTER_EMBED: &str = "openai/text-embedding-3-small";
const DEFAULT_DIM: usize = 768;
const MIN_DIM: usize = 64;
const MAX_DIM: usize = 3_072;
const CHUNK_CHARS: usize = 1_000;
const CHUNK_OVERLAP: usize = 150;
const BATCH: usize = 32;
/// Bound the first search in a long chat. Later searches embed the rest.
const MAX_NEW_EMBEDDINGS: usize = 64;
const MAX_CACHED: usize = 2_000;
const BM25_K1: f32 = 1.2;
const BM25_B: f32 = 0.75;
/// Cosine below this is typical of unrelated text. Counting it would fill
/// every search with notes that merely sit in the same embedding space.
const SEMANTIC_FLOOR: f32 = 0.45;

#[derive(Clone)]
pub struct Doc {
    pub id: String,
    pub key: String,
    pub text: String,
}

pub struct Chunk {
    pub key: String,
    pub text: String,
}

pub struct Vectors {
    pub docs: BTreeMap<String, Vec<f32>>,
    pub queries: Vec<Option<Vec<f32>>>,
}

impl Vectors {
    pub fn none(queries: usize) -> Self {
        Self {
            docs: BTreeMap::new(),
            queries: vec![None; queries],
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct EmbedCache {
    #[serde(default)]
    model: String,
    #[serde(default)]
    dim: usize,
    #[serde(default)]
    items: BTreeMap<String, EmbedItem>,
}

#[derive(Serialize, Deserialize)]
struct EmbedItem {
    hash: String,
    vector: Vec<f32>,
}

/// One passage per short note. A long transcript is split so the matching
/// part can rank on its own, with a small overlap so a sentence on the cut
/// is still whole in one of the passages.
pub fn chunks(id: &str, text: &str) -> Vec<Chunk> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= CHUNK_CHARS {
        return vec![Chunk {
            key: id.to_string(),
            text: text.to_string(),
        }];
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < chars.len() && out.len() < 32 {
        let end = (start + CHUNK_CHARS).min(chars.len());
        let piece: String = chars[start..end].iter().collect();
        let piece = piece.trim();
        if !piece.is_empty() {
            out.push(Chunk {
                key: format!("{id}#{}", out.len()),
                text: piece.to_string(),
            });
        }
        if end == chars.len() {
            break;
        }
        let next = end.saturating_sub(CHUNK_OVERLAP);
        if next <= start {
            break;
        }
        start = next;
    }
    out
}

/// Best passage of each note, highest score first. A zero score is left out.
/// `query_vector` and `doc_vectors` add meaning on top of the wording score.
pub fn order(
    query: &str,
    docs: &[Doc],
    query_vector: Option<&[f32]>,
    doc_vectors: &BTreeMap<String, Vec<f32>>,
    limit: usize,
) -> Vec<usize> {
    if limit == 0 || query.trim().is_empty() || docs.is_empty() {
        return Vec::new();
    }
    let texts: Vec<&str> = docs.iter().map(|doc| doc.text.as_str()).collect();
    let lexical = bm25(query, &texts);
    let max_lex = lexical.iter().copied().fold(0.0_f32, f32::max);
    let mut best: Vec<(usize, f32, f32)> = Vec::new();
    for (index, doc) in docs.iter().enumerate() {
        let lex = if max_lex > 0.0 {
            lexical[index] / max_lex
        } else {
            0.0
        };
        let semantic = query_vector
            .and_then(|query| doc_vectors.get(&doc.key).map(|doc| cosine(query, doc)))
            .unwrap_or(0.0);
        let semantic = if semantic >= SEMANTIC_FLOOR {
            semantic
        } else {
            0.0
        };
        let score = lex + semantic;
        if score <= 0.0 {
            continue;
        }
        // On a tie, the wording match wins. A gate code or a name should not
        // lose to a note that is merely nearby in the embedding space.
        if let Some(slot) = best
            .iter_mut()
            .find(|(have, _, _)| docs[*have].id == doc.id)
        {
            if score > slot.1 {
                *slot = (index, score, lex);
            }
        } else {
            best.push((index, score, lex));
        }
    }
    best.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then(right.2.total_cmp(&left.2))
            .then(left.0.cmp(&right.0))
    });
    best.into_iter()
        .take(limit)
        .map(|(index, _, _)| index)
        .collect()
}

pub async fn prepare(
    app: &AppHandle,
    settings: &Settings,
    docs: &[Doc],
    queries: &[String],
) -> Vectors {
    let app = app.clone();
    let settings = settings.clone();
    let docs = docs.to_vec();
    let queries = queries.to_vec();
    let count = queries.len();
    match tauri::async_runtime::spawn_blocking(move || {
        prepare_sync(&app, &settings, &docs, &queries)
    })
    .await
    {
        Ok(vectors) => vectors,
        Err(_) => Vectors::none(count),
    }
}

fn prepare_sync(app: &AppHandle, settings: &Settings, docs: &[Doc], queries: &[String]) -> Vectors {
    let Some(model) = embed_model(settings) else {
        return Vectors::none(queries.len());
    };
    let key = match crate::keys::get_key(app, &settings.ai_provider) {
        Ok(Some(key)) if !key.is_empty() => key,
        _ => return Vectors::none(queries.len()),
    };
    let Ok(path) = crate::voice::embed_cache_path(app) else {
        return Vectors::none(queries.len());
    };
    // The file lock stays off the network, so one chat's embedding call does
    // not hold up another chat's search.
    let (pending, dim) = {
        let _gate = cache_gate().lock().unwrap_or_else(|err| err.into_inner());
        let cache = load_cache(&path, model);
        let dim = if (MIN_DIM..=MAX_DIM).contains(&cache.dim) {
            cache.dim
        } else {
            DEFAULT_DIM
        };
        (docs_to_embed(docs, queries, &cache), dim)
    };
    let embedded = if pending.is_empty() {
        Vec::new()
    } else {
        fetch_embeddings(
            &settings.ai_provider,
            &key,
            &pending,
            "RETRIEVAL_DOCUMENT",
            dim,
        )
        .unwrap_or_default()
    };
    let (doc_vectors, query_dim) = {
        let _gate = cache_gate().lock().unwrap_or_else(|err| err.into_inner());
        let mut cache = load_cache(&path, model);
        if !embedded.is_empty() {
            let got = embedded[0].len();
            if cache.dim == 0 || cache.dim == got {
                cache.dim = got;
                for (text, vector) in pending.iter().zip(embedded) {
                    let Some(vector) = unit(vector, got) else {
                        continue;
                    };
                    let hash = text_hash(text);
                    for doc in docs.iter().filter(|doc| doc.text == *text) {
                        cache.items.insert(
                            doc.key.clone(),
                            EmbedItem {
                                hash: hash.clone(),
                                vector: vector.clone(),
                            },
                        );
                    }
                }
                prune(&mut cache, docs);
                if let Err(err) = save_cache(&path, &cache) {
                    crate::dlog::log(&format!("stand-in: embed cache {err}"));
                }
            }
        }
        let mut doc_vectors = BTreeMap::new();
        for doc in docs {
            if let Some(vector) = cached_vector(&cache, model, &doc.key, &doc.text) {
                doc_vectors.insert(doc.key.clone(), vector);
            }
        }
        let query_dim = if (MIN_DIM..=MAX_DIM).contains(&cache.dim) {
            cache.dim
        } else {
            dim
        };
        (doc_vectors, query_dim)
    };
    let queries_out = embed_queries(&settings.ai_provider, &key, queries, query_dim);
    Vectors {
        docs: doc_vectors,
        queries: queries_out,
    }
}

fn embed_model(settings: &Settings) -> Option<&'static str> {
    // A command-line stand-in was chosen so the chat is not sent to an API.
    // Embedding would upload every transcript, so it stays on the wording rank.
    if settings.standin_backend != "api" {
        return None;
    }
    match settings.ai_provider.as_str() {
        "gemini" => Some(GEMINI_EMBED),
        "openrouter" => Some(OPENROUTER_EMBED),
        _ => None,
    }
}

fn docs_to_embed(docs: &[Doc], queries: &[String], cache: &EmbedCache) -> Vec<String> {
    let mut scored: Vec<(usize, f32)> = docs
        .iter()
        .enumerate()
        .filter(|(_, doc)| cached_vector(cache, &cache.model, &doc.key, &doc.text).is_none())
        .map(|(index, doc)| {
            let rank: f32 = queries
                .iter()
                .filter(|query| !query.trim().is_empty())
                .map(|query| bm25(query, &[doc.text.as_str()])[0])
                .sum();
            (index, rank)
        })
        .collect();
    // A wording match is embedded first. The rest start at the oldest note,
    // because the newest transcripts are already in the prompt window.
    scored.sort_by(|left, right| right.1.total_cmp(&left.1).then(left.0.cmp(&right.0)));
    let mut seen = BTreeSet::new();
    scored
        .into_iter()
        .take(MAX_NEW_EMBEDDINGS)
        .filter_map(|(index, _)| {
            let text = docs[index].text.clone();
            seen.insert(text.clone()).then_some(text)
        })
        .collect()
}

fn embed_queries(
    provider: &str,
    key: &str,
    queries: &[String],
    dim: usize,
) -> Vec<Option<Vec<f32>>> {
    let wanted: Vec<String> = queries
        .iter()
        .map(|query| clip_chars(query.trim(), 2_000))
        .filter(|query| !query.is_empty())
        .collect();
    let embedded = if wanted.is_empty() {
        Vec::new()
    } else {
        fetch_embeddings(provider, key, &wanted, "RETRIEVAL_QUERY", dim).unwrap_or_default()
    };
    let mut cursor = 0usize;
    queries
        .iter()
        .map(|query| {
            if query.trim().is_empty() {
                return None;
            }
            let vector = embedded.get(cursor).cloned();
            cursor += 1;
            vector.and_then(|vector| unit(vector, dim))
        })
        .collect()
}

fn fetch_embeddings(
    provider: &str,
    key: &str,
    texts: &[String],
    task: &str,
    dim: usize,
) -> Result<Vec<Vec<f32>>, &'static str> {
    let mut out = Vec::with_capacity(texts.len());
    for batch in texts.chunks(BATCH) {
        let outbound = embed_request(provider, key, batch, task, dim)?;
        let body = post_embed(outbound)?;
        let parsed = parse_embeddings(provider, &body)?;
        if parsed.len() != batch.len() || parsed.iter().any(|vector| vector.len() != dim) {
            let got = parsed.first().map(Vec::len).unwrap_or(0);
            crate::dlog::log(&format!("stand-in: embed dim {got} expected {dim}"));
            return Err("embed");
        }
        out.extend(parsed);
    }
    Ok(out)
}

pub(crate) fn embed_request(
    provider: &str,
    key: &str,
    texts: &[String],
    task: &str,
    dim: usize,
) -> Result<Outbound, &'static str> {
    if key.is_empty() || texts.is_empty() || !(MIN_DIM..=MAX_DIM).contains(&dim) {
        return Err("embed");
    }
    match provider {
        "gemini" => Ok(Outbound {
            url: format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_EMBED}:batchEmbedContents"
            ),
            headers: vec![
                ("x-goog-api-key".into(), key.to_string()),
                ("Content-Type".into(), "application/json".into()),
            ],
            body: json!({
                "requests": texts.iter().map(|text| json!({
                    "model": format!("models/{GEMINI_EMBED}"),
                    "content": {"parts": [{"text": text}]},
                    "taskType": task,
                    "outputDimensionality": dim,
                    "embedContentConfig": {
                        "taskType": task,
                        "outputDimensionality": dim
                    }
                })).collect::<Vec<_>>()
            })
            .to_string(),
        }),
        "openrouter" => Ok(Outbound {
            url: "https://openrouter.ai/api/v1/embeddings".into(),
            headers: vec![
                ("Authorization".into(), format!("Bearer {key}")),
                ("Content-Type".into(), "application/json".into()),
            ],
            body: json!({
                "model": OPENROUTER_EMBED,
                "input": texts,
                "dimensions": dim
            })
            .to_string(),
        }),
        _ => Err("embed"),
    }
}

pub(crate) fn parse_embeddings(provider: &str, body: &str) -> Result<Vec<Vec<f32>>, &'static str> {
    let value: Value = serde_json::from_str(body).map_err(|_| "embed")?;
    let vectors = match provider {
        "gemini" => gemini_vectors(&value)?,
        "openrouter" => openrouter_vectors(&value)?,
        _ => return Err("embed"),
    };
    if vectors.is_empty() || vectors.iter().any(|vector| vector.is_empty()) {
        return Err("embed");
    }
    let dim = vectors[0].len();
    if !(MIN_DIM..=MAX_DIM).contains(&dim) || vectors.iter().any(|vector| vector.len() != dim) {
        return Err("embed");
    }
    Ok(vectors)
}

fn gemini_vectors(value: &Value) -> Result<Vec<Vec<f32>>, &'static str> {
    let rows = value
        .get("embeddings")
        .and_then(Value::as_array)
        .ok_or("embed")?;
    rows.iter().map(vector_values).collect()
}

fn openrouter_vectors(value: &Value) -> Result<Vec<Vec<f32>>, &'static str> {
    let mut rows = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or("embed")?
        .iter()
        .enumerate()
        .map(|(position, row)| {
            let index = row
                .get("index")
                .and_then(Value::as_u64)
                .map(|index| index as usize)
                .unwrap_or(position);
            vector_values(row).map(|vector| (index, vector))
        })
        .collect::<Result<Vec<_>, _>>()?;
    rows.sort_by_key(|(index, _)| *index);
    let indexes: Vec<usize> = rows.iter().map(|(index, _)| *index).collect();
    if indexes != (0..rows.len()).collect::<Vec<_>>() {
        return Err("embed");
    }
    Ok(rows.into_iter().map(|(_, vector)| vector).collect())
}

fn vector_values(row: &Value) -> Result<Vec<f32>, &'static str> {
    let values = row
        .get("values")
        .or_else(|| row.get("embedding"))
        .and_then(Value::as_array)
        .ok_or("embed")?;
    values
        .iter()
        .map(|value| {
            let number = value.as_f64().ok_or("embed")?;
            if number.is_finite() {
                Ok(number as f32)
            } else {
                Err("embed")
            }
        })
        .collect()
}

fn post_embed(outbound: Outbound) -> Result<String, &'static str> {
    let mut request = llm::client(Duration::from_secs(45)).post(&outbound.url);
    for (name, value) in &outbound.headers {
        request = request.set(name, value);
    }
    match request.send_string(&outbound.body) {
        Ok(response) => response.into_string().map_err(|_| "embed"),
        Err(ureq::Error::Status(code, _)) => {
            crate::dlog::log(&format!("stand-in: embed status={code}"));
            Err("embed")
        }
        Err(_) => {
            crate::dlog::log("stand-in: embed transport");
            Err("embed")
        }
    }
}

fn cached_vector(cache: &EmbedCache, model: &str, key: &str, text: &str) -> Option<Vec<f32>> {
    if cache.model != model {
        return None;
    }
    let item = cache.items.get(key)?;
    if item.hash != text_hash(text) {
        return None;
    }
    Some(item.vector.clone())
}

fn load_cache(path: &Path, model: &str) -> EmbedCache {
    let mut cache = match crate::jsonfile::read(path) {
        Loaded::Ok(cache) | Loaded::Recovered(cache) => cache,
        Loaded::Missing => EmbedCache::default(),
        Loaded::Corrupt => {
            crate::jsonfile::preserve_corrupt(path);
            EmbedCache::default()
        }
    };
    if cache.model != model {
        cache.model = model.to_string();
        cache.dim = 0;
        cache.items.clear();
    }
    cache
}

fn save_cache(path: &Path, cache: &EmbedCache) -> Result<(), String> {
    crate::jsonfile::save(path, cache).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn prune(cache: &mut EmbedCache, docs: &[Doc]) {
    if cache.items.len() <= MAX_CACHED {
        return;
    }
    let keep: BTreeSet<&str> = docs.iter().map(|doc| doc.key.as_str()).collect();
    let extra: Vec<String> = cache
        .items
        .keys()
        .filter(|key| !keep.contains(key.as_str()))
        .cloned()
        .collect();
    for key in extra {
        if cache.items.len() <= MAX_CACHED {
            break;
        }
        cache.items.remove(&key);
    }
}

fn cache_gate() -> &'static Mutex<()> {
    static GATE: Mutex<()> = Mutex::new(());
    &GATE
}

fn unit(mut vector: Vec<f32>, dim: usize) -> Option<Vec<f32>> {
    if vector.len() != dim || vector.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm < 1e-8 {
        return None;
    }
    for value in &mut vector {
        *value /= norm;
    }
    Some(vector)
}

fn text_hash(text: &str) -> String {
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(text.as_bytes()) {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

fn clip_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn bm25(query: &str, docs: &[&str]) -> Vec<f32> {
    let terms = unique_tokens(query);
    if terms.is_empty() || docs.is_empty() {
        return vec![0.0; docs.len()];
    }
    let doc_tokens: Vec<Vec<String>> = docs.iter().map(|doc| tokens(doc)).collect();
    let count = docs.len() as f32;
    let average = doc_tokens.iter().map(|tokens| tokens.len()).sum::<usize>() as f32 / count;
    let mut document_frequency: BTreeMap<&str, usize> = BTreeMap::new();
    for tokens in &doc_tokens {
        let mut seen = BTreeSet::new();
        for token in tokens {
            if seen.insert(token.as_str()) {
                *document_frequency.entry(token.as_str()).or_default() += 1;
            }
        }
    }
    let mut scores = vec![0.0; docs.len()];
    for term in &terms {
        let matching = document_frequency.get(term.as_str()).copied().unwrap_or(0) as f32;
        let idf = ((count - matching + 0.5) / (matching + 0.5) + 1.0).ln();
        for (index, tokens) in doc_tokens.iter().enumerate() {
            let frequency = tokens.iter().filter(|token| *token == term).count() as f32;
            if frequency == 0.0 {
                continue;
            }
            let length = tokens.len() as f32;
            let normal = 1.0 - BM25_B + BM25_B * length / average.max(1.0);
            scores[index] += idf * (frequency * (BM25_K1 + 1.0)) / (frequency + BM25_K1 * normal);
        }
    }
    scores
}

fn unique_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for token in tokens(text) {
        if !out.contains(&token) {
            out.push(token);
        }
    }
    out
}

fn tokens(text: &str) -> Vec<String> {
    fold(text)
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| token.chars().count() > 1 && !is_stopword(token))
        .map(str::to_string)
        .collect()
}

fn is_stopword(token: &str) -> bool {
    matches!(
        token,
        "the"
            | "and"
            | "for"
            | "are"
            | "was"
            | "were"
            | "you"
            | "your"
            | "that"
            | "this"
            | "with"
            | "from"
            | "have"
            | "has"
            | "had"
            | "what"
            | "where"
            | "when"
            | "how"
            | "who"
            | "why"
            | "did"
            | "does"
            | "not"
            | "but"
            | "its"
            | "que"
            | "para"
            | "com"
            | "uma"
            | "como"
            | "por"
            | "dos"
            | "das"
            | "nao"
            | "uns"
            | "umas"
            | "is"
            | "to"
            | "of"
            | "in"
            | "on"
            | "at"
            | "it"
            | "me"
            | "my"
            | "do"
            | "we"
            | "he"
            | "de"
            | "da"
            | "em"
            | "um"
            | "ou"
            | "se"
            | "os"
            | "as"
            | "ao"
            | "na"
            | "no"
    )
}

fn fold(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|ch| match ch {
            'á' | 'à' | 'ã' | 'â' | 'ä' => 'a',
            'é' | 'ê' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'õ' | 'ô' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            '\u{2019}' | '\u{2018}' => '\'',
            other => other,
        })
        .collect()
}

fn cosine(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for (left, right) in left.iter().zip(right) {
        if !left.is_finite() || !right.is_finite() {
            return 0.0;
        }
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }
    let scale = left_norm.sqrt() * right_norm.sqrt();
    if scale < 1e-8 {
        0.0
    } else {
        (dot / scale).clamp(-1.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, text: &str) -> Doc {
        Doc {
            id: id.into(),
            key: id.into(),
            text: text.into(),
        }
    }

    #[test]
    fn wording_finds_a_note_that_does_not_repeat_the_question() {
        let docs = vec![
            doc("gate", "the gate code is 4412"),
            doc("invoice", "I left the invoice on the table"),
            doc("key", "the spare key is under the mat"),
        ];
        let none = BTreeMap::new();
        let found = order("where is the spare", &docs, None, &none, 2);
        assert_eq!(found, vec![2]);
        let code = order("4412", &docs, None, &none, 2);
        assert_eq!(code, vec![0]);
    }

    #[test]
    fn an_exact_code_outranks_a_closer_embedding() {
        let docs = vec![
            doc("gate", "the gate code is 4412"),
            doc("other", "something else entirely"),
        ];
        let mut vectors = BTreeMap::new();
        vectors.insert("gate".into(), vec![1.0, 0.0]);
        vectors.insert("other".into(), vec![0.0, 1.0]);
        let found = order("4412", &docs, Some(&[0.0, 1.0]), &vectors, 2);
        assert_eq!(found.first().copied(), Some(0));
    }

    #[test]
    fn meaning_finds_a_note_with_no_shared_words() {
        let docs = vec![
            doc("key", "the spare key is under the mat"),
            doc("invoice", "I left the invoice on the table"),
        ];
        let mut vectors = BTreeMap::new();
        vectors.insert("key".into(), vec![1.0, 0.0]);
        vectors.insert("invoice".into(), vec![0.0, 1.0]);
        let found = order("payment paperwork", &docs, Some(&[0.0, 1.0]), &vectors, 1);
        assert_eq!(found, vec![1]);
    }

    #[test]
    fn a_long_transcript_keeps_its_ends() {
        let mut text = String::from("START ");
        text.push_str(&"x".repeat(2_200));
        text.push_str(" END");
        let parts = chunks("false_1555@c.us_A", &text);
        assert!(parts.len() >= 3);
        assert!(parts[0].text.contains("START"));
        assert!(parts.last().unwrap().text.contains("END"));
        assert!(parts[1].key.ends_with("#1"));
        assert_eq!(chunks("false_1555@c.us_A", "short note").len(), 1);
        assert!(chunks("false_1555@c.us_A", "  ").is_empty());
    }

    #[test]
    fn a_changed_transcript_does_not_reuse_its_vector() {
        let cache = EmbedCache {
            model: GEMINI_EMBED.into(),
            dim: 2,
            items: BTreeMap::from([(
                "note".into(),
                EmbedItem {
                    hash: text_hash("original"),
                    vector: vec![1.0, 0.0],
                },
            )]),
        };
        assert_eq!(
            cached_vector(&cache, GEMINI_EMBED, "note", "original"),
            Some(vec![1.0, 0.0])
        );
        assert!(cached_vector(&cache, GEMINI_EMBED, "note", "edited").is_none());
        assert!(cached_vector(&cache, OPENROUTER_EMBED, "note", "original").is_none());
    }

    #[test]
    fn embedding_requests_keep_the_key_out_of_the_body() {
        let secret = "sk-test-secret";
        let gemini = embed_request(
            "gemini",
            secret,
            &["gate code".into()],
            "RETRIEVAL_QUERY",
            768,
        )
        .unwrap();
        assert!(gemini.url.contains("batchEmbedContents"));
        assert!(!gemini.body.contains(secret));
        assert!(gemini.body.contains("RETRIEVAL_QUERY"));
        assert!(gemini.body.contains("outputDimensionality"));
        assert!(gemini.body.contains("embedContentConfig"));
        assert_eq!(gemini.headers[0].1, secret);
        let openrouter = embed_request(
            "openrouter",
            secret,
            &["gate code".into()],
            "RETRIEVAL_DOCUMENT",
            768,
        )
        .unwrap();
        assert!(!openrouter.body.contains(secret));
        assert!(openrouter.body.contains(OPENROUTER_EMBED));
        assert!(openrouter.headers[0].1.contains(secret));
        assert!(embed_request("anthropic", secret, &["x".into()], "RETRIEVAL_QUERY", 768).is_err());
    }

    #[test]
    fn embedding_responses_come_back_in_request_order() {
        let wide = |start: f32| -> String {
            (0..64)
                .map(|index| format!("{}", start + index as f32))
                .collect::<Vec<_>>()
                .join(",")
        };
        let gemini = format!(
            r#"{{"embeddings":[{{"values":[{}]}},{{"values":[{}]}}]}}"#,
            wide(0.0),
            wide(100.0)
        );
        let parsed = parse_embeddings("gemini", &gemini).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0][0], 0.0);
        assert_eq!(parsed[1][0], 100.0);
        let openrouter = format!(
            r#"{{"data":[{{"index":1,"embedding":[{}]}},{{"index":0,"embedding":[{}]}}]}}"#,
            wide(8.0),
            wide(1.0)
        );
        let parsed = parse_embeddings("openrouter", &openrouter).unwrap();
        assert_eq!(parsed[0][0], 1.0);
        assert_eq!(parsed[1][0], 8.0);
        assert!(parse_embeddings("gemini", r#"{"embeddings":[{"values":[1.0]}]}"#).is_err());
        let skipped = format!(
            r#"{{"data":[{{"index":0,"embedding":[{}]}},{{"index":2,"embedding":[{}]}}]}}"#,
            wide(1.0),
            wide(2.0)
        );
        assert!(parse_embeddings("openrouter", &skipped).is_err());
    }

    #[test]
    fn a_weak_embedding_does_not_count_as_a_match() {
        let docs = vec![
            doc("invoice", "I left the invoice on the table"),
            doc("weather", "the afternoon was sunny"),
        ];
        let mut vectors = BTreeMap::new();
        vectors.insert("invoice".into(), vec![0.2, 0.98]);
        vectors.insert("weather".into(), vec![0.15, 0.99]);
        let found = order("payment paperwork", &docs, Some(&[1.0, 0.0]), &vectors, 5);
        assert!(found.is_empty());
        let word = order("invoice", &docs, Some(&[1.0, 0.0]), &vectors, 5);
        assert_eq!(word, vec![0]);
    }

    #[test]
    fn embedding_starts_with_the_oldest_unembedded_note() {
        let docs: Vec<Doc> = (0..80)
            .map(|index| Doc {
                id: format!("n{index}"),
                key: format!("n{index}"),
                text: if index == 79 {
                    "the invoice is on the desk".into()
                } else {
                    format!("filler-{index:04}")
                },
            })
            .collect();
        let cache = EmbedCache {
            model: GEMINI_EMBED.into(),
            dim: 768,
            items: BTreeMap::new(),
        };
        let picked = docs_to_embed(&docs, &["invoice".into()], &cache);
        assert!(picked.iter().any(|text| text.contains("invoice")));
        assert!(picked.iter().any(|text| text.contains("filler-0000")));
        assert!(!picked.iter().any(|text| text.contains("filler-0070")));
        assert_eq!(picked.len(), 64);
    }
}

//! Stand-in backends that already know the user and can use tools.
//!
//! whatRust still decides when a chat may be answered, and it is still the
//! only process that sends a WhatsApp message. Hermes is an HTTP client to a
//! gateway the user runs on this network. Grok Bot is the webhook the desktop
//! app documents: a POST starts a cloud run, and the decision comes back only
//! if that run uses the computer on this Mac to POST to 127.0.0.1. A cloud
//! callback to a LAN address does not arrive.
//!
//! The webhook URL and both bearer keys live in a `0600` file under the config
//! directory. They are not written to `settings.json` and they are not sent to
//! the WhatsApp webview. `~/.hermes/.env` and Grok Bot's secret store are not
//! read.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv6Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const BODY_CAP: usize = 16 * 1024;
const REPLY_CAP: usize = 256 * 1024;
/// The webhook text Grok Bot shows the routine. A long transcript was cut off
/// at the end, which is where the callback address used to sit.
const GROK_CONTEXT_CAP: usize = 16 * 1024;
const HERMES_PORT: u16 = 8642;
const KEY_MIN: usize = 16;
const KEY_MAX: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentError {
    NotReady,
    Http(u16),
    Unreachable,
    Cancelled,
    TimedOut,
    NoDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunView {
    Pending,
    Completed,
    Terminal,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentStatus {
    pub grok_host: String,
    pub grok_ready: bool,
    pub hermes_key_stored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrokCall {
    pub url: String,
    pub authorization: String,
    pub body: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Secrets {
    #[serde(default)]
    grok_bot_url: String,
    #[serde(default)]
    grok_bot_key: String,
    #[serde(default)]
    hermes_key: String,
}

pub fn is_agent(backend: &str) -> bool {
    matches!(backend, "hermes" | "grok_bot")
}

/// A private-network Hermes base URL, or `None` when the host is public or the
/// URL is not a bare origin. An omitted port becomes 8642.
pub fn normalize_hermes_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 300 || raw.chars().any(char::is_control) {
        return None;
    }
    let (scheme, rest) = raw.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if rest.contains('@') || rest.contains('?') || rest.contains('#') || rest.contains('\\') {
        return None;
    }
    let authority = match rest.split_once('/') {
        Some((authority, path)) if path.is_empty() => authority,
        Some(_) => return None,
        None => rest,
    };
    if authority.is_empty() {
        return None;
    }
    let (host, port) = split_host_port(authority)?;
    if !hermes_host_ok(&host) {
        return None;
    }
    let port = port.unwrap_or(HERMES_PORT);
    if port == 0 {
        return None;
    }
    let shown = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    Some(format!("{scheme}://{shown}:{port}"))
}

/// The webhook must be `https`. The bearer is not allowed to appear in the URL.
pub fn prepare_grok(webhook: &str, bearer: &str, context: &str) -> Result<GrokCall, AgentError> {
    let url = grok_webhook(webhook, bearer).ok_or(AgentError::NotReady)?;
    if !secret_text(bearer) {
        return Err(AgentError::NotReady);
    }
    let body = serde_json::json!({ "context": context }).to_string();
    Ok(GrokCall {
        url,
        authorization: format!("Bearer {bearer}"),
        body,
    })
}

/// A 2xx keeps the body. Anything else is the status code alone.
pub fn take_body(status: u16, body: &str) -> Result<String, AgentError> {
    if (200..300).contains(&status) {
        Ok(body.to_string())
    } else {
        let _ = body;
        Err(AgentError::Http(status))
    }
}

/// Only a completed run's top-level `output` string is a decision. A failed
/// run, and a tool result that happens to contain decision JSON, are not.
pub fn read_run(body: &str) -> Option<(RunView, String)> {
    let value: Value = serde_json::from_str(body).ok()?;
    let status = value.get("status").and_then(Value::as_str)?;
    match status {
        "completed" => match value.get("output").and_then(Value::as_str) {
            Some(text) => Some((RunView::Completed, text.to_string())),
            None => Some((RunView::Terminal, String::new())),
        },
        "failed" | "cancelled" | "canceled" | "interrupted" => {
            Some((RunView::Terminal, String::new()))
        }
        _ => Some((RunView::Pending, String::new())),
    }
}

pub fn judge_callback(
    token: &str,
    method: &str,
    path: &str,
    declared_len: usize,
    body: &str,
    already: &mut Option<String>,
) -> u16 {
    let wanted = format!("/{token}");
    if method != "POST" || !tokens_match(path, &wanted) {
        return 404;
    }
    if declared_len > BODY_CAP || body.len() > BODY_CAP {
        return 413;
    }
    if already.is_some() {
        return 409;
    }
    *already = Some(body.to_string());
    204
}

pub fn callback_line(port: u16, token: &str) -> String {
    format!("CALLBACK http://127.0.0.1:{port}/{token}")
}

/// The callback address is the first line, then the messages that need an
/// answer, then as much of the rules and recent history as fit. Older history
/// and voice-note archives are what get left out.
pub fn grok_context(callback: &str, system: &str, user: &str) -> String {
    let incoming = tagged(user, "incoming_messages").unwrap_or("");
    let history = tagged(user, "chat_history").unwrap_or("");
    let contact = user
        .lines()
        .find(|line| line.starts_with("Contact:"))
        .unwrap_or("");
    let preface = format!(
        "{callback}\nPOST one JSON object, and nothing else, to that CALLBACK address from this computer. Content-Type: application/json. Do not message anyone.\n\n{contact}\n<incoming_messages>\n"
    );
    let close_incoming = "\n</incoming_messages>\n\n";
    let incoming = tail_str(
        incoming,
        GROK_CONTEXT_CAP
            .saturating_sub(preface.len() + close_incoming.len())
            .min(4_000),
    );
    let mut out = String::with_capacity(GROK_CONTEXT_CAP);
    out.push_str(&preface);
    out.push_str(incoming);
    out.push_str(close_incoming);
    let room = GROK_CONTEXT_CAP.saturating_sub(out.len());
    let wrap = "\n\n<chat_history>\n\n</chat_history>\n";
    let rules_room = room.saturating_sub(wrap.len());
    let rules = head_str(system, rules_room.min(4_500));
    let history = tail_str(
        history,
        room.saturating_sub(rules.len()).saturating_sub(wrap.len()),
    );
    out.push_str(rules);
    out.push_str("\n\n<chat_history>\n");
    out.push_str(history);
    out.push_str("\n</chat_history>\n");
    if out.len() > GROK_CONTEXT_CAP {
        let mut end = GROK_CONTEXT_CAP;
        while end > 0 && !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
    }
    out
}

pub fn ready(app: &AppHandle, backend: &str, hermes_url: &str) -> Result<(), AgentError> {
    let secrets = load_secrets(app);
    match backend {
        "grok_bot" => {
            grok_webhook(&secrets.grok_bot_url, &secrets.grok_bot_key)
                .ok_or(AgentError::NotReady)?;
            if !secret_text(&secrets.grok_bot_key) {
                return Err(AgentError::NotReady);
            }
            Ok(())
        }
        "hermes" => {
            normalize_hermes_url(hermes_url).ok_or(AgentError::NotReady)?;
            if !secret_text(&secrets.hermes_key) {
                return Err(AgentError::NotReady);
            }
            Ok(())
        }
        _ => Err(AgentError::NotReady),
    }
}

pub fn status(app: &AppHandle) -> AgentStatus {
    let secrets = load_secrets(app);
    let grok_host = grok_webhook(&secrets.grok_bot_url, &secrets.grok_bot_key)
        .as_deref()
        .and_then(host_of)
        .unwrap_or_default();
    AgentStatus {
        grok_ready: !grok_host.is_empty() && secret_text(&secrets.grok_bot_key),
        grok_host,
        hermes_key_stored: secret_text(&secrets.hermes_key),
    }
}

pub fn save_grok(app: &AppHandle, url: &str, key: &str) -> Result<(), &'static str> {
    let url = grok_webhook(url, key).ok_or("bad_url")?;
    if !secret_text(key) {
        return Err("bad_key");
    }
    let key = key.trim().to_string();
    edit_secrets(app, |secrets| {
        secrets.grok_bot_url = url;
        secrets.grok_bot_key = key;
    })
}

pub fn save_hermes_key(app: &AppHandle, key: &str) -> Result<(), &'static str> {
    if !secret_text(key) {
        return Err("bad_key");
    }
    let key = key.trim().to_string();
    edit_secrets(app, |secrets| secrets.hermes_key = key)
}

pub fn clear_grok(app: &AppHandle) -> Result<(), &'static str> {
    edit_secrets(app, |secrets| {
        secrets.grok_bot_url.clear();
        secrets.grok_bot_key.clear();
    })
}

pub fn clear_hermes_key(app: &AppHandle) -> Result<(), &'static str> {
    edit_secrets(app, |secrets| secrets.hermes_key.clear())
}

pub fn execute(
    app: &AppHandle,
    backend: &str,
    hermes_url: &str,
    timeout: Duration,
    system: &str,
    user: &str,
    cancel: &AtomicBool,
) -> Result<String, AgentError> {
    let secrets = load_secrets(app);
    let deadline = Instant::now() + timeout;
    match backend {
        "grok_bot" => run_grok(
            &secrets.grok_bot_url,
            &secrets.grok_bot_key,
            system,
            user,
            cancel,
            deadline,
        ),
        "hermes" => run_hermes(
            hermes_url,
            &secrets.hermes_key,
            system,
            user,
            cancel,
            deadline,
        ),
        _ => Err(AgentError::NotReady),
    }
}

pub fn run_grok(
    webhook: &str,
    bearer: &str,
    system: &str,
    user: &str,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<String, AgentError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(AgentError::Cancelled);
    }
    let (listener, port, token) = listen_local()?;
    let context = grok_context(&callback_line(port, &token), system, user);
    let call = prepare_grok(webhook, bearer, &context)?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(AgentError::TimedOut);
    }
    let status = post_raw(
        &call.url,
        &[
            ("Authorization", call.authorization.as_str()),
            ("Content-Type", "application/json"),
        ],
        &call.body,
        remaining.min(Duration::from_secs(20)),
    )?;
    take_body(status.0, &status.1)?;
    wait_callback(listener, &token, deadline, cancel)
}

pub fn run_hermes(
    base: &str,
    bearer: &str,
    instructions: &str,
    input: &str,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<String, AgentError> {
    let base = normalize_hermes_url(base).ok_or(AgentError::NotReady)?;
    if !secret_text(bearer) {
        return Err(AgentError::NotReady);
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(AgentError::Cancelled);
    }
    let idempotency = fresh_token()?;
    let body = serde_json::json!({
        "input": input,
        "instructions": instructions,
    })
    .to_string();
    let started = post_raw(
        &format!("{base}/v1/runs"),
        &[
            ("Authorization", &format!("Bearer {bearer}")),
            ("Content-Type", "application/json"),
            ("Idempotency-Key", &idempotency),
        ],
        &body,
        Duration::from_secs(30).min(deadline.saturating_duration_since(Instant::now())),
    )?;
    let started = take_body(started.0, &started.1)?;
    let run_id = serde_json::from_str::<Value>(&started)
        .ok()
        .and_then(|value| {
            value
                .get("run_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|id| run_id_ok(id))
        .ok_or(AgentError::NoDecision)?;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = post_raw(
                &format!("{base}/v1/runs/{run_id}/stop"),
                &[
                    ("Authorization", &format!("Bearer {bearer}")),
                    ("Content-Type", "application/json"),
                ],
                "{}",
                Duration::from_secs(3),
            );
            return Err(AgentError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(AgentError::TimedOut);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let polled = match get_raw(
            &format!("{base}/v1/runs/{run_id}"),
            &format!("Bearer {bearer}"),
            remaining.min(Duration::from_secs(15)),
        ) {
            Ok(polled) => polled,
            // One dropped poll is not a finished run. Keep waiting until the deadline.
            Err(AgentError::Unreachable) | Err(AgentError::TimedOut) => {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(err) => return Err(err),
        };
        let polled = match take_body(polled.0, &polled.1) {
            Ok(body) => body,
            Err(AgentError::Http(status)) if status == 408 || status == 429 || status >= 500 => {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(err) => return Err(err),
        };
        match read_run(&polled) {
            Some((RunView::Completed, text)) => return Ok(text),
            Some((RunView::Terminal, _)) => return Err(AgentError::NoDecision),
            Some((RunView::Pending, _)) | None => {
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

fn listen_local() -> Result<(TcpListener, u16, String), AgentError> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| AgentError::Unreachable)?;
    let port = listener
        .local_addr()
        .map_err(|_| AgentError::Unreachable)?
        .port();
    Ok((listener, port, fresh_token()?))
}

fn wait_callback(
    listener: TcpListener,
    token: &str,
    deadline: Instant,
    cancel: &AtomicBool,
) -> Result<String, AgentError> {
    listener
        .set_nonblocking(true)
        .map_err(|_| AgentError::Unreachable)?;
    let mut accepted: Option<String> = None;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AgentError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(AgentError::TimedOut);
        }
        match listener.accept() {
            Ok((stream, addr)) if addr.ip().is_loopback() => {
                let _ = serve_callback(stream, token, &mut accepted);
                if let Some(body) = accepted.clone() {
                    return Ok(body);
                }
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => return Err(AgentError::Unreachable),
        }
    }
}

fn serve_callback(
    mut stream: TcpStream,
    token: &str,
    accepted: &mut Option<String>,
) -> std::io::Result<()> {
    // The listening socket is nonblocking. An accepted socket must block so a
    // request that arrives in more than one packet is read whole.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    let header_end = loop {
        if buf.len() > 8 * 1024 {
            return respond(&mut stream, 431);
        }
        let read = stream.read(&mut tmp)?;
        if read == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..read]);
        if let Some(end) = find_sep(&buf) {
            break end;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let (method, path) = request_target(&head).unwrap_or(("", ""));
    let Some(len) = content_length(&head) else {
        return respond(&mut stream, 411);
    };
    if len > BODY_CAP {
        return respond(&mut stream, 413);
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < len {
        let read = stream.read(&mut tmp)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..read]);
        if body.len() > BODY_CAP {
            return respond(&mut stream, 413);
        }
    }
    body.truncate(len);
    let text = String::from_utf8_lossy(&body).into_owned();
    let status = judge_callback(token, method, path, len, &text, accepted);
    respond(&mut stream, status)
}

fn respond(stream: &mut TcpStream, status: u16) -> std::io::Result<()> {
    let reason = match status {
        204 => "No Content",
        404 => "Not Found",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        _ => "Bad Request",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

fn find_sep(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn request_target(head: &str) -> Option<(&str, &str)> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    Some((parts.next()?, parts.next()?))
}

fn content_length(head: &str) -> Option<usize> {
    head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse().ok())
            .flatten()
    })
}

fn post_raw(
    url: &str,
    headers: &[(&str, &str)],
    body: &str,
    timeout: Duration,
) -> Result<(u16, String), AgentError> {
    if timeout.is_zero() {
        return Err(AgentError::TimedOut);
    }
    let agent = http_agent(timeout);
    let mut request = agent.post(url);
    for (name, value) in headers {
        request = request.set(name, value);
    }
    match request.send_string(body) {
        Ok(response) => read_response(response),
        Err(ureq::Error::Status(status, response)) => {
            let (_status, text) = read_response(response).unwrap_or((status, String::new()));
            Ok((status, text))
        }
        Err(_) => Err(AgentError::Unreachable),
    }
}

fn get_raw(url: &str, bearer: &str, timeout: Duration) -> Result<(u16, String), AgentError> {
    let agent = http_agent(timeout);
    match agent.get(url).set("Authorization", bearer).call() {
        Ok(response) => read_response(response),
        Err(ureq::Error::Status(status, response)) => {
            let (_status, text) = read_response(response).unwrap_or((status, String::new()));
            Ok((status, text))
        }
        Err(_) => Err(AgentError::Unreachable),
    }
}

fn read_response(response: ureq::Response) -> Result<(u16, String), AgentError> {
    let status = response.status();
    let mut reader = response.into_reader().take(REPLY_CAP as u64 + 1);
    let mut buf = Vec::new();
    reader
        .read_to_end(&mut buf)
        .map_err(|_| AgentError::Unreachable)?;
    if buf.len() > REPLY_CAP {
        return Err(AgentError::NoDecision);
    }
    let text = String::from_utf8(buf).map_err(|_| AgentError::NoDecision)?;
    Ok((status, text))
}

fn http_agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(timeout)
        .timeout_connect(Duration::from_secs(5))
        .redirects(0)
        .build()
}

fn grok_webhook(raw: &str, bearer: &str) -> Option<String> {
    let raw = raw.trim();
    if !raw.starts_with("https://")
        || raw.len() > 2_000
        || raw.chars().any(char::is_control)
        || raw.contains('@')
        || raw.contains('?')
        || raw.contains('#')
        || raw.contains('\\')
        || raw.contains(' ')
    {
        return None;
    }
    if !bearer.is_empty() && raw.contains(bearer.trim()) {
        return None;
    }
    let rest = raw.trim_start_matches("https://");
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') {
        return None;
    }
    Some(raw.to_string())
}

fn tagged<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let start = format!("<{name}>");
    let end = format!("</{name}>");
    let from = text.find(&start)? + start.len();
    let rest = text.get(from..)?;
    let to = rest.find(&end)?;
    Some(rest[..to].trim())
}

fn head_str(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.get(..end).unwrap_or("")
}

fn tail_str(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len().saturating_sub(max);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    let slice = text.get(start..).unwrap_or("");
    slice
        .find('\n')
        .map(|index| &slice[index + 1..])
        .unwrap_or(slice)
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let (host, _) = split_host_port(authority)?;
    Some(host)
}

fn split_host_port(authority: &str) -> Option<(String, Option<u16>)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        if host.is_empty() || host.contains('%') {
            return None;
        }
        if after.is_empty() {
            return Some((host.to_string(), None));
        }
        let port = after.strip_prefix(':')?.parse().ok()?;
        return Some((host.to_string(), Some(port)));
    }
    if let Some((host, port)) = authority.rsplit_once(':') {
        if !host.is_empty() && !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) {
            return Some((host.to_string(), Some(port.parse().ok()?)));
        }
    }
    Some((authority.to_string(), None))
}

fn hermes_host_ok(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return private_ip(ip);
    }
    let lower = host.to_ascii_lowercase();
    let Some(name) = lower.strip_suffix(".local") else {
        return false;
    };
    !name.is_empty()
        && name.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => ipv6_allowed(ip),
    }
}

fn ipv6_allowed(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    let seg = ip.segments();
    // fe80::/10 link-local, fc00::/7 unique local.
    seg[0] & 0xffc0 == 0xfe80 || seg[0] & 0xfe00 == 0xfc00
}

fn secret_text(value: &str) -> bool {
    let value = value.trim();
    (KEY_MIN..=KEY_MAX).contains(&value.len())
        && !value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
}

fn run_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn tokens_match(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

fn fresh_token() -> Result<String, AgentError> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| AgentError::Unreachable)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn secrets_path(app: &AppHandle) -> Result<PathBuf, &'static str> {
    let dir = app.path().app_config_dir().map_err(|_| "keychain")?;
    std::fs::create_dir_all(&dir).map_err(|_| "keychain")?;
    Ok(dir.join("standin-agents.json"))
}

fn load_secrets(app: &AppHandle) -> Secrets {
    secrets_path(app)
        .ok()
        .map(|path| read_secrets(&path))
        .unwrap_or_default()
}

fn read_secrets(path: &Path) -> Secrets {
    match crate::jsonfile::read(path) {
        crate::jsonfile::Loaded::Ok(secrets) | crate::jsonfile::Loaded::Recovered(secrets) => {
            secrets
        }
        _ => Secrets::default(),
    }
}

fn edit_secrets(app: &AppHandle, edit: impl FnOnce(&mut Secrets)) -> Result<(), &'static str> {
    let path = secrets_path(app)?;
    let mut secrets = read_secrets(&path);
    edit(&mut secrets);
    crate::jsonfile::save(&path, &secrets).map_err(|_| "keychain")?;
    restrict(&path);
    for extra in crate::jsonfile::sidecar_paths(&path) {
        restrict(&extra);
    }
    Ok(())
}

fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn hermes_urls_stay_on_the_private_network() {
        assert_eq!(
            normalize_hermes_url("http://127.0.0.1:8642"),
            Some("http://127.0.0.1:8642".into())
        );
        assert_eq!(
            normalize_hermes_url("http://localhost:9000"),
            Some("http://localhost:9000".into())
        );
        assert_eq!(
            normalize_hermes_url("http://[::1]"),
            Some("http://[::1]:8642".into())
        );
        assert_eq!(
            normalize_hermes_url("http://10.1.2.3"),
            Some("http://10.1.2.3:8642".into())
        );
        assert_eq!(
            normalize_hermes_url("http://172.16.5.5:8642/"),
            Some("http://172.16.5.5:8642".into())
        );
        assert_eq!(
            normalize_hermes_url("http://192.168.1.20:8642"),
            Some("http://192.168.1.20:8642".into())
        );
        assert_eq!(
            normalize_hermes_url("http://169.254.1.1:8642"),
            Some("http://169.254.1.1:8642".into())
        );
        assert_eq!(
            normalize_hermes_url("http://[fe80::1]:8642"),
            Some("http://[fe80::1]:8642".into())
        );
        assert_eq!(
            normalize_hermes_url("http://hermes.local:8642"),
            Some("http://hermes.local:8642".into())
        );
        assert!(normalize_hermes_url("http://8.8.8.8:8642").is_none());
        assert!(normalize_hermes_url("https://api.example.com").is_none());
        assert!(normalize_hermes_url("http://192.168.1.20.evil.com").is_none());
        assert!(normalize_hermes_url("http://user:pass@192.168.1.20:8642").is_none());
        assert!(normalize_hermes_url("http://172.15.0.1:8642").is_none());
    }

    #[test]
    fn a_completed_run_yields_its_output_and_a_tool_blob_does_not() {
        let done = r#"{"object":"hermes.run","status":"completed","output":"{\"action\":\"reply\",\"asked_if_ai\":false,\"text\":\"On my way\"}"}"#;
        let (view, text) = read_run(done).unwrap();
        assert_eq!(view, RunView::Completed);
        assert!(text.contains("\"action\":\"reply\""));
        let failed = r#"{"status":"failed","output":"{\"action\":\"reply\",\"text\":\"no\"}","tool":{"preview":"{\"action\":\"reply\",\"text\":\"no\"}"}}"#;
        let (view, text) = read_run(failed).unwrap();
        assert_eq!(view, RunView::Terminal);
        assert!(text.is_empty());
        let running = r#"{"status":"running","events":[{"preview":"{\"action\":\"reply\",\"text\":\"no\"}"}]}"#;
        assert_eq!(read_run(running).unwrap().0, RunView::Pending);
    }

    #[test]
    fn the_grok_request_keeps_the_bearer_out_of_the_url() {
        let call = prepare_grok(
            "https://api2.cursor.sh/automations/webhook/abc",
            "crsr_example_key_value_123456",
            "hello",
        )
        .unwrap();
        assert_eq!(call.authorization, "Bearer crsr_example_key_value_123456");
        assert!(!call.url.contains("crsr_example_key_value_123456"));
        assert!(!call.url.contains("Bearer"));
        let body: Value = serde_json::from_str(&call.body).unwrap();
        assert_eq!(body["context"], "hello");
        let long = format!(
            "Contact: A\n<chat_history>\nSENTINEL-START\n{}NEW-LINE from me\n</chat_history>\n<incoming_messages>\nhello from them\n</incoming_messages>\n<voice_notes>\n{}</voice_notes>",
            "x".repeat(80_000),
            "v".repeat(80_000)
        );
        let context = grok_context(
            "CALLBACK http://127.0.0.1:9/abc",
            &format!("rules {}", "y".repeat(20_000)),
            &long,
        );
        assert!(context.starts_with("CALLBACK http://127.0.0.1:9/abc\n"));
        assert!(context.contains("hello from them"));
        assert!(context.contains("NEW-LINE from me"));
        assert!(!context.contains("SENTINEL-START"));
        assert!(!context.contains("voice_notes"));
        assert!(context.len() <= GROK_CONTEXT_CAP);
        assert!(prepare_grok(
            "http://api2.cursor.sh/hook",
            "crsr_example_key_value_123456",
            "x"
        )
        .is_err());
        assert!(prepare_grok(
            "https://api2.cursor.sh/hook?key=crsr_example_key_value_123456",
            "crsr_example_key_value_123456",
            "x"
        )
        .is_err());
    }

    #[test]
    fn a_non_200_is_the_status_and_not_the_body() {
        let err = take_body(401, "secret-body").unwrap_err();
        assert_eq!(err, AgentError::Http(401));
        assert!(!format!("{err:?}").contains("secret"));
        assert_eq!(take_body(200, "kept").unwrap(), "kept");
    }

    #[test]
    fn a_callback_accepts_one_decision_and_rejects_a_replay() {
        let mut slot = None;
        assert_eq!(
            judge_callback("abc", "POST", "/abc", 2, "ok", &mut slot),
            204
        );
        assert_eq!(slot.as_deref(), Some("ok"));
        assert_eq!(
            judge_callback("abc", "POST", "/abc", 2, "no", &mut slot),
            409
        );
        assert_eq!(slot.as_deref(), Some("ok"));
        assert_eq!(
            judge_callback("abc", "POST", "/other", 2, "no", &mut None),
            404
        );
        assert_eq!(
            judge_callback("abc", "POST", "/abc", BODY_CAP + 1, "", &mut None),
            413
        );
    }

    #[test]
    fn the_localhost_listener_returns_the_posted_decision() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = AtomicBool::new(false);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(40));
            post_decision(
                &format!("http://127.0.0.1:{port}/abc123token"),
                r#"{"action":"reply","text":"probe-local"}"#,
            )
            .unwrap();
        });
        let text = wait_callback(
            listener,
            "abc123token",
            Instant::now() + Duration::from_secs(3),
            &cancel,
        )
        .unwrap();
        assert!(text.contains("probe-local"));
    }

    #[test]
    fn hermes_polling_returns_only_the_completed_output() {
        let cancel = Arc::new(AtomicBool::new(false));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_server = seen.clone();
        let base = mock_server(move |head, body| {
            seen_server.lock().unwrap().push(format!("{head}\n{body}"));
            if head.starts_with("POST /v1/runs ") {
                assert!(head.contains("Authorization: Bearer hermes-key-value-1234"));
                assert!(head.contains("Idempotency-Key:"));
                assert!(!body.contains("session_id"));
                http_json(202, r#"{"run_id":"run_test","status":"started"}"#)
            } else if head.starts_with("GET /v1/runs/run_test ") {
                http_json(
                    200,
                    r#"{"status":"completed","output":"{\"action\":\"skip\",\"asked_if_ai\":false}"}"#,
                )
            } else {
                http_json(404, "{}")
            }
        });
        let text = run_hermes(
            &base,
            "hermes-key-value-1234",
            "rules",
            "turn",
            &cancel,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
        assert!(text.contains("\"action\":\"skip\""));
        for entry in seen.lock().unwrap().iter() {
            let line = entry.lines().next().unwrap_or("");
            assert!(
                !line.contains("hermes-key-value-1234"),
                "the bearer must stay out of the request line: {line}"
            );
        }
    }

    fn http_json(status: u16, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn post_decision(url: &str, body: &str) -> std::io::Result<()> {
        let rest = url.trim_start_matches("http://");
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let mut stream = TcpStream::connect(authority)?;
        write!(
            stream,
            "POST /{path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )?;
        let mut buf = [0u8; 128];
        let _ = stream.read(&mut buf);
        Ok(())
    }

    fn mock_server(handler: impl Fn(&str, &str) -> String + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for _ in 0..6 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
                let mut buf = Vec::new();
                let mut tmp = [0u8; 1024];
                let header_end = loop {
                    if buf.len() > 64 * 1024 {
                        break None;
                    }
                    let Ok(read) = stream.read(&mut tmp) else {
                        break None;
                    };
                    if read == 0 {
                        break None;
                    }
                    buf.extend_from_slice(&tmp[..read]);
                    if let Some(end) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                        break Some(end);
                    }
                };
                let Some(header_end) = header_end else {
                    continue;
                };
                let len = String::from_utf8_lossy(&buf[..header_end])
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                while buf.len() < header_end + 4 + len && buf.len() < 64 * 1024 {
                    let Ok(read) = stream.read(&mut tmp) else {
                        break;
                    };
                    if read == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..read]);
                }
                let req = String::from_utf8_lossy(&buf).into_owned();
                let (head, body) = req.split_once("\r\n\r\n").unwrap_or((req.as_str(), ""));
                let response = handler(head, body);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://127.0.0.1:{port}")
    }
}

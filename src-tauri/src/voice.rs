//! Voice-note transcription for the WhatsApp webview.
//!
//! `voice.js` frames each decrypted note as `[u16 id length][id][audio]` and
//! `invoke`s it as raw bytes. Audio is posted to FluidVoice on `127.0.0.1`.
//! Translation and summaries go out from here, so the page never holds an API key.

use crate::i18n::tr;
use crate::jsonfile::Loaded;
use crate::keys;
use crate::llm::{self, Completion};
use crate::settings::{self, Settings};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Webview};

pub const MAX_AUDIO: usize = 20 * 1024 * 1024;
const MAX_ITEMS: usize = 2_000;
const FLUID_TRANSCRIBE_SECS: u64 = 180;

pub struct VoiceState {
    gate: tokio::sync::Mutex<()>,
}

impl Default for VoiceState {
    fn default() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(()),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct VoicePrefs {
    pub enabled: bool,
    pub translate: bool,
    pub target: String,
}

#[derive(Clone, Serialize)]
pub struct VoiceView {
    pub id: String,
    pub status: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

#[derive(Serialize)]
pub struct SummaryView {
    pub id: String,
    pub summary: String,
}

#[derive(Serialize)]
pub struct FluidStatus {
    pub ok: bool,
    pub version: String,
    pub detail: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    text: String,
    at: u64,
    #[serde(default)]
    translation: Option<String>,
    #[serde(default)]
    translation_key: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    summary_key: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Cache {
    items: BTreeMap<String, Entry>,
}

pub fn push_prefs(app: &AppHandle, settings: &Settings) {
    let prefs = prefs_for(app, settings);
    let Ok(json) = serde_json::to_string(&prefs) else {
        return;
    };
    let script = format!("window.__whatrustVoicePrefs&&window.__whatrustVoicePrefs({json})");
    for (label, view) in app.webviews() {
        if label.starts_with("wa-") {
            let _ = view.eval(&script);
        }
    }
}

fn prefs_for(app: &AppHandle, settings: &Settings) -> VoicePrefs {
    VoicePrefs {
        enabled: settings.voice_transcribe && crate::lock::is_unlocked(app),
        translate: settings.translate_enabled,
        target: settings.translate_target_lang.clone(),
    }
}

fn page(window: &Webview) -> Result<(), String> {
    crate::integration::remote(window)
}

fn settings_window(window: &Webview, app: &AppHandle) -> Result<(), String> {
    if window.label() != "settings" || !crate::integration::trusted_local(window) {
        return Err("forbidden".into());
    }
    crate::lock::require_unlocked(app)
}

#[tauri::command]
pub fn voice_prefs(window: Webview, app: AppHandle) -> Result<VoicePrefs, String> {
    page(&window)?;
    Ok(prefs_for(&app, &settings::load(&app)))
}

#[tauri::command]
pub async fn voice_lookup(
    window: Webview,
    app: AppHandle,
    id: String,
) -> Result<VoiceView, String> {
    page(&window)?;
    if !valid_message_id(&id) {
        return Err("bad_id".into());
    }
    if !crate::lock::is_unlocked(&app) {
        return Ok(disabled(id));
    }
    let state = app.state::<VoiceState>();
    let _gate = state.gate.lock().await;
    lookup_cached(&app, id).await
}

#[tauri::command]
pub async fn transcribe_voice(
    window: Webview,
    app: AppHandle,
    request: Request<'_>,
) -> Result<VoiceView, String> {
    page(&window)?;
    let packed = payload_bytes(request.body())?;
    let (id, audio) = split_payload(&packed).map_err(str::to_string)?;
    let settings = settings::load(&app);
    if !crate::lock::is_unlocked(&app) || !settings.voice_transcribe {
        return Ok(disabled(id));
    }
    let state = app.state::<VoiceState>();
    let _gate = state.gate.lock().await;
    transcribe_locked(&app, &settings, id, audio).await
}

#[tauri::command]
pub async fn summarize_voice(
    window: Webview,
    app: AppHandle,
    id: String,
) -> Result<SummaryView, String> {
    page(&window)?;
    if !valid_message_id(&id) {
        return Err("bad_id".into());
    }
    crate::lock::require_unlocked(&app)?;
    let state = app.state::<VoiceState>();
    let _gate = state.gate.lock().await;
    let settings = settings::load(&app);
    let path = cache_path(&app)?;
    let mut cache = load_cache(&path);
    let text = cache
        .items
        .get(&id)
        .map(|entry| entry.text.clone())
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "no_transcript".to_string())?;
    let sum_key = summary_key(&settings);
    if let Some(entry) = cache.items.get(&id) {
        if entry.summary_key.as_deref() == Some(sum_key.as_str()) {
            if let Some(summary) = &entry.summary {
                return Ok(SummaryView {
                    id,
                    summary: summary.clone(),
                });
            }
        }
    }
    let summary = run_summary(&app, &settings, &text).await?;
    if let Some(entry) = cache.items.get_mut(&id) {
        entry.summary = Some(summary.clone());
        entry.summary_key = Some(sum_key);
    }
    save_cache(&path, &mut cache)?;
    Ok(SummaryView { id, summary })
}

#[tauri::command]
pub async fn fluidvoice_status(
    window: Webview,
    app: AppHandle,
    port: Option<u16>,
) -> Result<FluidStatus, String> {
    settings_window(&window, &app)?;
    let port =
        settings::sanitize_port(port.unwrap_or_else(|| settings::load(&app).fluidvoice_port));
    let probed = tauri::async_runtime::spawn_blocking(move || probe_health(port))
        .await
        .map_err(|_| "fluidvoice".to_string())?;
    match probed {
        Ok(version) => Ok(FluidStatus {
            ok: true,
            version,
            detail: tr("FluidVoice respondeu.").into_owned(),
        }),
        Err(_) => Ok(FluidStatus {
            ok: false,
            version: String::new(),
            detail: tr("FluidVoice não respondeu. Ative a API local e reinicie o FluidVoice.")
                .into_owned(),
        }),
    }
}

#[tauri::command]
pub fn set_ai_key(
    window: Webview,
    app: AppHandle,
    provider: String,
    key: String,
) -> Result<(), String> {
    settings_window(&window, &app)?;
    keys::set_key(&app, &provider, &key).map_err(|code| match code {
        "bad_provider" => tr("Provedor de IA desconhecido.").into_owned(),
        "bad_key" => tr("A chave da API não foi aceita.").into_owned(),
        _ => tr("Não foi possível guardar a chave da API.").into_owned(),
    })
}

#[tauri::command]
pub async fn list_ai_models(
    window: Webview,
    app: AppHandle,
    provider: String,
) -> Result<Vec<llm::ModelChoice>, String> {
    settings_window(&window, &app)?;
    if !keys::known_provider(&provider) {
        return Err(tr("Provedor de IA desconhecido.").into_owned());
    }
    // OpenRouter's catalog is too large to offer as a picker. The settings
    // fields stay free text, so this returns no models and does not call it.
    if provider == llm::OPENROUTER {
        return Ok(Vec::new());
    }
    let key = match keys::get_key(&app, &provider) {
        Ok(Some(key)) => key,
        Ok(None) => return Err(tr("Nenhuma chave guardada.").into_owned()),
        Err(_) => return Err(tr("Não foi possível listar os modelos.").into_owned()),
    };
    tauri::async_runtime::spawn_blocking(move || llm::list_main_models(&provider, &key))
        .await
        .map_err(|_| tr("Não foi possível listar os modelos.").into_owned())?
        .map_err(|_| tr("Não foi possível listar os modelos.").into_owned())
}

fn disabled(id: String) -> VoiceView {
    VoiceView {
        id,
        status: "disabled".into(),
        text: String::new(),
        translation: None,
        notice: None,
    }
}

/// Cache hit, including a translation refresh. `Ok(None)` means there is no transcript yet.
async fn lookup_cached(app: &AppHandle, id: String) -> Result<VoiceView, String> {
    let settings = settings::load(app);
    if !settings.voice_transcribe || !crate::lock::is_unlocked(app) {
        return Ok(disabled(id));
    }
    let path = cache_path(app)?;
    let mut cache = load_cache(&path);
    let Some(entry) = cache.items.get(&id) else {
        return Ok(VoiceView {
            id,
            status: "missing".into(),
            text: String::new(),
            translation: None,
            notice: None,
        });
    };
    // A stored transcript, even an empty one, is a finished result. The page
    // must not download the voice note again.
    let text = entry.text.clone();
    let (translation, notice) = match ensure_translation(app, &settings, &mut cache, &id).await {
        Ok(translation) => (translation, None),
        Err(code) => (None, Some(code.to_string())),
    };
    save_cache(&path, &mut cache)?;
    Ok(VoiceView {
        id,
        status: "ready".into(),
        text,
        translation,
        notice,
    })
}

async fn transcribe_locked(
    app: &AppHandle,
    settings: &Settings,
    id: String,
    audio: Vec<u8>,
) -> Result<VoiceView, String> {
    let path = cache_path(app)?;
    let mut cache = load_cache(&path);
    if cache.items.contains_key(&id) {
        return finish_existing(app, settings, &path, cache, id).await;
    }
    let port = settings.fluidvoice_port;
    let filename = audio_filename(&audio).to_string();
    let bytes = audio.len();
    let transcribed =
        tauri::async_runtime::spawn_blocking(move || fluid_transcribe(port, &audio, &filename))
            .await
            .map_err(|_| "fluidvoice".to_string())?;
    let text = match transcribed {
        Ok(text) => text,
        Err(code) => {
            crate::dlog::log(&format!("voice: transcribe bytes={bytes} err={code}"));
            return Err(code.into());
        }
    };
    crate::dlog::log(&format!("voice: transcribed bytes={bytes}"));
    cache.items.insert(
        id.clone(),
        Entry {
            text: text.clone(),
            at: now_ms(),
            translation: None,
            translation_key: None,
            summary: None,
            summary_key: None,
        },
    );
    let (translation, notice) = match ensure_translation(app, settings, &mut cache, &id).await {
        Ok(translation) => (translation, None),
        Err(code) => (None, Some(code.to_string())),
    };
    save_cache(&path, &mut cache)?;
    Ok(VoiceView {
        id,
        status: "ready".into(),
        text,
        translation,
        notice,
    })
}

async fn finish_existing(
    app: &AppHandle,
    settings: &Settings,
    path: &Path,
    mut cache: Cache,
    id: String,
) -> Result<VoiceView, String> {
    crate::dlog::log("voice: cache hit");
    let text = cache
        .items
        .get(&id)
        .map(|entry| entry.text.clone())
        .unwrap_or_default();
    let (translation, notice) = match ensure_translation(app, settings, &mut cache, &id).await {
        Ok(translation) => (translation, None),
        Err(code) => (None, Some(code.to_string())),
    };
    save_cache(path, &mut cache)?;
    Ok(VoiceView {
        id,
        status: "ready".into(),
        text,
        translation,
        notice,
    })
}

/// `Ok(None)` when translation is off. `Err("no_key" | "llm")` when it was requested and failed.
async fn ensure_translation(
    app: &AppHandle,
    settings: &Settings,
    cache: &mut Cache,
    id: &str,
) -> Result<Option<String>, &'static str> {
    if !settings.translate_enabled {
        return Ok(None);
    }
    let key = translation_key(settings);
    if let Some(entry) = cache.items.get(id) {
        if entry.translation_key.as_deref() == Some(key.as_str()) {
            return Ok(entry.translation.clone());
        }
    }
    let text = cache
        .items
        .get(id)
        .map(|entry| llm::clip(&entry.text).to_string())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Ok(None);
    }
    let api_key = match keys::get_key(app, &settings.ai_provider) {
        Ok(Some(key)) => key,
        Ok(None) => return Err("no_key"),
        Err(_) => return Err("no_key"),
    };
    let (system, user) = llm::translate_prompt(&settings.translate_target_lang, &text);
    let translated = llm::complete(Completion {
        provider: &settings.ai_provider,
        model: settings.ai_model(),
        key: &api_key,
        system: &system,
        user: &user,
        max_tokens: 2048,
    })
    .await?;
    if let Some(entry) = cache.items.get_mut(id) {
        entry.translation = Some(translated.clone());
        entry.translation_key = Some(key);
    }
    Ok(Some(translated))
}

async fn run_summary(app: &AppHandle, settings: &Settings, text: &str) -> Result<String, String> {
    let api_key = match keys::get_key(app, &settings.ai_provider) {
        Ok(Some(key)) => key,
        Ok(None) => return Err("no_key".into()),
        Err(_) => return Err("no_key".into()),
    };
    let clipped = llm::clip(text);
    let (system, user) = llm::summary_prompt(clipped);
    llm::complete(Completion {
        provider: &settings.ai_provider,
        model: settings.summary_model(),
        key: &api_key,
        system: &system,
        user: &user,
        max_tokens: 1024,
    })
    .await
    .map_err(str::to_string)
}

fn translation_key(settings: &Settings) -> String {
    format!(
        "{}|{}|{}",
        settings.ai_provider,
        settings.ai_model(),
        settings.translate_target_lang
    )
}

fn summary_key(settings: &Settings) -> String {
    format!("{}|{}", settings.ai_provider, settings.summary_model())
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("voice-transcripts.json"))
}

fn load_cache(path: &Path) -> Cache {
    match crate::jsonfile::read(path) {
        Loaded::Ok(cache) | Loaded::Recovered(cache) => cache,
        Loaded::Missing => Cache::default(),
        Loaded::Corrupt => {
            crate::jsonfile::preserve_corrupt(path);
            Cache::default()
        }
    }
}

fn save_cache(path: &Path, cache: &mut Cache) -> Result<(), String> {
    prune(cache);
    crate::jsonfile::save(path, cache).map_err(|e| e.to_string())
}

fn prune(cache: &mut Cache) {
    if cache.items.len() <= MAX_ITEMS {
        return;
    }
    let mut order: Vec<(u64, String)> = cache
        .items
        .iter()
        .map(|(id, entry)| (entry.at, id.clone()))
        .collect();
    order.sort_by_key(|(at, _)| *at);
    let extra = cache.items.len() - MAX_ITEMS;
    for (_, id) in order.into_iter().take(extra) {
        cache.items.remove(&id);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn valid_message_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 12 || bytes.len() > 180 {
        return false;
    }
    if !(id.starts_with("true_") || id.starts_with("false_")) {
        return false;
    }
    let Some((_, rest)) = id.split_once('_') else {
        return false;
    };
    let Some((chat, message)) = rest.split_once('_') else {
        return false;
    };
    if chat.is_empty() || message.is_empty() {
        return false;
    }
    bytes
        .iter()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'@' | b'.' | b'_' | b'-' | b'+'))
}

/// `[u16 big-endian id length][utf-8 id][audio]`.
pub fn split_payload(bytes: &[u8]) -> Result<(String, Vec<u8>), &'static str> {
    if bytes.len() > MAX_AUDIO + 182 {
        return Err("too_large");
    }
    if bytes.len() < 3 {
        return Err("bad_id");
    }
    let len = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
    if len == 0 || len > 180 || bytes.len() < 2 + len {
        return Err("bad_id");
    }
    let id = std::str::from_utf8(&bytes[2..2 + len]).map_err(|_| "bad_id")?;
    if !valid_message_id(id) {
        return Err("bad_id");
    }
    let audio = bytes[2 + len..].to_vec();
    if audio.is_empty() {
        return Err("bad_audio");
    }
    if audio.len() > MAX_AUDIO {
        return Err("too_large");
    }
    Ok((id.to_string(), audio))
}

fn payload_bytes(body: &InvokeBody) -> Result<Vec<u8>, String> {
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(value) => json_bytes(value),
    }
}

fn json_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let arr = value.as_array().ok_or("bad_audio")?;
    if arr.len() > MAX_AUDIO + 182 {
        return Err("too_large".into());
    }
    let mut out = Vec::with_capacity(arr.len());
    for number in arr {
        let byte = number.as_u64().ok_or("bad_audio")?;
        if byte > 255 {
            return Err("bad_audio".into());
        }
        out.push(byte as u8);
    }
    Ok(out)
}

pub fn audio_filename(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"OggS") {
        "note.opus"
    } else if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
        "note.m4a"
    } else if bytes.starts_with(b"RIFF") {
        "note.wav"
    } else if bytes.starts_with(b"ID3") || bytes.starts_with(&[0xFF, 0xFB]) {
        "note.mp3"
    } else {
        "note.opus"
    }
}

pub fn probe_health(port: u16) -> Result<String, &'static str> {
    let url = format!("http://127.0.0.1:{port}/v1/health");
    let response = llm::client(Duration::from_secs(4))
        .get(&url)
        .call()
        .map_err(|_| "fluidvoice")?;
    let text = response.into_string().map_err(|_| "fluidvoice")?;
    let value: Value = serde_json::from_str(&text).map_err(|_| "fluidvoice")?;
    if value.get("status").and_then(Value::as_str) != Some("ok") {
        return Err("fluidvoice");
    }
    Ok(value
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

fn fluid_transcribe(port: u16, audio: &[u8], filename: &str) -> Result<String, &'static str> {
    let port = settings::sanitize_port(port);
    let url = format!("http://127.0.0.1:{port}/v1/transcribe");
    let response = llm::client(Duration::from_secs(FLUID_TRANSCRIBE_SECS))
        .post(&url)
        .set("X-Filename", filename)
        .set("Content-Type", "application/octet-stream")
        .send_bytes(audio);
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(400, response)) => {
            let _ = response.into_string();
            crate::dlog::log("voice: fluidvoice rejected audio");
            return Err("bad_audio");
        }
        Err(ureq::Error::Status(code, response)) => {
            let _ = response.into_string();
            crate::dlog::log(&format!("voice: fluidvoice status={code}"));
            return Err("fluidvoice");
        }
        Err(_) => {
            crate::dlog::log("voice: fluidvoice unreachable");
            return Err("fluidvoice");
        }
    };
    let text = response.into_string().map_err(|_| "fluidvoice")?;
    let value: Value = serde_json::from_str(&text).map_err(|_| "fluidvoice")?;
    value
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or("fluidvoice")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(id: &str, audio: &[u8]) -> Vec<u8> {
        let id_bytes = id.as_bytes();
        let mut out = Vec::with_capacity(2 + id_bytes.len() + audio.len());
        let len = u16::try_from(id_bytes.len()).unwrap();
        out.extend(len.to_be_bytes());
        out.extend(id_bytes);
        out.extend(audio);
        out
    }

    #[test]
    fn framed_opus_round_trips() {
        let id = "false_123@c.us_ABC";
        let audio = b"OggSopus-bytes";
        let (parsed, bytes) = split_payload(&frame(id, audio)).unwrap();
        assert_eq!(parsed, id);
        assert_eq!(bytes, audio);
        assert_eq!(audio_filename(&bytes), "note.opus");
    }

    #[test]
    fn bad_frames_are_rejected() {
        assert_eq!(split_payload(&[0, 1, b'x']).unwrap_err(), "bad_id");
        assert_eq!(
            split_payload(&frame("nope", b"OggS")).unwrap_err(),
            "bad_id"
        );
        assert_eq!(
            split_payload(&frame("false_123@c.us_ABC", b"")).unwrap_err(),
            "bad_audio"
        );
        let mut huge = frame("false_123@c.us_ABC", b"x");
        huge.resize(MAX_AUDIO + 183, 1);
        assert_eq!(split_payload(&huge).unwrap_err(), "too_large");
    }

    #[test]
    fn filenames_follow_the_container() {
        assert_eq!(audio_filename(b"OggSrest"), "note.opus");
        assert_eq!(audio_filename(b"xxxxftyp"), "note.m4a");
        assert_eq!(audio_filename(b"RIFFwav"), "note.wav");
        assert_eq!(audio_filename(b"ID3tag"), "note.mp3");
        assert_eq!(audio_filename(b"????"), "note.opus");
    }

    #[test]
    fn message_ids_match_whatsapp_rows() {
        assert!(valid_message_id("true_15551212@c.us_3EB0ABC"));
        assert!(valid_message_id("false_123@lid_ABCDEF"));
        assert!(!valid_message_id("false_onlyone"));
        assert!(!valid_message_id("maybe_123@c.us_ABC"));
        assert!(!valid_message_id("false_123@c.us_ABC extra"));
    }

    #[test]
    fn cache_keeps_the_newest_entries() {
        let mut cache = Cache::default();
        for n in 0..MAX_ITEMS + 3 {
            cache.items.insert(
                format!("false_1@c.us_{n:04}"),
                Entry {
                    text: "t".into(),
                    at: n as u64,
                    translation: None,
                    translation_key: None,
                    summary: None,
                    summary_key: None,
                },
            );
        }
        prune(&mut cache);
        assert_eq!(cache.items.len(), MAX_ITEMS);
        assert!(!cache.items.contains_key("false_1@c.us_0000"));
        assert!(cache
            .items
            .contains_key(&format!("false_1@c.us_{:04}", MAX_ITEMS + 2)));
    }

    #[test]
    fn json_number_arrays_are_accepted_as_a_frame() {
        let framed = frame("false_123@c.us_ABC", b"OggShi");
        let value = Value::Array(framed.iter().map(|b| Value::from(*b)).collect());
        let bytes = json_bytes(&value).unwrap();
        assert_eq!(split_payload(&bytes).unwrap().0, "false_123@c.us_ABC");
    }
}

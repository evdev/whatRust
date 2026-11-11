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
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Webview};

pub const MAX_AUDIO: usize = 20 * 1024 * 1024;

/// The Windows beta button on fluidvoice.com. It redirects to the current
/// official `FluidVoice_*_x64-setup.exe`. The page cannot supply another address.
const FLUIDVOICE_WINDOWS_SETUP: &str = "https://fluidvoice.com/fluid/download/windows";
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

#[derive(Serialize)]
pub struct VoiceTranscriptHit {
    pub id: String,
    pub text: String,
}

const TRANSCRIPT_LIMIT: usize = 500;
const TRANSCRIPT_CHARS: usize = 2_000;

/// Cached transcripts for the ids a chat summary already has. One cache load.
/// Unknown ids are omitted. More than 500 ids keeps the newest, which the page
/// sends last.
pub fn select_transcripts(stored: &[StoredTranscript], ids: &[String]) -> Vec<VoiceTranscriptHit> {
    let ids = if ids.len() > TRANSCRIPT_LIMIT {
        &ids[ids.len() - TRANSCRIPT_LIMIT..]
    } else {
        ids
    };
    let mut out = Vec::new();
    for id in ids {
        let needle = id.trim();
        if needle.is_empty() || needle.len() > 180 {
            continue;
        }
        let Some(text) = stored.iter().find_map(|note| {
            if same_voice(note.id.as_str(), needle) {
                Some(note.text.as_str())
            } else {
                None
            }
        }) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        out.push(VoiceTranscriptHit {
            id: needle.to_string(),
            text: clip_chars(text, TRANSCRIPT_CHARS),
        });
    }
    out
}

fn same_voice(stored_id: &str, asked: &str) -> bool {
    if stored_id == asked {
        return true;
    }
    let stored_token = crate::todo::message_token(stored_id);
    let asked_token = crate::todo::message_token(asked);
    !stored_token.is_empty() && (stored_token == asked_token || stored_token == asked)
}

fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

#[tauri::command(rename_all = "snake_case")]
pub fn voice_transcripts(
    window: Webview,
    app: AppHandle,
    ids: Vec<String>,
) -> Result<Vec<VoiceTranscriptHit>, String> {
    page(&window)?;
    crate::lock::require_unlocked(&app)?;
    // A transcription holds the voice gate for minutes. This is a read of a
    // file that is replaced atomically, so it does not wait for that gate.
    Ok(select_transcripts(&stored_transcripts(&app), &ids))
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

/// Open the official FluidVoice Windows beta installer in the browser.
/// The download is optional: nothing is installed until the user runs it.
#[tauri::command]
pub fn open_fluidvoice_windows(window: Webview, app: AppHandle) -> Result<(), String> {
    settings_window(&window, &app)?;
    let url = fluidvoice_windows_setup_url().map_err(|_| "fluidvoice".to_string())?;
    #[cfg(windows)]
    {
        crate::opener::open_url(&app, url);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, url);
        Err(tr("O instalador do FluidVoice só é oferecido no Windows.").into_owned())
    }
}

fn fluidvoice_windows_setup_url() -> Result<tauri::Url, ()> {
    FLUIDVOICE_WINDOWS_SETUP.parse().map_err(|_| ())
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

#[derive(serde::Serialize)]
pub struct AiKeyReport {
    pub stored: bool,
    pub accepted: bool,
    pub tone: String,
    pub detail: String,
    pub models: Vec<llm::ModelChoice>,
}

#[tauri::command]
pub async fn set_ai_key(
    window: Webview,
    app: AppHandle,
    provider: String,
    key: String,
    remove: Option<bool>,
) -> Result<AiKeyReport, String> {
    settings_window(&window, &app)?;
    if !keys::known_provider(&provider) {
        return Err(tr("Provedor de IA desconhecido.").into_owned());
    }
    if remove.unwrap_or(false) {
        keys::set_key(&app, &provider, "").map_err(key_store_error)?;
        return Ok(AiKeyReport {
            stored: false,
            accepted: false,
            tone: "ok".into(),
            detail: tr("A chave deste provedor foi removida deste computador.").into_owned(),
            models: Vec::new(),
        });
    }
    let key = key.trim();
    if key.is_empty() {
        return Ok(AiKeyReport {
            stored: keys::has_key(&app, &provider),
            accepted: false,
            tone: "warn".into(),
            detail: tr("Digite a chave da API.").into_owned(),
            models: Vec::new(),
        });
    }
    if key.len() > 512 || key.chars().any(char::is_control) {
        return Ok(AiKeyReport {
            stored: keys::has_key(&app, &provider),
            accepted: false,
            tone: "bad".into(),
            detail: tr("A chave da API não foi aceita.").into_owned(),
            models: Vec::new(),
        });
    }
    let settings = settings::load(&app);
    let probe_model = match provider.as_str() {
        "gemini" => settings.ai_model_gemini.clone(),
        "anthropic" => settings.ai_model_anthropic.clone(),
        _ => settings.ai_model_openrouter.clone(),
    };
    let provider_for_check = provider.clone();
    let key_for_check = key.to_string();
    let checked = tauri::async_runtime::spawn_blocking(move || {
        llm::inspect_key(&provider_for_check, &key_for_check, &probe_model)
    })
    .await
    .map_err(|_| tr("Não foi possível contactar o provedor.").into_owned())?;
    match checked {
        Ok(inspection) => {
            keys::set_key(&app, &provider, key).map_err(key_store_error)?;
            Ok(AiKeyReport {
                stored: true,
                accepted: true,
                tone: if inspection.warning.is_some() {
                    "warn".into()
                } else {
                    "ok".into()
                },
                detail: inspection.detail,
                models: inspection.models,
            })
        }
        Err(error) => Ok(AiKeyReport {
            stored: keys::has_key(&app, &provider),
            accepted: false,
            tone: error.tone().into(),
            detail: error.detail,
            models: Vec::new(),
        }),
    }
}

fn key_store_error(code: &str) -> String {
    match code {
        "bad_provider" => tr("Provedor de IA desconhecido.").into_owned(),
        "bad_key" => tr("A chave da API não foi aceita.").into_owned(),
        _ => tr("Não foi possível guardar a chave da API.").into_owned(),
    }
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
        .map_err(|_| tr("Não foi possível contactar o provedor.").into_owned())?
        .map_err(|error| error.detail)
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
        thinking_budget: None,
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
        thinking_budget: None,
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

#[derive(Clone)]
pub(crate) struct StoredTranscript {
    pub id: String,
    pub at: u64,
    pub text: String,
}

/// Every non-empty transcript, oldest first. The stand-in reads and searches
/// these; the page never receives the whole cache.
pub(crate) fn stored_transcripts(app: &AppHandle) -> Vec<StoredTranscript> {
    let Ok(path) = cache_path(app) else {
        return Vec::new();
    };
    let cache = load_cache(&path);
    let mut notes: Vec<StoredTranscript> = cache
        .items
        .into_iter()
        .filter_map(|(id, entry)| {
            let text = entry.text.trim();
            if text.is_empty() {
                return None;
            }
            Some(StoredTranscript {
                id,
                at: entry.at,
                text: text.to_string(),
            })
        })
        .collect();
    notes.sort_by(|left, right| left.at.cmp(&right.at).then_with(|| left.id.cmp(&right.id)));
    notes
}

pub(crate) fn cached_transcript(app: &AppHandle, id_or_token: &str) -> Option<String> {
    let needle = id_or_token.trim();
    if needle.is_empty() {
        return None;
    }
    let path = cache_path(app).ok()?;
    let cache = load_cache(&path);
    let wanted = {
        let token = crate::todo::message_token(needle);
        if token.is_empty() {
            needle.to_string()
        } else {
            token
        }
    };
    let text_of = |entry: &Entry| {
        let text = entry.text.trim();
        if text.is_empty() {
            None
        } else {
            Some(text.to_string())
        }
    };
    if let Some(found) = cache.items.get(needle).and_then(text_of) {
        return Some(found);
    }
    cache.items.iter().find_map(|(id, entry)| {
        let token = crate::todo::message_token(id);
        if id == needle || (!wanted.is_empty() && (token == wanted || id == &wanted)) {
            text_of(entry)
        } else {
            None
        }
    })
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("voice-transcripts.json"))
}

pub(crate) fn embed_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cache_path(app)?.with_file_name("voice-embeddings.json"))
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

/// MIME type for FluidVoice's raw-byte mode. The documented request uses an
/// audio type; `application/octet-stream` is not one of them.
pub fn audio_content_type(filename: &str) -> &'static str {
    match filename.rsplit('.').next() {
        Some("opus") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        _ => "application/octet-stream",
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

fn wants_speaker_labels(audio: &[u8]) -> bool {
    !audio.starts_with(b"OggS")
}

fn transcribe_url(port: u16, speaker_labels: bool) -> String {
    let port = settings::sanitize_port(port);
    if speaker_labels {
        format!("http://127.0.0.1:{port}/v1/transcribe?speakerLabels=1")
    } else {
        format!("http://127.0.0.1:{port}/v1/transcribe")
    }
}

/// Prefer speaker turns when FluidVoice labeled more than one speaker.
/// A missing or unusable `speakerSegments` field keeps `text`.
fn transcript_text(value: &Value) -> Option<String> {
    let plain = value.get("text").and_then(Value::as_str)?.to_owned();
    let Some(segments) = value.get("speakerSegments").and_then(Value::as_array) else {
        return Some(plain);
    };
    Some(labeled_transcript(segments).unwrap_or(plain))
}

struct SpeakerTurn {
    speaker: String,
    start: f64,
    text: String,
}

fn labeled_transcript(segments: &[Value]) -> Option<String> {
    let mut turns = Vec::new();
    for item in segments {
        let Some(text) = item.get("text").and_then(Value::as_str) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let speaker = item
            .get("speaker")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if speaker.is_empty() {
            return None;
        }
        let Some(start) = item.get("startSeconds").and_then(Value::as_f64) else {
            continue;
        };
        if !start.is_finite() {
            continue;
        }
        turns.push(SpeakerTurn {
            speaker: speaker.to_string(),
            start,
            text: text.to_string(),
        });
    }
    if turns.is_empty() {
        return None;
    }
    turns.sort_by(|left, right| left.start.total_cmp(&right.start));
    let names: BTreeSet<&str> = turns.iter().map(|turn| turn.speaker.as_str()).collect();
    if names.len() < 2 {
        return Some(
            turns
                .into_iter()
                .map(|turn| turn.text)
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    Some(
        turns
            .iter()
            .map(|turn| {
                format!(
                    "[{}] {}: {}",
                    speaker_timestamp(turn.start),
                    turn.speaker,
                    turn.text
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
    )
}

fn speaker_timestamp(seconds: f64) -> String {
    let total = seconds.max(0.0).floor() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let secs = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

/// Base64 grows by 4/3. Notes larger than this skip that body and use a file.
const BASE64_MAX: usize = 18 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Transport {
    Raw,
    Base64,
    File,
}

/// Raw bytes first. Base64 next, unless the note is too large. A temp file last,
/// so a server that only accepts `{"path"}` or `{"audioBase64"}` still works.
fn transports_for(audio_len: usize) -> &'static [Transport] {
    if audio_len > BASE64_MAX {
        &[Transport::Raw, Transport::File]
    } else {
        &[Transport::Raw, Transport::Base64, Transport::File]
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum After {
    /// Try the next body. A 404, or a 400 that asks for `path` / `audioBase64`.
    Next,
    /// The server refused the audio itself.
    BadAudio,
    /// Any other status. Stop; another body will not help.
    Stop,
}

/// The documented refusal names the field it wanted (`audio path`, `audioBase64`).
/// A bare "path" is not enough: a decode error can echo the temp file's path.
fn asks_for_another_body(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("audiobase64") || lower.contains(" path") || lower.contains("\"path\"")
}

fn after_status(status: u16, body: &str) -> After {
    match status {
        // The raw body was the wrong shape, too large, or an unsupported type.
        // A file path or base64 body is a different request, so keep going.
        400 if asks_for_another_body(body) => After::Next,
        400 => After::BadAudio,
        404 | 413 | 415 => After::Next,
        _ => After::Stop,
    }
}

fn path_body(path: &Path) -> String {
    serde_json::json!({ "path": path.to_string_lossy() }).to_string()
}

fn base64_body(filename: &str, audio: &[u8]) -> String {
    serde_json::json!({
        "audioBase64": crate::window::base64_encode(audio),
        "filename": filename,
    })
    .to_string()
}

fn note_temp_path(dir: &Path, filename: &str, token: u64) -> PathBuf {
    let ext = Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| {
            !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or("opus");
    dir.join(format!(
        "whatrust-note-{}-{token}.{ext}",
        std::process::id()
    ))
}

fn fresh_note_path(filename: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    note_temp_path(
        &std::env::temp_dir(),
        filename,
        NEXT.fetch_add(1, Ordering::Relaxed),
    )
}

enum Attempt {
    Down,
    Status(u16, String),
}

fn post_once(
    port: u16,
    labels: bool,
    transport: Transport,
    audio: &[u8],
    filename: &str,
    temp: &mut Option<PathBuf>,
) -> Result<String, Attempt> {
    let url = transcribe_url(port, labels);
    let response = match transport {
        Transport::Raw => llm::client(Duration::from_secs(FLUID_TRANSCRIBE_SECS))
            .post(&url)
            .set("X-Filename", filename)
            .set("Content-Type", audio_content_type(filename))
            .send_bytes(audio),
        Transport::Base64 => llm::client(Duration::from_secs(FLUID_TRANSCRIBE_SECS))
            .post(&url)
            .set("Content-Type", "application/json")
            .send_string(&base64_body(filename, audio)),
        Transport::File => {
            let path = match temp.clone() {
                Some(path) => path,
                None => {
                    let path = fresh_note_path(filename);
                    if std::fs::write(&path, audio).is_err() {
                        let _ = std::fs::remove_file(&path);
                        return Err(Attempt::Down);
                    }
                    *temp = Some(path.clone());
                    path
                }
            };
            llm::client(Duration::from_secs(FLUID_TRANSCRIBE_SECS))
                .post(&url)
                .set("Content-Type", "application/json")
                .send_string(&path_body(&path))
        }
    };
    match response {
        Ok(response) => {
            let text = response.into_string().map_err(|_| Attempt::Down)?;
            let value: Value = serde_json::from_str(&text).map_err(|_| Attempt::Down)?;
            transcript_text(&value).ok_or(Attempt::Down)
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            if code == 400 && !asks_for_another_body(&body) {
                crate::dlog::log("voice: fluidvoice rejected audio");
            } else {
                crate::dlog::log(&format!("voice: fluidvoice status={code}"));
            }
            Err(Attempt::Status(code, body))
        }
        Err(_) => {
            crate::dlog::log("voice: fluidvoice unreachable");
            Err(Attempt::Down)
        }
    }
}

fn fluid_transcribe(port: u16, audio: &[u8], filename: &str) -> Result<String, &'static str> {
    let labels = wants_speaker_labels(audio);
    let mut temp = None;
    let result = (|| {
        for transport in transports_for(audio.len()) {
            match post_once(port, labels, *transport, audio, filename, &mut temp) {
                Ok(text) => return Ok(text),
                Err(Attempt::Down) => return Err("fluidvoice"),
                Err(Attempt::Status(code, body)) => {
                    let first = after_status(code, &body);
                    // `speakerLabels` is a Mac query. Retry the same body once
                    // without it before deciding the audio itself was refused.
                    if labels && matches!(first, After::Next | After::BadAudio) {
                        match post_once(port, false, *transport, audio, filename, &mut temp) {
                            Ok(text) => return Ok(text),
                            Err(Attempt::Down) => return Err("fluidvoice"),
                            Err(Attempt::Status(code, body)) => {
                                let second = after_status(code, &body);
                                // A 404 or "send a path" on the labeled call must
                                // not die just because the plain call says the
                                // raw bytes were unusable. The next body may work.
                                if first == After::Next || second == After::Next {
                                    continue;
                                }
                                if second == After::BadAudio {
                                    return Err("bad_audio");
                                }
                                return Err("fluidvoice");
                            }
                        }
                    }
                    match first {
                        After::BadAudio => return Err("bad_audio"),
                        After::Stop => return Err("fluidvoice"),
                        After::Next => continue,
                    }
                }
            }
        }
        crate::dlog::log("voice: fluidvoice rejected every transport");
        Err("fluidvoice")
    })();
    if let Some(path) = temp {
        let _ = std::fs::remove_file(path);
    }
    result
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
    fn speaker_labels_are_requested_only_for_non_ogg() {
        assert!(!wants_speaker_labels(b"OggSrest"));
        assert!(wants_speaker_labels(b"xxxxftyp"));
        assert!(wants_speaker_labels(b"RIFFwav"));
        assert!(wants_speaker_labels(b"ID3tag"));
        assert!(wants_speaker_labels(b"????"));
        assert_eq!(
            transcribe_url(47733, false),
            "http://127.0.0.1:47733/v1/transcribe"
        );
        assert_eq!(
            transcribe_url(47733, true),
            "http://127.0.0.1:47733/v1/transcribe?speakerLabels=1"
        );
    }

    #[test]
    fn speaker_segments_format_when_several_people_speak() {
        let value = serde_json::json!({
            "text": "labeled already",
            "speakerSegments": [
                {"speaker": "Speaker 2", "startSeconds": 3723.4, "text": "later"},
                {"speaker": "Speaker 1", "startSeconds": 12.2, "text": "  hello "},
                {"speaker": "Speaker 2", "startSeconds": 40, "text": "middle"},
                {"speaker": "", "startSeconds": 1, "text": ""}
            ]
        });
        assert_eq!(
            transcript_text(&value).unwrap(),
            "[0:12] Speaker 1: hello\n\n[0:40] Speaker 2: middle\n\n[1:02:03] Speaker 2: later"
        );
    }

    #[test]
    fn one_speaker_or_bad_segments_stay_unlabeled() {
        let one = serde_json::json!({
            "text": "[0:01] Speaker 1: baked label",
            "speakerSegments": [
                {"speaker": "Speaker 1", "startSeconds": 2, "text": "second"},
                {"speaker": "Speaker 1", "startSeconds": 1, "text": "first"}
            ]
        });
        assert_eq!(transcript_text(&one).unwrap(), "first second");

        let empty = serde_json::json!({"text": "plain", "speakerSegments": []});
        assert_eq!(transcript_text(&empty).unwrap(), "plain");

        let not_array = serde_json::json!({"text": "plain", "speakerSegments": {"speaker": "A"}});
        assert_eq!(transcript_text(&not_array).unwrap(), "plain");

        let blank_name = serde_json::json!({
            "text": "plain",
            "speakerSegments": [{"speaker": "  ", "startSeconds": 1, "text": "hidden"}]
        });
        assert_eq!(transcript_text(&blank_name).unwrap(), "plain");

        assert!(transcript_text(&serde_json::json!({"speakerSegments": []})).is_none());
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
    fn the_windows_installer_is_the_official_fluidvoice_download() {
        let url = fluidvoice_windows_setup_url().unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("fluidvoice.com"));
        assert_eq!(url.path(), "/fluid/download/windows");
    }

    #[test]
    fn content_types_match_the_filename() {
        assert_eq!(audio_content_type("note.opus"), "audio/ogg");
        assert_eq!(audio_content_type("note.m4a"), "audio/mp4");
        assert_eq!(audio_content_type("note.wav"), "audio/wav");
        assert_eq!(audio_content_type("note.mp3"), "audio/mpeg");
        assert_eq!(audio_content_type("note"), "application/octet-stream");
    }

    #[test]
    fn transports_skip_base64_once_the_note_is_too_large() {
        assert_eq!(
            transports_for(32),
            &[Transport::Raw, Transport::Base64, Transport::File]
        );
        assert_eq!(
            transports_for(BASE64_MAX + 1),
            &[Transport::Raw, Transport::File]
        );
    }

    #[test]
    fn a_windows_path_round_trips_through_the_json_body() {
        let path = Path::new(r"C:\Users\a\AppData\Local\Temp\note.opus");
        let body = path_body(path);
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            value.get("path").and_then(Value::as_str),
            Some(r"C:\Users\a\AppData\Local\Temp\note.opus")
        );
        assert!(body.contains(r"C:\\Users\\a\\AppData\\Local\\Temp\\note.opus"));
    }

    #[test]
    fn a_missing_path_error_tries_the_next_body_and_a_refusal_does_not() {
        assert_eq!(
            after_status(400, r#"{"error":"Missing audio path or audioBase64."}"#),
            After::Next
        );
        assert_eq!(after_status(404, "not found"), After::Next);
        assert_eq!(after_status(400, "could not decode audio"), After::BadAudio);
        assert_eq!(
            after_status(400, r#"could not decode C:\Users\a\Temp\note.opus"#),
            After::BadAudio
        );
        assert_eq!(after_status(413, "too large"), After::Next);
        assert_eq!(after_status(415, "unsupported media type"), After::Next);
        assert_eq!(after_status(500, "down"), After::Stop);
    }

    #[test]
    fn the_temp_note_keeps_a_windows_directory_and_the_extension() {
        let dir = Path::new(r"C:\Users\a\AppData\Local\Temp");
        let path = note_temp_path(dir, "note.opus", 7);
        assert_eq!(path.parent(), Some(dir));
        assert!(path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .ends_with(".opus"));
        assert!(path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("whatrust-note-"));
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

    #[test]
    fn transcript_lookup_returns_only_the_requested_ids_from_one_list() {
        let stored = vec![
            StoredTranscript {
                id: "false_1@c.us_AAA".into(),
                at: 1,
                text: "  hello  ".into(),
            },
            StoredTranscript {
                id: "false_1@c.us_BBB".into(),
                at: 2,
                text: "other".into(),
            },
        ];
        let hits = select_transcripts(
            &stored,
            &[
                "false_1@c.us_AAA".into(),
                "nope".into(),
                "false_9@c.us_ZZZ".into(),
            ],
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "false_1@c.us_AAA");
        assert_eq!(hits[0].text, "hello");
        let mut ids: Vec<String> = (0..TRANSCRIPT_LIMIT + 1)
            .map(|n| format!("false_1@c.us_{n:04}"))
            .collect();
        ids[0] = "false_1@c.us_BBB".into();
        let hits = select_transcripts(&stored, &ids);
        assert!(hits.iter().all(|hit| hit.id != "false_1@c.us_BBB"));
    }
}

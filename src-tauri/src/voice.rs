//! Voice-note transcription for the WhatsApp webview.
//!
//! `voice.js` frames each decrypted note as `[u16 id length][id][u64 message
//! time][audio]` and `invoke`s it as raw bytes. A frame from an older page,
//! without the time, is still accepted. Audio is posted to FluidVoice on
//! `127.0.0.1`. Translation and summaries go out from here, so the page never
//! holds an API key. The text is stored per account in [`crate::transcript_store`].

use crate::i18n::tr;
use crate::keys;
use crate::llm::{self, Completion};
use crate::settings::{self, Settings};
use crate::transcript_store::{self, Claim, NewNote};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Webview};

pub const MAX_AUDIO: usize = 20 * 1024 * 1024;
pub const MAX_VIDEO: usize = 64 * 1024 * 1024;

/// The Windows beta button on fluidvoice.com. It redirects to the current
/// official `FluidVoice_*_x64-setup.exe`. The page cannot supply another address.
const FLUIDVOICE_WINDOWS_SETUP: &str = "https://fluidvoice.com/fluid/download/windows";
const FLUID_TRANSCRIBE_SECS: u64 = 180;
/// Two length bytes, a 180-byte id, and an 8-byte message time.
const FRAME_SLACK: usize = 190;

#[derive(Clone, Serialize)]
pub struct VoicePrefs {
    pub enabled: bool,
    pub video: bool,
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
        video: settings.video_transcribe && crate::lock::is_unlocked(app),
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

fn account_of(window: &Webview) -> Result<String, String> {
    page(window)?;
    crate::accounts::id_from_label(window.label())
        .filter(|id| crate::todo::valid_account_id(id))
        .map(str::to_string)
        .ok_or_else(|| "forbidden".into())
}

#[tauri::command]
pub async fn voice_lookup(
    window: Webview,
    app: AppHandle,
    id: String,
) -> Result<VoiceView, String> {
    let account = account_of(&window)?;
    if !valid_message_id(&id) {
        return Err("bad_id".into());
    }
    if !crate::lock::is_unlocked(&app) {
        return Ok(disabled(id));
    }
    lookup_stored(&app, &account, id).await
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
    let account = account_of(&window)?;
    crate::lock::require_unlocked(&app)?;
    prepare_store(&app);
    let Ok(dir) = transcripts_dir(&app) else {
        return Ok(Vec::new());
    };
    let notes = transcript_store::by_tokens(&dir, &account, &ids).map_err(|err| {
        crate::dlog::log(&format!("voice: read {err}"));
        err
    })?;
    let stored: Vec<StoredTranscript> = notes.iter().filter_map(stored_of).collect();
    Ok(select_transcripts(&stored, &ids))
}

#[tauri::command]
pub async fn transcribe_voice(
    window: Webview,
    app: AppHandle,
    request: Request<'_>,
) -> Result<VoiceView, String> {
    let account = account_of(&window)?;
    let packed = payload_limited(request.body(), MAX_AUDIO)?;
    let framed = split_media(&packed, MAX_AUDIO).map_err(str::to_string)?;
    let settings = settings::load(&app);
    if !crate::lock::is_unlocked(&app) || !settings.voice_transcribe {
        return Ok(disabled(framed.id));
    }
    transcribe_locked(&app, &account, &settings, framed, "voice").await
}

#[tauri::command]
pub async fn transcribe_video(
    window: Webview,
    app: AppHandle,
    request: Request<'_>,
) -> Result<VoiceView, String> {
    let account = account_of(&window)?;
    let packed = payload_limited(request.body(), MAX_VIDEO)?;
    let framed = split_media(&packed, MAX_VIDEO).map_err(str::to_string)?;
    drop(packed);
    let settings = settings::load(&app);
    if !crate::lock::is_unlocked(&app) || !settings.video_transcribe {
        return Ok(disabled(framed.id));
    }
    let audio = crate::mp4audio::aac_m4a(&framed.audio).map_err(|err| err.code().to_string())?;
    // The await below keeps every live local. Drop the picture before waiting
    // on FluidVoice, which can take minutes.
    let framed = Framed {
        id: framed.id,
        at_ms: framed.at_ms,
        audio,
    };
    transcribe_locked(&app, &account, &settings, framed, "video").await
}

#[tauri::command]
pub async fn summarize_voice(
    window: Webview,
    app: AppHandle,
    id: String,
) -> Result<SummaryView, String> {
    let account = account_of(&window)?;
    if !valid_message_id(&id) {
        return Err("bad_id".into());
    }
    crate::lock::require_unlocked(&app)?;
    prepare_store(&app);
    let settings = settings::load(&app);
    let dir = transcripts_dir(&app)?;
    let note = transcript_store::load(&dir, &account, &id)?
        .filter(|note| note.state == "ready" && !note.text.trim().is_empty())
        .ok_or_else(|| "no_transcript".to_string())?;
    let sum_key = summary_key(&settings);
    if note.summary_key.as_deref() == Some(sum_key.as_str()) {
        if let Some(summary) = note.summary.clone() {
            return Ok(SummaryView { id, summary });
        }
    }
    let summary = run_summary(&app, &settings, &note.text).await?;
    transcript_store::save_summary(&dir, &account, &id, &summary, &sum_key)?;
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

fn missing(id: String) -> VoiceView {
    VoiceView {
        id,
        status: "missing".into(),
        text: String::new(),
        translation: None,
        notice: None,
    }
}

fn loading(id: String) -> VoiceView {
    VoiceView {
        id,
        status: "loading".into(),
        text: String::new(),
        translation: None,
        notice: None,
    }
}

fn transcripts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("transcripts");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(name))
}

fn prepare_store(app: &AppHandle) {
    let (Ok(dir), Ok(json), Ok(marker)) = (
        transcripts_dir(app),
        config_file(app, transcript_store::LEGACY_JSON),
        config_file(app, transcript_store::LEGACY_MARKER),
    ) else {
        return;
    };
    if let Err(err) = transcript_store::import_legacy(&dir, &json, &marker) {
        crate::dlog::log(&format!("voice: legacy import {err}"));
    }
}

/// A saved note, including a translation refresh. `missing` means there is no transcript yet.
async fn lookup_stored(app: &AppHandle, account: &str, id: String) -> Result<VoiceView, String> {
    let settings = settings::load(app);
    if !crate::lock::is_unlocked(app) || (!settings.voice_transcribe && !settings.video_transcribe)
    {
        return Ok(disabled(id));
    }
    prepare_store(app);
    let dir = transcripts_dir(app)?;
    let Some(note) = transcript_store::read(&dir, account, &id)? else {
        return Ok(missing(id));
    };
    if note.state != "ready" {
        // A crashed transcription leaves a running row. Let the page start
        // again once the claim is older than a FluidVoice call.
        if now_ms().saturating_sub(note.claimed_ms) >= FLUID_TRANSCRIBE_SECS * 1000 {
            return Ok(missing(id));
        }
        return Ok(loading(id));
    }
    // A stored transcript, even an empty one, is a finished result. The page
    // must not download the voice note again.
    let (translation, notice) = match ensure_translation(app, &settings, &dir, account, &note).await
    {
        Ok(translation) => (translation, None),
        Err(code) => (None, Some(code.to_string())),
    };
    Ok(VoiceView {
        id,
        status: "ready".into(),
        text: note.text,
        translation,
        notice,
    })
}

async fn transcribe_locked(
    app: &AppHandle,
    account: &str,
    settings: &Settings,
    framed: Framed,
    media: &'static str,
) -> Result<VoiceView, String> {
    prepare_store(app);
    let dir = transcripts_dir(app)?;
    let id = framed.id.clone();
    let claim = transcript_store::claim(
        &dir,
        account,
        &NewNote {
            id: id.clone(),
            at_ms: framed.at_ms,
            media,
        },
        now_ms(),
        FLUID_TRANSCRIBE_SECS * 1000,
    )?;
    match claim {
        Claim::Ready(note) => ready_note(app, settings, &dir, account, id, *note).await,
        Claim::Busy => Ok(loading(id)),
        Claim::Owned(generation) => {
            let audio = framed.audio;
            let port = settings.fluidvoice_port;
            let filename = audio_filename(&audio).to_string();
            let bytes = audio.len();
            let transcribed = tauri::async_runtime::spawn_blocking(move || {
                fluid_transcribe(port, &audio, &filename)
            })
            .await
            .map_err(|_| "fluidvoice".to_string())?;
            let text = match transcribed {
                Ok(text) => text,
                Err(code) => {
                    crate::dlog::log(&format!("voice: transcribe bytes={bytes} err={code}"));
                    // A newer claim may have taken over after the timeout. Only
                    // drop the row if it is still the one this call owns.
                    let removed =
                        transcript_store::release(&dir, account, &id, generation).unwrap_or(false);
                    if !removed {
                        return Ok(loading(id));
                    }
                    return Err(code.into());
                }
            };
            crate::dlog::log(&format!("voice: transcribed bytes={bytes}"));
            let saved = transcript_store::finish(
                &dir,
                account,
                &id,
                &text,
                framed.at_ms,
                now_ms(),
                generation,
            )?;
            if !saved {
                if let Some(note) = transcript_store::load(&dir, account, &id)? {
                    if note.state == "ready" {
                        return ready_note(app, settings, &dir, account, id, note).await;
                    }
                }
                return Ok(loading(id));
            }
            let Some(note) = transcript_store::load(&dir, account, &id)? else {
                return Err("claim".into());
            };
            ready_note(app, settings, &dir, account, id, note).await
        }
    }
}

async fn ready_note(
    app: &AppHandle,
    settings: &Settings,
    dir: &Path,
    account: &str,
    id: String,
    note: transcript_store::Note,
) -> Result<VoiceView, String> {
    let (translation, notice) = match ensure_translation(app, settings, dir, account, &note).await {
        Ok(translation) => (translation, None),
        Err(code) => (None, Some(code.to_string())),
    };
    Ok(VoiceView {
        id,
        status: "ready".into(),
        text: note.text,
        translation,
        notice,
    })
}

/// `Ok(None)` when translation is off. `Err("no_key" | "llm")` when it was requested and failed.
async fn ensure_translation(
    app: &AppHandle,
    settings: &Settings,
    dir: &Path,
    account: &str,
    note: &transcript_store::Note,
) -> Result<Option<String>, &'static str> {
    if !settings.translate_enabled {
        return Ok(None);
    }
    let key = translation_key(settings);
    if note.translation_key.as_deref() == Some(key.as_str()) {
        return Ok(note.translation.clone());
    }
    let text = llm::clip(&note.text).to_string();
    if text.trim().is_empty() {
        return Ok(None);
    }
    let owned = transcript_store::claim_translation(dir, account, &note.token, &key, now_ms())
        .map_err(|_| "llm")?;
    if !owned {
        return wait_translation(dir, account, &note.token, &key).await;
    }
    let api_key = match keys::get_key(app, &settings.ai_provider) {
        Ok(Some(key)) => key,
        Ok(None) => {
            let _ = transcript_store::clear_translation_claim(dir, account, &note.token, &key);
            return Err("no_key");
        }
        Err(_) => {
            let _ = transcript_store::clear_translation_claim(dir, account, &note.token, &key);
            return Err("no_key");
        }
    };
    let (system, user) = llm::translate_prompt(&settings.translate_target_lang, &text);
    let translated = match llm::complete(Completion {
        provider: &settings.ai_provider,
        model: settings.ai_model(),
        key: &api_key,
        system: &system,
        user: &user,
        max_tokens: 2048,
        thinking_budget: None,
        thinking_level: None,
    })
    .await
    {
        Ok(text) => text,
        Err(code) => {
            let _ = transcript_store::clear_translation_claim(dir, account, &note.token, &key);
            return Err(code);
        }
    };
    if transcript_store::save_translation(dir, account, &note.token, &key, &translated).is_err() {
        let _ = transcript_store::clear_translation_claim(dir, account, &note.token, &key);
        return Err("llm");
    }
    Ok(Some(translated))
}

async fn wait_translation(
    dir: &Path,
    account: &str,
    token: &str,
    key: &str,
) -> Result<Option<String>, &'static str> {
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let Ok(Some(note)) = transcript_store::load(dir, account, token) else {
            continue;
        };
        if note.translation_key.as_deref() == Some(key) {
            return Ok(note.translation);
        }
    }
    Ok(None)
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
        thinking_level: None,
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

fn stored_of(note: &transcript_store::Note) -> Option<StoredTranscript> {
    let text = note.text.trim();
    if note.state != "ready" || text.is_empty() {
        return None;
    }
    Some(StoredTranscript {
        id: note.id.clone(),
        at: note.at_ms,
        text: text.to_string(),
    })
}

/// Non-empty transcripts for these chats, oldest message first.
pub(crate) fn transcripts_for_chats(
    app: &AppHandle,
    account: &str,
    chats: &[String],
) -> Vec<StoredTranscript> {
    prepare_store(app);
    let Ok(dir) = transcripts_dir(app) else {
        return Vec::new();
    };
    match transcript_store::by_chats(&dir, account, chats) {
        Ok(notes) => notes.iter().filter_map(stored_of).collect(),
        Err(err) => {
            crate::dlog::log(&format!("voice: read {err}"));
            Vec::new()
        }
    }
}

pub(crate) fn cached_transcript(
    app: &AppHandle,
    account: &str,
    id_or_token: &str,
) -> Option<String> {
    let needle = id_or_token.trim();
    if needle.is_empty() {
        return None;
    }
    prepare_store(app);
    let dir = transcripts_dir(app).ok()?;
    let note = transcript_store::read(&dir, account, needle).ok()??;
    stored_of(&note).map(|note| note.text)
}

pub(crate) fn embed_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    config_file(app, "voice-embeddings.json")
}

pub fn delete_account(app: &AppHandle, account: &str) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    transcript_store::remove_account(&dir.join("transcripts"), account);
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

#[derive(Debug)]
struct Framed {
    id: String,
    at_ms: u64,
    audio: Vec<u8>,
}

fn container_at(bytes: &[u8]) -> bool {
    bytes.starts_with(b"OggS")
        || bytes.starts_with(b"RIFF")
        || bytes.starts_with(b"ID3")
        || bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3])
        || (bytes.len() >= 8 && &bytes[4..8] == b"ftyp")
}

/// `[u16 big-endian id length][utf-8 id][audio]`, or the same frame with an
/// 8-byte big-endian message time before the audio. An older page omits the
/// time; the audio container marks which shape this is.
#[cfg(test)]
pub fn split_payload(bytes: &[u8]) -> Result<(String, Vec<u8>), &'static str> {
    let framed = split_media(bytes, MAX_AUDIO)?;
    Ok((framed.id, framed.audio))
}

fn split_media(bytes: &[u8], max_media: usize) -> Result<Framed, &'static str> {
    if bytes.len() > max_media.saturating_add(FRAME_SLACK) {
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
    let rest = &bytes[2 + len..];
    let (at_ms, audio) = if rest.len() >= 8 && !container_at(rest) && container_at(&rest[8..]) {
        let at = u64::from_be_bytes(rest[..8].try_into().unwrap_or([0; 8]));
        (at, rest[8..].to_vec())
    } else {
        (0, rest.to_vec())
    };
    if audio.is_empty() {
        return Err("bad_audio");
    }
    if audio.len() > max_media {
        return Err("too_large");
    }
    Ok(Framed {
        id: id.to_string(),
        at_ms,
        audio,
    })
}

fn payload_limited(body: &InvokeBody, max_media: usize) -> Result<Vec<u8>, String> {
    let max = max_media.saturating_add(FRAME_SLACK);
    match body {
        InvokeBody::Raw(bytes) => {
            if bytes.len() > max {
                return Err("too_large".into());
            }
            Ok(bytes.clone())
        }
        InvokeBody::Json(value) => json_bytes(value, max),
    }
}

fn json_bytes(value: &Value, max: usize) -> Result<Vec<u8>, String> {
    let arr = value.as_array().ok_or("bad_audio")?;
    if arr.len() > max {
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

struct TempAudio {
    path: PathBuf,
}

impl Drop for TempAudio {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Delete leftover FluidVoice temp audio. A file newer than the request limit
/// whose process is still running belongs to another open window.
pub fn sweep_note_files() {
    sweep_notes_in(&std::env::temp_dir(), SystemTime::now(), process_alive);
}

fn sweep_notes_in(dir: &Path, now: SystemTime, alive: impl Fn(u32) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().into_string().ok() else {
            continue;
        };
        let Some(pid) = note_file_pid(&name) else {
            continue;
        };
        let path = entry.path();
        if keep_note(&path, pid, now, &alive) {
            continue;
        }
        let _ = std::fs::remove_file(path);
    }
}

fn note_file_pid(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("whatrust-note-")?;
    let (pid, rest) = rest.split_once('-')?;
    let (token, ext) = rest.split_once('.')?;
    if pid.is_empty()
        || token.is_empty()
        || !pid.chars().all(|c| c.is_ascii_digit())
        || !token.chars().all(|c| c.is_ascii_digit())
        || ext.is_empty()
        || ext.len() > 8
        || !ext.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    pid.parse().ok()
}

fn keep_note(path: &Path, pid: u32, now: SystemTime, alive: &impl Fn(u32) -> bool) -> bool {
    let Ok(modified) = std::fs::metadata(path).and_then(|meta| meta.modified()) else {
        return false;
    };
    let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
    age <= Duration::from_secs(FLUID_TRANSCRIBE_SECS) && alive(pid)
}

#[cfg(any(unix, test))]
fn probe_process(pid: u32, bins: &[&str]) -> bool {
    if bins.is_empty() {
        return true;
    }
    for bin in bins {
        match std::process::Command::new(bin)
            .arg("-0")
            .arg(pid.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
        {
            Ok(status) => return status.success(),
            Err(_) => continue,
        }
    }
    true
}

fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == std::process::id() {
        return true;
    }
    #[cfg(unix)]
    {
        // A packaged app often has no PATH, so a bare `kill` fails to spawn.
        // Failing the check must keep a fresh note another window is sending.
        probe_process(pid, &["/bin/kill", "/usr/bin/kill"])
    }
    #[cfg(windows)]
    {
        windows_process_alive(pid)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

#[cfg(windows)]
fn windows_process_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let _ = CloseHandle(handle);
        true
    }
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
    temp: &mut Option<TempAudio>,
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
            if temp.is_none() {
                let path = fresh_note_path(filename);
                if std::fs::write(&path, audio).is_err() {
                    let _ = std::fs::remove_file(&path);
                    return Err(Attempt::Down);
                }
                *temp = Some(TempAudio { path });
            }
            let path = temp
                .as_ref()
                .map(|note| note.path.clone())
                .ok_or(Attempt::Down)?;
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
    sweep_note_files();
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
    drop(temp);
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

    fn frame_at(id: &str, at_ms: u64, audio: &[u8]) -> Vec<u8> {
        let id_bytes = id.as_bytes();
        let mut out = Vec::with_capacity(2 + id_bytes.len() + 8 + audio.len());
        let len = u16::try_from(id_bytes.len()).unwrap();
        out.extend(len.to_be_bytes());
        out.extend(id_bytes);
        out.extend(at_ms.to_be_bytes());
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
        let old = split_media(&frame(id, audio), MAX_AUDIO).unwrap();
        assert_eq!(old.at_ms, 0);
        let timed = split_media(&frame_at(id, 1_700_000_000_000, audio), MAX_AUDIO).unwrap();
        assert_eq!(timed.at_ms, 1_700_000_000_000);
        assert_eq!(timed.audio, audio);
        let unknown = split_media(&frame(id, b"not-a-container"), MAX_AUDIO).unwrap();
        assert_eq!(unknown.at_ms, 0);
        assert_eq!(unknown.audio, b"not-a-container");
        let webm = [0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4];
        let timed = split_media(&frame_at(id, 42, &webm), MAX_AUDIO).unwrap();
        assert_eq!(timed.at_ms, 42);
        assert_eq!(timed.audio, webm);
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
        huge.resize(MAX_AUDIO + FRAME_SLACK + 1, 1);
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
    fn json_number_arrays_are_accepted_as_a_frame() {
        let framed = frame("false_123@c.us_ABC", b"OggShi");
        let value = Value::Array(framed.iter().map(|b| Value::from(*b)).collect());
        let bytes = json_bytes(&value, MAX_AUDIO + 182).unwrap();
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

    #[test]
    fn video_frame_accepts_64_mb_and_refuses_one_more() {
        let id = "false_123@c.us_ABC";
        let mut ok = frame(id, b"");
        ok.resize(2 + id.len() + MAX_VIDEO, 1);
        let framed = split_media(&ok, MAX_VIDEO).unwrap();
        assert_eq!(framed.id, id);
        assert_eq!(framed.audio.len(), MAX_VIDEO);
        ok.push(1);
        assert_eq!(split_media(&ok, MAX_VIDEO).unwrap_err(), "too_large");
    }

    static NEXT_SCRATCH: AtomicU64 = AtomicU64::new(1);

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "whatrust-{name}-{}-{}",
            std::process::id(),
            NEXT_SCRATCH.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_finished_note_file_is_removed() {
        let dir = scratch_dir("drop");
        let path = note_temp_path(&dir, "note.m4a", 1);
        std::fs::write(&path, b"audio").unwrap();
        {
            let _guard = TempAudio { path: path.clone() };
            assert!(path.exists());
        }
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn leftover_note_files_are_swept() {
        let dir = scratch_dir("sweep");
        let old = dir.join("whatrust-note-4242-1.m4a");
        let fresh = dir.join("whatrust-note-4242-2.opus");
        let dead = dir.join("whatrust-note-7-3.m4a");
        let other = dir.join("notes.txt");
        for path in [&old, &fresh, &dead, &other] {
            std::fs::write(path, b"audio").unwrap();
        }
        let file = std::fs::OpenOptions::new().write(true).open(&old).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(FLUID_TRANSCRIBE_SECS + 5))
            .unwrap();
        sweep_notes_in(&dir, SystemTime::now(), |pid| pid == 4242);
        assert!(!old.exists());
        assert!(fresh.exists());
        assert!(!dead.exists());
        assert!(other.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_kill_binary_keeps_a_fresh_note() {
        assert!(probe_process(1, &["/no/such/whatrust-kill"]));
    }

    #[cfg(unix)]
    #[test]
    fn a_live_process_keeps_its_note_and_a_dead_one_does_not() {
        let kill = if Path::new("/bin/kill").exists() {
            "/bin/kill"
        } else {
            "/usr/bin/kill"
        };
        if !Path::new(kill).exists() {
            return;
        }
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let alive = probe_process(pid, &[kill]);
        let _ = child.kill();
        let _ = child.wait();
        assert!(alive);
        assert!(!probe_process(pid, &[kill]));
    }
}

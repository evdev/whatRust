//! Reply popups for a personal mention, a reply to one of my messages, a
//! direct chat, or a group @everyone. The page reports which of those a
//! message matched. This module applies that account's switches, stacks at
//! most four windows at the top-right, and asks that account's page to send
//! a quote reply.
use crate::i18n::tr;
use crate::lock;
use crate::settings::{mention_alert_plan, MentionAccountPrefs, MentionAlertPlan, MentionMatch};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

pub const POPUP_W: f64 = 368.0;
pub const POPUP_H: f64 = 332.0;
const POPUP_GAP: f64 = 8.0;
const POPUP_MARGIN: f64 = 12.0;
const POPUP_MAX: usize = 4;
const HOLD_MAX: usize = 20;
const HOLD_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const SEEN_FOR: Duration = Duration::from_secs(120);
const REPLY_MAX: usize = 4096;
const FILE_MAX: usize = 8 * 1024 * 1024;
const VOICE_MAX: usize = 2 * 1024 * 1024;

#[derive(Default)]
pub struct Popups {
    inner: Mutex<Inner>,
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<(), String>>>>,
    filters: Mutex<HashMap<String, FilterWait>>,
    media: Mutex<HashMap<String, OutgoingMedia>>,
}

struct FilterWait {
    account: String,
    tx: tokio::sync::oneshot::Sender<Vec<String>>,
}

#[derive(Default)]
struct Inner {
    next: u64,
    /// Newest first.
    order: VecDeque<String>,
    cards: HashMap<String, Card>,
    /// Parked while locked, or waiting for a free slot. Newest first.
    waiting: VecDeque<Held>,
    seen: HashMap<(String, String), Instant>,
}

struct Card {
    account_label: String,
    chat_id: String,
    msg_id: String,
    chat_name: String,
    sender_name: String,
    body: String,
    at_ms: u64,
    sound: bool,
    account_name: String,
    mentions: bool,
    replies: bool,
    direct: bool,
    everyone: bool,
}

struct Held {
    account_label: String,
    chat_id: String,
    msg_id: String,
    chat_name: String,
    sender_name: String,
    body: String,
    at_ms: u64,
    account_name: String,
    mentions: bool,
    replies: bool,
    direct: bool,
    everyone: bool,
    queued: Instant,
}

#[derive(PartialEq, Eq)]
enum Release {
    Drop,
    Chime,
    Popup { sound: bool },
}

#[derive(Serialize)]
pub struct CardView {
    chat_name: String,
    sender_name: String,
    body: String,
    at_ms: u64,
    account_name: String,
    sound: bool,
}

pub fn boot_script(app: &AppHandle, label: &str) -> String {
    let settings = crate::settings::load(app);
    let id = crate::accounts::id_from_label(label).unwrap_or("default");
    boot_script_from(&crate::settings::prefs_for(&settings, id))
}

pub fn boot_script_from(prefs: &MentionAccountPrefs) -> String {
    format!(
        "window.__WHATRUST_MENTION={{mentions:{},replies:{},direct:{},everyone:{},popup:{},sound:{}}};",
        prefs.mentions, prefs.replies, prefs.direct, prefs.everyone, prefs.popup, prefs.sound
    )
}

pub fn push_prefs(app: &AppHandle, settings: &crate::settings::Settings) {
    for (label, view) in app.webviews() {
        let Some(id) = crate::accounts::id_from_label(&label) else {
            continue;
        };
        let prefs = crate::settings::prefs_for(settings, id);
        let script = format!(
            "window.__whatrustMentionPrefs&&window.__whatrustMentionPrefs({{mentions:{},replies:{},direct:{},everyone:{},popup:{},sound:{}}});",
            prefs.mentions, prefs.replies, prefs.direct, prefs.everyone, prefs.popup, prefs.sound
        );
        let _ = view.eval(&script);
    }
}

/// Top-right slot. `index` 0 is the newest, nearest the top.
pub fn popup_origin(
    work_x: f64,
    work_y: f64,
    work_w: f64,
    work_h: f64,
    index: usize,
) -> (f64, f64) {
    let x = (work_x + work_w - POPUP_MARGIN - POPUP_W).max(work_x);
    let y = work_y + POPUP_MARGIN + index as f64 * (POPUP_H + POPUP_GAP);
    let bottom = (work_y + work_h - POPUP_MARGIN - POPUP_H).max(work_y);
    (x, y.min(bottom))
}

pub fn reply_text(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(tr("Escreva uma resposta.").into_owned());
    }
    if text.chars().count() > REPLY_MAX {
        return Err(tr("A resposta é longa demais.").into_owned());
    }
    if text
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(tr("Não foi possível enviar.").into_owned());
    }
    Ok(text.to_string())
}

struct OutgoingMedia {
    filename: String,
    mime: String,
    bytes: Vec<u8>,
    voice: bool,
}

struct PreparedReply {
    text: String,
    kind: &'static str,
    media: Option<OutgoingMedia>,
}

fn prepare_reply(
    text: &str,
    kind: &str,
    filename: &str,
    mime: &str,
    data: &str,
) -> Result<PreparedReply, String> {
    let kind = match kind {
        "" | "text" => "text",
        "file" => "file",
        "voice" => "voice",
        _ => return Err(tr("Não foi possível enviar.").into_owned()),
    };
    if kind == "text" {
        return Ok(PreparedReply {
            text: reply_text(text)?,
            kind,
            media: None,
        });
    }
    let max = if kind == "voice" { VOICE_MAX } else { FILE_MAX };
    if data.len() > max.saturating_mul(4) / 3 + 8 {
        return Err(if kind == "voice" {
            tr("O áudio tem mais de 2 MB.").into_owned()
        } else {
            tr("O arquivo tem mais de 8 MB.").into_owned()
        });
    }
    let bytes = decode_base64(data).map_err(|_| tr("Não foi possível enviar.").to_string())?;
    if bytes.is_empty() {
        return Err(tr("Não foi possível enviar.").into_owned());
    }
    if bytes.len() > max {
        return Err(if kind == "voice" {
            tr("O áudio tem mais de 2 MB.").into_owned()
        } else {
            tr("O arquivo tem mais de 8 MB.").into_owned()
        });
    }
    let fallback = if kind == "voice" {
        "voice.webm"
    } else {
        "file"
    };
    let filename = safe_filename(filename, fallback);
    let mime = safe_mime(
        mime,
        if kind == "voice" {
            "audio/webm"
        } else {
            "application/octet-stream"
        },
    );
    let caption = text.trim();
    if caption.chars().count() > REPLY_MAX
        || caption
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(tr("Não foi possível enviar.").into_owned());
    }
    Ok(PreparedReply {
        text: caption.to_string(),
        kind,
        media: Some(OutgoingMedia {
            filename,
            mime,
            bytes,
            voice: kind == "voice",
        }),
    })
}

fn fold_ascii(c: char) -> String {
    let one = match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => Some('a'),
        'Á' | 'À' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' => Some('A'),
        'é' | 'è' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' => Some('e'),
        'É' | 'È' | 'Ê' | 'Ë' | 'Ē' | 'Ĕ' | 'Ė' | 'Ę' => Some('E'),
        'í' | 'ì' | 'î' | 'ï' | 'ī' | 'ĭ' | 'į' => Some('i'),
        'Í' | 'Ì' | 'Î' | 'Ï' | 'Ī' | 'Ĭ' | 'Į' => Some('I'),
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' | 'ō' | 'ŏ' | 'ő' => Some('o'),
        'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' | 'Ō' | 'Ŏ' | 'Ő' => Some('O'),
        'ú' | 'ù' | 'û' | 'ü' | 'ū' | 'ŭ' | 'ů' | 'ű' => Some('u'),
        'Ú' | 'Ù' | 'Û' | 'Ü' | 'Ū' | 'Ŭ' | 'Ů' | 'Ű' => Some('U'),
        'ý' | 'ÿ' => Some('y'),
        'Ý' => Some('Y'),
        'ç' | 'ć' | 'č' => Some('c'),
        'Ç' | 'Ć' | 'Č' => Some('C'),
        'ñ' | 'ń' => Some('n'),
        'Ñ' | 'Ń' => Some('N'),
        'š' => Some('s'),
        'Š' => Some('S'),
        'ž' => Some('z'),
        'Ž' => Some('Z'),
        'đ' => Some('d'),
        'Đ' => Some('D'),
        'ł' => Some('l'),
        'Ł' => Some('L'),
        _ => None,
    };
    if let Some(ch) = one {
        return ch.to_string();
    }
    match c {
        'æ' => "ae".into(),
        'Æ' => "Ae".into(),
        'œ' => "oe".into(),
        'Œ' => "Oe".into(),
        'ß' => "ss".into(),
        c if c.is_ascii()
            && !c.is_control()
            && !matches!(c, '/' | '\\' | '"' | '\'' | '<' | '>' | '&') =>
        {
            c.to_string()
        }
        _ => String::new(),
    }
}

fn safe_filename(name: &str, fallback: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(fallback);
    let (stem, ext) = match base.rfind('.') {
        Some(dot) if dot > 0 => (&base[..dot], &base[dot + 1..]),
        _ => (base, ""),
    };
    let ext =
        if !ext.is_empty() && ext.len() <= 10 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
            ext
        } else {
            ""
        };
    let mut folded = String::new();
    let budget = 80usize.saturating_sub(if ext.is_empty() { 0 } else { ext.len() + 1 });
    for c in stem.chars() {
        let part = fold_ascii(c);
        if folded.chars().count() + part.chars().count() > budget {
            break;
        }
        folded.push_str(&part);
    }
    let bare: String = folded.trim().trim_matches('.').to_string();
    if bare.is_empty() {
        if !ext.is_empty() && !fallback.contains('.') {
            return format!("{fallback}.{ext}");
        }
        return fallback.to_string();
    }
    if ext.is_empty() {
        folded
    } else {
        format!("{folded}.{ext}")
    }
}

fn safe_mime(mime: &str, fallback: &str) -> String {
    let mime = mime.split(';').next().unwrap_or("").trim();
    if mime.len() <= 100
        && mime.contains('/')
        && mime
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '+' | '-'))
    {
        mime.to_string()
    } else {
        fallback.to_string()
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, ()> {
    fn val(byte: u8) -> Result<u8, ()> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(()),
        }
    }
    let bytes = input.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err(());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks_exact(4) {
        let (a, b, c, d) = (chunk[0], chunk[1], chunk[2], chunk[3]);
        if a == b'=' || b == b'=' || (c == b'=' && d != b'=') {
            return Err(());
        }
        let pad = usize::from(c == b'=') + usize::from(d == b'=');
        let v0 = val(a)?;
        let v1 = val(b)?;
        let v2 = if c == b'=' { 0 } else { val(c)? };
        let v3 = if d == b'=' { 0 } else { val(d)? };
        out.push((v0 << 2) | (v1 >> 4));
        if pad < 2 {
            out.push(((v1 & 0x0f) << 4) | (v2 >> 2));
        }
        if pad < 1 {
            out.push(((v2 & 0x03) << 6) | v3);
        }
    }
    Ok(out)
}

fn plausible_id(value: &str) -> bool {
    let n = value.chars().count();
    (3..=180).contains(&n)
        && value.contains('@')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '-' | '+' | ':'))
}

fn clip(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn hold_prune(queue: &mut VecDeque<Held>, now: Instant) {
    queue.retain(|held| now.saturating_duration_since(held.queued) <= HOLD_TTL);
}

/// Newest first. The same account and message replaces its older copy.
fn hold_push(queue: &mut VecDeque<Held>, mut item: Held, now: Instant) {
    item.queued = now;
    hold_prune(queue, now);
    queue.retain(|held| !(held.account_label == item.account_label && held.msg_id == item.msg_id));
    queue.push_front(item);
    while queue.len() > HOLD_MAX {
        queue.pop_back();
    }
}

fn release_of(prefs: &MentionAccountPrefs, item: &Held) -> Release {
    let plan = mention_alert_plan(prefs, item.matched());
    if plan == MentionAlertPlan::none() {
        return Release::Drop;
    }
    if plan.popup {
        return Release::Popup { sound: plan.sound };
    }
    if plan.sound {
        return Release::Chime;
    }
    Release::Drop
}

impl Held {
    fn matched(&self) -> MentionMatch {
        MentionMatch {
            mentions: self.mentions,
            replies: self.replies,
            direct: self.direct,
            everyone: self.everyone,
        }
    }
}

fn hold_drop_account(queue: &mut VecDeque<Held>, account: &str) {
    queue.retain(|held| held.account_label != account);
}

fn hold_drop_chat(queue: &mut VecDeque<Held>, account: &str, chat: &str) {
    queue.retain(|held| !(held.account_label == account && held.chat_id == chat));
}

fn hold_drop_msg(queue: &mut VecDeque<Held>, account: &str, msg: &str) {
    queue.retain(|held| !(held.account_label == account && held.msg_id == msg));
}

fn send_script(chat_id: &str, msg_id: &str, text: &str, popup: &str, kind: &str) -> String {
    let chat = serde_json::to_string(chat_id).unwrap_or_else(|_| "\"\"".into());
    let msg = serde_json::to_string(msg_id).unwrap_or_else(|_| "\"\"".into());
    let body = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let label = serde_json::to_string(popup).unwrap_or_else(|_| "\"\"".into());
    let kind = serde_json::to_string(kind).unwrap_or_else(|_| "\"text\"".into());
    format!(
        "window.__whatrustMentionSend&&window.__whatrustMentionSend({chat},{msg},{body},{label},{kind})"
    )
}

fn open_script(chat_id: &str) -> String {
    let chat = serde_json::to_string(chat_id).unwrap_or_else(|_| "\"\"".into());
    format!("window.__whatrustMentionOpen&&window.__whatrustMentionOpen({chat})")
}

fn popups(app: &AppHandle) -> tauri::State<'_, Popups> {
    app.state::<Popups>()
}

fn is_popup(label: &str) -> bool {
    label.starts_with("mention-")
}

fn local_popup(window: &tauri::Webview) -> bool {
    is_popup(window.label())
        && window
            .url()
            .is_ok_and(|url| crate::integration::local_url(&url))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn mention_event(
    window: tauri::Webview,
    app: AppHandle,
    chat_id: String,
    msg_id: String,
    sender_id: String,
    chat_name: String,
    sender_name: String,
    body: String,
    at_ms: u64,
    mentions: bool,
    replies: bool,
    direct: bool,
    everyone: bool,
) -> Result<(), String> {
    crate::integration::remote(&window)?;
    if !mentions && !replies && !direct && !everyone {
        return Ok(());
    }
    if !plausible_id(&chat_id) || !plausible_id(&msg_id) {
        return Ok(());
    }
    let account = window.label().to_string();
    let account_id = account_id_from_label(&account);
    let settings = crate::settings::load(&app);
    let prefs = crate::settings::prefs_for(&settings, &account_id);
    let held = Held {
        account_label: account.clone(),
        chat_id,
        msg_id: msg_id.clone(),
        chat_name: clip(&chat_name, 120),
        sender_name: clip(&sender_name, 120),
        body: clip(&body, 500),
        at_ms: millis(at_ms),
        account_name: account_name(&app, &account),
        mentions,
        replies,
        direct,
        everyone,
        queued: Instant::now(),
    };
    if release_of(&prefs, &held) == Release::Drop {
        return Ok(());
    }
    let state = popups(&app);
    {
        let mut inner = lock::guard(&state.inner);
        let now = Instant::now();
        inner
            .seen
            .retain(|_, at| now.duration_since(*at) <= SEEN_FOR);
        let key = (account.clone(), msg_id);
        if inner.seen.contains_key(&key) {
            return Ok(());
        }
        inner.seen.insert(key.clone(), now);
        if inner.seen.len() > 2048 {
            inner.seen.clear();
            inner.seen.insert(key, now);
        }
        if !lock::is_unlocked(&app) {
            hold_push(&mut inner.waiting, held, now);
            crate::dlog::log("mention: parked while locked");
            return Ok(());
        }
    }
    deliver(&app, &account_id, &prefs, held);
    let _ = sender_id;
    Ok(())
}

#[tauri::command]
pub fn mention_card(window: tauri::Webview, app: AppHandle) -> Result<CardView, String> {
    if !local_popup(&window) {
        return Err("forbidden".into());
    }
    lock::require_unlocked(&app)?;
    let state = popups(&app);
    let inner = lock::guard(&state.inner);
    let card = inner.cards.get(window.label()).ok_or("closed")?;
    Ok(CardView {
        chat_name: card.chat_name.clone(),
        sender_name: card.sender_name.clone(),
        body: card.body.clone(),
        at_ms: card.at_ms,
        account_name: card.account_name.clone(),
        sound: card.sound,
    })
}

#[tauri::command]
pub async fn mention_reply(
    window: tauri::Webview,
    app: AppHandle,
    text: String,
    kind: Option<String>,
    filename: Option<String>,
    mime: Option<String>,
    data: Option<String>,
) -> Result<(), String> {
    if !local_popup(&window) {
        return Err("forbidden".into());
    }
    lock::require_unlocked(&app)?;
    let label = window.label().to_string();
    let prepared = prepare_reply(
        &text,
        kind.as_deref().unwrap_or("text"),
        filename.as_deref().unwrap_or(""),
        mime.as_deref().unwrap_or(""),
        data.as_deref().unwrap_or(""),
    )?;
    let card = {
        let state = popups(&app);
        let inner = lock::guard(&state.inner);
        let card = inner.cards.get(&label).ok_or("closed")?;
        (
            card.account_label.clone(),
            card.chat_id.clone(),
            card.msg_id.clone(),
        )
    };
    {
        let state = popups(&app);
        if lock::guard(&state.pending).contains_key(&label) {
            return Err(tr("Não foi possível enviar.").into_owned());
        }
    }
    if let Some(media) = prepared.media {
        let state = popups(&app);
        lock::guard(&state.media).insert(label.clone(), media);
    } else {
        let state = popups(&app);
        lock::guard(&state.media).remove(&label);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let state = popups(&app);
        lock::guard(&state.pending).insert(label.clone(), tx);
    }
    let wait = if prepared.kind == "text" {
        Duration::from_secs(25)
    } else {
        Duration::from_secs(60)
    };
    if let Err(err) = deliver_reply(
        &app,
        &card.0,
        &card.1,
        &card.2,
        &prepared.text,
        &label,
        prepared.kind,
    )
    .await
    {
        let state = popups(&app);
        lock::guard(&state.pending).remove(&label);
        return Err(err);
    }
    let result = match tokio::time::timeout(wait, rx).await {
        Ok(Ok(result)) => result,
        _ => {
            let state = popups(&app);
            lock::guard(&state.pending).remove(&label);
            Err(tr("Não foi possível enviar.").into_owned())
        }
    };
    if result.is_ok() {
        close_popup(&app, &label);
    }
    result
}

#[tauri::command]
pub fn mention_sent(
    window: tauri::Webview,
    app: AppHandle,
    label: String,
    ok: bool,
    error: String,
) -> Result<(), String> {
    crate::integration::remote(&window)?;
    if !is_popup(&label) {
        return Err("forbidden".into());
    }
    let state = popups(&app);
    let account = window.label().to_string();
    let owns = lock::guard(&state.inner)
        .cards
        .get(&label)
        .is_some_and(|card| card.account_label == account);
    if !owns {
        return Ok(());
    }
    let Some(tx) = lock::guard(&state.pending).remove(&label) else {
        return Ok(());
    };
    let _ = tx.send(if ok {
        Ok(())
    } else if error.trim().is_empty() {
        Err(tr("Não foi possível enviar.").into_owned())
    } else {
        Err(tr(&clip(&error, 180)).into_owned())
    });
    Ok(())
}

#[derive(Serialize)]
pub struct MediaView {
    filename: String,
    mime: String,
    data: String,
    voice: bool,
}

/// The WhatsApp page pulls the one file or voice note the popup is sending.
#[tauri::command]
pub fn mention_media(
    window: tauri::Webview,
    app: AppHandle,
    label: String,
) -> Result<MediaView, String> {
    crate::integration::remote(&window)?;
    if !is_popup(&label) {
        return Err("forbidden".into());
    }
    let state = popups(&app);
    let owns = lock::guard(&state.inner)
        .cards
        .get(&label)
        .is_some_and(|card| card.account_label == window.label());
    if !owns {
        return Err("forbidden".into());
    }
    let (filename, mime, voice, bytes) = {
        let media = lock::guard(&state.media);
        let media = media
            .get(&label)
            .ok_or_else(|| tr("Não foi possível enviar.").to_string())?;
        (
            media.filename.clone(),
            media.mime.clone(),
            media.voice,
            media.bytes.clone(),
        )
    };
    Ok(MediaView {
        filename,
        mime,
        data: crate::window::base64_encode(&bytes),
        voice,
    })
}

#[tauri::command]
pub fn mention_open(window: tauri::Webview, app: AppHandle) -> Result<(), String> {
    if !local_popup(&window) {
        return Err("forbidden".into());
    }
    lock::require_unlocked(&app)?;
    let label = window.label().to_string();
    let (account, chat) = {
        let state = popups(&app);
        let inner = lock::guard(&state.inner);
        let card = inner.cards.get(&label).ok_or("closed")?;
        (card.account_label.clone(), card.chat_id.clone())
    };
    let _ = ensure_view(&app, &account);
    reveal_account(&app, &account);
    if let Some(view) = app.get_webview(&account) {
        let _ = view.eval(open_script(&chat));
    }
    close_popup(&app, &label);
    Ok(())
}

#[tauri::command]
pub fn mention_dismiss(window: tauri::Webview, app: AppHandle) -> Result<(), String> {
    if !local_popup(&window) {
        return Err("forbidden".into());
    }
    close_popup(&app, window.label());
    Ok(())
}

/// The page reports a chat was read (`msg_id` empty) or one message was revoked.
#[tauri::command]
pub fn mention_settled(
    window: tauri::Webview,
    app: AppHandle,
    chat_id: String,
    msg_id: String,
) -> Result<(), String> {
    crate::integration::remote(&window)?;
    let account = window.label().to_string();
    if msg_id.is_empty() && !plausible_id(&chat_id) {
        return Ok(());
    }
    if !msg_id.is_empty() && !plausible_id(&msg_id) {
        return Ok(());
    }
    settle(&app, &account, &chat_id, &msg_id);
    Ok(())
}

/// Which parked messages the page says are already read. `drop` is those msg ids.
#[tauri::command]
pub fn mention_filter(
    window: tauri::Webview,
    app: AppHandle,
    token: String,
    drop_ids: Vec<String>,
) -> Result<(), String> {
    crate::integration::remote(&window)?;
    let state = popups(&app);
    let Some(wait) = lock::guard(&state.filters).remove(&token) else {
        return Ok(());
    };
    if wait.account != window.label() {
        let _ = wait.tx.send(Vec::new());
        return Ok(());
    }
    let drop_ids: Vec<String> = drop_ids
        .into_iter()
        .take(HOLD_MAX)
        .map(|id| clip(&id, 180))
        .collect();
    let _ = wait.tx.send(drop_ids);
    Ok(())
}

fn millis(at_ms: u64) -> u64 {
    if at_ms > 0 && at_ms < 1_000_000_000_000 {
        at_ms.saturating_mul(1000)
    } else {
        at_ms
    }
}

fn chime(app: &AppHandle, account_id: &str) {
    crate::mention_sound::play(app, account_id);
}

fn account_id_from_label(label: &str) -> String {
    crate::accounts::id_from_label(label)
        .unwrap_or("default")
        .to_string()
}

fn deliver(app: &AppHandle, account_id: &str, prefs: &MentionAccountPrefs, held: Held) {
    match release_of(prefs, &held) {
        Release::Drop => {}
        Release::Chime => chime(app, account_id),
        Release::Popup { sound } => {
            let label = stage(app, held, sound);
            if sound {
                chime(app, account_id);
            }
            spawn_present(app.clone(), vec![label]);
        }
    }
}

fn stage(app: &AppHandle, held: Held, sound: bool) -> String {
    let state = popups(app);
    let mut inner = lock::guard(&state.inner);
    inner.next += 1;
    let label = format!("mention-{}", inner.next);
    inner.order.push_front(label.clone());
    inner.cards.insert(
        label.clone(),
        Card {
            account_label: held.account_label,
            chat_id: held.chat_id,
            msg_id: held.msg_id,
            chat_name: held.chat_name,
            sender_name: held.sender_name,
            body: held.body,
            at_ms: held.at_ms,
            sound,
            account_name: held.account_name,
            mentions: held.mentions,
            replies: held.replies,
            direct: held.direct,
            everyone: held.everyone,
        },
    );
    label
}

fn spawn_present(app: AppHandle, labels: Vec<String>) {
    tauri::async_runtime::spawn_blocking(move || {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            for label in labels {
                present(&app2, &label);
            }
        });
    });
}

/// Hide every popup and park it. A later unlock shows it only if the chat
/// is still unread. The lock screen does not restore these windows itself.
pub fn on_lock(app: &AppHandle) {
    let state = popups(app);
    let (parked, labels) = {
        let mut inner = lock::guard(&state.inner);
        let labels: Vec<String> = inner.order.drain(..).collect();
        let mut parked = Vec::new();
        for label in &labels {
            if let Some(card) = inner.cards.remove(label) {
                parked.push(Held {
                    account_label: card.account_label,
                    chat_id: card.chat_id,
                    msg_id: card.msg_id,
                    chat_name: card.chat_name,
                    sender_name: card.sender_name,
                    body: card.body,
                    at_ms: card.at_ms,
                    account_name: card.account_name,
                    mentions: card.mentions,
                    replies: card.replies,
                    direct: card.direct,
                    everyone: card.everyone,
                    queued: Instant::now(),
                });
            }
        }
        (parked, labels)
    };
    let pending = std::mem::take(&mut *lock::guard(&state.pending));
    for (_, tx) in pending {
        let _ = tx.send(Err(tr("Não foi possível enviar.").into_owned()));
    }
    lock::guard(&state.filters).clear();
    for held in parked.into_iter().rev() {
        let mut inner = lock::guard(&state.inner);
        hold_push(&mut inner.waiting, held, Instant::now());
    }
    lock::guard(&state.media).clear();
    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.destroy();
        }
    }
}

pub fn on_unlock(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        filter_waiting(&app).await;
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || pump(&app2));
    });
}

pub fn drop_account(app: &AppHandle, label: &str) {
    settle(app, label, "", "");
}

fn settle(app: &AppHandle, account: &str, chat_id: &str, msg_id: &str) {
    let labels = {
        let state = popups(app);
        let mut inner = lock::guard(&state.inner);
        if msg_id.is_empty() && chat_id.is_empty() {
            hold_drop_account(&mut inner.waiting, account);
        } else if msg_id.is_empty() {
            hold_drop_chat(&mut inner.waiting, account, chat_id);
        } else {
            hold_drop_msg(&mut inner.waiting, account, msg_id);
        }
        inner
            .cards
            .iter()
            .filter(|(_, card)| {
                card.account_label == account
                    && if msg_id.is_empty() && chat_id.is_empty() {
                        true
                    } else if msg_id.is_empty() {
                        card.chat_id == chat_id
                    } else {
                        card.msg_id == msg_id
                    }
            })
            .map(|(label, _)| label.clone())
            .collect::<Vec<_>>()
    };
    for label in labels {
        close_popup(app, &label);
    }
}

async fn filter_waiting(app: &AppHandle) {
    let groups = {
        let state = popups(app);
        let inner = lock::guard(&state.inner);
        let mut groups: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for held in &inner.waiting {
            groups
                .entry(held.account_label.clone())
                .or_default()
                .push((held.chat_id.clone(), held.msg_id.clone()));
        }
        groups
    };
    for (account, rows) in groups {
        let Some(view) = app.get_webview(&account) else {
            continue;
        };
        let token = {
            let state = popups(app);
            let mut inner = lock::guard(&state.inner);
            inner.next += 1;
            format!("filter-{}", inner.next)
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let state = popups(app);
            lock::guard(&state.filters).insert(
                token.clone(),
                FilterWait {
                    account: account.clone(),
                    tx,
                },
            );
        }
        if view.eval(filter_script(&token, &rows)).is_err() {
            let state = popups(app);
            lock::guard(&state.filters).remove(&token);
            continue;
        }
        if let Ok(Ok(drop_ids)) = tokio::time::timeout(Duration::from_millis(1500), rx).await {
            let state = popups(app);
            let mut inner = lock::guard(&state.inner);
            inner.waiting.retain(|held| {
                held.account_label != account || !drop_ids.iter().any(|id| id == &held.msg_id)
            });
        } else {
            let state = popups(app);
            lock::guard(&state.filters).remove(&token);
        }
    }
}

fn filter_script(token: &str, rows: &[(String, String)]) -> String {
    let rows: Vec<_> = rows
        .iter()
        .map(|(chat, msg)| serde_json::json!({ "chatId": chat, "msgId": msg }))
        .collect();
    let rows = serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into());
    let token = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".into());
    format!("window.__whatrustMentionFilter&&window.__whatrustMentionFilter({token},{rows})")
}

fn pump(app: &AppHandle) {
    if !lock::is_unlocked(app) {
        return;
    }
    let settings = crate::settings::load(app);
    let mut show = Vec::new();
    let mut chimes = Vec::new();
    {
        let state = popups(app);
        let mut inner = lock::guard(&state.inner);
        hold_prune(&mut inner.waiting, Instant::now());
        let pending: Vec<Held> = inner.waiting.drain(..).collect();
        let slots = POPUP_MAX.saturating_sub(inner.order.len());
        let mut later = VecDeque::new();
        for item in pending {
            let account_id = account_id_from_label(&item.account_label);
            let prefs = crate::settings::prefs_for(&settings, &account_id);
            match release_of(&prefs, &item) {
                Release::Drop => {}
                Release::Chime => {
                    if !chimes.contains(&account_id) {
                        chimes.push(account_id);
                    }
                }
                Release::Popup { sound } => {
                    if show.len() < slots {
                        if sound && !chimes.contains(&account_id) {
                            chimes.push(account_id);
                        }
                        show.push((item, sound));
                    } else {
                        later.push_back(item);
                    }
                }
            }
        }
        inner.waiting = later;
    }
    for account_id in &chimes {
        chime(app, account_id);
    }
    let mut labels = Vec::new();
    for (item, sound) in show.into_iter().rev() {
        labels.push(stage(app, item, sound));
    }
    if !labels.is_empty() {
        spawn_present(app.clone(), labels);
    }
}

fn account_name(app: &AppHandle, label: &str) -> String {
    let file = crate::accounts::load(app);
    if file.accounts.len() < 2 {
        return String::new();
    }
    crate::accounts::id_from_label(label)
        .and_then(|id| file.accounts.iter().find(|account| account.id == id))
        .map(|account| account.name.clone())
        .unwrap_or_default()
}

fn evict_overflow(app: &AppHandle) {
    let extra = {
        let state = popups(app);
        let mut inner = lock::guard(&state.inner);
        let mut extra = Vec::new();
        while inner.order.len() > POPUP_MAX {
            if let Some(label) = inner.order.pop_back() {
                inner.cards.remove(&label);
                extra.push(label);
            }
        }
        extra
    };
    for label in extra {
        fail_pending(app, &label);
        let state = popups(app);
        lock::guard(&state.media).remove(&label);
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.destroy();
        }
    }
}

fn fail_pending(app: &AppHandle, label: &str) {
    let state = popups(app);
    let tx = lock::guard(&state.pending).remove(label);
    if let Some(tx) = tx {
        let _ = tx.send(Err(tr("Não foi possível enviar.").into_owned()));
    }
}

fn present(app: &AppHandle, label: &str) {
    evict_overflow(app);
    if app.get_webview_window(label).is_some() {
        layout(app);
        return;
    }
    let built = WebviewWindowBuilder::new(app, label, WebviewUrl::App("mention-popup.html".into()))
        .initialization_script(crate::i18n::init_script())
        .initialization_script(format!(
            "window.__MENTION_LABEL={};",
            serde_json::to_string(label).unwrap_or_else(|_| "\"\"".into())
        ))
        .additional_browser_args(crate::window::WEBVIEW2_SYNC_ARGS)
        .title("whatRust")
        .inner_size(POPUP_W, POPUP_H)
        .resizable(false)
        .decorations(false)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build();
    if let Ok(win) = built {
        crate::window::allow_popup_microphone(&win);
        layout(app);
        let _ = win.show();
    } else {
        forget(app, label, false);
        crate::dlog::log("mention: popup window failed");
    }
}

fn layout(app: &AppHandle) {
    let (order, anchor) = {
        let state = popups(app);
        let inner = lock::guard(&state.inner);
        let order: Vec<String> = inner.order.iter().cloned().collect();
        let anchor = order.first().and_then(|label| {
            inner
                .cards
                .get(label)
                .map(|card| card.account_label.clone())
        });
        (order, anchor)
    };
    let (work_x, work_y, work_w, work_h) = work_area(app, anchor.as_deref());
    for (index, label) in order.iter().enumerate() {
        let Some(win) = app.get_webview_window(label) else {
            continue;
        };
        let (x, y) = popup_origin(work_x, work_y, work_w, work_h, index);
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
}

fn work_area(app: &AppHandle, anchor: Option<&str>) -> (f64, f64, f64, f64) {
    let monitor = anchor
        .and_then(|label| app.get_webview(label))
        .and_then(|view| view.window().current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return (0.0, 0.0, 1280.0, 800.0);
    };
    let scale = monitor.scale_factor().max(1.0);
    let area = monitor.work_area();
    (
        area.position.x as f64 / scale,
        area.position.y as f64 / scale,
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
    )
}

fn close_popup(app: &AppHandle, label: &str) {
    forget(app, label, true);
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.destroy();
    }
}

fn forget(app: &AppHandle, label: &str, fill: bool) {
    let state = popups(app);
    let mut inner = lock::guard(&state.inner);
    inner.cards.remove(label);
    inner.order.retain(|item| item != label);
    drop(inner);
    fail_pending(app, label);
    let state = popups(app);
    lock::guard(&state.media).remove(label);
    layout(app);
    if fill {
        pump(app);
    }
}

async fn deliver_reply(
    app: &AppHandle,
    account: &str,
    chat_id: &str,
    msg_id: &str,
    text: &str,
    popup: &str,
    kind: &str,
) -> Result<(), String> {
    ensure_view(app, account)?;
    for _ in 0..40 {
        if app.get_webview(account).is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let Some(view) = app.get_webview(account) else {
        return Err(tr("O WhatsApp ainda está abrindo. Tente de novo.").into_owned());
    };
    view.eval(send_script(chat_id, msg_id, text, popup, kind))
        .map_err(|_| tr("Não foi possível enviar.").to_string())
}

fn ensure_view(app: &AppHandle, label: &str) -> Result<(), String> {
    if app.get_webview(label).is_some() {
        return Ok(());
    }
    let id = crate::accounts::id_from_label(label)
        .ok_or_else(|| tr("Conta indisponível.").to_string())?;
    let file = crate::accounts::load(app);
    let account = file
        .accounts
        .iter()
        .find(|account| account.id == id)
        .ok_or_else(|| tr("Conta indisponível.").to_string())?;
    if crate::sessions::enabled() {
        crate::sessions::open_account(app, account, true).map_err(|err| err.to_string())?;
    } else {
        crate::window::open_account_window(app, account, true).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn reveal_account(app: &AppHandle, label: &str) {
    if crate::sessions::enabled() {
        crate::sessions::activate(app, label);
        return;
    }
    if let Some(view) = app.get_webview(label) {
        let win = view.window();
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        boot_script_from, hold_push, popup_origin, prepare_reply, release_of, reply_text,
        send_script, Held, Release, FILE_MAX, POPUP_H, POPUP_W,
    };
    use crate::settings::MentionAccountPrefs;
    use std::collections::VecDeque;
    use std::time::{Duration, Instant};

    #[test]
    fn the_newest_popup_is_the_top_one() {
        let (x0, y0) = popup_origin(0.0, 0.0, 1440.0, 900.0, 0);
        let (_x1, y1) = popup_origin(0.0, 0.0, 1440.0, 900.0, 1);
        assert_eq!(x0, 1440.0 - 12.0 - POPUP_W);
        assert!(y0 < y1);
        assert!(y1 - y0 > POPUP_H);
    }

    #[test]
    fn a_short_screen_keeps_the_popup_on_it() {
        let (_, y) = popup_origin(0.0, 20.0, 800.0, 400.0, 5);
        assert!(y < 20.0 + 400.0 - POPUP_H);
    }

    #[test]
    fn an_empty_reply_is_refused_and_a_quote_is_escaped() {
        assert!(reply_text("  ").is_err());
        assert_eq!(reply_text("  hello \n").unwrap(), "hello");
        let js = send_script(
            "1@c.us",
            "false_1@c.us_A",
            "say \"hi\"",
            "mention-1",
            "text",
        );
        assert!(js.contains(r#"say \"hi\""#));
        assert!(js.starts_with("window.__whatrustMentionSend&&"));
        assert!(!js.contains("say \"hi\""));
    }

    #[test]
    fn the_boot_script_names_each_switch() {
        let prefs = MentionAccountPrefs {
            mentions: true,
            replies: false,
            direct: true,
            everyone: false,
            sound: false,
            popup: true,
            sound_file: None,
        };
        assert_eq!(
            boot_script_from(&prefs),
            "window.__WHATRUST_MENTION={mentions:true,replies:false,direct:true,everyone:false,popup:true,sound:false};"
        );
    }

    fn sample(account: &str, msg: &str, queued: Instant) -> Held {
        Held {
            account_label: account.into(),
            chat_id: "1@g.us".into(),
            msg_id: msg.into(),
            chat_name: "Family".into(),
            sender_name: "Ada".into(),
            body: "hello".into(),
            at_ms: 0,
            account_name: String::new(),
            mentions: true,
            replies: false,
            direct: false,
            everyone: false,
            queued,
        }
    }

    #[test]
    fn the_lock_queue_keeps_the_newest_twenty_and_replaces_a_repeat() {
        let now = Instant::now();
        let mut queue = VecDeque::new();
        for n in 0..25 {
            hold_push(
                &mut queue,
                sample("wa-default", &format!("false_1@g.us_{n}"), now),
                now,
            );
        }
        assert_eq!(queue.len(), 20);
        assert_eq!(queue.front().unwrap().msg_id, "false_1@g.us_24");
        assert_eq!(queue.back().unwrap().msg_id, "false_1@g.us_5");
        hold_push(
            &mut queue,
            sample("wa-default", "false_1@g.us_10", now),
            now,
        );
        assert_eq!(queue.len(), 20);
        assert_eq!(queue.front().unwrap().msg_id, "false_1@g.us_10");
        assert!(
            queue
                .iter()
                .filter(|held| held.msg_id == "false_1@g.us_10")
                .count()
                == 1
        );
    }

    #[test]
    fn a_day_old_parked_alert_is_dropped() {
        let now = Instant::now();
        let mut queue = VecDeque::new();
        let mut old = sample("wa-default", "false_1@g.us_old", now);
        old.queued = now
            .checked_sub(Duration::from_secs(25 * 60 * 60))
            .unwrap_or(now);
        queue.push_front(old);
        hold_push(
            &mut queue,
            sample("wa-default", "false_1@g.us_new", now),
            now,
        );
        assert_eq!(queue.len(), 1);
        assert_eq!(queue.front().unwrap().msg_id, "false_1@g.us_new");
    }

    #[test]
    fn unlocking_without_a_popup_only_chimes() {
        let item = sample("wa-default", "false_1@c.us_A", Instant::now());
        let sound_only = MentionAccountPrefs {
            mentions: true,
            popup: false,
            sound: true,
            ..MentionAccountPrefs::default()
        };
        assert!(matches!(release_of(&sound_only, &item), Release::Chime));
        assert!(matches!(
            release_of(&MentionAccountPrefs::default(), &item),
            Release::Drop
        ));
        let quiet = MentionAccountPrefs {
            mentions: true,
            popup: false,
            sound: false,
            ..MentionAccountPrefs::default()
        };
        assert!(matches!(release_of(&quiet, &item), Release::Drop));
    }

    #[test]
    fn a_file_can_be_a_captioned_reply_and_a_huge_one_cannot() {
        let file = prepare_reply(" caption ", "file", "notas.txt", "text/plain", "YWI=").unwrap();
        assert_eq!(file.text, "caption");
        assert_eq!(file.kind, "file");
        assert_eq!(file.media.unwrap().bytes, b"ab");
        let named = prepare_reply("", "file", "ação.pdf", "application/pdf", "YWJj").unwrap();
        assert_eq!(named.media.unwrap().filename, "acao.pdf");
        let blank = prepare_reply("", "file", "///", "application/pdf", "YWJj").unwrap();
        assert_eq!(blank.media.unwrap().filename, "file");
        let script = prepare_reply("", "file", "报告.pdf", "application/pdf", "YWJj").unwrap();
        assert_eq!(script.media.unwrap().filename, "file.pdf");
        assert_eq!(
            prepare_reply("", "file", "a.bin", "application/octet-stream", "YWJj")
                .unwrap()
                .media
                .unwrap()
                .bytes,
            b"abc"
        );
        assert!(prepare_reply("", "file", "a.txt", "text/plain", "").is_err());
        assert!(prepare_reply("hi", "text", "", "", "").is_ok());
        let huge = "A".repeat(FILE_MAX * 2);
        assert!(prepare_reply("", "voice", "voice.webm", "audio/webm", &huge).is_err());
    }
}

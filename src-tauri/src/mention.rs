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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

pub const POPUP_W: f64 = 368.0;
pub const POPUP_H: f64 = 332.0;
const POPUP_MIN_W: f64 = 300.0;
const POPUP_MIN_H: f64 = 280.0;
const POPUP_GAP: f64 = 8.0;
const POPUP_MARGIN: f64 = 12.0;
const POPUP_MAX: usize = 4;
const HOLD_MAX: usize = 20;
const HOLD_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const SEEN_FOR: Duration = Duration::from_secs(120);
const REPLY_MAX: usize = 4096;
const FILE_MAX: usize = 8 * 1024 * 1024;
const VOICE_MAX: usize = 2 * 1024 * 1024;
/// A few minutes of 16 kHz mono PCM, before it is encoded to a small Ogg file.
const VOICE_WAV_MAX: usize = 8 * 1024 * 1024;
/// An incoming voice note, still compressed, before it is turned into WAV.
const LISTEN_MAX: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub struct Popups {
    inner: Mutex<Inner>,
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<(), String>>>>,
    audio: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<Heard, String>>>>,
    chat_actions: Mutex<HashMap<String, ChatActionWait>>,
    next_chat_action: AtomicU64,
    filters: Mutex<HashMap<String, FilterWait>>,
    media: Mutex<HashMap<String, OutgoingMedia>>,
}

struct ChatActionWait {
    account: String,
    popup: String,
    tx: tokio::sync::oneshot::Sender<bool>,
}

#[derive(Clone, Copy)]
enum ChatAction {
    Open,
    MarkRead,
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
    /// Pictures accepted in the last few seconds, including ones whose window
    /// is not in `cards` yet. The second report of a photo arrives before the
    /// first window exists.
    photos: Vec<PhotoStamp>,
}

struct PhotoStamp {
    account: String,
    chat: String,
    sender: String,
    preview: String,
    at_ms: u64,
    when: Instant,
}

struct Card {
    account_label: String,
    automatic_geometry: Option<PopupGeometry>,
    chat_id: String,
    msg_id: String,
    chat_name: String,
    sender_name: String,
    body: String,
    preview: String,
    voice: bool,
    seconds: u32,
    at_ms: u64,
    sound: bool,
    account_name: String,
    mentions: bool,
    replies: bool,
    direct: bool,
    everyone: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct PopupGeometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

impl PopupGeometry {
    fn read(win: &WebviewWindow) -> Option<Self> {
        Some(Self {
            position: win.outer_position().ok()?,
            size: win.outer_size().ok()?,
        })
    }
}

struct Held {
    account_label: String,
    chat_id: String,
    msg_id: String,
    chat_name: String,
    sender_name: String,
    body: String,
    preview: String,
    voice: bool,
    seconds: u32,
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
    preview: String,
    voice: bool,
    seconds: u32,
    at_ms: u64,
    account_name: String,
    sound: bool,
}

#[derive(Serialize)]
pub(crate) struct Heard {
    mime: String,
    data: String,
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
    size: LogicalSize<f64>,
) -> (f64, f64) {
    let x = (work_x + work_w - POPUP_MARGIN - size.width).max(work_x);
    let y = work_y + POPUP_MARGIN + index as f64 * (size.height + POPUP_GAP);
    let bottom = (work_y + work_h - POPUP_MARGIN - size.height).max(work_y);
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
    let max = if kind == "voice" {
        VOICE_WAV_MAX
    } else {
        FILE_MAX
    };
    if data.len() > max.saturating_mul(4) / 3 + 8 {
        return Err(if kind == "voice" {
            tr("O áudio é longo demais.").into_owned()
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
            tr("O áudio é longo demais.").into_owned()
        } else {
            tr("O arquivo tem mais de 8 MB.").into_owned()
        });
    }
    let (filename, mime, bytes) = if kind == "voice" {
        let ogg = voice_ogg(&bytes)?;
        ("voice.ogg".to_string(), "audio/ogg".to_string(), ogg)
    } else {
        (
            safe_filename(filename, "file"),
            safe_mime(mime, "application/octet-stream"),
            bytes,
        )
    };
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

fn voice_ogg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let ogg = if is_ogg_opus(bytes) {
        bytes.to_vec()
    } else {
        match crate::voice_ogg::ogg_opus_from_wav(bytes) {
            Ok(ogg) => ogg,
            Err(err) => {
                let code = err.code();
                crate::dlog::log(&format!("mention: voice encode {code}"));
                return Err(tr("Não foi possível preparar o áudio.").into_owned());
            }
        }
    };
    if ogg.len() > VOICE_MAX {
        return Err(tr("O áudio tem mais de 2 MB.").into_owned());
    }
    Ok(ogg)
}

fn is_ogg_opus(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(128)];
    head.starts_with(b"OggS") && head.windows(8).any(|window| window == b"OpusHead")
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
    if !bytes.len().is_multiple_of(4) {
        return Err(());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.as_chunks::<4>().0 {
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

/// A second copy of a picture that WhatsApp reports under another id.
/// Different pictures keep their own popups: their thumbnails disagree.
fn duplicate_photo(
    cards: &HashMap<String, Card>,
    waiting: &VecDeque<Held>,
    photos: &[PhotoStamp],
    held: &Held,
) -> bool {
    let incoming = Arrival::from_held(held);
    cards
        .values()
        .any(|card| incoming.same_photo(&Arrival::from_card(card)))
        || waiting
            .iter()
            .any(|item| incoming.same_photo(&Arrival::from_held(item)))
        || photos
            .iter()
            .any(|item| incoming.same_photo(&Arrival::from_stamp(item)))
}

struct Arrival<'a> {
    account: &'a str,
    chat: &'a str,
    sender: &'a str,
    preview: &'a str,
    at_ms: u64,
}

impl<'a> Arrival<'a> {
    fn from_card(card: &'a Card) -> Self {
        Self {
            account: &card.account_label,
            chat: &card.chat_id,
            sender: &card.sender_name,
            preview: &card.preview,
            at_ms: card.at_ms,
        }
    }

    fn from_held(held: &'a Held) -> Self {
        Self {
            account: &held.account_label,
            chat: &held.chat_id,
            sender: &held.sender_name,
            preview: &held.preview,
            at_ms: held.at_ms,
        }
    }

    fn from_stamp(stamp: &'a PhotoStamp) -> Self {
        Self {
            account: &stamp.account,
            chat: &stamp.chat,
            sender: &stamp.sender,
            preview: &stamp.preview,
            at_ms: stamp.at_ms,
        }
    }

    fn same_photo(&self, other: &Arrival<'_>) -> bool {
        if self.account != other.account || self.at_ms.abs_diff(other.at_ms) > 8_000 {
            return false;
        }
        self.chat == other.chat
            && self.sender == other.sender
            && !self.preview.is_empty()
            && self.preview == other.preview
    }
}

/// The part of a WhatsApp id that stays put when a picture is reported
/// again as its type settles. `false_<chat>_<token>` and
/// `false_<chat>_<token>_<participant>` are one message.
fn message_token(id: &str) -> String {
    let Some(rest) = id
        .strip_prefix("true_")
        .or_else(|| id.strip_prefix("false_"))
    else {
        return id.to_string();
    };
    let Some(split) = rest.find('_') else {
        return id.to_string();
    };
    let tail = &rest[split + 1..];
    if tail.is_empty() {
        return id.to_string();
    }
    if let Some(cut) = tail.rfind('_') {
        let participant = &tail[cut + 1..];
        if participant.contains('@') && !participant.contains('_') {
            return tail[..cut].to_string();
        }
    }
    tail.to_string()
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

fn shown_name(value: &str) -> String {
    let text = clip(value, 120);
    let lower = text.to_ascii_lowercase();
    if lower.contains("@c.us")
        || lower.contains("@g.us")
        || lower.contains("@lid")
        || lower.contains("@s.whatsapp.net")
    {
        return String::new();
    }
    text
}

/// A JPEG thumbnail is base64 with no spaces. It is a picture, not the message.
fn shown_body(value: &str) -> String {
    let text = clip(value, 500);
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let blob = compact.chars().count() >= 80
        && compact
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='));
    if blob {
        String::new()
    } else {
        text
    }
}

fn shown_preview(value: &str) -> String {
    let text = value.trim();
    let Some(rest) = text.strip_prefix("data:image/") else {
        return String::new();
    };
    let Some((mime, data)) = rest.split_once(";base64,") else {
        return String::new();
    };
    if mime.is_empty()
        || !mime
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '+' | '-' | '.'))
        || !(64..=100_000).contains(&data.len())
        || !data
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
    {
        return String::new();
    }
    text.to_string()
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

/// `sent_at` of 0 drops every parked alert in the chat. A real send time
/// keeps an alert that arrived after that send.
fn hold_drop_chat(queue: &mut VecDeque<Held>, account: &str, chat: &str, sent_at: u64) {
    queue.retain(|held| {
        !(held.account_label == account && held.chat_id == chat && answered_by(held.at_ms, sent_at))
    });
}

/// An alert is answered when this account sent in that chat at or after it.
/// A missing send time answers every alert in the chat.
fn answered_by(alert_at: u64, sent_at: u64) -> bool {
    sent_at == 0 || alert_at <= sent_at
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

fn chat_action_script(chat_id: &str, request: &str, action: ChatAction) -> String {
    let chat = serde_json::to_string(chat_id).unwrap_or_else(|_| "\"\"".into());
    let request = serde_json::to_string(request).unwrap_or_else(|_| "\"\"".into());
    let method = match action {
        ChatAction::Open => "openChatBottom",
        ChatAction::MarkRead => "markIsRead",
    };
    format!("window.__whatrustMentionChatAction&&window.__whatrustMentionChatAction({chat},{request},'{method}')")
}

fn listen_script(msg_id: &str, label: &str) -> String {
    let msg = serde_json::to_string(msg_id).unwrap_or_else(|_| "\"\"".into());
    let label = serde_json::to_string(label).unwrap_or_else(|_| "\"\"".into());
    format!("window.__whatrustMentionListen&&window.__whatrustMentionListen({msg},{label})")
}

fn ensure_script(msg_id: &str) -> String {
    let msg = serde_json::to_string(msg_id).unwrap_or_else(|_| "\"\"".into());
    format!("window.__whatrustVoiceEnsure&&window.__whatrustVoiceEnsure({msg})")
}

fn playable(bytes: &[u8]) -> Result<(String, Vec<u8>), String> {
    let refuse = || tr("Não foi possível reproduzir o áudio.").into_owned();
    if bytes.starts_with(b"OggS") {
        let wav = crate::voice_ogg::wav_from_ogg(bytes).map_err(|err| {
            crate::dlog::log(&format!("mention: voice decode {}", err.code()));
            if err.code() == "too_long" {
                tr("O áudio é longo demais.").into_owned()
            } else {
                refuse()
            }
        })?;
        return Ok(("audio/wav".into(), wav));
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE" {
        return Ok(("audio/wav".into(), bytes.to_vec()));
    }
    if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
        return Ok(("audio/mp4".into(), bytes.to_vec()));
    }
    if bytes.starts_with(b"ID3")
        || (bytes.len() > 1 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0)
    {
        return Ok(("audio/mpeg".into(), bytes.to_vec()));
    }
    Err(refuse())
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
    preview: String,
    voice: bool,
    seconds: u32,
    at_ms: u64,
    mentions: bool,
    replies: bool,
    direct: bool,
    everyone: bool,
) -> Result<(), String> {
    crate::integration::remote(&window)?;
    if app
        .state::<crate::notify::Recent>()
        .privacy_masked(window.label())
    {
        return Ok(());
    }
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
        chat_name: shown_name(&chat_name),
        sender_name: shown_name(&sender_name),
        body: shown_body(&body),
        preview: shown_preview(&preview),
        voice,
        seconds: seconds.min(3600),
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
        let key = (account.clone(), message_token(&msg_id));
        if inner.seen.contains_key(&key) {
            return Ok(());
        }
        inner.seen.insert(key.clone(), now);
        if inner.seen.len() > 2048 {
            inner.seen.clear();
            inner.seen.insert(key, now);
        }
        inner
            .photos
            .retain(|stamp| now.duration_since(stamp.when) <= Duration::from_secs(8));
        if duplicate_photo(&inner.cards, &inner.waiting, &inner.photos, &held) {
            crate::dlog::log("mention: duplicate photo skipped");
            return Ok(());
        }
        if !held.preview.is_empty() {
            inner.photos.push(PhotoStamp {
                account: held.account_label.clone(),
                chat: held.chat_id.clone(),
                sender: held.sender_name.clone(),
                preview: held.preview.clone(),
                at_ms: held.at_ms,
                when: now,
            });
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
        preview: card.preview.clone(),
        voice: card.voice,
        seconds: card.seconds,
        at_ms: card.at_ms,
        account_name: card.account_name.clone(),
        sound: card.sound,
    })
}

#[tauri::command]
pub async fn mention_listen(window: tauri::Webview, app: AppHandle) -> Result<Heard, String> {
    if !local_popup(&window) {
        return Err("forbidden".into());
    }
    lock::require_unlocked(&app)?;
    let label = window.label().to_string();
    let (account, msg_id) = {
        let state = popups(&app);
        let inner = lock::guard(&state.inner);
        let card = inner.cards.get(&label).ok_or("closed")?;
        if !card.voice {
            return Err(tr("Não foi possível reproduzir o áudio.").into_owned());
        }
        (card.account_label.clone(), card.msg_id.clone())
    };
    {
        let state = popups(&app);
        if lock::guard(&state.audio).contains_key(&label) {
            return Err(tr("Não foi possível reproduzir o áudio.").into_owned());
        }
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let state = popups(&app);
        lock::guard(&state.audio).insert(label.clone(), tx);
    }
    if let Err(err) = ask_for_audio(&app, &account, &msg_id, &label).await {
        let state = popups(&app);
        lock::guard(&state.audio).remove(&label);
        return Err(err);
    }
    match tokio::time::timeout(Duration::from_secs(25), rx).await {
        Ok(Ok(result)) => result,
        _ => {
            let state = popups(&app);
            lock::guard(&state.audio).remove(&label);
            Err(tr("Não foi possível reproduzir o áudio.").into_owned())
        }
    }
}

#[tauri::command]
pub fn mention_heard(
    window: tauri::Webview,
    app: AppHandle,
    label: String,
    mime: String,
    data: String,
) -> Result<(), String> {
    crate::integration::remote(&window)?;
    let state = popups(&app);
    let Some(tx) = lock::guard(&state.audio).remove(&label) else {
        return Ok(());
    };
    let account = {
        let inner = lock::guard(&state.inner);
        inner
            .cards
            .get(&label)
            .map(|card| card.account_label.clone())
    };
    let finish = |result: Result<Heard, String>| {
        let _ = tx.send(result);
    };
    if account.as_deref() != Some(window.label()) {
        finish(Err(tr("Não foi possível reproduzir o áudio.").into_owned()));
        return Ok(());
    }
    let _ = mime;
    if data.is_empty() || data.len() > LISTEN_MAX / 3 * 4 + 8 {
        finish(Err(tr("Não foi possível reproduzir o áudio.").into_owned()));
        return Ok(());
    }
    let bytes = match decode_base64(&data) {
        Ok(bytes) if bytes.len() <= LISTEN_MAX => bytes,
        _ => {
            finish(Err(tr("Não foi possível reproduzir o áudio.").into_owned()));
            return Ok(());
        }
    };
    finish(playable(&bytes).map(|(mime, bytes)| Heard {
        mime,
        data: crate::window::base64_encode(&bytes),
    }));
    Ok(())
}

#[tauri::command]
pub async fn mention_transcript(
    window: tauri::Webview,
    app: AppHandle,
) -> Result<crate::voice::VoiceView, String> {
    if !local_popup(&window) {
        return Err("forbidden".into());
    }
    lock::require_unlocked(&app)?;
    let label = window.label().to_string();
    let (account_label, msg_id, voice) = {
        let state = popups(&app);
        let inner = lock::guard(&state.inner);
        let card = inner.cards.get(&label).ok_or("closed")?;
        (card.account_label.clone(), card.msg_id.clone(), card.voice)
    };
    if !voice {
        return Ok(crate::voice::VoiceView {
            id: msg_id,
            status: "disabled".into(),
            text: String::new(),
            translation: None,
            translation_key: None,
            notice: None,
        });
    }
    let account = account_id_from_label(&account_label);
    let view = crate::voice::lookup_for(&app, &account, msg_id.clone()).await?;
    if view.status == "missing" {
        if let Some(page) = app.get_webview(&account_label) {
            let _ = page.eval(ensure_script(&msg_id));
        }
    }
    Ok(view)
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
pub async fn mention_open(window: tauri::Webview, app: AppHandle) -> Result<(), String> {
    request_chat_action(&window, &app, ChatAction::Open).await
}

#[tauri::command]
pub async fn mention_mark_read(window: tauri::Webview, app: AppHandle) -> Result<(), String> {
    request_chat_action(&window, &app, ChatAction::MarkRead).await
}

async fn request_chat_action(
    window: &tauri::Webview,
    app: &AppHandle,
    action: ChatAction,
) -> Result<(), String> {
    if !local_popup(window) {
        return Err("forbidden".into());
    }
    lock::require_unlocked(app)?;
    let label = window.label().to_string();
    let (account, chat, at_ms) = {
        let state = popups(app);
        let inner = lock::guard(&state.inner);
        let card = inner.cards.get(&label).ok_or("closed")?;
        (card.account_label.clone(), card.chat_id.clone(), card.at_ms)
    };
    // Keep newer alerts that arrive while WhatsApp is handling the request.
    let read_through = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64)
        .max(at_ms);
    ensure_view(app, &account)?;
    if matches!(action, ChatAction::Open) {
        reveal_account(app, &account);
    }
    let error = || match action {
        ChatAction::Open => tr("O WhatsApp ainda está abrindo. Tente de novo.").into_owned(),
        ChatAction::MarkRead => {
            tr("Não foi possível marcar a conversa como lida. Tente de novo.").into_owned()
        }
    };
    let view = app.get_webview(&account).ok_or_else(error)?;
    let state = popups(app);
    let request = state
        .next_chat_action
        .fetch_add(1, Ordering::Relaxed)
        .to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    lock::guard(&state.chat_actions).insert(
        request.clone(),
        ChatActionWait {
            account: account.clone(),
            popup: label.clone(),
            tx,
        },
    );
    if view
        .eval(chat_action_script(&chat, &request, action))
        .is_err()
    {
        lock::guard(&state.chat_actions).remove(&request);
        return Err(error());
    }
    let succeeded = matches!(
        tokio::time::timeout(Duration::from_secs(12), rx).await,
        Ok(Ok(true))
    );
    lock::guard(&state.chat_actions).remove(&request);
    if !succeeded {
        return Err(error());
    }
    match action {
        ChatAction::Open => close_popup(app, &label),
        ChatAction::MarkRead => settle(app, &account, &chat, "", read_through),
    }
    Ok(())
}

#[tauri::command]
pub fn mention_chat_action_done(
    window: tauri::Webview,
    app: AppHandle,
    request: String,
    ok: bool,
) -> Result<(), String> {
    crate::integration::remote(&window)?;
    let state = popups(&app);
    let mut requests = lock::guard(&state.chat_actions);
    if requests
        .get(&request)
        .is_some_and(|wait| wait.account == window.label())
    {
        if let Some(wait) = requests.remove(&request) {
            let _ = wait.tx.send(ok);
        }
    }
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

/// The page reports one message revoked (`msg_id` set), or a message this
/// account sent in `chat_id` at `at_ms`. A send closes popups for that chat
/// that are not newer than the send. `at_ms` of 0 drops the whole chat, which
/// is the path with no send time. An empty chat and message drops the account.
#[tauri::command]
pub fn mention_settled(
    window: tauri::Webview,
    app: AppHandle,
    chat_id: String,
    msg_id: String,
    at_ms: u64,
) -> Result<(), String> {
    crate::integration::remote(&window)?;
    let account = window.label().to_string();
    if msg_id.is_empty() && !plausible_id(&chat_id) {
        return Ok(());
    }
    if !msg_id.is_empty() && !plausible_id(&msg_id) {
        return Ok(());
    }
    settle(&app, &account, &chat_id, &msg_id, millis(at_ms));
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
    if app
        .state::<crate::notify::Recent>()
        .privacy_masked(&held.account_label)
    {
        return;
    }
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
            automatic_geometry: None,
            chat_id: held.chat_id,
            msg_id: held.msg_id,
            chat_name: held.chat_name,
            sender_name: held.sender_name,
            body: held.body,
            preview: held.preview,
            voice: held.voice,
            seconds: held.seconds,
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
                    preview: card.preview,
                    voice: card.voice,
                    seconds: card.seconds,
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
    lock::guard(&state.chat_actions).clear();
    let audio = std::mem::take(&mut *lock::guard(&state.audio));
    for (_, tx) in audio {
        let _ = tx.send(Err(tr("Não foi possível reproduzir o áudio.").into_owned()));
    }
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
    settle(app, label, "", "", 0);
}

fn settle(app: &AppHandle, account: &str, chat_id: &str, msg_id: &str, sent_at: u64) {
    let labels = {
        let state = popups(app);
        let mut inner = lock::guard(&state.inner);
        if msg_id.is_empty() && chat_id.is_empty() {
            hold_drop_account(&mut inner.waiting, account);
        } else if msg_id.is_empty() {
            hold_drop_chat(&mut inner.waiting, account, chat_id, sent_at);
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
                        card.chat_id == chat_id && answered_by(card.at_ms, sent_at)
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
            if app
                .state::<crate::notify::Recent>()
                .privacy_masked(&item.account_label)
            {
                continue;
            }
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
        if app
            .state::<crate::notify::Recent>()
            .privacy_masked(&item.account_label)
        {
            continue;
        }
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

fn fail_audio(app: &AppHandle, label: &str) {
    let state = popups(app);
    let tx = lock::guard(&state.audio).remove(label);
    if let Some(tx) = tx {
        let _ = tx.send(Err(tr("Não foi possível reproduzir o áudio.").into_owned()));
    }
}

async fn ask_for_audio(
    app: &AppHandle,
    account: &str,
    msg_id: &str,
    label: &str,
) -> Result<(), String> {
    let Some(view) = app.get_webview(account) else {
        return Err(tr("O WhatsApp ainda está abrindo. Tente de novo.").into_owned());
    };
    view.eval(listen_script(msg_id, label))
        .map_err(|_| tr("Não foi possível reproduzir o áudio.").to_string())
}

/// Windows and macOS use the system title bar, so the popup can be dragged and
/// resized and the page hides its own close button. Linux keeps the borderless card.
fn uses_native_popup_frame(windows: bool, macos: bool) -> bool {
    windows || macos
}

fn present(app: &AppHandle, label: &str) {
    evict_overflow(app);
    let (placements, scale) = popup_layout(app);
    if app.get_webview_window(label).is_some() {
        layout(app, &placements, scale);
        return;
    }
    let Some((_, position)) = placements.iter().find(|(item, _)| item == label) else {
        return;
    };
    let native = uses_native_popup_frame(cfg!(windows), cfg!(target_os = "macos"));
    let built = WebviewWindowBuilder::new(app, label, WebviewUrl::App("mention-popup.html".into()))
        .initialization_script(crate::i18n::init_script())
        .initialization_script(format!("window.__MENTION_NATIVE_FRAME={native};"))
        .additional_browser_args(crate::window::WEBVIEW2_SYNC_ARGS)
        .title("whatRust")
        .position(position.x, position.y)
        .inner_size(POPUP_W, POPUP_H)
        .min_inner_size(POPUP_MIN_W, POPUP_MIN_H)
        .resizable(native)
        .maximizable(false)
        .minimizable(false)
        .decorations(native)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        // Creating the window visible is what makes focused(false) stick: Windows
        // applies it to the initial show, and macOS orders the window front
        // without making it key. A later show() would take keyboard focus.
        .visible(native)
        .build();
    if let Ok(win) = built {
        crate::window::allow_popup_microphone(&win);
        let handle = app.clone();
        let popup_label = label.to_owned();
        win.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                close_popup(&handle, &popup_label);
            }
        });
        let (placements, scale) = popup_layout(app);
        layout(app, &placements, scale);
        #[cfg(any(windows, target_os = "macos"))]
        raise_popup(&win);
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = win.show();
    } else {
        forget(app, label, false);
        crate::dlog::log("mention: popup window failed");
    }
}

/// Keep the popup above other windows without taking keyboard focus.
#[cfg(any(windows, target_os = "macos"))]
fn raise_popup(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };

        if let Ok(hwnd) = win.hwnd() {
            let result = unsafe {
                SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                )
            };
            if let Err(err) = result {
                crate::dlog::log(&format!("mention: could not raise popup: {err}"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        // NSFloatingWindowLevel. orderFrontRegardless shows the window while
        // another app is active and does not make it key, matching SWP_NOACTIVATE.
        const FLOATING: isize = 3;
        let Ok(ns) = win.ns_window() else {
            crate::dlog::log("mention: popup has no window to raise");
            return;
        };
        unsafe {
            let ns = ns as *mut objc2::runtime::AnyObject;
            let _: () = objc2::msg_send![ns, setLevel: FLOATING];
            let no: bool = false;
            let _: () = objc2::msg_send![ns, setHidesOnDeactivate: no];
            let _: () = objc2::msg_send![ns, orderFrontRegardless];
        }
    }
}

type Placement = (String, LogicalPosition<f64>);

fn popup_layout(app: &AppHandle) -> (Vec<Placement>, f64) {
    let (order, anchor) = {
        let state = popups(app);
        let inner = lock::guard(&state.inner);
        let order: Vec<_> = inner
            .order
            .iter()
            .filter_map(|label| Some((label.clone(), inner.cards.get(label)?.automatic_geometry)))
            .collect();
        let anchor = inner.order.front().and_then(|label| {
            inner
                .cards
                .get(label)
                .map(|card| card.account_label.clone())
        });
        (order, anchor)
    };
    if order.is_empty() {
        return (Vec::new(), 1.0);
    }
    #[cfg(any(windows, target_os = "macos"))]
    let foreground = foreground_monitor(app);
    #[cfg(not(any(windows, target_os = "macos")))]
    let foreground: Option<Monitor> = None;
    let monitor = foreground
        .or_else(|| {
            anchor
                .and_then(|label| app.get_webview(&label))
                .and_then(|view| view.window().current_monitor().ok().flatten())
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let (work_x, work_y, work_w, work_h, scale) =
        monitor.map_or((0.0, 0.0, 1280.0, 800.0, 1.0), |monitor| {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            (
                f64::from(area.position.x) / scale,
                f64::from(area.position.y) / scale,
                f64::from(area.size.width) / scale,
                f64::from(area.size.height) / scale,
                scale,
            )
        });
    let mut automatic = Vec::new();
    let mut occupied = Vec::new();
    let mut default_size = None;
    for (label, expected) in order {
        if let Some(win) = app.get_webview_window(&label) {
            if let Some(actual) = PopupGeometry::read(&win) {
                // The last automatic layout is the reference for native moves and resizes.
                if expected.is_some_and(|expected| expected != actual) {
                    let p = actual.position.to_logical::<f64>(scale);
                    let s = actual.size.to_logical::<f64>(scale);
                    occupied.push((p.x, p.y, p.x + s.width, p.y + s.height));
                    continue;
                }
                default_size.get_or_insert_with(|| {
                    actual
                        .size
                        .to_logical::<f64>(win.scale_factor().unwrap_or(scale))
                });
            }
        }
        automatic.push(label);
    }
    let size = default_size.unwrap_or_else(|| LogicalSize::new(POPUP_W, POPUP_H));
    let rows =
        ((work_h - 2.0 * POPUP_MARGIN + POPUP_GAP) / (size.height + POPUP_GAP)).max(1.0) as usize;
    let columns =
        ((work_w - 2.0 * POPUP_MARGIN + POPUP_GAP) / (size.width + POPUP_GAP)).max(1.0) as usize;
    let mut available = (0..columns)
        .flat_map(|col| {
            let width = work_w - col as f64 * (size.width + POPUP_GAP);
            (0..rows).map(move |row| popup_origin(work_x, work_y, width, work_h, row, size))
        })
        .filter(|&(x, y)| {
            occupied.iter().all(|&(left, top, right, bottom)| {
                x + size.width <= left || x >= right || y + size.height <= top || y >= bottom
            })
        });
    let placements = automatic
        .into_iter()
        .enumerate()
        .map(|(index, label)| {
            let default = || popup_origin(work_x, work_y, work_w, work_h, index, size);
            let (x, y) = if occupied.is_empty() {
                default()
            } else {
                available.next().unwrap_or_else(default)
            };
            (label, LogicalPosition::new(x, y))
        })
        .collect();
    (placements, scale)
}

#[cfg(windows)]
fn foreground_monitor(app: &AppHandle) -> Option<Monitor> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect};

    let mut rect = RECT::default();
    unsafe { GetWindowRect(GetForegroundWindow(), &mut rect) }.ok()?;
    let x = (f64::from(rect.left) + f64::from(rect.right)) / 2.0;
    let y = (f64::from(rect.top) + f64::from(rect.bottom)) / 2.0;
    app.monitor_from_point(x, y).ok().flatten()
}

/// The display under the frontmost ordinary window. Floating windows (including
/// these popups) are skipped, so a new popup does not chase itself.
#[cfg(target_os = "macos")]
fn foreground_monitor(app: &AppHandle) -> Option<Monitor> {
    use std::ptr::NonNull;

    use objc2_core_foundation::{CFArray, CFDictionary, CFRetained, CFString, CFType};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *mut CFArray;
    }

    const ON_SCREEN: u32 = 1;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;

    let raw = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN | EXCLUDE_DESKTOP, 0) };
    let list = unsafe { CFRetained::<CFArray<CFType>>::from_raw(NonNull::new(raw.cast())?) };
    let layer_key = CFString::from_str("kCGWindowLayer");
    let alpha_key = CFString::from_str("kCGWindowAlpha");
    let bounds_key = CFString::from_str("kCGWindowBounds");
    for index in 0..list.len() {
        let Some(item) = list.get(index) else {
            continue;
        };
        let Ok(info) = item.downcast::<CFDictionary>() else {
            continue;
        };
        // Window-info keys and values are CFStrings and other CF types.
        let info = unsafe { info.cast_unchecked::<CFString, CFType>() };
        let layer = dict_number(&info, &layer_key).unwrap_or(0.0);
        if layer.abs() > 0.5 {
            continue;
        }
        if dict_number(&info, &alpha_key).is_some_and(|alpha| alpha < 0.01) {
            continue;
        }
        let Some(bounds) = info.get(&*bounds_key) else {
            continue;
        };
        let Ok(bounds) = bounds.downcast::<CFDictionary>() else {
            continue;
        };
        let bounds = unsafe { bounds.cast_unchecked::<CFString, CFType>() };
        let (Some(x), Some(y), Some(width), Some(height)) = (
            dict_number(&bounds, &CFString::from_str("X")),
            dict_number(&bounds, &CFString::from_str("Y")),
            dict_number(&bounds, &CFString::from_str("Width")),
            dict_number(&bounds, &CFString::from_str("Height")),
        ) else {
            continue;
        };
        if width < 20.0 || height < 20.0 {
            continue;
        }
        return app
            .monitor_from_point(x + width / 2.0, y + height / 2.0)
            .ok()
            .flatten();
    }
    None
}

#[cfg(target_os = "macos")]
fn dict_number(
    dict: &objc2_core_foundation::CFDictionary<
        objc2_core_foundation::CFString,
        objc2_core_foundation::CFType,
    >,
    key: &objc2_core_foundation::CFString,
) -> Option<f64> {
    use objc2_core_foundation::CFNumber;
    let value = dict.get(key)?;
    let number = value.downcast_ref::<CFNumber>()?;
    number
        .as_f64()
        .or_else(|| number.as_i64().map(|n| n as f64))
}

fn layout(app: &AppHandle, placements: &[Placement], _scale: f64) {
    let state = popups(app);
    for (label, position) in placements {
        let Some(win) = app.get_webview_window(label) else {
            continue;
        };
        let position = *position;
        #[cfg(windows)]
        let position = position.to_physical::<i32>(_scale);
        if win.set_position(position).is_ok() {
            let geometry = PopupGeometry::read(&win);
            if let Some(card) = lock::guard(&state.inner).cards.get_mut(label) {
                card.automatic_geometry = geometry;
            }
        }
    }
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
    fail_audio(app, label);
    let state = popups(app);
    lock::guard(&state.media).remove(label);
    lock::guard(&state.chat_actions).retain(|_, wait| wait.popup != label);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let (placements, scale) = popup_layout(&handle);
        layout(&handle, &placements, scale);
    });
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
        answered_by, boot_script_from, duplicate_photo, hold_drop_chat, hold_push, message_token,
        popup_origin, prepare_reply, release_of, reply_text, send_script, shown_body, shown_name,
        shown_preview, uses_native_popup_frame, Held, Release, FILE_MAX, POPUP_H, POPUP_W,
    };
    use crate::settings::MentionAccountPrefs;
    use std::collections::{HashMap, VecDeque};
    use std::time::{Duration, Instant};
    use tauri::LogicalSize;

    #[test]
    fn reply_popups_use_a_native_frame_on_windows_and_mac() {
        assert!(uses_native_popup_frame(true, false));
        assert!(uses_native_popup_frame(false, true));
        assert!(!uses_native_popup_frame(false, false));
    }

    #[test]
    fn the_newest_popup_is_the_top_one() {
        let size = LogicalSize::new(POPUP_W, POPUP_H);
        let (x0, y0) = popup_origin(0.0, 0.0, 1440.0, 900.0, 0, size);
        let (_x1, y1) = popup_origin(0.0, 0.0, 1440.0, 900.0, 1, size);
        assert_eq!(x0, 1440.0 - 12.0 - POPUP_W);
        assert!(y0 < y1);
        assert!(y1 - y0 > POPUP_H);
    }

    #[test]
    fn a_short_screen_keeps_the_popup_on_it() {
        let (_, y) = popup_origin(
            0.0,
            20.0,
            800.0,
            400.0,
            5,
            LogicalSize::new(POPUP_W, POPUP_H),
        );
        assert!(y < 20.0 + 400.0 - POPUP_H);
    }

    #[test]
    fn a_thumbnail_is_a_picture_and_a_jid_is_not_a_name() {
        let blob = format!("/9j/{}", "A".repeat(90));
        assert!(shown_body(&blob).is_empty());
        assert_eq!(shown_body("look at this"), "look at this");
        let url = format!("data:image/jpeg;base64,/9j/{}", "A".repeat(80));
        assert_eq!(shown_preview(&url), url);
        assert!(shown_preview("data:text/plain;base64,AAAA").is_empty());
        assert!(shown_name("15551212@c.us").is_empty());
        assert_eq!(shown_name("Ada Lovelace"), "Ada Lovelace");
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
            preview: String::new(),
            voice: false,
            seconds: 0,
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
    fn a_second_copy_of_a_photo_is_not_another_popup() {
        let mut first = sample("wa-default", "false_1@c.us_A", Instant::now());
        first.preview = "data:image/jpeg;base64,SAME".into();
        first.body = "look".into();
        first.sender_name = "Ada".into();
        first.at_ms = 5_000;
        let mut copy = sample("wa-default", "false_1@c.us_B", Instant::now());
        copy.chat_id = first.chat_id.clone();
        copy.preview = first.preview.clone();
        copy.body = first.body.clone();
        copy.sender_name = first.sender_name.clone();
        copy.at_ms = first.at_ms;
        let mut other = sample("wa-default", "false_1@c.us_C", Instant::now());
        other.preview = "data:image/jpeg;base64,OTHER".into();
        other.body = "look".into();
        other.sender_name = "Ada".into();
        other.at_ms = 5_000;
        let mut waiting = VecDeque::new();
        waiting.push_back(first);
        assert!(duplicate_photo(&HashMap::new(), &waiting, &[], &copy));
        assert!(!duplicate_photo(&HashMap::new(), &waiting, &[], &other));
        copy.chat_id = "different@g.us".into();
        assert!(!duplicate_photo(&HashMap::new(), &waiting, &[], &copy));
    }

    #[test]
    fn a_picture_keeps_one_token_when_its_id_grows() {
        let token = "AbCdEfGh12345678";
        assert_eq!(
            message_token(&format!("false_15551212@c.us_{token}")),
            token
        );
        assert_eq!(message_token(&format!("false_777@lid_{token}")), token);
        assert_eq!(
            message_token(&format!("false_15551212@c.us_{token}_15551212@c.us")),
            token
        );
        assert_ne!(message_token("false_15551212@c.us_ZzYyXxWw98765432"), token);
    }

    #[test]
    fn a_reply_closes_alerts_from_that_moment_or_earlier() {
        assert!(answered_by(1_000, 1_000));
        assert!(answered_by(999, 1_000));
        assert!(!answered_by(1_001, 1_000));
        assert!(answered_by(9_000, 0));
        let now = Instant::now();
        let mut older = sample("wa-default", "false_1@g.us_old", now);
        older.at_ms = 1_000;
        let mut same = sample("wa-default", "false_1@g.us_same", now);
        same.at_ms = 2_000;
        let mut newer = sample("wa-default", "false_1@g.us_new", now);
        newer.at_ms = 3_000;
        let mut other = sample("wa-default", "false_2@g.us_other", now);
        other.chat_id = "2@g.us".into();
        other.at_ms = 1_000;
        let mut queue = VecDeque::new();
        queue.push_back(older);
        queue.push_back(same);
        queue.push_back(newer);
        queue.push_back(other);
        hold_drop_chat(&mut queue, "wa-default", "1@g.us", 2_000);
        let left: Vec<_> = queue.iter().map(|held| held.msg_id.as_str()).collect();
        assert_eq!(left, ["false_1@g.us_new", "false_2@g.us_other"]);
        hold_drop_chat(&mut queue, "wa-default", "1@g.us", 0);
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].chat_id, "2@g.us");
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
        assert!(prepare_reply("", "voice", "voice.m4a", "audio/mp4", "bm90YXVkaW8=").is_err());
        let mut samples = Vec::new();
        for i in 0..1600 {
            let tone = ((i as f32) / 16_000.0 * 440.0 * std::f32::consts::TAU).sin();
            samples.push((tone * 8000.0) as i16);
        }
        let wav = crate::voice_ogg::pcm_wav(&samples, 16_000, 1);
        let voice = prepare_reply("", "voice", "voice.m4a", "audio/mp4", &b64(&wav)).unwrap();
        let media = voice.media.unwrap();
        assert_eq!(media.filename, "voice.ogg");
        assert_eq!(media.mime, "audio/ogg");
        assert!(media.voice);
        assert!(media.bytes.starts_with(b"OggS"));
        let again =
            prepare_reply("", "voice", "voice.wav", "audio/wav", &b64(&media.bytes)).unwrap();
        assert_eq!(again.media.unwrap().bytes, media.bytes);
    }

    fn b64(data: &[u8]) -> String {
        const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in data.chunks(3) {
            let b0 = chunk[0];
            let b1 = chunk.get(1).copied().unwrap_or(0);
            let b2 = chunk.get(2).copied().unwrap_or(0);
            let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
            out.push(TABLE[((n >> 18) & 63) as usize] as char);
            out.push(TABLE[((n >> 12) & 63) as usize] as char);
            out.push(if chunk.len() > 1 {
                TABLE[((n >> 6) & 63) as usize] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                TABLE[(n & 63) as usize] as char
            } else {
                '='
            });
        }
        out
    }
}

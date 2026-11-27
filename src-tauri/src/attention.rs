//! Local inbox, scheduled dispatch, and account-scoped WhatsApp adapter.
mod model;

use crate::attention_provider::{Failure, Provider};
use crate::todo::{self, ItemKind, TodoDraft, TodoMessageRef};
use chrono::{LocalResult, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview};

const MINUTE: u64 = 60_000;
const HOUR: u64 = 60 * MINUTE;
const DAY: u64 = 24 * HOUR;
const MINUTES_PER_DAY: u32 = 24 * 60;
const SLOT_FORMAT: &str = "%Y-%m-%d/%H:%M";
const LOOKBACK: u64 = 7 * DAY;
const READY_FOR: u64 = 150_000;
const MAX_REQUESTS_PER_SLOT: usize = 80;
const NANOS_PER_CENT: u64 = 10_000_000;

#[derive(Default)]
pub struct AttentionState {
    gate: Mutex<Runtime>,
}

#[derive(Default)]
struct Runtime {
    online: HashMap<String, u64>,
    epoch: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Schedule {
    start_minute: u32,
    end_minute: u32,
    interval_minutes: u32,
}

impl Schedule {
    fn from_start_hour(start_hour: u32) -> Self {
        let start_minute = start_hour.min(23) * 60;
        Self {
            start_minute,
            end_minute: (start_minute + 18 * 60) % MINUTES_PER_DAY,
            interval_minutes: 60,
        }
    }

    fn valid(self) -> bool {
        self.start_minute < MINUTES_PER_DAY
            && self.end_minute < MINUTES_PER_DAY
            && (5..=MINUTES_PER_DAY).contains(&self.interval_minutes)
    }

    fn elapsed(self, local: &chrono::DateTime<Tz>) -> Option<u32> {
        if !self.valid() {
            return None;
        }
        let elapsed = (local.hour() * 60 + local.minute() + MINUTES_PER_DAY - self.start_minute)
            % MINUTES_PER_DAY;
        let duration = (self.end_minute + MINUTES_PER_DAY - self.start_minute) % MINUTES_PER_DAY;
        // Matching start and end times describe a full day.
        (duration == 0 || elapsed < duration).then_some(elapsed)
    }

    fn slot(self, zone: Tz, at: u64) -> Option<NaiveDateTime> {
        let local = local_time(zone, at)?;
        let offset = self.elapsed(&local)? % self.interval_minutes;
        let wall_minute = local.naive_local().with_second(0)?.with_nanosecond(0)?;
        let start = wall_minute.checked_sub_signed(chrono::Duration::minutes(offset.into()))?;
        // On a spring transition a scheduled minute may not exist. Keep the
        // rest of the day's cadence aligned to the configured start time.
        (!matches!(zone.from_local_datetime(&start), LocalResult::None)).then_some(start)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Prefs {
    enabled: bool,
    provider: Provider,
    start_hour: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    schedule: Option<Schedule>,
    time_zone: String,
    use_saved_gemini: bool,
    excluded_chats: BTreeSet<String>,
    group_chats: BTreeSet<String>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: Provider::Openai,
            start_hour: 7,
            schedule: None,
            time_zone: "UTC".into(),
            use_saved_gemini: false,
            excluded_chats: BTreeSet::new(),
            group_chats: BTreeSet::new(),
        }
    }
}

impl Prefs {
    fn schedule(&self) -> Schedule {
        self.schedule
            .unwrap_or_else(|| Schedule::from_start_hour(self.start_hour))
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Account {
    prefs: Prefs,
    since: u64,
    through: u64,
    discovered_through: u64,
    has_gap: bool,
    gap_since: Option<u64>,
    last_checked: u64,
    checked_slot: String,
    partial: bool,
    backfill_from: Option<u64>,
    generation: u64,
    pause: String,
    retry_at: u64,
}

impl Account {
    fn note_gap(&mut self, since: u64) {
        self.gap_since = Some(if self.has_gap {
            self.gap_since.unwrap_or(self.since).min(since)
        } else {
            since
        });
        self.has_gap = true;
    }

    fn record_backfill(&mut self) {
        if self
            .backfill_from
            .is_some_and(|from| from <= self.gap_since.unwrap_or(self.since))
        {
            self.has_gap = false;
            self.gap_since = None;
        }
        self.backfill_from = None;
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Chat {
    revision: u64,
    checked: u64,
    pending_since: u64,
    edit_revision: u64,
    messages: Vec<Message>,
    items: Vec<Item>,
    muted: BTreeSet<Kind>,
    seen: BTreeMap<String, (u64, String)>,
    edits: BTreeMap<String, (u64, u64)>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Message {
    message: TodoMessageRef,
    at_ms: u64,
    from_me: bool,
    quoted_id: Option<String>,
    speaker: Option<String>,
    kind: String,
    deleted: bool,
    unavailable: bool,
    due_at: Option<u64>,
    expires_at: Option<u64>,
    edited_at: Option<u64>,
    incoming_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Reply,
    Action,
    Waiting,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Open,
    Review,
    Done,
    Dismissed,
    Moved,
}

#[derive(Clone, Serialize, Deserialize)]
struct Item {
    id: String,
    anchor: String,
    message: TodoMessageRef,
    title: String,
    kind: Kind,
    state: Status,
    due_at: Option<u64>,
    snooze_until: Option<u64>,
    eligible_at: u64,
    vote: Option<String>,
    manual: bool,
    review_close: bool,
    #[serde(default)]
    resolution_message: Option<TodoMessageRef>,
    #[serde(default)]
    user_due: bool,
    moved_id: Option<String>,
    #[serde(default)]
    acknowledged_at: u64,
    #[serde(default)]
    correction: Option<String>,
    transfer: Option<Transfer>,
    undo: Option<Undo>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Transfer {
    operation: String,
    kind: ItemKind,
    title: String,
    due_at: Option<u64>,
    remind_at: Option<u64>,
    existing_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Undo {
    state: Status,
    snooze_until: Option<u64>,
    due_at: Option<u64>,
    vote: Option<String>,
    review_close: bool,
    correction: Option<String>,
    acknowledged_at: u64,
    #[serde(default)]
    unmute: bool,
    #[serde(default)]
    user_due: bool,
}

#[derive(Deserialize)]
pub struct Coverage {
    through: u64,
    partial: bool,
    since: Option<u64>,
    #[serde(default)]
    offline: bool,
    #[serde(default)]
    finished: bool,
}

fn now() -> u64 {
    Utc::now().timestamp_millis().max(0) as u64
}

fn fail(_: impl std::fmt::Display) -> String {
    "attention_store".into()
}

fn db(app: &AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(fail)?;
    std::fs::create_dir_all(&dir).map_err(fail)?;
    let c = Connection::open(dir.join("needs-attention.sqlite")).map_err(fail)?;
    initialize(&c)?;
    Ok(c)
}

fn initialize(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "PRAGMA secure_delete=ON;
         CREATE TABLE IF NOT EXISTS attention_account (id TEXT PRIMARY KEY, data TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS attention_chat (
           account TEXT, id TEXT, pending_since INTEGER, data TEXT NOT NULL, PRIMARY KEY(account,id));
         CREATE INDEX IF NOT EXISTS attention_pending ON attention_chat(account,pending_since);
         CREATE TABLE IF NOT EXISTS attention_usage (
           id INTEGER PRIMARY KEY, month TEXT, account TEXT, provider TEXT,
           cost INTEGER, tokens INTEGER, estimated INTEGER);
         CREATE INDEX IF NOT EXISTS attention_usage_month ON attention_usage(month);
         CREATE TABLE IF NOT EXISTS attention_budget (id INTEGER PRIMARY KEY CHECK(id=1), cents INTEGER);",
    )
    .map_err(fail)
}

fn transaction<T>(
    app: &AppHandle,
    edit: impl FnOnce(&Transaction<'_>, &mut Runtime) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<AttentionState>();
    let mut runtime = crate::lock::guard(&state.gate);
    let mut db = db(app)?;
    let tx = db.transaction().map_err(fail)?;
    let value = edit(&tx, &mut runtime)?;
    tx.commit().map_err(fail)?;
    Ok(value)
}

fn decode<T: DeserializeOwned>(raw: String) -> Result<T, String> {
    serde_json::from_str(&raw).map_err(fail)
}

fn encode(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(fail)
}

fn account(tx: &Connection, id: &str) -> Result<Account, String> {
    let raw = tx
        .query_row(
            "SELECT data FROM attention_account WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(fail)?;
    raw.map(decode).transpose().map(Option::unwrap_or_default)
}

fn save_account(tx: &Connection, id: &str, account: &Account) -> Result<(), String> {
    tx.execute(
        "INSERT OR REPLACE INTO attention_account VALUES(?1,?2)",
        params![id, encode(account)?],
    )
    .map_err(fail)?;
    Ok(())
}

fn chat(tx: &Connection, account: &str, chat: &str) -> Result<Chat, String> {
    let raw = tx
        .query_row(
            "SELECT data FROM attention_chat WHERE account=?1 AND id=?2",
            params![account, chat],
            |r| r.get(0),
        )
        .optional()
        .map_err(fail)?;
    raw.map(decode).transpose().map(Option::unwrap_or_default)
}

fn save_chat(tx: &Connection, account: &str, id: &str, chat: &Chat) -> Result<(), String> {
    tx.execute(
        "INSERT OR REPLACE INTO attention_chat VALUES(?1,?2,?3,?4)",
        params![account, id, chat.pending_since, encode(chat)?],
    )
    .map_err(fail)?;
    Ok(())
}

fn chats(tx: &Connection, account: &str) -> Result<Vec<(String, Chat)>, String> {
    let mut q = tx
        .prepare("SELECT id,data FROM attention_chat WHERE account=?1")
        .map_err(fail)?;
    let rows = q
        .query_map([account], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(fail)?;
    rows.map(|row| {
        let (id, raw) = row.map_err(fail)?;
        Ok((id, decode(raw)?))
    })
    .collect()
}

fn remote(window: &Webview, app: &AppHandle) -> Result<String, String> {
    crate::integration::remote(window)?;
    crate::lock::require_unlocked(app)?;
    crate::accounts::id_from_label(window.label())
        .filter(|id| todo::valid_account_id(id))
        .map(str::to_owned)
        .ok_or_else(|| "forbidden".into())
}

fn local(window: &Webview, app: &AppHandle) -> Result<(), String> {
    if window.label() != "settings" || !crate::integration::trusted_local(window) {
        return Err("forbidden".into());
    }
    crate::lock::require_unlocked(app)
}

fn valid_chat(id: &str) -> bool {
    id.len() <= 150
        && id.split_once('@').is_some_and(|(user, server)| {
            !user.is_empty()
                && user
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b == b'-' || b == b':')
                && matches!(server, "c.us" | "s.whatsapp.net" | "lid" | "g.us")
        })
}

fn allowed(prefs: &Prefs, id: &str) -> bool {
    valid_chat(id)
        && !prefs.excluded_chats.contains(id)
        && (!id.ends_with("@g.us") || prefs.group_chats.contains(id))
}

fn session_ready(runtime: &Runtime, id: &str, at: u64) -> bool {
    runtime
        .online
        .get(id)
        .is_some_and(|last| at.saturating_sub(*last) < READY_FOR)
}

fn local_time(zone: Tz, at: u64) -> Option<chrono::DateTime<Tz>> {
    Some(chrono::DateTime::from_timestamp_millis(at as i64)?.with_timezone(&zone))
}

fn slot(prefs: &Prefs, at: u64) -> Option<NaiveDateTime> {
    prefs.schedule().slot(prefs.time_zone.parse().ok()?, at)
}

fn last_slot(saved: &str) -> Option<NaiveDateTime> {
    if saved.is_empty() {
        return None;
    }
    if saved.len() == "2026-01-01/00".len() {
        // Older builds recorded the hour without a minute.
        return NaiveDateTime::parse_from_str(&format!("{saved}:00"), SLOT_FORMAT).ok();
    }
    NaiveDateTime::parse_from_str(saved, SLOT_FORMAT).ok()
}

fn active_window(prefs: &Prefs, at: u64) -> bool {
    let local = prefs
        .time_zone
        .parse()
        .ok()
        .and_then(|zone| local_time(zone, at));
    local.is_some_and(|local| prefs.schedule().elapsed(&local).is_some())
}

fn month(at: u64) -> String {
    chrono::DateTime::from_timestamp_millis(at as i64)
        .unwrap_or_default()
        .format("%Y-%m")
        .to_string()
}

fn key(app: &AppHandle, prefs: &Prefs) -> Option<String> {
    crate::keys::get_key(app, prefs.provider.key_id())
        .ok()
        .flatten()
        .or_else(|| {
            if prefs.provider == Provider::Gemini && prefs.use_saved_gemini {
                crate::keys::get_key(app, "gemini").ok().flatten()
            } else {
                None
            }
        })
}

fn clean(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(max)
        .collect()
}

fn tidy(mut msg: TodoMessageRef) -> Option<TodoMessageRef> {
    if !msg.chat_id.as_deref().is_some_and(valid_chat)
        || msg.msg_id.len() > 300
        || todo::message_token(&msg.msg_id).is_empty()
    {
        return None;
    }
    msg.msg_token = todo::message_token(&msg.msg_id);
    msg.snippet = clean(&msg.snippet, 2400);
    msg.chat_name = clean(&msg.chat_name, 120);
    msg.sender = clean(&msg.sender, 120);
    msg.kind = clean(&msg.kind, 24);
    msg.msg_timestamp = None;
    Some(msg)
}

fn item_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(fail)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn on_lock(app: &AppHandle) {
    let state = app.state::<AttentionState>();
    let mut runtime = crate::lock::guard(&state.gate);
    runtime.online.clear();
    runtime.epoch = runtime.epoch.wrapping_add(1);
}

pub fn delete_account(app: &AppHandle, id: &str) {
    let _ = transaction(app, |tx, runtime| {
        runtime.online.remove(id);
        tx.execute("DELETE FROM attention_chat WHERE account=?1", [id])
            .map_err(fail)?;
        tx.execute("DELETE FROM attention_account WHERE id=?1", [id])
            .map_err(fail)?;
        // Keep installation spending for the budget, without the account identifier.
        tx.execute(
            "UPDATE attention_usage SET account='' WHERE account=?1",
            [id],
        )
        .map_err(fail)?;
        Ok(())
    });
}

fn prune(chat: &mut Chat, at: u64) -> bool {
    let mut changed = false;
    for msg in &mut chat.messages {
        if !msg.deleted && msg.expires_at.is_some_and(|expiry| expiry <= at) {
            msg.deleted = true;
            msg.message.snippet.clear();
            chat.revision += 1;
            msg.incoming_revision = chat.revision;
            chat.pending_since = at;
            changed = true;
        }
        if msg.deleted {
            for item in &mut chat.items {
                if item.message.msg_id == msg.message.msg_id && !item.message.snippet.is_empty() {
                    item.message.snippet.clear();
                    item.title.clear();
                    item.review_close = false;
                    if !item.manual && item.state == Status::Open {
                        item.state = Status::Review;
                    }
                    changed = true;
                }
                if item
                    .resolution_message
                    .as_ref()
                    .is_some_and(|m| m.msg_id == msg.message.msg_id)
                {
                    item.resolution_message = None;
                    item.review_close = false;
                    changed = true;
                }
            }
        }
    }
    // Keep a small overlapping context and compact tombstones for work the
    // user acted on. Pending revisions are never evicted as ordinary context.
    let old = chat.messages.len();
    let mut context = 0;
    chat.messages.sort_by_key(|m| std::cmp::Reverse(m.at_ms));
    chat.messages.retain(|m| {
        if m.incoming_revision > chat.checked {
            return true;
        }
        context += 1;
        context <= 24 && at.saturating_sub(m.at_ms) <= LOOKBACK
    });
    changed || old != chat.messages.len()
}

fn usage(tx: &Connection, id: Option<&str>, at: u64) -> Result<Vec<serde_json::Value>, String> {
    let mut q = tx
        .prepare(
            "SELECT account,provider,SUM(cost),SUM(tokens),COUNT(*),SUM(estimated)
         FROM attention_usage WHERE month=?1 AND (?2 IS NULL OR account=?2)
         GROUP BY account,provider",
        )
        .map_err(fail)?;
    let rows = q
        .query_map(params![month(at), id], |r| {
            Ok(serde_json::json!({
                "account": r.get::<_, String>(0)?,
                "provider": r.get::<_, String>(1)?,
                "estimated_usd": r.get::<_, u64>(2)? as f64 / 1e9,
                "tokens": r.get::<_, u64>(3)?,
                "calls": r.get::<_, u64>(4)?,
                "estimated_calls": r.get::<_, u64>(5)?,
            }))
        })
        .map_err(fail)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(fail)
}

fn budget(tx: &Connection) -> Result<u64, String> {
    Ok(tx
        .query_row("SELECT cents FROM attention_budget WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(fail)?
        .unwrap_or(500))
}

fn reserve(
    tx: &Connection,
    account_id: &str,
    provider: Provider,
    at: u64,
    tokens: u64,
) -> Result<Option<i64>, String> {
    let month = month(at);
    let spent: u64 = tx
        .query_row(
            "SELECT COALESCE(SUM(cost),0) FROM attention_usage WHERE month=?1",
            [&month],
            |r| r.get(0),
        )
        .map_err(fail)?;
    let cost = tokens.saturating_mul(provider.rate_nanos_per_token());
    if cost
        > budget(tx)?
            .saturating_mul(NANOS_PER_CENT)
            .saturating_sub(spent)
    {
        return Ok(None);
    }
    tx.execute(
        "INSERT INTO attention_usage(month,account,provider,cost,tokens,estimated)
        VALUES(?1,?2,?3,?4,?5,1)",
        params![month, account_id, provider.model(), cost, tokens],
    )
    .map_err(fail)?;
    Ok(Some(tx.last_insert_rowid()))
}

fn next_check(account: &Account, at: u64) -> Option<u64> {
    if !account.prefs.enabled {
        return None;
    }
    let zone = account.prefs.time_zone.parse().ok()?;
    let schedule = account.prefs.schedule();
    let checked = last_slot(&account.checked_slot);
    let next_minute = at.div_ceil(MINUTE) * MINUTE;
    (0..=26 * 60)
        .map(|i| next_minute + i * MINUTE)
        .find(|when| {
            schedule
                .slot(zone, *when)
                .is_some_and(|s| checked.is_none_or(|previous| s > previous))
        })
}

fn rule_id(id: &str, kind: Kind) -> String {
    format!(
        "{id}/{}",
        match kind {
            Kind::Reply => "reply",
            Kind::Action => "action",
            Kind::Waiting => "waiting",
        }
    )
}

fn snapshot(
    app: &AppHandle,
    id: &str,
    undo_note: Option<&str>,
) -> Result<serde_json::Value, String> {
    transaction(app, |tx, runtime| {
        let at = now();
        let a = account(tx, id)?;
        let awake = active_window(&a.prefs, at);
        let ready = session_ready(runtime, id, at);
        let mut items = Vec::new();
        let mut rules = Vec::new();
        let mut pending = 0;
        for (id_chat, mut c) in chats(tx, id)? {
            if prune(&mut c, at) {
                save_chat(tx, id, &id_chat, &c)?;
            }
            let included = allowed(&a.prefs, &id_chat);
            pending += usize::from(included && c.pending_since > 0);
            for &kind in &c.muted {
                let name = c.items.first().map(|i| &i.message.chat_name);
                rules.push(serde_json::json!({"id": rule_id(&id_chat, kind), "chat_name": name, "kind": kind}));
            }
            for item in &c.items {
                if !included && !item.manual {
                    continue;
                }
                let muted = !item.manual && c.muted.contains(&item.kind);
                let actionable = item.state == Status::Open
                    && !muted
                    && !item.review_close
                    && !item.snooze_until.is_some_and(|until| at < until)
                    && (item.manual
                        || awake
                            && at >= item.eligible_at
                            && !(item.kind == Kind::Reply
                                && c.messages.iter().any(|m| {
                                    m.from_me
                                        && !m.deleted
                                        && m.incoming_revision > c.checked
                                        && m.at_ms >= item.message.msg_epoch.unwrap_or(0)
                                })
                                && item.due_at.is_none_or(|due| due > at + HOUR)))
                    && (item.kind != Kind::Waiting || item.due_at.is_some_and(|when| at >= when));
                let similar = c.items.iter().filter(|other| other.kind == item.kind);
                let positives = similar
                    .clone()
                    .filter(|other| other.vote.as_deref() == Some("useful"))
                    .count();
                let negatives = similar
                    .filter(|other| other.vote.as_deref() == Some("not_useful"))
                    .count();
                items.push(serde_json::json!({
                    "id": item.id, "message": item.message, "title": item.title, "kind": item.kind,
                    "state": item.state, "due_at": item.due_at, "snooze_until": item.snooze_until,
                    "eligible_at": item.eligible_at, "vote": item.vote, "manual": item.manual,
                    "review_close": item.review_close, "muted": muted, "actionable": actionable,
                    "moved_id": item.moved_id, "mute_suggested": negatives >= 3 && !muted,
                    "moved_kind": item.transfer.as_ref().map(|t| t.kind),
                    "resolution_message": item.resolution_message,
                    "unavailable": item.message.snippet.is_empty(),
                    "rank": positives.saturating_sub(negatives).min(10), "can_undo": item.undo.is_some(),
                }));
            }
        }
        let pause = if !a.prefs.enabled {
            ""
        } else if key(app, &a.prefs).is_none() {
            "credentials"
        } else if !ready {
            "offline"
        } else {
            a.pause.as_str()
        };
        Ok(serde_json::json!({
            "enabled": a.prefs.enabled, "awake": awake, "provider": a.prefs.provider,
            "since": a.since, "last_checked": a.last_checked, "pending":pending,
            "coverage": if !ready || a.partial || a.has_gap || a.through == 0 { "partial" } else { "complete" },
            "coverage_through": a.through.min(a.last_checked),
            "oldest_available": at.saturating_sub(LOOKBACK),
            "pause": pause, "catch_up_from": a.discovered_through.max(a.since),
            "backfill_from": a.backfill_from, "next_check": next_check(&a, at),
            "key_configured": key(app, &a.prefs).is_some(), "time_zone": a.prefs.time_zone,
            "excluded_chats": a.prefs.excluded_chats, "group_chats": a.prefs.group_chats,
            "items":items, "rules":rules, "undo_note":undo_note,
        }))
    })
}

fn push(app: &AppHandle, id: &str) {
    if !crate::lock::is_unlocked(app) {
        return;
    }
    if let Some(view) = app.get_webview(&crate::accounts::window_label(id)) {
        if crate::integration::remote(&view).is_ok() {
            // Fetch through the account-scoped command rather than injecting
            // message excerpts into a webview that can navigate after this check.
            let _ = view.eval("window.__whatrustAttentionRefresh?.()");
        }
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn attention_list(window: Webview, app: AppHandle) -> Result<serde_json::Value, String> {
    let id = remote(&window, &app)?;
    recover_moves(&app, &id)?;
    snapshot(&app, &id, None)
}

fn merge_message(c: &mut Chat, mut incoming: Message, at: u64) {
    c.seen
        .retain(|_, (last, _)| at.saturating_sub(*last) <= LOOKBACK);
    c.edits
        .retain(|_, (last, _)| at.saturating_sub(*last) <= LOOKBACK);
    let source_id = &incoming.message.msg_id;
    let version = if incoming.deleted {
        u64::MAX
    } else {
        incoming.edited_at.unwrap_or(0)
    };
    if c.edits
        .get(source_id)
        .is_some_and(|(_, previous)| *previous > version)
    {
        return;
    }
    if version != 0 {
        c.edits.insert(source_id.clone(), (at, version));
    }
    let fingerprint = model::fingerprint(&incoming);
    if c.seen
        .get(&incoming.message.msg_id)
        .is_some_and(|(_, old)| old == &fingerprint)
    {
        return;
    }
    let existing = c
        .messages
        .iter_mut()
        .find(|m| m.message.msg_id == incoming.message.msg_id);
    c.seen
        .insert(incoming.message.msg_id.clone(), (at, fingerprint));
    if let Some(existing) = existing {
        if existing.deleted {
            return;
        }
        if !incoming.deleted
            && existing.message.snippet == incoming.message.snippet
            && existing.unavailable == incoming.unavailable
            && existing.due_at == incoming.due_at
        {
            return;
        }
        if !incoming.deleted
            && incoming.edited_at.is_some()
            && incoming.message.snippet != existing.message.snippet
        {
            for item in &mut c.items {
                if !item.manual && item.message.msg_id == incoming.message.msg_id {
                    item.message.snippet = incoming.message.snippet.clone();
                    if item.state == Status::Open {
                        item.state = Status::Review;
                        item.review_close = false;
                        item.resolution_message = None;
                    }
                }
            }
        }
        c.revision += 1;
        incoming.incoming_revision = c.revision;
        *existing = incoming;
    } else {
        c.revision += 1;
        incoming.incoming_revision = c.revision;
        c.messages.push(incoming);
    }
    if c.pending_since == 0 {
        c.pending_since = at;
    }
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) fn attention_ingest(
    window: Webview,
    app: AppHandle,
    messages: Vec<Message>,
    coverage: Option<Coverage>,
) -> Result<(), String> {
    let id = remote(&window, &app)?;
    if messages.len() > 40 {
        return Err("invalid_batch".into());
    }
    transaction(&app, |tx, runtime| {
        let at = now();
        let mut a = account(tx, &id)?;
        if !a.prefs.enabled {
            return Ok(());
        }
        if let Some(coverage) = coverage {
            if coverage.offline {
                runtime.online.remove(&id);
            } else {
                runtime.online.insert(id.clone(), at);
            }
            a.partial = coverage.partial || coverage.offline;
            let required = a.backfill_from.unwrap_or(a.discovered_through.max(a.since));
            if !a.partial
                && required >= at.saturating_sub(LOOKBACK)
                && coverage.since.is_some_and(|from| from <= required)
            {
                a.through = a.through.max(coverage.through.min(at));
                a.discovered_through = a.discovered_through.max(a.through);
                a.record_backfill();
            } else if coverage.finished && !coverage.offline {
                a.discovered_through = a.discovered_through.max(coverage.through.min(at));
                a.note_gap(required);
                a.backfill_from = None;
            } else if !a.partial {
                a.partial = true;
            }
            save_account(tx, &id, &a)?;
        }
        let earliest = a
            .backfill_from
            .unwrap_or(a.since)
            .max(at.saturating_sub(LOOKBACK));
        let mut grouped = BTreeMap::<String, Vec<Message>>::new();
        for mut m in messages {
            let Some(mut source) = tidy(m.message) else {
                continue;
            };
            let Some(chat_id) = source.chat_id.clone() else {
                continue;
            };
            if !allowed(&a.prefs, &chat_id)
                || (!m.deleted && (m.at_ms < earliest || m.at_ms > at + HOUR))
            {
                continue;
            }
            source.msg_epoch = Some(m.at_ms);
            if m.deleted || m.expires_at.is_some_and(|expiry| at >= expiry) {
                source.snippet.clear();
                m.deleted = true;
            }
            m.message = source;
            if m.unavailable && !m.deleted && m.message.snippet.is_empty() {
                attach_transcript(&app, &id, &mut m);
            }
            m.speaker = m.speaker.map(|s| clean(&s, 120));
            m.kind = clean(&m.kind, 24);
            m.quoted_id = m.quoted_id.filter(|q| q.len() <= 300);
            grouped.entry(chat_id).or_default().push(m);
        }
        for (chat_id, messages) in grouped {
            let mut c = chat(tx, &id, &chat_id)?;
            let revision = c.revision;
            for m in messages {
                // Historical overlap within a window supports a pending turn.
                // Old replayed events outside that window never create work.
                if c.messages.len() >= 512
                    && !c
                        .messages
                        .iter()
                        .any(|old| old.message.msg_id == m.message.msg_id)
                {
                    a.partial = true;
                    a.note_gap(m.at_ms);
                    continue;
                }
                merge_message(&mut c, m, at);
            }
            if prune(&mut c, at) || revision != c.revision {
                save_chat(tx, &id, &chat_id, &c)?;
            }
        }
        if a.partial {
            save_account(tx, &id, &a)?;
        }
        Ok(())
    })
}

fn attach_transcript(app: &AppHandle, account_id: &str, msg: &mut Message) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    if let Ok(Some(note)) =
        crate::transcript_store::read(&dir.join("transcripts"), account_id, &msg.message.msg_id)
    {
        if note.state == "ready"
            && !note.text.is_empty()
            && (note.chat.is_empty() || Some(note.chat.as_str()) == msg.message.chat_id.as_deref())
        {
            msg.message.snippet = clean(&note.text, 2400);
            msg.unavailable = false;
        }
    }
}

pub fn transcript_ready(app: &AppHandle, account_id: &str, source_id: &str, chat_id: &str) {
    let changed = transaction(app, |tx, _| {
        let a = account(tx, account_id)?;
        if !a.prefs.enabled || !allowed(&a.prefs, chat_id) {
            return Ok(false);
        }
        let mut c = chat(tx, account_id, chat_id)?;
        let Some(mut m) = c
            .messages
            .iter()
            .find(|m| m.message.msg_id == source_id && m.unavailable && !m.deleted)
            .cloned()
        else {
            return Ok(false);
        };
        attach_transcript(app, account_id, &mut m);
        if m.unavailable {
            return Ok(false);
        }
        merge_message(&mut c, m, now());
        save_chat(tx, account_id, chat_id, &c)?;
        Ok(true)
    });
    if changed == Ok(true) {
        push(app, account_id);
    }
}

fn remember(item: &mut Item) {
    item.undo = Some(Undo {
        state: item.state,
        snooze_until: item.snooze_until,
        due_at: item.due_at,
        vote: item.vote.clone(),
        review_close: item.review_close,
        correction: item.correction.clone(),
        acknowledged_at: item.acknowledged_at,
        unmute: false,
        user_due: item.user_due,
    });
}

fn restore(item: &mut Item) {
    if let Some(undo) = item.undo.take() {
        item.state = undo.state;
        item.vote = undo.vote;
        item.snooze_until = undo.snooze_until;
        item.due_at = undo.due_at;
        item.review_close = undo.review_close;
        item.correction = undo.correction;
        item.acknowledged_at = undo.acknowledged_at;
        item.user_due = undo.user_due;
    }
}

fn find_item(tx: &Connection, account: &str, id: &str) -> Result<(String, Chat, usize), String> {
    for (chat_id, c) in chats(tx, account)? {
        if let Some(index) = c.items.iter().position(|i| i.id == id) {
            return Ok((chat_id, c, index));
        }
    }
    Err("item_unavailable".into())
}

fn reset_feedback(c: &mut Chat) {
    c.muted.clear();
    for item in &mut c.items {
        if item.state == Status::Dismissed && item.vote.as_deref() == Some("not_useful") {
            item.state = Status::Open;
        }
        item.vote = None;
        item.correction = None;
        if let Some(undo) = &mut item.undo {
            undo.vote = None;
            undo.correction = None;
        }
    }
}

fn new_item(
    m: TodoMessageRef,
    anchor: String,
    kind: Kind,
    title: String,
    at: u64,
) -> Result<Item, String> {
    Ok(Item {
        id: item_id()?,
        anchor,
        message: m,
        title,
        kind,
        state: Status::Open,
        due_at: None,
        snooze_until: None,
        eligible_at: at,
        vote: None,
        manual: false,
        review_close: false,
        resolution_message: None,
        user_due: false,
        moved_id: None,
        acknowledged_at: 0,
        correction: None,
        transfer: None,
        undo: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn attention_action(
    window: Webview,
    app: AppHandle,
    id: String,
    action: String,
    until: Option<u64>,
    message: Option<TodoMessageRef>,
    chat_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let account_id = remote(&window, &app)?;
    let note = transaction(&app, |tx, _| {
        let at = now();
        match action.as_str() {
            "reset" => {
                for (key, mut c) in chats(tx, &account_id)? {
                    reset_feedback(&mut c);
                    c.edit_revision += 1;
                    save_chat(tx, &account_id, &key, &c)?;
                }
                return Ok(None);
            }
            "exclude_chat" | "include_chat" | "enable_group" | "disable_group" => {
                let key = chat_id
                    .as_deref()
                    .filter(|key| valid_chat(key))
                    .ok_or("invalid_chat")?;
                let mut a = account(tx, &account_id)?;
                match action.as_str() {
                    "exclude_chat" => {
                        a.prefs.excluded_chats.insert(key.into());
                    }
                    "include_chat" => {
                        a.prefs.excluded_chats.remove(key);
                    }
                    "enable_group" if key.ends_with("@g.us") => {
                        a.prefs.group_chats.insert(key.into());
                    }
                    "disable_group" => {
                        a.prefs.group_chats.remove(key);
                    }
                    _ => return Err("invalid_chat".into()),
                }
                if !allowed(&a.prefs, key) {
                    let mut c = chat(tx, &account_id, key)?;
                    c.messages.clear();
                    c.checked = c.revision;
                    c.pending_since = 0;
                    for item in &mut c.items {
                        if !item.manual {
                            item.message.snippet.clear();
                            item.title.clear();
                        }
                    }
                    save_chat(tx, &account_id, key, &c)?;
                }
                a.generation += 1;
                save_account(tx, &account_id, &a)?;
                return Ok(None);
            }
            "unmute" => {
                let (key, kind) = id.rsplit_once('/').ok_or("invalid_rule")?;
                let kind = decode::<Kind>(format!("\"{kind}\""))?;
                let mut c = chat(tx, &account_id, key)?;
                c.muted.remove(&kind);
                c.edit_revision += 1;
                save_chat(tx, &account_id, key, &c)?;
                return Ok(None);
            }
            "manual" => {
                let source = message.and_then(tidy).ok_or("invalid_message")?;
                let key = source.chat_id.clone().ok_or("invalid_chat")?;
                let mut c = chat(tx, &account_id, &key)?;
                if let Some(item) = c.items.iter_mut().find(|i| {
                    i.message.msg_id == source.msg_id
                        && !matches!(i.state, Status::Moved | Status::Done)
                }) {
                    remember(item);
                    item.state = Status::Open;
                    item.manual = true;
                    item.snooze_until = None;
                    item.vote = Some("useful".into());
                    item.correction = Some("missed".into());
                } else {
                    let title = clean(&source.snippet, 180);
                    let mut item = new_item(source, String::new(), Kind::Action, title, at)?;
                    item.manual = true;
                    item.vote = Some("useful".into());
                    item.correction = Some("missed".into());
                    c.items.push(item);
                }
                c.edit_revision += 1;
                save_chat(tx, &account_id, &key, &c)?;
                return Ok(None);
            }
            _ => {}
        }
        let (key, mut c, index) = find_item(tx, &account_id, &id)?;
        let item = &mut c.items[index];
        let mut note = None;
        if item.state == Status::Moved && action != "undo" {
            return Err("item_moved".into());
        }
        if item.transfer.is_some() && item.state != Status::Moved {
            return Err("move_pending".into());
        }
        if (action == "useful" && item.vote.as_deref() == Some("useful"))
            || (action == "not_useful"
                && item.state == Status::Dismissed
                && item.vote.as_deref() == Some("not_useful"))
            || (action == "mute" && c.muted.contains(&item.kind))
        {
            return Ok(None);
        }
        if action != "undo" {
            remember(item);
        }
        match action.as_str() {
            "done" | "already_handled" => {
                item.state = Status::Done;
                item.review_close = false;
                if action == "already_handled" {
                    item.correction = Some("already_handled".into());
                }
            }
            "keep_open" | "reopen" => {
                item.state = Status::Open;
                item.acknowledged_at = c.revision;
                item.review_close = false;
            }
            "dismiss" | "not_useful" => {
                item.state = Status::Dismissed;
                if action == "not_useful" {
                    item.vote = Some("not_useful".into());
                }
            }
            "useful" => {
                item.vote = Some("useful".into());
            }
            "snooze" | "too_soon" | "follow_at" => {
                let until = until
                    .filter(|time| *time > at && *time <= at + 366 * DAY)
                    .ok_or("invalid_time")?;
                if action == "follow_at" {
                    item.due_at = Some(until);
                    item.user_due = true;
                } else {
                    item.snooze_until = Some(until);
                }
                if action == "too_soon" {
                    item.correction = Some(format!("delay:{}", until - at));
                }
            }
            "mute" => {
                let inserted = c.muted.insert(item.kind);
                if let Some(undo) = &mut item.undo {
                    undo.unmute = inserted;
                }
            }
            "undo" => {
                if item.undo.as_ref().is_some_and(|undo| undo.unmute) {
                    c.muted.remove(&item.kind);
                }
                if item.state == Status::Moved {
                    if let Some(transfer) = item.transfer.as_ref() {
                        let result =
                            todo::attention_transfer_undo(&app, &account_id, &transfer.operation)?;
                        if matches!(result, todo::AttentionUndo::Kept) {
                            note = Some("destination_kept");
                        }
                    }
                    item.moved_id = None;
                    item.transfer = None;
                }
                restore(item);
            }
            _ => return Err("invalid_action".into()),
        }
        c.edit_revision += 1;
        save_chat(tx, &account_id, &key, &c)?;
        Ok(note)
    })?;
    snapshot(&app, &account_id, note)
}

#[tauri::command(rename_all = "snake_case")]
pub fn attention_matches(
    window: Webview,
    app: AppHandle,
    id: String,
    kind: ItemKind,
) -> Result<Vec<todo::AttentionDestination>, String> {
    let account_id = remote(&window, &app)?;
    let source = transaction(&app, |tx, _| {
        let (_, c, index) = find_item(tx, &account_id, &id)?;
        Ok(c.items[index].message.clone())
    })?;
    todo::attention_destinations(&app, &account_id, &source, kind)
}

fn finish_move(item: &mut Item, destination: String) {
    remember(item);
    item.moved_id = Some(destination);
    item.state = Status::Moved;
    item.vote = Some("useful".into());
}

fn recover_moves(app: &AppHandle, id: &str) -> Result<(), String> {
    transaction(app, |tx, _| {
        let chats = chats(tx, id)?;
        if !chats
            .iter()
            .any(|(_, c)| c.items.iter().any(|i| i.transfer.is_some()))
        {
            return Ok(());
        }
        let receipts = todo::attention_transfer_receipts(app, id)?;
        for (key, mut c) in chats {
            let mut changed = false;
            for item in &mut c.items {
                let Some(transfer) = &item.transfer else {
                    continue;
                };
                if item.state != Status::Moved {
                    if let Some(receipt) = receipts.get(&transfer.operation) {
                        if !receipt.undone {
                            finish_move(item, receipt.destination_id.clone());
                            changed = true;
                        }
                    }
                } else if receipts
                    .get(&transfer.operation)
                    .is_some_and(|receipt| receipt.undone)
                {
                    item.transfer = None;
                    item.moved_id = None;
                    restore(item);
                    changed = true;
                }
            }
            if changed {
                c.edit_revision += 1;
                save_chat(tx, id, &key, &c)?;
            }
        }
        Ok(())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn attention_move(
    window: Webview,
    app: AppHandle,
    id: String,
    draft: TodoDraft,
    existing_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let account_id = remote(&window, &app)?;
    recover_moves(&app, &account_id)?;
    let transfer = transaction(&app, |tx, _| {
        let (key, mut c, index) = find_item(tx, &account_id, &id)?;
        let item = &mut c.items[index];
        if item.state == Status::Moved {
            return Ok(None);
        }
        if !matches!(item.state, Status::Open | Status::Review) {
            return Err("item_unavailable".into());
        }
        let t = if let Some(t) = item.transfer.clone() {
            t
        } else {
            Transfer {
                operation: item_id()?,
                kind: draft.kind.unwrap_or_default(),
                title: draft.title.unwrap_or_else(|| item.title.clone()),
                due_at: draft.due_at,
                remind_at: draft.remind_at,
                existing_id,
            }
        };
        item.transfer = Some(t.clone());
        let source = item.message.clone();
        c.edit_revision += 1;
        save_chat(tx, &account_id, &key, &c)?;
        Ok(Some((t, source)))
    })?;
    if let Some((t, source)) = transfer {
        transaction(&app, |tx, _| {
            crate::lock::require_unlocked(&app)?;
            let (key, mut c, index) = find_item(tx, &account_id, &id)?;
            let item = &mut c.items[index];
            if item.state == Status::Moved {
                return Ok(Ok(()));
            }
            if item.transfer.as_ref().map(|old| &old.operation) != Some(&t.operation) {
                return Err("item_unavailable".into());
            }
            let result = todo::attention_transfer(
                &app,
                &account_id,
                &t.operation,
                source,
                t.kind,
                t.title,
                t.due_at,
                t.remind_at,
                t.existing_id.as_deref(),
            );
            if let Ok(destination) = &result {
                finish_move(item, destination.clone());
            } else if todo::attention_transfer_receipt(&app, &account_id, &t.operation)?.is_none() {
                item.transfer = None;
            }
            save_chat(tx, &account_id, &key, &c)?;
            Ok(result.map(|_| ()))
        })??;
    }
    snapshot(&app, &account_id, None)
}

#[tauri::command(rename_all = "snake_case")]
pub fn attention_settings(window: Webview, app: AppHandle) -> Result<serde_json::Value, String> {
    local(&window, &app)?;
    transaction(&app, |tx, _| {
        let mut entries = Vec::new();
        for profile in crate::accounts::load(&app).accounts {
            let a = account(tx, &profile.id)?;
            entries.push(serde_json::json!({
                "id": profile.id, "name": profile.name, "prefs": a.prefs, "since":a.since,
                "key_configured": key(&app, &a.prefs).is_some(), "backfill_from":a.backfill_from,
                "schedule": a.prefs.schedule(),
            }));
        }
        let providers = [Provider::Openai, Provider::Gemini, Provider::Jev]
            .map(|p| {
                (
                    serde_json::to_value(p)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default(),
                    crate::keys::preview_for(&app, p.key_id()),
                )
            })
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        Ok(serde_json::json!({
            "accounts": entries, "providers": providers, "budget_cents": budget(tx)?,
            "usage": usage(tx, None, now())?, "saved_gemini": crate::keys::preview_for(&app, "gemini"),
        }))
    })
}

#[derive(Deserialize)]
pub struct Options {
    enabled: bool,
    provider: Provider,
    schedule: Schedule,
    time_zone: String,
    use_saved_gemini: bool,
    #[serde(default)]
    consent: bool,
    #[serde(default)]
    backfill_days: u64,
}

#[tauri::command(rename_all = "snake_case")]
pub fn attention_configure(
    window: Webview,
    app: AppHandle,
    account_id: String,
    options: Options,
    budget_cents: u64,
) -> Result<(), String> {
    local(&window, &app)?;
    if !crate::accounts::load(&app)
        .accounts
        .iter()
        .any(|p| p.id == account_id)
        || !options.schedule.valid()
        || options.time_zone.parse::<chrono_tz::Tz>().is_err()
        || budget_cents > 100_000
        || options.backfill_days > 7
    {
        return Err("invalid_settings".into());
    }
    transaction(&app, |tx, runtime| {
        let mut a = account(tx, &account_id)?;
        let new_consent = !a.prefs.enabled
            || a.prefs.provider != options.provider
            || a.prefs.use_saved_gemini != options.use_saved_gemini;
        if options.enabled && new_consent && !options.consent {
            return Err("provider_consent_required".into());
        }
        if options.enabled && !a.prefs.enabled {
            a.since = now();
            a.through = 0;
            a.discovered_through = 0;
            a.has_gap = false;
            a.gap_since = None;
            a.last_checked = 0;
            a.partial = true;
            a.checked_slot.clear();
        }
        if !options.enabled {
            runtime.online.remove(&account_id);
            a.backfill_from = None;
            for (key, mut c) in chats(tx, &account_id)? {
                c.messages.clear();
                c.pending_since = 0;
                c.checked = c.revision;
                save_chat(tx, &account_id, &key, &c)?;
            }
        } else if options.backfill_days != 0 {
            a.backfill_from = Some(now().saturating_sub(options.backfill_days * DAY));
            a.partial = true;
        }
        if a.prefs.schedule() != options.schedule || a.prefs.time_zone != options.time_zone {
            a.checked_slot.clear();
        }
        a.prefs.enabled = options.enabled;
        a.prefs.provider = options.provider;
        a.prefs.start_hour = options.schedule.start_minute / 60;
        a.prefs.schedule = Some(options.schedule);
        a.prefs.time_zone = options.time_zone;
        a.prefs.use_saved_gemini = options.use_saved_gemini;
        a.generation += 1;
        a.pause.clear();
        a.retry_at = 0;
        save_account(tx, &account_id, &a)?;
        tx.execute(
            "INSERT OR REPLACE INTO attention_budget VALUES(1,?1)",
            [budget_cents],
        )
        .map_err(fail)?;
        Ok(())
    })?;
    push(&app, &account_id);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn attention_set_key(
    window: Webview,
    app: AppHandle,
    provider: Provider,
    key: String,
    remove: Option<bool>,
) -> Result<(), String> {
    local(&window, &app)?;
    let key = if remove.unwrap_or(false) {
        ""
    } else {
        let key = key.trim();
        if key.is_empty() {
            return Err("bad_key".into());
        }
        key
    };
    let ids = transaction(&app, |tx, _| {
        crate::keys::set_key(&app, provider.key_id(), key).map_err(str::to_owned)?;
        refresh_key_users(tx, &app, provider, false)
    })?;
    for id in ids {
        push(&app, &id);
    }
    Ok(())
}

pub fn transcription_gemini_key_changed(app: &AppHandle) {
    if let Ok(ids) = transaction(app, |tx, _| {
        refresh_key_users(tx, app, Provider::Gemini, true)
    }) {
        for id in ids {
            push(app, &id);
        }
    }
}

fn refresh_key_users(
    tx: &Connection,
    app: &AppHandle,
    provider: Provider,
    use_shared: bool,
) -> Result<Vec<String>, String> {
    if use_shared && crate::keys::has_key(app, provider.key_id()) {
        return Ok(Vec::new());
    }
    let mut ids = Vec::new();
    for profile in crate::accounts::load(app).accounts {
        let mut a = account(tx, &profile.id)?;
        if a.prefs.provider == provider
            && a.prefs.enabled
            && (!use_shared || a.prefs.use_saved_gemini)
        {
            a.generation += 1;
            a.pause.clear();
            a.retry_at = 0;
            save_account(tx, &profile.id, &a)?;
            ids.push(profile.id);
        }
    }
    Ok(ids)
}

struct Run {
    id: String,
    slot: NaiveDateTime,
    generation: u64,
    epoch: u64,
    deferred: BTreeSet<String>,
}

fn begin_runs(app: &AppHandle) -> Result<Vec<Run>, String> {
    transaction(app, |tx, runtime| {
        let at = now();
        let mut runs = Vec::new();
        for profile in crate::accounts::load(app).accounts {
            let id = profile.id;
            let mut a = account(tx, &id)?;
            let Some(slot) = slot(&a.prefs, at) else {
                continue;
            };
            if !a.prefs.enabled
                // A clock change can repeat several sub-hour slots in turn.
                || last_slot(&a.checked_slot).is_some_and(|previous| slot <= previous)
                || !session_ready(runtime, &id, at)
                || a.retry_at > at
                || matches!(a.pause.as_str(), "credit" | "credentials" | "request")
            {
                continue;
            }
            if key(app, &a.prefs).is_none() {
                continue;
            }
            a.checked_slot = slot.format(SLOT_FORMAT).to_string();
            save_account(tx, &id, &a)?;
            runs.push(Run {
                id,
                slot,
                generation: a.generation,
                epoch: runtime.epoch,
                deferred: BTreeSet::new(),
            });
        }
        Ok(runs)
    })
}

struct Work {
    chat_id: String,
    chat: Chat,
    provider: Provider,
}

fn current(app: &AppHandle, runtime: &Runtime, a: &Account, run: &Run) -> bool {
    slot(&a.prefs, now()).as_ref() == Some(&run.slot) && can_apply_decision(app, runtime, a, run)
}

fn can_apply_decision(app: &AppHandle, runtime: &Runtime, a: &Account, run: &Run) -> bool {
    runtime.epoch == run.epoch
        && crate::lock::is_unlocked(app)
        && a.prefs.enabled
        && a.generation == run.generation
        && session_ready(runtime, &run.id, now())
        && app
            .get_webview(&crate::accounts::window_label(&run.id))
            .is_some()
}

fn pending_chat(tx: &Connection, run: &Run) -> Result<Option<(String, String)>, String> {
    let mut query = tx
        .prepare(
            "SELECT id,data FROM attention_chat WHERE account=?1 AND pending_since>0
         ORDER BY pending_since,id LIMIT ?2",
        )
        .map_err(fail)?;
    let rows = query
        .query_map(params![run.id, run.deferred.len() + 1], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(fail)?;
    for row in rows {
        let (id, data) = row.map_err(fail)?;
        if !run.deferred.contains(&id) {
            return Ok(Some((id, data)));
        }
    }
    Ok(None)
}

fn next_work(app: &AppHandle, run: &Run) -> Result<Option<Work>, String> {
    transaction(app, |tx, runtime| {
        let mut a = account(tx, &run.id)?;
        if !current(app, runtime, &a, run) {
            return Ok(None);
        }
        if let Some((chat_id, raw)) = pending_chat(tx, run)? {
            let mut c: Chat = decode(raw)?;
            if prune(&mut c, now()) {
                save_chat(tx, &run.id, &chat_id, &c)?;
            }
            Ok(Some(Work {
                chat_id,
                chat: c,
                provider: a.prefs.provider,
            }))
        } else {
            if run.deferred.is_empty() {
                a.last_checked = now();
                if a.pause != "review" {
                    a.pause.clear();
                }
                save_account(tx, &run.id, &a)?;
            }
            Ok(None)
        }
    })
}

async fn process(app: &AppHandle, run: &mut Run) -> Result<bool, String> {
    let Some(work) = next_work(app, run)? else {
        return Ok(false);
    };
    let (batch, prepared) = model::pack(&work.chat, work.provider);
    let result = if let Some(Ok(req)) = &prepared {
        let reservation = transaction(app, |tx, runtime| {
            let mut a = account(tx, &run.id)?;
            if !current(app, runtime, &a, run) || !allowed(&a.prefs, &work.chat_id) {
                return Ok(None);
            }
            let Some(api_key) = key(app, &a.prefs) else {
                return Ok(None);
            };
            let Some(usage_id) =
                reserve(tx, &run.id, work.provider, now(), req.upper_input_tokens())?
            else {
                a.pause = "budget".into();
                save_account(tx, &run.id, &a)?;
                return Ok(None);
            };
            Ok(Some((usage_id, api_key)))
        })?;
        let Some((usage_id, api_key)) = reservation else {
            return Ok(false);
        };
        // Pending reservations stay conservative after abrupt shutdown.
        let result = req.execute(&api_key).await;
        if let Some(tokens) = result.input_tokens {
            transaction(app, |tx, _| {
                tx.execute(
                    "UPDATE attention_usage SET tokens=?2,cost=?3,estimated=0 WHERE id=?1",
                    params![
                        usage_id,
                        tokens,
                        tokens.saturating_mul(work.provider.rate_nanos_per_token())
                    ],
                )
                .map_err(fail)?;
                Ok(())
            })?;
        }
        result
    } else {
        crate::attention_provider::DecisionResult {
            failure: prepared.map(|_| Failure::InvalidRequest),
            ..Default::default()
        }
    };
    let mut defer = false;
    let keep_going = transaction(app, |tx, runtime| {
        let mut a = account(tx, &run.id)?;
        // A request begun inside its slot can finish after the clock advances.
        // Recheck consent and chat revisions before keeping the paid result.
        if !can_apply_decision(app, runtime, &a, run) || !allowed(&a.prefs, &work.chat_id) {
            return Ok(false);
        }
        let at = now();
        a.pause = match result.failure {
            Some(Failure::Credentials) => "credentials",
            Some(Failure::Credit) => "credit",
            Some(Failure::Throttled) => "throttled",
            Some(Failure::Retryable) => "retry",
            Some(Failure::InvalidRequest) => "request",
            Some(Failure::InvalidResponse) if result.answers.is_empty() => "request",
            Some(Failure::InvalidResponse | Failure::Refused) => "review",
            None => "",
        }
        .into();
        let stopped = matches!(
            a.pause.as_str(),
            "credentials" | "credit" | "throttled" | "retry" | "request"
        );
        if stopped {
            a.retry_at = at
                + if a.pause == "throttled" {
                    15 * 60_000
                } else {
                    60_000
                };
            save_account(tx, &run.id, &a)?;
            return Ok(false);
        }
        let mut c = chat(tx, &run.id, &work.chat_id)?;
        if c.revision != work.chat.revision || c.edit_revision != work.chat.edit_revision {
            defer = true;
            return Ok(true);
        }
        model::apply(&mut c, &batch, &result.answers, work.provider, at)?;
        c.checked = batch.through;
        c.pending_since = if c.checked < c.revision { at } else { 0 };
        prune(&mut c, at);
        a.last_checked = at;
        save_chat(tx, &run.id, &work.chat_id, &c)?;
        save_account(tx, &run.id, &a)?;
        Ok(true)
    })?;
    if defer {
        run.deferred.insert(work.chat_id);
    }
    Ok(keep_going)
}

pub async fn scheduler(app: AppHandle) {
    loop {
        if crate::lock::is_unlocked(&app) {
            let mut active = begin_runs(&app).unwrap_or_default();
            for _ in 0..MAX_REQUESTS_PER_SLOT {
                if active.is_empty() {
                    break;
                }
                let mut next = Vec::new();
                for mut run in active {
                    if process(&app, &mut run).await == Ok(true) {
                        next.push(run);
                    } else {
                        push(&app, &run.id);
                    }
                }
                active = next;
            }
            for run in active {
                push(&app, &run.id);
            }
        }
        tokio::time::sleep(Duration::from_secs(12)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attention_provider::Answer;

    fn time(value: &str) -> u64 {
        chrono::DateTime::parse_from_rfc3339(value)
            .unwrap()
            .timestamp_millis() as u64
    }

    fn message(index: u64, text: &str) -> Message {
        Message {
            message: TodoMessageRef {
                msg_id: format!("false_123@c.us_MESSAGE{index}"),
                msg_epoch: Some(index * 1000),
                chat_id: Some("123@c.us".into()),
                snippet: text.into(),
                ..Default::default()
            },
            at_ms: index * 1000,
            ..Default::default()
        }
    }

    fn answers(rows: &[(&str, &str, f64)]) -> BTreeMap<String, Answer> {
        rows.iter()
            .map(|(q, choice, p)| {
                (
                    (*q).into(),
                    Answer {
                        choice: (*choice).into(),
                        probability: *p,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn attention_local_hour_handles_repeated_clock_and_midnight() {
        let prefs = Prefs {
            start_hour: 13,
            time_zone: "America/Denver".into(),
            ..Default::default()
        };
        let first = slot(&prefs, time("2026-11-01T01:15:00-06:00"));
        assert!(first.is_some());
        assert_eq!(first, slot(&prefs, time("2026-11-01T01:45:00-07:00")));
        assert!(slot(&prefs, time("2026-11-01T06:59:00-07:00")).is_some());
        assert!(slot(&prefs, time("2026-11-01T07:00:00-07:00")).is_none());
        assert_ne!(
            slot(&prefs, time("2026-03-08T01:59:00-07:00")),
            slot(&prefs, time("2026-03-08T03:00:00-06:00")),
        );
    }

    #[test]
    fn attention_legacy_preferences_keep_their_start_hour_and_last_check() {
        let default = Prefs::default().schedule();
        assert_eq!(
            (
                default.start_minute,
                default.end_minute,
                default.interval_minutes
            ),
            (420, 60, 60)
        );
        let prefs: Prefs = serde_json::from_str(r#"{"start_hour":9}"#).unwrap();
        let schedule = prefs.schedule();
        assert_eq!(
            (
                schedule.start_minute,
                schedule.end_minute,
                schedule.interval_minutes
            ),
            (540, 180, 60)
        );
        let at = time("2026-11-26T13:15:00Z");
        assert_eq!(slot(&prefs, at), last_slot("2026-11-26/13"));
    }

    #[test]
    fn attention_custom_schedule_uses_window_start_and_excludes_the_end() {
        let mut prefs = Prefs {
            schedule: Some(Schedule {
                start_minute: 22 * 60 + 10,
                end_minute: 70,
                interval_minutes: 45,
            }),
            ..Default::default()
        };
        let at = time("2026-11-26T23:50:00Z");
        assert_eq!(slot(&prefs, at), last_slot("2026-11-26/23:40"));
        let after_midnight = time("2026-11-27T00:09:00Z");
        assert_eq!(slot(&prefs, after_midnight), slot(&prefs, at));
        assert_eq!(
            slot(&prefs, time("2026-11-27T00:25:00Z")),
            last_slot("2026-11-27/00:25")
        );
        assert_eq!(slot(&prefs, time("2026-11-27T01:10:00Z")), None);

        prefs.schedule = Some(Schedule {
            start_minute: 90,
            end_minute: 90,
            interval_minutes: MINUTES_PER_DAY,
        });
        assert_eq!(
            slot(&prefs, time("2026-11-27T01:29:00Z")),
            last_slot("2026-11-26/01:30")
        );
        assert_eq!(
            slot(&prefs, time("2026-11-27T01:30:00Z")),
            last_slot("2026-11-27/01:30")
        );
    }

    #[test]
    fn attention_subhour_schedule_skips_repeated_and_missing_clock_times() {
        let mut account = Account {
            prefs: Prefs {
                enabled: true,
                schedule: Some(Schedule {
                    start_minute: 0,
                    end_minute: 240,
                    interval_minutes: 15,
                }),
                time_zone: "America/Denver".into(),
                ..Default::default()
            },
            checked_slot: "2026-11-01/01:45".into(),
            ..Default::default()
        };
        assert_eq!(
            next_check(&account, time("2026-11-01T01:02:00-07:00")),
            Some(time("2026-11-01T02:00:00-07:00"))
        );
        account.prefs.schedule = Some(Schedule {
            start_minute: 110,
            end_minute: 240,
            interval_minutes: 20,
        });
        account.checked_slot = "2026-03-08/01:50".into();
        let after_jump = time("2026-03-08T03:01:00-06:00");
        assert!(active_window(&account.prefs, after_jump));
        assert!(slot(&account.prefs, after_jump).is_none());
        assert_eq!(
            next_check(&account, after_jump),
            Some(time("2026-03-08T03:10:00-06:00"))
        );
    }

    #[test]
    fn attention_replays_cannot_overwrite_edits_and_revocations() {
        let mut chat = Chat::default();
        let original = message(1, "Send the invoice.");
        merge_message(&mut chat, original.clone(), 5_000);
        merge_message(&mut chat, original.clone(), 6_000);
        assert_eq!(chat.revision, 1);
        let mut edit = message(1, "Send the quote.");
        edit.edited_at = Some(7000);
        merge_message(&mut chat, edit.clone(), 7_000);
        merge_message(&mut chat, original, 8_000);
        assert_eq!(chat.messages[0].message.snippet, "Send the quote.");
        let mut revoke = message(1, "");
        revoke.deleted = true;
        merge_message(&mut chat, revoke, 9_000);
        merge_message(&mut chat, edit, 10_000);
        assert_eq!(chat.revision, 3);
        assert!(chat.messages[0].message.snippet.is_empty());
    }

    #[test]
    fn attention_overlapping_work_and_suggested_closure_are_independent() {
        let mut chat = Chat::default();
        merge_message(
            &mut chat,
            message(1, "Please send a quote. Please send an invoice."),
            1000,
        );
        let batch = model::prepare(&chat, 4);
        model::apply(
            &mut chat,
            &batch,
            &answers(&[
                ("work_p1", "reply", 0.97),
                ("work_p2", "reply", 0.98),
                ("link_p2", "new", 0.98),
            ]),
            Provider::Openai,
            5_000,
        )
        .unwrap();
        assert_eq!(chat.items.len(), 2);
        assert_ne!(chat.items[0].id, chat.items[1].id);
        assert_eq!(chat.items[0].eligible_at, 5_000 + HOUR);
        chat.checked = chat.revision;
        merge_message(&mut chat, message(2, "Thanks."), 5_100);
        let batch = model::prepare(&chat, 4);
        model::apply(
            &mut chat,
            &batch,
            &answers(&[
                ("work_p1", "none", 0.99),
                ("close_o1", "open", 0.99),
                ("close_o2", "open", 0.99),
            ]),
            Provider::Openai,
            5_100,
        )
        .unwrap();
        assert!(chat
            .items
            .iter()
            .all(|i| !i.review_close && i.state == Status::Open));
        chat.checked = chat.revision;
        merge_message(&mut chat, message(3, "Here is your quote."), 5_200);
        let batch = model::prepare(&chat, 4);
        let evidence: serde_json::Value = serde_json::from_str(&batch.input).unwrap();
        assert_eq!(
            evidence["tracked_obligations"][0]["work"],
            "Please send a quote."
        );
        assert_eq!(
            evidence["tracked_obligations"][1]["work"],
            "Please send an invoice."
        );
        model::apply(
            &mut chat,
            &batch,
            &answers(&[
                ("work_p1", "none", 0.99),
                ("close_o1", "p1", 0.99),
                ("close_o2", "open", 0.99),
            ]),
            Provider::Openai,
            5_200,
        )
        .unwrap();
        assert!(chat.items[0].review_close && chat.items[0].resolution_message.is_some());
        assert!(chat.items[0].state == Status::Open && !chat.items[1].review_close);
    }

    #[test]
    fn attention_full_batch_fits_all_provider_adapters() {
        let mut chat = Chat::default();
        for n in 1..=4 {
            let text = format!(
                "{}? {}. {}!",
                "á".repeat(350),
                "猫".repeat(350),
                "x".repeat(350)
            );
            merge_message(&mut chat, message(n, &text), n * 1000);
        }
        for n in 0..8 {
            let source = message(1, &"x".repeat(360)).message;
            chat.items
                .push(new_item(source, n.to_string(), Kind::Action, String::new(), 1000).unwrap());
        }
        for p in [Provider::Openai, Provider::Gemini, Provider::Jev] {
            let (batch, request) = model::pack(&chat, p);
            assert!(request.is_some_and(|r| r.is_ok()), "{p:?}");
            assert!(batch.through > 0 && batch.through <= chat.revision);
        }
    }

    #[test]
    fn attention_idle_chat_needs_no_provider_and_budget_is_shared_across_accounts() {
        assert!(model::pack(&Chat::default(), Provider::Openai).1.is_none());
        let mut c = Connection::open_in_memory().unwrap();
        initialize(&c).unwrap();
        c.execute("INSERT INTO attention_budget VALUES(1,1)", [])
            .unwrap();
        let at = time("2026-11-30T23:59:50Z");
        let transaction = c.transaction().unwrap();
        assert!(
            reserve(&transaction, "default", Provider::Openai, at, 90_000)
                .unwrap()
                .is_some()
        );
        transaction.commit().unwrap();
        // An unsettled charge in the first account still counts after the
        // reservation transaction closes, including for another provider.
        assert!(reserve(&c, "acct-1", Provider::Jev, at, 30_000)
            .unwrap()
            .is_none());
        assert!(reserve(&c, "acct-1", Provider::Jev, at + 60_000, 30_000)
            .unwrap()
            .is_some());
    }

    #[test]
    fn attention_stale_chat_stays_pending_without_blocking_other_chats() {
        let c = Connection::open_in_memory().unwrap();
        initialize(&c).unwrap();
        for (id, at) in [("busy", 1), ("other", 2)] {
            save_chat(
                &c,
                "default",
                id,
                &Chat {
                    pending_since: at,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let mut run = Run {
            id: "default".into(),
            slot: last_slot("2026-11-26/12:00").unwrap(),
            generation: 0,
            epoch: 0,
            deferred: BTreeSet::new(),
        };
        assert_eq!(pending_chat(&c, &run).unwrap().unwrap().0, "busy");
        run.deferred.insert("busy".into());
        assert_eq!(pending_chat(&c, &run).unwrap().unwrap().0, "other");
        run.deferred.clear();
        assert_eq!(pending_chat(&c, &run).unwrap().unwrap().0, "busy");
    }

    #[test]
    fn attention_short_backfill_cannot_clear_an_older_gap() {
        let mut a = Account {
            since: 100,
            ..Default::default()
        };
        a.note_gap(200);
        a.note_gap(350);
        a.backfill_from = Some(300);
        a.record_backfill();
        assert!(a.has_gap);
        a.backfill_from = Some(200);
        a.record_backfill();
        assert!(!a.has_gap);
    }

    #[test]
    #[ignore = "sends billable synthetic requests with explicitly supplied provider keys"]
    fn attention_live_synthetic_pilot() {
        // These examples are smoke cases for the hosted API and end-to-end
        // decisions. Use a larger held-out set for release calibration.
        let cases: &[(&str, &[(&str, bool)], usize, usize)] = &[
            ("quiet", &[("Thanks, have a nice weekend.", false)], 0, 0),
            (
                "reply",
                &[("Can you confirm which invoices are overdue?", false)],
                1,
                0,
            ),
            (
                "promise",
                &[
                    ("I'll send the replacement packing slip tomorrow.", true),
                    ("Thanks.", false),
                ],
                1,
                0,
            ),
            (
                "portuguese",
                &[("Você pode enviar a segunda via do boleto?", false)],
                1,
                0,
            ),
            (
                "fulfilled",
                &[
                    ("Can you send the packing slip?", false),
                    ("Here's the packing slip number PS-614.", true),
                ],
                1,
                1,
            ),
        ];
        for (provider, variable) in [
            (Provider::Openai, "WHATRUST_ATTENTION_OPENAI_KEY"),
            (Provider::Gemini, "WHATRUST_ATTENTION_GEMINI_KEY"),
            (Provider::Jev, "WHATRUST_ATTENTION_JEV_KEY"),
        ] {
            let key = std::env::var(variable)
                .unwrap_or_else(|_| panic!("Set {variable} to run the comparison"));
            let mut totals = (0, 0, 0, 0, 0, 0);
            for (name, turns, expected, expected_closures) in cases {
                let mut chat = Chat::default();
                for (index, (text, business)) in turns.iter().enumerate() {
                    let turn = index as u64 + 1;
                    let mut m = message(turn, text);
                    m.from_me = *business;
                    merge_message(&mut chat, m, turn * 1000);
                    let (batch, request) = model::pack(&chat, provider);
                    let request = request.unwrap().unwrap();
                    let result = tauri::async_runtime::block_on(request.execute(&key));
                    assert!(
                        result.failure.is_none() && !result.answers.is_empty(),
                        "{provider:?} {name}: {:?}",
                        result.failure
                    );
                    model::apply(&mut chat, &batch, &result.answers, provider, turn * 1000)
                        .unwrap();
                    chat.checked = batch.through;
                    totals.5 += result.input_tokens.unwrap_or(request.upper_input_tokens());
                }
                let surfaced = chat
                    .items
                    .iter()
                    .filter(|item| item.state == Status::Open)
                    .count();
                let proposed = chat.items.iter().filter(|item| item.review_close).count();
                totals.0 += surfaced.min(*expected);
                totals.1 += surfaced;
                totals.2 += expected;
                totals.3 += proposed.saturating_sub(*expected_closures);
                totals.4 += proposed;
                println!("{} {name}: surfaced {surfaced}/{expected}, proposed closure {proposed}/{expected_closures}", provider.model());
            }
            println!(
                "{}: actionable {}/{}, recall {}/{}, wrong closure proposals {}/{}, input tokens {}",
                provider.model(), totals.0, totals.1, totals.0, totals.2, totals.3, totals.4, totals.5
            );
        }
    }
}

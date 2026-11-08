//! Per-account to-do list. The WhatsApp page can add a message, edit it, and set
//! a reminder; a background thread raises one native notification when it comes due.
//!
//! Files live in `app_data_dir()/todos/<account-id>.json`, not under `profiles/`.
//! On macOS the profile directory is owned by WebKit and `delete_profile` is a
//! no-op, and the default account has no `profiles/default` directory on any OS.
//! `app_data_dir` is removed wholesale by a factory reset.

use crate::i18n::{tr, trf};
use crate::jsonfile::Loaded;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const MAX_TODOS: usize = 2_000;
pub const DAY_MS: u64 = 86_400_000;
const WEEK_MS: u64 = DAY_MS * 7;
/// How often the idle scheduler looks for a reminder that came due on its own.
const IDLE_TICK: Duration = Duration::from_secs(30);
/// After launch or unlock the page needs a moment to see replies that arrived
/// while it could not save. Watch reminders wait this out; tasks do not.
const UNLOCK_GRACE_MS: u64 = 20_000;
/// 2000-01-01T00:00:00Z, and a point in 2100. Rejects 0 and millisecond typos.
const MIN_TIME: u64 = 946_684_800_000;
const MAX_TIME: u64 = 4_102_444_800_000;

pub struct TodoState {
    gate: Mutex<()>,
    poke: Mutex<bool>,
    wake: Condvar,
    tz: Mutex<i32>,
    /// The next unlocked pass summarizes reminders that are already due, so a
    /// launch or an unlock does not raise one banner per missed item.
    summarize_next: AtomicBool,
    /// Watch reminders are held until this instant so a reply that arrived
    /// while the app was locked can clear them first.
    grace_until: AtomicU64,
}

impl Default for TodoState {
    fn default() -> Self {
        Self {
            gate: Mutex::new(()),
            poke: Mutex::new(false),
            wake: Condvar::new(),
            tz: Mutex::new(0),
            summarize_next: AtomicBool::new(true),
            grace_until: AtomicU64::new(now_ms().saturating_add(UNLOCK_GRACE_MS)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    #[default]
    Task,
    Waiting,
    Owe,
}

impl ItemKind {
    fn is_watch(self) -> bool {
        matches!(self, Self::Waiting | Self::Owe)
    }

    fn same_class(self, other: Self) -> bool {
        self.is_watch() == other.is_watch()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Low,
    #[default]
    Normal,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RepeatRule {
    #[default]
    None,
    Daily,
    Weekly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TodoMessageRef {
    #[serde(default)]
    pub msg_id: String,
    #[serde(default)]
    pub msg_token: String,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub chat_name: String,
    #[serde(default)]
    pub sender: String,
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub msg_timestamp: Option<String>,
    #[serde(default)]
    pub kind: String,
    /// When the message was sent, in milliseconds. A later chat message is
    /// compared against this and against when the watch was marked.
    #[serde(default)]
    pub msg_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub message: Option<TodoMessageRef>,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub due_at: Option<u64>,
    #[serde(default)]
    pub remind_at: Option<u64>,
    #[serde(default)]
    pub snooze_until: Option<u64>,
    #[serde(default)]
    pub repeat: RepeatRule,
    /// The current `effective_remind_at` has already been announced.
    #[serde(default)]
    pub fired: bool,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub completed_at: Option<u64>,
    /// `task` is a to-do. `waiting` and `owe` are reply watches and stay off
    /// the to-do page.
    #[serde(default)]
    pub kind: ItemKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TodoFile {
    #[serde(default)]
    pub next_seq: u64,
    #[serde(default)]
    pub items: Vec<TodoItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TodoAlarm {
    pub id: String,
    pub title: String,
    pub chat_name: String,
    pub kind: ItemKind,
    pub chat_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TodoSnapshot {
    pub items: Vec<TodoItem>,
    pub overdue_count: u32,
    pub today_count: u32,
    pub open_count: u32,
    pub alarms: Vec<TodoAlarm>,
    pub reply_open_count: u32,
}

#[derive(Debug, Deserialize)]
pub struct TodoDraft {
    pub title: Option<String>,
    pub note: Option<String>,
    pub priority: Option<Priority>,
    pub due_at: Option<u64>,
    pub remind_at: Option<u64>,
    pub repeat: Option<RepeatRule>,
    pub message: Option<TodoMessageRef>,
    #[serde(default)]
    pub kind: Option<ItemKind>,
}

#[derive(Debug, Deserialize)]
pub struct TodoPatch {
    pub id: String,
    pub title: Option<String>,
    pub note: Option<String>,
    pub priority: Option<Priority>,
    pub due_at: Option<u64>,
    pub remind_at: Option<u64>,
    pub repeat: Option<RepeatRule>,
    pub clear_due: Option<bool>,
    pub clear_remind: Option<bool>,
    #[serde(default)]
    pub kind: Option<ItemKind>,
}

#[derive(Debug, PartialEq, Eq)]
enum EditError {
    Invalid,
    Full,
    Missing,
}

impl EditError {
    fn message(self) -> String {
        match self {
            Self::Invalid => tr("Dados da tarefa inválidos.").into_owned(),
            Self::Full => tr("A lista de tarefas está cheia.").into_owned(),
            Self::Missing => tr("Tarefa não encontrada.").into_owned(),
        }
    }
}

pub fn on_lock(app: &AppHandle) {
    if let Some(state) = app.try_state::<TodoState>() {
        state.summarize_next.store(true, Ordering::SeqCst);
    }
}

pub fn on_unlock(app: &AppHandle) {
    if let Some(state) = app.try_state::<TodoState>() {
        state.summarize_next.store(true, Ordering::SeqCst);
        state
            .grace_until
            .store(now_ms().saturating_add(UNLOCK_GRACE_MS), Ordering::SeqCst);
    }
    poke(app);
}

pub fn poke(app: &AppHandle) {
    let Some(state) = app.try_state::<TodoState>() else {
        return;
    };
    {
        let mut flag = crate::lock::guard(&state.poke);
        *flag = true;
    }
    state.wake.notify_one();
}

/// Looks for due reminders immediately, then every half minute. Every panel
/// action pokes the scheduler, so a change shows up at once; the idle tick is
/// only there for reminders that come due on their own. Thirty seconds keeps
/// that from reading every account's list off disk all day, and a reminder can
/// still be up to half a minute late, which is fine for a to-do item.
/// A poke during a scan is remembered on `poke` so the wakeup is not lost.
/// Exits with the process.
pub fn scheduler(app: AppHandle) {
    loop {
        scan(&app);
        let state = app.state::<TodoState>();
        let wait = next_wait(&state);
        let mut guard = crate::lock::guard(&state.poke);
        if !*guard {
            let waited = state.wake.wait_timeout(guard, wait);
            guard = match waited {
                Ok(pair) => pair.0,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
        *guard = false;
    }
}

pub fn delete_account(app: &AppHandle, id: &str) {
    if !valid_account_id(id) {
        return;
    }
    let Ok(path) = account_path(app, id) else {
        return;
    };
    let state = app.try_state::<TodoState>();
    let _gate = state.as_ref().map(|state| crate::lock::guard(&state.gate));
    let _ = std::fs::remove_file(&path);
    for side in crate::jsonfile::sidecar_paths(&path) {
        let _ = std::fs::remove_file(side);
    }
}

fn scan(app: &AppHandle) {
    if !crate::lock::is_unlocked(app) {
        return;
    }
    let state = app.state::<TodoState>();
    let summarize = state.summarize_next.swap(false, Ordering::SeqCst);
    let now = now_ms();
    let accounts = crate::accounts::load(app);
    let mut pending = Vec::new();
    {
        let _gate = crate::lock::guard(&state.gate);
        let offset = *crate::lock::guard(&state.tz);
        if !crate::lock::is_unlocked(app) {
            state.summarize_next.store(true, Ordering::SeqCst);
            return;
        }
        for account in &accounts.accounts {
            let Ok(path) = account_path(app, &account.id) else {
                continue;
            };
            let mut file = read_file(&path);
            let grace = state.grace_until.load(Ordering::SeqCst);
            let alarms = take_due(&mut file, now, grace);
            if alarms.is_empty() {
                if summarize {
                    pending.push((account.id.clone(), alarms, snapshot_of(&file, now, offset)));
                }
                continue;
            }
            if write_file(&path, &file).is_err() {
                crate::dlog::log("todo: could not save a due reminder");
                continue;
            }
            pending.push((account.id.clone(), alarms, snapshot_of(&file, now, offset)));
        }
    }
    for (id, alarms, snapshot) in pending {
        if !crate::lock::is_unlocked(app) {
            state.summarize_next.store(true, Ordering::SeqCst);
            return;
        }
        if !alarms.is_empty() {
            announce(app, &id, &alarms, summarize);
            push_alarm(app, &id, &alarms, summarize);
        }
        publish(app, &id, &snapshot);
    }
}

fn next_wait(state: &TodoState) -> Duration {
    let grace = state.grace_until.load(Ordering::SeqCst);
    let now = now_ms();
    if grace > now {
        let remain = grace.saturating_sub(now).saturating_add(50);
        return Duration::from_millis(remain.min(IDLE_TICK.as_millis() as u64));
    }
    IDLE_TICK
}

fn announce(app: &AppHandle, account_id: &str, alarms: &[TodoAlarm], summarize: bool) {
    let label = crate::accounts::window_label(account_id);
    if (summarize || alarms.len() > 3) && alarms.len() > 1 {
        let watch_count = alarms.iter().filter(|alarm| alarm.kind.is_watch()).count();
        let watches = watch_count == alarms.len();
        let mixed = watch_count > 0 && !watches;
        let title = if watches {
            trf(
                "Você tem {0} lembretes de resposta pendentes.",
                &[&alarms.len()],
            )
        } else if mixed {
            trf("Você tem {0} lembretes pendentes.", &[&alarms.len()])
        } else {
            trf(
                "Você tem {0} lembretes pendentes na lista de tarefas.",
                &[&alarms.len()],
            )
        };
        let body = if watches {
            tr("Abra Respostas para vê-los.")
        } else if mixed {
            tr("Abra a lista de tarefas e Respostas para vê-los.")
        } else {
            tr("Abra a lista de tarefas para vê-los.")
        };
        crate::notify::show_for_account(app, &label, &clip_chars(&title, 180), body.as_ref());
        return;
    }
    for alarm in alarms {
        if alarm.kind.is_watch() {
            let title = watch_notice(alarm);
            let snippet = alarm.title.trim();
            let body = if snippet.is_empty() {
                tr("Abra a conversa.").into_owned()
            } else {
                clip_chars(snippet, 160)
            };
            crate::notify::show_for_account(app, &label, &title, &body);
            continue;
        }
        let title = trf("Lembrete: {0}", &[&clip_chars(&alarm.title, 120)]);
        let body = {
            let chat = alarm.chat_name.trim();
            if chat.is_empty() {
                tr("Toque para ver o item na lista de tarefas.").into_owned()
            } else {
                clip_chars(chat, 160)
            }
        };
        crate::notify::show_for_account(app, &label, &title, &body);
    }
}

fn watch_notice(alarm: &TodoAlarm) -> String {
    let chat = {
        let name = alarm.chat_name.trim();
        if name.is_empty() {
            tr("essa conversa").into_owned()
        } else {
            clip_chars(name, 80)
        }
    };
    match alarm.kind {
        ItemKind::Waiting => trf("Ainda sem resposta: {0}", &[&chat]),
        ItemKind::Owe => trf("Você ainda deve uma resposta em {0}", &[&chat]),
        ItemKind::Task => trf("Lembrete: {0}", &[&clip_chars(&alarm.title, 120)]),
    }
}

fn push_alarm(app: &AppHandle, account_id: &str, alarms: &[TodoAlarm], summary: bool) {
    let Ok(json) = serde_json::to_string(&serde_json::json!({
        "alarms": alarms,
        "summary": summary,
    })) else {
        return;
    };
    eval_account(
        app,
        account_id,
        &format!("window.__whatrustTodoAlarm&&window.__whatrustTodoAlarm({json})"),
    );
}

fn publish(app: &AppHandle, account_id: &str, snapshot: &TodoSnapshot) {
    let Ok(json) = serde_json::to_string(snapshot) else {
        return;
    };
    eval_account(
        app,
        account_id,
        &format!("window.__whatrustTodoState&&window.__whatrustTodoState({json})"),
    );
}

fn eval_account(app: &AppHandle, account_id: &str, script: &str) {
    let Some(view) = app.get_webview(&crate::accounts::window_label(account_id)) else {
        return;
    };
    let _ = view.eval(script);
}

fn account_of(window: &tauri::Webview, app: &AppHandle) -> Result<String, String> {
    crate::integration::remote(window)?;
    crate::lock::require_unlocked(app)?;
    crate::accounts::id_from_label(window.label())
        .filter(|id| valid_account_id(id))
        .map(str::to_string)
        .ok_or_else(|| "forbidden".into())
}

fn remember_tz(app: &AppHandle, tz: Option<i32>) -> i32 {
    let state = app.state::<TodoState>();
    let mut slot = crate::lock::guard(&state.tz);
    if let Some(tz) = tz {
        *slot = tz.clamp(-14 * 60, 14 * 60);
    }
    *slot
}

fn with_file<T>(
    app: &AppHandle,
    account_id: &str,
    edit: impl FnOnce(&mut TodoFile) -> Result<T, EditError>,
) -> Result<(T, TodoSnapshot), String> {
    let state = app.state::<TodoState>();
    let _gate = crate::lock::guard(&state.gate);
    let offset = *crate::lock::guard(&state.tz);
    let path = account_path(app, account_id)?;
    let mut file = read_file(&path);
    let value = edit(&mut file).map_err(EditError::message)?;
    write_file(&path, &file)?;
    let snapshot = snapshot_of(&file, now_ms(), offset);
    Ok((value, snapshot))
}

fn finish(
    app: &AppHandle,
    account_id: &str,
    snapshot: TodoSnapshot,
) -> Result<TodoSnapshot, String> {
    publish(app, account_id, &snapshot);
    poke(app);
    Ok(snapshot)
}

#[tauri::command]
pub fn todo_list(
    window: tauri::Webview,
    app: AppHandle,
    tz_offset_minutes: Option<i32>,
) -> Result<TodoSnapshot, String> {
    let account_id = account_of(&window, &app)?;
    let state = app.state::<TodoState>();
    let _gate = crate::lock::guard(&state.gate);
    let offset = remember_tz(&app, tz_offset_minutes);
    let path = account_path(&app, &account_id)?;
    let file = read_file(&path);
    Ok(snapshot_of(&file, now_ms(), offset))
}

#[tauri::command]
pub fn todo_add(
    window: tauri::Webview,
    app: AppHandle,
    draft: TodoDraft,
    tz_offset_minutes: Option<i32>,
) -> Result<TodoSnapshot, String> {
    let account_id = account_of(&window, &app)?;
    remember_tz(&app, tz_offset_minutes);
    let now = now_ms();
    let (_, snapshot) = with_file(&app, &account_id, |file| add_item(file, draft, now))?;
    finish(&app, &account_id, snapshot)
}

#[tauri::command]
pub fn todo_update(
    window: tauri::Webview,
    app: AppHandle,
    patch: TodoPatch,
) -> Result<TodoSnapshot, String> {
    let account_id = account_of(&window, &app)?;
    let (_, snapshot) = with_file(&app, &account_id, |file| update_item(file, patch))?;
    finish(&app, &account_id, snapshot)
}

#[tauri::command]
pub fn todo_toggle_done(
    window: tauri::Webview,
    app: AppHandle,
    id: String,
    done: Option<bool>,
) -> Result<TodoSnapshot, String> {
    let account_id = account_of(&window, &app)?;
    let now = now_ms();
    let (_, snapshot) = with_file(&app, &account_id, |file| {
        let item = find_mut(file, &id)?;
        let done = done.unwrap_or(!item.done);
        item.done = done;
        if done {
            item.completed_at = Some(now);
            item.fired = true;
        } else {
            item.completed_at = None;
            if effective_remind_at(item).is_some_and(|t| t > now) {
                item.fired = false;
            }
        }
        Ok(())
    })?;
    finish(&app, &account_id, snapshot)
}

#[tauri::command]
pub fn todo_delete(
    window: tauri::Webview,
    app: AppHandle,
    id: String,
) -> Result<TodoSnapshot, String> {
    let account_id = account_of(&window, &app)?;
    let (_, snapshot) = with_file(&app, &account_id, |file| {
        let before = file.items.len();
        file.items.retain(|item| item.id != id);
        if file.items.len() == before {
            Err(EditError::Missing)
        } else {
            Ok(())
        }
    })?;
    finish(&app, &account_id, snapshot)
}

#[tauri::command]
pub fn todo_snooze(
    window: tauri::Webview,
    app: AppHandle,
    id: String,
    until_ms: u64,
) -> Result<TodoSnapshot, String> {
    let account_id = account_of(&window, &app)?;
    let now = now_ms();
    let (_, snapshot) = with_file(&app, &account_id, |file| {
        if !valid_time(until_ms) || until_ms <= now {
            return Err(EditError::Invalid);
        }
        let item = find_mut(file, &id)?;
        item.snooze_until = Some(until_ms);
        item.fired = false;
        Ok(())
    })?;
    finish(&app, &account_id, snapshot)
}

#[tauri::command]
pub fn todo_dismiss_alarm(
    window: tauri::Webview,
    app: AppHandle,
    id: String,
) -> Result<TodoSnapshot, String> {
    let account_id = account_of(&window, &app)?;
    let now = now_ms();
    let (_, snapshot) = with_file(&app, &account_id, |file| {
        let item = find_mut(file, &id)?;
        dismiss_alarm(item, now);
        Ok(())
    })?;
    finish(&app, &account_id, snapshot)
}

#[tauri::command]
pub fn todo_clear_done(
    window: tauri::Webview,
    app: AppHandle,
    kind: Option<ItemKind>,
) -> Result<TodoSnapshot, String> {
    let account_id = account_of(&window, &app)?;
    let watches = kind.is_some_and(ItemKind::is_watch);
    let (_, snapshot) = with_file(&app, &account_id, |file| {
        clear_done(file, watches);
        Ok(())
    })?;
    finish(&app, &account_id, snapshot)
}

pub fn valid_account_id(id: &str) -> bool {
    if id == "default" {
        return true;
    }
    let Some(rest) = id.strip_prefix("acct-") else {
        return false;
    };
    let bytes = rest.as_bytes();
    !bytes.is_empty() && bytes.len() <= 12 && bytes.iter().all(|c| c.is_ascii_digit())
}

pub fn message_token(value: &str) -> String {
    if let Some(rest) = value
        .strip_prefix("true_")
        .or_else(|| value.strip_prefix("false_"))
    {
        if let Some((chat, rest)) = rest.split_once('_') {
            if is_jid(chat) {
                if let Some((msg, participant)) = rest.rsplit_once('_') {
                    if !msg.is_empty() && is_jid(participant) {
                        return msg.to_string();
                    }
                }
                return rest.to_string();
            }
        }
    }
    if (16..=80).contains(&value.len()) && value.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return value.to_string();
    }
    String::new()
}

fn is_jid(value: &str) -> bool {
    let Some((local, host)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !host.is_empty()
        && !local.contains('_')
        && !local.contains('@')
        && !host.contains('_')
        && !host.contains('@')
}

pub fn day_start(now_ms: u64, offset_minutes: i32) -> u64 {
    let offset = i64::from(offset_minutes.clamp(-14 * 60, 14 * 60)) * 60_000;
    let local = now_ms as i64 + offset;
    let start_local = local - local.rem_euclid(DAY_MS as i64);
    (start_local - offset).max(0) as u64
}

pub fn advance(from: u64, now: u64, repeat: RepeatRule) -> Option<u64> {
    let step = match repeat {
        RepeatRule::None => return None,
        RepeatRule::Daily => DAY_MS,
        RepeatRule::Weekly => WEEK_MS,
    };
    if from > now {
        return Some(from);
    }
    let steps = (now - from) / step + 1;
    steps
        .checked_mul(step)
        .and_then(|delta| from.checked_add(delta))
}

fn effective_remind_at(item: &TodoItem) -> Option<u64> {
    if item.done {
        return None;
    }
    item.snooze_until.or(item.remind_at)
}

fn dismiss_alarm(item: &mut TodoItem, now: u64) {
    if item.repeat == RepeatRule::None {
        item.remind_at = None;
        item.snooze_until = None;
        item.fired = true;
        return;
    }
    let base = item.remind_at.or(item.snooze_until).unwrap_or(now);
    item.remind_at = advance(base, now, item.repeat);
    item.snooze_until = None;
    item.fired = false;
}

fn take_due(file: &mut TodoFile, now: u64, grace_until: u64) -> Vec<TodoAlarm> {
    let mut alarms = Vec::new();
    for item in &mut file.items {
        if item.done || item.fired {
            continue;
        }
        if item.kind.is_watch() && now < grace_until {
            continue;
        }
        let Some(at) = effective_remind_at(item) else {
            continue;
        };
        if at <= now {
            item.fired = true;
            alarms.push(alarm_of(item));
        }
    }
    alarms
}

fn alarm_of(item: &TodoItem) -> TodoAlarm {
    let message = item.message.as_ref();
    TodoAlarm {
        id: item.id.clone(),
        title: item.title.clone(),
        chat_name: message.map(|msg| msg.chat_name.clone()).unwrap_or_default(),
        kind: item.kind,
        chat_id: message
            .and_then(|msg| msg.chat_id.clone())
            .unwrap_or_default(),
    }
}

fn clear_done(file: &mut TodoFile, watches: bool) {
    file.items
        .retain(|item| !item.done || item.kind.is_watch() != watches);
}

fn snapshot_of(file: &TodoFile, now: u64, offset_minutes: i32) -> TodoSnapshot {
    let start = day_start(now, offset_minutes);
    let end = start.saturating_add(DAY_MS);
    let mut overdue_count = 0;
    let mut today_count = 0;
    let mut open_count = 0;
    let mut reply_open_count = 0;
    let mut alarms = Vec::new();
    for item in &file.items {
        if item.done {
            continue;
        }
        if item.kind.is_watch() {
            reply_open_count += 1;
        } else {
            open_count += 1;
            if let Some(due) = item.due_at {
                if due < start {
                    overdue_count += 1;
                } else if due < end {
                    today_count += 1;
                }
            }
        }
        if item.fired && effective_remind_at(item).is_some_and(|t| t <= now) {
            alarms.push(alarm_of(item));
        }
    }
    TodoSnapshot {
        items: file.items.clone(),
        overdue_count,
        today_count,
        open_count,
        alarms,
        reply_open_count,
    }
}

fn add_item(file: &mut TodoFile, draft: TodoDraft, now: u64) -> Result<(), EditError> {
    let TodoDraft {
        title,
        note,
        priority,
        due_at,
        remind_at,
        repeat,
        message,
        kind,
    } = draft;
    let kind = kind.unwrap_or_default();
    let message = match message {
        Some(raw) => Some(sanitize_message(raw)?),
        None => None,
    };
    // A watch has no due date. Ignore that field instead of rejecting the mark
    // when a caller still sends one.
    let due_at = if kind.is_watch() {
        None
    } else {
        checked_time(due_at)?
    };
    let remind_at = checked_time(remind_at)?;
    if let Some(msg) = &message {
        if let Some(existing) = file
            .items
            .iter_mut()
            .find(|item| !item.done && item.kind.same_class(kind) && same_message(item, msg))
        {
            // A second "add" of the same message keeps the title the user gave
            // it. Only an untitled item takes the message's first line.
            // Marking the other reply kind switches the open watch.
            if kind.is_watch() {
                existing.kind = kind;
            }
            if existing.title.trim().is_empty() {
                let fallback = title
                    .as_deref()
                    .map(|title| one_line(title, 300))
                    .filter(|title| !title.is_empty());
                existing.title = fallback.unwrap_or_else(|| default_title(msg));
            }
            if !kind.is_watch() {
                if let Some(due) = due_at {
                    existing.due_at = Some(due);
                }
            }
            if let Some(remind) = remind_at {
                existing.remind_at = Some(remind);
                existing.snooze_until = None;
                existing.fired = false;
            }
            // A second "add" of the same message refreshes the link. It must
            // not clear a note, priority, or repeat the user already set.
            let incoming = msg.clone();
            let previous = existing.message.take();
            existing.message = Some(match previous {
                Some(previous) => merge_message(previous, incoming),
                None => incoming,
            });
            return Ok(());
        }
    }
    if kind.is_watch()
        && message
            .as_ref()
            .and_then(|msg| msg.chat_id.as_ref())
            .is_none()
    {
        return Err(EditError::Invalid);
    }
    if file.items.len() >= MAX_TODOS {
        return Err(EditError::Full);
    }
    let title = title
        .as_deref()
        .map(|title| one_line(title, 300))
        .filter(|title| !title.is_empty());
    let title = if let Some(title) = title {
        title
    } else if let Some(msg) = &message {
        default_title(msg)
    } else {
        return Err(EditError::Invalid);
    };
    file.next_seq = file.next_seq.saturating_add(1);
    file.items.push(TodoItem {
        id: format!("todo-{}-{}", file.next_seq, now % 1_000_000_000),
        title,
        note: clean(note.as_deref().unwrap_or(""), 4_000),
        message,
        priority: if kind.is_watch() {
            Priority::Normal
        } else {
            priority.unwrap_or_default()
        },
        due_at,
        remind_at,
        snooze_until: None,
        repeat: if kind.is_watch() {
            RepeatRule::None
        } else {
            repeat.unwrap_or_default()
        },
        fired: false,
        done: false,
        created_at: now,
        completed_at: None,
        kind,
    });
    Ok(())
}

fn update_item(file: &mut TodoFile, patch: TodoPatch) -> Result<(), EditError> {
    let item = find_mut(file, &patch.id)?;
    if let Some(kind) = patch.kind {
        if item.kind.is_watch() && kind.is_watch() {
            item.kind = kind;
        } else if kind != item.kind {
            return Err(EditError::Invalid);
        }
    }
    let watch = item.kind.is_watch();
    if let Some(title) = patch.title.as_deref() {
        let title = one_line(title, 300);
        if title.is_empty() {
            return Err(EditError::Invalid);
        }
        item.title = title;
    }
    if let Some(note) = patch.note {
        item.note = clean(&note, 4_000);
    }
    if !watch {
        if let Some(priority) = patch.priority {
            item.priority = priority;
        }
        if patch.clear_due.unwrap_or(false) {
            item.due_at = None;
        } else if let Some(due) = checked_time(patch.due_at)? {
            item.due_at = Some(due);
        }
    }
    if patch.clear_remind.unwrap_or(false) {
        item.remind_at = None;
        item.snooze_until = None;
        item.fired = true;
    } else if let Some(remind) = checked_time(patch.remind_at)? {
        item.remind_at = Some(remind);
        item.snooze_until = None;
        item.fired = false;
    }
    if let Some(repeat) = patch.repeat.filter(|_| !watch) {
        item.repeat = repeat;
    }
    Ok(())
}

fn find_mut<'a>(file: &'a mut TodoFile, id: &str) -> Result<&'a mut TodoItem, EditError> {
    file.items
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or(EditError::Missing)
}

fn merge_message(previous: TodoMessageRef, incoming: TodoMessageRef) -> TodoMessageRef {
    let mut merged = incoming;
    // Prefer the compound id, which carries the chat, so Jump can open the
    // exact message even if the page later reports only the bare token.
    if chat_from_compound(&merged.msg_id).is_none()
        && chat_from_compound(&previous.msg_id).is_some()
    {
        merged.msg_id = previous.msg_id;
    }
    if merged.snippet.is_empty() {
        merged.snippet = previous.snippet;
    }
    if merged.chat_name.is_empty() {
        merged.chat_name = previous.chat_name;
    }
    if merged.sender.is_empty() {
        merged.sender = previous.sender;
    }
    if merged.chat_id.is_none() {
        merged.chat_id = previous.chat_id;
    }
    if merged.msg_timestamp.is_none() {
        merged.msg_timestamp = previous.msg_timestamp;
    }
    if merged.kind == "other" && previous.kind != "other" {
        merged.kind = previous.kind;
    }
    if merged.msg_epoch.is_none() {
        merged.msg_epoch = previous.msg_epoch;
    }
    merged
}

fn same_message(item: &TodoItem, msg: &TodoMessageRef) -> bool {
    let Some(existing) = &item.message else {
        return false;
    };
    (!msg.msg_id.is_empty() && existing.msg_id == msg.msg_id)
        || (!msg.msg_token.is_empty() && existing.msg_token == msg.msg_token)
}

fn sanitize_message(raw: TodoMessageRef) -> Result<TodoMessageRef, EditError> {
    let msg_id = one_line(&raw.msg_id, 180);
    if !valid_stored_msg_id(&msg_id) {
        return Err(EditError::Invalid);
    }
    let derived = message_token(&msg_id);
    let token = if !derived.is_empty() {
        derived
    } else {
        message_token(raw.msg_token.trim())
    };
    if token.is_empty() {
        return Err(EditError::Invalid);
    }
    let chat_id = raw
        .chat_id
        .as_deref()
        .map(str::trim)
        .filter(|id| valid_chat_id(id))
        .map(str::to_string)
        .or_else(|| chat_from_compound(&msg_id));
    let timestamp = raw
        .msg_timestamp
        .as_deref()
        .map(|value| one_line(value, 64))
        .filter(|value| !value.is_empty());
    let msg_epoch = raw.msg_epoch.filter(|time| valid_time(*time));
    Ok(TodoMessageRef {
        msg_id,
        msg_token: token,
        chat_id,
        chat_name: one_line(&raw.chat_name, 160),
        sender: one_line(&raw.sender, 160),
        snippet: clean(&raw.snippet, 1_000),
        msg_timestamp: timestamp,
        kind: normalize_kind(&raw.kind),
        msg_epoch,
    })
}

fn valid_stored_msg_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 180 {
        return false;
    }
    if !id
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'@' | b'.' | b'_' | b'-' | b'+'))
    {
        return false;
    }
    if id.starts_with("true_") || id.starts_with("false_") {
        return crate::voice::valid_message_id(id);
    }
    (16..=80).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_alphanumeric())
}

fn valid_chat_id(id: &str) -> bool {
    id.len() <= 120
        && is_jid(id)
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'@' | b'.' | b'_' | b'-' | b'+'))
}

fn chat_from_compound(id: &str) -> Option<String> {
    let rest = id
        .strip_prefix("true_")
        .or_else(|| id.strip_prefix("false_"))?;
    let (chat, _) = rest.split_once('_')?;
    valid_chat_id(chat).then(|| chat.to_string())
}

fn normalize_kind(kind: &str) -> String {
    match kind {
        "text" | "voice" | "image" | "video" | "document" => kind.to_string(),
        _ => "other".to_string(),
    }
}

fn default_title(msg: &TodoMessageRef) -> String {
    let line = msg.snippet.lines().next().unwrap_or("").trim();
    if !line.is_empty() {
        return one_line(line, 300);
    }
    tr("Mensagem do WhatsApp").into_owned()
}

fn checked_time(value: Option<u64>) -> Result<Option<u64>, EditError> {
    match value {
        Some(time) if !valid_time(time) => Err(EditError::Invalid),
        other => Ok(other),
    }
}

fn valid_time(time: u64) -> bool {
    (MIN_TIME..=MAX_TIME).contains(&time)
}

fn valid_todo_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("todo-") else {
        return false;
    };
    !rest.is_empty() && rest.len() <= 40 && rest.bytes().all(|c| c.is_ascii_digit() || c == b'-')
}

fn clean(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|ch| *ch == '\n' || *ch == '\t' || !ch.is_control())
        .take(max_chars)
        .collect()
}

fn one_line(value: &str, max_chars: usize) -> String {
    clean(value, max_chars)
        .replace(['\n', '\r', '\t'], " ")
        .trim()
        .to_string()
}

fn clip_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn account_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_account_id(id) {
        return Err(tr("Dados da tarefa inválidos.").into());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("todos")
        .join(format!("{id}.json")))
}

fn read_file(path: &Path) -> TodoFile {
    match crate::jsonfile::read(path) {
        Loaded::Ok(mut file) | Loaded::Recovered(mut file) => {
            normalize(&mut file);
            file
        }
        Loaded::Missing => TodoFile::default(),
        Loaded::Corrupt => {
            crate::jsonfile::preserve_corrupt(path);
            crate::dlog::log("todo: unreadable file, starting empty");
            TodoFile::default()
        }
    }
}

fn write_file(path: &Path, file: &TodoFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    crate::jsonfile::save(path, file).map_err(|err| err.to_string())
}

fn normalize(file: &mut TodoFile) {
    file.items.retain(|item| valid_todo_id(&item.id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        use std::sync::atomic::AtomicU64;
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "whatrust-todo-{name}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn message(id: &str) -> TodoMessageRef {
        TodoMessageRef {
            msg_id: id.into(),
            msg_token: message_token(id),
            chat_id: None,
            chat_name: "Ada".into(),
            sender: "Ada".into(),
            snippet: "please send the file".into(),
            msg_timestamp: Some("12:41".into()),
            kind: "text".into(),
            msg_epoch: None,
        }
    }

    fn draft_message(id: &str) -> TodoDraft {
        TodoDraft {
            title: Some("please send the file".into()),
            note: None,
            priority: Some(Priority::High),
            due_at: None,
            remind_at: None,
            repeat: None,
            message: Some(message(id)),
            kind: None,
        }
    }

    #[test]
    fn account_ids_cannot_escape_the_todo_directory() {
        assert!(valid_account_id("default"));
        assert!(valid_account_id("acct-12"));
        assert!(!valid_account_id("acct-"));
        assert!(!valid_account_id("acct-12a"));
        assert!(!valid_account_id("../default"));
        assert!(!valid_account_id("default/../../x"));
        assert!(!valid_account_id(""));
    }

    #[test]
    fn message_token_matches_both_whatsapp_id_shapes() {
        let web = "3EB0".to_string() + &"A".repeat(18);
        let group = format!("false_15551212@c.us_{web}_5511999@c.us");
        assert_eq!(message_token(&group), web);
        let android = "D".repeat(32);
        assert_eq!(
            message_token(&format!("true_120363@g.us_{android}")),
            android
        );
        assert_eq!(message_token(&web), web);
        assert_eq!(message_token("123456789@c.us"), "");
        assert_eq!(message_token(&format!("false_not-a-jid_{web}")), "");
    }

    #[test]
    fn adding_the_same_message_updates_the_open_item() {
        let mut file = TodoFile::default();
        let id = format!("false_15551212@c.us_{}", "A".repeat(20));
        add_item(&mut file, draft_message(&id), 1_700_000_000_000).unwrap();
        let mut again = draft_message(&id);
        again.remind_at = Some(1_700_000_100_000);
        again.title = Some("the snippet again".into());
        file.items[0].note = "keep this".into();
        file.items[0].repeat = RepeatRule::Weekly;
        file.items[0].title = "call about the invoice".into();
        again.note = Some(String::new());
        again.priority = Some(Priority::Low);
        again.repeat = Some(RepeatRule::None);
        if let Some(msg) = again.message.as_mut() {
            msg.snippet.clear();
            msg.chat_name.clear();
            msg.sender.clear();
            msg.kind = "other".into();
        }
        add_item(&mut file, again, 1_700_000_000_100).unwrap();
        assert_eq!(file.items.len(), 1);
        assert_eq!(file.items[0].title, "call about the invoice");
        assert_eq!(file.items[0].note, "keep this");
        assert_eq!(file.items[0].priority, Priority::High);
        assert_eq!(file.items[0].repeat, RepeatRule::Weekly);
        assert_eq!(file.items[0].remind_at, Some(1_700_000_100_000));
        assert!(!file.items[0].fired);
        let linked = file.items[0].message.as_ref().unwrap();
        assert_eq!(linked.snippet, "please send the file");
        assert_eq!(linked.chat_name, "Ada");
        assert_eq!(linked.sender, "Ada");
        assert_eq!(linked.kind, "text");
        assert_eq!(
            file.items[0].message.as_ref().unwrap().chat_id.as_deref(),
            Some("15551212@c.us")
        );
    }

    #[test]
    fn a_bare_id_never_replaces_the_compound_link() {
        let bare = format!("false_15551212@c.us_{}", "A".repeat(20));
        let token = message_token(&bare);
        let mut compound = message(&bare);
        compound.chat_id = chat_from_compound(&bare);
        let merged = merge_message(compound, message(&token));
        assert_eq!(merged.msg_id, bare);
        assert_eq!(merged.chat_id.as_deref(), Some("15551212@c.us"));
        let filled = merge_message(message(&token), message(&bare));
        assert_eq!(filled.msg_id, bare);
    }

    #[test]
    fn a_full_list_rejects_a_new_manual_task() {
        let mut file = TodoFile::default();
        for n in 0..MAX_TODOS {
            add_item(
                &mut file,
                TodoDraft {
                    title: Some(format!("task {n}")),
                    note: None,
                    priority: None,
                    due_at: None,
                    remind_at: None,
                    repeat: None,
                    message: None,
                    kind: None,
                },
                1_700_000_000_000 + n as u64,
            )
            .unwrap();
        }
        let err = add_item(
            &mut file,
            TodoDraft {
                title: Some("one more".into()),
                note: None,
                priority: None,
                due_at: None,
                remind_at: None,
                repeat: None,
                message: None,
                kind: None,
            },
            1_800_000_000_000,
        );
        assert_eq!(err, Err(EditError::Full));
        assert_eq!(file.items.len(), MAX_TODOS);
    }

    #[test]
    fn snooze_overrides_the_reminder_and_dismiss_advances_a_week() {
        let mut item = TodoItem {
            id: "todo-1-1".into(),
            title: "call".into(),
            note: String::new(),
            message: None,
            priority: Priority::Normal,
            due_at: None,
            remind_at: Some(1_700_000_000_000),
            snooze_until: None,
            repeat: RepeatRule::Weekly,
            fired: true,
            done: false,
            created_at: 1_700_000_000_000,
            completed_at: None,
            kind: ItemKind::Task,
        };
        let later = 1_700_000_000_000 + 10 * DAY_MS;
        item.snooze_until = Some(later);
        item.fired = false;
        assert_eq!(effective_remind_at(&item), Some(later));
        let now = 1_700_000_000_000 + 15 * DAY_MS;
        dismiss_alarm(&mut item, now);
        assert_eq!(item.snooze_until, None);
        assert!(!item.fired);
        assert_eq!(item.remind_at, Some(1_700_000_000_000 + 21 * DAY_MS));
    }

    #[test]
    fn dismissing_a_one_shot_reminder_clears_it() {
        let mut item = TodoItem {
            id: "todo-2-2".into(),
            title: "call".into(),
            note: String::new(),
            message: None,
            priority: Priority::Low,
            due_at: Some(1_700_000_000_000),
            remind_at: Some(1_700_000_000_000),
            snooze_until: Some(1_700_000_060_000),
            repeat: RepeatRule::None,
            fired: true,
            done: false,
            created_at: 1,
            completed_at: None,
            kind: ItemKind::Task,
        };
        dismiss_alarm(&mut item, 1_700_000_100_000);
        assert_eq!(item.remind_at, None);
        assert_eq!(item.snooze_until, None);
        assert!(item.fired);
        assert_eq!(item.due_at, Some(1_700_000_000_000));
        let snapshot = snapshot_of(
            &TodoFile {
                next_seq: 2,
                items: vec![item],
            },
            1_700_000_100_000,
            0,
        );
        assert!(snapshot.alarms.is_empty());
    }

    #[test]
    fn repeat_skips_days_spent_offline_instead_of_catching_up_one_by_one() {
        let start = 1_700_000_000_000;
        let now = start + 15 * DAY_MS;
        assert_eq!(
            advance(start, now, RepeatRule::Daily),
            Some(start + 16 * DAY_MS)
        );
        assert_eq!(
            advance(start, start, RepeatRule::Daily),
            Some(start + DAY_MS)
        );
        assert_eq!(advance(start, now, RepeatRule::None), None);
    }

    #[test]
    fn local_day_start_follows_the_offset() {
        let hour = 3_600_000;
        let now = DAY_MS + hour;
        assert_eq!(day_start(now, 0), DAY_MS);
        assert_eq!(day_start(now, -60), now);
        assert_eq!(day_start(now, 60), DAY_MS - hour);
    }

    #[test]
    fn counts_split_overdue_and_today_and_a_fired_alarm() {
        let start = day_start(1_700_000_360_000, 0);
        let mut file = TodoFile::default();
        add_item(
            &mut file,
            TodoDraft {
                title: Some("late".into()),
                note: None,
                priority: None,
                due_at: Some(start - DAY_MS),
                remind_at: Some(start - 1_000),
                repeat: None,
                message: None,
                kind: None,
            },
            start - DAY_MS,
        )
        .unwrap();
        add_item(
            &mut file,
            TodoDraft {
                title: Some("today".into()),
                note: None,
                priority: None,
                due_at: Some(start + 1_000),
                remind_at: None,
                repeat: None,
                message: None,
                kind: None,
            },
            start,
        )
        .unwrap();
        file.items[0].fired = true;
        let snapshot = snapshot_of(&file, start + 1_000, 0);
        assert_eq!(snapshot.overdue_count, 1);
        assert_eq!(snapshot.today_count, 1);
        assert_eq!(snapshot.open_count, 2);
        assert_eq!(snapshot.alarms.len(), 1);
        assert_eq!(snapshot.alarms[0].title, "late");
    }

    #[test]
    fn a_corrupt_file_is_kept_beside_an_empty_list() {
        let dir = scratch("corrupt");
        let path = dir.join("default.json");
        std::fs::write(&path, b"{not json").unwrap();
        let file = read_file(&path);
        assert!(file.items.is_empty());
        assert!(dir.join("default.json.corrupt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn round_trip_keeps_a_message_link() {
        let dir = scratch("round");
        let path = dir.join("acct-3.json");
        let mut file = TodoFile::default();
        let id = format!("true_120363@g.us_{}", "B".repeat(20));
        add_item(&mut file, draft_message(&id), 1_700_000_000_000).unwrap();
        write_file(&path, &file).unwrap();
        let loaded = read_file(&path);
        assert_eq!(loaded.items.len(), 1);
        assert_eq!(loaded.items[0].message.as_ref().unwrap().msg_id, id);
        assert_eq!(loaded.items[0].priority, Priority::High);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn control_characters_and_huge_notes_are_cut() {
        let mut file = TodoFile::default();
        add_item(
            &mut file,
            TodoDraft {
                title: Some("hello\u{0000} there".into()),
                note: Some("x".repeat(5_000)),
                priority: None,
                due_at: None,
                remind_at: Some(10),
                repeat: None,
                message: None,
                kind: None,
            },
            1_700_000_000_000,
        )
        .unwrap_err();
        add_item(
            &mut file,
            TodoDraft {
                title: Some("hello\u{0000} there".into()),
                note: Some(format!("{}\n{}", "x".repeat(5_000), "kept")),
                priority: None,
                due_at: None,
                remind_at: None,
                repeat: None,
                message: None,
                kind: None,
            },
            1_700_000_000_000,
        )
        .unwrap();
        assert_eq!(file.items[0].title, "hello there");
        assert_eq!(file.items[0].note.chars().count(), 4_000);
        assert!(!file.items[0].note.contains('\u{0000}'));
    }

    #[test]
    fn an_old_file_without_kind_loads_as_tasks() {
        let raw = r#"{"next_seq":1,"items":[{"id":"todo-1-1","title":"call","created_at":1700000000000}]}"#;
        let file: TodoFile = serde_json::from_str(raw).unwrap();
        assert_eq!(file.items[0].kind, ItemKind::Task);
        assert!(file.items[0].message.is_none());
    }

    #[test]
    fn a_watch_and_a_task_on_one_message_stay_separate() {
        let mut file = TodoFile::default();
        let id = format!("false_15551212@c.us_{}", "A".repeat(20));
        add_item(&mut file, draft_message(&id), 1_700_000_000_000).unwrap();
        let mut watch = draft_message(&id);
        watch.kind = Some(ItemKind::Waiting);
        watch.priority = Some(Priority::Low);
        watch.due_at = Some(1_700_000_500_000);
        watch.repeat = Some(RepeatRule::Daily);
        add_item(&mut file, watch, 1_700_000_000_100).unwrap();
        assert_eq!(file.items.len(), 2);
        assert_eq!(file.items[0].kind, ItemKind::Task);
        assert_eq!(file.items[1].kind, ItemKind::Waiting);
        assert_eq!(file.items[1].priority, Priority::Normal);
        assert_eq!(file.items[1].due_at, None);
        assert_eq!(file.items[1].repeat, RepeatRule::None);
        assert_eq!(
            file.items[1].message.as_ref().unwrap().chat_id.as_deref(),
            Some("15551212@c.us")
        );
    }

    #[test]
    fn marking_the_other_kind_switches_the_open_watch() {
        let mut file = TodoFile::default();
        let id = format!("true_15551212@c.us_{}", "B".repeat(20));
        let mut waiting = draft_message(&id);
        waiting.kind = Some(ItemKind::Waiting);
        waiting.remind_at = Some(1_700_000_100_000);
        add_item(&mut file, waiting, 1_700_000_000_000).unwrap();
        file.items[0].title = "keep the question".into();
        let mut owe = draft_message(&id);
        owe.kind = Some(ItemKind::Owe);
        owe.title = Some("ignored".into());
        add_item(&mut file, owe, 1_700_000_000_100).unwrap();
        assert_eq!(file.items.len(), 1);
        assert_eq!(file.items[0].kind, ItemKind::Owe);
        assert_eq!(file.items[0].title, "keep the question");
        assert_eq!(file.items[0].remind_at, Some(1_700_000_100_000));
    }

    #[test]
    fn a_watch_without_a_chat_is_rejected() {
        let mut file = TodoFile::default();
        let mut draft = draft_message(&"C".repeat(20));
        draft.kind = Some(ItemKind::Waiting);
        assert_eq!(
            add_item(&mut file, draft, 1_700_000_000_000),
            Err(EditError::Invalid)
        );
        assert!(file.items.is_empty());
    }

    #[test]
    fn task_counts_and_clear_done_ignore_the_other_kind() {
        let start = day_start(1_700_000_360_000, 0);
        let mut file = TodoFile::default();
        add_item(
            &mut file,
            TodoDraft {
                title: Some("late".into()),
                note: None,
                priority: None,
                due_at: Some(start - DAY_MS),
                remind_at: None,
                repeat: None,
                message: None,
                kind: None,
            },
            start - DAY_MS,
        )
        .unwrap();
        let id = format!("false_15551212@c.us_{}", "D".repeat(20));
        let mut watch = draft_message(&id);
        watch.kind = Some(ItemKind::Owe);
        add_item(&mut file, watch, start).unwrap();
        file.items[0].done = true;
        file.items[1].done = true;
        let other = format!("false_15551212@c.us_{}", "E".repeat(20));
        let mut open_watch = draft_message(&other);
        open_watch.kind = Some(ItemKind::Waiting);
        open_watch.remind_at = Some(start - 1_000);
        add_item(&mut file, open_watch, start).unwrap();
        file.items[2].fired = true;
        let snapshot = snapshot_of(&file, start + 1_000, 0);
        assert_eq!(snapshot.open_count, 0);
        assert_eq!(snapshot.overdue_count, 0);
        assert_eq!(snapshot.reply_open_count, 1);
        assert_eq!(snapshot.alarms.len(), 1);
        assert_eq!(snapshot.alarms[0].kind, ItemKind::Waiting);
        assert_eq!(snapshot.alarms[0].chat_id, "15551212@c.us");
        clear_done(&mut file, false);
        assert_eq!(file.items.len(), 2);
        assert!(file.items.iter().all(|item| item.kind.is_watch()));
        clear_done(&mut file, true);
        assert!(file.items.iter().all(|item| !item.done));
        assert_eq!(file.items.len(), 1);
    }

    #[test]
    fn a_watch_reminder_waits_out_the_unlock_grace() {
        let now = 1_700_000_100_000;
        let id = format!("false_15551212@c.us_{}", "F".repeat(20));
        let mut file = TodoFile::default();
        let mut watch = draft_message(&id);
        watch.kind = Some(ItemKind::Waiting);
        watch.remind_at = Some(now - 1_000);
        add_item(&mut file, watch, now - DAY_MS).unwrap();
        add_item(
            &mut file,
            TodoDraft {
                title: Some("call".into()),
                note: None,
                priority: None,
                due_at: None,
                remind_at: Some(now - 1_000),
                repeat: None,
                message: None,
                kind: None,
            },
            now - DAY_MS,
        )
        .unwrap();
        let held = take_due(&mut file, now, now + UNLOCK_GRACE_MS);
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].kind, ItemKind::Task);
        assert!(!file.items[0].fired);
        assert!(file.items[1].fired);
        let due = take_due(&mut file, now, now);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].kind, ItemKind::Waiting);
        assert_eq!(due[0].chat_id, "15551212@c.us");
    }
}

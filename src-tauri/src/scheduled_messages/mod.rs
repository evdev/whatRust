//! Native scheduling and durable claims for the connected WhatsApp webviews.
mod calendar;
mod store;

use crate::{accounts, integration, lock};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use store::{
    Action, Attachment, Candidate, FileInput, Mode, Outcome, PendingAccount, Review, SaveInput,
    Schedule, Store,
};
use tauri::{AppHandle, Manager, Webview};

const CHUNK: usize = 256 * 1024;
const MAX_FILE: u64 = 100 * 1024 * 1024;
const MAX_TOTAL: u64 = 500 * 1024 * 1024;
const MAX_FILES: usize = 200;
const MAX_TEXT: usize = 256 * 1024;
const MAX_VOICE: u64 = 4 * 1024 * 1024;
const MAX_VOICE_SECONDS: u64 = 120;
const WARM_MS: i64 = 60_000;
const GRACE_MS: i64 = 15_000;
const STAGE_TTL: Duration = Duration::from_secs(15 * 60);
const RELEASE_DELAY: Duration = Duration::from_secs(15);
const FILE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(45);
const ACK_TIMEOUT: Duration = Duration::from_secs(75);
const CLOCK_RECHECK: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Scheduler {
    inner: Mutex<Inner>,
    changed: Condvar,
}

#[derive(Default)]
struct Inner {
    store: Option<Store>,
    app_data: Option<PathBuf>,
    views: HashMap<String, View>,
    stages: HashMap<String, Stage>,
    jobs: HashMap<String, Job>,
    warmed: HashMap<String, Instant>,
    warm_attempts: HashMap<String, i64>,
    reconciled: HashMap<(String, u32), String>,
    started: i64,
    blocked_until: i64,
    unlocked: bool,
    generation: u64,
    notify: bool,
    collect_files: bool,
}

#[derive(Clone)]
struct View {
    session: String,
    identity: Option<String>,
    ready_since: Option<i64>,
}

struct Stage {
    account: String,
    identity: String,
    session: String,
    files: Vec<Attachment>,
    received: Vec<u64>,
    expires: Instant,
}

#[derive(Clone)]
struct Job {
    candidate: Candidate,
    session: String,
    token: String,
    deadline: Instant,
    message_id: Option<String>,
}

#[derive(Serialize)]
struct Dispatch<'a> {
    token: &'a str,
    session_id: &'a str,
    identity: &'a str,
    chat_id: &'a str,
    operation: &'static str,
    kind: &'static str,
    text: &'a str,
    attachment: Option<&'a Attachment>,
    message_id: Option<&'a str>,
}

#[derive(Serialize)]
pub struct Snapshot {
    current_account_id: String,
    schedules: Vec<Schedule>,
    review: Vec<Review>,
    pending_accounts: Vec<PendingAccount>,
    can_send: bool,
}

impl Scheduler {
    fn acquire(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn signal(&self, inner: &mut Inner) {
        inner.generation = inner.generation.wrapping_add(1);
        self.changed.notify_one();
    }
}

impl Inner {
    fn storage(&mut self, app: &AppHandle) -> Result<&mut Store, String> {
        if self.store.is_none() {
            let path = app
                .path()
                .app_data_dir()
                .map_err(|_| "schedule_storage")?
                .join("scheduled-messages");
            fs::create_dir_all(&path).map_err(|_| "schedule_storage")?;
            let store = Store::open(&path.join("schedules.sqlite"))?;
            collect_startup_files(&path, &store)?;
            self.app_data = Some(path);
            self.store = Some(store);
            self.notify = true;
        }
        self.store.as_mut().ok_or_else(|| "schedule_storage".into())
    }

    fn path(&self) -> Result<&Path, String> {
        self.app_data
            .as_deref()
            .ok_or_else(|| "schedule_storage".into())
    }

    fn set_lock(&mut self, unlocked: bool) {
        if self.unlocked != unlocked {
            self.unlocked = unlocked;
            self.blocked_until = now_ms();
            self.notify = true;
        }
    }

    fn matches(&self, job: &Job) -> bool {
        self.current_view(job)
            .is_some_and(|view| view.ready_since.is_some())
    }

    fn current_view(&self, job: &Job) -> Option<&View> {
        self.views.get(&job.candidate.account).filter(|view| {
            view.session == job.session && view.identity.as_deref() == Some(&job.candidate.identity)
        })
    }

    fn user_view(&self, account: &str) -> Result<(&View, &str), String> {
        let view = self.views.get(account).ok_or("account_unavailable")?;
        Ok((view, view.identity.as_deref().ok_or("account_unavailable")?))
    }

    fn drop_stage(&mut self, stage_id: &str) {
        if let Some(stage) = self.stages.remove(stage_id) {
            if let Ok(path) = self.path() {
                for attachment in stage.files {
                    let _ = fs::remove_file(file_path(path, &attachment.id));
                }
            }
        }
    }

    fn settle(&mut self, app: &AppHandle, job: &Job, outcome: Outcome) -> Result<(), String> {
        self.storage(app)?
            .finish(&job.candidate, outcome, job.message_id.is_some())?;
        let operation = if job.candidate.reconciliation {
            "reconciliation"
        } else {
            "delivery"
        };
        crate::dlog::log(&format!(
            "scheduler: {operation} {outcome:?}, prepared={}",
            job.message_id.is_some()
        ));
        self.jobs.remove(&job.candidate.account);
        self.notify = true;
        self.collect_files = true;
        Ok(())
    }
}

pub fn start(app: AppHandle) {
    let state = app.state::<Scheduler>();
    {
        let mut inner = state.acquire();
        if inner.started != 0 {
            return;
        }
        inner.started = now_ms();
        inner.blocked_until = inner.started;
        inner.unlocked = lock::is_unlocked(&app);
    }
    std::thread::spawn(move || run(app));
}

pub fn wake(app: &AppHandle) {
    let Some(state) = app.try_state::<Scheduler>() else {
        return;
    };
    let mut inner = state.acquire();
    inner.set_lock(lock::is_unlocked(app));
    state.signal(&mut inner);
}

pub fn forget_view(app: &AppHandle, label: &str) {
    let (Some(state), Some(account)) =
        (app.try_state::<Scheduler>(), accounts::id_from_label(label))
    else {
        return;
    };
    let mut inner = state.acquire();
    if inner.views.remove(account).is_some() {
        state.signal(&mut inner);
    }
}

pub fn remove_account(app: &AppHandle, account: &str) {
    let Some(state) = app.try_state::<Scheduler>() else {
        return;
    };
    let mut inner = state.acquire();
    inner.views.remove(account);
    inner.jobs.remove(account);
    inner.warmed.remove(account);
    inner.warm_attempts.remove(account);
    if inner
        .storage(app)
        .and_then(|store| store.remove_account(account))
        .is_err()
    {
        crate::dlog::log("scheduler: could not delete removed account data");
    }
    inner.notify = true;
    inner.collect_files = true;
    state.signal(&mut inner);
}

fn run(app: AppHandle) {
    let state = app.state::<Scheduler>();
    let mut last_wall = now_ms();
    let mut last_mono = Instant::now();
    loop {
        let (generation, wait, opened, closed, jobs, notify) = {
            let mut inner = state.acquire();
            let now = now_ms();
            let mono = Instant::now();
            // A resumed clock or wall clock adjustment invalidates overdue
            // automatic sends. The deadline check also catches large late wakes
            // on platforms whose monotonic clock includes suspend.
            let elapsed = mono.duration_since(last_mono).as_millis() as i64;
            if now.saturating_sub(last_wall).abs_diff(elapsed) > 2_000 {
                inner.blocked_until = now;
            }
            last_wall = now;
            last_mono = mono;
            inner.set_lock(lock::is_unlocked(&app));
            match tick(&app, &mut inner, now, mono) {
                Ok(Tick {
                    wait,
                    opened,
                    closed,
                    jobs,
                    notify,
                }) => (inner.generation, wait, opened, closed, jobs, notify),
                Err(_) => {
                    crate::dlog::log("scheduler: could not process a scheduled message");
                    (
                        inner.generation,
                        Some(Duration::from_secs(10)),
                        vec![],
                        vec![],
                        vec![],
                        false,
                    )
                }
            }
        };

        for job in jobs {
            if evaluate(&app, &job).is_err() {
                let mut inner = state.acquire();
                if inner
                    .jobs
                    .get(&job.candidate.account)
                    .is_some_and(|current| current.token == job.token)
                {
                    let _ = inner.settle(&app, &job, Outcome::Unavailable);
                    state.signal(&mut inner);
                }
            }
        }
        for account in opened {
            let owns_view =
                lock::is_unlocked(&app) && crate::window::scheduler_open_account(&app, &account);
            if owns_view {
                let mut inner = state.acquire();
                inner.warmed.insert(account, Instant::now() + RELEASE_DELAY);
                state.signal(&mut inner);
            }
        }
        for account in closed {
            crate::window::scheduler_release_account(&app, &account);
        }
        if notify {
            for (label, view) in app.webviews() {
                if accounts::id_from_label(&label).is_some() && integration::remote(&view).is_ok() {
                    let _ = view.eval("window.__wrScheduleChanged && window.__wrScheduleChanged()");
                }
            }
        }

        // An IPC or account event might have arrived while evaluating webviews.
        // Observe its generation before sleeping so that wake cannot be lost.
        let inner = state.acquire();
        if inner.generation != generation {
            continue;
        }
        if let Some(wait) = wait {
            let _result = state.changed.wait_timeout(inner, wait);
        } else {
            let _result = state.changed.wait(inner);
        }
    }
}

struct Tick {
    wait: Option<Duration>,
    opened: Vec<String>,
    closed: Vec<String>,
    jobs: Vec<Job>,
    notify: bool,
}

fn tick(app: &AppHandle, inner: &mut Inner, now: i64, mono: Instant) -> Result<Tick, String> {
    inner.storage(app)?;
    let stale_stages: Vec<_> = inner
        .stages
        .iter()
        .filter_map(|(id, stage)| {
            let stale = stage.expires <= mono
                || !inner.unlocked
                || inner.views.get(&stage.account).is_none_or(|view| {
                    view.session != stage.session
                        || view.identity.as_deref() != Some(&stage.identity)
                });
            stale.then_some(id.clone())
        })
        .collect();
    for id in stale_stages {
        inner.drop_stage(&id);
    }

    let stale_jobs: Vec<_> = inner
        .jobs
        .values()
        .filter(|job| {
            job.deadline <= mono
                || inner.current_view(job).is_none()
                || (job.message_id.is_none()
                    && (!inner.unlocked
                        || !inner.matches(job)
                        || !dispatch_authorized(
                            &job.candidate,
                            now,
                            inner.blocked_until,
                            inner
                                .views
                                .get(&job.candidate.account)
                                .and_then(|view| view.ready_since),
                        )))
        })
        .cloned()
        .collect();
    for job in stale_jobs {
        let outcome = if job.deadline <= mono && inner.matches(&job) {
            if job.message_id.is_some() {
                Outcome::Unknown
            } else {
                Outcome::Rejected
            }
        } else {
            Outcome::Unavailable
        };
        inner.settle(app, &job, outcome)?;
    }

    let views = &inner.views;
    let awake_since = inner.started.max(inner.blocked_until);
    let unlocked = inner.unlocked;
    let store = inner.store.as_mut().ok_or("schedule_storage")?;
    if store.due(now, |account, identity, due| {
        let linked = views
            .get(account)
            .filter(|view| view.identity.as_deref() == Some(identity));
        let reason = if !unlocked {
            "app locked"
        } else if due <= awake_since || now.saturating_sub(due) > GRACE_MS {
            "deadline passed while unavailable"
        } else if linked.is_none() {
            "linked session unavailable"
        } else if !linked
            .and_then(|view| view.ready_since)
            .is_some_and(|since| since <= due)
        {
            "WhatsApp connection not ready at deadline"
        } else {
            return true;
        };
        // No recipient, content, or account identifiers go into diagnostics.
        crate::dlog::log(&format!("scheduler: moved to review, {reason}"));
        false
    })? {
        inner.notify = true;
        inner.collect_files = true;
    }
    let deadlines = store.deadlines()?;
    let candidates = store.candidates()?;

    let uncertain: HashSet<_> = candidates
        .iter()
        .filter(|candidate| candidate.reconciliation)
        .map(|candidate| (candidate.occurrence_id.clone(), candidate.position))
        .collect();
    inner.reconciled.retain(|part, _| uncertain.contains(part));

    let mut jobs = vec![];
    for candidate in candidates {
        if inner.jobs.contains_key(&candidate.account) {
            continue;
        }
        let session = inner
            .views
            .get(&candidate.account)
            .filter(|view| {
                unlocked
                    && view.identity.as_deref() == Some(&candidate.identity)
                    && dispatch_allowed(&candidate, now, awake_since, view.ready_since)
            })
            .map(|view| view.session.clone());
        let Some(session) = session else {
            if !candidate.reconciliation {
                inner
                    .storage(app)?
                    .finish(&candidate, Outcome::Unavailable, false)?;
                inner.notify = true;
                inner.collect_files = true;
            }
            continue;
        };
        if candidate.reconciliation {
            let part = (candidate.occurrence_id.clone(), candidate.position);
            if inner.reconciled.contains_key(&part) {
                continue;
            }
            inner.reconciled.insert(part, candidate.account.clone());
        }
        let job = Job {
            session,
            token: new_id()?,
            deadline: mono
                + if candidate.reconciliation {
                    ACK_TIMEOUT
                } else {
                    DELIVERY_TIMEOUT
                },
            message_id: candidate.message_id.clone(),
            candidate,
        };
        inner.storage(app)?.dispatch(&job.candidate)?;
        inner
            .jobs
            .insert(job.candidate.account.clone(), job.clone());
        jobs.push(job);
    }

    if std::mem::take(&mut inner.collect_files) {
        let stale_files = inner.storage(app)?.take_unreferenced()?;
        let path = inner.path()?;
        for id in stale_files {
            let _ = fs::remove_file(file_path(path, &id));
        }
    }

    let mut opened = vec![];
    let mut next_wall = None;
    let mut busy = HashSet::new();
    inner
        .warm_attempts
        .retain(|profile, _| deadlines.iter().any(|(account, _)| account == profile));
    for (account, due) in deadlines {
        earlier(&mut next_wall, due);
        if unlocked && due - now <= WARM_MS {
            busy.insert(account.clone());
        }
        if unlocked
            && inner.warm_attempts.get(&account) != Some(&due)
            && app.get_webview(&accounts::window_label(&account)).is_none()
        {
            let warm = due - WARM_MS;
            if warm <= now {
                inner.warm_attempts.insert(account.clone(), due);
                opened.push(account);
            } else {
                earlier(&mut next_wall, warm);
            }
        }
    }

    let mut closed = vec![];
    let mut next_mono = None;
    for (account, release) in &mut inner.warmed {
        if busy.contains(account) || inner.jobs.contains_key(account) {
            *release = mono + RELEASE_DELAY;
        } else if *release <= mono {
            closed.push(account.clone());
        } else {
            earlier(&mut next_mono, *release);
        }
    }
    for account in &closed {
        inner.warmed.remove(account);
    }
    for job in inner.jobs.values() {
        earlier(&mut next_mono, job.deadline);
    }
    for stage in inner.stages.values() {
        earlier(&mut next_mono, stage.expires);
    }
    let next_clock = next_wall
        .map(|due| Duration::from_millis(due.saturating_sub(now).max(0) as u64).min(CLOCK_RECHECK));
    let next_timer = next_mono.map(|due| due.saturating_duration_since(mono));
    let wait = match (next_clock, next_timer) {
        (Some(clock), Some(timer)) => Some(clock.min(timer)),
        (clock, timer) => clock.or(timer),
    };
    Ok(Tick {
        wait,
        opened,
        closed,
        jobs,
        notify: std::mem::take(&mut inner.notify),
    })
}

fn earlier<T: Ord + Copy>(date: &mut Option<T>, value: T) {
    *date = Some(date.map_or(value, |current| value.min(current)));
}

fn dispatch_allowed(
    candidate: &Candidate,
    now: i64,
    awake_since: i64,
    ready_since: Option<i64>,
) -> bool {
    dispatch_authorized(candidate, now, awake_since, ready_since)
        && (candidate.reconciliation
            || candidate.approved_at.is_some()
            || candidate.partially_sent
            || now.saturating_sub(candidate.due_ms) <= GRACE_MS)
}

fn dispatch_authorized(
    candidate: &Candidate,
    now: i64,
    awake_since: i64,
    ready_since: Option<i64>,
) -> bool {
    let Some(ready_since) = ready_since else {
        return false;
    };
    if candidate.reconciliation {
        return true;
    }
    let approved = candidate.approved_at.unwrap_or(candidate.due_ms);
    approved <= now
        && ready_since <= approved
        && match candidate.approved_at {
            Some(_) => approved >= awake_since,
            None => approved > awake_since,
        }
}

fn evaluate(app: &AppHandle, job: &Job) -> Result<(), String> {
    lock::require_unlocked(app)?;
    let view = app
        .get_webview(&accounts::window_label(&job.candidate.account))
        .ok_or("account_unavailable")?;
    integration::remote(&view)?;
    let candidate = &job.candidate;
    let request = Dispatch {
        token: &job.token,
        session_id: &job.session,
        identity: &candidate.identity,
        chat_id: &candidate.chat_id,
        operation: if candidate.reconciliation {
            "reconcile"
        } else {
            "send"
        },
        kind: if candidate.attachment.is_some() {
            "file"
        } else {
            "text"
        },
        text: &candidate.text,
        attachment: candidate.attachment.as_ref(),
        message_id: job.message_id.as_deref(),
    };
    let json = serde_json::to_string(&request).map_err(|_| "invalid_schedule")?;
    view.eval(format!(
        "if (location.origin === 'https://web.whatsapp.com' && !window.__whatrustLocked) window.__wrScheduleDeliver?.({json});"
    ))
    .map_err(|_| "account_unavailable".into())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_id() -> Result<String, String> {
    use std::fmt::Write;
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "schedule_unavailable")?;
    let mut id = String::with_capacity(32);
    for byte in bytes {
        let _ = write!(id, "{byte:02x}");
    }
    Ok(id)
}

fn file_path(path: &Path, id: &str) -> PathBuf {
    path.join("files").join(format!("{id}.bin"))
}

fn collect_startup_files(path: &Path, store: &Store) -> Result<(), String> {
    for id in store.take_unreferenced()? {
        let _ = fs::remove_file(file_path(path, &id));
    }
    let files = path.join("files");
    if !files.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(files)
        .map_err(|_| "schedule_storage")?
        .flatten()
    {
        let path = entry.path();
        let Some(id) = path.file_stem().and_then(|id| id.to_str()) else {
            continue;
        };
        if path.extension().is_some_and(|extension| extension == "bin")
            && !store.has_attachment(id)?
        {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

fn account(app: &AppHandle, window: &Webview) -> Result<String, String> {
    integration::remote(window)?;
    let id = accounts::id_from_label(window.label())
        .filter(|id| crate::todo::valid_account_id(id))
        .ok_or("forbidden")?;
    if !accounts::load(app)
        .accounts
        .iter()
        .any(|account| account.id == id)
    {
        return Err("forbidden".into());
    }
    Ok(id.into())
}

fn auth(app: &AppHandle, window: &Webview) -> Result<String, String> {
    lock::require_unlocked(app)?;
    account(app, window)
}

fn identity_valid(identity: &str) -> bool {
    identity.split_once('@').is_some_and(|(number, realm)| {
        !number.is_empty()
            && number.len() <= 32
            && number.bytes().all(|byte| byte.is_ascii_digit())
            && matches!(realm, "c.us" | "s.whatsapp.net" | "lid")
    })
}

fn chat_valid(chat: &str) -> bool {
    chat.split_once('@').is_some_and(|(number, realm)| {
        !number.is_empty()
            && number.len() <= 64
            && number
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (realm == "g.us" && byte == b'-'))
            && matches!(realm, "c.us" | "s.whatsapp.net" | "lid" | "g.us")
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn schedule_report(
    window: Webview,
    app: AppHandle,
    session_id: String,
    identity: Option<String>,
    ready: bool,
) -> Result<(), String> {
    let account = account(&app, &window)?;
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || identity
            .as_deref()
            .is_some_and(|identity| !identity_valid(identity))
        || (ready && identity.is_none())
    {
        return Err("invalid_session".into());
    }
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    let view = inner.views.get(&account);
    let same = view.is_some_and(|view| view.session == session_id && view.identity == identity);
    if same && view.is_some_and(|view| view.ready_since.is_some() == ready) {
        return Ok(());
    }
    inner.views.insert(
        account.clone(),
        View {
            session: session_id,
            identity,
            ready_since: ready.then(now_ms),
        },
    );
    inner.reconciled.retain(|_, profile| profile != &account);
    inner.notify = true;
    state.signal(&mut inner);
    Ok(())
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn schedule_snapshot(window: Webview, app: AppHandle) -> Result<Snapshot, String> {
    let account = auth(&app, &window)?;
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    lock::require_unlocked(&app)?;
    let view = inner.views.get(&account);
    let can_send = view.is_some_and(|view| view.ready_since.is_some());
    let identity = view.and_then(|view| view.identity.clone());
    let store = inner.storage(&app)?;
    let (schedules, review) = if let Some(identity) = identity {
        (
            store.schedules(&account, &identity)?,
            store.review(&account, &identity)?,
        )
    } else {
        (vec![], vec![])
    };
    let mut pending_accounts = store.pending_accounts()?;
    pending_accounts.retain(|pending| pending.account_id != account);
    if !review.is_empty() {
        pending_accounts.push(PendingAccount {
            account_id: account.clone(),
            count: review.len() as u32,
        });
    }
    Ok(Snapshot {
        current_account_id: account,
        schedules,
        review,
        pending_accounts,
        can_send,
    })
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn schedule_save(window: Webview, app: AppHandle, input: SaveInput) -> Result<(), String> {
    let profile_guard = accounts::lock_mutations();
    let account = auth(&app, &window)?;
    if !chat_valid(&input.chat_id)
        || input.chat_name.len() > 1024
        || input.text.len() > MAX_TEXT
        || input.keep_attachment_ids.len() > MAX_FILES
    {
        return Err("invalid_message".into());
    }
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    lock::require_unlocked(&app)?;
    let (view, identity) = inner.user_view(&account)?;
    let mut attachments = vec![];
    if let Some(id) = &input.stage_id {
        let stage = inner
            .stages
            .get(id)
            .filter(|stage| {
                stage.account == account
                    && stage.identity == identity
                    && stage.session == view.session
                    && stage.expires > Instant::now()
            })
            .ok_or("attachment_stage_expired")?;
        let path = inner.path()?;
        for (attachment, received) in stage.files.iter().zip(&stage.received) {
            let path = file_path(path, &attachment.id);
            if *received != attachment.file.size {
                return Err("attachment_incomplete".into());
            }
            let file = OpenOptions::new()
                .write(true)
                .open(path)
                .map_err(|_| "attachment_storage")?;
            if file.metadata().map_err(|_| "attachment_storage")?.len() != *received {
                return Err("attachment_incomplete".into());
            }
            file.sync_all().map_err(|_| "attachment_storage")?;
        }
        #[cfg(unix)]
        File::open(path.join("files"))
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "attachment_storage")?;
        attachments = prepare_staged_files(path, stage)?;
    }
    let identity = identity.to_owned();
    let saved = inner
        .storage(&app)
        .and_then(|store| store.save(&account, &identity, &input, &attachments, now_ms()));
    if saved.is_err() {
        // Keep original upload bytes and sizes intact for a transaction retry.
        if let Some(stage) = input.stage_id.as_ref().and_then(|id| inner.stages.get(id)) {
            for attachment in &attachments {
                if !stage
                    .files
                    .iter()
                    .any(|original| original.id == attachment.id)
                {
                    let _ = fs::remove_file(file_path(inner.path()?, &attachment.id));
                }
            }
        }
        state.signal(&mut inner);
        return saved;
    }
    if let Some(id) = input.stage_id {
        if let Some(stage) = inner.stages.remove(&id) {
            for original in stage.files {
                if !attachments.iter().any(|saved| saved.id == original.id) {
                    let _ = fs::remove_file(file_path(inner.path()?, &original.id));
                }
            }
        }
    }
    inner.notify = true;
    inner.collect_files = true;
    state.signal(&mut inner);
    drop(profile_guard);
    Ok(())
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn schedule_cancel(
    window: Webview,
    app: AppHandle,
    id: String,
    revision: u32,
) -> Result<(), String> {
    let account = auth(&app, &window)?;
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    lock::require_unlocked(&app)?;
    let identity = inner.user_view(&account)?.1.to_owned();
    if inner
        .jobs
        .get(&account)
        .is_some_and(|job| job.candidate.schedule_id == id)
    {
        return Err("delivery_in_progress".into());
    }
    inner
        .storage(&app)?
        .cancel(&account, &identity, &id, revision)?;
    inner.notify = true;
    inner.collect_files = true;
    state.signal(&mut inner);
    Ok(())
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn schedule_decide(
    window: Webview,
    app: AppHandle,
    occurrence_id: String,
    action: Action,
) -> Result<(), String> {
    let account = auth(&app, &window)?;
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    lock::require_unlocked(&app)?;
    let (view, identity) = inner.user_view(&account)?;
    let identity = identity.to_owned();
    let ready = view.ready_since.is_some();
    if inner
        .jobs
        .get(&account)
        .is_some_and(|job| job.candidate.occurrence_id == occurrence_id)
    {
        return Err("delivery_in_progress".into());
    }
    inner
        .storage(&app)?
        .decide(&account, &identity, &occurrence_id, action, ready, now_ms())?;
    inner.notify = true;
    inner.collect_files = true;
    state.signal(&mut inner);
    Ok(())
}

fn valid_voice_stage(files: &[FileInput]) -> bool {
    !files.iter().any(|file| matches!(file.mode, Mode::Voice))
        || (files.len() == 1
            && files[0].name == "voice-note.wav"
            && files[0].mime == "audio/wav"
            && files[0].caption.is_empty()
            && files[0].size > 0
            && files[0].size <= MAX_VOICE)
}

// Bound duration before the encoder allocates or resamples PCM. Reject
// truncated chunks and partial frames rather than persisting repaired audio.
fn validate_voice_wav(data: &[u8]) -> Result<(), String> {
    let invalid = || "invalid_voice_message".to_owned();
    if data.len() < 44
        || data.len() as u64 > MAX_VOICE
        || &data[..4] != b"RIFF"
        || &data[8..12] != b"WAVE"
        || u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize + 8 != data.len()
    {
        return Err(invalid());
    }
    let mut offset = 12usize;
    let mut format = None;
    let mut audio = None;
    while offset + 8 <= data.len() {
        let len = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(len)
            .filter(|end| *end <= data.len())
            .ok_or_else(invalid)?;
        match &data[offset..offset + 4] {
            b"fmt " if format.is_none() && len >= 16 => {
                let pcm = u16::from_le_bytes(data[start..start + 2].try_into().unwrap());
                let channels = u16::from_le_bytes(data[start + 2..start + 4].try_into().unwrap());
                let rate = u32::from_le_bytes(data[start + 4..start + 8].try_into().unwrap());
                let bits = u16::from_le_bytes(data[start + 14..start + 16].try_into().unwrap());
                if pcm != 1
                    || bits != 16
                    || !(1..=2).contains(&channels)
                    || !(8000..=192000).contains(&rate)
                {
                    return Err(invalid());
                }
                format = Some((u64::from(rate), u64::from(channels) * 2));
            }
            b"data" if audio.is_none() => audio = Some(len as u64),
            b"fmt " | b"data" => return Err(invalid()),
            _ => {}
        }
        offset = end
            .checked_add(len & 1)
            .filter(|end| *end <= data.len())
            .ok_or_else(invalid)?;
    }
    let (rate, frame) = format.ok_or_else(invalid)?;
    let len = audio.ok_or_else(invalid)?;
    if offset != data.len()
        || len == 0
        || len % frame != 0
        || len / frame > rate * MAX_VOICE_SECONDS
    {
        return Err(invalid());
    }
    Ok(())
}

fn prepare_staged_files(path: &Path, stage: &Stage) -> Result<Vec<Attachment>, String> {
    if !stage
        .files
        .iter()
        .any(|a| matches!(a.file.mode, Mode::Voice))
    {
        return Ok(stage.files.clone());
    }
    if !valid_voice_stage(
        &stage
            .files
            .iter()
            .map(|a| a.file.clone())
            .collect::<Vec<_>>(),
    ) {
        return Err("invalid_voice_message".into());
    }
    let wav = fs::read(file_path(path, &stage.files[0].id)).map_err(|_| "attachment_storage")?;
    validate_voice_wav(&wav)?;
    let ogg = crate::voice_ogg::ogg_opus_from_wav(&wav).map_err(|_| "invalid_voice_message")?;
    if ogg.is_empty() || ogg.len() as u64 > MAX_VOICE {
        return Err("invalid_voice_message".into());
    }
    let id = new_id()?;
    let target = file_path(path, &id);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|_| "attachment_storage")?;
    let write = (|| -> std::io::Result<()> {
        file.write_all(&ogg)?;
        file.sync_all()?;
        #[cfg(unix)]
        File::open(path.join("files"))?.sync_all()?;
        Ok(())
    })();
    drop(file);
    if write.is_err() {
        let _ = fs::remove_file(target);
        return Err("attachment_storage".into());
    }
    Ok(vec![Attachment {
        id,
        file: FileInput {
            name: "voice-note.ogg".into(),
            mime: "audio/ogg; codecs=opus".into(),
            size: ogg.len() as u64,
            mode: Mode::Voice,
            caption: String::new(),
        },
    }])
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn schedule_stage_begin(
    window: Webview,
    app: AppHandle,
    files: Vec<FileInput>,
) -> Result<String, String> {
    let account = auth(&app, &window)?;
    if !valid_voice_stage(&files)
        || files.is_empty()
        || files.len() > MAX_FILES
        || files.iter().any(|file| {
            file.size == 0
                || file.size > MAX_FILE
                || file.name.is_empty()
                || file.name.len() > 1024
                || file.name.contains(['/', '\\'])
                || file.name.chars().any(char::is_control)
                || file.mime.len() > 256
                || file.mime.chars().any(char::is_control)
                || file.caption.len() > MAX_TEXT
        })
        || files.iter().map(|file| file.size).sum::<u64>() > MAX_TOTAL
    {
        return Err("invalid_attachments".into());
    }
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    lock::require_unlocked(&app)?;
    let (view, identity) = inner.user_view(&account)?;
    let session = view.session.clone();
    let identity = identity.to_owned();
    if inner
        .stages
        .values()
        .filter(|stage| stage.account == account)
        .count()
        >= 2
    {
        return Err("attachment_stage_busy".into());
    }
    inner.storage(&app)?;
    fs::create_dir_all(inner.path()?.join("files")).map_err(|_| "attachment_storage")?;
    let id = new_id()?;
    let received = vec![0; files.len()];
    let files = files
        .into_iter()
        .enumerate()
        .map(|(index, file)| Attachment {
            id: format!("{id}-{index}"),
            file,
        })
        .collect();
    inner.stages.insert(
        id.clone(),
        Stage {
            account,
            identity,
            session,
            files,
            received,
            expires: Instant::now() + STAGE_TTL,
        },
    );
    state.signal(&mut inner);
    Ok(id)
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn schedule_stage_chunk(
    window: Webview,
    app: AppHandle,
    stage_id: String,
    file_index: usize,
    offset: u64,
    data: String,
) -> Result<(), String> {
    let account = auth(&app, &window)?;
    if data.is_empty() || data.len() > CHUNK.div_ceil(3) * 4 {
        return Err("invalid_attachment_chunk".into());
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "invalid_attachment_chunk")?;
    if bytes.is_empty() || bytes.len() > CHUNK {
        return Err("invalid_attachment_chunk".into());
    }
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    lock::require_unlocked(&app)?;
    let (view, identity) = inner.user_view(&account)?;
    let path = inner.path()?.to_owned();
    let session = view.session.clone();
    let identity = identity.to_owned();
    let stage = inner
        .stages
        .get_mut(&stage_id)
        .filter(|stage| {
            stage.account == account
                && stage.identity == identity
                && stage.session == session
                && stage.expires > Instant::now()
        })
        .ok_or("attachment_stage_expired")?;
    let attachment = stage.files.get(file_index).ok_or("invalid_attachment")?;
    let received = stage.received[file_index];
    if offset != received || received + bytes.len() as u64 > attachment.file.size {
        return Err("invalid_attachment_chunk".into());
    }
    let path = file_path(&path, &attachment.id);
    let mut options = OpenOptions::new();
    options.write(true);
    if received == 0 {
        options.create(true).truncate(true);
    }
    let mut file = options.open(path).map_err(|_| "attachment_storage")?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "attachment_storage")?;
    if file.write_all(&bytes).is_err() {
        let _ = file.set_len(offset);
        return Err("attachment_storage".into());
    }
    stage.received[file_index] += bytes.len() as u64;
    stage.expires = Instant::now() + STAGE_TTL;
    Ok(())
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn schedule_stage_discard(
    window: Webview,
    app: AppHandle,
    stage_id: String,
) -> Result<(), String> {
    let account = auth(&app, &window)?;
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    let (view, identity) = inner.user_view(&account)?;
    if inner.stages.get(&stage_id).is_some_and(|stage| {
        stage.account == account && stage.identity == identity && stage.session == view.session
    }) {
        inner.drop_stage(&stage_id);
        state.signal(&mut inner);
    }
    Ok(())
}

fn authorized_job<'a>(inner: &'a Inner, account: &str, token: &str) -> Result<&'a Job, String> {
    inner
        .jobs
        .get(account)
        .filter(|job| job.token == token)
        .ok_or_else(|| "delivery_changed".into())
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn schedule_delivery_chunk(
    window: Webview,
    app: AppHandle,
    token: String,
    offset: u64,
) -> Result<String, String> {
    let account = auth(&app, &window)?;
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    lock::require_unlocked(&app)?;
    let job = authorized_job(&inner, &account, &token)?;
    if !inner.matches(job) || job.candidate.reconciliation || job.message_id.is_some() {
        return Err("delivery_changed".into());
    }
    let attachment = job
        .candidate
        .attachment
        .as_ref()
        .ok_or("invalid_attachment")?;
    if offset >= attachment.file.size || !offset.is_multiple_of(CHUNK as u64) {
        return Err("invalid_attachment_chunk".into());
    }
    let len = (attachment.file.size - offset).min(CHUNK as u64) as usize;
    let path = file_path(inner.path()?, &attachment.id);
    let mut file = File::open(path).map_err(|_| "attachment_storage")?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "attachment_storage")?;
    let mut buffer = vec![0; len];
    file.read_exact(&mut buffer)
        .map_err(|_| "attachment_storage")?;
    if let Some(job) = inner.jobs.get_mut(&account) {
        job.deadline = Instant::now() + DELIVERY_TIMEOUT;
    }
    Ok(STANDARD.encode(buffer))
}

fn valid_message_key(chat_id: &str, key: &str) -> bool {
    key.len() <= 240
        && !key.chars().any(char::is_control)
        && key
            .strip_prefix("true_")
            .and_then(|value| value.split_once('_'))
            .is_some_and(|(chat, message)| chat == chat_id && !message.is_empty())
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn schedule_delivery_prepare(
    window: Webview,
    app: AppHandle,
    token: String,
    message_id: String,
) -> Result<(), String> {
    let account = auth(&app, &window)?;
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    lock::require_unlocked(&app)?;
    let job = authorized_job(&inner, &account, &token)?.clone();
    if job.candidate.reconciliation
        || job.message_id.is_some()
        || !dispatch_authorized(
            &job.candidate,
            now_ms(),
            inner.blocked_until,
            inner.current_view(&job).and_then(|view| view.ready_since),
        )
    {
        return Err("delivery_changed".into());
    }
    if !valid_message_key(&job.candidate.chat_id, &message_id) {
        return Err("invalid_message_key".into());
    }
    inner.storage(&app)?.prepare(&job.candidate, &message_id)?;
    if let Some(job) = inner.jobs.get_mut(&account) {
        job.message_id = Some(message_id);
        job.deadline = Instant::now()
            + if job.candidate.attachment.is_some() {
                FILE_TIMEOUT
            } else {
                ACK_TIMEOUT
            };
    }
    state.signal(&mut inner);
    Ok(())
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn schedule_delivery_result(
    window: Webview,
    app: AppHandle,
    token: String,
    outcome: Outcome,
    message_id: Option<String>,
) -> Result<(), String> {
    let account = account(&app, &window)?;
    let state = app.state::<Scheduler>();
    let mut inner = state.acquire();
    let job = authorized_job(&inner, &account, &token)?.clone();
    let outcome =
        if matches!(outcome, Outcome::Sent | Outcome::Rejected) && job.message_id != message_id {
            if job.message_id.is_some() {
                Outcome::Unknown
            } else {
                Outcome::Rejected
            }
        } else {
            outcome
        };
    inner.settle(&app, &job, outcome)?;
    state.signal(&mut inner);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice_stage(path: &Path) -> Stage {
        fs::create_dir_all(path.join("files")).unwrap();
        let wav = crate::voice_ogg::pcm_wav(&vec![0; 320], 16_000, 1);
        fs::write(file_path(path, "upload"), &wav).unwrap();
        Stage {
            account: "default".into(),
            identity: "111@c.us".into(),
            session: "session".into(),
            files: vec![Attachment {
                id: "upload".into(),
                file: FileInput {
                    name: "voice-note.wav".into(),
                    mime: "audio/wav".into(),
                    size: wav.len() as u64,
                    mode: Mode::Voice,
                    caption: String::new(),
                },
            }],
            received: vec![wav.len() as u64],
            expires: Instant::now() + STAGE_TTL,
        }
    }

    #[test]
    fn voice_staging_accepts_only_one_uncaptioned_bounded_wav() {
        let dir = tempfile::tempdir().unwrap();
        let stage = voice_stage(dir.path());
        let mut files = vec![stage.files[0].file.clone()];
        assert!(valid_voice_stage(&files));
        files[0].caption = "caption".into();
        assert!(!valid_voice_stage(&files));
        files[0].caption.clear();
        files[0].size = MAX_VOICE + 1;
        assert!(!valid_voice_stage(&files));
        files[0].size = 100;
        files.push(files[0].clone());
        assert!(!valid_voice_stage(&files));
    }

    #[test]
    fn voice_wav_duration_and_integrity_are_checked_before_encoding() {
        let short = crate::voice_ogg::pcm_wav(&vec![0; 320], 16_000, 1);
        assert!(validate_voice_wav(&short).is_ok());
        assert!(validate_voice_wav(&short[..short.len() - 1]).is_err());
        assert!(validate_voice_wav(&crate::voice_ogg::pcm_wav(&[], 16_000, 1)).is_err());
        let limit = crate::voice_ogg::pcm_wav(&vec![0; 16_000 * 120], 16_000, 1);
        assert!(validate_voice_wav(&limit).is_ok());
        let too_long = crate::voice_ogg::pcm_wav(&vec![0; 16_000 * 120 + 1], 16_000, 1);
        assert!(validate_voice_wav(&too_long).is_err());
        let mut huge_resample = short.clone();
        huge_resample[24..28].copy_from_slice(&1u32.to_le_bytes());
        assert!(validate_voice_wav(&huge_resample).is_err());
    }

    #[test]
    fn voice_conversion_keeps_stage_retryable_and_restart_collects_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let stage = voice_stage(dir.path());
        let original = fs::read(file_path(dir.path(), "upload")).unwrap();
        let first = prepare_staged_files(dir.path(), &stage).unwrap();
        let input: SaveInput = serde_json::from_value(serde_json::json!({
            "id": null, "revision": null, "chat_id": "222@c.us", "chat_name": "Test",
            "text": "", "local_at": "2030-01-01T09:00", "time_zone": "UTC",
            "repeat": null, "stage_id": "stage", "keep_attachment_ids": [], "first_caption": null
        }))
        .unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();
        store.db.execute_batch("CREATE TRIGGER fail_save BEFORE INSERT ON schedule_file BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        assert!(store
            .save("default", "111@c.us", &input, &first, 0)
            .is_err());
        assert!(store.schedules("default", "111@c.us").unwrap().is_empty());
        assert!(!store.has_attachment(&first[0].id).unwrap());
        store.db.execute_batch("DROP TRIGGER fail_save").unwrap();
        let second = prepare_staged_files(dir.path(), &stage).unwrap();
        assert_ne!(first[0].id, second[0].id);
        assert_eq!(stage.received[0], original.len() as u64);
        assert_eq!(stage.files[0].file.size, original.len() as u64);
        assert_eq!(fs::read(file_path(dir.path(), "upload")).unwrap(), original);
        let ogg = fs::read(file_path(dir.path(), &first[0].id)).unwrap();
        assert!(ogg.starts_with(b"OggS"));
        assert_eq!(first[0].file.size, ogg.len() as u64);
        assert_eq!(first[0].file.mime, "audio/ogg; codecs=opus");
        assert_eq!(first[0].file.name, "voice-note.ogg");
        store
            .save("default", "111@c.us", &input, &second, 0)
            .unwrap();
        drop(store);
        let store = Store::open(&db_path).unwrap();
        collect_startup_files(dir.path(), &store).unwrap();
        assert_eq!(fs::read_dir(dir.path().join("files")).unwrap().count(), 1);
        assert!(!file_path(dir.path(), "upload").exists());
        assert!(!file_path(dir.path(), &first[0].id).exists());
        assert!(fs::read(file_path(dir.path(), &second[0].id))
            .unwrap()
            .starts_with(b"OggS"));
    }

    fn candidate() -> Candidate {
        Candidate {
            occurrence_id: "occurrence".into(),
            schedule_id: "schedule".into(),
            account: "default".into(),
            identity: "12345@c.us".into(),
            chat_id: "4321@c.us".into(),
            text: "hello".into(),
            position: 0,
            attachment: None,
            message_id: None,
            reconciliation: false,
            due_ms: 100_000,
            approved_at: None,
            partially_sent: false,
        }
    }

    #[test]
    fn queued_automatic_sends_do_not_cross_restart_resume_lock_or_reconnect() {
        let mut pending = candidate();
        assert!(dispatch_allowed(&pending, 100_005, 99_000, Some(90_000)));
        assert!(!dispatch_allowed(&pending, 100_005, 100_002, Some(90_000)));
        assert!(!dispatch_allowed(&pending, 100_005, 99_000, Some(100_002)));
        assert!(!dispatch_allowed(&pending, 100_005, 99_000, None));
        assert!(!dispatch_allowed(&pending, 116_000, 99_000, Some(90_000)));
        assert!(!dispatch_allowed(&pending, 99_999, 98_000, Some(90_000)));

        pending.partially_sent = true;
        assert!(dispatch_allowed(&pending, 116_000, 99_000, Some(90_000)));
        assert!(!dispatch_allowed(&pending, 116_000, 101_000, Some(90_000)));
        assert!(!dispatch_allowed(&pending, 116_000, 99_000, Some(101_000)));
    }

    #[test]
    fn manual_review_uses_approval_time_and_reconcile_never_reauthorizes_a_send() {
        let mut pending = candidate();
        pending.approved_at = Some(250_000);
        assert!(dispatch_allowed(&pending, 250_001, 200_000, Some(210_000)));
        assert!(!dispatch_allowed(&pending, 260_001, 200_000, Some(260_000)));
        assert!(!dispatch_allowed(&pending, 260_001, 255_000, Some(210_000)));
        assert!(!dispatch_allowed(&pending, 249_999, 200_000, Some(210_000)));
        assert!(!valid_message_key(
            &pending.chat_id,
            "true_9999@c.us_outgoing"
        ));
        assert!(!valid_message_key(
            &pending.chat_id,
            "false_4321@c.us_incoming"
        ));
        assert!(valid_message_key(
            &pending.chat_id,
            "true_4321@c.us_outgoing"
        ));
    }
}

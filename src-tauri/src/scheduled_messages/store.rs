use super::calendar::{Calendar, Repeat};
use super::new_id;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

const SCHEMA: &str = "
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schedule (
    id TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    identity TEXT NOT NULL,
    revision INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    chat_name TEXT NOT NULL,
    text TEXT NOT NULL,
    local_at TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    repeat TEXT,
    next_due INTEGER,
    next_index INTEGER NOT NULL,
    successful INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedule_deadline ON schedule(next_due) WHERE next_due IS NOT NULL;
CREATE INDEX IF NOT EXISTS schedule_profile ON schedule(profile, identity);
CREATE TABLE IF NOT EXISTS file (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    mode TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_file (
    schedule_id TEXT NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES file(id),
    position INTEGER NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (schedule_id, position)
);
CREATE INDEX IF NOT EXISTS schedule_file_attachment ON schedule_file(file_id);
CREATE TABLE IF NOT EXISTS occurrence (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    chat_name TEXT NOT NULL,
    text TEXT NOT NULL,
    due INTEGER NOT NULL,
    approved_at INTEGER,
    state TEXT NOT NULL CHECK (state IN ('missed','queued','sending','failed','uncertain'))
);
CREATE INDEX IF NOT EXISTS occurrence_schedule ON occurrence(schedule_id, state);
CREATE INDEX IF NOT EXISTS occurrence_state ON occurrence(state, due);
CREATE TABLE IF NOT EXISTS part (
    occurrence_id TEXT NOT NULL REFERENCES occurrence(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    file_id TEXT REFERENCES file(id),
    caption TEXT NOT NULL DEFAULT '',
    message_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending','inflight','acked','failed','unknown')),
    PRIMARY KEY (occurrence_id, position)
);
CREATE INDEX IF NOT EXISTS part_attachment ON part(file_id) WHERE file_id IS NOT NULL;
";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FileInput {
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub mode: Mode,
    #[serde(default)]
    pub caption: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Image,
    Video,
    Document,
}

#[derive(Clone, Debug, Serialize)]
pub struct Attachment {
    pub id: String,
    #[serde(flatten)]
    pub file: FileInput,
}

#[derive(Deserialize)]
pub struct SaveInput {
    pub id: Option<String>,
    pub revision: Option<u32>,
    pub chat_id: String,
    pub chat_name: String,
    pub text: String,
    pub local_at: String,
    pub time_zone: String,
    pub repeat: Option<Repeat>,
    pub stage_id: Option<String>,
    pub keep_attachment_ids: Vec<String>,
    pub first_caption: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Schedule {
    pub id: String,
    pub revision: u32,
    pub chat_id: String,
    pub chat_name: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
    pub local_at: String,
    pub time_zone: String,
    pub repeat: Option<Repeat>,
    pub next_due_ms: Option<i64>,
    pub successful_sends: u32,
}

#[derive(Serialize)]
pub struct Review {
    pub occurrence_id: String,
    pub schedule_id: String,
    pub chat_id: String,
    pub chat_name: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
    pub due_ms: i64,
    pub state: String,
}

#[derive(Serialize)]
pub struct PendingAccount {
    pub account_id: String,
    pub count: u32,
}

#[derive(Clone)]
pub struct Candidate {
    pub occurrence_id: String,
    pub schedule_id: String,
    pub account: String,
    pub identity: String,
    pub chat_id: String,
    pub text: String,
    pub position: u32,
    pub attachment: Option<Attachment>,
    pub message_id: Option<String>,
    pub reconciliation: bool,
    pub due_ms: i64,
    pub approved_at: Option<i64>,
    pub partially_sent: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Sent,
    Rejected,
    Unknown,
    Unavailable,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Send,
    Skip,
    Retry,
}

pub struct Store {
    pub db: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let db = Connection::open(path).map_err(db_error)?;
        db.busy_timeout(Duration::from_secs(3)).map_err(db_error)?;
        db.pragma_update(None, "journal_mode", "WAL")
            .map_err(db_error)?;
        db.pragma_update(None, "synchronous", "FULL")
            .map_err(db_error)?;
        db.execute_batch(SCHEMA).map_err(db_error)?;
        let mut store = Self { db };
        store.migrate_captions()?;
        store.restore()?;
        Ok(store)
    }

    fn migrate_captions(&mut self) -> Result<(), String> {
        // Initial development builds stored one caption with the file bytes.
        let legacy: bool = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('file') WHERE name='caption')",
                [],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !legacy {
            return Ok(());
        }
        let tx = self.db.transaction().map_err(db_error)?;
        tx.execute_batch(
            "ALTER TABLE schedule_file ADD COLUMN caption TEXT NOT NULL DEFAULT '';
             ALTER TABLE part ADD COLUMN caption TEXT NOT NULL DEFAULT '';
             UPDATE schedule_file SET caption=(SELECT caption FROM file WHERE id=schedule_file.file_id);
             UPDATE part SET caption=(SELECT caption FROM file WHERE id=part.file_id) WHERE file_id IS NOT NULL;
             ALTER TABLE file DROP COLUMN caption;",
        ).map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    fn restore(&mut self) -> Result<(), String> {
        let tx = self.db.transaction().map_err(db_error)?;
        tx.execute_batch(
            "UPDATE part SET state = CASE WHEN message_id IS NULL THEN 'pending' ELSE 'unknown' END
             WHERE state = 'inflight';
             UPDATE occurrence SET state = CASE
                WHEN EXISTS(SELECT 1 FROM part WHERE occurrence_id = occurrence.id AND state='unknown')
                THEN 'uncertain'
                WHEN EXISTS(SELECT 1 FROM part WHERE occurrence_id = occurrence.id AND state='acked')
                THEN 'failed'
                ELSE 'missed' END
             WHERE state IN ('queued','sending');
             DELETE FROM occurrence AS older WHERE state='missed' AND EXISTS(
                 SELECT 1 FROM occurrence AS newer WHERE newer.schedule_id=older.schedule_id
                 AND newer.state='missed' AND (newer.due,newer.rowid)>(older.due,older.rowid)
             );",
        ).map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    pub fn save(
        &mut self,
        account: &str,
        identity: &str,
        input: &SaveInput,
        new_attachments: &[Attachment],
        now: i64,
    ) -> Result<(), String> {
        let calendar = Calendar::new(&input.local_at, &input.time_zone, input.repeat.as_ref())?;
        let first_due = calendar.due(0).ok_or("invalid_date")?;
        let tx = self.db.transaction().map_err(db_error)?;
        let (id, revision, next_index, next_due) = if let Some(id) = &input.id {
            let old = lookup(&tx, account, identity, id)?;
            if Some(old.revision) != input.revision || old.next_due_ms.is_none() {
                return Err("schedule_changed".into());
            }
            if old.next_due_ms.is_some_and(|due| due <= now) {
                return Err("schedule_changed".into());
            }
            if old.chat_id != input.chat_id {
                return Err("invalid_chat".into());
            }
            let old_index = tx
                .query_row("SELECT next_index FROM schedule WHERE id=?", [id], |row| {
                    row.get(0)
                })
                .map_err(db_error)?;
            let (index, due) = if old.local_at == input.local_at && old.time_zone == input.time_zone
            {
                let index = calendar.latest_due(0, now).map_or(0, |last| last + 1);
                let index = if same_repeat(old.repeat.as_ref(), input.repeat.as_ref()) {
                    index.max(old_index)
                } else {
                    index
                };
                (index, calendar.due(index))
            } else if first_due > now {
                (0, Some(first_due))
            } else {
                return Err("date_in_past".into());
            };
            if due.is_none() {
                return Err("date_in_past".into());
            }
            if let Some(limit) = input.repeat.as_ref().and_then(|repeat| repeat.max_sends) {
                if old.successful_sends >= limit
                    || old
                        .successful_sends
                        .saturating_add(reserved_sends(&tx, id)?)
                        > limit
                {
                    return Err("invalid_repeat".into());
                }
            }
            (id.clone(), old.revision + 1, index, due)
        } else {
            if first_due <= now {
                return Err("date_in_past".into());
            }
            if input.revision.is_some() || !input.keep_attachment_ids.is_empty() {
                return Err("invalid_schedule".into());
            }
            (new_id()?, 1, 0, Some(first_due))
        };
        let repeat = input
            .repeat
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| "invalid_repeat")?;

        let mut old_files = attachments_for_schedule(&tx, &id)?;
        let mut files = Vec::new();
        for keep in &input.keep_attachment_ids {
            let position = old_files
                .iter()
                .position(|file| &file.id == keep)
                .ok_or("invalid_attachment")?;
            files.push(old_files.remove(position));
        }
        if let Some(caption) = &input.first_caption {
            if input.stage_id.is_some()
                || !new_attachments.is_empty()
                || caption.len() > super::MAX_TEXT
            {
                return Err("invalid_caption".into());
            }
            files
                .first_mut()
                .ok_or("invalid_caption")?
                .file
                .caption
                .clone_from(caption);
        }
        files.extend_from_slice(new_attachments);
        if files.is_empty() && input.text.trim().is_empty() {
            return Err("empty_message".into());
        }
        if !files.is_empty() && !input.text.is_empty() {
            return Err("invalid_caption".into());
        }
        if files.len() > super::MAX_FILES
            || files.iter().map(|file| file.file.size).sum::<u64>() > super::MAX_TOTAL
        {
            return Err("attachments_too_large".into());
        }

        tx.execute(
            "INSERT INTO schedule (id,profile,identity,revision,chat_id,chat_name,text,local_at,time_zone,repeat,next_due,next_index,successful)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)
             ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,chat_name=excluded.chat_name,
                text=excluded.text,local_at=excluded.local_at,time_zone=excluded.time_zone,repeat=excluded.repeat,
                next_due=excluded.next_due,next_index=excluded.next_index",
            params![id, account, identity, revision, input.chat_id, input.chat_name, input.text,
                input.local_at, input.time_zone, repeat, next_due, next_index],
        ).map_err(db_error)?;
        tx.execute("DELETE FROM schedule_file WHERE schedule_id=?", [&id])
            .map_err(db_error)?;
        for attachment in new_attachments {
            let file = &attachment.file;
            tx.execute(
                "INSERT INTO file (id,name,mime,size,mode) VALUES (?,?,?,?,?)",
                params![
                    attachment.id,
                    file.name,
                    file.mime,
                    file.size,
                    file.mode.as_str()
                ],
            )
            .map_err(db_error)?;
        }
        for (position, attachment) in files.iter().enumerate() {
            tx.execute(
                "INSERT INTO schedule_file (schedule_id,file_id,position,caption) VALUES (?,?,?,?)",
                params![id, attachment.id, position, attachment.file.caption],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    }

    pub fn cancel(
        &mut self,
        profile: &str,
        identity: &str,
        id: &str,
        revision: u32,
    ) -> Result<(), String> {
        let tx = self.db.transaction().map_err(db_error)?;
        let schedule = lookup(&tx, profile, identity, id)?;
        if schedule.revision != revision {
            return Err("schedule_changed".into());
        }
        let busy: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM occurrence WHERE schedule_id=? AND state IN ('queued','sending'))",
            [id], |row| row.get(0),
        ).map_err(db_error)?;
        if busy {
            return Err("delivery_in_progress".into());
        }
        tx.execute("DELETE FROM schedule WHERE id=?", [id])
            .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    pub fn decide(
        &mut self,
        account: &str,
        identity: &str,
        id: &str,
        action: Action,
        ready: bool,
        now: i64,
    ) -> Result<(), String> {
        let tx = self.db.transaction().map_err(db_error)?;
        let (schedule_id, state): (String, String) = tx.query_row(
            "SELECT o.schedule_id,o.state FROM occurrence o JOIN schedule s ON s.id=o.schedule_id
             WHERE o.id=? AND s.profile=? AND s.identity=?",
            params![id, account, identity], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(db_error)?.ok_or("schedule_changed")?;
        match (action, state.as_str()) {
            (Action::Skip, "missed" | "failed" | "uncertain") => {
                tx.execute("DELETE FROM occurrence WHERE id=?", [id])
                    .map_err(db_error)?;
                prune_schedule(&tx, &schedule_id)?;
            }
            (Action::Send, "missed") | (Action::Retry, "failed") if ready => {
                let schedule = lookup(&tx, account, identity, &schedule_id)?;
                if !may_queue(&tx, &schedule)? {
                    return Err("repeat_limit_pending".into());
                }
                tx.execute(
                    "UPDATE occurrence SET state='queued',approved_at=? WHERE id=?",
                    params![now, id],
                )
                .map_err(db_error)?;
                tx.execute("UPDATE part SET state='pending',message_id=NULL WHERE occurrence_id=? AND state='failed'", [id]).map_err(db_error)?;
            }
            (Action::Send, "missed") | (Action::Retry, "failed") => {
                return Err("account_unavailable".into())
            }
            _ => return Err("schedule_changed".into()),
        }
        tx.commit().map_err(db_error)
    }

    pub fn schedules(&self, profile: &str, identity: &str) -> Result<Vec<Schedule>, String> {
        let mut query = self.db.prepare(
            "SELECT id,revision,chat_id,chat_name,text,local_at,time_zone,repeat,next_due,successful
             FROM schedule WHERE profile=? AND identity=? ORDER BY next_due IS NULL,next_due,id",
        ).map_err(db_error)?;
        let schedules = query
            .query_map(params![profile, identity], map_schedule)
            .map_err(db_error)?;
        schedules
            .map(|row| {
                let mut schedule = row.map_err(db_error)?;
                schedule.attachments = attachments_for_schedule(&self.db, &schedule.id)?;
                Ok(schedule)
            })
            .collect()
    }

    pub fn review(&self, profile: &str, identity: &str) -> Result<Vec<Review>, String> {
        let mut query = self
            .db
            .prepare(
                "SELECT o.id,o.schedule_id,o.chat_id,o.chat_name,o.text,o.due,o.state
             FROM occurrence o JOIN schedule s ON s.id=o.schedule_id
             WHERE s.profile=? AND s.identity=? AND o.state IN ('missed','failed','uncertain')
             ORDER BY o.due,o.id",
            )
            .map_err(db_error)?;
        let rows = query
            .query_map(params![profile, identity], |row| {
                Ok(Review {
                    occurrence_id: row.get(0)?,
                    schedule_id: row.get(1)?,
                    chat_id: row.get(2)?,
                    chat_name: row.get(3)?,
                    text: row.get(4)?,
                    attachments: vec![],
                    due_ms: row.get(5)?,
                    state: row.get(6)?,
                })
            })
            .map_err(db_error)?;
        rows.map(|row| {
            let mut review = row.map_err(db_error)?;
            review.attachments = attachments_for_occurrence(&self.db, &review.occurrence_id)?;
            Ok(review)
        })
        .collect()
    }

    pub fn pending_accounts(&self) -> Result<Vec<PendingAccount>, String> {
        let mut query = self.db.prepare(
            "SELECT s.profile,COUNT(*) FROM occurrence o JOIN schedule s ON s.id=o.schedule_id
             WHERE o.state IN ('missed','failed','uncertain') GROUP BY s.profile ORDER BY s.profile",
        ).map_err(db_error)?;
        let rows = query
            .query_map([], |row| {
                Ok(PendingAccount {
                    account_id: row.get(0)?,
                    count: row.get(1)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)
    }

    pub fn due(
        &mut self,
        now: i64,
        live: impl Fn(&str, &str, i64) -> bool,
    ) -> Result<bool, String> {
        let tx = self.db.transaction().map_err(db_error)?;
        let schedules = {
            let mut query = tx.prepare(
                "SELECT id,revision,chat_id,chat_name,text,local_at,time_zone,repeat,next_due,successful,
                        profile,identity,next_index FROM schedule WHERE next_due<=? ORDER BY next_due,id",
            ).map_err(db_error)?;
            let rows = query
                .query_map([now], |row| {
                    Ok((
                        map_schedule(row)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, u32>(12)?,
                    ))
                })
                .map_err(db_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(db_error)?
        };
        for (schedule, profile, identity, from) in &schedules {
            let calendar = Calendar::new(
                &schedule.local_at,
                &schedule.time_zone,
                schedule.repeat.as_ref(),
            )?;
            let Some((index, due)) = calendar
                .latest_due(*from, now)
                .and_then(|index| calendar.due(index).map(|due| (index, due)))
            else {
                // An updated zone database can move the computed due time
                // later than the stored instant. Let other due rows proceed.
                tx.execute(
                    "UPDATE schedule SET next_due=? WHERE id=?",
                    params![calendar.due(*from), schedule.id],
                )
                .map_err(db_error)?;
                prune_schedule(&tx, &schedule.id)?;
                continue;
            };
            let live = live(profile, identity, due) && may_queue(&tx, schedule)?;
            if live {
                if index > *from {
                    let missed = calendar.due(index - 1).ok_or("invalid_schedule")?;
                    insert_occurrence(&tx, schedule, missed, "missed")?;
                }
                insert_occurrence(&tx, schedule, due, "queued")?;
            } else {
                insert_occurrence(&tx, schedule, due, "missed")?;
            }
            tx.execute(
                "UPDATE schedule SET next_due=?, next_index=? WHERE id=?",
                params![calendar.due(index + 1), index + 1, schedule.id],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(!schedules.is_empty())
    }

    pub fn deadlines(&self) -> Result<Vec<(String, i64)>, String> {
        let mut query = self.db.prepare(
            "SELECT profile,MIN(next_due) FROM schedule WHERE next_due IS NOT NULL GROUP BY profile",
        ).map_err(db_error)?;
        let rows = query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)
    }

    pub fn candidates(&self) -> Result<Vec<Candidate>, String> {
        let mut query = self.db.prepare(
            "SELECT o.id,s.profile,s.identity,o.chat_id,o.text,p.position,p.message_id,o.state='uncertain',
                    f.id,f.name,f.mime,f.size,f.mode,p.caption,s.id,o.due,o.approved_at,
                    EXISTS(SELECT 1 FROM part sent WHERE sent.occurrence_id=o.id AND sent.state='acked')
             FROM occurrence o JOIN schedule s ON s.id=o.schedule_id
             JOIN part p ON p.occurrence_id=o.id LEFT JOIN file f ON f.id=p.file_id
             WHERE o.state IN ('queued','uncertain') AND p.position=(
                SELECT MIN(eligible.position) FROM part eligible
                WHERE eligible.occurrence_id=o.id
                AND eligible.state=CASE o.state WHEN 'queued' THEN 'pending' ELSE 'unknown' END
             )
             ORDER BY o.state='uncertain' DESC,o.due,p.position",
        ).map_err(db_error)?;
        let rows = query
            .query_map([], |row| {
                Ok(Candidate {
                    occurrence_id: row.get(0)?,
                    schedule_id: row.get(14)?,
                    due_ms: row.get(15)?,
                    approved_at: row.get(16)?,
                    partially_sent: row.get(17)?,
                    account: row.get(1)?,
                    identity: row.get(2)?,
                    chat_id: row.get(3)?,
                    text: row.get(4)?,
                    position: row.get(5)?,
                    message_id: row.get(6)?,
                    reconciliation: row.get(7)?,
                    attachment: row
                        .get::<_, Option<String>>(8)?
                        .map(|_| map_attachment(row, 8))
                        .transpose()?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)
    }

    pub fn dispatch(&mut self, candidate: &Candidate) -> Result<(), String> {
        if candidate.reconciliation {
            return Ok(());
        }
        let tx = self.db.transaction().map_err(db_error)?;
        tx.execute(
            "UPDATE occurrence SET state='sending' WHERE id=?",
            [&candidate.occurrence_id],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE part SET state='inflight' WHERE occurrence_id=? AND position=?",
            params![candidate.occurrence_id, candidate.position],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    pub fn prepare(&self, candidate: &Candidate, message_id: &str) -> Result<(), String> {
        let changed = self.db.execute(
            "UPDATE part SET message_id=? WHERE occurrence_id=? AND position=? AND state='inflight' AND message_id IS NULL",
            params![message_id, candidate.occurrence_id, candidate.position],
        ).map_err(db_error)?;
        if changed == 1 {
            Ok(())
        } else {
            Err("delivery_changed".into())
        }
    }

    pub fn finish(
        &mut self,
        candidate: &Candidate,
        outcome: Outcome,
        prepared: bool,
    ) -> Result<(), String> {
        let tx = self.db.transaction().map_err(db_error)?;
        let id = &candidate.occurrence_id;
        let part_state = match (outcome, candidate.reconciliation, prepared) {
            (Outcome::Sent, _, true) => "acked",
            (_, true, _) => "unknown",
            (Outcome::Rejected, false, _) => "failed",
            (Outcome::Unknown | Outcome::Unavailable, false, true) => "unknown",
            (Outcome::Unavailable, false, false) => "pending",
            _ => "failed",
        };
        tx.execute(
            "UPDATE part SET state=? WHERE occurrence_id=? AND position=?",
            params![part_state, id, candidate.position],
        )
        .map_err(db_error)?;
        let count = |state: &str| {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM part WHERE occurrence_id=? AND state=?)",
                params![id, state],
                |row| row.get::<_, bool>(0),
            )
            .map_err(db_error)
        };
        let new_state = if count("unknown")? {
            "uncertain"
        } else if count("failed")? || (candidate.reconciliation && count("pending")?) {
            "failed"
        } else if count("pending")? {
            if matches!(outcome, Outcome::Unavailable) {
                if count("acked")? {
                    "failed"
                } else {
                    "missed"
                }
            } else {
                "queued"
            }
        } else {
            complete_occurrence(&tx, id)?;
            return tx.commit().map_err(db_error);
        };
        tx.execute(
            "UPDATE occurrence SET state=? WHERE id=?",
            params![new_state, id],
        )
        .map_err(db_error)?;
        if new_state == "missed" {
            tx.execute(
                "DELETE FROM occurrence AS older WHERE state='missed'
                 AND schedule_id=(SELECT schedule_id FROM occurrence WHERE id=?)
                 AND EXISTS(SELECT 1 FROM occurrence newer WHERE newer.schedule_id=older.schedule_id
                 AND newer.state='missed' AND (newer.due,newer.rowid)>(older.due,older.rowid))",
                [id],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    }

    pub fn remove_account(&mut self, profile: &str) -> Result<(), String> {
        self.db
            .execute("DELETE FROM schedule WHERE profile=?", [profile])
            .map_err(db_error)?;
        Ok(())
    }

    pub fn take_unreferenced(&self) -> Result<Vec<String>, String> {
        let mut query = self
            .db
            .prepare(
                "DELETE FROM file
             WHERE NOT EXISTS(SELECT 1 FROM schedule_file WHERE file_id=file.id)
             AND NOT EXISTS(SELECT 1 FROM part WHERE file_id=file.id)
             RETURNING id",
            )
            .map_err(db_error)?;
        let rows = query.query_map([], |row| row.get(0)).map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)
    }

    pub fn has_attachment(&self, id: &str) -> Result<bool, String> {
        self.db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM file WHERE id=?)",
                [id],
                |row| row.get(0),
            )
            .map_err(db_error)
    }
}

impl Mode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::Document => "document",
        }
    }
}

fn db_error(_error: rusqlite::Error) -> String {
    // Avoid exposing message data, paths, or raw SQL to the remote webview.
    "schedule_storage".into()
}

fn lookup(db: &Connection, profile: &str, identity: &str, id: &str) -> Result<Schedule, String> {
    db.query_row(
        "SELECT id,revision,chat_id,chat_name,text,local_at,time_zone,repeat,next_due,successful
         FROM schedule WHERE profile=? AND identity=? AND id=?",
        params![profile, identity, id],
        map_schedule,
    )
    .optional()
    .map_err(db_error)?
    .ok_or_else(|| "schedule_changed".into())
}

fn map_schedule(row: &rusqlite::Row<'_>) -> rusqlite::Result<Schedule> {
    let repeat = row
        .get::<_, Option<String>>(7)?
        .map(|value| {
            serde_json::from_str(&value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    7,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()?;
    Ok(Schedule {
        id: row.get(0)?,
        revision: row.get(1)?,
        chat_id: row.get(2)?,
        chat_name: row.get(3)?,
        text: row.get(4)?,
        attachments: vec![],
        local_at: row.get(5)?,
        time_zone: row.get(6)?,
        repeat,
        next_due_ms: row.get(8)?,
        successful_sends: row.get(9)?,
    })
}

fn map_attachment(row: &rusqlite::Row<'_>, from: usize) -> rusqlite::Result<Attachment> {
    let mode = match row.get::<_, String>(from + 4)?.as_str() {
        "image" => Mode::Image,
        "video" => Mode::Video,
        "document" => Mode::Document,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(Attachment {
        id: row.get(from)?,
        file: FileInput {
            name: row.get(from + 1)?,
            mime: row.get(from + 2)?,
            size: row.get(from + 3)?,
            mode,
            caption: row.get(from + 5)?,
        },
    })
}

fn attachments_for_schedule(db: &Connection, id: &str) -> Result<Vec<Attachment>, String> {
    attachments(db, id, "SELECT f.id,f.name,f.mime,f.size,f.mode,sf.caption
        FROM schedule_file sf JOIN file f ON f.id=sf.file_id WHERE sf.schedule_id=? ORDER BY sf.position")
}

fn attachments_for_occurrence(db: &Connection, id: &str) -> Result<Vec<Attachment>, String> {
    attachments(
        db,
        id,
        "SELECT f.id,f.name,f.mime,f.size,f.mode,p.caption
        FROM part p JOIN file f ON f.id=p.file_id WHERE p.occurrence_id=? ORDER BY p.position",
    )
}

fn attachments(db: &Connection, id: &str, sql: &str) -> Result<Vec<Attachment>, String> {
    let mut query = db.prepare(sql).map_err(db_error)?;
    let rows = query
        .query_map([id], |row| map_attachment(row, 0))
        .map_err(db_error)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_error)
}

fn same_repeat(left: Option<&Repeat>, right: Option<&Repeat>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            std::mem::discriminant(&left.unit) == std::mem::discriminant(&right.unit)
                && left.interval == right.interval
        }
        _ => false,
    }
}

fn may_queue(tx: &Transaction<'_>, schedule: &Schedule) -> Result<bool, String> {
    let Some(max_sends) = schedule.repeat.as_ref().and_then(|rule| rule.max_sends) else {
        return Ok(true);
    };
    Ok(schedule
        .successful_sends
        .saturating_add(reserved_sends(tx, &schedule.id)?)
        < max_sends)
}

fn reserved_sends(tx: &Transaction<'_>, schedule_id: &str) -> Result<u32, String> {
    tx.query_row(
        "SELECT COUNT(*) FROM occurrence WHERE schedule_id=? AND state IN ('queued','sending','uncertain')",
        [schedule_id], |row| row.get(0),
    ).map_err(db_error)
}

fn insert_occurrence(
    tx: &Transaction<'_>,
    schedule: &Schedule,
    due: i64,
    state: &str,
) -> Result<(), String> {
    if state == "missed" {
        let has_later: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM occurrence WHERE schedule_id=? AND state='missed' AND due>?)",
            params![schedule.id,due], |row| row.get(0),
        ).map_err(db_error)?;
        if has_later {
            return Ok(());
        }
        tx.execute(
            "DELETE FROM occurrence WHERE schedule_id=? AND state='missed' AND due<=?",
            params![schedule.id, due],
        )
        .map_err(db_error)?;
    }
    let id = new_id()?;
    tx.execute(
        "INSERT INTO occurrence (id,schedule_id,chat_id,chat_name,text,due,state) VALUES (?,?,?,?,?,?,?)",
        params![
            id,
            schedule.id,
            schedule.chat_id,
            schedule.chat_name,
            schedule.text,
            due,
            state
        ],
    )
    .map_err(db_error)?;
    if tx
        .execute(
            "INSERT INTO part(occurrence_id,position,file_id,caption,state)
         SELECT ?,position,file_id,caption,'pending' FROM schedule_file WHERE schedule_id=?",
            params![id, schedule.id],
        )
        .map_err(db_error)?
        == 0
    {
        tx.execute(
            "INSERT INTO part(occurrence_id,position,state) VALUES (?,0,'pending')",
            [id],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

fn complete_occurrence(tx: &Transaction<'_>, id: &str) -> Result<(), String> {
    let (schedule_id, raw_repeat, successful): (String, Option<String>, u32) = tx.query_row(
        "SELECT s.id,s.repeat,s.successful FROM occurrence o JOIN schedule s ON s.id=o.schedule_id WHERE o.id=?",
        [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).map_err(db_error)?;
    let new_successful = successful.saturating_add(1);
    let rule = raw_repeat
        .map(|raw| serde_json::from_str::<Repeat>(&raw))
        .transpose()
        .map_err(|_| "invalid_repeat")?;
    tx.execute("DELETE FROM occurrence WHERE id=?", [id])
        .map_err(db_error)?;
    if rule
        .and_then(|repeat| repeat.max_sends)
        .is_some_and(|limit| new_successful >= limit)
    {
        tx.execute("DELETE FROM schedule WHERE id=?", [schedule_id])
            .map_err(db_error)?;
    } else {
        tx.execute(
            "UPDATE schedule SET successful=? WHERE id=?",
            params![new_successful, schedule_id],
        )
        .map_err(db_error)?;
        prune_schedule(tx, &schedule_id)?;
    }
    Ok(())
}

fn prune_schedule(tx: &Transaction<'_>, id: &str) -> Result<(), String> {
    tx.execute(
        "DELETE FROM schedule WHERE id=? AND next_due IS NULL
        AND NOT EXISTS(SELECT 1 FROM occurrence WHERE schedule_id=schedule.id)",
        [id],
    )
    .map_err(db_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduled_messages::calendar::Unit;

    const PROFILE: &str = "default";
    const IDENTITY: &str = "16661234567@c.us";

    fn input() -> SaveInput {
        SaveInput {
            id: None,
            revision: None,
            chat_id: "17771234567@c.us".into(),
            chat_name: "Test chat".into(),
            text: "first line\n🙂 second line".into(),
            local_at: "2030-01-01T09:00".into(),
            time_zone: "UTC".into(),
            repeat: None,
            stage_id: None,
            keep_attachment_ids: vec![],
            first_caption: None,
        }
    }

    fn due(input: &SaveInput, index: u32) -> i64 {
        Calendar::new(&input.local_at, &input.time_zone, input.repeat.as_ref())
            .unwrap()
            .due(index)
            .unwrap()
    }

    fn attachments() -> Vec<Attachment> {
        (0..3)
            .map(|index| Attachment {
                id: format!("file-{index}"),
                file: FileInput {
                    name: format!("file-{index}.txt"),
                    mime: "text/plain".into(),
                    size: 10,
                    mode: Mode::Document,
                    caption: format!("caption {index}"),
                },
            })
            .collect()
    }

    fn claim_ack(store: &mut Store, candidate: &Candidate) {
        store.dispatch(candidate).unwrap();
        store.prepare(candidate, "test-message-id").unwrap();
        store.finish(candidate, Outcome::Sent, true).unwrap();
    }

    #[test]
    fn scheduler_catches_up_latest_per_series_and_only_success_uses_an_allowance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let mut input = input();
        input.repeat = Some(Repeat {
            unit: Unit::Day,
            interval: 2,
            end_date: None,
            max_sends: Some(1),
        });
        let first = due(&input, 0);
        let latest = due(&input, 3);
        Store::open(&path)
            .unwrap()
            .save(PROFILE, IDENTITY, &input, &[], first - 1)
            .unwrap();

        let mut store = Store::open(&path).unwrap();
        store.due(latest, |_, _, _| false).unwrap();
        let rows = store.review(PROFILE, IDENTITY).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].due_ms, latest);
        assert_eq!(rows[0].text, input.text);
        assert_eq!(store.pending_accounts().unwrap()[0].count, 1);
        assert!(store
            .review(PROFILE, "18881234567@c.us")
            .unwrap()
            .is_empty());
        assert!(store.schedules("acct-1", IDENTITY).unwrap().is_empty());
        assert!(store.candidates().unwrap().is_empty());
        store
            .decide(
                PROFILE,
                IDENTITY,
                &rows[0].occurrence_id,
                Action::Skip,
                true,
                latest + 5,
            )
            .unwrap();
        let schedule = &store.schedules(PROFILE, IDENTITY).unwrap()[0];
        let next = due(&input, 4);
        assert_eq!(schedule.next_due_ms, Some(next));
        assert_eq!(schedule.successful_sends, 0);

        store.due(next, |_, _, _| false).unwrap();
        let rows = store.review(PROFILE, IDENTITY).unwrap();
        assert!(store
            .decide(
                PROFILE,
                IDENTITY,
                &rows[0].occurrence_id,
                Action::Send,
                false,
                next + 5
            )
            .is_err());
        store
            .decide(
                PROFILE,
                IDENTITY,
                &rows[0].occurrence_id,
                Action::Send,
                true,
                next + 5,
            )
            .unwrap();
        let candidate = &store.candidates().unwrap()[0];
        assert_eq!(candidate.approved_at, Some(next + 5));
        claim_ack(&mut store, candidate);
        assert!(store.schedules(PROFILE, IDENTITY).unwrap().is_empty());
    }

    #[test]
    fn restart_reconciles_a_prepared_file_without_replaying_acknowledged_parts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let mut input = input();
        input.text.clear();
        let at = due(&input, 0);
        {
            let mut store = Store::open(&path).unwrap();
            store
                .save(PROFILE, IDENTITY, &input, &attachments(), at - 10)
                .unwrap();
            store.due(at, |_, _, _| true).unwrap();
            let jobs = store.candidates().unwrap();
            assert_eq!(jobs.len(), 1);
            assert_eq!(jobs[0].position, 0);
            claim_ack(&mut store, &jobs[0]);
            let jobs = store.candidates().unwrap();
            assert!(jobs[0].partially_sent);
            assert_eq!(jobs[0].position, 1);
            store.dispatch(&jobs[0]).unwrap();
            store.prepare(&jobs[0], "prepared-video-message").unwrap();
        }
        let mut store = Store::open(&path).unwrap();
        let jobs = store.candidates().unwrap();
        assert_eq!(jobs.len(), 1);
        assert!(jobs[0].reconciliation);
        assert_eq!(jobs[0].position, 1);
        assert_eq!(
            jobs[0].message_id.as_deref(),
            Some("prepared-video-message")
        );
        let review = store.review(PROFILE, IDENTITY).unwrap();
        assert_eq!(review[0].state, "uncertain");
        assert!(store
            .decide(
                PROFILE,
                IDENTITY,
                &review[0].occurrence_id,
                Action::Retry,
                true,
                at + 2
            )
            .is_err());
        store.finish(&jobs[0], Outcome::Rejected, true).unwrap();
        assert_eq!(
            store.review(PROFILE, IDENTITY).unwrap()[0].state,
            "uncertain"
        );
        store.finish(&jobs[0], Outcome::Sent, true).unwrap();
        let review = store.review(PROFILE, IDENTITY).unwrap();
        assert_eq!(review[0].state, "failed");
        assert_eq!(review[0].attachments[1].file.caption, "caption 1");
        assert!(store.candidates().unwrap().is_empty());
        store
            .decide(
                PROFILE,
                IDENTITY,
                &review[0].occurrence_id,
                Action::Retry,
                true,
                at + 3,
            )
            .unwrap();
        let jobs = store.candidates().unwrap();
        assert_eq!(jobs[0].position, 2);
        claim_ack(&mut store, &jobs[0]);
        assert!(store.schedules(PROFILE, IDENTITY).unwrap().is_empty());
        assert_eq!(store.take_unreferenced().unwrap().len(), 3);
    }

    #[test]
    fn edits_keep_missed_payload_and_stale_deadline_cannot_block_unrelated_work() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let mut input = input();
        input.repeat = Some(Repeat {
            unit: Unit::Day,
            interval: 1,
            end_date: None,
            max_sends: None,
        });
        let first = due(&input, 0);
        store
            .save(PROFILE, IDENTITY, &input, &[], first - 1)
            .unwrap();
        store
            .save("acct-1", IDENTITY, &input, &[], first - 1)
            .unwrap();
        let first_schedule = store.schedules(PROFILE, IDENTITY).unwrap().pop().unwrap();
        store
            .db
            .execute(
                "UPDATE schedule SET next_due=? WHERE id=?",
                params![first - 10, first_schedule.id],
            )
            .unwrap();
        store.due(first - 10, |_, _, _| false).unwrap();
        assert_eq!(
            store.schedules(PROFILE, IDENTITY).unwrap()[0].next_due_ms,
            Some(first)
        );

        let draft = input.text.clone();
        input.id = Some(first_schedule.id);
        input.revision = Some(first_schedule.revision);
        input.text = "replacement".into();
        assert!(store
            .save(PROFILE, IDENTITY, &input, &[], first + 1)
            .is_err());
        store.due(first + 1, |_, _, _| false).unwrap();
        store
            .save(PROFILE, IDENTITY, &input, &[], first + 1)
            .unwrap();
        assert_eq!(store.review(PROFILE, IDENTITY).unwrap()[0].text, draft);
        assert_eq!(store.review("acct-1", IDENTITY).unwrap()[0].text, draft);
        assert_eq!(
            store.schedules(PROFILE, IDENTITY).unwrap()[0].text,
            "replacement"
        );
    }

    #[test]
    fn edits_retained_caption_without_changing_the_missed_snapshot_or_attachment_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("captions.sqlite");
        let mut draft = input();
        draft.text.clear();
        draft.repeat = Some(Repeat {
            unit: Unit::Day,
            interval: 1,
            end_date: None,
            max_sends: None,
        });
        let first = due(&draft, 0);
        let next = due(&draft, 1);
        let files = attachments();
        let mut store = Store::open(&path).unwrap();
        store
            .save(PROFILE, IDENTITY, &draft, &files, first - 1)
            .unwrap();
        store.due(first, |_, _, _| false).unwrap();
        let schedule = store.schedules(PROFILE, IDENTITY).unwrap().pop().unwrap();
        draft.id = Some(schedule.id);
        draft.revision = Some(schedule.revision);
        draft.keep_attachment_ids = files.iter().map(|file| file.id.clone()).collect();
        draft.first_caption = Some("changed upcoming caption".into());
        store
            .save(PROFILE, IDENTITY, &draft, &[], first + 1)
            .unwrap();
        drop(store);

        let mut store = Store::open(&path).unwrap();
        let old = &store.review(PROFILE, IDENTITY).unwrap()[0].attachments[0];
        let upcoming = store.schedules(PROFILE, IDENTITY).unwrap().pop().unwrap();
        assert_eq!(old.id, upcoming.attachments[0].id);
        assert_eq!(old.file.caption, "caption 0");
        assert_eq!(
            upcoming.attachments[0].file.caption,
            "changed upcoming caption"
        );
        assert_eq!(upcoming.attachments[1].file.caption, "caption 1");
        let file_count: usize = store
            .db
            .query_row("SELECT COUNT(*) FROM file", [], |row| row.get(0))
            .unwrap();
        assert_eq!(file_count, files.len());
        store.due(next, |_, _, _| true).unwrap();
        let queued = store.candidates().unwrap();
        assert_eq!(
            queued[0].attachment.as_ref().unwrap().file.caption,
            "changed upcoming caption"
        );
    }

    #[test]
    fn migrating_old_captions_preserves_saved_files_and_missed_captions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy-captions.sqlite");
        let mut draft = input();
        draft.text.clear();
        let first = due(&draft, 0);
        let files = attachments();
        let mut store = Store::open(&path).unwrap();
        store
            .save(PROFILE, IDENTITY, &draft, &files, first - 1)
            .unwrap();
        store.due(first, |_, _, _| false).unwrap();
        store
            .db
            .execute_batch(
                "ALTER TABLE file ADD COLUMN caption TEXT NOT NULL DEFAULT '';
             UPDATE file SET caption=(SELECT caption FROM schedule_file WHERE file_id=file.id);
             ALTER TABLE schedule_file DROP COLUMN caption;
             ALTER TABLE part DROP COLUMN caption;",
            )
            .unwrap();
        drop(store);

        let store = Store::open(&path).unwrap();
        let saved = store.schedules(PROFILE, IDENTITY).unwrap().pop().unwrap();
        let missed = store.review(PROFILE, IDENTITY).unwrap().pop().unwrap();
        assert_eq!(saved.attachments[0].id, files[0].id);
        assert_eq!(saved.attachments[0].file.caption, "caption 0");
        assert_eq!(missed.attachments[1].id, files[1].id);
        assert_eq!(missed.attachments[1].file.caption, "caption 1");
    }
}

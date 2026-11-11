//! Permanent voice transcripts, one SQLite file per WhatsApp account.
//!
//! Notes live in `app_data_dir/transcripts/<account-id>.sqlite`, beside that
//! account's profile. A row is never pruned. Lookup reads one row. A second
//! transcription of the same note claims the existing row instead of calling
//! FluidVoice again.
//!
//! The pre-account `voice-transcripts.json` is imported once into
//! `transcripts/legacy.sqlite`. The first account to open a legacy note takes
//! it. The JSON stays in the config directory so an interrupted import can be
//! repeated; [`LEGACY_MARKER`] stops it from being read twice.

use crate::jsonfile::Loaded;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const LEGACY_JSON: &str = "voice-transcripts.json";
pub const LEGACY_MARKER: &str = "voice-transcripts.imported";

const LEGACY_DB: &str = "legacy.sqlite";
/// A translation claim older than this is taken over. The model call is not
/// supposed to run that long.
const TRANSLATION_STALE_MS: u64 = 120_000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS note (
  token TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  chat TEXT NOT NULL DEFAULT '',
  from_me INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  at_ms INTEGER NOT NULL DEFAULT 0,
  saved_ms INTEGER NOT NULL DEFAULT 0,
  translation TEXT,
  translation_key TEXT,
  summary TEXT,
  summary_key TEXT,
  claimed_ms INTEGER NOT NULL DEFAULT 0,
  media TEXT NOT NULL DEFAULT 'voice',
  translation_claim_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS note_chat ON note(chat, at_ms);
";

#[derive(Clone, Debug)]
pub struct Note {
    pub token: String,
    pub id: String,
    pub chat: String,
    pub from_me: bool,
    pub state: String,
    pub text: String,
    pub at_ms: u64,
    pub saved_ms: u64,
    pub translation: Option<String>,
    pub translation_key: Option<String>,
    pub summary: Option<String>,
    pub summary_key: Option<String>,
    pub claimed_ms: u64,
    pub media: String,
}

pub struct NewNote {
    pub id: String,
    pub at_ms: u64,
    pub media: &'static str,
}

pub enum Claim {
    /// This caller owns FluidVoice. The number is the claim generation.
    Owned(u64),
    Ready(Note),
    Busy,
}

#[derive(Default, Deserialize)]
struct LegacyFile {
    #[serde(default)]
    items: BTreeMap<String, LegacyEntry>,
}

#[derive(Default, Deserialize)]
struct LegacyEntry {
    #[serde(default)]
    text: String,
    #[serde(default)]
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

fn db_path(dir: &Path, account: &str) -> Result<PathBuf, String> {
    if !crate::todo::valid_account_id(account) {
        return Err("bad_account".into());
    }
    Ok(dir.join(format!("{account}.sqlite")))
}

fn legacy_path(dir: &Path) -> PathBuf {
    dir.join(LEGACY_DB)
}

fn open_path(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let conn = Connection::open(path).map_err(|err| err.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|err| err.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|err| err.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
    Ok(conn)
}

fn open_account(dir: &Path, account: &str) -> Result<Connection, String> {
    open_path(&db_path(dir, account)?)
}

fn token_of(id: &str) -> Result<String, String> {
    let token = crate::todo::message_token(id);
    if token.is_empty() {
        Err("bad_id".into())
    } else {
        Ok(token)
    }
}

fn map_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let from_me: i64 = row.get(3)?;
    Ok(Note {
        token: row.get(0)?,
        id: row.get(1)?,
        chat: row.get(2)?,
        from_me: from_me != 0,
        state: row.get(4)?,
        text: row.get(5)?,
        at_ms: row.get(6)?,
        saved_ms: row.get(7)?,
        translation: row.get(8)?,
        translation_key: row.get(9)?,
        summary: row.get(10)?,
        summary_key: row.get(11)?,
        claimed_ms: row.get(12)?,
        media: row.get(13)?,
    })
}

const NOTE_COLUMNS: &str = "
SELECT token, id, chat, from_me, state, text, at_ms, saved_ms,
       translation, translation_key, summary, summary_key, claimed_ms, media
";

fn select_from(table: &str) -> String {
    format!("{NOTE_COLUMNS} FROM {table}")
}

fn load_token(conn: &Connection, token: &str) -> Result<Option<Note>, String> {
    conn.query_row(
        &(select_from("note") + " WHERE token = ?1"),
        [token],
        map_note,
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn load_id(conn: &Connection, id: &str) -> Result<Option<Note>, String> {
    conn.query_row(&(select_from("note") + " WHERE id = ?1"), [id], map_note)
        .optional()
        .map_err(|err| err.to_string())
}

fn load_conn(conn: &Connection, id: &str) -> Result<Option<Note>, String> {
    let parsed = crate::todo::message_token(id);
    let token = if parsed.is_empty() {
        id
    } else {
        parsed.as_str()
    };
    if !token.is_empty() {
        if let Some(note) = load_token(conn, token)? {
            return Ok(Some(note));
        }
    }
    if !id.is_empty() && id != token {
        return load_id(conn, id);
    }
    Ok(None)
}

/// The account file only. Does not create a row and does not read the legacy file.
pub fn load(dir: &Path, account: &str, id: &str) -> Result<Option<Note>, String> {
    let path = db_path(dir, account)?;
    if !path.exists() {
        return Ok(None);
    }
    load_conn(&open_path(&path)?, id)
}

fn adopt(conn: &Connection, legacy: &Path, id: &str) -> Result<Option<Note>, String> {
    if !legacy.exists() {
        return Ok(None);
    }
    conn.execute(
        "ATTACH DATABASE ?1 AS legacy",
        [legacy.to_string_lossy().as_ref()],
    )
    .map_err(|err| err.to_string())?;
    let detach = Detach(conn);
    let parsed = crate::todo::message_token(id);
    let token = if parsed.is_empty() {
        id.to_string()
    } else {
        parsed
    };
    let note = if token.is_empty() {
        None
    } else {
        conn.query_row(
            &(select_from("legacy.note") + " WHERE token = ?1"),
            [&token],
            map_note,
        )
        .optional()
        .map_err(|err| err.to_string())?
    };
    let note = match note {
        Some(note) => Some(note),
        None if !id.is_empty() => conn
            .query_row(
                &(select_from("legacy.note") + " WHERE id = ?1"),
                [id],
                map_note,
            )
            .optional()
            .map_err(|err| err.to_string())?,
        None => None,
    };
    let Some(note) = note else {
        drop(detach);
        return Ok(None);
    };
    conn.execute(
        "INSERT OR REPLACE INTO note (
            token, id, chat, from_me, state, text, at_ms, saved_ms,
            translation, translation_key, summary, summary_key, claimed_ms, media, translation_claim_ms
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0)",
        params![
            note.token,
            note.id,
            note.chat,
            note.from_me as i64,
            note.state,
            note.text,
            note.at_ms,
            note.saved_ms,
            note.translation,
            note.translation_key,
            note.summary,
            note.summary_key,
            note.claimed_ms,
            note.media,
        ],
    )
    .map_err(|err| err.to_string())?;
    conn.execute("DELETE FROM legacy.note WHERE token = ?1", [&note.token])
        .map_err(|err| err.to_string())?;
    drop(detach);
    Ok(Some(note))
}

struct Detach<'a>(&'a Connection);

impl Drop for Detach<'_> {
    fn drop(&mut self) {
        let _ = self.0.execute("DETACH DATABASE legacy", []);
    }
}

/// Account row, or the legacy row moved into this account.
pub fn read(dir: &Path, account: &str, id: &str) -> Result<Option<Note>, String> {
    if let Some(note) = load(dir, account, id)? {
        return Ok(Some(note));
    }
    let conn = open_account(dir, account)?;
    adopt(&conn, &legacy_path(dir), id)
}

pub fn claim(
    dir: &Path,
    account: &str,
    seed: &NewNote,
    now: u64,
    stale_ms: u64,
) -> Result<Claim, String> {
    let token = token_of(&seed.id)?;
    let chat = crate::todo::chat_from_compound(&seed.id).unwrap_or_default();
    let from_me = seed.id.starts_with("true_") as i64;
    let conn = open_account(dir, account)?;
    let inserted = conn
        .execute(
            "INSERT INTO note (
                token, id, chat, from_me, state, text, at_ms, saved_ms, claimed_ms, media
             ) VALUES (?1,?2,?3,?4,'running','',?5,?6,?6,?7)
             ON CONFLICT(token) DO NOTHING",
            params![token, seed.id, chat, from_me, seed.at_ms, now, seed.media],
        )
        .map_err(|err| err.to_string())?;
    if inserted == 1 {
        return Ok(Claim::Owned(now));
    }
    let Some(note) = load_token(&conn, &token)? else {
        return Err("claim".into());
    };
    if note.state == "ready" {
        return Ok(Claim::Ready(note));
    }
    if now.saturating_sub(note.claimed_ms) >= stale_ms {
        let updated = conn
            .execute(
                "UPDATE note SET claimed_ms = ?1, id = ?2
                 WHERE token = ?3 AND state = 'running' AND claimed_ms = ?4",
                params![now, seed.id, token, note.claimed_ms],
            )
            .map_err(|err| err.to_string())?;
        if updated == 1 {
            return Ok(Claim::Owned(now));
        }
        if let Some(note) = load_token(&conn, &token)? {
            if note.state == "ready" {
                return Ok(Claim::Ready(note));
            }
        }
    }
    Ok(Claim::Busy)
}

pub fn finish(
    dir: &Path,
    account: &str,
    id: &str,
    text: &str,
    at_ms: u64,
    now: u64,
    generation: u64,
) -> Result<bool, String> {
    let token = token_of(id)?;
    let at = if at_ms == 0 { now } else { at_ms };
    let conn = open_account(dir, account)?;
    let updated = conn
        .execute(
            "UPDATE note SET state = 'ready', text = ?1, at_ms = ?2, saved_ms = ?3, claimed_ms = ?3
             WHERE token = ?4 AND state = 'running' AND claimed_ms = ?5",
            params![text, at, now, token, generation],
        )
        .map_err(|err| err.to_string())?;
    Ok(updated == 1)
}

pub fn release(dir: &Path, account: &str, id: &str, generation: u64) -> Result<bool, String> {
    let token = token_of(id)?;
    let path = db_path(dir, account)?;
    if !path.exists() {
        return Ok(false);
    }
    let conn = open_path(&path)?;
    let updated = conn
        .execute(
            "DELETE FROM note WHERE token = ?1 AND state = 'running' AND claimed_ms = ?2",
            params![token, generation],
        )
        .map_err(|err| err.to_string())?;
    Ok(updated == 1)
}

pub fn claim_translation(
    dir: &Path,
    account: &str,
    token: &str,
    key: &str,
    now: u64,
) -> Result<bool, String> {
    let pending = format!("pending:{key}");
    let stale_before = now.saturating_sub(TRANSLATION_STALE_MS);
    let conn = open_account(dir, account)?;
    let updated = conn
        .execute(
            "UPDATE note SET translation_key = ?1, translation_claim_ms = ?2
             WHERE token = ?3 AND state = 'ready'
             AND COALESCE(translation_key, '') != ?4
             AND (
               translation_claim_ms = 0
               OR COALESCE(translation_key, '') NOT LIKE 'pending:%'
               OR translation_claim_ms < ?5
             )",
            params![pending, now, token, key, stale_before],
        )
        .map_err(|err| err.to_string())?;
    Ok(updated == 1)
}

pub fn save_translation(
    dir: &Path,
    account: &str,
    token: &str,
    key: &str,
    text: &str,
) -> Result<(), String> {
    let pending = format!("pending:{key}");
    let conn = open_account(dir, account)?;
    conn.execute(
        "UPDATE note SET translation = ?1, translation_key = ?2, translation_claim_ms = 0
         WHERE token = ?3 AND translation_key = ?4",
        params![text, key, token, pending],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn clear_translation_claim(
    dir: &Path,
    account: &str,
    token: &str,
    key: &str,
) -> Result<(), String> {
    let pending = format!("pending:{key}");
    let path = db_path(dir, account)?;
    if !path.exists() {
        return Ok(());
    }
    let conn = open_path(&path)?;
    conn.execute(
        "UPDATE note SET translation_key = NULL, translation_claim_ms = 0
         WHERE token = ?1 AND translation_key = ?2",
        params![token, pending],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn save_summary(
    dir: &Path,
    account: &str,
    id: &str,
    summary: &str,
    key: &str,
) -> Result<(), String> {
    let token = token_of(id)?;
    let conn = open_account(dir, account)?;
    conn.execute(
        "UPDATE note SET summary = ?1, summary_key = ?2 WHERE token = ?3 AND state = 'ready'",
        params![summary, key, token],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn placeholders(count: usize) -> String {
    let mut out = String::new();
    for index in 0..count {
        if index > 0 {
            out.push(',');
        }
        out.push('?');
    }
    out
}

/// Move this chat's imported notes into the account file. Notes already stored
/// for the account are kept; the legacy copies are dropped either way.
fn take_legacy_chats(dir: &Path, account: &str, chats: &[String]) -> Result<(), String> {
    let legacy = legacy_path(dir);
    if chats.is_empty() || !legacy.exists() {
        return Ok(());
    }
    let conn = open_account(dir, account)?;
    conn.execute(
        "ATTACH DATABASE ?1 AS legacy",
        [legacy.to_string_lossy().as_ref()],
    )
    .map_err(|err| err.to_string())?;
    let detach = Detach(&conn);
    let slots = placeholders(chats.len());
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        &format!(
            "INSERT OR IGNORE INTO note
             SELECT * FROM legacy.note WHERE state = 'ready' AND chat IN ({slots})"
        ),
        rusqlite::params_from_iter(chats.iter()),
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        &format!("DELETE FROM legacy.note WHERE chat IN ({slots})"),
        rusqlite::params_from_iter(chats.iter()),
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    drop(detach);
    Ok(())
}

pub fn by_chats(dir: &Path, account: &str, chats: &[String]) -> Result<Vec<Note>, String> {
    if chats.is_empty() {
        return Ok(Vec::new());
    }
    take_legacy_chats(dir, account, chats)?;
    let path = db_path(dir, account)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let conn = open_path(&path)?;
    let mut sql = select_from("note");
    sql.push_str(" WHERE state = 'ready' AND chat IN (");
    sql.push_str(&placeholders(chats.len()));
    sql.push_str(") ORDER BY at_ms, token");
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(chats.iter()), map_note)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub fn by_tokens(dir: &Path, account: &str, ids: &[String]) -> Result<Vec<Note>, String> {
    let mut notes = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let path = db_path(dir, account)?;
    if path.exists() {
        let conn = open_path(&path)?;
        let tokens: Vec<String> = ids
            .iter()
            .filter_map(|id| {
                let token = crate::todo::message_token(id);
                if token.is_empty() {
                    None
                } else {
                    Some(token)
                }
            })
            .collect();
        for chunk in tokens.chunks(200) {
            let mut sql = select_from("note");
            sql.push_str(" WHERE token IN (");
            for index in 0..chunk.len() {
                if index > 0 {
                    sql.push(',');
                }
                sql.push('?');
            }
            sql.push(')');
            let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(chunk.iter()), map_note)
                .map_err(|err| err.to_string())?;
            for row in rows {
                let note = row.map_err(|err| err.to_string())?;
                seen.insert(note.token.clone());
                notes.push(note);
            }
        }
    }
    for id in ids {
        let token = crate::todo::message_token(id);
        if token.is_empty() || seen.contains(&token) {
            continue;
        }
        if let Some(note) = read(dir, account, id)? {
            seen.insert(note.token.clone());
            notes.push(note);
        }
    }
    Ok(notes)
}

pub fn remove_account(dir: &Path, account: &str) {
    let Ok(path) = db_path(dir, account) else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    for suffix in ["-wal", "-shm"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }
}

/// Import the shared JSON file once. A missing file still writes the marker.
/// A corrupt file does not, so a later recovery can try again.
pub fn import_legacy(dir: &Path, json_path: &Path, marker: &Path) -> Result<(), String> {
    if marker.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let file = match crate::jsonfile::read::<LegacyFile>(json_path) {
        Loaded::Ok(file) | Loaded::Recovered(file) => file,
        Loaded::Missing => {
            std::fs::write(marker, b"1").map_err(|err| err.to_string())?;
            return Ok(());
        }
        Loaded::Corrupt => {
            crate::jsonfile::preserve_corrupt(json_path);
            return Err("corrupt".into());
        }
    };
    let conn = open_path(&legacy_path(dir))?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    for (id, entry) in &file.items {
        let Ok(token) = token_of(id) else {
            continue;
        };
        let chat = crate::todo::chat_from_compound(id).unwrap_or_default();
        let from_me = id.starts_with("true_") as i64;
        tx.execute(
            "INSERT INTO note (
                token, id, chat, from_me, state, text, at_ms, saved_ms,
                translation, translation_key, summary, summary_key, claimed_ms, media
             ) VALUES (?1,?2,?3,?4,'ready',?5,?6,?6,?7,?8,?9,?10,?6,'voice')
             ON CONFLICT(token) DO UPDATE SET
                text = excluded.text,
                at_ms = excluded.at_ms,
                saved_ms = excluded.saved_ms,
                id = excluded.id,
                translation = excluded.translation,
                translation_key = excluded.translation_key,
                summary = excluded.summary,
                summary_key = excluded.summary_key,
                claimed_ms = excluded.claimed_ms
             WHERE excluded.at_ms >= note.at_ms",
            params![
                token,
                id,
                chat,
                from_me,
                entry.text,
                entry.at,
                entry.translation,
                entry.translation_key,
                entry.summary,
                entry.summary_key,
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    std::fs::write(marker, b"1").map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(1);

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "whatrust-notes-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed(id: &str, at: u64) -> NewNote {
        NewNote {
            id: id.into(),
            at_ms: at,
            media: "voice",
        }
    }

    #[test]
    fn notes_older_than_two_thousand_stay() {
        let dir = scratch();
        for n in 0..2_001 {
            let id = format!("false_1555@c.us_{n:016}");
            assert!(matches!(
                claim(&dir, "default", &seed(&id, n), n, 1_000).unwrap(),
                Claim::Owned(_)
            ));
            finish(&dir, "default", &id, "t", n, n, n).unwrap();
        }
        let oldest = load(&dir, "default", "false_1555@c.us_0000000000000000").unwrap();
        assert_eq!(oldest.unwrap().text, "t");
        let newest = load(&dir, "default", &format!("false_1555@c.us_{:016}", 2_000)).unwrap();
        assert!(newest.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_same_token_is_one_row_and_a_fresh_claim_does_not_own_it() {
        let dir = scratch();
        let first = "false_1555@c.us_ABCDEFGHIJKLMNOP";
        let second = "true_1555@c.us_ABCDEFGHIJKLMNOP";
        assert!(matches!(
            claim(&dir, "default", &seed(first, 10), 1, 180_000).unwrap(),
            Claim::Owned(_)
        ));
        finish(&dir, "default", first, "hello", 10, 2, 1).unwrap();
        match claim(&dir, "default", &seed(second, 10), 3, 180_000).unwrap() {
            Claim::Ready(note) => {
                assert_eq!(note.text, "hello");
                assert_eq!(note.token, "ABCDEFGHIJKLMNOP");
            }
            other => panic!("expected the stored note, got {}", claim_name(&other)),
        }
        let conn = open_account(&dir, "default").unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_running_note_is_busy_and_a_stale_one_is_reclaimed() {
        let dir = scratch();
        let id = "false_1555@c.us_ABCDEFGHIJKLMNOP";
        assert!(matches!(
            claim(&dir, "default", &seed(id, 1), 1_000, 180_000).unwrap(),
            Claim::Owned(_)
        ));
        assert!(matches!(
            claim(&dir, "default", &seed(id, 1), 2_000, 180_000).unwrap(),
            Claim::Busy
        ));
        assert!(matches!(
            claim(&dir, "default", &seed(id, 1), 1_000 + 180_000, 180_000).unwrap(),
            Claim::Owned(_)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_late_failure_does_not_drop_the_replacement_claim() {
        let dir = scratch();
        let id = "false_1555@c.us_ABCDEFGHIJKLMNOP";
        let Claim::Owned(first) = claim(&dir, "default", &seed(id, 1), 1_000, 180_000).unwrap()
        else {
            panic!("first claim");
        };
        let Claim::Owned(second) =
            claim(&dir, "default", &seed(id, 1), 1_000 + 180_000, 180_000).unwrap()
        else {
            panic!("second claim");
        };
        assert!(!release(&dir, "default", id, first).unwrap());
        assert!(!finish(&dir, "default", id, "stale", 1, 9, first).unwrap());
        let note = load(&dir, "default", id).unwrap().unwrap();
        assert_eq!(note.state, "running");
        assert_eq!(note.claimed_ms, second);
        assert!(finish(&dir, "default", id, "kept", 1, 10, second).unwrap());
        assert_eq!(load(&dir, "default", id).unwrap().unwrap().text, "kept");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_chat_search_adopts_imported_notes_before_the_account_file_exists() {
        let dir = scratch();
        let json = dir.join("voice-transcripts.json");
        std::fs::write(
            &json,
            br#"{"items":{"false_1555@c.us_ABCDEFGHIJKLMNOP":{"text":"the gate code","at":20},"false_9999@c.us_BBBBBBBBBBBBBBBB":{"text":"other chat","at":30}}}"#,
        )
        .unwrap();
        import_legacy(&dir, &json, &dir.join("voice-transcripts.imported")).unwrap();
        let notes = by_chats(&dir, "default", &["1555@c.us".into()]).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].text, "the gate code");
        let again = by_chats(&dir, "default", &["1555@c.us".into()]).unwrap();
        assert_eq!(again.len(), 1);
        let conn = open_path(&legacy_path(&dir)).unwrap();
        assert!(load_token(&conn, "ABCDEFGHIJKLMNOP").unwrap().is_none());
        assert!(load_token(&conn, "BBBBBBBBBBBBBBBB").unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_translation_claim_wins() {
        let dir = scratch();
        let id = "false_1555@c.us_ABCDEFGHIJKLMNOP";
        claim(&dir, "default", &seed(id, 5), 1, 1_000).unwrap();
        finish(&dir, "default", id, "olá", 5, 2, 1).unwrap();
        let token = "ABCDEFGHIJKLMNOP";
        assert!(claim_translation(&dir, "default", token, "openai|m|en", 10).unwrap());
        assert!(!claim_translation(&dir, "default", token, "openai|m|en", 11).unwrap());
        save_translation(&dir, "default", token, "openai|m|en", "hello").unwrap();
        let note = load(&dir, "default", id).unwrap().unwrap();
        assert_eq!(note.translation.as_deref(), Some("hello"));
        assert_eq!(note.translation_key.as_deref(), Some("openai|m|en"));
        assert!(!claim_translation(&dir, "default", token, "openai|m|en", 12).unwrap());
        assert!(claim_translation(&dir, "default", token, "openai|m|pt", 13).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chats_come_back_in_message_order() {
        let dir = scratch();
        let later = "false_1555@c.us_BBBBBBBBBBBBBBBB";
        let earlier = "false_1555@c.us_AAAAAAAAAAAAAAAA";
        claim(&dir, "default", &seed(later, 300), 1, 1_000).unwrap();
        finish(&dir, "default", later, "later", 300, 1, 1).unwrap();
        claim(&dir, "default", &seed(earlier, 100), 2, 1_000).unwrap();
        finish(&dir, "default", earlier, "earlier", 100, 2, 2).unwrap();
        let notes = by_chats(&dir, "default", &["1555@c.us".into()]).unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].text, "earlier");
        assert_eq!(notes[1].text, "later");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_import_keeps_every_note_and_the_opener_takes_it() {
        let dir = scratch();
        let mut items = serde_json::Map::new();
        for n in 0..2_001 {
            items.insert(
                format!("false_1555@c.us_{n:016}"),
                serde_json::json!({ "text": format!("t{n}"), "at": n }),
            );
        }
        let json = dir.join("voice-transcripts.json");
        std::fs::write(
            &json,
            serde_json::to_vec(&serde_json::json!({ "items": items })).unwrap(),
        )
        .unwrap();
        let marker = dir.join("voice-transcripts.imported");
        import_legacy(&dir, &json, &marker).unwrap();
        assert!(marker.exists());
        import_legacy(&dir, &json, &marker).unwrap();
        let conn = open_path(&legacy_path(&dir)).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2_001);
        let oldest = load_token(&conn, "0000000000000000").unwrap().unwrap();
        assert_eq!(oldest.text, "t0");
        drop(conn);
        let taken = read(&dir, "default", "false_1555@c.us_0000000000000000")
            .unwrap()
            .unwrap();
        assert_eq!(taken.text, "t0");
        let conn = open_path(&legacy_path(&dir)).unwrap();
        assert!(load_token(&conn, "0000000000000000").unwrap().is_none());
        let again = load(&dir, "default", "false_1555@c.us_0000000000000000")
            .unwrap()
            .unwrap();
        assert_eq!(again.text, "t0");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_an_account_removes_its_database() {
        let dir = scratch();
        let id = "false_1555@c.us_ABCDEFGHIJKLMNOP";
        claim(&dir, "acct-3", &seed(id, 1), 1, 1_000).unwrap();
        finish(&dir, "acct-3", id, "t", 1, 1, 1).unwrap();
        let path = db_path(&dir, "acct-3").unwrap();
        assert!(path.exists());
        remove_account(&dir, "acct-3");
        assert!(!path.exists());
        remove_account(&dir, "../default");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn claim_name(claim: &Claim) -> &'static str {
        match claim {
            Claim::Owned(_) => "owned",
            Claim::Ready(_) => "ready",
            Claim::Busy => "busy",
        }
    }
}

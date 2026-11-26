//! Export one reviewed event and hand it to the OS calendar file association.

#[cfg(any(windows, target_os = "macos", test))]
mod event {
    use chrono::{DateTime, FixedOffset, Local, LocalResult, NaiveDateTime, TimeZone, Utc};

    pub(super) fn resolve(value: &str, zone: &str) -> Result<DateTime<Utc>, &'static str> {
        let format = match value.len() {
            16 => "%Y-%m-%dT%H:%M",
            19 => "%Y-%m-%dT%H:%M:%S",
            _ => return Err("invalid_time"),
        };
        let wall = NaiveDateTime::parse_from_str(value, format).map_err(|_| "invalid_time")?;
        let result = if zone.starts_with(['+', '-']) {
            let offset = zone.parse::<FixedOffset>().map_err(|_| "invalid_time")?;
            to_utc(offset.from_local_datetime(&wall))
        } else if zone == "local" {
            to_utc(Local.from_local_datetime(&wall))
        } else {
            let tz = zone.parse::<chrono_tz::Tz>().map_err(|_| "invalid_time")?;
            to_utc(tz.from_local_datetime(&wall))
        };
        match result {
            LocalResult::Single(value) => Ok(value),
            LocalResult::None => Err("missing_time"),
            LocalResult::Ambiguous(_, _) => Err("ambiguous_time"),
        }
    }

    fn to_utc<T: TimeZone>(value: LocalResult<DateTime<T>>) -> LocalResult<DateTime<Utc>> {
        value.map(|time| time.with_timezone(&Utc))
    }

    pub(super) fn encode(
        title: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        uid: &str,
    ) -> String {
        let title = title
            .replace('\\', "\\\\")
            .replace("\r\n", "\\n")
            .replace(['\r', '\n'], "\\n")
            .replace(';', "\\;")
            .replace(',', "\\,");
        let stamp = |t: DateTime<Utc>| t.format("%Y%m%dT%H%M%SZ").to_string();
        let mut file = format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//whatRust//Calendar Event//EN\r\n\
             BEGIN:VEVENT\r\nUID:{uid}@whatrust\r\nDTSTAMP:{}\r\nDTSTART:{}\r\nDTEND:{}\r\nSUMMARY:",
            stamp(Utc::now()), stamp(start), stamp(end),
        );
        let mut width = "SUMMARY:".len();
        for c in title.chars() {
            if width + c.len_utf8() > 75 {
                file.push_str("\r\n ");
                width = 1;
            }
            file.push(c);
            width += c.len_utf8();
        }
        file.push_str("\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
        file
    }
}

#[derive(serde::Deserialize)]
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub struct Draft {
    title: String,
    start: String,
    end: String,
    zone: String,
}

#[cfg(any(windows, target_os = "macos"))]
fn directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|_| "export_failed")?
        .join("calendar-events"))
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn cleanup(app: &tauri::AppHandle) {
    let Ok(dir) = directory(app) else { return };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("whatrust-event-")
            || path.extension().is_none_or(|ext| ext != "ics")
        {
            continue;
        }
        if entry.metadata().is_ok_and(|meta| {
            meta.is_file()
                && meta
                    .modified()
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age.as_secs() >= 24 * 3600)
        }) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tauri::command(async)]
pub fn calendar_event(
    app: tauri::AppHandle,
    window: tauri::Webview,
    draft: Draft,
    save: bool,
) -> Result<bool, String> {
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, window, draft, save);
        Err("unavailable".into())
    }
    #[cfg(any(windows, target_os = "macos"))]
    {
        use std::io::Write;
        use tauri_plugin_dialog::DialogExt;

        let check = || {
            crate::lock::require_unlocked(&app).map_err(|_| "unavailable")?;
            if !window.label().starts_with("wa-") || !crate::settings::load(&app).message_actions {
                return Err("unavailable");
            }
            Ok(())
        };
        check()?;
        let title = draft.title.trim();
        if title.is_empty()
            || title.chars().count() > 160
            || title
                .chars()
                .any(|c| c.is_control() && c != '\r' && c != '\n')
            || draft.zone.len() > 64
        {
            return Err("invalid_event".into());
        }
        let start = event::resolve(&draft.start, &draft.zone)?;
        let end = event::resolve(&draft.end, &draft.zone)?;
        if end <= start {
            return Err("invalid_range".into());
        }
        cleanup(&app);
        let dir = directory(&app)?;
        std::fs::create_dir_all(&dir).map_err(|_| "export_failed")?;
        let mut file = tempfile::Builder::new()
            .prefix("whatrust-event-")
            .suffix(".ics")
            .tempfile_in(dir)
            .map_err(|_| "export_failed")?;
        let uid = file
            .path()
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or("export_failed")?;
        let contents = event::encode(title, start, end, uid);
        if save {
            let picked = app
                .dialog()
                .file()
                .set_title(crate::i18n::tr("Salvar evento"))
                .set_file_name("whatrust-event.ics")
                .add_filter("iCalendar", &["ics"])
                .set_parent(&window.window())
                .blocking_save_file();
            let Some(picked) = picked else {
                return Ok(false);
            };
            check()?;
            let path = picked.into_path().map_err(|_| "export_failed")?;
            if !path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("ics"))
            {
                return Err("export_failed".into());
            }
            std::fs::write(path, contents).map_err(|_| "export_failed")?;
        } else {
            file.write_all(contents.as_bytes())
                .map_err(|_| "export_failed")?;
            check()?;
            let (handle, path) = file.keep().map_err(|_| "export_failed")?;
            drop(handle);
            if crate::opener::open_associated_file(&path).is_err() {
                let _ = std::fs::remove_file(path);
                return Err("open_failed".into());
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::event::{encode, resolve};

    #[test]
    fn refuses_clock_changes_and_respects_explicit_offsets() {
        assert_eq!(
            resolve("2026-03-08T02:15", "America/Denver"),
            Err("missing_time")
        );
        assert_eq!(
            resolve("2026-11-01T01:15", "America/Denver"),
            Err("ambiguous_time")
        );
        assert_eq!(resolve("2026-02-30T01:00", "UTC"), Err("invalid_time"));
        assert_eq!(
            resolve("2026-12-04T15:00", "+02:30").unwrap().to_rfc3339(),
            "2026-12-04T12:30:00+00:00"
        );
    }

    #[test]
    fn exports_one_event_with_escaped_and_folded_summary() {
        let start = resolve("2026-12-04T15:00", "UTC").unwrap();
        let end = resolve("2026-12-04T15:30", "UTC").unwrap();
        let file = encode(
            &format!("Olá, amigo; \\ {}\r\nATTENDEE:example", "á".repeat(80)),
            start,
            end,
            "event",
        );
        assert!(file.contains("DTSTART:20261204T150000Z\r\nDTEND:20261204T153000Z"));
        assert!(file.lines().all(|line| line.len() <= 75));
        let unfolded = file.replace("\r\n ", "");
        assert!(unfolded.contains(&format!(
            "SUMMARY:Olá\\, amigo\\; \\\\ {}\\nATTENDEE:example",
            "á".repeat(80)
        )));
        assert!(!unfolded.contains("\r\nATTENDEE:"));
    }
}

//! Connection status reported by each open WhatsApp account.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    #[default]
    Online,
    Stale,
    Offline,
}

#[derive(Default)]
pub struct SyncHealth(Mutex<HashMap<String, SyncStatus>>);

fn apply_report(
    accounts: &mut HashMap<String, SyncStatus>,
    label: &str,
    status: SyncStatus,
) -> bool {
    let previous = match status {
        SyncStatus::Online => accounts.remove(label),
        _ => accounts.insert(label.to_string(), status),
    };
    previous.unwrap_or_default() != status
}

/// Drop a closed account, or every account when the shared window goes away.
fn forget_label(accounts: &mut HashMap<String, SyncStatus>, label: &str) -> bool {
    if label == "main" {
        let had = !accounts.is_empty();
        accounts.clear();
        had
    } else {
        accounts.remove(label).is_some()
    }
}

fn highest_status(accounts: &HashMap<String, SyncStatus>) -> SyncStatus {
    accounts.values().copied().max().unwrap_or_default()
}

pub fn status(app: &AppHandle) -> SyncStatus {
    let Some(state) = app.try_state::<SyncHealth>() else {
        return SyncStatus::Online;
    };
    let mut accounts = crate::lock::guard(&state.0);
    accounts.retain(|label, _| app.get_webview(label).is_some());
    highest_status(&accounts)
}

pub fn forget(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<SyncHealth>() else {
        return;
    };
    let changed = {
        let mut accounts = crate::lock::guard(&state.0);
        forget_label(&mut accounts, label)
    };
    if changed {
        refresh_tray(app);
    }
}

fn refresh_tray(app: &AppHandle) {
    let ui = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::tray::rebuild_menu(&ui);
        let total = ui
            .try_state::<crate::accounts::UnreadMap>()
            .map(|map| crate::accounts::aggregate_unread(&crate::lock::guard(&map)))
            .unwrap_or(0);
        crate::tray::update_badge(&ui, total);
    });
}

/// Page-side recovery. Falls back to a plain navigation when the hook from
/// `bridge.js` is not on the page yet.
const RECONNECT_JS: &str = "if(typeof window.__whatrustRecoverConnection==='function')window.__whatrustRecoverConnection();else window.location.reload()";

pub fn reconnect_view(view: &tauri::Webview) {
    if view.eval(RECONNECT_JS).is_err() {
        let _ = view.reload();
    }
}

/// Reconnect the accounts that still report a sync problem.
pub fn reconnect_from_tray(app: &AppHandle) {
    let labels: Vec<String> = {
        let Some(state) = app.try_state::<SyncHealth>() else {
            return;
        };
        let accounts = crate::lock::guard(&state.0);
        accounts.keys().cloned().collect()
    };
    for label in labels {
        if let Some(view) = app.get_webview(&label) {
            reconnect_view(&view);
        }
    }
}

#[tauri::command]
pub fn report_sync_status(
    window: tauri::Webview,
    app: tauri::AppHandle,
    status: SyncStatus,
) -> Result<(), String> {
    crate::integration::remote(&window)?;
    crate::lock::require_unlocked(&app)?;
    let label = window.label().to_string();
    if crate::accounts::id_from_label(&label).is_none() {
        return Err("forbidden".into());
    }
    let changed = {
        let state = app.state::<SyncHealth>();
        let mut accounts = crate::lock::guard(&state.0);
        apply_report(&mut accounts, &label, status)
    };
    if changed {
        crate::dlog::log(match status {
            SyncStatus::Online => "sync: account reported online",
            SyncStatus::Stale => "sync: account may have stopped syncing",
            SyncStatus::Offline => "sync: account reported offline",
        });
        refresh_tray(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_report, forget_label, highest_status, SyncStatus::*};
    use std::collections::HashMap;

    #[test]
    fn a_repeat_report_does_not_count_as_a_change() {
        let mut accounts = HashMap::new();
        assert!(apply_report(&mut accounts, "wa-default", Stale));
        assert!(!apply_report(&mut accounts, "wa-default", Stale));
        assert!(apply_report(&mut accounts, "wa-default", Offline));
        assert!(apply_report(&mut accounts, "wa-default", Online));
        assert!(!apply_report(&mut accounts, "wa-default", Online));
        assert!(accounts.is_empty());
    }

    #[test]
    fn the_tray_is_offline_only_when_at_least_one_account_is_offline() {
        let mut accounts = HashMap::new();
        assert_eq!(highest_status(&accounts), Online);
        apply_report(&mut accounts, "wa-default", Offline);
        apply_report(&mut accounts, "wa-acct-2", Stale);
        assert_eq!(highest_status(&accounts), Offline);
        assert!(apply_report(&mut accounts, "wa-default", Online));
        assert_eq!(highest_status(&accounts), Stale);
    }

    #[test]
    fn closing_the_shared_window_clears_every_account() {
        let mut accounts = HashMap::new();
        apply_report(&mut accounts, "wa-default", Offline);
        apply_report(&mut accounts, "wa-acct-2", Stale);
        assert!(forget_label(&mut accounts, "main"));
        assert!(accounts.is_empty());
        assert!(!forget_label(&mut accounts, "main"));
    }

    #[test]
    fn closing_one_account_leaves_the_other() {
        let mut accounts = HashMap::new();
        apply_report(&mut accounts, "wa-default", Stale);
        apply_report(&mut accounts, "wa-acct-2", Offline);
        assert!(forget_label(&mut accounts, "wa-default"));
        assert!(!forget_label(&mut accounts, "wa-default"));
        assert_eq!(accounts.get("wa-acct-2"), Some(&Offline));
        assert_eq!(accounts.len(), 1);
    }
}

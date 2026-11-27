//! Whether an open WhatsApp account has stopped syncing.
//!
//! The page reports it. The tray then says so and offers Reconnect, including
//! when the window was left hidden overnight and the chat list still looks fine.

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct SyncHealth(Mutex<HashSet<String>>);

/// Record one account's report. Returns whether the set actually changed.
pub fn apply_report(offline: &mut HashSet<String>, label: &str, down: bool) -> bool {
    let had = offline.contains(label);
    if down {
        offline.insert(label.to_string());
    } else {
        offline.remove(label);
    }
    had != down
}

/// Drop a closed account, or every account when the shared window goes away.
pub fn forget_label(offline: &mut HashSet<String>, label: &str) -> bool {
    if label == "main" {
        let had = !offline.is_empty();
        offline.clear();
        had
    } else {
        offline.remove(label)
    }
}

pub fn any_offline(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<SyncHealth>() else {
        return false;
    };
    let mut offline = crate::lock::guard(&state.0);
    offline.retain(|label| app.get_webview(label).is_some());
    !offline.is_empty()
}

pub fn forget(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<SyncHealth>() else {
        return;
    };
    let changed = {
        let mut offline = crate::lock::guard(&state.0);
        forget_label(&mut offline, label)
    };
    if changed {
        refresh_tray(app);
    }
}

fn refresh_tray(app: &AppHandle) {
    crate::tray::rebuild_menu(app);
    let total = app
        .try_state::<crate::accounts::UnreadMap>()
        .map(|map| crate::accounts::aggregate_unread(&crate::lock::guard(&map)))
        .unwrap_or(0);
    crate::tray::update_badge(app, total);
}

/// Page-side recovery. Falls back to a plain navigation when the hook from
/// `bridge.js` is not on the page yet.
const RECONNECT_JS: &str = "if(typeof window.__whatrustRecoverConnection==='function')window.__whatrustRecoverConnection();else window.location.reload()";

pub fn reconnect_view(view: &tauri::Webview) {
    if view.eval(RECONNECT_JS).is_err() {
        let _ = view.reload();
    }
}

/// Reconnect every account that reported itself offline. With none reported,
/// reconnect the account the tray already treats as current.
pub fn reconnect_from_tray(app: &AppHandle) {
    let labels: Vec<String> = {
        let Some(state) = app.try_state::<SyncHealth>() else {
            reconnect_active(app);
            return;
        };
        let offline = crate::lock::guard(&state.0);
        offline.iter().cloned().collect()
    };
    if labels.is_empty() {
        reconnect_active(app);
        return;
    }
    for label in labels {
        if let Some(view) = app.get_webview(&label) {
            reconnect_view(&view);
        }
    }
}

fn reconnect_active(app: &AppHandle) {
    let Some(active) = app.try_state::<crate::accounts::ActiveAccount>() else {
        return;
    };
    let label = crate::lock::guard(&active).clone();
    if let Some(view) = app.get_webview(&label) {
        reconnect_view(&view);
    }
}

#[tauri::command]
pub fn report_sync_offline(
    window: tauri::Webview,
    app: tauri::AppHandle,
    offline: bool,
) -> Result<(), String> {
    crate::integration::remote(&window)?;
    crate::lock::require_unlocked(&app)?;
    let label = window.label().to_string();
    if crate::accounts::id_from_label(&label).is_none() {
        return Err("forbidden".into());
    }
    let changed = {
        let state = app.state::<SyncHealth>();
        let mut down = crate::lock::guard(&state.0);
        apply_report(&mut down, &label, offline)
    };
    if changed {
        crate::dlog::log(if offline {
            "sync: account reported offline"
        } else {
            "sync: account reported online"
        });
        refresh_tray(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_report, forget_label};
    use std::collections::HashSet;

    #[test]
    fn a_repeat_report_does_not_count_as_a_change() {
        let mut offline = HashSet::new();
        assert!(apply_report(&mut offline, "wa-default", true));
        assert!(!apply_report(&mut offline, "wa-default", true));
        assert!(apply_report(&mut offline, "wa-default", false));
        assert!(!apply_report(&mut offline, "wa-default", false));
        assert!(offline.is_empty());
    }

    #[test]
    fn accounts_are_tracked_separately() {
        let mut offline = HashSet::new();
        apply_report(&mut offline, "wa-default", true);
        apply_report(&mut offline, "wa-acct-2", true);
        assert!(apply_report(&mut offline, "wa-default", false));
        assert!(offline.contains("wa-acct-2"));
        assert!(!offline.contains("wa-default"));
    }

    #[test]
    fn closing_the_shared_window_clears_every_account() {
        let mut offline = HashSet::new();
        apply_report(&mut offline, "wa-default", true);
        apply_report(&mut offline, "wa-acct-2", true);
        assert!(forget_label(&mut offline, "main"));
        assert!(offline.is_empty());
        assert!(!forget_label(&mut offline, "main"));
    }

    #[test]
    fn closing_one_account_leaves_the_other() {
        let mut offline = HashSet::new();
        apply_report(&mut offline, "wa-default", true);
        apply_report(&mut offline, "wa-acct-2", true);
        assert!(forget_label(&mut offline, "wa-default"));
        assert!(!forget_label(&mut offline, "wa-default"));
        assert!(offline.contains("wa-acct-2"));
        assert_eq!(offline.len(), 1);
    }
}

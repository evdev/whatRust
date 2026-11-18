//! Settings in the macOS menu bar.
//!
//! The menu-bar icon opens the same settings window. This puts that command
//! in the application menu (whatRust → Settings…) and in File, which is where
//! people look when the icon's menu will not open. Command-, is the standard
//! shortcut and lives on the application-menu item.

use std::sync::Once;

use tauri::menu::{MenuItemBuilder, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

const APP_ITEM: &str = "app.preferences";
const FILE_ITEM: &str = "file.preferences";

pub fn install(app: &AppHandle) {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        app.on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == APP_ITEM || id == FILE_ITEM {
                crate::window::open_settings_window(app);
            }
        });
    });

    let Some(menu) = app.menu() else {
        crate::dlog::log("app menu: no menu bar to add Settings to");
        return;
    };
    let Ok(items) = menu.items() else {
        return;
    };

    let mut menus = items
        .into_iter()
        .filter_map(|item| item.as_submenu().cloned());
    // macOS treats the first submenu as the application menu.
    if let Some(app_menu) = menus.next() {
        ensure(app, &app_menu, APP_ITEM, Some("CmdOrCtrl+,"), 2);
    }
    for submenu in menus {
        let Ok(title) = submenu.text() else {
            continue;
        };
        if title == "File" {
            ensure(app, &submenu, FILE_ITEM, None, 0);
        }
    }
}

/// Insert Settings… at `at` if it is not already there, or retitle it after a
/// language change. A separator follows it so it does not sit against Services
/// or Close.
fn ensure<R: Runtime>(
    app: &AppHandle<R>,
    submenu: &Submenu<R>,
    id: &str,
    accelerator: Option<&str>,
    at: usize,
) {
    let label = crate::i18n::tr("Configurações…");
    if let Some(existing) = submenu.get(id) {
        if let Some(item) = existing.as_menuitem() {
            if let Err(e) = item.set_text(label.as_ref()) {
                crate::dlog::log(&format!("app menu: {e}"));
            }
        }
        return;
    }

    let mut builder = MenuItemBuilder::with_id(id, label.as_ref());
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    let Ok(item) = builder.build(app) else {
        crate::dlog::log("app menu: could not build the Settings item");
        return;
    };
    let Ok(separator) = PredefinedMenuItem::separator(app) else {
        return;
    };
    let at = submenu
        .items()
        .map(|items| at.min(items.len()))
        .unwrap_or(0);
    if let Err(e) = submenu.insert_items(&[&item, &separator], at) {
        crate::dlog::log(&format!("app menu: {e}"));
    }
}

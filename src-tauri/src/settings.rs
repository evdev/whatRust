use crate::i18n::trf;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub close_to_tray: bool,
    pub start_minimized: bool,
    pub autostart: bool,
    pub hotkey_enabled: bool,
    pub hotkey: String,
    pub notifications: bool,
    pub notify_when_focused: bool,
    pub notify_active_chat: bool,
    pub respect_muted: bool,
    /// macOS only: the app lives in the menu bar, no Dock icon and no
    /// standard window. Every account stays connected in the background and
    /// opens as a panel from the tray. Off by default. Ignored on other platforms.
    pub menubar_only: bool,
    /// Display zoom for the WhatsApp webview, 1.0 = the site's own sizing.
    pub zoom: f64,
    /// Icon beside a message's time when its id indicates an Apple device,
    /// Android, or a computer. On by default.
    pub show_message_device: bool,
    /// macOS only (issue #44): show the icon in the menu bar. With it off, the
    /// Dock icon brings a hidden window back. Windows and Linux always show the
    /// tray icon, since there it is the only way back to a hidden window.
    pub menu_bar_icon: bool,
    /// Interface language: `en` or `pt-BR`. Defaults to the OS language
    /// (Portuguese for a Portuguese system, English otherwise).
    pub language: String,
    /// Transcribe WhatsApp voice notes with the local FluidVoice API.
    pub voice_transcribe: bool,
    /// FluidVoice local API port. `47733` is FluidVoice's own default.
    pub fluidvoice_port: u16,
    /// Translate each transcript into `translate_target_lang`.
    pub translate_enabled: bool,
    /// Language name passed to the model, for example `English` or `português`.
    pub translate_target_lang: String,
    /// `openrouter`, `gemini` or `anthropic`.
    pub ai_provider: String,
    /// Translation model for each provider. Summaries use the `summary_model_*`
    /// fields and fall back to these when a summary model has not been chosen.
    pub ai_model_openrouter: String,
    pub ai_model_gemini: String,
    pub ai_model_anthropic: String,
    /// `None` means the field was absent, so the translation model is used.
    pub summary_model_openrouter: Option<String>,
    pub summary_model_gemini: Option<String>,
    pub summary_model_anthropic: Option<String>,
    /// Master switch for the per-chat stand-in. Off until the user turns it on.
    pub standin_enabled: bool,
    /// `api`, `claude_cli`, `grok_cli`, or `codex_cli`.
    pub standin_backend: String,
    /// Optional stand-in model for each API provider. Empty uses the summary model.
    pub standin_model_openrouter: Option<String>,
    pub standin_model_gemini: Option<String>,
    pub standin_model_anthropic: Option<String>,
    /// Optional model id passed to a CLI backend.
    pub standin_cli_model: String,
    /// Absolute path to a CLI binary. Empty means look on PATH and the usual install locations.
    pub standin_claude_bin: String,
    pub standin_grok_bin: String,
    pub standin_codex_bin: String,
    /// Seconds to wait after the last incoming message before one reply.
    pub standin_delay_secs: u16,
    /// Stand-in replies allowed in one chat during a rolling hour.
    pub standin_hourly_limit: u16,
}

pub const FLUIDVOICE_PORT_DEFAULT: u16 = 47_733;
pub const DEFAULT_MODEL_OPENROUTER: &str = "google/gemini-2.5-flash";
pub const DEFAULT_MODEL_GEMINI: &str = "gemini-2.5-flash";
pub const DEFAULT_MODEL_ANTHROPIC: &str = "claude-haiku-4-5";

impl Default for Settings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            start_minimized: false,
            autostart: false,
            hotkey_enabled: true,
            hotkey: "CmdOrCtrl+Shift+W".to_string(),
            notifications: true,
            notify_when_focused: true,
            notify_active_chat: true,
            respect_muted: true,
            menubar_only: false,
            zoom: 1.0,
            show_message_device: true,
            menu_bar_icon: true,
            language: crate::i18n::system_default().to_string(),
            voice_transcribe: true,
            fluidvoice_port: FLUIDVOICE_PORT_DEFAULT,
            translate_enabled: false,
            translate_target_lang: "English".into(),
            ai_provider: "openrouter".into(),
            ai_model_openrouter: DEFAULT_MODEL_OPENROUTER.into(),
            ai_model_gemini: DEFAULT_MODEL_GEMINI.into(),
            ai_model_anthropic: DEFAULT_MODEL_ANTHROPIC.into(),
            summary_model_openrouter: None,
            summary_model_gemini: None,
            summary_model_anthropic: None,
            standin_enabled: false,
            standin_backend: "api".into(),
            standin_model_openrouter: None,
            standin_model_gemini: None,
            standin_model_anthropic: None,
            standin_cli_model: String::new(),
            standin_claude_bin: String::new(),
            standin_grok_bin: String::new(),
            standin_codex_bin: String::new(),
            standin_delay_secs: 10,
            standin_hourly_limit: 12,
        }
    }
}

/// A Flatpak build cannot see the host's `claude`, `grok`, or `codex` binaries.
pub fn cli_backends_allowed() -> bool {
    #[cfg(target_os = "linux")]
    {
        flatpak_id().is_none()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

pub fn sanitize_standin_backend(value: &str, cli_ok: bool) -> String {
    if cli_ok && matches!(value, "claude_cli" | "grok_cli" | "codex_cli") {
        value.to_string()
    } else {
        "api".into()
    }
}

fn sanitize_bin(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() || value.len() > 300 || value.chars().any(char::is_control) {
        return String::new();
    }
    if std::path::Path::new(value).is_absolute() {
        value.to_string()
    } else {
        String::new()
    }
}

pub fn sanitize_delay(value: u16) -> u16 {
    value.clamp(5, 60)
}

pub fn sanitize_hourly(value: u16) -> u16 {
    if value == 0 {
        12
    } else {
        value.clamp(1, 60)
    }
}

pub fn start_hidden(preference: bool, args: &[String]) -> bool {
    if args.iter().any(|a| a == "--show") {
        return false;
    }
    if cfg!(windows) {
        // A manual launch from Start or a desktop shortcut has no startup flag
        // and should always show the window. Apply the preference only to OS
        // startup. Accept --minimized for older Run entries, but still respect
        // the saved preference; new entries use the explicit flag below.
        preference
            && args
                .iter()
                .any(|a| a == "--autostart" || a == "--minimized")
    } else {
        preference || args.iter().any(|a| a == "--minimized")
    }
}

/// Zoom bounds. The settings UI only offers four presets inside this range; the
/// clamp exists so a hand-edited settings.json cannot leave the app at a zoom
/// level from which the settings window is unreadable.
pub const ZOOM_MIN: f64 = 0.5;
pub const ZOOM_MAX: f64 = 2.0;

/// Bring a zoom factor into range. A non-finite value (a `null` or a string in
/// the JSON deserialises to the default, but arithmetic in an older build could
/// still have written a NaN) falls back to 1.0 rather than to a bound.
pub fn sanitize_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() {
        zoom.clamp(ZOOM_MIN, ZOOM_MAX)
    } else {
        1.0
    }
}

pub fn sanitize_port(port: u16) -> u16 {
    if port == 0 {
        FLUIDVOICE_PORT_DEFAULT
    } else {
        port
    }
}

pub fn sanitize_provider(provider: &str) -> String {
    match provider {
        "gemini" | "anthropic" => provider.to_string(),
        _ => "openrouter".into(),
    }
}

fn sanitize_model(model: &str, fallback: &str) -> String {
    let model = model.trim();
    if model.is_empty() || model.len() > 120 || model.chars().any(char::is_control) {
        fallback.to_string()
    } else {
        model.to_string()
    }
}

fn sanitize_label(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() || value.len() > 40 || value.chars().any(char::is_control) {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

impl Settings {
    /// Translation model for the selected provider.
    pub fn ai_model(&self) -> &str {
        match self.ai_provider.as_str() {
            "gemini" => self.ai_model_gemini.as_str(),
            "anthropic" => self.ai_model_anthropic.as_str(),
            _ => self.ai_model_openrouter.as_str(),
        }
    }

    /// Summary model for the selected provider.
    pub fn summary_model(&self) -> &str {
        let chosen = match self.ai_provider.as_str() {
            "gemini" => self.summary_model_gemini.as_deref(),
            "anthropic" => self.summary_model_anthropic.as_deref(),
            _ => self.summary_model_openrouter.as_deref(),
        };
        chosen
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .unwrap_or_else(|| self.ai_model())
    }

    /// Model used when the stand-in calls the configured API provider.
    pub fn standin_model(&self) -> &str {
        let chosen = match self.ai_provider.as_str() {
            "gemini" => self.standin_model_gemini.as_deref(),
            "anthropic" => self.standin_model_anthropic.as_deref(),
            _ => self.standin_model_openrouter.as_deref(),
        };
        chosen
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .unwrap_or_else(|| self.summary_model())
    }

    /// Repair values an older or hand-edited settings.json can carry.
    pub fn sanitized(mut self) -> Self {
        self.zoom = sanitize_zoom(self.zoom);
        self.language = crate::i18n::sanitize_code(&self.language);
        self.fluidvoice_port = sanitize_port(self.fluidvoice_port);
        self.translate_target_lang = sanitize_label(&self.translate_target_lang, "English");
        self.ai_provider = sanitize_provider(&self.ai_provider);
        self.ai_model_openrouter =
            sanitize_model(&self.ai_model_openrouter, DEFAULT_MODEL_OPENROUTER);
        self.ai_model_gemini = sanitize_model(&self.ai_model_gemini, DEFAULT_MODEL_GEMINI);
        self.ai_model_anthropic = sanitize_model(&self.ai_model_anthropic, DEFAULT_MODEL_ANTHROPIC);
        self.summary_model_openrouter = Some(sanitize_model(
            self.summary_model_openrouter.as_deref().unwrap_or(""),
            &self.ai_model_openrouter,
        ));
        self.summary_model_gemini = Some(sanitize_model(
            self.summary_model_gemini.as_deref().unwrap_or(""),
            &self.ai_model_gemini,
        ));
        self.summary_model_anthropic = Some(sanitize_model(
            self.summary_model_anthropic.as_deref().unwrap_or(""),
            &self.ai_model_anthropic,
        ));
        self.standin_backend =
            sanitize_standin_backend(&self.standin_backend, cli_backends_allowed());
        self.standin_model_openrouter = Some(sanitize_model(
            self.standin_model_openrouter.as_deref().unwrap_or(""),
            &self.summary_model_openrouter.clone().unwrap_or_default(),
        ));
        self.standin_model_gemini = Some(sanitize_model(
            self.standin_model_gemini.as_deref().unwrap_or(""),
            &self.summary_model_gemini.clone().unwrap_or_default(),
        ));
        self.standin_model_anthropic = Some(sanitize_model(
            self.standin_model_anthropic.as_deref().unwrap_or(""),
            &self.summary_model_anthropic.clone().unwrap_or_default(),
        ));
        self.standin_cli_model = sanitize_model(&self.standin_cli_model, "");
        self.standin_claude_bin = sanitize_bin(&self.standin_claude_bin);
        self.standin_grok_bin = sanitize_bin(&self.standin_grok_bin);
        self.standin_codex_bin = sanitize_bin(&self.standin_codex_bin);
        self.standin_delay_secs = sanitize_delay(self.standin_delay_secs);
        self.standin_hourly_limit = sanitize_hourly(self.standin_hourly_limit);
        // Menu-bar-only mode needs WKWebView's inactive-scheduling policy
        // (macOS 14+). Dropping the flag here means a settings file or an
        // older build can never leave the app in a mode it cannot sustain.
        #[cfg(target_os = "macos")]
        if !crate::menubar::supported() {
            self.menubar_only = false;
        }
        self
    }
}

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
fn is_valid_flatpak_id(id: &str) -> bool {
    id.len() <= 255
        && id.split('.').count() >= 3
        && id.split('.').all(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

#[cfg(target_os = "linux")]
pub(crate) fn flatpak_id() -> Option<String> {
    std::env::var("FLATPAK_ID")
        .ok()
        .filter(|id| is_valid_flatpak_id(id))
}

#[cfg(target_os = "linux")]
fn flatpak_autostart_entry(flatpak_id: &str) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Version=1.0\n\
         Name=whatRust\n\
         Comment=Start whatRust minimized\n\
         Exec=flatpak run --command=whatrust {flatpak_id} --minimized\n\
         Icon={flatpak_id}\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n\
         X-Flatpak={flatpak_id}\n"
    )
}

#[cfg(target_os = "linux")]
fn apply_flatpak_autostart(flatpak_id: &str, enabled: bool) -> std::io::Result<()> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "HOME is not set"))?;
    let dir = home.join(".config/autostart");
    let path = dir.join(format!("{flatpak_id}.desktop"));
    if enabled {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(path, flatpak_autostart_entry(flatpak_id))
    } else if path.exists() {
        std::fs::remove_file(path)
    } else {
        Ok(())
    }
}

fn settings_path(app: &AppHandle) -> tauri::Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    use crate::jsonfile::Loaded;
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    match crate::jsonfile::read::<Settings>(&path) {
        Loaded::Ok(s) | Loaded::Recovered(s) => s.sanitized(),
        Loaded::Missing => Settings::default(),
        Loaded::Corrupt => {
            crate::jsonfile::preserve_corrupt(&path);
            Settings::default()
        }
    }
}

pub fn save(app: &AppHandle, s: &Settings) -> tauri::Result<()> {
    let path = settings_path(app)?;
    crate::jsonfile::save(&path, s)?;
    Ok(())
}

/// Apply side effects of settings (autostart + global shortcut + the macOS menu bar).
/// Returns any non-fatal side-effect failures as one warning string;
/// persisted settings and zoom changes are still applied.
pub fn apply(app: &AppHandle, s: &Settings) -> Option<String> {
    // Zoom is a webview property, so it applies on every platform and takes
    // effect on the open account windows without a reload.
    let lang = crate::i18n::Lang::from_code(&s.language);
    if lang != crate::i18n::current() {
        crate::i18n::set(lang);
        crate::i18n::refresh(app);
    }
    crate::window::apply_zoom_all(app, s.zoom);

    // Menu-bar mode is only available where a hidden WKWebView keeps running
    // (macOS 14+); elsewhere the setting is ignored rather than dropping every
    // account's session the moment it is enabled.
    #[cfg(target_os = "macos")]
    let menubar_only = s.menubar_only && crate::menubar::supported();

    // In menu-bar-only mode the tray icon is the app's only entry point, so
    // it can never be hidden.
    #[cfg(target_os = "macos")]
    crate::tray::apply_visibility(app, s.menu_bar_icon || menubar_only);
    #[cfg(not(target_os = "macos"))]
    crate::tray::apply_visibility(app, s.menu_bar_icon);

    // macOS menu-bar mode: reconcile the live window set with the settings.
    #[cfg(target_os = "macos")]
    {
        if menubar_only {
            crate::menubar::enter_only(app);
        } else if crate::menubar::leave_only(app) {
            // Leaving menu-bar-only mode: reopen missing windows and show the
            // active one, so the app is never left with no visible window.
            for a in crate::accounts::load(app).accounts {
                let label = crate::accounts::window_label(&a.id);
                if app.get_webview_window(&label).is_none() {
                    let _ = crate::window::open_account_window(app, &a, true);
                }
            }
            crate::window::show_active(app);
        }

        // Menu-bar-only apps have no Dock presence.
        let policy = if menubar_only {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        let h = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = h.set_activation_policy(policy);
        });

        // App Nap would suspend the process after the windows have been hidden
        // or left idle, and WhatsApp's socket would die with it. The activity
        // allows the Mac to sleep; it only stops the app itself from being napped.
        crate::menubar::set_keep_alive(true);
    }

    #[cfg(desktop)]
    {
        let mut warnings = Vec::new();

        #[cfg(target_os = "linux")]
        let flatpak_autostart_handled = flatpak_id()
            .map(|id| {
                if let Err(e) = apply_flatpak_autostart(&id, s.autostart) {
                    warnings.push(trf(
                        "Não foi possível atualizar a inicialização automática: {0}",
                        &[&e],
                    ));
                }
                true
            })
            .unwrap_or(false);
        #[cfg(not(target_os = "linux"))]
        let flatpak_autostart_handled = false;

        if !flatpak_autostart_handled {
            use tauri_plugin_autostart::ManagerExt;
            let autostart = app.autolaunch();
            let result = if s.autostart {
                autostart.enable()
            } else {
                // Windows reports NotFound when removing a Run entry that isn't
                // there, so turning off what is already off would warn.
                autostart
                    .is_enabled()
                    .and_then(|on| if on { autostart.disable() } else { Ok(()) })
            };
            if let Err(e) = result {
                warnings.push(trf(
                    "Não foi possível atualizar a inicialização automática: {0}",
                    &[&e],
                ));
            }
        }

        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();
        if s.hotkey_enabled && !s.hotkey.trim().is_empty() {
            if let Err(e) = gs.register(s.hotkey.as_str()) {
                warnings.push(trf(
                    "Não foi possível registrar o atalho (ele pode estar em uso): {0}",
                    &[&e],
                ));
            }
        }
        if warnings.is_empty() {
            None
        } else {
            Some(warnings.join("; "))
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, s);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{
        sanitize_zoom, Settings, DEFAULT_MODEL_OPENROUTER, FLUIDVOICE_PORT_DEFAULT, ZOOM_MAX,
        ZOOM_MIN,
    };

    #[cfg(target_os = "linux")]
    use super::{flatpak_autostart_entry, is_valid_flatpak_id};

    #[test]
    fn old_settings_enable_new_notification_preferences() {
        let s: Settings = serde_json::from_str(r#"{"notifications":false}"#).unwrap();
        assert!(!s.notifications);
        assert!(s.notify_when_focused && s.notify_active_chat && s.respect_muted);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn flatpak_id_validation_blocks_path_and_desktop_entry_injection() {
        assert!(is_valid_flatpak_id("io.github.karem505.whatRust"));
        assert!(!is_valid_flatpak_id("../../autostart"));
        assert!(!is_valid_flatpak_id("io.github.karem505.whatRust\nExec=sh"));
        assert!(!is_valid_flatpak_id("io..whatRust"));
        assert!(!is_valid_flatpak_id("io.github.505whatRust"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn flatpak_autostart_entry_reenters_the_sandbox() {
        let entry = flatpak_autostart_entry("io.github.karem505.whatRust");
        assert!(entry.contains(
            "Exec=flatpak run --command=whatrust io.github.karem505.whatRust --minimized"
        ));
        assert!(entry.contains("Icon=io.github.karem505.whatRust"));
        assert!(entry.contains("X-Flatpak=io.github.karem505.whatRust"));
        assert!(!entry.contains("Exec=/app/bin/whatrust"));
    }

    #[test]
    fn defaults_are_sane() {
        let s = Settings::default();
        assert!(s.close_to_tray);
        assert!(s.notifications);
        // The menu-bar mode is opt-in.
        assert!(!s.menubar_only);
        assert_eq!(s.hotkey, "CmdOrCtrl+Shift+W");
        assert!(!s.autostart);
        assert_eq!(s.zoom, 1.0);
        assert!(s.menu_bar_icon);
    }

    #[test]
    fn zoom_presets_survive_sanitizing() {
        for z in [0.75, 0.85, 1.0, 1.15] {
            assert_eq!(sanitize_zoom(z), z);
        }
    }

    #[test]
    fn out_of_range_zoom_is_clamped() {
        assert_eq!(sanitize_zoom(0.01), ZOOM_MIN);
        assert_eq!(sanitize_zoom(9.0), ZOOM_MAX);
        assert_eq!(sanitize_zoom(-1.0), ZOOM_MIN);
    }

    #[test]
    fn non_finite_zoom_falls_back_to_unscaled() {
        assert_eq!(sanitize_zoom(f64::NAN), 1.0);
        assert_eq!(sanitize_zoom(f64::INFINITY), 1.0);
    }

    #[test]
    fn zoom_from_json_is_sanitized() {
        let s: Settings = serde_json::from_str(r#"{"zoom": 12}"#).unwrap();
        assert_eq!(s.sanitized().zoom, ZOOM_MAX);
        // Absent in a settings.json written by an older build.
        let s: Settings = serde_json::from_str(r#"{"autostart": true}"#).unwrap();
        assert_eq!(s.sanitized().zoom, 1.0);
    }

    #[test]
    fn partial_json_fills_defaults() {
        let s: Settings = serde_json::from_str(r#"{"autostart": true}"#).unwrap();
        assert!(s.autostart);
        assert!(s.close_to_tray);
        assert_eq!(s.hotkey, "CmdOrCtrl+Shift+W");
        // Absent in a settings.json written before issue #44: keep the icon.
        assert!(s.menu_bar_icon);
        assert!(s.voice_transcribe);
        assert!(s.show_message_device);
        assert_eq!(s.fluidvoice_port, FLUIDVOICE_PORT_DEFAULT);
        assert!(!s.translate_enabled);
        assert_eq!(s.ai_provider, "openrouter");
    }

    #[test]
    fn voice_settings_are_repaired() {
        let s: Settings = serde_json::from_str(
            r#"{"fluidvoice_port":0,"ai_provider":"nope","ai_model_gemini":"  gemini-2.5-flash  ","translate_target_lang":"português"}"#,
        )
        .unwrap();
        let s = s.sanitized();
        assert_eq!(s.fluidvoice_port, FLUIDVOICE_PORT_DEFAULT);
        assert_eq!(s.ai_provider, "openrouter");
        assert_eq!(s.ai_model_gemini, "gemini-2.5-flash");
        assert_eq!(s.translate_target_lang, "português");
        assert_eq!(s.ai_model(), DEFAULT_MODEL_OPENROUTER);
        assert_eq!(s.summary_model_gemini.as_deref(), Some("gemini-2.5-flash"));
        assert_eq!(s.summary_model(), DEFAULT_MODEL_OPENROUTER);
    }

    #[test]
    fn summary_model_can_differ_from_the_translation_model() {
        let s: Settings = serde_json::from_str(
            r#"{"ai_provider":"anthropic","ai_model_anthropic":"claude-haiku-5-5","summary_model_anthropic":"claude-sonnet-5-5"}"#,
        )
        .unwrap();
        let s = s.sanitized();
        assert_eq!(s.ai_model(), "claude-haiku-5-5");
        assert_eq!(s.summary_model(), "claude-sonnet-5-5");
    }

    #[test]
    fn missing_summary_model_follows_the_translation_model() {
        let s: Settings = serde_json::from_str(
            r#"{"ai_provider":"gemini","ai_model_gemini":"gemini-3.8-flash"}"#,
        )
        .unwrap();
        assert!(s.summary_model_gemini.is_none());
        let s = s.sanitized();
        assert_eq!(s.summary_model(), "gemini-3.8-flash");
    }

    #[test]
    fn empty_json_is_all_defaults() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn roundtrip() {
        let s = Settings {
            autostart: true,
            hotkey: "Ctrl+Alt+W".into(),
            ..Default::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }
    #[test]
    fn explicit_foreground_launch_overrides_background_preference() {
        let args = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(super::start_hidden(true, &args(&[])), !cfg!(windows));
        assert_eq!(
            super::start_hidden(false, &args(&["--minimized"])),
            !cfg!(windows)
        );
        assert!(!super::start_hidden(true, &args(&["--show"])));
        assert!(!super::start_hidden(
            true,
            &args(&["--show", "--minimized"])
        ));
        assert!(!super::start_hidden(false, &args(&[])));
    }

    #[cfg(windows)]
    #[test]
    fn start_minimized_only_affects_system_autostart() {
        assert!(!super::start_hidden(true, &[]));
        assert!(super::start_hidden(true, &["--autostart".into()]));
        assert!(!super::start_hidden(false, &["--autostart".into()]));
        assert!(!super::start_hidden(false, &["--minimized".into()]));
        assert!(!super::start_hidden(
            true,
            &["--autostart".into(), "--show".into()]
        ));
    }
}

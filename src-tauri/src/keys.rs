//! API keys for AI providers.
//!
//! The key lives in a `0600` file under the app config directory. It never
//! goes in `settings.json` and never reaches the WhatsApp webview. Settings
//! can display a masked prefix. The macOS
//! login keychain is not used: this app is ad-hoc signed, so that keychain
//! cannot remember an "Always Allow" choice and asks for the login password
//! on every launch. WebKit's own master key is the same problem and is
//! handled in `webcrypto`. A missing key is `Ok(None)`, not an error.

use tauri::AppHandle;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

static WRITE_GATE: Mutex<()> = Mutex::new(());

pub fn known_provider(provider: &str) -> bool {
    matches!(
        provider,
        "openrouter"
            | "gemini"
            | "anthropic"
            | "attention_openai"
            | "attention_gemini"
            | "attention_jev"
    )
}

/// Empty `key` deletes the stored secret. Rejects control characters and
/// oversized values so a paste cannot smuggle a header or a huge blob.
pub fn set_key(app: &AppHandle, provider: &str, key: &str) -> Result<(), &'static str> {
    if !known_provider(provider) {
        return Err("bad_provider");
    }
    let key = key.trim();
    if key.len() > 512 || key.chars().any(char::is_control) {
        return Err("bad_key");
    }
    if key.is_empty() {
        return delete_key(app, provider);
    }
    store_secret(app, provider, key)
}

pub fn get_key(app: &AppHandle, provider: &str) -> Result<Option<String>, &'static str> {
    if !known_provider(provider) {
        return Err("bad_provider");
    }
    read_secret(app, provider)
}

pub fn has_key(app: &AppHandle, provider: &str) -> bool {
    matches!(get_key(app, provider), Ok(Some(key)) if !key.is_empty())
}

pub(crate) fn preview_for(app: &AppHandle, provider: &str) -> Option<String> {
    masked_preview(&get_key(app, provider).ok()??)
}

pub(crate) fn masked_preview(key: &str) -> Option<String> {
    if key.is_empty() {
        return None;
    }
    match key.char_indices().nth(10) {
        Some((end, _)) => Some(format!("{}••••", &key[..end])),
        // A short key must still have a hidden portion.
        None => Some("••••".into()),
    }
}

fn store_secret(app: &AppHandle, provider: &str, key: &str) -> Result<(), &'static str> {
    write_store(&store_path(app)?, provider, key)
}

fn read_secret(app: &AppHandle, provider: &str) -> Result<Option<String>, &'static str> {
    read_store(&store_path(app)?, provider)
}

fn delete_key(app: &AppHandle, provider: &str) -> Result<(), &'static str> {
    write_store(&store_path(app)?, provider, "")
}

fn store_path(app: &AppHandle) -> Result<PathBuf, &'static str> {
    let dir = app.path().app_config_dir().map_err(|_| "keychain")?;
    std::fs::create_dir_all(&dir).map_err(|_| "keychain")?;
    Ok(dir.join("ai-keys.json"))
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    keys: BTreeMap<String, String>,
}

pub(crate) fn write_store(path: &Path, provider: &str, key: &str) -> Result<(), &'static str> {
    let _gate = crate::lock::guard(&WRITE_GATE);
    let mut store = match crate::jsonfile::read(path) {
        crate::jsonfile::Loaded::Ok(store) | crate::jsonfile::Loaded::Recovered(store) => store,
        crate::jsonfile::Loaded::Missing => Store::default(),
        crate::jsonfile::Loaded::Corrupt => return Err("keychain"),
    };
    if key.is_empty() {
        store.keys.remove(provider);
    } else {
        store.keys.insert(provider.to_string(), key.to_string());
    }
    crate::jsonfile::save(path, &store).map_err(|_| "keychain")?;
    // The atomic writer leaves the previous copy in a `.bak` created with the
    // process umask. Both copies hold the key, so both must be owner-only.
    restrict(path);
    for extra in crate::jsonfile::sidecar_paths(path) {
        restrict(&extra);
    }
    Ok(())
}

fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

pub(crate) fn read_store(path: &Path, provider: &str) -> Result<Option<String>, &'static str> {
    Ok(read_all(path)
        .keys
        .remove(provider)
        .filter(|key| !key.is_empty()))
}

fn read_all(path: &Path) -> Store {
    match crate::jsonfile::read(path) {
        crate::jsonfile::Loaded::Ok(store) | crate::jsonfile::Loaded::Recovered(store) => store,
        _ => Store::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("whatrust-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("ai-keys.json")
    }

    #[test]
    fn file_store_round_trips_and_deletes() {
        let path = scratch();
        write_store(&path, "gemini", "secret-value").unwrap();
        assert_eq!(
            read_store(&path, "gemini").unwrap().as_deref(),
            Some("secret-value")
        );
        write_store(&path, "openrouter", "other").unwrap();
        write_store(&path, "gemini", "").unwrap();
        assert_eq!(read_store(&path, "gemini").unwrap(), None);
        assert_eq!(
            read_store(&path, "openrouter").unwrap().as_deref(),
            Some("other")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            let bak = crate::jsonfile::backup_path(&path);
            let bak_mode = std::fs::metadata(&bak).unwrap().permissions().mode() & 0o777;
            assert_eq!(bak_mode, 0o600);
        }
    }

    #[test]
    fn unknown_provider_names_are_rejected() {
        assert!(!known_provider(""));
        assert!(!known_provider("openai"));
        assert!(known_provider("anthropic"));
    }

    #[test]
    fn previews_mask_the_rest_and_keep_short_keys_hidden() {
        assert_eq!(masked_preview(""), None);
        assert_eq!(masked_preview("0123456789").as_deref(), Some("••••"));
        assert_eq!(
            masked_preview("0123456789private").as_deref(),
            Some("0123456789••••"),
        );
        assert_eq!(
            masked_preview("αβγδεζηθικλμ").as_deref(),
            Some("αβγδεζηθικ••••"),
        );
    }

    #[test]
    fn a_save_preserves_an_unreadable_key_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai-keys.json");
        std::fs::write(&path, b"{ damaged").unwrap();
        assert_eq!(
            write_store(&path, "gemini", "synthetic-key"),
            Err("keychain")
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"{ damaged");
    }

    #[test]
    fn replacing_a_provider_key_preserves_the_other_provider_and_feature_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai-keys.json");
        let entries = [
            ("openrouter", "example-or-current"),
            ("gemini", "example-gemini-text"),
            ("attention_gemini", "example-gemini-decisions"),
            ("attention_openai", "example-openai-before"),
        ];
        for (provider, key) in entries {
            write_store(&path, provider, key).unwrap();
        }
        write_store(&path, "attention_openai", "example-openai-after").unwrap();
        for (provider, key) in entries.into_iter().take(3) {
            assert_eq!(read_store(&path, provider).unwrap().as_deref(), Some(key));
        }
        assert_eq!(
            read_store(&path, "attention_openai").unwrap().as_deref(),
            Some("example-openai-after"),
        );
    }
}

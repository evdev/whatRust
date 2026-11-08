//! API keys for translation and summaries.
//!
//! The key lives in a `0600` file under the app config directory. It never
//! goes in `settings.json` and never reaches the WhatsApp webview. The macOS
//! login keychain is not used: this app is ad-hoc signed, so that keychain
//! cannot remember an "Always Allow" choice and asks for the login password
//! on every launch. WebKit's own master key is the same problem and is
//! handled in `webcrypto`. A missing key is `Ok(None)`, not an error.

use tauri::AppHandle;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub fn known_provider(provider: &str) -> bool {
    matches!(provider, "openrouter" | "gemini" | "anthropic")
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
    let mut store = read_all(path);
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
}

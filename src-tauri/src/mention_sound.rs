//! The mention chime. Sound-only alerts play here, in the app process, so they
//! do not depend on a popup or on the WhatsApp page. A replaced file is a copy
//! kept in the config directory; anything else falls back to the bundled chime.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const BUNDLED: &[u8] = include_bytes!("../../settings-ui/mention.wav");
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
const PLAY_LIMIT: &str = "8";

pub fn is_stored_name(name: &str) -> bool {
    let Some(ext) = name.strip_prefix("mention-alert.") else {
        return false;
    };
    matches!(ext, "wav" | "mp3" | "ogg" | "m4a" | "aac" | "flac") && !name.contains(['/', '\\'])
}

pub fn stored_name(ext: &str) -> Option<String> {
    let ext = ext.to_ascii_lowercase();
    let name = format!("mention-alert.{ext}");
    is_stored_name(&name).then_some(name)
}

pub fn looks_like_audio(bytes: &[u8], ext: &str) -> bool {
    let ext = ext.to_ascii_lowercase();
    match ext.as_str() {
        "wav" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE",
        "mp3" => {
            bytes.len() > 2
                && (&bytes[..3] == b"ID3" || (bytes[0] == 0xFF && matches!(bytes[1] & 0xE0, 0xE0)))
        }
        "ogg" => bytes.len() >= 4 && &bytes[..4] == b"OggS",
        "flac" => bytes.len() >= 4 && &bytes[..4] == b"fLaC",
        "m4a" | "aac" => {
            bytes.len() >= 8
                && (&bytes[4..8] == b"ftyp"
                    || (bytes[0] == 0xFF && matches!(bytes[1], 0xF1 | 0xF9)))
        }
        _ => false,
    }
}

pub fn validate_picked(path: &Path) -> Result<(String, Vec<u8>), String> {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .ok_or_else(|| crate::i18n::tr("O arquivo não é um áudio aceito.").into_owned())?;
    let name = stored_name(ext)
        .ok_or_else(|| crate::i18n::tr("O arquivo não é um áudio aceito.").into_owned())?;
    let meta = std::fs::metadata(path).map_err(|err| err.to_string())?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(crate::i18n::tr("O arquivo não é um áudio aceito.").into_owned());
    }
    if meta.len() > MAX_BYTES {
        return Err(crate::i18n::tr("O áudio tem mais de 5 MB.").into_owned());
    }
    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    if !looks_like_audio(&bytes, ext) {
        return Err(crate::i18n::tr("O arquivo não é um áudio aceito.").into_owned());
    }
    Ok((name, bytes))
}

pub fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

pub fn is_present(app: &AppHandle, name: &str) -> bool {
    stored_path(app, name).is_some_and(|path| path.is_file())
}

pub fn stored_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    if !is_stored_name(name) {
        return None;
    }
    Some(config_dir(app)?.join(name))
}

pub fn install(app: &AppHandle, name: &str, bytes: &[u8]) -> Result<(), String> {
    if !is_stored_name(name) || !looks_like_audio(bytes, name.rsplit('.').next().unwrap_or("")) {
        return Err(crate::i18n::tr("O arquivo não é um áudio aceito.").into_owned());
    }
    let dir = config_dir(app)
        .ok_or_else(|| crate::i18n::tr("Não foi possível guardar o som.").into_owned())?;
    clear_dir(&dir);
    std::fs::write(dir.join(name), bytes).map_err(|err| err.to_string())
}

pub fn clear_stored(app: &AppHandle) {
    if let Some(dir) = config_dir(app) {
        clear_dir(&dir);
    }
}

fn clear_dir(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if is_stored_name(&name.to_string_lossy()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Play the chosen file, or the bundled chime when that file is missing or
/// the player cannot open it. Overlapping alerts share one playback.
pub fn play(app: &AppHandle) {
    let custom = crate::settings::load(app)
        .mention_alert_sound_file
        .as_deref()
        .and_then(|name| stored_path(app, name))
        .filter(|path| path.is_file());
    std::thread::spawn(move || {
        let Ok(_guard) = PLAYING.try_lock() else {
            return;
        };
        if let Some(path) = custom {
            if play_file(&path) {
                return;
            }
        }
        if let Some(path) = bundled_file() {
            let _ = play_file(&path);
        }
    });
}

static PLAYING: Mutex<()> = Mutex::new(());

fn bundled_file() -> Option<PathBuf> {
    let path = std::env::temp_dir().join("whatrust-mention.wav");
    let fresh = path.is_file()
        && std::fs::metadata(&path)
            .map(|m| m.len() == BUNDLED.len() as u64)
            .unwrap_or(false);
    if !fresh {
        std::fs::write(&path, BUNDLED).ok()?;
    }
    Some(path)
}

fn play_file(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        Command::new("afplay")
            .arg("-t")
            .arg(PLAY_LIMIT)
            .arg(path)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(target_os = "linux")]
    {
        for player in ["pw-play", "paplay"] {
            let status = Command::new("timeout")
                .arg(PLAY_LIMIT)
                .arg(player)
                .arg(path)
                .status();
            match status {
                // Killed by `timeout` after the cap: the chime played its
                // full share. Treat it as success instead of falling through
                // to the next player and holding the one-playback lock longer.
                Ok(status) if status.success() => return true,
                Ok(status) if status.code() == Some(124) => return true,
                _ => {}
            }
        }
        Command::new("ffplay")
            .args([
                "-nodisp",
                "-autoexit",
                "-loglevel",
                "quiet",
                "-t",
                PLAY_LIMIT,
            ])
            .arg(path)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        play_windows(path)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = (path, PLAY_LIMIT);
        false
    }
}

#[cfg(windows)]
fn play_windows(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "wav" && play_windows_wav(path) {
        return true;
    }
    Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$p = New-Object System.Windows.Media.MediaPlayer; \
             $p.Open([uri]$env:WHATRUST_SOUND); $p.Play(); \
             Start-Sleep -Seconds 8; $p.Stop()",
        ])
        .env("WHATRUST_SOUND", path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn play_windows_wav(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let started = unsafe {
        PlaySoundW(
            PCWSTR(wide.as_ptr()),
            None,
            SND_FILENAME | SND_ASYNC | SND_NODEFAULT,
        )
        .0 != 0
    };
    if started {
        std::thread::sleep(std::time::Duration::from_secs(
            PLAY_LIMIT.parse().unwrap_or(8),
        ));
        unsafe {
            let _ = PlaySoundW(PCWSTR::null(), None, SND_NODEFAULT);
        }
    }
    started
}

#[cfg(test)]
mod tests {
    use super::{is_stored_name, looks_like_audio, stored_name, BUNDLED};

    #[test]
    fn only_the_copied_file_name_is_accepted() {
        assert!(is_stored_name("mention-alert.mp3"));
        assert!(is_stored_name("mention-alert.wav"));
        assert!(!is_stored_name("mention-alert.exe"));
        assert!(!is_stored_name("../mention-alert.wav"));
        assert!(!is_stored_name("mention-alert.wav/extra"));
        assert!(!is_stored_name("/tmp/mention-alert.wav"));
        assert_eq!(stored_name("MP3").as_deref(), Some("mention-alert.mp3"));
        assert!(stored_name("txt").is_none());
    }

    #[test]
    fn headers_have_to_match_the_extension() {
        assert!(looks_like_audio(b"RIFFxxxxWAVE", "wav"));
        assert!(!looks_like_audio(b"RIFFxxxxWAVE", "mp3"));
        assert!(looks_like_audio(b"ID3\x03", "mp3"));
        assert!(looks_like_audio(&[0xFF, 0xFB, 0x90], "mp3"));
        assert!(looks_like_audio(b"OggSxxxx", "ogg"));
        assert!(looks_like_audio(b"fLaCxxxx", "flac"));
        assert!(looks_like_audio(b"xxxxftyp", "m4a"));
        assert!(!looks_like_audio(b"not audio", "wav"));
    }

    #[test]
    fn the_bundled_chime_is_a_wav() {
        assert!(looks_like_audio(BUNDLED, "wav"));
        assert!(BUNDLED.len() < 20_000);
    }
}

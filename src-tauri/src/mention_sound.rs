//! The mention chime. Sound-only alerts play here, in the app process, so they
//! do not depend on a popup or on the WhatsApp page. Each account has its own
//! copied file. Anything else falls back to that account's built-in chime.
//! The `default` account keeps the original chime. `acct-1`, `acct-2`, and
//! `acct-3` use three other tones, then the extra tones repeat.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const BUNDLED: &[u8] = include_bytes!("../../settings-ui/mention.wav");
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
const PLAY_LIMIT: &str = "8";

/// `default`, or `acct-` followed by digits. Those are the only ids this app
/// assigns, and the sound file name is built from the id.
pub fn is_account_id(id: &str) -> bool {
    if id == "default" {
        return true;
    }
    let Some(rest) = id.strip_prefix("acct-") else {
        return false;
    };
    !rest.is_empty() && rest.len() <= 10 && rest.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_audio_ext(ext: &str) -> bool {
    matches!(ext, "wav" | "mp3" | "ogg" | "m4a" | "aac" | "flac")
}

/// The single file used before sounds were stored per account: `mention-alert.mp3`.
pub fn is_legacy_name(name: &str) -> bool {
    name.strip_prefix("mention-alert.")
        .is_some_and(is_audio_ext)
}

/// `mention-alert.{accountId}.{ext}`.
pub fn account_of_sound(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("mention-alert.")?;
    let (id, ext) = rest.rsplit_once('.')?;
    if is_account_id(id) && is_audio_ext(ext) {
        Some(id)
    } else {
        None
    }
}

pub fn is_stored_name(name: &str) -> bool {
    is_legacy_name(name) || account_of_sound(name).is_some()
}

pub fn stored_name(account_id: &str, ext: &str) -> Option<String> {
    if !is_account_id(account_id) {
        return None;
    }
    let ext = ext.to_ascii_lowercase();
    if !is_audio_ext(&ext) {
        return None;
    }
    let name = format!("mention-alert.{account_id}.{ext}");
    account_of_sound(&name).is_some().then_some(name)
}

/// `0` is the original chime and is reserved for the `default` account.
/// Keep this in step with `builtinIndex` in settings-ui/mention-alert.js.
/// The spoken names (chime, bell, ping, tone) live in that file.
pub fn builtin_index(account_id: &str) -> usize {
    if account_id == "default" {
        return 0;
    }
    let n = account_id
        .strip_prefix("acct-")
        .and_then(|rest| rest.parse::<u32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1);
    (n as usize - 1) % 3 + 1
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

/// The extension and the file bytes. The stored name depends on the account.
pub fn validate_picked(path: &Path) -> Result<(String, Vec<u8>), String> {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .ok_or_else(|| crate::i18n::tr("O arquivo não é um áudio aceito.").into_owned())?
        .to_ascii_lowercase();
    if !is_audio_ext(&ext) {
        return Err(crate::i18n::tr("O arquivo não é um áudio aceito.").into_owned());
    }
    let meta = std::fs::metadata(path).map_err(|err| err.to_string())?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(crate::i18n::tr("O arquivo não é um áudio aceito.").into_owned());
    }
    if meta.len() > MAX_BYTES {
        return Err(crate::i18n::tr("O áudio tem mais de 5 MB.").into_owned());
    }
    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    if !looks_like_audio(&bytes, &ext) {
        return Err(crate::i18n::tr("O arquivo não é um áudio aceito.").into_owned());
    }
    Ok((ext, bytes))
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

pub fn install(app: &AppHandle, account_id: &str, name: &str, bytes: &[u8]) -> Result<(), String> {
    if account_of_sound(name) != Some(account_id)
        || !looks_like_audio(bytes, name.rsplit('.').next().unwrap_or(""))
    {
        return Err(crate::i18n::tr("O arquivo não é um áudio aceito.").into_owned());
    }
    let dir = config_dir(app)
        .ok_or_else(|| crate::i18n::tr("Não foi possível guardar o som.").into_owned())?;
    clear_account_dir(&dir, account_id);
    std::fs::write(dir.join(name), bytes).map_err(|err| err.to_string())
}

/// Result of copying the old shared sound onto one account. `Missing` means
/// there is nothing usable to copy. `Failed` means a later attempt might work,
/// so the original file must stay.
#[derive(Debug, PartialEq, Eq)]
pub enum CopyLegacy {
    Stored(String),
    Missing,
    Failed,
}

/// Copy the old shared file onto one account. The shared file is left in place
/// so the other accounts can be copied before it is removed.
pub fn copy_legacy(app: &AppHandle, legacy_name: &str, account_id: &str) -> CopyLegacy {
    if !is_legacy_name(legacy_name) || !is_account_id(account_id) {
        return CopyLegacy::Failed;
    }
    let Some(src) = stored_path(app, legacy_name) else {
        // The config directory could not be opened. The file may still be there.
        return CopyLegacy::Failed;
    };
    if !src.is_file() {
        return CopyLegacy::Missing;
    }
    let Ok(bytes) = std::fs::read(&src) else {
        return CopyLegacy::Failed;
    };
    let Some(ext) = legacy_name.rsplit('.').next() else {
        return CopyLegacy::Missing;
    };
    let ext = ext.to_ascii_lowercase();
    if !looks_like_audio(&bytes, &ext) {
        return CopyLegacy::Missing;
    }
    let Some(name) = stored_name(account_id, &ext) else {
        return CopyLegacy::Failed;
    };
    match install(app, account_id, &name, &bytes) {
        Ok(()) => CopyLegacy::Stored(name),
        Err(_) => CopyLegacy::Failed,
    }
}

pub fn delete_legacy(app: &AppHandle) {
    let Some(dir) = config_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if is_legacy_name(&name.to_string_lossy()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub fn clear_account(app: &AppHandle, account_id: &str) {
    if !is_account_id(account_id) {
        return;
    }
    if let Some(dir) = config_dir(app) {
        clear_account_dir(&dir, account_id);
    }
}

fn clear_account_dir(dir: &Path, account_id: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if account_of_sound(&name.to_string_lossy()) == Some(account_id) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

struct Gate {
    busy: bool,
    waiting: Option<String>,
}

/// Start this account now, or keep it as the one chime that plays next.
/// A third account, while one is playing and one is waiting, is ignored.
fn reserve(gate: &mut Gate, account_id: String) -> bool {
    if !gate.busy {
        gate.busy = true;
        return true;
    }
    if gate.waiting.is_none() {
        gate.waiting = Some(account_id);
    }
    false
}

static PLAYING: Mutex<Gate> = Mutex::new(Gate {
    busy: false,
    waiting: None,
});

/// Play this account's file, or its built-in chime. One chime can be waiting
/// behind the one that is already playing. Any further chime is dropped.
pub fn play(app: &AppHandle, account_id: &str) {
    if !is_account_id(account_id) {
        return;
    }
    let app = app.clone();
    let account_id = account_id.to_string();
    let start = {
        let mut gate = PLAYING.lock().unwrap_or_else(|err| err.into_inner());
        reserve(&mut gate, account_id.clone())
    };
    if !start {
        return;
    }
    std::thread::spawn(move || {
        let mut current = Some(account_id);
        loop {
            if let Some(id) = current.take() {
                play_account(&app, &id);
            }
            let mut gate = PLAYING.lock().unwrap_or_else(|err| err.into_inner());
            match gate.waiting.take() {
                Some(next) => current = Some(next),
                None => {
                    gate.busy = false;
                    return;
                }
            }
        }
    });
}

fn play_account(app: &AppHandle, account_id: &str) {
    let settings = crate::settings::load(app);
    let prefs = crate::settings::prefs_for(&settings, account_id);
    if let Some(name) = prefs.sound_file.as_deref() {
        if let Some(path) = stored_path(app, name).filter(|path| path.is_file()) {
            if play_file(&path) {
                return;
            }
        }
    }
    let index = builtin_index(account_id);
    if let Some(path) = builtin_file(index) {
        let _ = play_file(&path);
    }
}

fn builtin_bytes(index: usize) -> Vec<u8> {
    match index {
        0 => BUNDLED.to_vec(),
        1 => tone_wav(&[(880.0, 90), (0.0, 40), (1174.0, 140)]),
        2 => tone_wav(&[(1760.0, 70)]),
        _ => tone_wav(&[(440.0, 110), (554.0, 160)]),
    }
}

fn builtin_file(index: usize) -> Option<PathBuf> {
    let bytes = builtin_bytes(index);
    let path = std::env::temp_dir().join(format!("whatrust-mention-{index}.wav"));
    let fresh = std::fs::read(&path)
        .ok()
        .is_some_and(|existing| existing == bytes);
    if !fresh {
        std::fs::write(&path, &bytes).ok()?;
    }
    Some(path)
}

/// Short 16-bit mono tones. A frequency of 0 is silence, so two notes can be
/// separated without a click.
fn tone_wav(steps: &[(f32, u32)]) -> Vec<u8> {
    const RATE: u32 = 22_050;
    let mut samples = Vec::new();
    for &(freq, ms) in steps {
        let count = RATE as usize * ms as usize / 1000;
        for i in 0..count {
            if freq <= 0.0 {
                samples.push(0i16);
                continue;
            }
            let t = i as f32 / RATE as f32;
            let env = 1.0 - i as f32 / count.max(1) as f32;
            let sample = (t * freq * std::f32::consts::TAU).sin() * env * 0.55;
            samples.push((sample * i16::MAX as f32) as i16);
        }
    }
    wav_pcm16(RATE, &samples)
}

fn wav_pcm16(rate: u32, samples: &[i16]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend(b"RIFF");
    out.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
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
    use super::{
        account_of_sound, builtin_bytes, builtin_index, is_account_id, is_legacy_name,
        is_stored_name, looks_like_audio, reserve, stored_name, Gate, BUNDLED,
    };

    #[test]
    fn only_the_copied_file_name_is_accepted() {
        assert!(is_stored_name("mention-alert.mp3"));
        assert!(is_stored_name("mention-alert.default.wav"));
        assert!(is_stored_name("mention-alert.acct-2.ogg"));
        assert!(!is_stored_name("mention-alert.exe"));
        assert!(!is_stored_name("../mention-alert.wav"));
        assert!(!is_stored_name("mention-alert.wav/extra"));
        assert!(!is_stored_name("/tmp/mention-alert.wav"));
        assert!(!is_stored_name("mention-alert.not-an-account.mp3"));
        assert_eq!(
            stored_name("default", "MP3").as_deref(),
            Some("mention-alert.default.mp3")
        );
        assert_eq!(
            stored_name("acct-4", "wav").as_deref(),
            Some("mention-alert.acct-4.wav")
        );
        assert!(stored_name("default", "txt").is_none());
        assert!(stored_name("../acct", "wav").is_none());
        assert!(is_legacy_name("mention-alert.mp3"));
        assert!(!is_legacy_name("mention-alert.default.mp3"));
        assert_eq!(
            account_of_sound("mention-alert.acct-12.flac"),
            Some("acct-12")
        );
        assert!(is_account_id("default"));
        assert!(is_account_id("acct-1"));
        assert!(!is_account_id("acct-"));
        assert!(!is_account_id("acct-1/../x"));
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
    fn each_account_has_its_own_built_in_chime() {
        assert_eq!(builtin_index("default"), 0);
        assert_eq!(builtin_index("acct-1"), 1);
        assert_eq!(builtin_index("acct-2"), 2);
        assert_eq!(builtin_index("acct-3"), 3);
        assert_eq!(builtin_index("acct-4"), 1);
        let original = builtin_bytes(0);
        assert!(looks_like_audio(&original, "wav"));
        assert_eq!(original, BUNDLED);
        let bell = builtin_bytes(1);
        let ping = builtin_bytes(2);
        let tone = builtin_bytes(3);
        assert!(looks_like_audio(&bell, "wav") && bell.len() < 20_000);
        assert_ne!(original, bell);
        assert_ne!(bell, ping);
        assert_ne!(ping, tone);
        assert_ne!(tone, original);
    }

    #[test]
    fn a_third_chime_waits_for_nobody() {
        let mut gate = Gate {
            busy: false,
            waiting: None,
        };
        assert!(reserve(&mut gate, "default".into()));
        assert!(gate.busy && gate.waiting.is_none());
        assert!(!reserve(&mut gate, "acct-1".into()));
        assert_eq!(gate.waiting.as_deref(), Some("acct-1"));
        assert!(!reserve(&mut gate, "acct-2".into()));
        assert_eq!(gate.waiting.as_deref(), Some("acct-1"));
    }
}

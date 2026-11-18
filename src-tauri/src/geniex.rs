//! Local Windows ARM64 transcription using an app-owned GenieX server.
use std::net::TcpListener;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MODEL: &str = "ggml-org/Qwen3-ASR-0.6B-GGUF:Q8_0";
const REPO: &str = "ggml-org/Qwen3-ASR-0.6B-GGUF";
const NO_WINDOW: u32 = 0x08000000;
struct Server {
    child: Child,
    port: u16,
    _job: OwnedHandle,
}
static SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();
static INFERENCE: Mutex<()> = Mutex::new(());
fn state() -> &'static Mutex<Option<Server>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

fn executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("GenieX CLI").join("geniex.exe"));
    }
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(programs)
                .join("GenieX CLI")
                .join("geniex.exe"),
        );
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("geniex.exe")));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn command() -> Result<Command, &'static str> {
    let mut cmd = Command::new(executable().ok_or("geniex_missing")?);
    cmd.creation_flags(NO_WINDOW).arg("--skip-update");
    Ok(cmd)
}

fn own_process(child: &Child) -> Result<OwnedHandle, &'static str> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let handle = CreateJobObjectW(None, None).map_err(|_| "geniex_start")?;
        let owned = OwnedHandle::from_raw_handle(handle.0);
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as _,
            std::mem::size_of_val(&info) as u32,
        )
        .map_err(|_| "geniex_start")?;
        AssignProcessToJobObject(handle, HANDLE(child.as_raw_handle()))
            .map_err(|_| "geniex_start")?;
        Ok(owned)
    }
}

// A port can be taken between releasing our reservation and GenieX binding it.
// Never send private audio until Windows says our child owns the listener.
fn owns_listener(pid: u32, port: u16) -> bool {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    let mut size = 0u32;
    unsafe {
        GetExtendedTcpTable(None, &mut size, false, 2, TCP_TABLE_OWNER_PID_LISTENER, 0);
    }
    if !(4..=16 * 1024 * 1024).contains(&size) {
        return false;
    }
    let mut words = vec![0u32; (size as usize).div_ceil(4)];
    let result = unsafe {
        GetExtendedTcpTable(
            Some(words.as_mut_ptr().cast()),
            &mut size,
            false,
            2,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if result != 0 {
        return false;
    }
    let available = (size as usize).saturating_sub(4) / std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
    let count = (words[0] as usize).min(available);
    let rows = unsafe {
        std::slice::from_raw_parts(words.as_ptr().add(1).cast::<MIB_TCPROW_OWNER_PID>(), count)
    };
    rows.iter().any(|row| {
        row.dwOwningPid == pid
            && u16::from_be(row.dwLocalPort as u16) == port
            && row.dwLocalAddr == u32::from_ne_bytes([127, 0, 0, 1])
    })
}

pub fn model_present() -> Result<bool, &'static str> {
    let output = command()?
        .args(["list", "--format", "json"])
        .output()
        .map_err(|_| "geniex_missing")?;
    if !output.status.success() {
        return Err("geniex_unavailable");
    }
    let list: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "geniex_unavailable")?;
    model_in_list(&list)
}

fn model_in_list(list: &serde_json::Value) -> Result<bool, &'static str> {
    let items = list.as_array().ok_or("geniex_unavailable")?;
    Ok(items.iter().any(|item| {
        item["name"].as_str() == Some(REPO)
            && item["precisions"]
                .as_array()
                .is_some_and(|ps| ps.iter().any(|p| p.as_str() == Some("Q8_0")))
    }))
}

pub fn download_model() -> Result<(), &'static str> {
    if model_present()? {
        return Ok(());
    }
    let mut child = command()?
        .args(["pull", MODEL, "--model-type", "vlm"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "geniex_unavailable")?;
    let _job = match own_process(&child) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let status = child.wait().map_err(|_| "geniex_download")?;
    if status.success() && model_present()? {
        Ok(())
    } else {
        Err("geniex_download")
    }
}

fn server(slot: &mut Option<Server>) -> Result<u16, &'static str> {
    if let Some(s) = slot.as_mut() {
        if matches!(s.child.try_wait(), Ok(None)) && owns_listener(s.child.id(), s.port) {
            return Ok(s.port);
        }
        let _ = s.child.kill();
        let _ = s.child.wait();
        *slot = None;
    }
    if !model_present()? {
        return Err("geniex_model_missing");
    }
    // Reserve an ephemeral port so an unrelated service is not reused.
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "geniex_start")?;
    let port = listener.local_addr().map_err(|_| "geniex_start")?.port();
    drop(listener);
    let address = format!("127.0.0.1:{port}");
    let mut child = command()?
        .args([
            "serve",
            "--host",
            &address,
            "--compute",
            "npu",
            "--origins",
            "http://127.0.0.1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "geniex_start")?;
    let job = match own_process(&child) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    let client = crate::llm::client(Duration::from_secs(1));
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return Err("geniex_start");
        }
        if owns_listener(child.id(), port)
            && client
                .get(&format!("http://{address}/v1/models"))
                .call()
                .is_ok()
        {
            // A failed bind must not lead us to send audio to another process.
            std::thread::sleep(Duration::from_millis(300));
            if !matches!(child.try_wait(), Ok(None)) {
                return Err("geniex_start");
            }
            *slot = Some(Server {
                child,
                port,
                _job: job,
            });
            return Ok(port);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("geniex_start")
}

fn parse_transcript(v: &serde_json::Value) -> Result<String, &'static str> {
    if v["choices"][0]["finish_reason"].as_str() == Some("length") {
        return Err("geniex_truncated");
    }
    let text = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("geniex_response")?;
    let text = text
        .split_once("<asr_text>")
        .map_or(text, |(_, tail)| tail)
        .trim();
    Ok(text.to_owned())
}

fn pcm_data(audio: &[u8]) -> Result<&[u8], &'static str> {
    if audio.len() < 44 || !audio.starts_with(b"RIFF") || &audio[8..12] != b"WAVE" {
        return Err("bad_audio");
    }
    let mut pos = 12usize;
    let mut format_ok = false;
    let mut pcm = None;
    while pos + 8 <= audio.len() {
        let len = u32::from_le_bytes(
            audio[pos + 4..pos + 8]
                .try_into()
                .map_err(|_| "bad_audio")?,
        ) as usize;
        let start = pos + 8;
        let end = start
            .checked_add(len)
            .filter(|end| *end <= audio.len())
            .ok_or("bad_audio")?;
        if &audio[pos..pos + 4] == b"fmt " && len >= 16 {
            format_ok = audio[start..start + 2] == 1u16.to_le_bytes()
                && audio[start + 2..start + 4] == 1u16.to_le_bytes()
                && audio[start + 4..start + 8] == 16000u32.to_le_bytes()
                && audio[start + 14..start + 16] == 16u16.to_le_bytes();
        }
        if &audio[pos..pos + 4] == b"data" {
            pcm = Some(&audio[start..end]);
        }
        pos = end.checked_add(len % 2).ok_or("bad_audio")?;
    }
    let pcm = pcm.ok_or("bad_audio")?;
    if !format_ok || pcm.is_empty() || pcm.len() % 2 != 0 {
        return Err("bad_audio");
    }
    Ok(pcm)
}

fn wav_for_pcm(pcm: &[u8]) -> Vec<u8> {
    let len = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

// Split long recordings at a quiet 20 ms window near each one-minute mark.
// This keeps the audio and generated text within the server's context window.
fn chunk_end(pcm: &[u8], start: usize) -> usize {
    const MINUTE: usize = 60 * 32000;
    const SEARCH: usize = 32000;
    const STEP: usize = 640;
    let target = start.saturating_add(MINUTE);
    if target.saturating_add(SEARCH) >= pcm.len() {
        return pcm.len();
    }
    let from = target - SEARCH;
    let to = (target + SEARCH).min(pcm.len().saturating_sub(STEP));
    let mut best = target;
    let mut best_energy = u64::MAX;
    for at in (from..=to).step_by(STEP) {
        let energy: u64 = pcm[at..at + STEP]
            .chunks_exact(2)
            .map(|s| i16::from_le_bytes([s[0], s[1]]).unsigned_abs() as u64)
            .sum();
        if energy < best_energy
            || (energy == best_energy && at.abs_diff(target) < best.abs_diff(target))
        {
            best = at;
            best_energy = energy;
        }
    }
    best
}

pub fn transcribe(audio: &[u8]) -> Result<String, &'static str> {
    let pcm = pcm_data(audio)?;
    // Serializing calls prevents competing NPU model loads and server starts.
    let _one_at_a_time = INFERENCE.lock().map_err(|_| "geniex_start")?;
    let port = {
        let mut slot = state().lock().map_err(|_| "geniex_start")?;
        server(&mut slot)?
    };
    let mut parts = Vec::new();
    let mut start = 0;
    while start < pcm.len() {
        let end = chunk_end(pcm, start);
        let wav = wav_for_pcm(&pcm[start..end]);
        let body = serde_json::json!({"model":MODEL,"temperature":0,"max_tokens":2048,"messages":[{"role":"user","content":[{"type":"text","text":"Transcribe the speech exactly."},{"type":"input_audio","input_audio":{"data":crate::window::base64_encode(&wav),"format":"wav"}}]}]});
        let result = crate::llm::client(Duration::from_secs(180))
            .post(&format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string())
            .map_err(|_| "geniex_inference")?;
        let value: serde_json::Value =
            serde_json::from_reader(result.into_reader()).map_err(|_| "geniex_response")?;
        let text = parse_transcript(&value)?;
        if !text.is_empty() {
            parts.push(text);
        }
        start = end;
    }
    Ok(parts.join(" "))
}

pub fn shutdown() {
    if let Ok(mut slot) = state().lock() {
        if let Some(mut s) = slot.take() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }
}

pub fn test_npu() -> Result<(), &'static str> {
    let data_len = 32000u32;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.resize(44 + data_len as usize, 0);
    transcribe(&wav).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_asr_marker_and_plain_text() {
        assert_eq!(
            parse_transcript(
                &serde_json::json!({"choices":[{"message":{"content":"language English<asr_text>Hello there."}}]})
            ),
            Ok("Hello there.".into())
        );
        assert_eq!(
            parse_transcript(&serde_json::json!({"choices":[{"message":{"content":"Hello"}}]})),
            Ok("Hello".into())
        );
        assert!(parse_transcript(&serde_json::json!({})).is_err());
        assert!(parse_transcript(&serde_json::json!({"choices":[{"finish_reason":"length","message":{"content":"partial"}}]})).is_err());
    }
    #[test]
    fn wav_chunks_are_aligned_and_preserve_samples() {
        let pcm = vec![0u8; 32000 * 130];
        let wav = wav_for_pcm(&pcm);
        assert_eq!(pcm_data(&wav).unwrap(), pcm.as_slice());
        let first = chunk_end(&pcm, 0);
        let second = chunk_end(&pcm, first);
        assert_eq!(first, 32000 * 60);
        assert_eq!(second, 32000 * 120);
        assert_eq!(chunk_end(&pcm, second), pcm.len());
        assert!(pcm_data(b"not a WAV").is_err());
    }
    #[test]
    fn only_the_selected_q8_model_counts_as_installed() {
        assert_eq!(model_in_list(&serde_json::json!([])), Ok(false));
        assert_eq!(
            model_in_list(&serde_json::json!([{"name": REPO, "precisions": ["Q4_0"]}])),
            Ok(false)
        );
        assert_eq!(
            model_in_list(&serde_json::json!([{"name": REPO, "precisions": ["Q8_0"]}])),
            Ok(true)
        );
        assert!(model_in_list(&serde_json::json!({})).is_err());
    }
    #[test]
    fn listener_owner_must_match_process_and_port() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(owns_listener(std::process::id(), port));
        assert!(!owns_listener(0, port));
        assert!(!owns_listener(std::process::id(), 0));
    }
    #[test]
    #[ignore = "requires installed GenieX, the Q8 model, Snapdragon NPU, and WHATRUST_ASR_TEST_WAV"]
    fn real_npu_transcription() {
        let path = std::env::var_os("WHATRUST_ASR_TEST_WAV").expect("test WAV path");
        let audio = std::fs::read(path).expect("read test WAV");
        let result = transcribe(&audio);
        let first_pid = state().lock().unwrap().as_ref().unwrap().child.id();
        let again = transcribe(&audio).expect("warm transcription");
        assert!(again.to_lowercase().contains("country"));
        assert_eq!(
            state().lock().unwrap().as_ref().unwrap().child.id(),
            first_pid
        );
        {
            let mut slot = state().lock().unwrap();
            let child = &mut slot.as_mut().unwrap().child;
            child.kill().unwrap();
            child.wait().unwrap();
        }
        let restarted = transcribe(&audio).expect("restart after server exit");
        assert!(restarted.to_lowercase().contains("country"));
        shutdown();
        let text = result.expect("NPU transcription").to_lowercase();
        assert!(text.contains("country"), "unexpected transcript: {text}");
    }
    #[test]
    #[ignore = "requires GenieX, Q8 model, Snapdragon NPU and WHATRUST_ASR_VIDEO_WAV"]
    fn video_audio_transcription() {
        let path = std::env::var_os("WHATRUST_ASR_VIDEO_WAV").expect("test video WAV path");
        let audio = std::fs::read(path).expect("read test WAV");
        let result = transcribe(&audio);
        shutdown();
        let text = result.expect("video transcription");
        assert!(!text.trim().is_empty(), "empty transcript");
        println!("video transcript: {text}");
    }
    #[test]
    #[ignore = "requires GenieX, Q8 model and Snapdragon NPU"]
    fn silence_connection_test() {
        let result = test_npu();
        shutdown();
        result.expect("NPU health test");
    }
}

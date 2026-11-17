const invoke = window.__TAURI__
  ? window.__TAURI__.core.invoke
  : () => Promise.reject(new Error("WhatsApp is still opening. Try again."));

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = parts.map((part) => part[0]).join("");
  return (letters || "?").toUpperCase();
}

function when(at) {
  const date = new Date(Number(at) || 0);
  if (!at || Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function showError(message) {
  document.getElementById("error").textContent = message || "";
}

async function load() {
  const card = await invoke("mention_card");
  const sender = card.sender_name || "WhatsApp";
  document.getElementById("sender").textContent = sender;
  document.getElementById("avatar").textContent = initials(sender);
  const meta = [card.chat_name, when(card.at_ms), card.account_name].filter(Boolean);
  document.getElementById("meta").textContent = meta.join(" · ");
  const picture = document.getElementById("incoming");
  const text = document.getElementById("body-text");
  if (card.preview) {
    picture.hidden = false;
    picture.onerror = () => {
      picture.hidden = true;
      picture.removeAttribute("src");
      if (!text.textContent) text.textContent = "Photo";
    };
    picture.src = card.preview;
  } else {
    picture.hidden = true;
    picture.removeAttribute("src");
  }
  text.textContent = card.body || (card.preview || card.voice ? "" : "New message");
  if (card.voice) showHeard(card);
  if (card.voice && !card.body && !card.preview) document.getElementById("body").hidden = true;
}

let heardUrl = "";
let heardLoading = false;
let heardSeconds = 0;
let transcriptTries = 0;
let transcriptPlaceholder = false;

function showHeard(card) {
  heardSeconds = Number(card.seconds) || 0;
  document.getElementById("heard").hidden = false;
  document.getElementById("heard-duration").textContent = clockText(heardSeconds);
  watchTranscript();
}

function paintHeard() {
  const audio = document.getElementById("heard-audio");
  const decoded = Number.isFinite(audio.duration) && audio.duration ? audio.duration : 0;
  const duration = decoded || heardSeconds;
  const ratio = duration ? Math.min(1, (audio.currentTime || 0) / duration) : 0;
  document.querySelector("#heard-progress i").style.width = (ratio * 100) + "%";
  const at = !decoded || (audio.paused && audio.currentTime < 0.2) ? duration : audio.currentTime;
  document.getElementById("heard-duration").textContent = clockText(at);
}

function setTranscript(text, placeholder) {
  const node = document.getElementById("heard-transcript");
  transcriptPlaceholder = placeholder;
  node.textContent = text;
  node.hidden = false;
}

async function watchTranscript() {
  let view;
  try { view = await invoke("mention_transcript"); }
  catch { return; }
  const node = document.getElementById("heard-transcript");
  if (!view || view.status === "disabled") {
    if (transcriptPlaceholder || !node.textContent) node.hidden = true;
    return;
  }
  if (view.status === "ready") {
    const text = String(view.text || "").trim();
    const translation = String(view.translation || "").trim();
    setTranscript(
      text ? (translation ? text + "\n" + translation : text) : "No speech recognized.",
      false,
    );
    return;
  }
  // Missing means FluidVoice has not claimed the note yet. That can outlast
  // the first few lookups, so keep asking until it is ready or the wait ends.
  if (transcriptPlaceholder || !node.textContent) setTranscript("Transcribing…", true);
  if (transcriptTries < 20) {
    transcriptTries += 1;
    setTimeout(watchTranscript, 2000);
    return;
  }
  if (transcriptPlaceholder) node.hidden = true;
}

async function openChat() {
  try { await invoke("mention_open"); } catch (error) { showError(String(error)); }
}

const FILE_MAX = 8 * 1024 * 1024;
const VOICE_WAV_MAX = 8 * 1024 * 1024;
const VOICE_RATE = 16000;
const SPEEDS = [1, 1.5, 2];
let speedIndex = 0;
let attached = null;
let attachmentUrl = "";
let voiceBlob = null;
let voiceUrl = "";
let voiceSeconds = 0;
let recorder = null;
let recordStream = null;

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

let voiceEpoch = 0;
let voiceStarting = false;

function clearVoice() {
  voiceEpoch += 1;
  stopMeters();
  if (recorder && recorder.state === "recording") recorder.stop();
  if (recordStream) recordStream.getTracks().forEach((track) => track.stop());
  recordStream = null;
  recorder = null;
  voiceBlob = null;
  voiceSeconds = 0;
  resetPlayer();
  if (voiceUrl) URL.revokeObjectURL(voiceUrl);
  voiceUrl = "";
  const button = document.getElementById("voice");
  button.classList.remove("recording");
  button.setAttribute("aria-label", "Record a voice note");
  document.getElementById("text").hidden = false;
}

function imageMime(file) {
  const type = file.type || "";
  if (type.startsWith("image/")) return type;
  const name = String(file.name || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".bmp")) return "image/bmp";
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  if (name.endsWith(".avif")) return "image/avif";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  return "";
}

function clearAttachmentPreview() {
  const img = document.getElementById("attachment-preview");
  img.onload = null;
  img.onerror = null;
  img.hidden = true;
  img.removeAttribute("src");
  if (attachmentUrl) URL.revokeObjectURL(attachmentUrl);
  attachmentUrl = "";
}

function clearFile() {
  attached = null;
  document.getElementById("file").value = "";
  document.getElementById("attachment").hidden = true;
  document.getElementById("attachment-name").textContent = "";
  clearAttachmentPreview();
}

function wavBytes(samples, rate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const mark = (at, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  mark(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  mark(8, "WAVE");
  mark(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  mark(36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    let sample = samples[i];
    if (sample > 1) sample = 1;
    if (sample < -1) sample = -1;
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

async function voiceWav(blob) {
  let ctx;
  try {
    ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * VOICE_RATE));
    const offline = new OfflineAudioContext(1, frames, VOICE_RATE);
    const mixed = offline.createBuffer(1, decoded.length, decoded.sampleRate);
    const target = mixed.getChannelData(0);
    const count = decoded.numberOfChannels || 1;
    for (let c = 0; c < count; c++) {
      const src = decoded.getChannelData(c);
      for (let i = 0; i < src.length; i++) target[i] += src[i] / count;
    }
    const source = offline.createBufferSource();
    source.buffer = mixed;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return wavBytes(rendered.getChannelData(0), VOICE_RATE);
  } catch (error) {
    throw new Error("The voice note could not be prepared.");
  } finally {
    if (ctx) ctx.close().catch(() => {});
  }
}

async function alreadyOgg(blob) {
  if (!String(blob.type || "").includes("ogg")) return null;
  const head = new Uint8Array(await blob.slice(0, 128).arrayBuffer());
  let text = "";
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  if (!text.startsWith("OggS") || !text.includes("OpusHead")) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

async function payload() {
  const text = document.getElementById("text").value;
  if (voiceBlob) {
    const ogg = await alreadyOgg(voiceBlob);
    const bytes = ogg || (await voiceWav(voiceBlob));
    if (!bytes.length) throw new Error("The recording was empty. Try again.");
    if (bytes.length > VOICE_WAV_MAX) throw new Error("The voice note is too long.");
    return {
      text: "",
      kind: "voice",
      filename: ogg ? "voice.ogg" : "voice.wav",
      mime: ogg ? "audio/ogg" : "audio/wav",
      data: bytesToBase64(bytes),
    };
  }
  if (attached) {
    if (attached.size > FILE_MAX) throw new Error("The file is larger than 8 MB.");
    const bytes = new Uint8Array(await attached.arrayBuffer());
    return {
      text,
      kind: "file",
      filename: attached.name || "file",
      mime: imageMime(attached) || attached.type || "application/octet-stream",
      data: bytesToBase64(bytes),
    };
  }
  return { text: text.trim(), kind: "text", filename: "", mime: "", data: "" };
}

async function send(event) {
  event.preventDefault();
  if (recorder && recorder.state === "recording") await finishRecording();
  const text = document.getElementById("text");
  const button = document.getElementById("send");
  let body;
  try {
    body = await payload();
  } catch (error) {
    showError(String(error.message || error));
    return;
  }
  if (body.kind === "text" && !body.text) {
    showError("Write a reply.");
    return;
  }
  button.disabled = true;
  showError("");
  try {
    await invoke("mention_reply", body);
  } catch (error) {
    showError(String(error));
    button.disabled = false;
    text.focus();
  }
}

document.getElementById("file").addEventListener("change", () => {
  const file = document.getElementById("file").files[0];
  if (!file) return;
  clearVoice();
  attached = file;
  clearAttachmentPreview();
  document.getElementById("attachment-name").textContent = file.name;
  document.getElementById("attachment").hidden = false;
  const mime = imageMime(file);
  if (!mime) return;
  attachmentUrl = URL.createObjectURL(file);
  const img = document.getElementById("attachment-preview");
  img.onload = () => { img.hidden = false; };
  img.onerror = () => {
    img.hidden = true;
    img.removeAttribute("src");
  };
  img.src = attachmentUrl;
});
document.getElementById("attachment-clear").addEventListener("click", clearFile);
document.getElementById("attach").addEventListener("click", () => {
  document.getElementById("file").click();
});
const WAVE_BARS = 28;
let audioCtx = null;
let meterSource = null;
let analyser = null;
let waveLevels = [];
let waveTimer = 0;
let clockTimer = 0;
let recordStarted = 0;

function micError(error) {
  const name = error && error.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    showError("Allow microphone access for whatRust in System Settings, then try again.");
  } else if (name === "NotFoundError" || name === "OverconstrainedError") {
    showError("No microphone was found.");
  } else {
    showError("The microphone is not available.");
  }
}

function ensureWave() {
  const wave = document.getElementById("voice-wave");
  if (wave.childElementCount) return;
  for (let i = 0; i < WAVE_BARS; i++) {
    wave.appendChild(document.createElement("i"));
  }
}

function paintWave() {
  const bars = document.getElementById("voice-wave").children;
  for (let i = 0; i < bars.length; i++) {
    const level = waveLevels[i] || 0;
    bars[i].style.height = (4 + Math.round(level * 18)) + "px";
  }
}

function sampleLevel() {
  if (!analyser) return 0.12;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.max(0.08, Math.min(1, Math.sqrt(sum / data.length) * 4));
}

function startMeters(stream) {
  ensureWave();
  waveLevels = Array(WAVE_BARS).fill(0.12);
  paintWave();
  stopMeters();
  try {
    audioCtx = new AudioContext();
    meterSource = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    meterSource.connect(analyser);
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (error) {
    analyser = null;
  }
  recordStarted = Date.now();
  document.getElementById("voice-time").textContent = "0:00";
  document.getElementById("voice-status").hidden = false;
  document.getElementById("text").hidden = true;
  clockTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - recordStarted) / 1000);
    const min = Math.floor(secs / 60);
    const sec = String(secs % 60).padStart(2, "0");
    document.getElementById("voice-time").textContent = min + ":" + sec;
  }, 200);
  waveTimer = setInterval(() => {
    waveLevels.push(sampleLevel());
    if (waveLevels.length > WAVE_BARS) waveLevels.shift();
    paintWave();
  }, 90);
}

function stopMeters() {
  if (clockTimer) clearInterval(clockTimer);
  if (waveTimer) clearInterval(waveTimer);
  clockTimer = 0;
  waveTimer = 0;
  if (meterSource) {
    try { meterSource.disconnect(); } catch (error) {}
    meterSource = null;
  }
  if (analyser) {
    try { analyser.disconnect(); } catch (error) {}
  }
  analyser = null;
  const ctx = audioCtx;
  audioCtx = null;
  // Closing the context in the same turn as stopping the microphone kills
  // this webview on macOS. The popup would then reload and drop the take.
  if (ctx) setTimeout(() => { ctx.close().catch(() => {}); }, 400);
  const status = document.getElementById("voice-status");
  if (status) status.hidden = true;
}

function finishRecording() {
  if (!recorder || recorder.state !== "recording") return Promise.resolve();
  return new Promise((resolve) => {
    const rec = recorder;
    const previous = rec.onstop;
    rec.onstop = (event) => {
      if (typeof previous === "function") previous(event);
      resolve();
    };
    try { rec.stop(); }
    catch (error) { resolve(); }
  });
}

function voiceMime() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== "function") return "";
  if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) return "audio/ogg;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
  return "";
}

document.getElementById("voice").addEventListener("click", async () => {
  if (voiceStarting) return;
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  if (voiceBlob) {
    clearVoice();
    return;
  }
  clearFile();
  voiceStarting = true;
  const epoch = voiceEpoch;
  let stream;
  try {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      throw new Error("no-mic");
    }
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    voiceStarting = false;
    micError(error);
    return;
  }
  voiceStarting = false;
  if (epoch !== voiceEpoch) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  recordStream = stream;
  const mime = voiceMime();
  let rec;
  try {
    rec = new MediaRecorder(recordStream, mime ? { mimeType: mime } : undefined);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    recordStream = null;
    micError(error);
    return;
  }
  recorder = rec;
  const chunks = [];
  rec.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  rec.onstop = () => {
    stopMeters();
    if (recordStream) recordStream.getTracks().forEach((track) => track.stop());
    recordStream = null;
    const button = document.getElementById("voice");
    button.classList.remove("recording");
    document.getElementById("text").hidden = false;
    if (epoch !== voiceEpoch) return;
    const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
    if (!blob.size) {
      showError("The recording was empty. Try again.");
      button.setAttribute("aria-label", "Record a voice note");
      return;
    }
    voiceBlob = blob;
    voiceSeconds = Math.max(1, Math.round((Date.now() - recordStarted) / 1000));
    if (voiceUrl) URL.revokeObjectURL(voiceUrl);
    voiceUrl = URL.createObjectURL(voiceBlob);
    showVoicePlayer();
    button.setAttribute("aria-label", "Cancel the recording");
  };
  try {
    rec.start(250);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    recordStream = null;
    recorder = null;
    micError(error);
    return;
  }
  startMeters(stream);
  document.getElementById("voice").classList.add("recording");
  document.getElementById("voice").setAttribute("aria-label", "Stop recording");
  showError("");
});

function clockText(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

function resetPlayer() {
  speedIndex = 0;
  const audio = document.getElementById("voice-preview");
  audio.pause();
  audio.playbackRate = SPEEDS[0];
  audio.removeAttribute("src");
  const play = document.getElementById("voice-play");
  play.classList.remove("playing");
  play.setAttribute("aria-label", "Play the voice note");
  document.getElementById("voice-speed").textContent = SPEEDS[0].toFixed(1) + "x";
  document.querySelector("#voice-progress i").style.width = "0";
  document.getElementById("voice-duration").textContent = "";
  document.getElementById("voice-player").hidden = true;
}

function showVoicePlayer() {
  speedIndex = 0;
  document.getElementById("voice-speed").textContent = SPEEDS[0].toFixed(1) + "x";
  const play = document.getElementById("voice-play");
  play.classList.remove("playing");
  play.setAttribute("aria-label", "Play the voice note");
  document.querySelector("#voice-progress i").style.width = "0";
  document.getElementById("voice-duration").textContent = clockText(voiceSeconds);
  document.getElementById("voice-player").hidden = false;
}

function paintPlayback() {
  const audio = document.getElementById("voice-preview");
  const decoded = Number.isFinite(audio.duration) && audio.duration ? audio.duration : 0;
  const duration = decoded || voiceSeconds;
  const ratio = duration ? Math.min(1, (audio.currentTime || 0) / duration) : 0;
  document.querySelector("#voice-progress i").style.width = (ratio * 100) + "%";
  const shown = !decoded || (audio.paused && audio.currentTime < 0.2) ? duration : audio.currentTime;
  document.getElementById("voice-duration").textContent = clockText(shown);
}

document.getElementById("voice-play").addEventListener("click", async () => {
  const audio = document.getElementById("voice-preview");
  const play = document.getElementById("voice-play");
  if (!voiceUrl) return;
  if (!audio.getAttribute("src")) {
    audio.preload = "auto";
    audio.src = voiceUrl;
  }
  if (audio.paused) {
    try { await audio.play(); } catch (error) { return; }
    play.classList.add("playing");
    play.setAttribute("aria-label", "Pause the voice note");
  } else {
    audio.pause();
    play.classList.remove("playing");
    play.setAttribute("aria-label", "Play the voice note");
  }
  paintPlayback();
});
document.getElementById("voice-speed").addEventListener("click", () => {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  const rate = SPEEDS[speedIndex];
  document.getElementById("voice-preview").playbackRate = rate;
  document.getElementById("voice-speed").textContent = rate.toFixed(1) + "x";
});
document.getElementById("voice-progress").addEventListener("click", (event) => {
  const audio = document.getElementById("voice-preview");
  const bar = event.currentTarget;
  if (!Number.isFinite(audio.duration) || !audio.duration) return;
  const rect = bar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * audio.duration;
  paintPlayback();
});
const preview = document.getElementById("voice-preview");
preview.addEventListener("timeupdate", paintPlayback);
preview.addEventListener("loadedmetadata", paintPlayback);
preview.addEventListener("ended", () => {
  preview.currentTime = 0;
  const play = document.getElementById("voice-play");
  play.classList.remove("playing");
  play.setAttribute("aria-label", "Play the voice note");
  paintPlayback();
});

function base64ToBytes(data) {
  const binary = atob(data || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

document.getElementById("heard-play").addEventListener("click", async () => {
  const audio = document.getElementById("heard-audio");
  const play = document.getElementById("heard-play");
  if (audio.getAttribute("src") && !audio.paused) {
    audio.pause();
    play.classList.remove("playing");
    play.setAttribute("aria-label", "Play the voice note");
    paintHeard();
    return;
  }
  if (!audio.getAttribute("src")) {
    if (heardLoading) return;
    heardLoading = true;
    play.disabled = true;
    showError("");
    try {
      const media = await invoke("mention_listen");
      const bytes = base64ToBytes(media.data || "");
      if (!bytes.length) throw new Error("Could not play the voice note.");
      if (heardUrl) URL.revokeObjectURL(heardUrl);
      heardUrl = URL.createObjectURL(new Blob([bytes], { type: media.mime || "audio/wav" }));
      audio.src = heardUrl;
    } catch (error) {
      const message = String((error && error.message) || error || "");
      showError(message.replace(/^Error:\s*/, "") || "Could not play the voice note.");
      heardLoading = false;
      play.disabled = false;
      return;
    }
    heardLoading = false;
    play.disabled = false;
  }
  try {
    await audio.play();
  } catch (error) {
    showError("Could not play the voice note.");
    return;
  }
  play.classList.add("playing");
  play.setAttribute("aria-label", "Pause the voice note");
  paintHeard();
});
document.getElementById("heard-progress").addEventListener("click", (event) => {
  const audio = document.getElementById("heard-audio");
  const bar = event.currentTarget;
  if (!Number.isFinite(audio.duration) || !audio.duration) return;
  const rect = bar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * audio.duration;
  paintHeard();
});
const heardAudio = document.getElementById("heard-audio");
heardAudio.addEventListener("timeupdate", paintHeard);
heardAudio.addEventListener("loadedmetadata", paintHeard);
heardAudio.addEventListener("ended", () => {
  heardAudio.currentTime = 0;
  const play = document.getElementById("heard-play");
  play.classList.remove("playing");
  play.setAttribute("aria-label", "Play the voice note");
  paintHeard();
});

document.getElementById("open").addEventListener("click", openChat);
document.getElementById("body").addEventListener("click", openChat);
document.getElementById("close").addEventListener("click", () => {
  invoke("mention_dismiss").catch(() => {});
});
document.getElementById("reply").addEventListener("submit", send);
document.getElementById("text").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    document.getElementById("reply").requestSubmit();
  }
});
load().catch((error) => showError(String(error)));

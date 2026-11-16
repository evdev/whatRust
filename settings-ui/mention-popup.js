const invoke = window.__TAURI__.core.invoke;

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
  document.getElementById("body").textContent = card.body || "New message";
}

async function openChat() {
  try { await invoke("mention_open"); } catch (error) { showError(String(error)); }
}

const FILE_MAX = 8 * 1024 * 1024;
const VOICE_MAX = 2 * 1024 * 1024;
let attached = null;
let voiceBlob = null;
let voiceUrl = "";
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
  if (recorder && recorder.state === "recording") recorder.stop();
  if (recordStream) recordStream.getTracks().forEach((track) => track.stop());
  recordStream = null;
  recorder = null;
  voiceBlob = null;
  if (voiceUrl) URL.revokeObjectURL(voiceUrl);
  voiceUrl = "";
  const preview = document.getElementById("voice-preview");
  preview.pause();
  preview.removeAttribute("src");
  preview.hidden = true;
  const button = document.getElementById("voice");
  button.classList.remove("recording");
  button.setAttribute("aria-label", "Record a voice note");
}

function clearFile() {
  attached = null;
  document.getElementById("file").value = "";
  document.getElementById("attachment").hidden = true;
  document.getElementById("attachment-name").textContent = "";
}

async function payload() {
  const text = document.getElementById("text").value;
  if (voiceBlob) {
    if (text.trim()) throw new Error("Voice notes cannot include a caption. Remove the text or clear the recording.");
    if (voiceBlob.size > VOICE_MAX) throw new Error("The voice note is larger than 2 MB.");
    const bytes = new Uint8Array(await voiceBlob.arrayBuffer());
    const mime = voiceBlob.type || "audio/webm";
    const ext = mime.includes("mp4") ? "m4a" : "webm";
    return { text, kind: "voice", filename: "voice." + ext, mime, data: bytesToBase64(bytes) };
  }
  if (attached) {
    if (attached.size > FILE_MAX) throw new Error("The file is larger than 8 MB.");
    const bytes = new Uint8Array(await attached.arrayBuffer());
    return {
      text,
      kind: "file",
      filename: attached.name || "file",
      mime: attached.type || "application/octet-stream",
      data: bytesToBase64(bytes),
    };
  }
  return { text: text.trim(), kind: "text", filename: "", mime: "", data: "" };
}

async function send(event) {
  event.preventDefault();
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
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
  document.getElementById("attachment-name").textContent = file.name;
  document.getElementById("attachment").hidden = false;
});
document.getElementById("attachment-clear").addEventListener("click", clearFile);
document.getElementById("attach").addEventListener("click", () => {
  document.getElementById("file").click();
});
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
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    voiceStarting = false;
    showError("The microphone is not available.");
    return;
  }
  voiceStarting = false;
  if (epoch !== voiceEpoch) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  recordStream = stream;
  const mime = window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : window.MediaRecorder && MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "";
  recorder = new MediaRecorder(recordStream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  recorder.onstop = () => {
    if (recordStream) recordStream.getTracks().forEach((track) => track.stop());
    recordStream = null;
    if (epoch !== voiceEpoch) return;
    voiceBlob = new Blob(chunks, { type: (recorder && recorder.mimeType) || mime || "audio/webm" });
    voiceUrl = URL.createObjectURL(voiceBlob);
    const preview = document.getElementById("voice-preview");
    preview.src = voiceUrl;
    preview.hidden = false;
    const button = document.getElementById("voice");
    button.classList.remove("recording");
    button.setAttribute("aria-label", "Cancel the recording");
  };
  recorder.start();
  document.getElementById("voice").classList.add("recording");
  document.getElementById("voice").setAttribute("aria-label", "Stop recording");
  showError("");
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

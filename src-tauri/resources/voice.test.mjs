// Run: node src-tauri/resources/voice.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "voice.js"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else {
    failures++;
    console.error("FAIL  " + msg);
  }
}

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.parentNode = null;
    this.listeners = {};
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((item) => item !== child);
    child.parentNode = null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  get firstChild() { return this.children[0] || null; }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}
function matches(el, selector) {
  const found = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (!found) return false;
  if (found[2] === undefined) return el.getAttribute(found[1]) != null;
  return el.getAttribute(found[1]) === found[2];
}

globalThis.window = globalThis;
globalThis.location = { origin: "https://web.whatsapp.com" };
globalThis.__WHATRUST_TEST = true;
globalThis.document = { createElement: (tag) => new El(tag) };
eval(source);
const api = globalThis.__whatrustVoiceApi;
const wav = api.pcmWav(new Float32Array([-1, 0, 1]));
const wavView = new DataView(wav.buffer);
assert(String.fromCharCode(...wav.slice(0, 4)) === "RIFF" && String.fromCharCode(...wav.slice(8, 12)) === "WAVE", "GenieX audio is a WAV file");
assert(wavView.getUint32(24, true) === 16000 && wavView.getUint16(22, true) === 1 && wavView.getUint16(34, true) === 16, "WAV is mono 16 kHz 16-bit PCM");
assert(wavView.getInt16(44, true) === -32768 && wavView.getInt16(46, true) === 0 && wavView.getInt16(48, true) === 32767, "PCM samples use the correct signed range");

const id = "false_123@c.us_ABC";
assert(api.isMessageId(id), "accepts a WhatsApp message id");
assert(!api.isMessageId("false_short"), "rejects an id without a message part");
assert(api.isVoiceMessage({ type: "ptt" }), "ptt is a voice note");
assert(api.isVoiceMessage({ attributes: { type: "audio" } }), "audio messages count");
assert(!api.isVoiceMessage({ type: "chat" }), "text messages are skipped");
assert(!api.isVoiceMessage(null), "missing messages are skipped");
assert(api.incomingVoiceId({ id: { _serialized: id }, type: "ptt" }) === id, "incoming voice models expose their serialized id");
assert(!api.incomingVoiceId({ id: "true_123@c.us_SENT", type: "ptt" }), "outgoing notes are not treated as incoming");
assert(!api.incomingVoiceId({ id, type: "video" }), "incoming videos remain on demand");
assert(api.isVideoMessage({ type: "video" }) && api.isVideoMessage({ attributes: { type: "ptv" } }), "regular and instant videos are eligible");
assert(!api.isVideoMessage({ type: "image" }) && !api.isVideoMessage({ type: "video", isGif: true }) && !api.isVideoMessage({ type: "video", isViewOnce: true }), "photos, GIFs and view-once videos are excluded");
const thumbnailRow = {
  querySelector: (selector) => selector === "img" ? {} : null,
  querySelectorAll: () => [],
};
assert(api.mayContainVideo(thumbnailRow), "an unmarked thumbnail is checked against the message model");
const reactRow = { parentElement: null, getAttribute: () => null, __reactProps$test: { message: { id: { _serialized: id } } } };
assert(api.messageIdOf(reactRow) === id, "a message ID can be recovered from React props when the row has no data-id");

const row = new El("div");
row.setAttribute("data-id", id);
const icon = new El("span");
icon.setAttribute("data-icon", "audio-play");
row.appendChild(icon);
assert(api.looksLikeVoiceRow(row), "a play icon marks the row");
assert(api.audioRetryDelay("bad_audio", 1) === 1000, "a refused note is tried again");
assert(api.audioRetryDelay({ message: "bad_audio" }, 8) === 8000, "later refusals wait longer, up to eight seconds");
assert(api.audioRetryDelay("bad_audio", 9) === 0, "a note that keeps failing is shown");
assert(api.audioRetryDelay("fluidvoice", 1) === 0, "a missing FluidVoice is not retried as busy");
assert(api.audioRetryDelay("too_large", 1) === 0, "an oversized note is not retried");
const chat = { getMessageById: function () {}, downloadMedia: function () {} };
assert(api.chatApiReady({ chat: chat, isReady: true }), "a ready chat api can transcribe");
assert(api.chatApiReady({ chat: chat, isReady: false, conn: { isMainReady: function () { return true; } } }), "an already-connected account can transcribe without the loader flag");
assert(!api.chatApiReady({ chat: chat, isReady: false, conn: { isMainReady: function () { return false; } } }), "a signed-out page waits");
assert(!api.chatApiReady({ isReady: true }), "missing chat methods wait");
assert(!api.chatApiReady({
  get chat() { throw new Error("chat"); },
  isReady: true,
}), "a throwing chat lookup does not stick the watcher");
row.getBoundingClientRect = () => ({ top: 10, bottom: 40, left: 0, right: 80, width: 80, height: 30 });
assert(api.intersectsViewport(row, { width: 400, height: 300 }), "on-screen row is visible");
assert(!api.intersectsViewport(row, { width: 400, height: 5 }), "a row below the viewport is not visible");

const packed = api.pack(id, new Uint8Array([1, 2, 3]), 1_700_000_000_000);
assert(packed[0] === 0 && packed[1] === id.length, "frame length is a big-endian u16");
assert(packed.length === 2 + id.length + 8 + 3 && packed[packed.length - 1] === 3, "frame ends with the audio");
const timeAt = 2 + id.length;
const hi = (packed[timeAt] * 16777216) + (packed[timeAt + 1] * 65536) + (packed[timeAt + 2] * 256) + packed[timeAt + 3];
const lo = (packed[timeAt + 4] * 16777216) + (packed[timeAt + 5] * 65536) + (packed[timeAt + 6] * 256) + packed[timeAt + 7];
assert(hi * 4294967296 + lo === 1_700_000_000_000, "frame carries the message time");
const seconds = api.pack(id, new Uint8Array([9]), 5);
const secondsAt = 2 + id.length;
const secondsHi = (seconds[secondsAt] * 16777216) + (seconds[secondsAt + 1] * 65536) + (seconds[secondsAt + 2] * 256) + seconds[secondsAt + 3];
const secondsLo = (seconds[secondsAt + 4] * 16777216) + (seconds[secondsAt + 5] * 65536) + (seconds[secondsAt + 6] * 256) + seconds[secondsAt + 7];
assert(secondsHi * 4294967296 + secondsLo === 5000, "a WhatsApp second timestamp is stored as milliseconds");

const view = { id, status: "ready", text: "olá", translation: "hello" };
api.renderBox(row, view, { translate: true });
api.renderBox(row, view, { translate: true });
assert(row.querySelectorAll("[data-wr-voice]").length === 1, "rendering twice keeps a single box");
const box = row.querySelector("[data-wr-voice]");
assert(box.children.some((child) => child.textContent === "olá"), "transcript is shown");
assert(box.children.some((child) => child.textContent === "hello"), "translation is shown when enabled");
api.renderBox(row, view, { translate: false });
assert(!box.children.some((child) => child.textContent === "hello"), "translation hides when the setting is off");
assert(row.querySelectorAll("[data-wr-voice]").length === 1, "updating the box does not duplicate it");
const earlyButtons = box.children.filter((child) => child.tagName === "button");
assert(earlyButtons.length === 1, "a transcript offers Summarize only");
assert(box.style.cssText.includes("rgba(255,255,255,0.62)"), "a received note uses a translucent white panel");
const sent = "true_123@c.us_ABC";
assert(api.panelStyle(sent, null).includes("rgba(217,253,211,0.62)"), "a sent note falls back to translucent green");
assert(
  api.panelStyle(id, { background: { r: 0, g: 92, b: 75, a: 1 }, color: "rgb(233,237,239)" }).includes("rgba(0,92,75,0.62)"),
  "a sampled bubble color replaces the fallback"
);
assert(api.parseColor("rgba(255, 255, 255, 0)").a === 0, "a transparent bubble color is recognized");

globalThis.__WR_LANG = "en";
api.renderBox(row, { id, status: "ready", text: "olá", summary: "- buy milk\n- call Sam" }, { translate: false });
const summarized = row.querySelector("[data-wr-voice]");
const add = summarized.children.find((child) => child.tagName === "button" && child.textContent === "Add to To-Do");
assert(add, "a summary adds Add to To-Do");
assert(summarized.querySelector("[data-wr-voice-text]").textContent === "olá", "the transcript is tagged");
const summaryList = summarized.querySelector("[data-wr-voice-summary]");
assert(
  summaryList && summaryList.children.some((child) => child.textContent === "buy milk") && summaryList.tagName !== "button",
  "the summary points are tagged separately from the button"
);
let captured = null;
globalThis.__whatrustTodoFromVoice = (payload) => { captured = payload; };
add.listeners.click.forEach((fn) => fn({ stopPropagation() {} }));
assert(
  captured && captured.id === id && captured.summary === "- buy milk\n- call Sam" && captured.transcript === "olá",
  "Add to To-Do sends the summary and the voice note"
);
api.renderBox(row, { id, status: "ready", text: "olá", summary: "" }, { translate: true });
assert(
  !row.querySelector("[data-wr-voice]").children.some((child) => child.textContent === "Add to To-Do"),
  "Add to To-Do waits for a summary"
);
delete globalThis.__WR_LANG;

api.renderBox(row, {
  id,
  status: "ready",
  text: "olá",
  summary: "first\n- second\n\n1. third\n3 people\n1.5 liters",
}, { translate: false });
const transcript = box.children.find((child) => child.textContent === "olá");
const card = box.children.find((child) => String(child.style.cssText || "").includes("rgba(255,196,120,0.9)"));
assert(transcript && transcript !== card, "transcript stays outside the summary card");
assert(!String(transcript.style.cssText || "").includes("font-weight:700") && transcript.style.fontWeight !== "700", "transcript is not bold");
assert(card.style.cssText.includes("color:#3a2415") && card.style.cssText.includes("font-weight:700"), "summary card is apricot with dark bold text");
assert(card.children[0].textContent === "Resumo", "summary card is labeled");
const items = card.children.find((child) => child.tagName === "ul").children;
assert(items.map((item) => item.textContent).join("|") === "first|second|third|3 people|1.5 liters", "summary lines become bullets with markers removed");
assert(items.every((item) => item.style.cssText.includes("font-weight:700")), "summary points are bold");
api.renderBox(row, { id, status: "ready", text: "olá", summary: " \n- \n" }, { translate: false });
assert(!box.children.some((child) => String(child.style.cssText || "").includes("rgba(255,196,120,0.9)")), "a blank summary renders no card");

let active = 0;
let peak = 0;
const release = {};
const queue = api.createQueue(2, (item) => new Promise((resolve) => {
  active += 1;
  peak = Math.max(peak, active);
  release[item] = () => { active -= 1; resolve(); };
}));
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
assert(queue.add("a") && queue.add("b") && queue.add("c"), "three ids are accepted");
assert(queue.add("a") === false, "an id already queued is not added again");
await flush();
assert(peak === 2 && active === 2, "only two transcriptions run at once");
assert(queue.state("c") === "queued", "the third id waits");
release.a();
await flush();
assert(active === 2 && queue.state("c") === "run", "the waiter starts when a slot frees");
release.b();
release.c();
await flush();
assert(queue.forget("a"), "a finished id can be retried");
assert(queue.add("a"), "retry queues it again");
await flush();
release.a();
await flush();
assert(queue.state("a") === "done", "the retry finishes");
assert(api.enqueueMissing(queue, "a"), "a finished id is queued again when the note is missing");
const heldRun = api.createQueue(1, () => new Promise(() => {}));
assert(heldRun.add("busy"), "a held transcription is accepted");
await flush();
assert(heldRun.state("busy") === "run", "the held transcription is running");
assert(api.enqueueMissing(heldRun, "busy") === false, "a running transcription is not started twice");

const held = {
  shown: { id: "shown", status: "ready", text: "on screen" },
  gone: { id: "gone", status: "ready", text: "released" },
  failed: { id: "failed", status: "error", notice: "llm" },
  running: { id: "running", status: "ready", text: "still working" },
};
const heldAnchors = {
  shown: { isConnected: true },
  gone: { isConnected: false },
  failed: { isConnected: false },
  running: { isConnected: false },
};
const paintCache = [];
api.retainVisible(held, heldAnchors, { shown: true }, { running: true }, paintCache);
assert(held.shown && held.shown.text === "on screen", "a visible transcript stays");
assert(!held.gone && paintCache.some((view) => view.id === "gone" && view.text === "released"), "a detached transcript is released");
assert(api.releasedView(paintCache, "gone").text === "released", "a released transcript can be painted again");
assert(held.failed && held.failed.status === "error", "an error marker is kept");
assert(held.running && held.running.text === "still working", "a running note survives the sweep");
assert(!heldAnchors.gone && !heldAnchors.failed, "a detached row is not kept alive");
assert(heldAnchors.shown, "a connected row stays anchored");
const overflow = [];
const many = {};
for (let n = 0; n < 33; n++) many["n" + n] = { id: "n" + n, status: "ready", text: String(n) };
api.retainVisible(many, {}, {}, {}, overflow);
assert(overflow.length === 32 && overflow[0].text === "1" && overflow[31].text === "32", "the paint cache keeps the newest 32");
const stale = {};
for (let n = 0; n < 405; n++) stale["s" + n] = { skip: true };
stale.keep = { skip: true };
api.capIdMap(stale, { keep: true }, 400);
assert(Object.keys(stale).length === 400 && stale.keep.skip === true, "stale markers stay under the cap and a kept id survives");

// Exercise the live event path with no chat DOM: a saved transcript must be
// reused, while a new incoming note is downloaded and saved immediately.
const listeners = {};
const calls = [];
const savedId = "false_123@c.us_SAVED";
const newId = "false_456@c.us_NEW";
const live = {
  location: { origin: "https://web.whatsapp.com" },
  WPP: { isReady: true, on: (event, fn) => { listeners[event] = fn; }, chat: {
    getMessageById: async () => { throw new Error("unexpected lookup"); },
    downloadMedia: async (noteId) => { calls.push(["download", noteId]); return new Blob(["audio"]); },
  } },
  __TAURI__: { core: { invoke: async (cmd, args) => {
    calls.push([cmd, args?.id]);
    if (cmd === "voice_prefs") return { enabled: true };
    if (cmd === "voice_lookup") return args.id === savedId ? { id: args.id, status: "ready", text: "saved" } : { status: "missing" };
    if (cmd === "transcribe_voice") return { id: newId, status: "ready", text: "new" };
  } } },
  setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1,
  Blob, Uint8Array, TextEncoder, Promise,
};
live.window = live;
runInNewContext(source, live);
await new Promise((resolve) => setImmediate(resolve));
listeners["chat.new_message"]({ id: { _serialized: savedId }, type: "ptt" });
listeners["chat.new_message"]({ id: newId, type: "audio" });
listeners["chat.new_message"]({ id: newId, type: "audio" });
for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
assert(calls.some(([cmd, noteId]) => cmd === "voice_lookup" && noteId === savedId), "incoming notes check the saved transcript first");
assert(!calls.some(([cmd, noteId]) => cmd === "download" && noteId === savedId), "a saved transcript avoids another download");
assert(calls.filter(([cmd, noteId]) => cmd === "download" && noteId === newId).length === 1, "a new note is downloaded once without opening its chat");
assert(calls.filter(([cmd]) => cmd === "transcribe_voice").length === 1, "the incoming note is sent for transcription");
live.__whatrustVoicePrefs({ enabled: false });
listeners["chat.new_message"]({ id: "false_456@c.us_DISABLED", type: "ptt" });
await new Promise((resolve) => setImmediate(resolve));
assert(!calls.some(([cmd, noteId]) => cmd === "voice_lookup" && noteId === "false_456@c.us_DISABLED"), "disabled transcription ignores incoming notes");

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall voice tests passed");

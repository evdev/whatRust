// Run: node src-tauri/resources/schedule-recorder.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { File } from "node:buffer";
import vm from "node:vm";

const source = readFileSync(new URL("./schedule-recorder.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const events = new Map(), timers = new Map(), changes = [], errors = [], records = [], tracks = [];
  let permission, closes = 0, decoded = { duration: 0.001, length: 48, sampleRate: 48000, numberOfChannels: 2, getChannelData: c => new Float32Array(48).fill(c ? 0 : 1) };
  const button = { style: {}, attrs: {}, listeners: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, v) { this.listeners[k] = v; }, removeEventListener(k) { delete this.listeners[k]; }, click() { if (!this.disabled) this.listeners.click?.(); } };
  class Recorder {
    static isTypeSupported(type) { return type.includes("webm"); }
    constructor(stream, options) { this.stream = stream; this.options = options; this.mimeType = options.mimeType; this.state = "inactive"; records.push(this); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["recorded"]) }); this.onstop?.(); }
  }
  class AudioContext {
    async decodeAudioData() { return decoded; }
    async close() { closes++; }
  }
  class OfflineAudioContext {
    constructor(channels, frames, rate) { this.frames = frames; this.rate = rate; assert.equal(channels, 1); }
    createBuffer(channels, frames) { assert.equal(channels, 1); this.mono = new Float32Array(frames); return { getChannelData: () => this.mono }; }
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { assert.equal(this.mono[0], 0.5); return { getChannelData: () => new Float32Array(this.frames).fill(this.mono[0]) }; }
  }
  const root = { __WHATRUST_TEST: true, __WR_LANG: "en", Blob, File, AudioContext, OfflineAudioContext, MediaRecorder: Recorder,
    document: { createElement: () => button }, navigator: { mediaDevices: { getUserMedia() {
      if (permission) return permission;
      const track = { stops: 0, stop() { this.stops++; } }; tracks.push(track);
      return Promise.resolve({ getTracks: () => [track] });
    } } },
    setTimeout(fn, ms) { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(k, v) { events.set(k, v); }, removeEventListener(k) { events.delete(k); }
  };
  root.window = root; vm.runInNewContext(source, root);
  const api = root.__wrCreateScheduleRecorder({ onChange: value => changes.push(value), onError: value => errors.push(value) });
  return { root, api, button, changes, errors, tracks, records, events, timers, closes: () => closes, setPermission(value) { permission = value; }, setDecoded(value) { decoded = value; } };
}

{
  const f = fixture();
  assert.equal(f.tracks.length, 0, "no capture before explicit click");
  assert.equal(f.api.busy(), false); assert.match(f.button.attrs["aria-label"], /Record a voice/);
  f.button.click(); assert(f.api.busy()); assert(f.button.disabled);
  await tick(); assert.equal(f.records.length, 1); assert(!f.button.disabled); assert.equal(f.button.attrs["aria-pressed"], "true");
  assert.equal([...f.timers.values()][0].ms, 120000);
  f.button.click(); assert(f.api.busy()); await tick();
  assert.equal(f.api.busy(), false); assert.equal(f.tracks[0].stops, 1); assert.equal(f.timers.size, 0); assert.equal(f.closes(), 1);
  const file = f.changes.find(value => value instanceof File);
  assert.equal(file.name, "voice-note.wav"); assert.equal(file.type, "audio/wav");
  const bytes = new DataView(await file.arrayBuffer());
  assert.equal(bytes.getUint16(22, true), 1); assert.equal(bytes.getUint32(24, true), 16000);
  assert.equal(bytes.getUint16(34, true), 16); assert.equal(bytes.getInt16(44, true), 16383);
  assert.equal(f.errors.length, 0);
  f.button.click(); await tick(); assert.equal(f.records.length, 2, "same editor can record again");
  f.api.dispose(); assert.equal(f.tracks[1].stops, 1); assert.equal(f.api.busy(), false); assert.equal(f.events.size, 0);
}
{
  const f = fixture(); let grant;
  const track = { stops: 0, stop() { this.stops++; } };
  f.setPermission(new Promise(resolve => { grant = resolve; }));
  f.button.click(); f.api.setDisabled(true); assert(!f.api.busy());
  grant({ getTracks: () => [track] }); await tick();
  assert.equal(track.stops, 1); assert.equal(f.records.length, 0); assert.equal(f.errors.length, 0);
  f.api.setDisabled(false); assert(!f.button.disabled); f.api.dispose();
}
{
  const f = fixture();
  f.setPermission(Promise.reject(Object.assign(new Error(), { name: "NotAllowedError" })));
  f.button.click(); await tick();
  assert.equal(f.api.busy(), false); assert.match(f.errors[0], /Allow microphone access/); assert(!f.button.disabled);
  f.api.dispose();
}
{
  const f = fixture(); f.root.__WR_LANG = "pt-BR";
  f.button.click(); await tick();
  f.records[0].onerror({ error: new Error("device lost") });
  assert.equal(f.tracks[0].stops, 1); assert(!f.api.busy()); assert.match(f.errors[0], /microfone/); assert.equal(f.timers.size, 0); f.api.dispose();
}
{
  const f = fixture(); f.button.click(); await tick();
  [...f.timers.values()][0].fn(); await tick();
  assert.equal(f.changes.filter(value => value instanceof File).length, 1, "automatic limit completes a voice note");
  f.api.dispose();
}
{
  const f = fixture(); let decode;
  f.root.AudioContext.prototype.decodeAudioData = () => new Promise(resolve => { decode = resolve; });
  f.button.click(); await tick(); f.button.click(); await tick();
  const count = f.changes.length; f.events.get("pagehide")();
  decode({}); await tick();
  assert.equal(f.closes(), 1); assert.equal(f.changes.length, count, "pagehide suppresses stale completion"); assert.equal(f.errors.length, 0);
}
{
  const f = fixture(); f.button.click(); await tick();
  f.records[0].ondataavailable({ data: new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]) });
  assert(!f.api.busy()); assert.match(f.errors[0], /too large/); assert.equal(f.tracks[0].stops, 1); f.api.dispose();
}
{
  const f = fixture();
  f.setDecoded({ duration: 121, length: 121, sampleRate: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(121).fill(0.5) });
  f.button.click(); await tick(); f.button.click(); await tick();
  const file = f.changes.find(value => value instanceof File);
  assert.equal(file.size, 44 + 120 * 16000 * 2, "delayed stop cannot exceed two minutes in the WAV");
  f.api.dispose();
}
{
  const f = fixture();
  const bytes = new DataView(f.root.__wrScheduleRecorderTest.wavBytes(new Float32Array([-2, 2, NaN])));
  assert.equal(bytes.getInt16(44, true), -32768); assert.equal(bytes.getInt16(46, true), 32767); assert.equal(bytes.getInt16(48, true), 0);
  assert.equal(bytes.getUint32(40, true), 6); f.api.dispose();
}
console.log("schedule-recorder tests passed");

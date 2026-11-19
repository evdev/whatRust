// Run: node src-tauri/resources/schedule-ui.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { File } from "node:buffer";
import vm from "node:vm";

const source = readFileSync(new URL("./schedule-ui.js", import.meta.url), "utf8");
const calls = [];
let current = { id: { _serialized: "123@c.us" }, name: "Ada" };
const root = { __WHATRUST_TEST: true, File, btoa, Intl, Date, Map, Uint8Array,
  WPP: { chat: { getActiveChat: () => current, setInputText: async (...args) => calls.push(["clear", ...args]) } },
  __TAURI__: { core: { invoke: async (cmd, args) => { calls.push([cmd, args]); return cmd === "schedule_stage_begin" ? "stage-1" : {}; } } }
};
root.window = root;
vm.runInNewContext(source, root);
const api = root.__whatrustScheduleUiApi;
assert.equal(api.chatId("123:4@lid"), "123@lid");
assert.equal(api.chatId("120363@g.us"), "120363@g.us");
assert.equal(api.chatId("15551234-14159265@g.us"), "15551234-14159265@g.us");
assert.equal(api.chatId("15551234-14159265@c.us"), "");
assert.equal(api.chatId("15551234--14159265@g.us"), "");
for (const id of ["status@broadcast", "12@newsletter", "garbage", "123@c.us<script>"]) assert.equal(api.chatId(id), "");
assert.equal(api.draftText({ innerText: "Hello 🙂\r\nhttps://example.com\nline 3" }), "Hello 🙂\nhttps://example.com\nline 3");
const textNode = value => ({ nodeType: 3, nodeValue: value });
const emojiNode = { tagName: "IMG", getAttribute: key => key === "alt" ? "🙂" : null };
assert.equal(api.draftText({ querySelector: () => emojiNode, childNodes: [textNode("Hello "), emojiNode, { tagName: "BR" }, textNode("https://example.com")] }), "Hello 🙂\nhttps://example.com");
assert(api.validTime("2026-11-19T15:45", "America/Denver"));
assert(!api.validTime("2026-02-30T15:45", "America/Denver"));
assert(!api.validTime("2026-11-19T15:45", "invalid/zone"));
const latest = api.latestReview([{ schedule_id: "s", occurrence_id: "old", due_ms: 1, state: "missed" }, { schedule_id: "s", occurrence_id: "new", due_ms: 2, state: "missed" }, { schedule_id: "other", occurrence_id: "o", due_ms: 1, state: "missed" }, { schedule_id: "s", occurrence_id: "ambiguous", due_ms: 0, state: "uncertain" }, { schedule_id: "s", occurrence_id: "failed", due_ms: 0, state: "failed" }]);
assert.deepEqual(Array.from(latest, x => x.occurrence_id), ["new", "o", "ambiguous", "failed"]);
assert(api.validTime("2026-03-08T02:30", "America/Denver"), "DST gaps reach Rust for original-zone resolution");
assert.deepEqual(Array.from(api.reviewActions({ state: "uncertain" })), ["skip"]);
assert.deepEqual(Array.from(api.reviewActions({ state: "failed" })), ["retry", "skip"]);
assert.deepEqual(Array.from(api.reviewActions({ state: "missed" })), ["send", "skip"]);
assert.equal(api.messagePreview({ text: "Schedule this\nmessage" }), "Schedule this\nmessage");
assert.equal(api.messagePreview({ attachments: [{ name: "photo.png", caption: "Caption 🙂" }, { name: "notes.txt", caption: "" }] }), "photo.png · Caption 🙂\nnotes.txt");
assert.deepEqual(Array.from(api.otherAccountPending({ current_account_id: "own", pending_accounts: [{ account_id: "own", count: 5 }, { account_id: "other", count: 2 }, { account_id: "empty", count: 0 }] }), item => item.account_id), ["other"]);
root.__WR_LANG = "en";
assert.match(api.errorText("date_in_past"), /future date/);
assert.match(api.errorText("attachment_stage_busy"), /file upload/);
assert.match(api.errorText("delivery_in_progress"), /being sent/);
assert.match(api.errorText("account_unavailable"), /account is unavailable/);
root.__WR_LANG = "pt-BR";
assert.match(api.errorText("date_in_past"), /futuras/);

const input = { innerText: "First 🙂\nhttps://example.com", isConnected: true };
const capture = { chat: { id: "123@c.us" }, input, text: input.innerText };
assert(await api.clearSavedDraft(capture));
assert.deepEqual(calls.pop(), ["clear", "", "123@c.us"]);
input.innerText += " changed";
assert.equal(await api.clearSavedDraft(capture), false);
input.innerText = capture.text;
current = { id: "456@g.us" };
assert.equal(await api.clearSavedDraft(capture), false);
current = { id: "123@c.us" };
input.isConnected = false;
assert.equal(await api.clearSavedDraft(capture), false);
assert.equal(await api.clearSavedDraft({ chat: capture.chat, input: null }), false);

const image = new File([new Uint8Array(300000).fill(17)], "photo.png", { type: "image/png" });
const doc = new File(["original document"], "notes.txt", { type: "text/plain" });
assert(api.originalFiles([image, doc]));
assert(!api.originalFiles([{ name: "fake.png", size: 100, type: "image/png" }]));
assert.equal(await api.stageFiles([image, doc], ["Multiline 🙂\ncaption", "Second"]), "stage-1");
const begin = calls.find(c => c[0] === "schedule_stage_begin")[1];
assert.equal(begin.files[0].caption, "Multiline 🙂\ncaption");
assert.equal(begin.files[0].mode, "image");
assert.equal(begin.files[1].mode, "document");
const chunks = calls.filter(c => c[0] === "schedule_stage_chunk").map(c => c[1]);
assert.equal(chunks.length, 3);
assert.equal(chunks[0].offset, 0);
assert.equal(chunks[1].offset, 262144);
assert.equal(chunks[2].file_index, 1);
assert.equal(Buffer.from(chunks[0].data, "base64").length, 262144);
assert.equal(Buffer.from(chunks[2].data, "base64").toString(), "original document");

calls.length = 0;
root.__TAURI__.core.invoke = async (cmd, args) => { calls.push([cmd, args]); if (cmd === "schedule_stage_chunk") throw Error("disk full"); return "stage-failed"; };
await assert.rejects(api.stageFiles([image], [""]), /disk full/);
assert.equal(calls.at(-1)[0], "schedule_stage_discard");
assert.equal(calls.at(-1)[1].stage_id, "stage-failed");

let seq = 0;
const revoked = [];
const urls = { createObjectURL: () => "blob:local-" + (++seq), revokeObjectURL: url => revoked.push(url) };
const identities = api.captureObjectURLs(urls);
const url = urls.createObjectURL(image);
assert.equal(identities.get(url), image);
const unknown = urls.createObjectURL(new Blob(["not a File"]));
assert.equal(identities.get(unknown), undefined);
urls.revokeObjectURL(url);
assert.equal(identities.get(url), undefined);
assert.deepEqual(revoked, [url]);
for (let i = 0; i < 70; i++) urls.createObjectURL(image);
assert.equal(identities.size, 64);

// The supported native-preview fixture uses real local File identity and exact
// current blob URL, not an arbitrary remote URL or reconstructed download.
const previewCapture = { chat: { id: "123@c.us" }, files: [image], edited: false };
let previewSrc = "blob:verified", viewOff = true, editedDOM = false, transform = "none", duplicate = false;
const caption = { innerText: "Caption 🙂\nhttps://example.com" };
const once = { getAttribute: () => viewOff ? "view-once-off" : "view-once", closest: () => null };
const container = { getAttribute: () => "media-editor", querySelectorAll: () => duplicate ? [mediaNode, mediaNode] : [mediaNode], querySelector: selector => selector.includes("media-caption") ? caption : selector.startsWith("[data-icon") ? once : editedDOM ? {} : null };
const mediaNode = { getAttribute: () => previewSrc, parentElement: container };
root.getComputedStyle = () => ({ transform, clipPath: "none", filter: "none" });
const previewURLs = new Map([["blob:verified", image]]);
const verified = api.verifyNativePreview(previewCapture, container, previewURLs);
assert.equal(verified.files[0], image);
assert.equal(verified.text, caption.innerText);
previewSrc = "blob:unknown";
assert.equal(api.verifyNativePreview(previewCapture, container, previewURLs), null);
previewSrc = "blob:verified"; viewOff = false;
assert.equal(api.verifyNativePreview(previewCapture, container, previewURLs), null);
viewOff = true; editedDOM = true;
assert.equal(api.verifyNativePreview(previewCapture, container, previewURLs), null);
editedDOM = false; transform = "matrix(1,0,0,1,2,3)";
assert.equal(api.verifyNativePreview(previewCapture, container, previewURLs), null);
transform = "none"; duplicate = true;
assert.equal(api.verifyNativePreview(previewCapture, container, previewURLs), null);
duplicate = false; previewCapture.edited = true;
assert.equal(api.verifyNativePreview(previewCapture, container, previewURLs), null);

// Full script runs at document-start: identity interception is immediate, DOM
// observation and mounting wait for body without throwing or losing the hook.
const listeners = new Map(); let observed = 0;
const earlyDoc = { body: null, querySelector: () => null, addEventListener: (name, fn) => listeners.set(name, fn), hasFocus: () => false };
const initialCreate = () => "blob:early";
const earlyRoot = { location: { origin: "https://web.whatsapp.com" }, document: earlyDoc, File, URL: { createObjectURL: initialCreate }, addEventListener() {}, MutationObserver: class { observe(target) { assert.equal(target, earlyDoc.body); observed++; } }, __TAURI__: { core: { invoke: async () => ({ schedules: [], review: [], pending_accounts: [] }) } } };
earlyRoot.window = earlyRoot;
vm.runInNewContext(source, earlyRoot);
assert.notEqual(earlyRoot.URL.createObjectURL, initialCreate);
assert.equal(observed, 0);
assert.equal(typeof listeners.get("DOMContentLoaded"), "function");
earlyDoc.body = {};
listeners.get("DOMContentLoaded")();
assert.equal(observed, 1);
console.log("schedule-ui: passed chat, draft, recurrence, review, original-file identity and staged transfer tests");

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
assert.equal(api.scheduleChat({ id: "456@g.us", name: "Group" }).id, "456@g.us");
assert.equal(api.scheduleChat({ id: "status@broadcast" }).id, "123@c.us");
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
assert.equal(api.attachmentMime(new File(["png"], "photo.PNG")), "image/png");
assert.equal(api.attachmentMime(new File(["pdf"], "file.pdf", { type: "application/octet-stream" })), "application/pdf");
assert.equal(api.attachmentMime(new File(["x"], "file.constructor")), "application/octet-stream");
calls.length = 0;
await api.stageFiles([new File(["wav"], "voice-note.wav", {type: "audio/wav"})], ["unscheduled draft"], true);
const voiceMetadata = calls.find(c => c[0] === "schedule_stage_begin")[1].files[0];
assert.equal(voiceMetadata.mode, "voice");
assert.equal(voiceMetadata.mime, "audio/wav");
assert.equal(voiceMetadata.caption, "");

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
const earlyDoc = { body: null, querySelector: () => null, querySelectorAll: () => [], addEventListener: (name, fn) => listeners.set(name, fn), hasFocus: () => false };
const initialCreate = () => "blob:early";
const earlyRoot = { location: { origin: "https://web.whatsapp.com" }, document: earlyDoc, File, URL: { createObjectURL: initialCreate }, addEventListener() {}, dispatchEvent(event) { assert.equal(event.type, "whatrust-schedule-ready"); }, Event, setTimeout, MutationObserver: class { observe(target) { assert.equal(target, earlyDoc.body); observed++; } }, __TAURI__: { core: { invoke: async () => ({ schedules: [], review: [], pending_accounts: [] }) } } };
earlyRoot.window = earlyRoot;
vm.runInNewContext(source, earlyRoot);
assert.notEqual(earlyRoot.URL.createObjectURL, initialCreate);
assert.equal(observed, 0);
assert.equal(typeof listeners.get("DOMContentLoaded"), "function");
earlyDoc.body = {};
listeners.get("DOMContentLoaded")();
assert.equal(observed, 1);

// WA can expose Send through a label or test ID before it has an active WPP model.
const visibleNode = { getClientRects: () => [{}] };
const inputBox = { ...visibleNode, closest: selector => selector.includes("footer,") ? composeFooter : null };
const send = { ...visibleNode, closest: selector => selector.startsWith("button") ? send : null };
const hiddenSend = { getClientRects: () => [], closest: selector => selector.startsWith("button") ? hiddenSend : null };
const wrap = { children: [send] };
const composeFooter = { children: [inputBox, wrap], contains: node => [send, hiddenSend].includes(node), querySelectorAll: selector => selector.includes("compose-btn-send") ? [hiddenSend, send] : [] };
send.parentElement = wrap;
wrap.parentElement = composeFooter;
const composeDoc = { querySelector: () => ({ querySelectorAll: () => [inputBox] }) };
const context = api.composerContext(composeDoc);
assert.equal(context.input, inputBox);
assert.equal(context.action, send, "the visible Send action wins");
assert.equal(api.actionSlot(send, composeFooter), wrap, "the clock sits outside a clipped native wrapper");

// Schedule page regression: readiness changes update existing controls, not rows.
let focused;
class ListNode {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = {}; this.style = {}; this.events = {}; this.textContent = ""; this.hidden = false;
    this.classList = {
      contains: name => String(this.className || "").split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...String(this.className || "").split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = String(this.className || "").split(/\s+/).filter(name => !names.includes(name)).join(" "); },
      toggle: (name, force) => { const on = force ?? !this.classList.contains(name); this.classList[on ? "add" : "remove"](name); return on; }
    };
  }
  get textContent() { return (this._text || "") + this.children.map(child => child.textContent).join(""); }
  set textContent(text) { this._text = String(text); for (const child of this.children || []) child.parentNode = null; this.children = []; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  attachShadow() { this.shadowRoot = new ListNode("shadow"); this.shadowRoot.parentNode = this; return this.shadowRoot; }
  setAttribute(key, value) { this.attrs[key] = value; if (key === "id") this.id = String(value); if (key === "class") this.className = String(value); if (key === "hidden") this.hidden = true; }
  getAttribute(key) { return key === "class" ? this.className || null : key === "id" ? this.id || null : Object.hasOwn(this.attrs, key) ? String(this.attrs[key]) : null; }
  removeAttribute(key) { delete this.attrs[key]; if (key === "hidden") this.hidden = false; }
  addEventListener(name, handler) { this.events[name] = handler; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  get isConnected() { return this === listDoc.body || !!this.parentNode?.isConnected; }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  focus() { focused = this; listDoc.activeElement = this; }
  matches(selector) {
    return selector.split(",").some(part => {
      part = part.trim();
      const tag = /^[\w-]+/.exec(part);
      if (tag && this.tagName !== tag[0]) return false;
      for (const [, id] of part.matchAll(/#([\w-]+)/g)) if (this.id !== id) return false;
      for (const [, name] of part.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
      for (const [, key, , value] of part.matchAll(/\[([^=\]]+)(?:=(['"]?)([^'"\]]*)\2)?\]/g)) if (value === undefined ? this.getAttribute(key) === null : this.getAttribute(key) !== value) return false;
      return true;
    });
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  click() { return this.events.click?.({ target: this }); }
}
const listDoc = { body: new ListNode("body"), createElement: tag => new ListNode(tag), createElementNS: (_namespace, tag) => new ListNode(tag), querySelector: () => null, querySelectorAll: () => [], hasFocus: () => false, addEventListener() {} };
const missed = { occurrence_id: "voice", schedule_id: "v", chat_id: "123@c.us", chat_name: "Ada", state: "missed", due_ms: 1, attachments: [{ name: "voice.ogg", mode: "voice" }] };
const failed = { ...missed, occurrence_id: "failed", schedule_id: "f", state: "failed" };
const unrelated = { ...missed, occurrence_id: "other", schedule_id: "o", chat_id: "456@c.us" };
let liveState = { schedules: [], review: [missed, failed, unrelated], can_send: false, pending_accounts: [] };
let snapshotImpl = async () => liveState, decideImpl, decisions = [];
const listRoot = { location: { origin: "https://web.whatsapp.com" }, document: listDoc, __WR_LANG: "en", File, Event, URL: {}, addEventListener() {}, dispatchEvent() {}, setTimeout: () => 0, MutationObserver: class { observe() {} }, __TAURI__: { core: { invoke(cmd, args) {
  if (cmd === "schedule_snapshot") return snapshotImpl();
  assert.equal(cmd, "schedule_decide"); decisions.push(args); return decideImpl();
} } } };
listRoot.window = listRoot;
vm.runInNewContext(source, listRoot);
const settle = () => new Promise(resolve => setImmediate(resolve));
const leftColumn = listDoc.body.appendChild(new ListNode("div"));
const pageRequests = [];
let unmountPage;
function closePage() {
  unmountPage?.();
  unmountPage = undefined;
}
listRoot.__wrShowScheduledPage = options => {
  pageRequests.push(options);
  closePage();
  unmountPage = listRoot.__wrMountScheduledPage(leftColumn, options, closePage);
};
const currentPage = () => leftColumn.children[0]?.shadowRoot.querySelector("section.schedule-page");
const editorDialog = () => listDoc.body.children.find(node => node.id === "__whatrust_schedule")?.shadowRoot.querySelector("dialog");
listRoot.__whatrustScheduleOpen(true, { id: "123@c.us", name: "Ada" });
await settle();
let listPage = currentPage();
assert(listPage, "the chat-scoped scheduler mounts in the host column");
assert.equal(editorDialog(), undefined, "opening a list does not open a modal dialog");
assert.equal(pageRequests[0].chatOnly, true);
assert.equal(pageRequests[0].chat.id, "123@c.us");
assert.equal(pageRequests[0].missedOnly, false);
const rows = listPage.querySelectorAll("article");
assert.equal(rows.length, 2, "chat filter remains applied");
const sendNow = rows[0].querySelectorAll("button")[0], skip = rows[0].querySelectorAll("button")[1], retry = rows[1].querySelectorAll("button")[0];
assert.equal(sendNow.disabled, true); assert.equal(retry.disabled, true); assert.equal(skip.disabled, false);
assert(listPage.querySelectorAll("p").some(node => /Keep this WhatsApp account open/.test(node.textContent)));
skip.focus();
liveState = { ...liveState, can_send: true };
listRoot.__wrScheduleChanged(); await settle();
assert.equal(sendNow.disabled, false); assert.equal(retry.disabled, false);
assert.equal(focused, skip, "readiness updates preserve keyboard focus");
assert.equal(listPage.querySelectorAll("article")[0], rows[0], "readiness does not rebuild rows");
assert.equal(decisions.length, 0, "readiness never approves a send");

// Newer snapshot wins when readiness fetches complete out of order.
const pendingSnapshots = [];
snapshotImpl = () => new Promise(resolve => pendingSnapshots.push(resolve));
listRoot.__wrScheduleChanged(); listRoot.__wrScheduleChanged();
pendingSnapshots[1]({ ...liveState, can_send: true }); await settle();
pendingSnapshots[0]({ ...liveState, can_send: false }); await settle();
assert.equal(sendNow.disabled, false);
snapshotImpl = async () => liveState;

let rejectDecision;
decideImpl = () => new Promise((resolve, reject) => { rejectDecision = reject; });
const firstClick = sendNow.click(); const duplicateClick = sendNow.click();
assert.equal(decisions.length, 1, "duplicate clicks cannot submit twice");
listRoot.__wrScheduleChanged(); await settle();
assert.equal(sendNow.disabled, true, "refresh cannot unlock an in-flight action");
liveState = { ...liveState, can_send: false };
listRoot.__wrScheduleChanged(); await settle();
rejectDecision(Error("account_unavailable")); await firstClick; await duplicateClick;
assert.equal(sendNow.disabled, true, "failure respects latest unavailable readiness");
assert.equal(skip.disabled, false);
liveState = { ...liveState, can_send: true };
listRoot.__wrScheduleChanged(); await settle();

let finishDecision;
decideImpl = () => new Promise(resolve => { finishDecision = resolve; });
const staleClick = retry.click();
listRoot.__whatrustScheduleMissed(); await settle();
const newerPage = currentPage();
const retryWhilePending = newerPage.querySelectorAll("button").find(node => node.textContent === "Retry");
assert.equal(retryWhilePending.disabled, true, "reopening cannot duplicate a pending decision");
const pendingCount = decisions.length;
await retryWhilePending.click(); assert.equal(decisions.length, pendingCount);
finishDecision({}); await staleClick;
assert.equal(currentPage(), newerPage, "old decision response cannot replace the current page");
const beforeStale = decisions.length;
await sendNow.click();
assert.equal(decisions.length, beforeStale, "detached page action is ignored");
assert.equal(newerPage.querySelectorAll("article").length, 3, "the current page keeps its account-wide review scope");

// A review that changed to uncertain must never retain a live Retry action.
listRoot.__whatrustScheduleOpen(true, { id: "123@c.us", name: "Ada" }); await settle();
listPage = currentPage();
const staleRetry = listPage.querySelectorAll("article")[1].querySelectorAll("button")[0];
liveState = { ...liveState, review: [missed, { ...failed, state: "uncertain" }, unrelated] };
listRoot.__wrScheduleChanged(); await settle();
assert.equal(staleRetry.disabled, true);
assert(listPage.querySelectorAll("p").some(node => /pending send changed/.test(node.textContent)));
await staleRetry.click(); assert.equal(decisions.length, beforeStale);

// Page tabs separate future schedules from review work, including a recurring
// series that has both an upcoming send and a missed occurrence.
const upcoming = { id: "future", revision: 1, chat_id: "123@c.us", chat_name: "Ada", text: "Future message", attachments: [], next_due_ms: Date.UTC(2026, 11, 4, 15), local_at: "2026-12-04T08:00", time_zone: "America/Denver", successful_sends: 0 };
const recurringUpcoming = { ...upcoming, id: "v", text: "Next recurring send", repeat: { unit: "week", interval: 1, end_date: null, max_sends: null } };
const foreignUpcoming = { ...upcoming, id: "foreign", chat_id: "456@c.us", chat_name: "Another chat" };
const completed = { ...upcoming, id: "completed", next_due_ms: null };
const uncertain = { ...missed, occurrence_id: "uncertain", schedule_id: "u", state: "uncertain" };
liveState = { ...liveState, schedules: [upcoming, recurringUpcoming, foreignUpcoming, completed], review: [missed, failed, uncertain, unrelated] };
const pageTab = (page, name) => page.querySelector(`button[data-schedule-tab='${name}']`);
const pagePane = (page, name) => page.querySelector(`section[data-schedule-pane='${name}']`);
const tabCount = (page, name) => Number(pageTab(page, name).querySelector("span.schedule-count").textContent);
listRoot.__whatrustScheduleOpen(true, { id: "123@c.us", name: "Ada" }); await settle();
listPage = currentPage();
assert.equal(listPage.querySelector("dialog"), null, "the host page contains no modal dialog");
assert.equal(listPage.querySelectorAll("[role='tab']").length, 2);
const upcomingTab = pageTab(listPage, "upcoming"), attentionTab = pageTab(listPage, "attention");
const upcomingPane = pagePane(listPage, "upcoming"), attentionPane = pagePane(listPage, "attention");
assert.match(upcomingTab.textContent, /Upcoming/); assert.match(attentionTab.textContent, /Needs attention/);
assert.equal(tabCount(listPage, "upcoming"), 2, "completed and unrelated future schedules are excluded");
assert.equal(tabCount(listPage, "attention"), 3, "attention count includes matching missed, failed and uncertain items");
assert.equal(attentionTab.getAttribute("aria-selected"), "true", "matching review defaults to Needs attention");
assert.equal(upcomingTab.getAttribute("aria-selected"), "false");
assert.equal(attentionPane.hidden, false); assert.equal(upcomingPane.hidden, true);
assert.equal(attentionPane.getAttribute("role"), "tabpanel"); assert.equal(upcomingPane.getAttribute("role"), "tabpanel");
assert.equal(attentionPane.getAttribute("aria-labelledby"), attentionTab.id);
assert.equal(upcomingPane.getAttribute("aria-labelledby"), upcomingTab.id);
assert.equal(attentionPane.querySelectorAll("article").length, 3);
assert.equal(upcomingPane.querySelectorAll("article").length, 2);
assert(attentionPane.textContent.includes("Voice note"), "saved voice note remains identifiable in review");
for (const label of ["Missed", "Incomplete", "Check delivery"]) assert(attentionPane.textContent.includes(label), `attention explicitly labels ${label}`);
assert(!upcomingPane.textContent.includes("Send now"), "future schedules never inherit missed-send actions");
assert(!attentionPane.textContent.includes("Cancel schedule"), "review rows remain independent from schedule management");
const uncertainRow = attentionPane.querySelectorAll("article").find(row => row.textContent.includes("Check delivery"));
assert.equal(uncertainRow.querySelectorAll("button").length, 1, "uncertain review offers only Skip");
assert.equal(uncertainRow.querySelector("button").textContent, "Skip");
const savedAttentionRow = attentionPane.querySelector("article"), savedUpcomingRow = upcomingPane.querySelector("article");
await upcomingTab.click();
assert.equal(upcomingTab.getAttribute("aria-selected"), "true");
assert.equal(upcomingPane.hidden, false); assert.equal(attentionPane.hidden, true);
assert.equal(savedAttentionRow.isConnected, true); assert.equal(savedUpcomingRow.isConnected, true);
assert.equal(upcomingPane.querySelector("article"), savedUpcomingRow, "tab changes preserve existing upcoming nodes");
assert.equal(attentionPane.querySelector("article"), savedAttentionRow, "tab changes preserve review nodes");
upcomingTab.focus();
liveState = { ...liveState, can_send: false };
listRoot.__wrScheduleChanged(); await settle();
assert.equal(focused, upcomingTab, "readiness refresh preserves selected-tab keyboard focus");
assert.equal(upcomingTab.getAttribute("aria-selected"), "true", "readiness refresh preserves explicit tab choice");
await attentionTab.click();
assert.equal(attentionPane.hidden, false);
assert.equal(attentionPane.querySelector("article"), savedAttentionRow);
const keyTab = (tab, key) => { let prevented = false; tab.events.keydown({ key, preventDefault() { prevented = true; } }); assert.equal(prevented, true); };
keyTab(attentionTab, "Home");
assert.equal(focused, upcomingTab); assert.equal(upcomingTab.tabIndex, 0); assert.equal(attentionTab.tabIndex, -1);
keyTab(upcomingTab, "ArrowRight");
assert.equal(focused, attentionTab); assert.equal(attentionPane.hidden, false);
keyTab(attentionTab, "ArrowLeft");
assert.equal(focused, upcomingTab); assert.equal(upcomingPane.hidden, false);
keyTab(upcomingTab, "End");
assert.equal(focused, attentionTab); assert.equal(attentionTab.getAttribute("aria-selected"), "true");
assert.equal(decisions.length, beforeStale, "tab navigation never approves a send");

listRoot.__whatrustScheduleMissed(); await settle();
listPage = currentPage();
assert.equal(pageRequests.at(-1).chatOnly, false, "missed sends open account-wide");
assert.equal(pageRequests.at(-1).missedOnly, true, "missed sends request the attention tab");
assert.equal(pageTab(listPage, "attention").getAttribute("aria-selected"), "true", "missed prompt selects attention");
assert.equal(tabCount(listPage, "upcoming"), 3, "account-wide view includes future items from other chats");
assert.equal(tabCount(listPage, "attention"), 4);
await pageTab(listPage, "upcoming").click();
assert.equal(pagePane(listPage, "upcoming").hidden, false, "explicit review entry still permits Upcoming navigation");

liveState = { ...liveState, review: [unrelated] };
listRoot.__whatrustScheduleOpen(true, { id: "123@c.us", name: "Ada" }); await settle();
listPage = currentPage();
assert.equal(pageTab(listPage, "upcoming").getAttribute("aria-selected"), "true", "unrelated review does not select attention in this chat");
assert.equal(tabCount(listPage, "attention"), 0);
assert.equal(tabCount(listPage, "upcoming"), 2);
assert.equal(pagePane(listPage, "attention").querySelectorAll("article").length, 0);

listRoot.__whatrustScheduleOpen(false); await settle();
listPage = currentPage();
assert.equal(pageRequests.at(-1).chatOnly, false);
assert.equal(pageRequests.at(-1).chat, null);
assert.equal(pageRequests.at(-1).missedOnly, false);
assert.equal(tabCount(listPage, "upcoming"), 3, "the general entry includes upcoming schedules in every chat");
assert.equal(tabCount(listPage, "attention"), 1, "the general entry includes review from other chats");

await pageTab(listPage, "upcoming").click();
const edit = pagePane(listPage, "upcoming").querySelector("article").querySelector("button");
edit.focus();
await edit.click();
assert.equal(editorDialog()?.open, true, "editing a schedule still opens the modal editor");
assert.equal(currentPage(), listPage, "the schedule page stays mounted behind the editor");
editorDialog().close();
assert.equal(currentPage(), listPage, "closing the editor returns to the same schedule page");
assert.equal(focused, edit, "closing the editor restores focus to the schedule action");

let completeRefresh;
snapshotImpl = () => new Promise(resolve => { completeRefresh = resolve; });
listRoot.__wrScheduleChanged();
const close = listPage.querySelector("button[aria-label='Close']");
await close.click();
assert.equal(leftColumn.children.length, 0, "closing the page removes its mounted content");
assert.equal(listPage.isConnected, false);
completeRefresh(liveState); await settle();
assert.equal(currentPage(), undefined, "a late refresh cannot reopen the closed page");
console.log("schedule-ui: passed chat, draft, recurrence, review, original-file identity and staged transfer tests");

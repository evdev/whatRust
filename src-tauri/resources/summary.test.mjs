// Run: node src-tauri/resources/summary.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "summary.js"), "utf8");

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
    this.parentNode = null;
    this.id = "";
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  get parentElement() { return this.parentNode; }
}

function headerButton(kind, label) {
  const main = new El("div");
  main.id = "main";
  const header = new El("header");
  const button = new El("button");
  button.setAttribute("aria-label", label);
  button.setAttribute("data-icon", kind);
  header.appendChild(button);
  main.appendChild(header);
  return button;
}

globalThis.window = globalThis;
globalThis.location = { origin: "https://web.whatsapp.com" };
globalThis.__WHATRUST_TEST = true;
globalThis.__WR_LANG = "en";
eval(source);
const api = globalThis.__whatrustSummaryApi;

const day = 86400000;
const hour = 3600000;
const now = 10 * day + 10 * hour;
assert(api.dayStart(now, 0) === 10 * day, "utc midnight is the start of today");
assert(api.windowBounds("1h", now, 0).start === now - hour, "last hour rolls back sixty minutes");
assert(api.windowBounds("4h", now, 0).start === now - 4 * hour, "last four hours roll back");
assert(api.windowBounds("today", now, 0).start === 10 * day, "today starts at local midnight");
assert(api.windowBounds("3d", now, 0).start === now - 72 * hour, "last three days roll back 72 hours");
assert(api.windowBounds("today", now, -60).start === 10 * day + hour, "a negative offset moves midnight");
const near = api.windowBounds("1h", 10 * day + hour, 0);
assert(api.sinceLabel(near.start, near.end, 0) === "00:00", "a range that crosses midnight names the weekday");
assert(api.sinceLabel(day + 2 * hour, day + 3 * hour, 0) === "02:00", "the same day shows only the clock");

const overflow = headerButton("menu", "Menu");
assert(api.inChatHeader(overflow), "the overflow button is in the chat header");
assert(api.controlKind(overflow) === "overflow", "a menu button is the overflow");
const search = headerButton("search", "Search");
assert(api.controlKind(search) === "search", "search is not the overflow");
const video = headerButton("video-call", "Video call");
assert(api.controlKind(video) === "video", "video call is not the overflow");
const chevron = new El("button");
chevron.setAttribute("aria-label", "Message options");
chevron.setAttribute("data-icon", "down-context");
assert(!api.inChatHeader(chevron), "a message chevron is not in the chat header");

const protocol = api.mapMessage({ id: "false_1@c.us_AAA", t: 100, type: "e2e_notification", body: "encrypted" });
assert(protocol === null, "protocol lines are dropped");
const poll = api.mapMessage({ id: "false_1@c.us_POL", t: 150, type: "poll_creation", pollName: "Lunch?" });
assert(poll && poll.text === "[poll] Lunch?", "a poll keeps its question");
const image = api.mapMessage({ id: "false_1@c.us_BBB", t: 200, type: "image", body: "see this" });
assert(image.text === "[image] see this", "an image keeps its caption");
const unnamed = api.mapMessage({ id: "false_1@g.us_CCC", t: 300, type: "chat", body: "hello" });
assert(unnamed.sender === "", "a missing sender is left blank");
const call = api.mapMessage({ id: "false_1@c.us_CALL", t: 180, type: "call_log", body: "Voice call" });
assert(call === null, "a call log is left out of the transcript");
assert(api.displayName({ name: "Ada Lovelace", pushname: "Ada" }, {}) === "Ada Lovelace", "the contact card name wins over the profile name");
assert(api.displayName({ pushname: "Ada" }, {}) === "Ada", "an unsaved contact uses the name they set");
assert(api.displayName({}, { notifyName: "Ada" }) === "Ada", "the message profile name is the fallback");
assert(api.displayName({ name: "+1 555 0100", pushname: "Ada" }, {}) === "Ada", "a phone number is not used as the name");
assert(api.displayName({ mentionName: function () { return "Ada Card"; }, pushname: "Ada" }, {}) === "Ada Card", "a contact-card getter wins");
const quote = "q".repeat(200);
const replied = api.mapMessage({
  id: "true_1@c.us_DDD",
  t: 400,
  type: "chat",
  body: "yes",
  quotedMsg: { body: quote },
});
assert(replied.from_me && replied.quote.length === 120, "a quote is capped at 120 characters");
assert(api.senderField({ sender: { pushname: "Ada" } }) === "pushname", "the profile name is used when there is no saved name");
assert(api.senderField({ sender: { name: "Ada Lovelace", pushname: "Ada" } }) === "name", "the saved name is the field that wins");

const first = { id: "a", token: "a", at: day + hour, from_me: false, sender: "Ada", text: "morning", quote: "", kind: "chat" };
const second = { id: "b", token: "b", at: day + 26 * hour, from_me: true, sender: "Me", text: "later", quote: "", kind: "chat" };
const built = api.buildTranscript([second, first], day, day + 30 * hour, 80000, 0);
assert(built.text.indexOf("Fri 01:00 Ada: morning") === 0, "the first day names the weekday and the person");
const unnamedLine = api.buildTranscript(
  [{ id: "c", token: "c", at: day + hour, from_me: false, sender: "", text: "hi", quote: "", kind: "chat" }],
  day,
  day + 2 * hour,
  80000,
  0,
);
assert(unnamedLine.text.indexOf("Member") < 0, "a missing name is not called Member");
assert(unnamedLine.text.indexOf("01:00: hi") >= 0, "a missing name still keeps the line");
assert(built.text.indexOf("Sat 02:00 You: later") > 0, "a later day is named and your messages say You");
assert(built.anchor === "b" && built.count === 2 && !built.sampled, "the anchor is the newest message");

const long = [];
for (let n = 0; n < 20; n++) {
  long.push({ id: String(n), token: String(n), at: n + 1, from_me: false, sender: "Ada", text: "x".repeat(20), quote: "", kind: "chat" });
}
const clipped = api.buildTranscript(long, 0, 100, 80, 0);
assert(clipped.sampled, "a transcript past the cap is marked sampled");
assert(clipped.text.length <= 80, "the kept text fits the cap");
assert(clipped.coveredFrom > 1, "sampling drops the oldest messages");
assert(clipped.anchor === "19", "the newest message stays");

const wide = [];
for (let n = 0; n < 5; n++) {
  wide.push({ id: String(n), token: String(n), at: n + 1, from_me: false, sender: "Ada", text: "x".repeat(15000), quote: "", kind: "chat" });
}
const one = api.buildTranscript(wide, 0, 100, 80000, 0);
assert(!one.sampled && one.text.split("\n").length === 5, "a normal stretch is one call, not several chunks");
assert(api.packedChunks(one.text) === 1, "seventy-five thousand characters fit in one context window");
const huge = [];
for (let n = 0; n < 3; n++) {
  huge.push({ id: String(n), token: String(n), at: n + 1, from_me: false, sender: "Ada", text: "x".repeat(200000), quote: "", kind: "chat" });
}
const two = api.buildTranscript(huge, 0, 100, 600000, 0);
assert(two.sampled && two.coveredFrom === 2, "only the newest text past two context windows is dropped");
assert(api.packedChunks(two.text) <= 2, "the sent text fits in two model calls");

const notes = [];
for (let n = 0; n < 501; n++) notes.push({ id: "n" + n, at: n, kind: n % 2 ? "audio" : "ptt", text: "[voice note]" });
notes.push({ id: "chat", at: 3, kind: "chat", text: "hi" });
const keptNotes = api.newestNotes(notes);
assert(keptNotes.length === 500 && keptNotes[0].id === "n1" && keptNotes[499].id === "n500", "only the newest 500 voice notes are requested");
const ordered = api.newestNotes([
  { id: "b", at: 2, kind: "audio", text: "[voice note]" },
  { id: "a", at: 1, kind: "ptt", text: "[voice note]" },
]);
assert(ordered[0].id === "a" && ordered[1].id === "b", "voice notes are requested oldest first");

assert(api.historyStep("", Infinity, "m2", 50, false) === "next", "the first history page moves backward");
assert(api.historyStep("m2", 50, "m1", 40, false) === "next", "an older page is progress");
assert(api.historyStep("m2", 50, "m1", 50, false) === "next", "the same second still moves when the id does");
assert(api.historyStep("m2", 50, "m2", 40, false) === "done", "the same page is the end of the history");
assert(api.historyStep("m2", 50, "", 40, false) === "done", "a page with no id is the end of the history");
assert(api.historyStep("m2", 50, "m1", 10, true) === "done", "a message before the window ends the scan");
assert(api.historyStep("m2", 50, "m9", 80, false) === "stall", "a page that jumps forward is not progress");
assert(api.normalizeChatId("false_1555@c.us_ABCDEF") === "1555@c.us", "a message row still names its chat");
assert(api.describeChat({ id: { toString() { return "1555@c.us"; } }, formattedTitle: "Ada" }).id === "1555@c.us", "a chat id that only prints as text is kept");
const throwing = { id: "1555@g.us" };
Object.defineProperty(throwing, "formattedTitle", { get() { throw new Error("title"); } });
Object.defineProperty(throwing, "contact", { get() { throw new Error("contact"); } });
const described = api.describeChat(throwing);
assert(described && described.id === "1555@g.us" && described.group === true, "a chat is kept when its name cannot be read");
assert(api.describeChat({ then() {}, id: "1555@c.us", formattedTitle: "Ada" }).id === "1555@c.us", "a chat model with then is still a chat");
assert(api.describeChat({ then() {} }) === null, "a promise is not a chat");
assert(source.includes('item.textContent = "• " + point'), "each summary point is drawn with a bullet");
assert(source.includes("display:block;margin:3px 0"), "each bullet is on its own line");
assert(source.includes("white-space") || source.includes("whiteSpace"), "a fallback card keeps the line breaks");

if (failures) {
  console.error(failures + " failed");
  process.exit(1);
}
console.log("summary tests passed");

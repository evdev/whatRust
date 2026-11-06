// Run: node src-tauri/resources/device.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "device.js"), "utf8");

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
    this.textContent = "";
    this.scrollHeight = 0;
    this.clientHeight = 0;
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
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    const at = this.children.indexOf(ref);
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }
  get parentElement() { return this.parentNode; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const at = this.parentNode.children.indexOf(this);
    return at >= 0 ? this.parentNode.children[at + 1] || null : null;
  }
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
  return selector.split(",").some((part) => matchesOne(el, part.trim()));
}
function matchesOne(el, selector) {
  if (!selector) return false;
  let rest = selector;
  let tagName = null;
  const tag = rest.match(/^[a-zA-Z][\w-]*/);
  if (tag) {
    tagName = tag[0];
    rest = rest.slice(tag[0].length);
  }
  const attrs = [];
  while (rest.startsWith("[")) {
    const found = rest.match(/^\[([^\]=]+)(?:="([^"]*)")?\]/);
    if (!found) return false;
    attrs.push([found[1], found[2]]);
    rest = rest.slice(found[0].length);
  }
  if (rest) return false;
  if (tagName && String(el.tagName).toLowerCase() !== tagName.toLowerCase()) return false;
  if (!tagName && attrs.length === 0) return false;
  for (const [key, value] of attrs) {
    const got = el.getAttribute(key);
    if (got == null) return false;
    if (value !== undefined && got !== value) return false;
  }
  return true;
}

const web = "3EB0" + "A".repeat(18);
const apple = "3A" + "B".repeat(18);
const desktop18 = "C".repeat(18);
const android32 = "D".repeat(32);
const android21 = "E".repeat(21);
const desktop3F = "3FBBHEUFEUVUF783B839FB8F3";

globalThis.window = globalThis;
globalThis.location = { origin: "https://web.whatsapp.com" };
globalThis.__WHATRUST_TEST = true;
globalThis.__WHATRUST_DEVICE = false;
globalThis.__WR_LANG = "en";
globalThis.document = {
  createElement: (tag) => new El(tag),
  createElementNS: (_ns, tag) => new El(tag),
  getElementById: () => null,
  querySelector: () => null,
};
eval(source);
const api = globalThis.__whatrustDeviceApi;

assert(web.length === 22, "web ids are 22 characters");
assert(apple.length === 20, "apple ids are 20 characters");
assert(desktop3F.length === 25, "the desktop 3F sample is longer than 22");

assert(api.deviceOf(web) === "computer", "3EB0 web id is a computer");
assert(api.deviceOf("3E" + "1".repeat(20)) === "computer", "Baileys web shape is a computer");
assert(api.deviceOf(apple) === "apple", "3A plus 18 is an Apple device");
assert(api.deviceOf("3A" + "F".repeat(16)) === "apple", "a shorter 3A id is still Apple");
assert(api.deviceOf(android32) === "android", "32-character id is Android");
assert(api.deviceOf(android21) === "android", "21-character id is Android");
assert(api.deviceOf("AB".repeat(13)) === "android", "other ids longer than 22 are Android");
assert(api.deviceOf("3A" + "F".repeat(30)) === "android", "a long id that happens to start with 3A stays Android");
assert(api.deviceOf(desktop18) === "computer", "18-character id is a computer");
assert(api.deviceOf(desktop3F) === "computer", "3F prefix is a computer, even when longer than 22");
assert(api.deviceOf("2A327AC82CD56D95E087") === "", "an unrecognized 20-character id is left unmarked");
assert(api.deviceOf("") === "", "empty id is unmarked");
assert(api.deviceOf("abc") === "", "a short id is unmarked");

const participant = "false_15551212@c.us_" + web + "_5511999@c.us";
assert(api.messageToken(participant) === web, "group participant suffix is not part of the message id");
assert(api.messageToken("true_120363@g.us_" + android32) === android32, "legacy compound data-id yields the message id");
assert(api.messageToken(apple) === apple, "current WhatsApp Web data-id is the bare message id");
assert(api.messageToken("123456789@c.us") === "", "a chat jid is not a message id");
assert(api.messageToken("false_not-a-jid_" + web) === "", "a compound id whose chat has no @ is ignored");

assert(api.isEnabled() === false, "a saved off switch starts disabled");
api.setEnabled(true);
assert(api.isEnabled() === true, "the switch can turn the icons on");

function row(id, time, extra) {
  const message = new El("div");
  message.setAttribute("data-id", id);
  const plain = new El("div");
  plain.setAttribute("data-pre-plain-text", "[" + time + ", 11/6/2026] Ana: ");
  if (extra) {
    const duration = new El("span");
    duration.textContent = extra;
    plain.appendChild(duration);
  }
  const body = new El("span");
  body.textContent = "oi";
  const clock = new El("span");
  clock.textContent = time;
  plain.appendChild(body);
  plain.appendChild(clock);
  message.appendChild(plain);
  return { message, clock };
}

const sample = row("false_1@c.us_" + web, "14:05", "0:12");
assert(api.clockSpan(sample.message) === sample.clock, "the message time wins over a voice-note duration");
api.paint(sample.message);
api.paint(sample.message);
const icons = sample.message.querySelectorAll("[data-wr-device]");
assert(icons.length === 1, "painting twice keeps a single icon");
assert(icons[0].getAttribute("data-wr-device") === "computer", "a web message shows the computer icon");
assert(icons[0].nextSibling === sample.clock, "the icon sits immediately before the time");
assert(icons[0].getAttribute("title") === "Sent from a computer", "the tooltip names a computer");
assert(icons[0].querySelector("svg"), "the icon is an svg");

const phone = row(apple, "9:41");
api.paint(phone.message);
assert(phone.message.querySelector("[data-wr-device]").getAttribute("data-wr-device") === "apple", "an Apple id shows the Apple icon");
assert(phone.message.querySelector("[data-wr-device]").getAttribute("title") === "Sent from an Apple device", "Apple tooltip in English");

globalThis.__WR_LANG = "pt-BR";
api.relabel(phone.message);
assert(phone.message.querySelector("[data-wr-device]").getAttribute("title") === "Enviada de um aparelho Apple", "Apple tooltip follows the language");
globalThis.__WR_LANG = "en";

const unknown = row("2A327AC82CD56D95E087", "8:01");
api.paint(unknown.message);
assert(unknown.message.querySelector("[data-wr-device]") === null, "an unrecognized id gets no icon");

const mismatched = row(web, "14:05", "0:12");
mismatched.message.querySelector("[data-pre-plain-text]").setAttribute("data-pre-plain-text", "[16:40, 11/6/2026] Ana: ");
mismatched.clock.textContent = "0:12";
assert(api.clockSpan(mismatched.message) === null, "a duration is not used when the real time is missing");
api.paint(mismatched.message);
assert(mismatched.message.querySelector("[data-wr-device]") === null, "no clock means no icon");

api.setEnabled(false);
api.paint(sample.message);
assert(sample.message.querySelector("[data-wr-device]") === null, "turning the feature off removes the icon");
api.setEnabled(true);

const main = new El("div");
const outer = new El("div");
outer.setAttribute("data-id", "false_1@c.us_" + web);
const inner = new El("div");
inner.setAttribute("data-id", "false_1@c.us_" + apple);
outer.appendChild(inner);
main.appendChild(outer);
const found = api.messageNodes(main);
assert(found.length === 1 && found[0] === outer, "a message nested inside another is not marked separately");

const bare = new El("div");
bare.setAttribute("data-id", android32);
main.appendChild(bare);
assert(api.messageNodes(main).indexOf(bare) !== -1, "a bare Android id is a message row");

const chat = new El("div");
chat.setAttribute("data-id", "15551212@c.us");
main.appendChild(chat);
assert(api.messageNodes(main).indexOf(chat) === -1, "the chat list id is not a message");

document.getElementById = (id) => (id === "main" ? main : null);
assert(api.conversation() === main, "the open chat is #main");
const orphanHost = new El("div");
const orphan = new El("span");
orphan.setAttribute("data-wr-device", "android");
orphanHost.appendChild(orphan);
main.appendChild(orphanHost);
api.scan();
assert(orphan.parentNode === null, "a leftover icon outside a message is removed");

const narrow = row(web, "2:05 PM");
narrow.clock.textContent = "2:05\u202fPM";
assert(api.clockSpan(narrow.message) === narrow.clock, "a narrow space before AM/PM still matches the time");

if (failures) {
  console.error("\n" + failures + " failed");
  process.exit(1);
}
console.log("\nall device tests passed");

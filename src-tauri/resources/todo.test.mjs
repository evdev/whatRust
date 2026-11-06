// Run: node src-tauri/resources/todo.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "todo.js"), "utf8");

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
    this.textContent = "";
    this.id = "";
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
  get parentElement() { return this.parentNode; }
}

function box(width, height, left, top) {
  left = left || 0;
  top = top || 0;
  return { width, height, left: left, top: top, right: left + width, bottom: top + height };
}

globalThis.window = globalThis;
globalThis.location = { origin: "https://web.whatsapp.com" };
globalThis.__WHATRUST_TEST = true;
globalThis.__WR_LANG = "en";
globalThis.document = { getElementById: () => null, body: null };
eval(source);
const api = globalThis.__whatrustTodoApi;

const web = "3EB0" + "A".repeat(18);
assert(api.messageToken("false_15551212@c.us_" + web + "_5511999@c.us") === web, "group suffix is not part of the token");
assert(api.messageToken("true_120363@g.us_" + "D".repeat(32)) === "D".repeat(32), "legacy compound id yields the token");
assert(api.messageToken(web) === web, "a bare message id is its own token");
assert(api.messageToken("123456789@c.us") === "", "a chat id is not a message id");
assert(api.messageToken("false_not-a-jid_" + web) === "", "a compound id without a jid is ignored");
assert(api.chatFromId("false_15551212@c.us_" + web) === "15551212@c.us", "chat jid comes from the compound id");
assert(api.chatFromId(web) === "", "a bare id has no chat jid");

const plain = api.parsePlain("[12:41, 6/11/2026] Ada: ");
assert(plain.time === "12:41, 6/11/2026" && plain.sender === "Ada", "plain text keeps the clock and sender");

const day = 86400000;
const hour = 3600000;
const now = day + hour;
assert(api.dayStart(now, 0) === day, "utc day starts at midnight");
assert(api.dayStart(now, -60) === now, "utc-1 midnight is the current hour");
assert(api.dayStart(now, 60) === day - hour, "utc+1 midnight was an hour earlier");

const row = new El("div");
row.setAttribute("data-id", "false_15551212@c.us_" + web);
const plainNode = new El("span");
plainNode.setAttribute("data-pre-plain-text", "[12:41, 6/11/2026] Ada: ");
const text = new El("span");
text.setAttribute("class", "selectable-text");
text.textContent = "please send the file";
const voice = new El("div");
voice.setAttribute("data-wr-voice", "1");
voice.textContent = "transcript";
row.appendChild(plainNode);
row.appendChild(text);
row.appendChild(voice);
const extracted = api.extractDom(row);
assert(extracted.msg_token === web, "dom extract keeps the bare token");
assert(extracted.chat_id === "15551212@c.us", "dom extract keeps the chat");
assert(extracted.sender === "Ada", "dom extract reads the sender");
assert(extracted.snippet === "please send the file\ntranscript", "dom extract includes a voice transcript");
assert(extracted.kind === "text", "text plus a transcript stays text");

const bare = new El("div");
bare.setAttribute("data-id", web);
const icon = new El("span");
icon.setAttribute("data-icon", "audio-play");
bare.appendChild(icon);
assert(api.extractDom(bare).kind === "voice", "a play icon marks a voice note");
assert(api.extractDom(bare).msg_id === web, "a bare data-id is stored whole");

const app = new El("div");
app.id = "app";
const rail = new El("header");
rail.id = "rail";
rail.getBoundingClientRect = () => box(64, 800, 0);
const chats = new El("button");
chats.setAttribute("aria-label", "Chats");
const meta = new El("button");
meta.setAttribute("aria-label", "Meta AI");
rail.appendChild(chats);
rail.appendChild(meta);
const side = new El("div");
side.id = "side";
side.getBoundingClientRect = () => box(420, 800, 64);
const main = new El("div");
main.id = "main";
const convo = new El("header");
convo.getBoundingClientRect = () => box(64, 800, 500);
convo.appendChild(new El("button"));
convo.appendChild(new El("button"));
main.appendChild(convo);
app.appendChild(rail);
app.appendChild(side);
app.appendChild(main);
const doc = {
  body: app,
  getElementById(id) {
    if (id === "app") return app;
    if (id === "main") return main;
    if (id === "side") return side;
    return null;
  },
};
assert(api.findRail(doc) === rail, "the narrow left rail is chosen over the conversation header");
assert(api.findMetaButton(rail) === meta, "Meta AI is found by its label");
const noMeta = new El("header");
noMeta.getBoundingClientRect = () => box(64, 800, 0);
noMeta.appendChild(new El("button"));
noMeta.appendChild(new El("button"));
assert(api.findMetaButton(noMeta) === null, "a rail without Meta AI has no meta button");
assert(api.chooseAnchor(doc).el === meta && api.chooseAnchor(doc).mode === "rail", "without a switcher the icon follows Meta AI");
const switcher = new El("button");
switcher.id = "__whatrust_accounts";
side.appendChild(switcher);
const controls = new El("span");
controls.id = "__whatrust_controls";
side.appendChild(controls);
const lookup = doc.getElementById;
doc.getElementById = function (id) {
  if (id === "__whatrust_accounts") return switcher;
  if (id === "__whatrust_controls") return controls;
  return lookup(id);
};
assert(api.chooseAnchor(doc).el === switcher && api.chooseAnchor(doc).mode === "switcher", "the account switcher wins over Meta AI");
switcher.parentNode.removeChild(switcher);
assert(api.chooseAnchor(doc).el === controls, "the Windows account controls are the next choice");
controls.parentNode.removeChild(controls);
assert(api.anchorPlacement("switcher", "row", 64, 800) === "after", "a narrow rail keeps the button in the column");
assert(api.anchorPlacement("switcher", "row", 420, 59) === "below", "a horizontal header puts the button under the switcher");
assert(api.anchorPlacement("switcher", "column", 420, 400) === "after", "a vertical stack already places it below");
assert(api.anchorPlacement("rail", "row", 420, 59) === "after", "the rail fallback stays in flow");

const openItem = { id: "a", title: "send file", note: "", done: false, due_at: now - day, priority: "high", created_at: 2, message: { sender: "Ada", chat_name: "Ada", snippet: "file" } };
const todayItem = { id: "b", title: "today", note: "note", done: false, due_at: now, priority: "low", created_at: 3, remind_at: now + 2 * day };
const laterItem = { id: "c", title: "later", note: "", done: false, due_at: now + 3 * day, priority: "normal", created_at: 1 };
const doneItem = { id: "d", title: "done", note: "", done: true, due_at: now, priority: "normal", created_at: 4 };
const loose = { id: "e", title: "loose", note: "", done: false, priority: "normal", created_at: 5 };
const all = [openItem, todayItem, laterItem, doneItem, loose];
assert(api.badgeFor(all, now, 0).count === 2 && api.badgeFor(all, now, 0).overdue === 1, "the badge counts overdue and due today");
assert(api.badgeFor([loose], now, 0).count === 1, "with no due dates the badge counts open items");
assert(api.badgeFor([laterItem], now, 0).count === 0, "a future due date does not light the badge");
assert(api.filterItems(all, "today", "", now, 0).map((item) => item.id).join() === "b", "today is the local day");
assert(api.filterItems(all, "upcoming", "", now, 0).map((item) => item.id).join() === "c", "upcoming is after today");
assert(api.filterItems(all, "done", "", now, 0).length === 1, "done is its own list");
assert(api.filterItems(all, "open", "", now, 0).map((item) => item.id).join("") === "abce", "open is everything not done");
assert(api.filterItems(all, "open", "ada", now, 0).length === 1, "search matches the sender");
assert(api.sectionOf(openItem, now, 0) === "overdue", "a past due date is overdue");
assert(api.sectionOf(todayItem, now, 0) === "today", "a due date today stays in today");
assert(api.sectionOf(laterItem, now, 0) === "upcoming", "a later due date is upcoming");
assert(api.sectionOf(loose, now, 0) === "none", "no date has no section");
const snoozed = { id: "s", title: "s", done: false, due_at: now - day, snooze_until: now + 2 * day, priority: "normal", created_at: 1 };
assert(api.sectionOf(snoozed, now, 0) === "upcoming", "a future snooze leaves the overdue section");
assert(api.filterItems([snoozed], "upcoming", "", now, 0).length === 1, "a future snooze is upcoming");
assert(api.badgeFor([snoozed], now, 0).overdue === 0 && api.badgeFor([snoozed], now, 0).count === 0, "a future snooze does not keep the overdue badge");
const remindSoon = { id: "r", title: "r", done: false, due_at: now + 3 * day, remind_at: now, priority: "normal", created_at: 1 };
assert(api.sectionOf(remindSoon, now, 0) === "today", "an earlier reminder is today");
assert(api.filterItems([remindSoon], "today", "", now, 0).length === 1, "today includes an earlier reminder");
assert(api.filterItems([remindSoon], "upcoming", "", now, 0).length === 0, "upcoming waits until the reminder is past today");
assert(api.badgeFor([remindSoon], now, 0).count === 1 && api.badgeFor([remindSoon], now, 0).overdue === 0, "a reminder today lights the badge");
const woke = { id: "w", title: "w", done: false, due_at: now + 3 * day, snooze_until: now - hour, priority: "normal", created_at: 1 };
assert(api.sectionOf(woke, now, 0) === "upcoming", "an expired snooze falls back to the due date");
const missed = { id: "m", title: "m", done: false, due_at: now + 3 * day, remind_at: now - day, priority: "normal", created_at: 1 };
assert(api.sectionOf(missed, now, 0) === "upcoming", "a missed reminder does not hide a future due date");
const lateLow = { id: "z", title: "z", done: false, due_at: now - day, priority: "low", created_at: 9 };
assert(api.groupItems([lateLow, openItem], now, 0)[0].items.map((item) => item.id).join("") === "az", "overdue keeps high priority first");
assert(api.groupItems(api.filterItems(all, "open", "", now, 0), now, 0).map((group) => group.id + ":" + group.items.map((item) => item.id).join("")).join("|") === "overdue:a|today:b|upcoming:c|none:e", "open groups are overdue, today, upcoming, then no date");
const sorted = api.sortItems([laterItem, openItem, todayItem]).map((item) => item.id).join("");
assert(sorted === "acb", "priority puts high before normal before low");
assert(api.menuActions(null).join() === "add,remind", "a new message can be added or reminded");
assert(api.menuActions({ id: "a" }).join() === "open,complete", "a tracked message opens or completes");
const token = "A".repeat(20);
const doneCopy = { id: "old", done: true, message: { msg_id: token, msg_token: token } };
const openCopy = { id: "new", done: false, message: { msg_id: "false_1@c.us_" + token, msg_token: token } };
const indexed = api.indexMessages([doneCopy, openCopy]);
assert(indexed.open[token].id === "new", "an open copy is the one a new add matches");
assert(indexed.any[token].id === "new", "the open copy wins the message marker");
const onlyDone = api.indexMessages([doneCopy]);
assert(onlyDone.open[token] == null, "a completed message can be added again");
assert(onlyDone.any[token].id === "old", "a completed message still gets a marker");

const chevron = new El("span");
chevron.setAttribute("data-icon", "chevron-down");
const oldChevron = new El("span");
oldChevron.setAttribute("data-icon", "down-context");
assert(api.isChevronTarget(chevron) === true, "a chevron icon opens the message menu");
assert(api.isChevronTarget(oldChevron) === true, "the old context icon still counts");
assert(api.isChevronTarget(text) === false, "message text is not the menu chevron");

const menu = new El("ul");
menu.getBoundingClientRect = () => box(220, 160, 80, 90);
function item(top) {
  const row = new El("li");
  row.getBoundingClientRect = () => box(200, 36, 90, top);
  return row;
}
menu.appendChild(item(100));
menu.appendChild(item(140));
assert(api.menuScore(menu, { x: 120, y: 110 }) > 0, "a menu near the click counts");
const far = new El("ul");
far.getBoundingClientRect = () => box(220, 160, 800, 90);
far.appendChild(item(100));
far.appendChild(item(140));
assert(api.menuScore(far, { x: 120, y: 110 }) < 0, "a menu away from the click is ignored");
const shell = new El("div");
shell.id = "app";
shell.getBoundingClientRect = () => box(1200, 800, 0, 0);
assert(api.menuScore(shell, { x: 20, y: 20 }) < 0, "the app shell is not a menu");
const icons = new El("ul");
icons.getBoundingClientRect = () => box(220, 80, 80, 90);
const tinyA = new El("button");
tinyA.getBoundingClientRect = () => box(32, 32, 90, 100);
const tinyB = new El("button");
tinyB.getBoundingClientRect = () => box(32, 32, 130, 100);
icons.appendChild(tinyA);
icons.appendChild(tinyB);
assert(api.menuScore(icons, { x: 100, y: 110 }) < 0, "icon-sized buttons are not menu rows");
const messages = new El("ul");
messages.getBoundingClientRect = () => box(220, 160, 80, 90);
messages.querySelector = function () { return {}; };
messages.appendChild(item(100));
messages.appendChild(item(140));
assert(api.menuScore(messages, { x: 120, y: 110 }) < 0, "a list of messages is not a menu");
const tree = new El("div");
tree.appendChild(menu);
assert(api.findMenu(tree, { x: 120, y: 110 }) === menu, "the open menu is the one near the click");
const smaller = new El("ul");
smaller.getBoundingClientRect = () => box(140, 48, 300, 90);
smaller.appendChild(item(100));
smaller.appendChild(item(140));
tree.appendChild(smaller);
assert(api.findMenu(tree, { x: 120, y: 110 }) === menu, "the menu under the click wins over a smaller menu farther away");

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall todo tests passed");

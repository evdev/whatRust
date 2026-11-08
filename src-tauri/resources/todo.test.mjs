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
assert(api.normalizeChatId("15551212:14@lid") === "15551212@lid", "a device suffix is the same chat");
assert(api.normalizeChatId("status@broadcast") === "", "a status broadcast is not a chat");
assert(api.chatForMark("", "15551212@c.us") === "15551212@c.us", "a bare message uses the open chat");
assert(
  api.chatForMark("false_15551212:14@lid_" + web, "999@c.us") === "15551212@lid",
  "the message chat wins over the open chat"
);

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

const tagged = new El("div");
tagged.setAttribute("data-id", "false_15551212@c.us_" + web);
const taggedVoice = new El("div");
taggedVoice.setAttribute("data-wr-voice", "1");
const spoken = new El("div");
spoken.setAttribute("data-wr-voice-text", "1");
spoken.textContent = "transcript";
const summary = new El("ul");
summary.setAttribute("data-wr-voice-summary", "1");
const point = new El("li");
point.textContent = "buy milk";
summary.appendChild(point);
const button = new El("button");
button.textContent = "Add to To-Do";
taggedVoice.appendChild(spoken);
taggedVoice.appendChild(summary);
taggedVoice.appendChild(button);
tagged.appendChild(taggedVoice);
const taggedExtract = api.extractDom(tagged);
assert(taggedExtract.snippet === "transcript\nbuy milk", "tagged voice copy skips the button label");

const dirty = new El("div");
dirty.setAttribute("data-id", web);
const dirtyVoice = new El("div");
dirtyVoice.setAttribute("data-wr-voice", "1");
const dirtyButton = new El("button");
dirtyButton.textContent = "Add to To-Do";
dirtyVoice.appendChild(dirtyButton);
dirty.appendChild(dirtyVoice);
assert(api.extractDom(dirty).snippet === "", "a voice box button is not the transcript");

const bare = new El("div");
bare.setAttribute("data-id", web);
const icon = new El("span");
icon.setAttribute("data-icon", "audio-play");
bare.appendChild(icon);
assert(api.extractDom(bare).kind === "voice", "a play icon marks a voice note");
assert(api.extractDom(bare).msg_id === web, "a bare data-id is stored whole");
assert(api.extractDom(bare).chat_id === "", "a bare data-id has no chat of its own");
assert(api.extractDom(bare).from_me === false, "a bare id without a bubble class is not treated as yours");

const mine = new El("div");
mine.setAttribute("class", "message-out");
mine.setAttribute("data-id", web);
assert(api.extractDom(mine).from_me === true, "an outgoing bubble is yours when the id is bare");
const theirs = new El("div");
theirs.setAttribute("class", "message-in focusable-list-item");
theirs.setAttribute("data-id", web);
assert(api.extractDom(theirs).from_me === false, "an incoming bubble is theirs");
const outgoing = new El("div");
outgoing.setAttribute("class", "message-out");
const outgoingChild = new El("div");
outgoingChild.setAttribute("data-id", web);
outgoing.appendChild(outgoingChild);
assert(api.extractDom(outgoingChild).from_me === true, "direction comes from the outgoing row");
const legacyMine = new El("div");
legacyMine.setAttribute("data-id", "true_1555@c.us_" + web);
assert(api.extractDom(legacyMine).from_me === true, "a true_ id is your message");
const deviceRow = new El("div");
deviceRow.setAttribute("data-id", "false_15551212:14@lid_" + web + "_1555999:14@lid");
assert(api.extractDom(deviceRow).chat_id === "15551212@lid", "a device suffix on the row is stored as the chat");
assert(api.extractDom(deviceRow).msg_token === web, "the token stays the message id");

const headerChat = new El("header");
headerChat.setAttribute("data-id", "120363@g.us");
const quoted = new El("div");
quoted.setAttribute("data-id", "false_999@c.us_" + web);
const person = new El("div");
person.setAttribute("data-id", "111@c.us");
headerChat.appendChild(quoted);
headerChat.appendChild(person);
const selectedChat = new El("div");
selectedChat.setAttribute("data-id", "15551212:14@lid");
assert(api.chooseOpenChat("1555:8@c.us", headerChat, selectedChat) === "1555@c.us", "the open conversation wins over the header and the chat list");
assert(api.chooseOpenChat("", headerChat, selectedChat) === "120363@g.us", "the open pane's chat wins over the chat list");
assert(api.chooseOpenChat("status@broadcast", headerChat, selectedChat) === "120363@g.us", "a status id is not the open chat");
const headerOnlyMessage = new El("header");
headerOnlyMessage.appendChild(quoted);
assert(api.chooseOpenChat("", headerOnlyMessage, selectedChat) === "15551212@lid", "a nested message id is not the open chat");
assert(api.chooseOpenChat("", headerOnlyMessage, null) === "", "a message id inside the header is not a chat");
const wrapper = new El("div");
const innerMsg = new El("div");
innerMsg.setAttribute("data-id", "false_999@c.us_" + web);
const innerChat = new El("div");
innerChat.setAttribute("data-id", "1555:2@lid");
wrapper.appendChild(innerMsg);
wrapper.appendChild(innerChat);
assert(api.chooseOpenChat("", null, wrapper) === "1555@lid", "a nested chat id is used when the row itself has none");

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

const switchBox = { top: 332, bottom: 375, left: 17, right: 59, height: 43 };
const onFlower = api.pickClearance(switchBox, 141, 0, [
  { top: 348, bottom: 390, left: 17, right: 59, meta: true },
  { top: 648, bottom: 670, left: 20, right: 52, meta: false },
]);
assert(onFlower.shift === 78, "Meta AI below the switcher's top still pushes the stack down");
assert(onFlower.meta && onFlower.meta.bottom === 390, "the clearance remembers the Meta AI box");
assert(
  api.pickClearance(switchBox, 141, 0, [{ top: 700, bottom: 740, left: 400, right: 460, meta: true }]).shift === 0,
  "Ask Meta AI in the conversation pane is left where it is"
);
assert(api.clearanceFor(332, 375, 0, 141, 640) === 63, "the stack drops to a gap under the flower");
assert(api.clearanceFor(400, 375, 0, 141, 640) === 0, "a stack already below Meta AI stays put");
assert(api.clearanceFor(393, 375, 61, 141, 640) === 63, "measuring after a shift does not add the margin twice");
assert(api.clearanceFor(332, 600, 0, 141, 692) === 219, "the drop stops before the next rail icon");

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
assert(api.menuActions(null, null, false).join() === "add,remind,owe,waiting", "their message offers owe, then waiting");
assert(api.menuActions(null, null, true).join() === "add,remind,waiting,owe", "your message offers waiting first");
assert(api.menuActions({ id: "a" }, null, false).join() === "open,complete,owe,waiting", "a to-do still opens or completes");
assert(api.menuActions({ id: "a" }, { id: "w", kind: "waiting" }, true).join() === "open,complete,reply-open,reply-clear", "an open watch opens or clears");
const waitingItem = { id: "rw", kind: "waiting", title: "wait", done: false, created_at: 8, fired: true, remind_at: now, message: { chat_id: "1555@c.us", chat_name: "Ada", msg_token: "WAIT", msg_epoch: now - day } };
const oweItem = { id: "ro", kind: "owe", title: "owe", done: false, created_at: 7, message: { chat_id: "1555@lid", chat_name: "Ada", msg_token: "OWE" } };
assert(api.filterItems(all.concat([waitingItem]), "open", "", now, 0).map((item) => item.id).join("") === "abce", "a watch stays off the to-do list");
assert(api.groupItems([waitingItem, openItem], now, 0).map((group) => group.items.map((item) => item.id).join("")).join("|") === "a", "to-do groups leave watches out");
assert(api.badgeFor(all.concat([waitingItem]), now, 0).count === 2, "a watch does not light the to-do badge");
assert(api.replyBadge([waitingItem]).count === 1 && api.replyBadge([waitingItem]).overdue === true, "a fired watch lights the replies badge");
assert(api.replyBadge([oweItem]).overdue === false, "a watch without a fired reminder stays quiet");
assert(api.groupWatches([waitingItem, oweItem, { id: "gone", kind: "waiting", done: true }]).map((group) => group.id + ":" + group.items.map((item) => item.id).join("")).join("|") === "waiting:rw|owe:ro", "replies group into waiting and owe");
assert(api.filterWatches([waitingItem, oweItem], "cleared", "").length === 0, "open watches are not cleared");
assert(api.filterWatches([{ id: "c1", kind: "owe", done: true, title: "done" }], "cleared", "").length === 1, "cleared watches have their own list");
const token = "A".repeat(20);
const doneCopy = { id: "old", done: true, message: { msg_id: token, msg_token: token } };
const openCopy = { id: "new", done: false, message: { msg_id: "false_1@c.us_" + token, msg_token: token } };
const indexed = api.indexMessages([doneCopy, openCopy]);
assert(indexed.open[token].id === "new", "an open copy is the one a new add matches");
assert(indexed.any[token].id === "new", "the open copy wins the message marker");
const onlyDone = api.indexMessages([doneCopy]);
assert(onlyDone.open[token] == null, "a completed message can be added again");
assert(onlyDone.any[token].id === "old", "a completed message still gets a marker");
const watchCopy = { id: "watch", kind: "waiting", done: false, message: { msg_id: "false_1@c.us_" + token, msg_token: token } };
const mixed = api.indexMessages([openCopy, watchCopy]);
assert(mixed.open[token].id === "new", "a watch does not replace the open to-do");
assert(mixed.watches.open[token].id === "watch", "the watch keeps its own index");
const extract = { msg_id: "false_1@c.us_" + token, msg_token: token };
assert(api.lookupMapped(mixed.open, extract).id === "new" && api.isTask(api.lookupMapped(mixed.open, extract)), "the to-do lookup never returns a watch");
assert(api.lookupMapped(mixed.watches.open, extract).id === "watch", "the replies lookup returns the open watch");
const doneTask = { id: "old", done: true };
const openTask = { id: "new", done: false };
const openWatch = { id: "watch", kind: "waiting", done: false };
assert(api.markerChoice(doneTask, null, openWatch).item.id === "watch" && api.markerChoice(doneTask, null, openWatch).replies, "an open watch shows when the to-do is already done");
assert(api.markerChoice(openTask, openTask, openWatch).item.id === "new" && !api.markerChoice(openTask, openTask, openWatch).replies, "an open to-do keeps the message marker");
assert(api.messageChatId({ id: { remote: { _serialized: "1@g.us" }, fromMe: false }, chat: { id: { _serialized: "9@c.us" } }, from: { _serialized: "9@c.us" } }) === "1@g.us", "a group message uses the chat on the key, not the sender");
assert(api.messageChatId({ id: "false_1555@g.us_" + token }) === "1555@g.us", "a string message id still carries its chat");
assert(api.messageChatId({ id: { remote: { _serialized: "15551212:14@lid" }, fromMe: true }, from: { _serialized: "999@c.us" } }) === "15551212@lid", "a device suffix on the key is the same chat");
assert(api.messageChatId({ id: { fromMe: false }, from: { _serialized: "1555:14@c.us" } }) === "1555@c.us", "without a key, the sender is the fallback");
assert(api.messageChatId({ id: { remote: { _serialized: "status@broadcast" }, fromMe: false }, from: { _serialized: "1555@c.us" } }) === "", "a status is not the sender's chat");
assert(api.directChatId({ id: { remote: { _serialized: "1:14@g.us" }, fromMe: false }, from: { _serialized: "9@c.us" } }) === "1@g.us", "marking uses the group on the key, not the sender");
assert(api.directChatId({ id: { fromMe: false }, from: { _serialized: "9@c.us" } }) === "", "marking does not treat the sender as the chat");

const chatOf = (id) => (id === "1555@c.us" || id === "1555@lid" ? "chat-1" : "");
const base = { kind: "waiting", done: false, created_at: now - 1000, message: { chat_id: "1555@c.us", msg_id: "false_1555@c.us_OLD", msg_token: "OLD", msg_epoch: now - day } };
const incoming = { chat_id: "1555@lid", from_me: false, at_ms: now - 500, msg_id: "false_1555@lid_NEW", msg_token: "NEW", type: "chat", live: false, now: now };
assert(api.clearsWatch(base, incoming, chatOf) === true, "a later incoming message clears waiting across lid and c.us");
assert(api.clearsWatch(Object.assign({}, base, { kind: "owe" }), incoming, chatOf) === false, "their message does not clear a reply you owe");
assert(api.clearsWatch(Object.assign({}, base, { kind: "owe" }), Object.assign({}, incoming, { from_me: true, msg_id: "true_1555@lid_MINE", msg_token: "MINE" }), chatOf) === true, "your later message clears a reply you owe");
assert(api.clearsWatch(base, Object.assign({}, incoming, { from_me: true }), chatOf) === false, "your own follow-up does not clear waiting");
assert(api.clearsWatch(base, Object.assign({}, incoming, { at_ms: now - 2 * day }), chatOf) === false, "a message from before you marked it does not clear");
assert(api.clearsWatch(base, Object.assign({}, incoming, { msg_token: "OLD", msg_id: "false_1555@c.us_OLD" }), chatOf) === false, "the marked message does not clear itself");
assert(api.clearsWatch(base, Object.assign({}, incoming, { type: "e2e_notification" }), chatOf) === false, "a protocol notice is not a reply");
assert(api.clearsWatch(base, Object.assign({}, incoming, { chat_id: "999@c.us" }), chatOf) === false, "an unresolved other chat does not clear");
assert(api.clearsWatch(base, Object.assign({}, incoming, { chat_id: "1555@c.us", live: true, at_ms: now - 10 * 60000, now: now }), chatOf) === false, "history loaded with the chat is not a new reply");
assert(api.clearsWatch(base, Object.assign({}, incoming, { chat_id: "1555@c.us", live: true, at_ms: now - 400, now: now }), chatOf) === true, "a recent message after you marked it can clear");
const noChat = () => "";
const storedLid = { kind: "waiting", done: false, created_at: now - 1000, message: { chat_id: "1555@lid", msg_id: "false_1555@lid_OLD", msg_token: "OLD", msg_epoch: now - day } };
const deviceReply = { chat_id: "1555:14@lid", from_me: false, at_ms: now - 500, msg_id: "false_1555@lid_NEW", msg_token: "NEW", type: "chat", live: false, now: now };
assert(api.clearsWatch(storedLid, deviceReply, noChat) === true, "a device suffix is the same chat when a reply arrives");
assert(api.clearsWatch(base, Object.assign({}, incoming, { chat_id: "1555:14@lid" }), chatOf) === true, "a device suffix still resolves through the plain chat id");
const uneven = (id) => (id === "1555@c.us" ? "1555:14@lid" : id === "1555@lid" ? "1555@lid" : "");
assert(api.clearsWatch(base, incoming, uneven) === true, "a device suffix on only one resolved id is still the same chat");

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

assert(api.themeFromColor("rgba(0, 0, 0, 0)") === null, "transparent black is not a dark background");
assert(api.themeFromColor("transparent") === null, "the transparent keyword is not a sample");
assert(api.themeFromColor("rgb(0, 0, 0)") === "dark", "opaque black is dark");
assert(api.themeFromColor("#111b21") === "dark", "the WhatsApp dark background is dark");
assert(api.themeFromColor("white") === "light", "white is light");
assert(api.themeFromColor("#ffffff") === "light", "hex white is light");

const darkPalette = api.themePalette(true);
const lightPalette = api.themePalette(false);
assert(darkPalette.panel.bg === "#111b21" && darkPalette.panel.fg === "#e9edef" && darkPalette.panel.dim === "#8696a0" && darkPalette.panel.hover === "#202c33", "the dark list keeps WhatsApp's panel colors");
assert(lightPalette.panel.bg === "#ffffff" && lightPalette.panel.fg === "#111b21" && lightPalette.panel.dim === "#667781" && lightPalette.panel.hover === "#f0f2f5", "the light list keeps WhatsApp's panel colors");
assert(darkPalette.popup.bg === "#233138" && darkPalette.popup.btn === "#2a3942" && darkPalette.popup.link === "#7dffb3", "dark popups use the elevated WhatsApp surface");
assert(lightPalette.popup.bg === "#ffffff" && lightPalette.popup.fg === "#111b21" && lightPalette.popup.btn === "#f0f2f5" && lightPalette.popup.link === "#008069", "light popups use a readable undo color");
assert(lightPalette.popup.border === "1px solid #e9edef", "a light popup keeps a visible edge");
assert(darkPalette.hover.bg === "#111b21cc" && lightPalette.hover.bg === "#ffffffcc", "the hover chip keeps its translucent wash");

const popup = api.popupCss();
assert(popup.indexOf("var(--bg)") !== -1 && popup.indexOf("var(--btn)") !== -1, "popup styles follow the theme variables");
assert(popup.indexOf("#111b21") === -1, "popup styles do not hardcode the dark panel background");
assert(popup.indexOf("button.primary{background:#1daa61;color:#042}") !== -1, "primary buttons stay green in both modes");

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall todo tests passed");

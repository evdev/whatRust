// Run: node src-tauri/resources/mention.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "mention.js"), "utf8");
const context = { __WHATRUST_TEST: true };
vm.createContext(context);
vm.runInContext(source, context, { filename: "mention.js" });
const api = context.__whatrustMentionApi;

const suppressRows = [{ key: "the gate is open now", sender: "Ada", chat: "Family", until: 5_000 }];
assert(api.shouldSuppress(suppressRows, "Ada", "the gate is open now", 1_000).hit, "a popup holds the ordinary notification for that text");
assert(!api.shouldSuppress(suppressRows, "Someone else", "ok", 1_000).hit, "a short unrelated notification is not held");
assert(api.shouldSuppress([{ key: "ok", sender: "Ada", chat: "Family", until: 5_000 }], "Ada", "ok", 1_000).hit,
  "a short reply is held when the title names the sender");
assert(!api.shouldSuppress(suppressRows, "Ada", "the gate is open now", 6_000).hit, "a held notification expires");

const shown = api.displayFrom({
  notifyName: "Ada",
  chat: { formattedTitle: "Family" },
  body: "  hello  ",
  t: 1_763_000_000,
}, { kind: "direct", chatId: "1@c.us", senderId: "1@c.us", msgId: "false_1@c.us_A" });
assert(shown.senderName === "Ada" && shown.chatName === "Family" && shown.body === "hello", "the popup gets the sender, chat, and text");
assert(shown.at === 1_763_000_000_000, "a seconds timestamp is shown in milliseconds");
assert(api.stillUnread({ unreadCount: 2 }, null) === true, "an unread chat is still waiting");
assert(api.stillUnread({ unreadCount: 0 }, null) === false, "a chat read on the phone is not shown after unlock");
assert(api.stillUnread({ unreadCount: 3 }, { type: "revoked" }) === false, "a revoked message is closed");
assert(api.stillUnread(null, null) === true, "an unknown chat is kept until it can be checked");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else {
    failures++;
    console.error("FAIL  " + msg);
  }
}

// Above 1e12 so it stays milliseconds. Smaller numbers are WhatsApp's seconds.
const ready = 1_763_000_000_000;
const now = ready + 5_000;
const self = ["15551212@c.us", "777@lid"];

function ctx(over) {
  return Object.assign({ selfIds: self, readyAt: ready, now: now }, over || {});
}

function incoming(over) {
  return Object.assign({
    id: "false_15551212@c.us_ABC",
    t: ready + 1000,
    from: "15551212@c.us",
    type: "chat",
    body: "hi",
  }, over || {});
}

function kind(over, context) {
  const hit = api.classify(incoming(over), context || ctx());
  return hit && hit.kind;
}

assert(api.SETTINGS_COPY.en === "Does not alert on @everyone", "the settings line is the agreed English copy");
assert(api.SETTINGS_COPY.pt === "Não avisa em @everyone", "the settings source string is Portuguese");

assert(kind({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "hey",
  mentionedJidList: ["15551212@c.us"],
}) === "mention", "a group @mention of me alerts");

assert(kind({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  type: "image",
  body: "",
  caption: "look @15551212",
}) === "mention", "a media caption that tags my number alerts");

assert(kind({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "@everyone please read",
}) === null, "@everyone alone stays quiet");

assert(kind({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "@all",
  nonJidMentions: 1,
}) === null, "@all alone stays quiet");

assert(kind({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "@everyone and you",
  mentionedJidList: [{ _serialized: "15551212@c.us" }],
}) === "mention", "a personal mention still alerts inside an @everyone message");

assert(kind({
  id: "false_999@g.us_LID",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "hey",
  mentionedJidList: ["777@lid"],
}) === "mention", "a lid mention matches the lid self id");

assert(kind({
  id: "false_999@g.us_LID",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "@777",
  mentionedJidList: [],
}, ctx({ selfIds: ["777@lid"] })) === null, "a lid is not matched from digits typed in the text");

assert(kind({
  id: "false_999@g.us_Q",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "about this",
  quotedParticipant: "15551212@s.whatsapp.net",
  quotedStanzaID: "OLD",
}) === "quote", "a reply to my message alerts");

assert(kind({
  id: "false_999@g.us_Q2",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "about this",
  quotedMsg: { id: { fromMe: true, _serialized: "true_999@g.us_OLD" } },
}) === "quote", "a quoted message I sent alerts");

assert(kind({
  id: "false_999@g.us_Q3",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "about them",
  quotedParticipant: "333@c.us",
  quotedStanzaID: "OLD",
}) === null, "a reply to someone else stays quiet");

assert(kind() === "direct", "a new direct message alerts");
assert(kind({ t: Math.floor((ready + 1000) / 1000) }) === "direct", "a WhatsApp seconds timestamp counts as live");
assert(kind({ body: "@everyone" }) === "direct", "a direct message still alerts when the text says @everyone");
assert(kind({
  body: "replied",
  quotedParticipant: "333@c.us",
  quotedStanzaID: "OLD",
}) === "direct", "a direct message that quotes someone else still alerts");

assert(kind({ id: "true_15551212@c.us_ME", from: "15551212@c.us" }) === null, "my own message stays quiet");
assert(kind({ type: "ciphertext" }) === null, "an undecrypted message stays quiet");
assert(kind({
  id: "false_999@g.us_BIT",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "hello",
  nonJidMentions: 1,
}) === null, "the everyone flag without a personal mention stays quiet");
assert(kind({ t: ready - 30_000 }) === null, "a message from before the account caught up stays quiet");
assert(kind({ t: ready - 2_000 }) === "direct", "a few seconds of clock slack still counts as live");
assert(kind({ t: ready + 1000 }, ctx({ now: ready + api.REPLAY_MS + 2000 })) === null, "a chat-open replay older than two minutes stays quiet");
assert(kind({ id: "false_news@newsletter_N", from: "news@newsletter" }) === null, "a newsletter stays quiet");
assert(kind({ id: "false_list@broadcast_B", from: "list@broadcast" }) === null, "a broadcast list stays quiet");
assert(kind({
  id: "false_status@broadcast_S",
  from: "444@c.us",
  isStatusV3: true,
  body: "see this",
  mentionedJidList: ["15551212@c.us"],
}) === null, "a status mention stays quiet");
assert(kind({
  id: "false_444@c.us_S",
  from: "444@c.us",
  isStatusV3: true,
  body: "see this",
  mentionedJidList: ["15551212@c.us"],
}) === null, "a status flagged on the message stays quiet");

assert(api.classify(incoming({ id: "" }), ctx()) === null, "a message with no id is ignored");

assert(api.selfIdsFrom(null).length === 0, "missing connection yields no self ids");
assert(api.selfIdsFrom({
  conn: {
    getMyUserWid: () => ({ _serialized: "15551212@c.us" }),
    getMyUserLid: () => { throw new Error("no lid"); },
  },
}).join() === "15551212@c.us", "a missing lid does not drop the phone id");

function fakeWpp(readyNow) {
  const listeners = Object.create(null);
  return {
    isFullReady: !!readyNow,
    on(name, fn) {
      (listeners[name] || (listeners[name] = [])).push(fn);
    },
    emit(name, msg) {
      (listeners[name] || []).forEach((fn) => fn(msg));
    },
  };
}

const late = fakeWpp(false);
const emitted = [];
let clock = ready;
assert(api.attach(late, {
  now: () => clock,
  selfIds: () => self,
  emit: (hit) => emitted.push(hit),
}), "the listener can attach before the account is ready");
late.emit("chat.new_message", incoming());
assert(emitted.length === 0, "nothing is delivered before the account has caught up");
clock = ready + 1000;
late.emit("conn.main_ready");
late.emit("conn.main_ready");
late.emit("chat.new_message", incoming({ t: ready - 10_000 }));
late.emit("chat.new_message", incoming({ id: "false_999@g.us_ALL", from: "999@g.us", author: "444@c.us", isGroupMsg: true, body: "@everyone", t: clock }));
late.emit("chat.new_message", incoming({ id: "false_15551212@c.us_NEW", t: clock }));
late.emit("chat.new_message", incoming({ id: "false_15551212@c.us_NEW", t: clock }));
assert(emitted.length === 1 && emitted[0].kind === "direct" && emitted[0].msgId === "false_15551212@c.us_NEW",
  "after catch-up, only a new qualifying message is delivered once");

const already = fakeWpp(true);
const readyHits = [];
clock = ready + 2000;
api.attach(already, {
  now: () => clock,
  selfIds: () => self,
  emit: (hit) => readyHits.push(hit.kind),
});
already.emit("chat.new_message", incoming({ id: "false_15551212@c.us_NOW", t: clock }));
assert(readyHits.join() === "direct", "an account that is already caught up listens immediately");

const bundle = readFileSync(join(here, "wppconnect-wa.js"), "utf8");
assert(bundle.includes("t.sendTextMessage=async function"), "wa-js can send a text message");
assert(bundle.includes("r.quotedMsg instanceof s.MsgKey"), "a quoted send accepts a message id");
assert(bundle.includes("(?<![\\w@.+-])@all\\b"), "wa-js treats @all as a non-jid mention");
assert(bundle.includes("t.markIsRead=async function"), "wa-js can mark a chat read");
assert(bundle.includes("t.getMyUserLid=function"), "wa-js can read the lid self id");
assert(bundle.includes('emit("conn.main_ready"'), "catch-up is conn.main_ready");
assert(bundle.includes('emit("chat.new_message"'), "live messages use chat.new_message");

const settingsPage = readFileSync(join(here, "../../settings-ui/index.html"), "utf8");
const settingsI18n = readFileSync(join(here, "../../settings-ui/i18n.js"), "utf8");
assert(settingsPage.includes(api.SETTINGS_COPY.en), "settings shows the @everyone line");
assert(
  settingsI18n.includes(`"${api.SETTINGS_COPY.en}": "${api.SETTINGS_COPY.pt}"`),
  "Portuguese still has the @everyone line"
);
const wav = readFileSync(join(here, "../../settings-ui/mention.wav"));
const chime = readFileSync(join(here, "mention-chime.js"), "utf8");
assert(chime.includes(wav.toString("base64")), "the page plays the bundled chime");

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall mention detection tests passed");

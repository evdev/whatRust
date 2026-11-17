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
assert(shown.voice === false && shown.seconds === 0, "a text message is not a voice note");
assert(shown.at === 1_763_000_000_000, "a seconds timestamp is shown in milliseconds");

const thumb = "/9j/" + "A".repeat(90);
const photo = api.displayFrom({
  notifyName: "15551212@c.us",
  sender: { name: "Ada Lovelace", pushname: "Ada" },
  chat: { formattedTitle: "Family" },
  body: thumb,
  caption: "look at this",
  t: 1_763_000_000,
}, { kind: "direct", chatId: "1@c.us", senderId: "15551212@c.us", msgId: "false_1@c.us_A" });
assert(photo.senderName === "Ada Lovelace", "a saved name beats a phone jid and a push name");
assert(photo.body === "look at this" && !photo.body.includes("/9j/"), "a photo caption is the text, not the thumbnail");
assert(photo.preview.startsWith("data:image/jpeg;base64,/9j/"), "the thumbnail is passed as a picture");

context.WPP = {
  whatsapp: {
    ContactStore: {
      get(wid) {
        const key = typeof wid === "string" ? wid : "";
        if (key === "15551212@c.us") return { name: "Ada" };
        if (key === "15559999@c.us") return { name: "Bea" };
        return null;
      },
    },
  },
};
const named = api.displayFrom({
  notifyName: "15551212@c.us",
  from: "15551212@c.us",
  chat: { formattedTitle: "15551212@c.us", id: "15551212@c.us" },
  body: "hi @15559999",
  mentionedJidList: ["15559999@c.us"],
}, { kind: "direct", chatId: "15551212@c.us", senderId: "15551212@c.us", msgId: "false_15551212@c.us_B" });
assert(named.senderName === "Ada" && named.chatName === "Ada", "a stored contact name replaces the phone jid");
assert(named.body === "hi @Bea", "an @phone in the message is shown as that person's name");

const unsaved = api.displayFrom({
  notifyName: "15550000@c.us",
  from: "15550000@c.us",
  body: "hey",
}, { kind: "direct", chatId: "15550000@c.us", senderId: "15550000@c.us", msgId: "false_15550000@c.us_C" });
assert(unsaved.senderName === "+15550000" && !unsaved.senderName.includes("@"), "a contact with no name is a phone number, not a jid");

const note = api.displayFrom({
  type: "ptt",
  duration: "14",
  body: "/9j/" + "B".repeat(90),
  notifyName: "Ada",
  chat: { formattedTitle: "Family" },
}, { kind: "direct", chatId: "1@c.us", senderId: "1@c.us", msgId: "false_1@c.us_V" });
assert(note.voice === true && note.seconds === 14 && note.body === "" && note.preview === "", "a voice note is playable instead of a block of text");
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

function flags(over, context) {
  return api.classify(incoming(over), context || ctx()) || {};
}

assert(api.SETTINGS_COPY.en === "Group messages that tag everyone.", "the settings line is the agreed English copy");
assert(api.SETTINGS_COPY.pt === "Mensagens de grupo que marcam todos.", "the settings source string is Portuguese");

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
}) === "everyone", "@everyone alone is its own type");
assert(flags({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "@everyone please read",
}).everyone === true && flags({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "@everyone please read",
}).mentions !== true, "@everyone alone is not a personal mention");

assert(kind({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "@all",
  nonJidMentions: 1,
}) === "everyone", "@all alone is the everyone type");

assert(kind({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "@everyone and you",
  mentionedJidList: [{ _serialized: "15551212@c.us" }],
}) === "mention", "a personal mention still alerts inside an @everyone message");
assert(flags({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "@everyone and you",
  mentionedJidList: [{ _serialized: "15551212@c.us" }],
}).everyone === true, "a personal mention inside @everyone is also everyone");

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
{
  const throwing = {
    id: "false_1@c.us_THROW",
    t: ready + 1000,
    from: "1@c.us",
    type: "chat",
    body: "hello",
  };
  Object.defineProperty(throwing, "quotedMsgId", {
    get: function () { throw new Error("message_not_have_a_reply"); },
  });
  const hit = api.classify(throwing, ctx());
  assert(hit && hit.kind === "direct" && hit.direct === true, "a direct message still alerts when quotedMsgId throws");
}
{
  const mention = {
    id: "false_999@g.us_MTHROW",
    t: ready + 1000,
    from: "999@g.us",
    author: "444@c.us",
    isGroupMsg: true,
    type: "chat",
    body: "hey",
    mentionedJidList: ["15551212@c.us"],
  };
  Object.defineProperty(mention, "quotedMsgId", {
    get: function () { throw new Error("message_not_have_a_reply"); },
  });
  const hit = api.classify(mention, ctx());
  assert(hit && hit.kind === "mention" && hit.mentions === true, "a mention still alerts when quotedMsgId throws");
}
{
  const everyone = {
    id: "false_999@g.us_ETHROW",
    t: ready + 1000,
    from: "999@g.us",
    author: "444@c.us",
    isGroupMsg: true,
    type: "chat",
    body: "@everyone",
  };
  Object.defineProperty(everyone, "quotedMsgId", {
    get: function () { throw new Error("message_not_have_a_reply"); },
  });
  const hit = api.classify(everyone, ctx());
  assert(hit && hit.kind === "everyone" && hit.everyone === true, "an everyone tag still alerts when quotedMsgId throws");
}
{
  const reply = {
    id: "false_999@g.us_RTHROW",
    t: ready + 1000,
    from: "999@g.us",
    author: "444@c.us",
    isGroupMsg: true,
    type: "chat",
    body: "about this",
    quotedParticipant: "15551212@c.us",
    quotedStanzaID: "OLD",
  };
  Object.defineProperty(reply, "quotedMsgId", {
    get: function () { throw new Error("message_not_have_a_reply"); },
  });
  Object.defineProperty(reply, "quotedMsg", {
    get: function () { throw new Error("quoted_msg_unavailable"); },
  });
  const hit = api.classify(reply, ctx());
  assert(hit && hit.kind === "quote" && hit.replies === true, "a reply still alerts when quotedMsg and quotedMsgId throw");
}
assert(kind({ isGroupMsg: function () { return false; } }) === "direct", "a direct message stays direct when isGroupMsg is a method");
assert(kind({
  id: "false_999@g.us_GFN",
  from: "999@g.us",
  author: "444@c.us",
  body: "hey",
  mentionedJidList: ["15551212@c.us"],
  isGroupMsg: function () { return true; },
}) === "mention", "a group stays a group when isGroupMsg is a method");
assert(kind({ isStatusV3: function () { return false; } }) === "direct", "a direct message stays direct when isStatusV3 is a method");
assert(kind({ isStatusV3: function () { return true; } }) === null, "a status method stays quiet");
{
  const dm = {
    id: "false_1@c.us_MLIST",
    t: ready + 1000,
    from: "1@c.us",
    type: "chat",
    body: "hello",
  };
  Object.defineProperty(dm, "mentionedJidList", {
    get: function () { throw new Error("no_mentions"); },
  });
  Object.defineProperty(dm, "nonJidMentions", {
    get: function () { throw new Error("no_everyone"); },
  });
  Object.defineProperty(dm, "quotedMsg", {
    get: function () { throw new Error("quoted_msg_unavailable"); },
  });
  const hit = api.classify(dm, ctx());
  assert(hit && hit.direct === true, "a direct message still alerts when mention fields throw");
}
assert(kind({
  id: "false_999@g.us_Q4",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "about this",
  quotedStanzaID: "OLD",
  quotedMsgId: "true_999@g.us_OLD",
}) === "quote", "a quote key that starts with true_ is a reply to me");
assert(kind({ t: Math.floor((ready + 1000) / 1000) }) === "direct", "a WhatsApp seconds timestamp counts as live");
assert(kind({ body: "@everyone" }) === "direct", "a direct message still alerts when the text says @everyone");
assert(flags({ body: "@everyone" }).everyone !== true, "a direct chat is not an everyone alert");
assert(flags({
  body: "replied to me",
  quotedParticipant: "15551212@c.us",
}).direct === true && flags({
  body: "replied to me",
  quotedParticipant: "15551212@c.us",
}).replies === true, "a direct reply is both a direct message and a reply");
assert(kind({
  body: "replied",
  quotedParticipant: "333@c.us",
  quotedStanzaID: "OLD",
}) === "direct", "a direct message that quotes someone else still alerts");

assert(kind({ id: "true_15551212@c.us_ME", from: "15551212@c.us" }) === null, "my own message stays quiet");
assert(kind({ fromMe: true, type: "ptt", body: "" }) === null, "an outgoing voice note stays quiet");
assert(kind({ id: { fromMe: true, _serialized: "false_15551212@c.us_OUT" }, type: "ptt" }) === null, "an outgoing key stays quiet");
assert(kind({ fromMe: function () { return true; } }) === null, "a fromMe method that returns true stays quiet");
assert(kind({ fromMe: function () { return false; } }) === "direct", "a fromMe method that returns false still alerts");

function outgoing(over) {
  return Object.assign({
    id: "true_15551212@c.us_OUT",
    fromMe: true,
    to: "15551212@c.us",
    type: "chat",
    body: "on my way",
    t: now,
  }, over || {});
}
assert(api.ownChat(outgoing(), ctx()) === "15551212@c.us", "a live outgoing text names the chat");
assert(api.ownChat(outgoing({
  id: "true_999@g.us_VOICE",
  to: "999@g.us",
  type: "ptt",
  body: "",
}), ctx()) === "999@g.us", "a live outgoing voice note names the group");
assert(api.ownChat(outgoing({ fromMe: false, id: "true_15551212@c.us_PHONE" }), ctx()) === "15551212@c.us",
  "a message synced from another device is an answer");
assert(api.ownChat(incoming(), ctx()) === null, "an incoming message is not an answer");
assert(api.ownChat(outgoing({ type: "ciphertext" }), ctx()) === null, "a ciphertext stub is not an answer yet");
assert(api.ownChat(outgoing({ t: ready - 30_000 }), ctx()) === null, "an outgoing message from before catch-up is not an answer");
assert(api.ownChat(outgoing({ t: now - api.REPLAY_MS - 1000 }), ctx()) === null, "an old outgoing replay is not an answer");
assert(api.ownChat(outgoing({ id: "true_news@newsletter_N", to: "news@newsletter" }), ctx()) === null, "an outgoing newsletter is not an answer");
assert(api.ownChat(outgoing({
  id: "true_status@broadcast_S",
  to: "status@broadcast",
  isStatusV3: true,
}), ctx()) === null, "an outgoing status is not an answer");
assert(kind({ type: "ciphertext" }) === null, "an undecrypted message stays quiet");
assert(kind({
  id: "false_999@g.us_BIT",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "hello",
  nonJidMentions: 1,
}) === "everyone", "the everyone flag without a personal mention is the everyone type");
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
assert(emitted.length === 2 && emitted[0].kind === "everyone" && emitted[1].kind === "direct" && emitted[1].msgId === "false_15551212@c.us_NEW",
  "after catch-up, a new everyone tag and a new direct message are each delivered once");

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

const answered = fakeWpp(true);
const settled = [];
const answerAlerts = [];
clock = now;
api.attach(answered, {
  now: () => clock,
  selfIds: () => self,
  emit: (hit) => answerAlerts.push(hit.kind),
  settle: (chatId, at) => settled.push([chatId, at]),
});
const reply = outgoing({ id: "true_15551212@c.us_REPLY", t: clock });
answered.emit("chat.new_message", reply);
answered.emit("chat.new_message", reply);
answered.emit("chat.new_message", outgoing({
  id: "true_999@g.us_VOICE",
  to: "999@g.us",
  type: "ptt",
  body: "",
  t: clock,
}));
answered.emit("chat.new_message", incoming({ id: "false_15551212@c.us_STILL", t: clock }));
answered.emit("chat.new_message", outgoing({ id: "true_15551212@c.us_LATER", type: "ciphertext", t: clock }));
answered.emit("chat.new_message", outgoing({ id: "true_15551212@c.us_LATER", type: "chat", t: clock }));
answered.emit("chat.new_message", outgoing({ id: "true_15551212@c.us_OLD", t: clock - api.REPLAY_MS - 1000 }));
answered.emit("chat.new_message", outgoing({
  id: "true_status@broadcast_S",
  to: "status@broadcast",
  isStatusV3: true,
  t: clock,
}));
answered.emit("chat.new_message", outgoing({ id: "true_news@newsletter_N", to: "news@newsletter", t: clock }));
assert(settled.length === 3
  && settled[0][0] === "15551212@c.us" && settled[0][1] === clock
  && settled[1][0] === "999@g.us" && settled[1][1] === clock
  && settled[2][0] === "15551212@c.us" && settled[2][1] === clock,
  "a live outgoing text or voice note settles that chat once, after ciphertext");
assert(answerAlerts.join() === "direct", "an outgoing message does not alert, and an incoming one still does");

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
const alertOn = { mentions: true, replies: true, direct: true, everyone: false, popup: true, sound: true };
const everyoneHit = flags({
  id: "false_999@g.us_ABC",
  from: "999@g.us",
  author: "444@c.us",
  isGroupMsg: true,
  body: "@everyone please read",
});
assert(api.wantsAlert(everyoneHit, alertOn) === false, "everyone stays quiet until that switch is on");
assert(api.wantsAlert(everyoneHit, Object.assign({}, alertOn, { everyone: true })) === true, "everyone alerts when that switch is on");
assert(api.wantsAlert(everyoneHit, Object.assign({}, alertOn, { everyone: true, popup: false, sound: false })) === false,
  "a matched type with both deliveries off does nothing");
const directReply = flags({ body: "replied to me", quotedParticipant: "15551212@c.us" });
assert(api.wantsAlert(directReply, { mentions: false, replies: true, direct: false, everyone: false, popup: true, sound: false }) === true,
  "a direct reply alerts when only replies are on");
assert(api.wantsAlert(directReply, { mentions: false, replies: false, direct: true, everyone: false, popup: false, sound: true }) === true,
  "a direct reply alerts when only direct messages are on");
const wav = readFileSync(join(here, "../../settings-ui/mention.wav"));
const chime = readFileSync(join(here, "mention-chime.js"), "utf8");
assert(chime.includes(wav.toString("base64")), "the page plays the bundled chime");

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall mention detection tests passed");

// Run: node src-tauri/resources/autoreply.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "autoreply.js"), "utf8");
const context = { __WHATRUST_TEST: true };
vm.createContext(context);
vm.runInContext(source, context, { filename: "autoreply.js" });
const api = context.__whatrustAutoreplyApi;

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else {
    failures++;
    console.error("FAIL  " + msg);
  }
}

assert(api, "helpers are exported for tests");
assert(api.normalizeChatId("1555:14@lid") === "1555@lid", "a device suffix is the same chat");
assert(api.normalizeChatId("false_1555@c.us_ABC") === "1555@c.us", "a message id yields its chat");
assert(api.isDirectId("1555@c.us") === true, "a 1:1 chat is eligible");
assert(api.isDirectId("1555@lid") === true, "a lid chat is eligible");
assert(api.isDirectId("1555@g.us") === false, "a group is not eligible");
assert(api.isDirectId("status@broadcast") === false, "a broadcast is not eligible");

const now = 1_000_000;
assert(api.isFresh(now - 1000, now - 2000, now), "a message after arming is fresh");
assert(!api.isFresh(now - 200_000, now - 1000, now), "a message older than three minutes is ignored");
assert(!api.isFresh(now - 20_000, now, now), "a message from before arming is ignored");

assert(
  api.isStandinEcho("STANDIN", "ok", ["STANDIN"], null, now),
  "a recorded stand-in token is not a human reply"
);
assert(
  api.isStandinEcho("", "On my way", [], { text: "on my way", until: now + 1000 }, now),
  "an in-flight stand-in send is not a human reply"
);
assert(
  !api.isStandinEcho("OTHER", "I'll reply myself", ["STANDIN"], null, now),
  "a different outgoing message is the user"
);

const hits = api.searchMessages(
  [
    { id: "1", from_me: false, text: "hello" },
    { id: "2", from_me: true, text: "the invoice is 40" },
    { id: "3", from_me: false, text: "thanks" },
  ],
  "Invóice",
  5
);
assert(hits.length === 1 && hits[0].id === "2", "search ignores case and accents");
assert(hits[0].around.length === 3, "a hit keeps the surrounding messages");
assert(api.searchMessages([{ id: "1", text: "hello" }], "invoice", 5).length === 0, "a miss stays empty");

assert(
  api.messageChatId({ id: "false_1555@g.us_ABC", from: "1999@c.us" }) === "",
  "a group message is not a direct chat"
);
assert(
  api.messageChatId({ id: { remote: "1555@c.us", fromMe: false, _serialized: "false_1555@c.us_ABC" } }) === "1555@c.us",
  "the message remote is the chat"
);
assert(
  api.sameMessage({ id: "a", msg_token: "TOK" }, { id: "b", msg_token: "TOK" }),
  "the same WhatsApp token is one message"
);
assert(
  !api.sameMessage({ id: "a", msg_token: "ONE" }, { id: "b", msg_token: "TWO" }),
  "different messages stay apart"
);

const photo = api.mapMessage({ id: "false_1@c.us_ABC", type: "image", t: 1000 });
assert(/^\[image\]/.test(photo.text), "a picture is named, not left blank");
const captioned = api.mapMessage({ id: "false_1@c.us_DEF", type: "image", body: "look", t: 1000 });
assert(captioned.text === "[image] look", "a caption is kept beside the kind");
const quoted = api.mapMessage({
  id: "false_1@c.us_GHI",
  type: "chat",
  body: "yes",
  t: 1000,
  quotedMsg: { body: "are we still on for Friday?" },
});
assert(quoted.quoted_snippet === "are we still on for Friday?", "the quoted line is carried");
assert(quoted.text === "yes", "the reply itself stays the text");
assert(api.messageToken("false_1555@c.us_3EB0ABC") === "3EB0ABC", "a classic id yields its token");

function iconButton(icon, label) {
  var iconNode = {
    getAttribute: function (name) {
      return name === "data-icon" ? icon : "";
    },
  };
  return {
    tagName: "BUTTON",
    getAttribute: function (name) {
      return name === "aria-label" ? label || "" : "";
    },
    querySelectorAll: function (sel) {
      if (sel === "button,[role=button]") return [];
      return [iconNode];
    },
  };
}

function headerDoc(buttons) {
  return {
    querySelector: function (sel) {
      if (sel !== "#main header") return null;
      return {
        querySelectorAll: function () {
          return buttons;
        },
      };
    },
  };
}

const video = iconButton("video-call", "Video call");
const voice = iconButton("voice-call", "Voice call");
const menu = iconButton("menu", "Menu");
assert(
  api.videoCallButton(headerDoc([voice, video, menu])) === video,
  "the stand-in anchors on the video call, not the menu"
);
assert(api.videoCallButton(headerDoc([voice, menu])) === null, "a voice call is not the video call");
assert(api.isVideoCallControl(iconButton("", "Chamada de vídeo")), "a Portuguese video call label counts");
assert(!api.isVideoCallControl(iconButton("menu", "Menu")), "the menu is not the video call");
assert(!api.isVideoCallControl(iconButton("voice-call", "Voice call")), "the voice call is not the video call");

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall autoreply tests passed");

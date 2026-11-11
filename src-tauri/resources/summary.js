/* Chat summaries from the open conversation's header menu.
 *
 * The companion sits beside WhatsApp's menu, never inside it. The summary is
 * a block under the newest message it covers. It is stored on this computer
 * and is not sent into the chat.
 */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  if (!root.location || root.location.origin !== "https://web.whatsapp.com") return;

  var DAY = 86400000;
  var HOUR = 3600000;
  // One model call. Matches the Rust context budget: two characters per token
  // inside Claude Haiku's 200k window, which is the smallest offered here.
  var CONTEXT_CHARS = 300000;
  var MAX_CHUNKS = 2;
  var MAX_CHARS = CONTEXT_CHARS * MAX_CHUNKS;
  var PAGE_WAIT_MS = 20000;
  var NAME_WAIT_MS = 5000;
  var VOICE_WAIT_MS = 8000;
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function L(pt, en) {
    return root.__WR_LANG === "en" ? en : pt;
  }

  function attr(node, name) {
    if (!node || typeof node.getAttribute !== "function") return "";
    return node.getAttribute(name) || "";
  }

  function tzOffset() {
    return -new Date().getTimezoneOffset();
  }

  function dayStart(now, offsetMin) {
    var offsetMinutes = Math.max(-840, Math.min(840, Number(offsetMin) || 0));
    var offset = offsetMinutes * 60000;
    var local = now + offset;
    var startLocal = local - ((local % DAY) + DAY) % DAY;
    return Math.max(0, startLocal - offset);
  }

  function windowBounds(range, now, offsetMin) {
    var end = now;
    var start = now - HOUR;
    if (range === "4h") start = now - 4 * HOUR;
    else if (range === "today") start = dayStart(now, offsetMin);
    else if (range === "3d") start = now - 72 * HOUR;
    if (start < 0) start = 0;
    if (start >= end) start = Math.max(0, end - 1);
    return { start: start, end: end };
  }

  function localParts(at, offsetMin) {
    var offset = (Number(offsetMin) || 0) * 60000;
    var local = new Date(at + offset);
    var hours = local.getUTCHours();
    var minutes = local.getUTCMinutes();
    return {
      day: WEEKDAYS[local.getUTCDay()],
      dayKey: local.getUTCFullYear() + "-" + local.getUTCMonth() + "-" + local.getUTCDate(),
      clock: (hours < 10 ? "0" : "") + hours + ":" + (minutes < 10 ? "0" : "") + minutes,
    };
  }

  function dayName(day) {
    if (root.__WR_LANG === "en") return day;
    var names = { Sun: "dom", Mon: "seg", Tue: "ter", Wed: "qua", Thu: "qui", Fri: "sex", Sat: "sáb" };
    return names[day] || day;
  }

  function sinceLabel(start, now, offsetMin) {
    var when = localParts(start, offsetMin);
    var today = localParts(now, offsetMin);
    if (when.dayKey === today.dayKey) return when.clock;
    return dayName(when.day) + " " + when.clock;
  }

  function widText(id) {
    if (!id) return "";
    if (typeof id === "string") return id;
    try {
      if (id._serialized) return String(id._serialized);
    } catch (e) {}
    try {
      if (id.user && id.server) return String(id.user) + "@" + String(id.server);
    } catch (e2) {}
    if (typeof id.toString === "function") {
      try {
        var text = String(id.toString());
        if (text && text !== "[object Object]") return text;
      } catch (e3) {}
    }
    return "";
  }

  function describeChat(chat) {
    if (!chat || typeof chat.then === "function" && !chat.id) return null;
    var id = "";
    try { id = normalizeChatId(widText(chat.id)); } catch (e) { id = ""; }
    if (!id) return null;
    var name = id;
    try {
      var contact = chat.contact || null;
      name = chat.formattedTitle || displayName(contact, chat) || chat.name || id;
    } catch (e2) {}
    var group = /@g\.us$/.test(id);
    try { group = group || !!(chat.isGroup || chat.groupMetadata); } catch (e3) {}
    return { id: id, name: String(name || id).slice(0, 80), group: !!group };
  }

  function messageToken(value) {
    if (typeof value !== "string" || !value) return "";
    var legacy = /^(?:true|false)_([^_]+@[^_]+)_(.+)$/.exec(value);
    if (legacy) {
      var rest = legacy[2];
      var cut = rest.lastIndexOf("_");
      if (cut > 0 && /^[^_@]+@[^_]+$/.test(rest.slice(cut + 1))) return rest.slice(0, cut);
      return rest;
    }
    if (/^[0-9A-Za-z]{8,80}$/.test(value)) return value;
    return "";
  }

  function normalizeChatId(value) {
    var raw = String(value || "").trim();
    if (!raw) return "";
    var compound = /^(?:true|false)_([^_]+@[^_]+)_/.exec(raw);
    if (compound) raw = compound[1];
    var at = raw.lastIndexOf("@");
    if (at <= 0) return "";
    var local = raw.slice(0, at);
    var host = raw.slice(at + 1).toLowerCase();
    var colon = local.indexOf(":");
    if (colon > 0) local = local.slice(0, colon);
    if (!local || !host || host === "broadcast" || host === "status") return "";
    return local + "@" + host;
  }

  function stampOf(msg) {
    var at = Number(msg && (msg.t || msg.timestamp) || 0);
    if (at > 0 && at < 1e12) at *= 1000;
    return at > 0 ? at : 0;
  }

  function textOf(value) {
    if (value == null) return "";
    if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
    return "";
  }

  function looksLikePhone(value) {
    return /^\+?\d[\d\s().-]{5,}$/.test(textOf(value));
  }

  function clipName(value) {
    var text = textOf(value);
    if (!text || text === "[object Object]" || looksLikePhone(text)) return "";
    return text.slice(0, 80);
  }

  function readField(obj, key, nested) {
    if (!obj || !key) return "";
    var value;
    try { value = obj[key]; } catch (e) { return ""; }
    if (typeof value === "function") {
      try { value = value.call(obj); } catch (e2) { return ""; }
    }
    var text = clipName(value);
    if (text) return text;
    if (!nested && obj.attributes && obj.attributes !== obj) return readField(obj.attributes, key, true);
    return "";
  }

  function readName(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var text = readField(obj, keys[i]);
      if (text) return text;
    }
    return "";
  }

  var CARD_FIELDS = ["name", "shortName", "formattedShortName", "mentionName", "verifiedName"];
  var OWN_FIELDS = ["pushname", "notifyName"];
  var SHOWN_FIELDS = ["formattedName", "displayName", "displayNameOrPnForLid"];

  function displayName(contact, msg) {
    var card = readName(contact, CARD_FIELDS);
    var own = readName(contact, OWN_FIELDS) || readName(msg, OWN_FIELDS);
    var shown = readName(contact, SHOWN_FIELDS);
    if (shown && (shown === own || shown === card)) shown = "";
    return card || own || shown;
  }

  function widKey(wid) {
    return widText(wid);
  }

  function isGroupMsg(msg) {
    if (!msg) return false;
    if (msg.isGroupMsg) return true;
    var id = typeof msg.id === "string" ? msg.id : widText(msg.id);
    if (/@g\.us/.test(id)) return true;
    return /@g\.us$/.test(widKey(msg.from));
  }

  function candidateWids(msg) {
    var list = [];
    function add(wid) { if (wid) list.push(wid); }
    if (!msg) return list;
    add(msg.id && msg.id.participant);
    add(msg.author);
    add(msg.participant);
    if (!isGroupMsg(msg)) add(msg.from);
    var sender = msg.sender;
    if (sender && typeof sender === "object") add(sender.id || sender);
    return list;
  }

  function personKey(msg) {
    var wids = candidateWids(msg);
    for (var i = 0; i < wids.length; i++) {
      var key = widKey(wids[i]);
      if (key && !/@g\.us$/.test(key)) return key;
    }
    return "";
  }

  function storeContact(wid) {
    var store = root.WPP && root.WPP.whatsapp && root.WPP.whatsapp.ContactStore;
    if (!store || !wid || typeof store.get !== "function") return null;
    var keys = [wid];
    var serial = widKey(wid);
    if (serial && serial !== wid) keys.push(serial);
    for (var i = 0; i < keys.length; i++) {
      try {
        var found = store.get(keys[i]);
        if (found && typeof found.then !== "function") return found;
      } catch (e) {}
    }
    return null;
  }

  function contactOf(msg) {
    var sender = msg && msg.sender;
    var direct = sender && typeof sender === "object" ? sender : null;
    if (direct && readName(direct, CARD_FIELDS)) return direct;
    var wids = candidateWids(msg);
    var i;
    for (i = 0; i < wids.length; i++) {
      var card = storeContact(wids[i]);
      if (card && readName(card, CARD_FIELDS)) return card;
    }
    for (i = 0; i < wids.length; i++) {
      var any = storeContact(wids[i]);
      if (any && displayName(any, msg)) return any;
    }
    if (direct && displayName(direct, msg)) return direct;
    return null;
  }

  function senderName(msg) {
    return displayName(contactOf(msg), msg);
  }

  function senderField(msg) {
    var contact = contactOf(msg) || {};
    if (readName(contact, ["name"])) return "name";
    if (readName(contact, ["shortName", "formattedShortName", "mentionName", "verifiedName"])) return "name";
    if (readName(contact, ["pushname"]) || readName(msg, ["pushname"])) return "pushname";
    if (readName(contact, ["notifyName"]) || readName(msg, ["notifyName"])) return "notifyName";
    if (readName(contact, SHOWN_FIELDS)) return "formattedName";
    return "none";
  }

  function nameFromPlain(value) {
    var text = String(value || "").replace(/[\u200e\u200f\u200b\u2066-\u2069]/g, "");
    var match = /^\[(\d{1,2}:\d{2}(?:\s*[AP]M)?)[,\s]+([^\]]+)\]\s*([^:\n]{0,160})/.exec(text);
    if (!match) return "";
    return clipName(match[3]);
  }

  function visibleSenderNames() {
    var map = Object.create(null);
    var main = document.getElementById && document.getElementById("main");
    if (!main || !main.querySelectorAll) return map;
    var rows = main.querySelectorAll("[data-id]");
    for (var i = 0; i < rows.length; i++) {
      var id = attr(rows[i], "data-id");
      var token = messageToken(id) || id;
      var plain = attr(rows[i], "data-pre-plain-text");
      if (!plain && rows[i].querySelector) {
        var node = rows[i].querySelector("[data-pre-plain-text]");
        plain = attr(node, "data-pre-plain-text");
      }
      var name = nameFromPlain(plain);
      if (!name) continue;
      if (token) map[token] = name;
      if (id) map[id] = name;
    }
    return map;
  }

  function mapMessage(msg) {
    if (!msg) return null;
    var type = String(msg.type || "");
    if (/e2e|notification|gp2|protocol|ciphertext|revoked|oversized/.test(type)) return null;
    var id = typeof msg.id === "string" ? msg.id : widText(msg.id);
    if (!id) return null;
    var at = stampOf(msg);
    if (!at) return null;
    var fromMe = !!(msg.id && msg.id.fromMe) || String(id).indexOf("true_") === 0 || !!msg.fromMe;
    var text = "";
    if (/ptt|audio/.test(type)) {
      text = typeof msg.transcript === "string" && msg.transcript.trim() ? msg.transcript.trim() : "[voice note]";
    }
    else if (/sticker/.test(type)) text = "[sticker]";
    else if (/call/.test(type)) return null;
    else if (/poll/.test(type)) {
      var poll = String(msg.pollName || msg.name || msg.body || "").trim();
      text = poll ? "[poll] " + poll : "[poll]";
    } else if (/location/.test(type)) text = "[location]";
    else if (/vcard/.test(type)) text = "[contact]";
    else if (/image|video|document|album/.test(type)) {
      var caption = String(msg.body || msg.caption || "").trim();
      var kind = /image/.test(type) ? "image" : /video/.test(type) ? "video" : /album/.test(type) ? "album" : "document";
      text = caption ? "[" + kind + "] " + caption : "[" + kind + "]";
    } else text = String(msg.body || msg.caption || "").trim();
    if (!text) return null;
    var quote = "";
    try {
      if (msg.quotedMsg) quote = String(msg.quotedMsg.body || msg.quotedMsg.caption || "").trim();
    } catch (e) {}
    if (quote.length > 120) quote = quote.slice(0, 120);
    return {
      id: id,
      token: messageToken(id) || id,
      at: at,
      from_me: fromMe,
      sender: senderName(msg),
      person: personKey(msg),
      text: text.slice(0, 2000),
      quote: quote,
      kind: type,
    };
  }

  function packedChunks(text) {
    var count = 0;
    var buf = 0;
    var start = 0;
    for (var i = 0; i <= text.length; i++) {
      if (i !== text.length && text.charAt(i) !== "\n") continue;
      var line = text.slice(start, i === text.length ? i : i + 1);
      start = i + 1;
      var n = line.length;
      if (!n) continue;
      if (n > CONTEXT_CHARS) {
        if (buf) count += 1;
        count += Math.floor(n / CONTEXT_CHARS);
        buf = n % CONTEXT_CHARS;
        continue;
      }
      if (buf && buf + n > CONTEXT_CHARS) {
        count += 1;
        buf = 0;
      }
      buf += n;
    }
    if (buf) count += 1;
    return count;
  }

  function newestNotes(messages) {
    var notes = (messages || []).filter(function (msg) {
      return msg && /ptt|audio/.test(msg.kind || "");
    });
    notes.sort(function (a, b) { return a.at - b.at; });
    if (notes.length > 500) notes = notes.slice(notes.length - 500);
    return notes;
  }

  function buildTranscript(messages, start, end, maxChars, offsetMin) {
    var list = (messages || []).filter(function (msg) {
      return msg && msg.at >= start && msg.at <= end && msg.text;
    });
    list.sort(function (a, b) { return a.at - b.at; });
    var sampled = false;
    function render(rows) {
      var lines = [];
      var prev = "";
      for (var i = 0; i < rows.length; i++) {
        var parts = localParts(rows[i].at, offsetMin);
        var when = parts.dayKey !== prev ? parts.day + " " + parts.clock : parts.clock;
        prev = parts.dayKey;
        var who = rows[i].from_me ? "You" : rows[i].sender;
        var body = rows[i].text;
        if (rows[i].quote) body += ' — re: "' + rows[i].quote + '"';
        lines.push(who ? when + " " + who + ": " + body : when + ": " + body);
      }
      return lines.join("\n");
    }
    var text = render(list);
    while (list.length > 1 && (text.length > maxChars || packedChunks(text) > MAX_CHUNKS)) {
      list.shift();
      sampled = true;
      text = render(list);
    }
    if (text.length > maxChars) {
      var cut = text.length - maxChars;
      var unit = text.charCodeAt(cut);
      if (unit >= 0xdc00 && unit <= 0xdfff) cut += 1;
      text = text.slice(cut);
      sampled = true;
    }
    return {
      text: text,
      sampled: sampled,
      coveredFrom: list.length ? list[0].at : start,
      count: list.length,
      anchor: list.length ? (list[list.length - 1].token || "") : "",
    };
  }

  function controlKind(node) {
    var bits = [];
    var cur = node;
    for (var i = 0; cur && i < 6; i++) {
      bits.push(attr(cur, "data-icon"), attr(cur, "data-testid"), attr(cur, "aria-label"), attr(cur, "title"));
      cur = cur.parentElement || cur.parentNode;
    }
    var text = bits.join(" ").toLowerCase();
    if (/video-?call|videocam|video-refreshed|ic-video|wds-ic-video/.test(text)) return "video";
    if (/search|buscar|pesquisa|ic-search|wds-ic-search/.test(text)) return "search";
    if (/voice-?call|audio-call|wds-ic-call|ic-call|(^|[^a-z])phone([^a-z]|$)/.test(text)) return "voice";
    if (/wds-ic-menu|ic-more|ic-menu|overflow|more-refreshed|mais op|(^|[^a-z])menu([^a-z]|$)/.test(text)) return "overflow";
    return "other";
  }

  function inChatHeader(node) {
    var cur = node;
    var sawHeader = false;
    for (var i = 0; cur && i < 12; i++) {
      if (String(cur.tagName || "").toLowerCase() === "header") sawHeader = true;
      if (cur.id === "main") return sawHeader;
      cur = cur.parentElement || cur.parentNode;
    }
    return false;
  }

  if (root.__WHATRUST_TEST) {
    root.__whatrustSummaryApi = {
      dayStart: dayStart,
      windowBounds: windowBounds,
      sinceLabel: sinceLabel,
      mapMessage: mapMessage,
      displayName: displayName,
      buildTranscript: buildTranscript,
      packedChunks: packedChunks,
      newestNotes: newestNotes,
      historyStep: historyStep,
      controlKind: controlKind,
      inChatHeader: inChatHeader,
      messageToken: messageToken,
      normalizeChatId: normalizeChatId,
      describeChat: describeChat,
      senderField: senderField,
    };
    return;
  }

  function crumb(msg) {
    var tauri = root.__TAURI__;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") return;
    tauri.core.invoke("dlog", { msg: String(msg).slice(0, 280) }).catch(function () {});
  }

  function invoke(cmd, args) {
    var tauri = root.__TAURI__;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") return Promise.reject("no_tauri");
    return tauri.core.invoke(cmd, args === undefined ? {} : args);
  }

  function withTimeout(promise, ms) {
    var timer;
    var wrapped = Promise.resolve(promise).then(
      function (value) { return { ok: true, value: value }; },
      function () { return { ok: false }; }
    );
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve({ ok: false, timedOut: true }); }, ms);
    });
    return Promise.race([wrapped, timeout]).then(function (result) {
      clearTimeout(timer);
      return result;
    });
  }

  function historyStep(cursor, cursorAt, oldestId, oldestAt, reached) {
    if (!oldestId || oldestId === cursor || reached) return "done";
    if (cursor && oldestAt > cursorAt) return "stall";
    return "next";
  }

  function hold(on) {
    if (typeof root.__whatrustMenuHold === "function") root.__whatrustMenuHold("summary", on);
  }

  function explain(error) {
    var text = error && error.message ? error.message : error;
    text = String(text || "error");
    if (text.indexOf("needs_consent") !== -1) return L("Confirme o envio antes de resumir.", "Confirm sending before summarizing.");
    if (text.indexOf("no_key") !== -1) return L("Falta a chave da API nas configurações.", "The API key is missing in Settings.");
    if (text.indexOf("locked") !== -1) return L("O whatRust está bloqueado.", "whatRust is locked.");
    if (text.indexOf("empty") !== -1) return L("Não há mensagens nesse intervalo.", "No messages in that range.");
    if (text.indexOf("llm") !== -1) return L("A IA não respondeu.", "The AI provider did not respond.");
    return L("Não foi possível resumir.", "Could not summarize.");
  }

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === "function") return root.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  var openId = "";
  var entries = [];
  var companion = null;
  var card = null;
  var pending = null;
  var menuTimer = 0;
  var runSeq = 0;
  var currentRun = 0;
  var runs = {};
  var inflight = false;
  var senderLogged = false;
  var theme = "light";

  var chatMissLogged = false;

  function headerName() {
    var header = document.querySelector("#main header");
    if (!header || !header.querySelector) return "";
    var title = header.querySelector("span[dir='auto'], span[title]");
    var text = title && (title.getAttribute("title") || title.textContent) || "";
    return String(text).replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function firstDataChat(node) {
    if (!node || !node.querySelectorAll) return "";
    var rows = node.querySelectorAll("[data-id]");
    for (var i = 0; i < rows.length && i < 40; i++) {
      var id = normalizeChatId(rows[i].getAttribute("data-id"));
      if (id) return id;
    }
    return "";
  }

  function domChat() {
    var main = document.getElementById("main");
    var id = firstDataChat(main);
    if (!id) {
      var side = document.getElementById("pane-side") || document.getElementById("side");
      var selected = side && side.querySelector ? side.querySelector('[aria-selected="true"]') : null;
      var node = selected;
      for (var n = 0; node && n < 6 && !id; n++) {
        id = normalizeChatId(node.getAttribute && node.getAttribute("data-id"));
        if (!id && node.querySelectorAll) id = firstDataChat(node);
        node = node.parentElement;
      }
    }
    if (!id) return null;
    return { id: id, name: headerName() || id, group: /@g\.us$/.test(id) };
  }

  function activeChat() {
    var wpp = root.WPP;
    var model = null;
    if (wpp && wpp.chat && typeof wpp.chat.getActiveChat === "function") {
      try { model = describeChat(wpp.chat.getActiveChat()); } catch (e) { model = null; }
    }
    var found = model || domChat();
    if (!found && !chatMissLogged) {
      chatMissLogged = true;
      crumb("summary: no active chat");
    }
    if (found) chatMissLogged = false;
    return found;
  }

  function colors() {
    var dark = false;
    try {
      dark = root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches;
      var sample = document.querySelector("#main header") || document.body;
      if (sample) {
        var bg = getComputedStyle(sample).backgroundColor || "";
        var nums = bg.match(/\d+/g);
        if (nums && nums.length >= 3) {
          var lum = (Number(nums[0]) * 299 + Number(nums[1]) * 587 + Number(nums[2]) * 114) / 1000;
          dark = lum < 140;
        }
      }
    } catch (e) {}
    theme = dark ? "dark" : "light";
    return dark
      ? { bg: "#233138", fg: "#e9edef", line: "rgba(134,150,160,.25)", muted: "#8696a0" }
      : { bg: "#ffffff", fg: "#111b21", line: "rgba(17,27,33,.12)", muted: "#667781" };
  }

  function ensureCompanion() {
    if (companion) return;
    companion = document.createElement("div");
    companion.id = "__whatrust_summary_menu";
    companion.setAttribute("data-wr-summary-menu", "1");
    companion.style.cssText = "position:fixed;z-index:100003;display:none;box-sizing:border-box;overflow:hidden;box-shadow:0 12px 28px #0006;margin:0;padding:0";
    document.documentElement.appendChild(companion);
  }

  function hideCompanion() {
    pending = null;
    hold(false);
    clearTimeout(menuTimer);
    if (companion) {
      companion.style.display = "none";
      companion.setAttribute("data-mode", "");
    }
  }

  function placeCompanion(rect, above) {
    var viewW = root.innerWidth || 800;
    var viewH = root.innerHeight || 800;
    var width = Math.max(220, Math.min(rect.width || 240, viewW - 16));
    companion.style.width = width + "px";
    companion.style.display = "block";
    var height = companion.offsetHeight || 48;
    var top = above ? Math.max(8, rect.top - height) : rect.bottom;
    if (!above && top + height > viewH - 8) {
      top = Math.max(8, rect.top - height);
      above = true;
    }
    companion.style.left = Math.max(8, Math.min(rect.left, viewW - width - 8)) + "px";
    companion.style.top = top + "px";
    companion.style.borderRadius = above ? "12px 12px 0 0" : "0 0 12px 12px";
  }

  function buttonRow(title, subtitle, action) {
    var button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-wr-summary-menu", "1");
    button.setAttribute("data-wr-summary-action", action);
    var paint = colors();
    button.style.cssText = "display:block;width:100%;text-align:start;padding:10px 14px;border:0;border-top:1px solid " + paint.line + ";background:transparent;color:" + paint.fg + ";font:14px system-ui;cursor:pointer";
    var label = document.createElement("div");
    label.textContent = title;
    button.appendChild(label);
    if (subtitle) {
      var sub = document.createElement("div");
      sub.textContent = subtitle;
      sub.style.cssText = "font-size:12px;margin-top:2px;color:" + paint.muted;
      button.appendChild(sub);
    }
    return button;
  }

  function fillCompanion(mode) {
    var paint = colors();
    companion.replaceChildren();
    companion.style.background = paint.bg;
    companion.style.color = paint.fg;
    companion.style.colorScheme = theme;
    if (mode === "ranges") {
      var now = Date.now();
      var offset = tzOffset();
      [
        ["1h", L("Última hora", "Last hour")],
        ["4h", L("Últimas 4 horas", "Last 4 hours")],
        ["today", L("Hoje", "Today")],
        ["3d", L("Últimos 3 dias", "Last 3 days")],
      ].forEach(function (row) {
        var bounds = windowBounds(row[0], now, offset);
        var since = L("desde ", "since ") + sinceLabel(bounds.start, now, offset);
        companion.appendChild(buttonRow(row[1], since, row[0]));
      });
      return;
    }
    companion.appendChild(buttonRow(L("Criar resumo", "Create summary"), "", "open"));
  }

  function findMenu(point) {
    if (!document.querySelectorAll) return null;
    var nodes = document.querySelectorAll("ul, [role='menu'], [role='listbox']");
    var best = null;
    var bestDist = 280;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el.getBoundingClientRect) continue;
      if (el.id && String(el.id).indexOf("__whatrust") === 0) continue;
      if (el.closest && el.closest("#pane-side, #side")) continue;
      if (el.querySelector && el.querySelector("[data-id]")) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 140 || rect.width > 560 || rect.height < 48 || rect.height > 680) continue;
      var dx = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;
      var dy = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
      var dist = dx + dy;
      if (dist < bestDist) {
        best = el;
        bestDist = dist;
      }
    }
    return best;
  }

  function pinRect(rect) {
    if (!rect) return null;
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width || 240,
      height: rect.height || 0,
    };
  }

  function showCompanion() {
    if (!pending) return;
    ensureCompanion();
    var menu = findMenu(pending);
    if (menu && menu.getBoundingClientRect) pending.pinned = pinRect(menu.getBoundingClientRect());
    if (!pending.pinned) {
      if (!menu && Date.now() - pending.at < 400) return;
      if (!pending.explicit) {
        hideCompanion();
        return;
      }
      pending.pinned = pinRect(pending.button);
    }
    if (!pending.pinned) return;
    var mode = companion.getAttribute("data-mode");
    var pinKey = [pending.pinned.left, pending.pinned.top, pending.pinned.bottom, pending.pinned.width].join(":");
    if (pending.placed && mode === pending.mode && pending.pinKey === pinKey) return;
    if (mode !== pending.mode) {
      fillCompanion(pending.mode);
      companion.setAttribute("data-mode", pending.mode);
    }
    placeCompanion(pending.pinned, false);
    pending.placed = true;
    pending.pinKey = pinKey;
  }

  function pumpCompanion() {
    if (!pending) return;
    showCompanion();
    if (!pending) return;
    if (Date.now() - pending.at > 30000) {
      hideCompanion();
      return;
    }
    menuTimer = setTimeout(pumpCompanion, 120);
  }

  function showRanges(pin) {
    if (!pin) return;
    pending = {
      at: Date.now(),
      x: pin.left || 0,
      y: pin.top || 0,
      explicit: true,
      mode: "ranges",
      button: pin,
      pinned: pin,
    };
    hold(true);
    clearTimeout(menuTimer);
    pumpCompanion();
  }

  function arm(button, explicit, x, y) {
    var rect = button && button.getBoundingClientRect ? button.getBoundingClientRect() : { left: x, top: y, right: x + 32, bottom: y + 32, width: 240 };
    pending = { at: Date.now(), x: x, y: y, explicit: explicit, mode: "create", button: pinRect(rect) };
    hold(true);
    clearTimeout(menuTimer);
    pumpCompanion();
  }

  function ensureCard() {
    if (card) return;
    card = document.createElement("div");
    card.id = "__whatrust_summary_card";
    card.setAttribute("data-wr-chat-summary", "card");
    card.setAttribute("dir", "auto");
    card.style.cssText = "position:fixed;top:72px;right:16px;z-index:100004;display:none;width:min(380px,calc(100vw - 32px));max-height:min(420px,calc(100vh - 96px));overflow:auto;box-sizing:border-box;padding:14px;border-radius:14px;box-shadow:0 12px 28px #0006;font:14px/1.4 system-ui";
    document.documentElement.appendChild(card);
  }

  function paintCard(text, actions) {
    ensureCard();
    var paint = colors();
    card.style.display = "block";
    card.style.background = paint.bg;
    card.style.color = paint.fg;
    card.replaceChildren();
    var body = document.createElement("div");
    body.style.whiteSpace = "pre-wrap";
    body.textContent = text;
    card.appendChild(body);
    if (actions && actions.length) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;margin-top:12px";
      actions.forEach(function (action) {
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        button.setAttribute("data-wr-chat-summary", "card");
        button.style.cssText = "border:0;border-radius:8px;padding:6px 10px;cursor:pointer;font:inherit;background:transparent;color:inherit;text-decoration:underline";
        button.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          action.fn();
        });
        row.appendChild(button);
      });
      card.appendChild(row);
    }
  }

  function hideCard() {
    if (card) card.style.display = "none";
  }

  function dropRun(id) {
    var run = runs[id];
    if (run) run.drop = true;
  }

  function rangeTitle(range) {
    if (range === "4h") return L("Últimas 4 horas", "Last 4 hours");
    if (range === "today") return L("Hoje", "Today");
    if (range === "3d") return L("Últimos 3 dias", "Last 3 days");
    return L("Última hora", "Last hour");
  }

  function spanLabel(entry) {
    var offset = tzOffset();
    var start = localParts(entry.covered_from_ms || entry.window_start_ms, offset);
    var end = localParts(entry.window_end_ms, offset);
    var from = dayName(start.day) + " " + start.clock;
    var to = end.dayKey === start.dayKey ? end.clock : dayName(end.day) + " " + end.clock;
    return from + " – " + to;
  }

  function bulletLines(points) {
    return (points || []).map(function (point) { return "• " + point; }).join("\n");
  }

  function copyText(entry) {
    var lines = [rangeTitle(entry.range) + " · " + spanLabel(entry), bulletLines(entry.points)];
    var text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
      return;
    }
    var area = document.createElement("textarea");
    area.value = text;
    document.documentElement.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } catch (e) {}
    area.remove();
  }

  function remember(entry) {
    if (!entry || !entry.id) return;
    var next = [];
    var replaced = false;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].chat_id === entry.chat_id && entries[i].range === entry.range) {
        next.push(entry);
        replaced = true;
      } else if (entries[i].id !== entry.id) next.push(entries[i]);
    }
    if (!replaced) next.push(entry);
    entries = next;
  }

  function findBlock(row, id) {
    var kids = row.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute("data-wr-summary-block") === id) return kids[i];
    }
    return null;
  }

  function paintBlock(row, entry) {
    var id = String(entry.id);
    var box = findBlock(row, id);
    var paint = colors();
    var sig = theme + ":" + entry.updated_at + ":" + (entry.points || []).join("|");
    if (box && box.getAttribute("data-sig") === sig) return;
    var host = row.ownerDocument && row.ownerDocument.getElementById ? row.ownerDocument.getElementById("main") : null;
    if (host && host.querySelectorAll) {
      var copies = host.querySelectorAll("[data-wr-summary-block]");
      for (var c = 0; c < copies.length; c++) {
        if (copies[c].getAttribute("data-wr-summary-block") !== id || copies[c] === box) continue;
        if (copies[c].parentNode) copies[c].parentNode.removeChild(copies[c]);
      }
    }
    if (!box) {
      box = document.createElement("div");
      box.setAttribute("data-wr-summary-block", id);
      box.setAttribute("data-wr-chat-summary", id);
      box.setAttribute("dir", "auto");
      row.appendChild(box);
    }
    box.setAttribute("data-sig", sig);
    box.style.cssText = "margin:6px 8px;padding:8px 10px;border-radius:8px;background:" + paint.bg + ";color:" + paint.fg + ";font:13px/1.4 system-ui;box-shadow:inset 0 0 0 1px " + paint.line;
    box.replaceChildren();
    var title = document.createElement("div");
    title.style.fontWeight = "700";
    title.textContent = rangeTitle(entry.range);
    box.appendChild(title);
    var meta = document.createElement("div");
    meta.style.cssText = "font-size:12px;margin:2px 0 6px;color:" + paint.muted;
    var metaText = spanLabel(entry) + " · " + (entry.message_count || 0) + " " + L("mensagens", "messages");
    if (entry.sampled) {
      metaText += " · " + L("a partir de ", "from ") + sinceLabel(entry.covered_from_ms, entry.window_end_ms, tzOffset());
    }
    meta.textContent = metaText;
    box.appendChild(meta);
    var list = document.createElement("ul");
    list.style.cssText = "margin:0;padding:0;list-style:none";
    (entry.points || []).forEach(function (point) {
      var item = document.createElement("li");
      item.setAttribute("dir", "auto");
      item.style.cssText = "display:block;margin:3px 0;padding-inline-start:1.15em;text-indent:-1.15em";
      item.textContent = "• " + point;
      list.appendChild(item);
    });
    box.appendChild(list);
    var actions = document.createElement("div");
    function link(label, fn) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("data-wr-chat-summary", "action");
      button.style.cssText = "margin:8px 8px 0 0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;cursor:pointer";
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        fn();
      });
      actions.appendChild(button);
    }
    link(L("Copiar", "Copy"), function () { copyText(entry); });
    link(L("Atualizar", "Refresh"), function () { begin(entry.range); });
    link(L("Apagar", "Delete"), function () {
      Object.keys(runs).forEach(function (id) {
        var run = runs[id];
        if (run && run.chat === entry.chat_id && run.range === entry.range) run.drop = true;
      });
      invoke("chat_summary_delete", { id: entry.id }).then(function () {
        entries = entries.filter(function (item) { return item.id !== entry.id; });
        if (box.parentNode) box.parentNode.removeChild(box);
      }).catch(function () {});
    });
    box.appendChild(actions);
  }

  function atBottom() {
    var main = document.getElementById("main");
    if (!main || !main.querySelector) return false;
    var node = main.querySelector("[data-id]");
    for (var i = 0; node && node !== document.body && i < 10; i++) {
      if (node.scrollHeight > node.clientHeight + 80) {
        return node.scrollTop + node.clientHeight >= node.scrollHeight - 160;
      }
      node = node.parentElement;
    }
    return false;
  }

  function paintAll() {
    var main = document.getElementById("main");
    if (!main || !main.querySelectorAll) return;
    if (typeof root.__whatrustPageBusy === "function" && root.__whatrustPageBusy()) return;
    var rows = main.querySelectorAll("[data-id]");
    var byId = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var data = attr(rows[i], "data-id");
      if (data) byId[data] = rows[i];
      var token = messageToken(data);
      if (token) byId[token] = rows[i];
    }
    var keep = Object.create(null);
    entries.forEach(function (entry) {
      if (!entry || entry.chat_id !== openId) return;
      var row = entry.anchor_token ? byId[entry.anchor_token] || byId[messageToken(entry.anchor_token)] : null;
      if (!row && atBottom() && rows.length) row = rows[rows.length - 1];
      if (!row) return;
      keep[entry.id] = true;
      paintBlock(row, entry);
    });
    var boxes = main.querySelectorAll("[data-wr-summary-block]");
    for (var n = 0; n < boxes.length; n++) {
      var id = boxes[n].getAttribute("data-wr-summary-block");
      if (!keep[id] && boxes[n].parentNode) boxes[n].parentNode.removeChild(boxes[n]);
    }
  }

  function loadEntries(chatId) {
    return invoke("chat_summaries", { chat_id: chatId }).then(function (list) {
      if (chatId !== openId) return;
      entries = entries.filter(function (item) { return item.chat_id !== chatId; }).concat(list || []);
      paintAll();
    }).catch(function () {});
  }

  function noteSender(raw) {
    if (senderLogged || !raw) return;
    var field = senderField(raw);
    if (field === "none") return;
    senderLogged = true;
    crumb("summary: sender " + field);
  }

  function modelList(collection) {
    if (!collection) return [];
    try {
      if (typeof collection.getModelsArray === "function") return collection.getModelsArray() || [];
    } catch (e) {}
    if (collection.models) return collection.models;
    if (collection._models) return collection._models;
    return [];
  }

  function rawChat(chatId) {
    var wpp = root.WPP;
    if (!wpp || !wpp.chat) return null;
    try {
      if (typeof wpp.chat.get === "function") {
        var found = wpp.chat.get(chatId);
        if (found && (typeof found.then !== "function" || found.id)) return found;
      }
    } catch (e) {}
    try {
      var active = wpp.chat.getActiveChat && wpp.chat.getActiveChat();
      if (active && typeof active.then !== "function" && normalizeChatId(widText(active.id)) === chatId) return active;
    } catch (e2) {}
    return null;
  }

  function collect(chatId, start, runId) {
    var wpp = root.WPP;
    if (!wpp || !wpp.chat || typeof wpp.chat.getMessages !== "function") {
      return Promise.resolve({ messages: [], partial: false });
    }
    var seen = Object.create(null);
    var all = [];
    var cursor = "";
    var cursorAt = Infinity;
    var pages = 0;
    var chars = 0;
    var reached = false;
    function take(raw) {
      noteSender(raw);
      var at = stampOf(raw);
      if (at && at < start) reached = true;
      var msg = mapMessage(raw);
      if (!msg || seen[msg.id]) return false;
      seen[msg.id] = true;
      if (msg.at < start) return false;
      all.push(msg);
      chars += msg.text.length + 24;
      return true;
    }
    function addLoaded() {
      var chat = rawChat(chatId);
      var models = modelList(chat && chat.msgs);
      for (var i = 0; i < models.length; i++) take(models[i]);
    }
    function pack(partial) {
      addLoaded();
      return { messages: all, partial: !!(partial && !reached) };
    }
    function step() {
      var run = runs[runId];
      if (!run || run.drop || currentRun !== runId) return Promise.resolve(pack(true));
      if (pages >= 25 || all.length >= 2000 || chars >= MAX_CHARS) return Promise.resolve(pack(true));
      pages += 1;
      var args = { count: 100 };
      if (cursor) {
        args.direction = "before";
        args.id = cursor;
      }
      return withTimeout(wpp.chat.getMessages(chatId, args), PAGE_WAIT_MS).then(function (result) {
        if (!result.ok) {
          crumb("summary: history timed out");
          return pack(true);
        }
        var batch = result.value || [];
        if (!batch.length) return pack(false);
        var oldestId = "";
        var oldestAt = Infinity;
        for (var i = 0; i < batch.length; i++) {
          var raw = batch[i];
          var at = stampOf(raw);
          var id = typeof raw.id === "string" ? raw.id : widText(raw.id);
          if (id && at && at < oldestAt) {
            oldestAt = at;
            oldestId = id;
          }
          take(raw);
          if (all.length >= 2000 || chars >= MAX_CHARS) break;
        }
        var move = historyStep(cursor, cursorAt, oldestId, oldestAt, reached);
        if (move === "stall") return pack(true);
        if (move !== "next") return pack(false);
        cursor = oldestId;
        cursorAt = oldestAt;
        return step();
      });
    }
    return step();
  }

  function fillNames(messages, chat) {
    var visible = visibleSenderNames();
    var shownFor = Object.create(null);
    var cardFor = Object.create(null);
    var profileFor = Object.create(null);
    messages.forEach(function (msg) {
      if (!msg || msg.from_me || !msg.person) return;
      var shown = visible[msg.token] || visible[msg.id];
      if (shown) shownFor[msg.person] = shown;
    });
    function apply() {
      messages.forEach(function (msg) {
        if (!msg || msg.from_me) return;
        var shown = visible[msg.token] || visible[msg.id] || (msg.person && shownFor[msg.person]);
        if (shown) {
          msg.sender = shown;
          return;
        }
        if (msg.person && cardFor[msg.person]) {
          msg.sender = cardFor[msg.person];
          return;
        }
        if (msg.sender) return;
        if (msg.person && profileFor[msg.person]) msg.sender = profileFor[msg.person];
      });
      if (!chat || chat.group) return;
      var title = clipName(chat.name);
      if (!title || title === chat.id) return;
      messages.forEach(function (msg) {
        if (msg && !msg.from_me && !msg.sender) msg.sender = title;
      });
    }
    var people = Object.create(null);
    messages.forEach(function (msg) {
      if (msg && !msg.from_me && !msg.sender && msg.person && !shownFor[msg.person]) people[msg.person] = true;
    });
    var keys = Object.keys(people);
    var get = root.WPP && root.WPP.contact && root.WPP.contact.get;
    if (!keys.length || typeof get !== "function") {
      apply();
      return Promise.resolve();
    }
    var pending = Promise.all(keys.map(function (key) {
      return Promise.resolve().then(function () { return get(key); }).then(function (contact) {
        var card = readName(contact, CARD_FIELDS);
        if (card) cardFor[key] = card;
        else {
          var own = displayName(contact, null);
          if (own) profileFor[key] = own;
        }
      }).catch(function () {});
    }));
    return withTimeout(pending, NAME_WAIT_MS).then(function (result) {
      if (!result.ok) crumb("summary: names timed out");
      apply();
    });
  }

  function attachVoice(messages) {
    var notes = newestNotes(messages);
    if (!notes.length) return Promise.resolve();
    return withTimeout(
      invoke("voice_transcripts", { ids: notes.map(function (msg) { return msg.id; }) }),
      VOICE_WAIT_MS
    ).then(function (result) {
      if (!result.ok) {
        crumb("summary: voice timed out");
        return;
      }
      var byId = Object.create(null);
      (result.value || []).forEach(function (hit) {
        if (hit && hit.id && hit.text) byId[hit.id] = hit.text;
      });
      messages.forEach(function (msg) {
        if (byId[msg.id]) msg.text = String(byId[msg.id]).slice(0, 2000);
        else if (byId[msg.token]) msg.text = String(byId[msg.token]).slice(0, 2000);
      });
    });
  }

  function finish(runId, entry) {
    var run = runs[runId];
    delete runs[runId];
    var current = currentRun === runId;
    if (current) {
      currentRun = 0;
      inflight = false;
    }
    if (run && run.drop) {
      if (entry && entry.id) {
        invoke("chat_summary_delete", { id: entry.id, updated_at: entry.updated_at }).catch(function () {});
      }
      return;
    }
    if (!entry || entry.chat_id !== openId) return;
    remember(entry);
    paintAll();
    if (!current) return;
    hideCard();
    if (!document.querySelector("[data-wr-summary-block='" + cssEscape(entry.id) + "']")) {
      paintCard(rangeTitle(entry.range) + "\n" + bulletLines(entry.points), [
        { label: L("Fechar", "Close"), fn: hideCard },
      ]);
    }
  }

  function start(chat, range) {
    if (inflight) return;
    inflight = true;
    var runId = ++runSeq;
    currentRun = runId;
    runs[runId] = { drop: false, chat: chat.id, range: range };
    var offset = tzOffset();
    var bounds = windowBounds(range, Date.now(), offset);
    paintCard(L("Lendo as mensagens…", "Reading messages…"), [
      { label: L("Cancelar", "Cancel"), fn: function () { dropRun(runId); inflight = false; currentRun = 0; hideCard(); } },
    ]);
    collect(chat.id, bounds.start, runId).then(function (result) {
      var messages = result && result.messages || [];
      if (runId !== currentRun || (runs[runId] && runs[runId].drop)) return finish(runId, null);
      return attachVoice(messages).then(function () {
        if (runId !== currentRun || (runs[runId] && runs[runId].drop)) return finish(runId, null);
        return fillNames(messages, chat).then(function () {
        if (runId !== currentRun || (runs[runId] && runs[runId].drop)) return finish(runId, null);
        var built = buildTranscript(messages, bounds.start, bounds.end, MAX_CHARS, offset);
        if (result && result.partial) built.sampled = true;
        if (!built.text) {
          delete runs[runId];
          if (currentRun === runId) {
            currentRun = 0;
            inflight = false;
            paintCard(L("Não há mensagens nesse intervalo.", "No messages in that range."), [
              { label: L("Fechar", "Close"), fn: hideCard },
            ]);
          }
          return;
        }
        paintCard(L("Resumindo…", "Summarizing…"), [
          { label: L("Cancelar", "Cancel"), fn: function () { dropRun(runId); inflight = false; currentRun = 0; hideCard(); } },
        ]);
        return invoke("summarize_chat", {
          chat_id: chat.id,
          chat_name: chat.name,
          range: range,
          window_start_ms: bounds.start,
          window_end_ms: bounds.end,
          anchor_token: built.anchor,
          transcript: built.text,
          acknowledged: true,
          covered_from_ms: built.coveredFrom,
          sampled: built.sampled,
          message_count: built.count,
        }).then(function (entry) { finish(runId, entry); });
        });
      });
    }).catch(function (error) {
      var dropped = runs[runId] && runs[runId].drop;
      delete runs[runId];
      if (runId !== currentRun || dropped) {
        if (currentRun === 0 || currentRun === runId) inflight = false;
        return;
      }
      inflight = false;
      paintCard(explain(error), [{ label: L("Fechar", "Close"), fn: hideCard }]);
    });
  }

  function sameChat(chat) {
    var now = activeChat();
    return !!(chat && now && now.id === chat.id);
  }

  function begin(range) {
    if (inflight) return;
    var chat = activeChat();
    if (!chat) {
      paintCard(L("Abra uma conversa primeiro.", "Open a chat first."), [
        { label: L("Fechar", "Close"), fn: hideCard },
      ]);
      return;
    }
    var pin = pending && (pending.pinned || pending.button);
    hideCompanion();
    invoke("chat_summary_consent").then(function (view) {
      if (!sameChat(chat)) return;
      if (view && view.consented) {
        start(chat, range);
        return;
      }
      var provider = view && view.provider ? view.provider : "OpenRouter";
      paintCard(
        L(
          "O whatRust envia as mensagens deste intervalo para " + provider + " e guarda o resumo neste computador, não no telefone. Em grupos, isso inclui o que as outras pessoas escreveram. Nada é enviado no chat.",
          "whatRust sends the messages in this range to " + provider + " and saves the summary on this computer, not on the phone. In a group, that includes what other people wrote. Nothing is sent into the chat."
        ),
        [
          {
            label: L("Criar resumo", "Create summary"),
            fn: function () {
              if (!sameChat(chat)) { hideCard(); return; }
              start(chat, range);
            },
          },
          {
            label: L("Cancelar", "Cancel"),
            fn: function () {
              hideCard();
              if (pin && sameChat(chat)) showRanges(pin);
            },
          },
        ]
      );
    }).catch(function (error) {
      if (!sameChat(chat)) return;
      paintCard(explain(error), [{ label: L("Fechar", "Close"), fn: hideCard }]);
    });
  }

  function onCompanionAction(action) {
    if (!pending) return;
    if (action === "open") {
      pending.mode = "ranges";
      showCompanion();
      return;
    }
    if (action === "1h" || action === "4h" || action === "today" || action === "3d") begin(action);
  }

  document.addEventListener("pointerdown", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var own = target.closest("[data-wr-summary-menu]");
    if (own) {
      var action = own.getAttribute("data-wr-summary-action");
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      onCompanionAction(action);
      return;
    }
    if (!inChatHeader(target)) {
      if (pending && Date.now() - pending.at > 280) hideCompanion();
      return;
    }
    var button = target.closest("button, [role='button']");
    if (!button) return;
    var kind = controlKind(button);
    if (kind === "video" || kind === "voice" || kind === "search") return;
    arm(button, kind === "overflow", event.clientX, event.clientY);
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && pending) hideCompanion();
  }, true);

  function watchChat() {
    var chat = activeChat();
    var id = chat ? chat.id : "";
    if (id === openId) return;
    var previous = openId;
    openId = id;
    if (pending) hideCompanion();
    hideCard();
    if (inflight) {
      currentRun = 0;
      inflight = false;
    }
    if (id && id !== previous) loadEntries(id);
  }

  var paintTimer = 0;
  function schedulePaint() {
    if (paintTimer) return;
    paintTimer = setTimeout(function () {
      paintTimer = 0;
      if (typeof root.__whatrustPageBusy === "function" && root.__whatrustPageBusy()) {
        schedulePaint();
        return;
      }
      paintAll();
    }, 300);
  }

  function boot() {
    var wpp = root.WPP;
    if (!wpp || !wpp.isReady) {
      setTimeout(boot, 500);
      return;
    }
    crumb("summary: injected");
    watchChat();
    setInterval(watchChat, 700);
    if (typeof MutationObserver === "function") {
      new MutationObserver(function () { setTimeout(schedulePaint, 300); }).observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener("scroll", function () { setTimeout(schedulePaint, 200); }, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

/* Stand-in replies for one 1:1 chat. Search stays in this page. Sending is
 * only done with text that Rust returned as a send. */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  if (!root.__WHATRUST_TEST && (!root.location || root.location.origin !== "https://web.whatsapp.com")) return;

  var FRESH_MS = 180000;
  var ARM_SLACK_MS = 5000;
  var MAX_BATCH_MS = 30000;
  var HISTORY_CAP = 500;

  function fold(value) {
    return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function chatFromId(id) {
    var match = /^(?:true|false)_([^_]+@[^_]+)_/.exec(id || "");
    return match ? match[1] : "";
  }

  function normalizeChatId(value) {
    var raw = String(value || "").trim();
    if (!raw || raw.length > 180) return "";
    var compound = chatFromId(raw);
    if (compound) raw = compound;
    var at = raw.lastIndexOf("@");
    if (at <= 0 || at === raw.length - 1) return "";
    var local = raw.slice(0, at);
    var host = raw.slice(at + 1).toLowerCase();
    var colon = local.indexOf(":");
    if (colon > 0) local = local.slice(0, colon);
    if (!local || !host || /[\s_@]/.test(local) || /[\s_@:]/.test(host)) return "";
    if (host === "broadcast") return "";
    return local + "@" + host;
  }

  function isDirectId(id) {
    return /@(c\.us|lid|s\.whatsapp\.net)$/.test(normalizeChatId(id));
  }

  function widText(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value._serialized === "string") return value._serialized;
    if (typeof value.toString === "function") {
      try {
        var text = String(value.toString());
        if (text && text !== "[object Object]") return text;
      } catch (e) {}
    }
    return "";
  }

  function messageChatId(msg) {
    if (!msg || msg.isGroupMsg) return "";
    if (msg.chat && (msg.chat.isGroup || msg.chat.groupMetadata)) return "";
    var id = msg.id;
    var raw = "";
    if (typeof id === "string") raw = chatFromId(id);
    if (!raw && id) raw = widText(id.remote);
    if (!raw && msg.chat) raw = widText(msg.chat.id);
    if (/@g\.us|@broadcast|@newsletter/.test(String(raw))) return "";
    var direct = normalizeChatId(raw);
    if (isDirectId(direct)) return direct;
    var fallback = widText(id && id.fromMe ? msg.to : msg.from);
    if (/@g\.us|@broadcast|@newsletter/.test(String(fallback))) return "";
    direct = normalizeChatId(fallback);
    return isDirectId(direct) ? direct : "";
  }

  function sameMessage(a, b) {
    if (!a || !b) return false;
    if (a.id && a.id === b.id) return true;
    return !!(a.msg_token && a.msg_token === b.msg_token);
  }

  function isFresh(at, armed, now) {
    at = Number(at) || 0;
    armed = Number(armed) || 0;
    now = Number(now) || 0;
    return at + ARM_SLACK_MS >= armed && now - at <= FRESH_MS && now - at >= -15000;
  }

  function isStandinEcho(token, text, tokens, inflight, now) {
    now = now || Date.now();
    if (token && tokens && tokens.indexOf(token) !== -1) return true;
    if (!inflight || now > inflight.until) return false;
    return fold(text) === fold(inflight.text);
  }

  function searchMessages(list, query, limit) {
    var parts = fold(query).split(/\s+/).filter(Boolean);
    var cap = Math.max(1, Math.min(10, Number(limit) || 5));
    var hits = [];
    if (!parts.length) return hits;
    for (var i = 0; i < list.length && hits.length < cap; i++) {
      var text = fold(list[i] && list[i].text);
      var matched = parts.every(function (part) { return text.indexOf(part) !== -1; });
      if (!matched) continue;
      var from = Math.max(0, i - 2);
      var to = Math.min(list.length, i + 3);
      var around = [];
      for (var n = from; n < to; n++) {
        around.push({
          id: list[n].id || "",
          from_me: !!list[n].from_me,
          text: String(list[n].text || "").slice(0, 500),
        });
      }
      hits.push({ id: list[i].id || "", around: around });
    }
    return hits;
  }

  function attrOf(el, name) {
    if (!el || typeof el.getAttribute !== "function") return "";
    return el.getAttribute(name) || "";
  }

  function listed(el, selector) {
    if (!el || typeof el.querySelectorAll !== "function") return [];
    return Array.prototype.slice.call(el.querySelectorAll(selector));
  }

  // Header buttons only. A video-call control is the anchor; the menu and the
  // voice call must not match, or the pill lands on top of them.
  function isVideoCallControl(el) {
    if (!el || typeof el.getAttribute !== "function") return false;
    var tag = String(el.tagName || "").toLowerCase();
    var itself = tag === "button" || attrOf(el, "role") === "button";
    if (!itself && listed(el, "button,[role=button]").length > 1) return false;
    var bits = [
      attrOf(el, "data-icon"),
      attrOf(el, "data-testid"),
      attrOf(el, "aria-label"),
      attrOf(el, "title"),
    ];
    listed(el, "[data-icon],[data-testid]").forEach(function (node) {
      bits.push(
        attrOf(node, "data-icon"),
        attrOf(node, "data-testid"),
        attrOf(node, "aria-label"),
        attrOf(node, "title")
      );
    });
    var text = fold(bits.join(" "));
    if (!/\S/.test(text)) return false;
    if (/video-note|status-video|gif/.test(text)) return false;
    if (/video-?call|videocam|video-refreshed|ic-video|wds-ic-video/.test(text)) return true;
    if (/video/.test(text) && /call|chamada|ligar|ligac|llamada/.test(text)) return true;
    if (/(^|[^a-z])video([^a-z]|$)/.test(text)) return true;
    return false;
  }

  function videoCallButton(doc) {
    var header = doc.querySelector("#main header");
    if (!header) return null;
    var buttons = listed(header, "button,[role=button]");
    for (var i = 0; i < buttons.length; i++) {
      var el = buttons[i];
      if (typeof el.closest === "function" && el.closest("[data-whatrust-standin]")) continue;
      if (isVideoCallControl(el)) return el;
    }
    return null;
  }

  if (root.__WHATRUST_TEST) {
    root.__whatrustAutoreplyApi = {
      normalizeChatId: normalizeChatId,
      isDirectId: isDirectId,
      isFresh: isFresh,
      isStandinEcho: isStandinEcho,
      searchMessages: searchMessages,
      messageChatId: messageChatId,
      sameMessage: sameMessage,
      mapMessage: mapMessage,
      messageToken: messageToken,
      fold: fold,
      isVideoCallControl: isVideoCallControl,
      videoCallButton: videoCallButton,
    };
    return;
  }

  var prefs = { enabled: false, delay_secs: 10, voice: false, backend: "api" };
  var chats = {};
  var privacyAck = false;
  var timers = {};
  var batchStart = {};
  var pending = {};
  var inflight = {};
  var history = {};
  var busy = {};
  var host = null;
  var shadow = null;
  var panelHost = null;
  var panelShadow = null;
  var bannerHost = null;
  var HOST_STYLE = "display:flex;align-items:center;flex:0 1 auto;min-width:0;margin-inline-end:6px";
  var open = false;
  var watching = false;
  var menuQuietUntil = 0;

  var mine = {};
  var mineAt = 0;
  var recentSends = {};
  var answered = {};
  var bannerTimer = null;

  function invoke(cmd, args) {
    var tauri = root.__TAURI__;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") return Promise.reject("no_tauri");
    return tauri.core.invoke(cmd, args === undefined ? {} : args);
  }

  function rememberMine() {
    var conn = root.WPP && root.WPP.conn;
    if (!conn) return;
    if (mineAt && Date.now() - mineAt < 30000) return;
    var found = false;
    ["getMyUserId", "getMyUserLid", "getMyUserWid"].forEach(function (name) {
      if (typeof conn[name] !== "function") return;
      try {
        var id = normalizeChatId(widText(conn[name]()));
        if (id) {
          mine[id] = true;
          found = true;
        }
      } catch (e) {}
    });
    // Only hold the answer for a while once it is known; before WhatsApp is
    // ready there is nothing to cache, so try again on the next call.
    if (found) mineAt = Date.now();
  }

  function isMine(id) {
    rememberMine();
    return !!mine[normalizeChatId(id)];
  }

  function blockedChat(chat) {
    if (!chat) return false;
    if (chat.isGroup || chat.groupMetadata) return true;
    var wid = chat.id;
    try {
      if (wid && typeof wid.isGroup === "function" && wid.isGroup()) return true;
      if (wid && typeof wid.isPSA === "function" && wid.isPSA()) return true;
      if (wid && typeof wid.isNewsletter === "function" && wid.isNewsletter()) return true;
      if (wid && typeof wid.isBroadcast === "function" && wid.isBroadcast()) return true;
    } catch (e) {}
    return /^meta ai$/i.test(String(chat.formattedTitle || chat.name || "").trim());
  }

  function rememberSend(chatId, text, token) {
    var bag = recentSends[chatId] || (recentSends[chatId] = []);
    bag.push({ text: text, token: token || "", until: Date.now() + 20000 });
    if (bag.length > 8) bag.shift();
  }

  function isOurSend(chatId, token, text) {
    var stale = inflight[chatId];
    if (stale && Date.now() > stale.until) delete inflight[chatId];
    var record = rowFor(chatId) || {};
    // Tokens are the strong signal. The text covers the short window between
    // typing the reply and WhatsApp reporting its id, during which the echo
    // arrives with no token this page knows yet.
    if (isStandinEcho(token, text, record.tokens || [], inflight[chatId], Date.now())) {
      return true;
    }
    var now = Date.now();
    var bag = recentSends[chatId] || [];
    for (var i = 0; i < bag.length; i++) {
      if (now > bag[i].until) continue;
      if (token && bag[i].token && token === bag[i].token) return true;
    }
    return false;
  }

  // WhatsApp emits a message twice when its type settles, so one picture could
  // otherwise be answered twice once the first reply is already out. A queued
  // marker suppresses the duplicate event while the answer is being written; a
  // final marker, only after a real outcome, keeps the message closed.
  function rememberAnswered(chatId, msgs, ttlMs, final) {
    var bag = answered[chatId] || (answered[chatId] = []);
    var until = Date.now() + (ttlMs || 600000);
    (msgs || []).forEach(function (msg) {
      if (!msg || (!msg.id && !msg.msg_token)) return;
      bag.push({ id: msg.id || "", token: msg.msg_token || "", until: until, final: !!final });
    });
    if (bag.length > 60) bag.splice(0, bag.length - 60);
  }

  function forgetAnswered(chatId, msgs) {
    var bag = answered[chatId] || [];
    (msgs || []).forEach(function (msg) {
      if (!msg) return;
      for (var i = bag.length - 1; i >= 0; i--) {
        if (bag[i].final) continue;
        if ((msg.id && bag[i].id === msg.id) || (msg.msg_token && bag[i].token === msg.msg_token)) {
          bag.splice(i, 1);
        }
      }
    });
  }

  function alreadyAnswered(chatId, msg, finalOnly) {
    var bag = answered[chatId] || [];
    var now = Date.now();
    for (var i = 0; i < bag.length; i++) {
      if (now > bag[i].until) continue;
      if (finalOnly && !bag[i].final) continue;
      if (bag[i].id && bag[i].id === msg.id) return true;
      if (bag[i].token && msg.msg_token && bag[i].token === msg.msg_token) return true;
    }
    return false;
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
    if (/^[0-9A-Za-z]{16,80}$/.test(value)) return value;
    return "";
  }

  function applySnapshot(snapshot) {
    if (!snapshot) return;
    prefs.enabled = !!snapshot.enabled;
    prefs.delay_secs = snapshot.delay_secs || prefs.delay_secs;
    prefs.voice = !!snapshot.voice;
    prefs.backend = snapshot.backend || prefs.backend;
    privacyAck = !!snapshot.privacy_ack;
    var next = {};
    (snapshot.chats || []).forEach(function (chat) {
      if (!chat || !chat.id) return;
      next[chat.id] = chat;
      (chat.aliases || []).forEach(function (alias) { next[alias] = chat; });
    });
    chats = next;
    if (!prefs.enabled) {
      Object.keys(timers).forEach(function (id) { clearTimeout(timers[id]); });
      timers = {};
      pending = {};
      batchStart = {};
    }
    paint();
  }

  function refresh() {
    return invoke("autoreply_state").then(applySnapshot).catch(function () {});
  }

  root.__whatrustStandinPrefs = function (next) {
    if (!next) return;
    prefs.enabled = !!next.enabled;
    prefs.delay_secs = next.delay_secs || 10;
    prefs.voice = !!next.voice;
    prefs.backend = next.backend || prefs.backend;
    if (!prefs.enabled) {
      Object.keys(timers).forEach(function (id) { clearTimeout(timers[id]); });
      timers = {};
      pending = {};
      batchStart = {};
    }
    paint();
  };

  function activeChat() {
    var wpp = root.WPP;
    if (!wpp || !wpp.chat || typeof wpp.chat.getActiveChat !== "function") return null;
    try {
      var chat = wpp.chat.getActiveChat();
      if (!chat || typeof chat.then === "function") return null;
      var id = normalizeChatId(widText(chat.id));
      if (!isDirectId(id) || isMine(id) || blockedChat(chat)) return null;
      var name = chat.formattedTitle || chat.name || chat.contact && (chat.contact.pushname || chat.contact.name) || id;
      return { id: id, name: String(name).slice(0, 160), chat: chat };
    } catch (e) {
      return null;
    }
  }

  function rowFor(id) {
    return chats[id] || null;
  }

  function statusOf(id) {
    var row = rowFor(id);
    return row && row.status || "off";
  }

  function ensureHost() {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute("data-whatrust-standin", "1");
    shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = ":host{all:initial}button{font:13px/1.2 system-ui} .pill{border:0;border-radius:999px;padding:6px 10px;cursor:pointer;background:#1daa61;color:#042;white-space:nowrap}";
    shadow.appendChild(style);
    host.addEventListener("click", function (event) { event.stopPropagation(); });
  }

  function panelTheme() {
    var sample = document.querySelector("#main header") || document.body;
    var color = "";
    try { color = sample ? getComputedStyle(sample).backgroundColor || "" : ""; } catch (e) {}
    var rgb = String(color).match(/[\d.]+/g);
    if (!rgb || rgb.length < 3) {
      return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    var lum = 0.2126 * +rgb[0] + 0.7152 * +rgb[1] + 0.0722 * +rgb[2];
    return lum > 150 ? "light" : "dark";
  }

  function backendLabel(id) {
    if (id === "claude_cli") return "Claude";
    if (id === "grok_cli") return "Grok";
    if (id === "codex_cli") return "Codex";
    return "the API";
  }

  function ensurePanel() {
    if (panelHost) return;
    panelHost = document.createElement("div");
    panelHost.setAttribute("data-whatrust-standin-panel", "1");
    panelHost.style.cssText = "position:fixed;z-index:100003;display:none;box-sizing:border-box";
    panelShadow = panelHost.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = [
      ":host{all:initial}",
      ".panel{--bg:#fff;--fg:#111b21;--muted:#667781;--line:rgba(17,27,33,.1);--field:#f3f5f6;--hover:rgba(17,27,33,.06);--accent:#0b8f5a;--on:#fff;--shadow:0 18px 48px rgba(17,27,33,.16);box-sizing:border-box;width:100%;max-height:min(520px,calc(100vh - 88px));overflow:auto;padding:16px;border:1px solid var(--line);border-radius:18px;background:var(--bg);color:var(--fg);box-shadow:var(--shadow);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color-scheme:light}",
      ".panel[data-theme=dark]{--bg:#1e2a30;--fg:#e9edef;--muted:#8b9da6;--line:rgba(255,255,255,.08);--field:#2a3942;--hover:rgba(255,255,255,.07);--accent:#1daa61;--on:#042;--shadow:0 18px 50px rgba(0,0,0,.46);color-scheme:dark}",
      "button,textarea{font:inherit;color:inherit}",
      ".head{display:flex;align-items:flex-start;gap:12px}",
      ".titles{min-width:0;flex:1}",
      ".title{font-size:15px;font-weight:600;letter-spacing:-.015em}",
      ".sub{display:flex;align-items:center;gap:6px;margin-top:3px;color:var(--muted);font-size:12px}",
      ".dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}",
      ".dot[data-state=armed]{background:var(--accent)}",
      ".dot[data-state=paused]{background:#e3a008}",
      ".close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin-block-start:-4px;margin-inline-end:-4px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer}",
      ".close:hover{background:var(--hover);color:var(--fg)}",
      ".close:focus-visible,.btn:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
      ".hint{margin-top:14px;padding:10px 12px;border-radius:12px;background:var(--field);color:var(--muted);font-size:12px}",
      ".row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}",
      ".btn{border:0;border-radius:10px;padding:8px 12px;background:var(--field);color:var(--fg);font-weight:600;cursor:pointer}",
      ".btn:hover{background:var(--hover)}",
      ".btn.primary{background:var(--accent);color:var(--on)}",
      ".btn.primary:hover{filter:brightness(1.06)}",
      ".btn.ghost{background:transparent;color:var(--muted);font-weight:550}",
      ".btn.ghost:hover{background:var(--hover);color:var(--fg)}",
      ".btn:disabled{opacity:.4;cursor:default;filter:none}",
      ".field{display:block;margin-top:16px}",
      ".field span{display:block;margin-bottom:6px;color:var(--muted);font-size:12px;font-weight:600}",
      "textarea{width:100%;min-height:108px;resize:vertical;box-sizing:border-box;border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--field);color:var(--fg)}",
      "textarea::placeholder{color:var(--muted)}",
      ".foot{margin-top:10px}",
      ".foot .primary{margin-inline-end:auto}",
      ".confirm{margin-top:12px;padding:12px;border-radius:12px;background:var(--field)}",
      ".confirm p{margin:0;font-size:12.5px}",
      ".confirm .btn{margin-top:10px}"
    ].join("");
    panelShadow.appendChild(style);
    panelHost.addEventListener("mousedown", function (event) { event.stopPropagation(); });
    panelHost.addEventListener("click", function (event) { event.stopPropagation(); });
    document.documentElement.appendChild(panelHost);
    if (!ensurePanel.bound) {
      ensurePanel.bound = true;
      document.addEventListener("mousedown", function (event) {
        if (!open || !panelHost || panelHost.style.display === "none") return;
        var target = event.target;
        if (target && host && (target === host || (host.contains && host.contains(target)))) return;
        if (target && (target === panelHost || (panelHost.contains && panelHost.contains(target)))) return;
        open = false;
        paint(true);
      }, true);
      window.addEventListener("keydown", function (event) {
        if (!open || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        open = false;
        paint(true);
      }, true);
    }
  }

  function hideStandin() {
    if (host && host.parentNode) host.remove();
    if (panelHost) panelHost.style.display = "none";
  }

  // Sit in the header's own row, immediately before the video call, so the
  // name and the menu keep their space. A fixed corner would cover the menu.
  function headerSlot(button) {
    var point = button;
    var el = button;
    while (el && el.parentElement) {
      var parent = el.parentElement;
      if (parent === document.body || parent === document.documentElement) break;
      var style;
      try { style = getComputedStyle(parent); } catch (e) { break; }
      var row = style.display === "flex" || style.display === "inline-flex";
      var dir = style.flexDirection || "row";
      if (row && dir.indexOf("column") !== 0) {
        var controls = 0;
        for (var i = 0; i < parent.children.length; i++) {
          var child = parent.children[i];
          if (child === host) continue;
          if (child.matches && child.matches("button,[role=button]")) controls++;
          else if (child.querySelector && child.querySelector("button,[role=button],[data-icon]")) controls++;
        }
        if (controls >= 2) return el;
      }
      if (String(parent.tagName || "").toLowerCase() === "header") break;
      el = parent;
    }
    return point;
  }

  function rightClusterButton(doc) {
    var header = doc.querySelector("#main header");
    if (!header || typeof header.getBoundingClientRect !== "function") return null;
    var box = header.getBoundingClientRect();
    if (box.width < 160) return null;
    var buttons = listed(header, "button,[role=button]");
    var best = null;
    var bestLeft = Infinity;
    var limit = box.left + box.width * 0.55;
    for (var i = 0; i < buttons.length; i++) {
      var el = buttons[i];
      if (typeof el.closest === "function" && el.closest("[data-whatrust-standin]")) continue;
      if (typeof el.getBoundingClientRect !== "function") continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20 || rect.width > 64 || rect.height > 64) continue;
      if (rect.left < limit) continue;
      if (rect.left < bestLeft) {
        best = el;
        bestLeft = rect.left;
      }
    }
    return best;
  }

  function placeHost() {
    // Once the pill is in the header, leave it there. Moving or removing it
    // while a message menu is opening rewrites the header and that menu closes.
    var headerNow = document.querySelector("#main header");
    if (host && headerNow && headerNow.contains && headerNow.contains(host)) return true;
    var slot = videoCallButton(document) || rightClusterButton(document);
    if (!slot || !slot.parentNode) return false;
    var header = document.querySelector("#main header");
    if (!header || (header.contains && !header.contains(slot))) return false;
    var anchor = headerSlot(slot);
    if (!anchor || !anchor.parentNode || (anchor.contains && anchor.contains(host))) return false;
    if (host.parentNode !== anchor.parentNode || host.nextElementSibling !== anchor) {
      anchor.parentNode.insertBefore(host, anchor);
    }
    if (host.getAttribute("style") !== HOST_STYLE) host.setAttribute("style", HOST_STYLE);
    return true;
  }

  function syncPanel() {
    if (!open || !panelHost || !shadow) return;
    var pill = shadow.querySelector(".pill");
    if (!pill || !pill.getBoundingClientRect) return;
    var rect = pill.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    var width = Math.min(360, Math.max(240, window.innerWidth - 16));
    var right = window.innerWidth - rect.right;
    if (right < 8) right = 8;
    if (right + width > window.innerWidth - 8) right = Math.max(8, window.innerWidth - 8 - width);
    panelHost.style.display = "block";
    panelHost.style.top = Math.round(rect.bottom + 8) + "px";
    panelHost.style.right = Math.round(right) + "px";
    panelHost.style.width = Math.round(width) + "px";
    panelHost.style.left = "auto";
  }

  function pageBlocked() {
    return (typeof root.__whatrustPageBusy === "function" && root.__whatrustPageBusy()) || Date.now() < menuQuietUntil;
  }

  // A click inside the pill retargets to the host at the document, so a
  // listener has to walk the composed path to see that it was ours.
  function ownStandinEvent(event) {
    var path = event && typeof event.composedPath === "function" ? event.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (!node || typeof node.getAttribute !== "function") continue;
      if (node.getAttribute("data-whatrust-standin") || node.getAttribute("data-whatrust-standin-panel")) return true;
    }
    return false;
  }

  function paint(immediate) {
    if (!open) {
      var stale = panelShadow && panelShadow.querySelector(".panel");
      if (stale) stale.remove();
      if (panelHost) panelHost.style.display = "none";
    }
    var blocked = pageBlocked();
    // Background refreshes wait while a WhatsApp menu is opening, because
    // rewriting the header closes it. The click that opens this panel is
    // itself that gesture, and a header-menu hold lasts half a minute, so a
    // click cannot wait its turn.
    if (blocked && !immediate) return;
    var current = activeChat();
    if (!current) {
      if (!blocked) hideStandin();
      return;
    }
    ensureHost();
    if (blocked) {
      if (!host || !host.parentNode) return;
    } else if (!placeHost()) {
      hideStandin();
      return;
    }
    var status = statusOf(current.id);
    var shown = (prefs.enabled ? "on:" : "off:") + status;
    var label = prefs.enabled && status === "armed"
      ? "Stand-in: On"
      : prefs.enabled && status === "paused"
        ? "Stand-in: Paused"
        : "Stand-in: Off";
    var existing = shadow.querySelector(".pill");
    if (!existing) {
      existing = document.createElement("button");
      existing.className = "pill";
      existing.type = "button";
      existing.addEventListener("click", function () { open = !open; paint(true); });
      shadow.appendChild(existing);
    }
    if (existing.textContent !== label) existing.textContent = label;
    var panel = panelShadow && panelShadow.querySelector(".panel");
    if (!open) {
      if (panel) panel.remove();
      if (panelHost) panelHost.style.display = "none";
      if (!blocked && !immediate) setTimeout(markStandin, 0);
      return;
    }
    ensurePanel();
    panel = panelShadow.querySelector(".panel");
    syncPanel();
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "panel";
      panelShadow.appendChild(panel);
    }
    panel.dataset.theme = panelTheme();
    // After the panel is in the document. The scan walks every message, so a
    // click does not run it; the next refresh does, once the window is up.
    if (!blocked && !immediate) setTimeout(markStandin, 0);
    if (panel.dataset.chat === current.id && panel.dataset.status === shown) return;
    panel.dataset.chat = current.id;
    panel.dataset.status = shown;
    panel.innerHTML = "";
    var head = document.createElement("div");
    head.className = "head";
    var titles = document.createElement("div");
    titles.className = "titles";
    var title = document.createElement("div");
    title.className = "title";
    title.textContent = "Stand-in";
    var sub = document.createElement("div");
    sub.className = "sub";
    var dot = document.createElement("i");
    dot.className = "dot";
    dot.setAttribute("data-state", status === "armed" || status === "paused" ? status : "off");
    var subText = document.createElement("span");
    subText.textContent = !prefs.enabled
      ? "Off in Settings"
      : status === "armed"
        ? "Replying in this chat"
        : status === "paused"
          ? "Paused in this chat"
          : "Off for this chat";
    sub.appendChild(dot);
    sub.appendChild(subText);
    titles.appendChild(title);
    titles.appendChild(sub);
    var close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.setAttribute("aria-label", "Close");
    close.title = "Close";
    close.appendChild(closeGlyph());
    close.addEventListener("click", function () { open = false; paint(true); });
    head.appendChild(titles);
    head.appendChild(close);
    panel.appendChild(head);
    if (!prefs.enabled) {
      var hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Turn on Allow stand-in in Settings before it can reply.";
      panel.appendChild(hint);
    }
    var row = document.createElement("div");
    row.className = "row";
    function button(text, kind, fn) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "btn" + (kind ? " " + kind : "");
      el.textContent = text;
      el.addEventListener("click", fn);
      row.appendChild(el);
    }
    if (status === "armed") {
      button("Pause", "", function () { setChat(current, "pause", false); });
    } else if (status === "paused") {
      button("Resume", "primary", function () { setChat(current, "resume", false); });
      button("Turn off", "ghost", function () { setChat(current, "off", false); });
    } else {
      button("Turn on", "primary", function () { confirmArm(current); });
    }
    panel.appendChild(row);
    var field = document.createElement("label");
    field.className = "field";
    var fieldLabel = document.createElement("span");
    fieldLabel.textContent = "Instructions for this chat";
    var area = document.createElement("textarea");
    area.placeholder = "How to reply to this person";
    area.setAttribute("aria-label", "Instructions for this chat");
    field.appendChild(fieldLabel);
    field.appendChild(area);
    panel.appendChild(field);
    var actions = document.createElement("div");
    actions.className = "row foot";
    function action(text, kind, fn) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "btn" + (kind ? " " + kind : "");
      el.textContent = text;
      el.addEventListener("click", fn);
      actions.appendChild(el);
      return el;
    }
    var save = action("Save", "primary", function () {
      invoke("autoreply_save_chat_doc", { chat_id: current.id, text: area.value })
        .catch(function (error) { showBanner(current.id, docError(error, "Could not save the instructions. Try again.")); });
    });
    action("Open file", "ghost", function () {
      invoke("autoreply_open_chat_doc", { chat_id: current.id })
        .catch(function (error) { showBanner(current.id, docError(error, "Could not open the instructions.")); });
    });
    var reset = action("Reset", "ghost", function () {
      invoke("autoreply_reset_chat_doc", { chat_id: current.id }).then(function (text) {
        area.value = text || "";
      }).catch(function (error) {
        showBanner(current.id, docError(error, "Could not reset the instructions."));
      });
    });
    // Saving before the file has loaded would replace it with an empty box.
    [save, reset].forEach(function (el) { el.disabled = true; });
    invoke("autoreply_get_chat_doc", { chat_id: current.id }).then(function (text) {
      if (panel.dataset.chat !== current.id) return;
      area.value = text || "";
      [save, reset].forEach(function (el) { el.disabled = false; });
    }).catch(function (error) {
      if (panel.dataset.chat !== current.id) return;
      showBanner(current.id, docError(error, "Could not read the instructions."));
    });
    panel.appendChild(actions);
  }

  function classText(el) {
    if (!el) return "";
    return typeof el.className === "string" ? el.className : "";
  }

  function hasClass(el, name) {
    return (" " + classText(el) + " ").indexOf(" " + name + " ") !== -1;
  }

  function nestedMessage(node, main) {
    var parent = node.parentElement;
    while (parent && parent !== main) {
      if (messageToken(parent.getAttribute && parent.getAttribute("data-id") || "")) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function standinTokens() {
    var known = {};
    Object.keys(chats).forEach(function (id) {
      var list = chats[id] && chats[id].tokens || [];
      for (var i = 0; i < list.length; i++) if (list[i]) known[list[i]] = true;
    });
    var now = Date.now();
    Object.keys(recentSends).forEach(function (id) {
      var bag = recentSends[id] || [];
      for (var i = 0; i < bag.length; i++) {
        if (bag[i].token && now <= bag[i].until) known[bag[i].token] = true;
      }
    });
    return known;
  }

  function sentByStandin(row, token, known) {
    if (!token || !known[token]) return false;
    var cur = row;
    for (var i = 0; cur && i < 8; i++) {
      if (hasClass(cur, "message-in")) return false;
      if (hasClass(cur, "message-out")) return true;
      cur = cur.parentElement;
    }
    var id = row.getAttribute("data-id") || "";
    return id.indexOf("false_") !== 0;
  }

  function markHost(row) {
    var cur = row;
    for (var i = 0; cur && i < 8; i++) {
      if (hasClass(cur, "message-out")) return cur;
      cur = cur.parentElement;
    }
    return row;
  }

  function aiMark() {
    var mark = document.createElement("span");
    mark.setAttribute("data-wr-standin-mark", "1");
    mark.title = "Sent by the stand-in";
    mark.setAttribute("aria-label", "Sent by the stand-in");
    mark.style.cssText = "flex:none;align-self:flex-end;display:inline-flex;align-items:center;justify-content:center;height:14px;margin-block-end:3px;margin-inline-end:6px;padding:0 3px;border:1px solid #1daa61;border-radius:4px;color:#1daa61;background:transparent;font:600 9px/14px system-ui;letter-spacing:.02em;user-select:none;pointer-events:none";
    mark.textContent = "AI";
    return mark;
  }

  // The token list is the record of what this app sent. The mark sits beside
  // the bubble, in the row's own layout, so it does not cover the words.
  function markStandin() {
    if (Date.now() < menuQuietUntil) return;
    var main = document.getElementById("main");
    if (!main || !main.querySelectorAll) return;
    var known = standinTokens();
    var rows = main.querySelectorAll("[data-id]");
    var seen = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (nestedMessage(row, main)) continue;
      var token = messageToken(row.getAttribute("data-id") || "");
      if (!sentByStandin(row, token, known)) continue;
      var host = markHost(row);
      var mark = null;
      var kids = host.children || [];
      for (var k = 0; k < kids.length; k++) {
        if (kids[k].getAttribute && kids[k].getAttribute("data-wr-standin-mark")) mark = kids[k];
      }
      if (!mark) mark = aiMark();
      if (mark.parentNode !== host || host.firstElementChild !== mark) host.insertBefore(mark, host.firstChild);
      seen.push(mark);
    }
    var marks = main.querySelectorAll("[data-wr-standin-mark]");
    for (var j = 0; j < marks.length; j++) {
      if (seen.indexOf(marks[j]) === -1 && marks[j].parentNode) marks[j].parentNode.removeChild(marks[j]);
    }
  }

  function confirmArm(current) {
    if (privacyAck) {
      setChat(current, "arm", false);
      return;
    }
    ensureHost();
    ensurePanel();
    var panel = panelShadow.querySelector(".panel");
    if (!panel) {
      open = true;
      paint(true);
      panel = panelShadow && panelShadow.querySelector(".panel");
    }
    if (!panel) return;
    var note = document.createElement("div");
    note.className = "confirm";
    var copy = document.createElement("p");
    copy.textContent = "Messages in this chat will be sent to " + backendLabel(prefs.backend) + ".";
    var yes = document.createElement("button");
    yes.type = "button";
    yes.className = "btn primary";
    yes.textContent = "Continue";
    yes.addEventListener("click", function () { setChat(current, "arm", true); });
    var old = panel.querySelector(".confirm");
    if (old) old.remove();
    note.appendChild(copy);
    note.appendChild(yes);
    var actions = panel.querySelector(".row");
    if (actions && actions.nextSibling) panel.insertBefore(note, actions.nextSibling);
    else panel.appendChild(note);
  }

  function closeGlyph() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("d", "M4 4l8 8M12 4L4 12");
    svg.appendChild(path);
    return svg;
  }

  function relatedIds(chat) {
    var found = [];
    function add(value) {
      var id = normalizeChatId(widText(value));
      if (isDirectId(id) && found.indexOf(id) === -1) found.push(id);
    }
    if (!chat) return found;
    add(chat.id);
    add(chat.lid);
    add(chat.phoneNumber);
    if (chat.contact) {
      add(chat.contact.id);
      add(chat.contact.phoneNumber);
      add(chat.contact.lid);
    }
    return found;
  }

  function setChat(current, action, ack) {
    invoke("autoreply_set_chat", {
      chat_id: current.id,
      chat_name: current.name,
      aliases: relatedIds(current.chat).filter(function (id) { return id !== current.id; }),
      action: action,
      ack_privacy: !!ack,
    }).then(function (snapshot) {
      applySnapshot(snapshot);
      open = true;
      paint(true);
    }).catch(function (error) {
      showBanner(current.id, docError(error, "Could not change the stand-in. Try again."));
    });
  }

  function docError(error, fallback) {
    var text = typeof error === "string" ? error : String(error || "");
    invoke("dlog", { msg: ("stand-in: " + text).slice(0, 240) }).catch(function () {});
    if (text === "locked") return "Unlock whatRust to change the stand-in.";
    if (text && text !== "[object Object]" && text.length <= 200) return text;
    return fallback;
  }

  function showBanner(chatId, text) {
    if (!bannerHost) {
      bannerHost = document.createElement("div");
      bannerHost.style.cssText = "position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:100004;background:#111b21;color:#e9edef;padding:12px;border-radius:12px;max-width:420px;overflow-wrap:anywhere";
      document.documentElement.appendChild(bannerHost);
    }
    bannerHost.innerHTML = "";
    var line = document.createElement("div");
    line.textContent = text;
    var openChat = document.createElement("button");
    openChat.type = "button";
    openChat.textContent = "Open chat";
    openChat.addEventListener("click", function () {
      var wpp = root.WPP;
      if (wpp && wpp.chat && typeof wpp.chat.openChatBottom === "function") {
        Promise.resolve(wpp.chat.openChatBottom(chatId)).catch(function () {});
      }
      if (bannerTimer) clearTimeout(bannerTimer);
      bannerTimer = null;
      bannerHost.style.display = "none";
    });
    bannerHost.appendChild(line);
    bannerHost.appendChild(openChat);
    bannerHost.style.display = "block";
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () {
      bannerTimer = null;
      bannerHost.style.display = "none";
    }, 30000);
  }

  function mapMessage(msg) {    var id = typeof msg.id === "string" ? msg.id : widText(msg.id);
    var at = Number(msg.t || msg.timestamp || 0);
    if (at > 0 && at < 1e12) at *= 1000;
    var type = msg.type || "";
    var text = msg.body || msg.caption || "";
    // A media message's body is its caption, and the reply often depends on the
    // picture itself, so say so instead of letting the model read the caption
    // as the whole message.
    if (/image|video|document|sticker/.test(type)) {
      var caption = String(msg.body || msg.caption || "").trim();
      text = caption ? "[" + type + "] " + caption : "[" + type + "]";
    }
    var quoted = "";
    try {
      if (msg.quotedMsg) quoted = msg.quotedMsg.body || msg.quotedMsg.caption || "";
    } catch (e) {}
    return {
      id: id,
      msg_token: messageToken(id),
      from_me: !!(msg.id && msg.id.fromMe) || String(id).indexOf("true_") === 0,
      timestamp_ms: at,
      quoted_snippet: String(quoted).slice(0, 240),
      kind: type || "text",
      text: String(text || "").slice(0, 2000),
    };
  }

  function loadRecent(chatId) {
    var wpp = root.WPP;
    if (!wpp || !wpp.chat || typeof wpp.chat.getMessages !== "function") return Promise.resolve([]);
    return Promise.resolve(wpp.chat.getMessages(chatId, { count: 25 })).then(function (list) {
      return (list || []).map(mapMessage).filter(function (msg) { return msg.id; })
        .sort(function (a, b) { return a.timestamp_ms - b.timestamp_ms; });
    }).catch(function () { return []; });
  }

  function pageOlder(chatId) {
    var have = history[chatId] || [];
    if (have.length >= HISTORY_CAP) return Promise.resolve(have);
    var wpp = root.WPP;
    var oldest = have[0] && have[0].id;
    if (!wpp || !wpp.chat || typeof wpp.chat.getMessages !== "function") return Promise.resolve(have);
    var args = { count: 100, direction: "before" };
    if (oldest) args.id = oldest;
    return Promise.resolve(wpp.chat.getMessages(chatId, args)).then(function (list) {
      var mapped = (list || []).map(mapMessage).filter(function (msg) { return msg.id; });
      var seen = {};
      have.forEach(function (msg) { seen[msg.id] = true; });
      var merged = mapped.filter(function (msg) { return !seen[msg.id]; }).concat(have);
      merged.sort(function (a, b) { return a.timestamp_ms - b.timestamp_ms; });
      if (merged.length > HISTORY_CAP) merged = merged.slice(merged.length - HISTORY_CAP);
      history[chatId] = merged;
      return merged;
    }).catch(function () { return have; });
  }

  function waitVoice(messages) {
    if (!prefs.voice) return Promise.resolve(messages);
    var voice = messages.filter(function (msg) {
      return !msg.from_me && /ptt|audio|voice/.test(msg.kind) && !msg.text;
    });
    if (!voice.length) return Promise.resolve(messages);
    var deadline = Date.now() + 45000;
    function poll(msg) {
      if (Date.now() > deadline) return Promise.resolve();
      return invoke("voice_lookup", { id: msg.id }).then(function (view) {
        if (view && view.status === "ready" && view.text) {
          msg.text = view.text;
          return;
        }
        if (view && view.status === "disabled") return;
        return new Promise(function (resolve) {
          setTimeout(function () { poll(msg).then(resolve); }, 1500);
        });
      }).catch(function () {});
    }
    return Promise.all(voice.map(poll)).then(function () { return messages; });
  }

  function sendText(chatId, step) {
    var wpp = root.WPP;
    if (!wpp || !wpp.chat || typeof wpp.chat.sendTextMessage !== "function") return Promise.resolve();
    if (statusOf(chatId) !== "armed") return Promise.resolve();
    var wait = Math.max(1500, Math.min(4000, String(step.text || "").length * 25));
    inflight[chatId] = { text: step.text, until: Date.now() + 20000, turn_id: step.turn_id };
    if (typeof wpp.chat.markIsComposing === "function") {
      Promise.resolve(wpp.chat.markIsComposing(chatId, wait)).catch(function () {});
    }
    return new Promise(function (resolve) {
      setTimeout(function () {
        invoke("autoreply_state").then(applySnapshot).catch(function () {}).then(function () {
          if (!prefs.enabled || statusOf(chatId) !== "armed") {
            resolve();
            return;
          }
          Promise.resolve(wpp.chat.sendTextMessage(chatId, step.text, { createChat: false })).then(function (sent) {
            var id = sent && (typeof sent.id === "string" ? sent.id : widText(sent.id));
            var token = messageToken(id);
            rememberSend(chatId, step.text, token);
            return invoke("autoreply_record_sent", {
              chat_id: chatId,
              turn_id: step.turn_id || "",
              msg_token: token,
              text: step.text,
            });
          }).catch(function () {}).then(function () {
            refresh().then(resolve);
          });
        });
      }, wait);
    });
  }

  function runTool(chatId, step) {
    if (step.name === "get_earlier_messages") {
      return pageOlder(chatId).then(function (list) {
        var count = Math.max(1, Math.min(25, step.count || 15));
        var end = list.length;
        if (step.before_id) {
          var at = -1;
          for (var i = 0; i < list.length; i++) if (list[i].id === step.before_id) at = i;
          if (at >= 0) end = at;
        }
        return list.slice(Math.max(0, end - count), end).map(function (msg) {
          return (msg.from_me ? "me" : "them") + ": " + msg.text;
        }).join("\n");
      });
    }
    return pageOlder(chatId).then(function () { return pageOlder(chatId); }).then(function (list) {
      var hits = searchMessages(list, step.query || "", step.limit || 5);
      if (!hits.length && list.length < HISTORY_CAP) {
        return pageOlder(chatId).then(function (more) {
          return searchMessages(more, step.query || "", step.limit || 5);
        });
      }
      return hits;
    }).then(function (hits) {
      return hits.map(function (hit) {
        return hit.around.map(function (msg) {
          return (msg.from_me ? "me" : "them") + ": " + msg.text;
        }).join("\n");
      }).join("\n---\n");
    });
  }

  function turn(chatId, name, pendingMsgs, round, exchanges) {
    if (busy[chatId] && round === 0) return Promise.resolve();
    busy[chatId] = true;
    return loadRecent(chatId).then(function (loaded) {
      var messages = loaded.slice();
      // Keep anything an earlier search round already paged in, so a second
      // search does not start over from the newest 25 and re-fetch the same
      // pages.
      (history[chatId] || []).forEach(function (have) {
        if (!messages.some(function (msg) { return sameMessage(msg, have); })) messages.push(have);
      });
      (pendingMsgs || []).forEach(function (msg) {
        if (!messages.some(function (have) { return sameMessage(have, msg); })) messages.push(msg);
      });
      messages.sort(function (a, b) { return a.timestamp_ms - b.timestamp_ms; });
      if (messages.length > HISTORY_CAP) messages = messages.slice(messages.length - HISTORY_CAP);
      history[chatId] = messages.slice();
      var incomingIds = [];
      var incoming = [];
      messages.forEach(function (have) {
        if ((pendingMsgs || []).some(function (msg) { return sameMessage(have, msg); })) {
          incomingIds.push(have.id);
          incoming.push(have);
        }
      });
      if (!round && !incomingIds.length) return { messages: messages, incomingIds: incomingIds, skip: true };
      return waitVoice(incoming).then(function () {
        return { messages: messages, incomingIds: incomingIds };
      });
    }).then(function (ready) {
      if (ready.skip) {
        forgetAnswered(chatId, pendingMsgs);
        return refresh();
      }
      return invoke("autoreply_turn", {
        chat_id: chatId,
        chat_name: name,
        messages: ready.messages,
        incoming_ids: ready.incomingIds,
        exchanges: exchanges || [],
        round: round || 0,
      });
    }).then(function (step) {
      if (!step || step.kind === "idle") return refresh();
      if (step.kind === "tool" && round < 3) {
        return runTool(chatId, step).then(function (text) {
          var next = (exchanges || []).slice();
          next.push({ role: "assistant", content: JSON.stringify(step) });
          // Rust frames this in <search_results> when it rebuilds the prompt.
          next.push({ role: "user", content: String(text || "").slice(0, 8000) });
          return turn(chatId, name, pendingMsgs, round + 1, next);
        });
      }
      if (step.kind === "send") {
        // A sent reply is final; remember it for the rest of the session so a
        // late duplicate event cannot reopen the same message.
        rememberAnswered(chatId, pendingMsgs, 600000, true);
        return sendText(chatId, step);
      }
      if (step.kind === "skip" || step.kind === "paused") {
        rememberAnswered(chatId, pendingMsgs, 600000, true);
        showBanner(chatId, step.reason || "The stand-in stayed quiet.");
        return refresh();
      }
      // Idle or an unexpected step: allow the message to be retried.
      forgetAnswered(chatId, pendingMsgs);
      return refresh();
    }).catch(function () {
      forgetAnswered(chatId, pendingMsgs);
      return refresh();
    }).then(function () { busy[chatId] = false; });
  }

  function schedule(chatId, name, msg) {
    if (!prefs.enabled || statusOf(chatId) !== "armed") return;
    if (!msg.id && !msg.msg_token) return;
    if (alreadyAnswered(chatId, msg)) return;
    // The event only fires for a new message, so a missing timestamp means the
    // field has not settled yet; treat it as now instead of dropping the reply.
    if (!(msg.timestamp_ms > 0)) msg.timestamp_ms = Date.now();
    var armed = (rowFor(chatId) || {}).armed_at_ms || 0;
    if (!armed || !isFresh(msg.timestamp_ms, armed, Date.now())) return;
    // Recorded now, so the second event WhatsApp emits for the same message
    // cannot queue a second answer while the first one is still being written.
    rememberAnswered(chatId, [msg], 120000);
    var bag = pending[chatId] || (pending[chatId] = { name: name, msgs: [] });
    if (name) bag.name = name;
    if (!bag.msgs.some(function (have) { return sameMessage(have, msg); })) bag.msgs.push(msg);
    bag.msgs.sort(function (a, b) { return a.timestamp_ms - b.timestamp_ms; });
    if (!batchStart[chatId]) batchStart[chatId] = Date.now();
    if (timers[chatId]) clearTimeout(timers[chatId]);
    var delay = Math.max(5, Math.min(60, prefs.delay_secs || 10)) * 1000;
    if (Date.now() - batchStart[chatId] > MAX_BATCH_MS) delay = 0;
    timers[chatId] = setTimeout(function () { fire(chatId); }, delay);
  }

  function fire(chatId) {
    delete timers[chatId];
    var bag = pending[chatId];
    if (!bag || !bag.msgs.length) return;
    if (busy[chatId]) {
      timers[chatId] = setTimeout(function () { fire(chatId); }, 2000);
      return;
    }
    // Drop anything the turn already answered while this batch waited.
    var msgs = bag.msgs
      .filter(function (msg) { return !alreadyAnswered(chatId, msg, true); })
      .slice(-25);
    delete pending[chatId];
    delete batchStart[chatId];
    if (!msgs.length) return;
    turn(chatId, bag.name, msgs, 0, []);
  }

  function onMessage(msg) {
    if (msg && blockedChat(msg.chat)) return;
    var mapped = mapMessage(msg || {});
    var chatId = messageChatId(msg);
    if (!isDirectId(chatId) || isMine(chatId)) return;
    var name = "";
    var current = activeChat();
    if (current && (current.id === chatId || relatedIds(current.chat).indexOf(chatId) !== -1)) name = current.name;
    if (mapped.from_me) {
      if (isOurSend(chatId, mapped.msg_token, mapped.text)) return;
      if (statusOf(chatId) !== "armed") return;
      if (timers[chatId]) clearTimeout(timers[chatId]);
      delete timers[chatId];
      delete pending[chatId];
      delete batchStart[chatId];
      invoke("autoreply_pause_self", { chat_id: chatId }).then(applySnapshot).then(function () {
        showBanner(chatId, "The stand-in paused because you replied.");
      }).catch(function () {});
      return;
    }
    schedule(chatId, name, mapped);
  }

  function armWatch() {
    var wpp = root.WPP;
    if (!wpp || !wpp.isReady || typeof wpp.on !== "function") {
      setTimeout(armWatch, 500);
      return;
    }
    if (watching) return;
    watching = true;
    try {
      wpp.on("chat.new_message", onMessage);
    } catch (e) {
      watching = false;
      setTimeout(armWatch, 1000);
    }
  }

  function watchPlacement() {
    if (watchPlacement.started) return;
    if (!document.body) {
      setTimeout(watchPlacement, 200);
      return;
    }
    watchPlacement.started = true;
    var timer = 0;
    function noteMenuGesture(event) {
      if (ownStandinEvent(event)) return;
      var target = event && event.target;
      if (!target || !target.closest || !target.closest("#main")) return;
      menuQuietUntil = Date.now() + 1000;
    }
    document.addEventListener("pointerdown", noteMenuGesture, true);
    document.addEventListener("contextmenu", noteMenuGesture, true);
    var observer = new MutationObserver(function () {
      if (timer) return;
      timer = setTimeout(function () {
        timer = 0;
        if ((typeof root.__whatrustPageBusy === "function" && root.__whatrustPageBusy()) || Date.now() < menuQuietUntil) return;
        markStandin();
        if (!activeChat()) {
          hideStandin();
          return;
        }
        ensureHost();
        if (!placeHost()) {
          if (!host || !host.parentNode) hideStandin();
        } else if (open) syncPanel();
      }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", function () { if (open) syncPanel(); });
  }

  setInterval(paint, 2000);
  watchPlacement();
  refresh().then(armWatch);
})();

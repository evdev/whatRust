/* Detection spike for mention alerts. Not injected yet.
 *
 * Settings copy, under the mention switches in Notifications:
 *   "Does not alert on @everyone" (Portuguese: "Não avisa em @everyone")
 * A group message that only tags everyone stays quiet. A personal @mention
 * in that same message still alerts. A direct chat alerts because it is a
 * direct chat, even if the text says @everyone.
 *
 * What wa-js 4.7.2 (resources/wppconnect-wa.js) actually exposes:
 * - New messages: WPP.on("chat.new_message"). Opening a chat replays older
 *   messages through that event. WPP.isFullReady becomes true only after
 *   conn.main_ready, which is the caught-up point. Subscribe then, and
 *   ignore anything older than that moment.
 * - Self: WPP.conn.getMyUserWid() and getMyUserLid() (the lid call throws
 *   when there is none). A mention may use either id.
 * - Personal mention: mentionedJidList. @all is not a jid. The send path
 *   treats /(?<![\w@.+-])@all\b/ as MENTION_ALL, and that flag's value is 1
 *   (nonJidMentions bit). @everyone is the same kind of tag.
 * - Reply to me: quotedParticipant is me, or the quoted message is from me.
 *   quotedStanzaID alone is not enough. Quote send, later, is
 *   WPP.chat.sendTextMessage(chatId, text, { quotedMsg: msgId }). The
 *   default send options set markIsRead, so that send also marks the chat
 *   read. WPP.chat.markIsRead(chatId) is the explicit form.
 * - Status posts are out of this feature. A status@broadcast chat, an
 *   isStatusV3 message, and any other broadcast stay quiet.
 */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;

  var REPLAY_MS = 120000;
  var SKEW_MS = 15000;
  var READY_SLACK_MS = 5000;
  var SEEN_CAP = 500;
  var SETTINGS_COPY = {
    pt: "Não avisa em @everyone",
    en: "Does not alert on @everyone",
  };
  var SKIP_TYPE = {
    protocol: true,
    ciphertext: true,
    revoked: true,
    notification: true,
    e2e_notification: true,
    gp2: true,
    call_log: true,
  };

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

  function parseId(value) {
    var raw = String(value || "").trim();
    if (!raw || raw.length > 180) return null;
    var compound = /^(?:true|false)_([^_]+@[^_]+)_/.exec(raw);
    if (compound) raw = compound[1];
    var at = raw.lastIndexOf("@");
    if (at <= 0 || at === raw.length - 1) return null;
    var local = raw.slice(0, at);
    var host = raw.slice(at + 1).toLowerCase();
    var colon = local.indexOf(":");
    if (colon > 0) local = local.slice(0, colon);
    if (!local || !host || /[\s_@]/.test(local) || /[\s_@:]/.test(host)) return null;
    return { local: local, host: host, serialized: local + "@" + host };
  }

  function samePerson(a, b) {
    if (!a || !b || a.local !== b.local) return false;
    if (a.host === b.host) return true;
    var phoneA = a.host === "c.us" || a.host === "s.whatsapp.net";
    var phoneB = b.host === "c.us" || b.host === "s.whatsapp.net";
    return phoneA && phoneB;
  }

  function matchesAny(value, selfIds) {
    var id = parseId(widText(value));
    if (!id) return false;
    for (var i = 0; i < selfIds.length; i++) {
      if (samePerson(id, selfIds[i])) return true;
    }
    return false;
  }

  function asList(value) {
    if (!value) return [];
    if (typeof value === "string") return [value];
    if (typeof value.length === "number") {
      var out = [];
      for (var i = 0; i < value.length; i++) out.push(widText(value[i]));
      return out;
    }
    return [widText(value)];
  }

  function selfList(value) {
    var out = [];
    asList(value).forEach(function (item) {
      var id = parseId(item);
      if (id) out.push(id);
    });
    return out;
  }

  function textOf(msg) {
    return String((msg && (msg.body || msg.caption)) || "");
  }

  // @everyone, @all, and nonJidMentions bit 1 (MENTION_ALL) are not personal.
  function mentionsSelf(msg, selfIds, body) {
    var list = asList(msg && msg.mentionedJidList);
    for (var i = 0; i < list.length; i++) {
      if (matchesAny(list[i], selfIds)) return true;
    }
    var found = Object.create(null);
    var re = /(?<![\w@.+-])@(\d{6,})\b/g;
    var match;
    while ((match = re.exec(body))) found[match[1]] = true;
    for (var n = 0; n < selfIds.length; n++) {
      var id = selfIds[n];
      if ((id.host === "c.us" || id.host === "s.whatsapp.net") && found[id.local]) return true;
    }
    return false;
  }

  function quotesSelf(msg, selfIds) {
    if (matchesAny(msg && msg.quotedParticipant, selfIds)) return true;
    var quoted = msg && msg.quotedMsg;
    if (quoted && (quoted.fromMe || (quoted.id && quoted.id.fromMe))) return true;
    var quotedId = quoted ? (typeof quoted.id === "string" ? quoted.id : widText(quoted.id)) : "";
    if (quotedId.indexOf("true_") === 0) return true;
    var key = msg && (typeof msg.quotedMsgId === "string" ? msg.quotedMsgId : widText(msg.quotedMsgId));
    return typeof key === "string" && key.indexOf("true_") === 0;
  }

  function messageId(msg) {
    var id = msg && msg.id;
    if (typeof id === "string") return id;
    return widText(id);
  }

  function fromMe(msg, id) {
    if (msg.id && msg.id.fromMe) return true;
    return id.indexOf("true_") === 0;
  }

  function atMs(msg) {
    var at = Number(msg.t || msg.timestamp || 0);
    if (at > 0 && at < 1e12) at *= 1000;
    return at;
  }

  function isLive(at, readyAt, now) {
    at = Number(at) || 0;
    readyAt = Number(readyAt) || 0;
    now = Number(now) || 0;
    if (!at || !readyAt || !now) return false;
    if (now - at > REPLAY_MS) return false;
    if (at - now > SKEW_MS) return false;
    if (at + READY_SLACK_MS < readyAt) return false;
    return true;
  }

  function chatOf(msg) {
    var id = msg.id;
    var raw = "";
    if (typeof id === "string") {
      var compound = /^(?:true|false)_([^_]+@[^_]+)_/.exec(id);
      if (compound) raw = compound[1];
    }
    if (!raw && id) raw = widText(id.remote);
    if (!raw && msg.chat) raw = widText(msg.chat.id);
    var chat = parseId(raw);
    if (chat) return chat;
    if (fromMe(msg, messageId(msg))) return parseId(widText(msg.to));
    return parseId(widText(msg.from));
  }

  function isStatus(msg, chat) {
    if (msg.isStatusV3) return true;
    if (chat && chat.host === "broadcast" && chat.local === "status") return true;
    var remote = parseId(widText(msg.id && msg.id.remote));
    return !!(remote && remote.host === "broadcast" && remote.local === "status");
  }

  function isGroup(msg, chat) {
    if (msg.isGroupMsg) return true;
    if (msg.chat && (msg.chat.isGroup || msg.chat.groupMetadata)) return true;
    return !!(chat && chat.host === "g.us");
  }

  function isDirect(chat) {
    return !!(chat && (chat.host === "c.us" || chat.host === "lid" || chat.host === "s.whatsapp.net"));
  }

  function senderOf(msg, chat, group) {
    var author = parseId(widText(msg.author));
    var from = parseId(widText(msg.from));
    if (group && author) return author.serialized;
    if (from && (!chat || from.serialized !== chat.serialized)) return from.serialized;
    if (author) return author.serialized;
    return from ? from.serialized : "";
  }

  function classify(msg, ctx) {
    if (!msg) return null;
    ctx = ctx || {};
    var id = messageId(msg);
    if (!id || fromMe(msg, id)) return null;
    var type = String(msg.type || "").toLowerCase();
    if (SKIP_TYPE[type]) return null;
    if (!isLive(atMs(msg), ctx.readyAt, ctx.now)) return null;
    var selfIds = selfList(ctx.selfIds);
    var chat = chatOf(msg);
    if (chat && (chat.host === "newsletter" || chat.host === "broadcast")) return null;
    if (isStatus(msg, chat)) return null;
    var body = textOf(msg);
    var personal = mentionsSelf(msg, selfIds, body);
    var quote = quotesSelf(msg, selfIds);
    var group = isGroup(msg, chat);
    var kind = "";
    if (personal) kind = "mention";
    else if (quote) kind = "quote";
    else if (isDirect(chat) && !group) kind = "direct";
    else return null;
    return {
      kind: kind,
      chatId: chat ? chat.serialized : "",
      senderId: senderOf(msg, chat, group),
      msgId: id,
    };
  }

  function selfIdsFrom(wpp) {
    var conn = wpp && wpp.conn;
    if (!conn) return [];
    var ids = [];
    function push(read) {
      try {
        var text = widText(read());
        if (text) ids.push(text);
      } catch (e) {}
    }
    if (typeof conn.getMyUserWid === "function") push(function () { return conn.getMyUserWid(); });
    if (typeof conn.getMyUserLid === "function") push(function () { return conn.getMyUserLid(); });
    return ids;
  }

  // Subscribe only once the account has caught up. readyAt is that moment,
  // so history replayed before it, and later replays older than two minutes,
  // never classify as live. The same message id is emitted once.
  function attach(wpp, hooks) {
    if (!wpp || typeof wpp.on !== "function" || !hooks) return false;
    if (typeof hooks.now !== "function" || typeof hooks.emit !== "function" || typeof hooks.selfIds !== "function") {
      return false;
    }
    var listening = false;
    function start() {
      if (listening) return;
      listening = true;
      var readyAt = Number(hooks.now()) || 0;
      var seen = Object.create(null);
      var order = [];
      wpp.on("chat.new_message", function (msg) {
        var ids = [];
        try { ids = hooks.selfIds() || []; } catch (e) { ids = []; }
        var hit = classify(msg, { selfIds: ids, readyAt: readyAt, now: hooks.now() });
        if (!hit || seen[hit.msgId]) return;
        seen[hit.msgId] = true;
        order.push(hit.msgId);
        if (order.length > SEEN_CAP) delete seen[order.shift()];
        hooks.emit(hit, msg);
      });
    }
    if (wpp.isFullReady) start();
    else wpp.on("conn.main_ready", start);
    return true;
  }

  function fold(value) {
    return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  // A popup replaces the ordinary notification for that message. A short body
  // only counts when the notification title also names the sender or the chat,
  // so a text like "ok" does not swallow an unrelated alert.
  function shouldSuppress(rows, title, body, now) {
    now = Number(now) || 0;
    var text = fold(body);
    var head = fold(title);
    var kept = [];
    var hit = false;
    for (var i = 0; i < (rows || []).length; i++) {
      var row = rows[i];
      if (!row || Number(row.until) <= now) continue;
      kept.push(row);
      var key = fold(row.key);
      if (!key || text.indexOf(key) === -1) continue;
      var sender = fold(row.sender);
      var chat = fold(row.chat);
      var named = sender.length > 1 && head.indexOf(sender) !== -1;
      var inChat = chat.length > 1 && head.indexOf(chat) !== -1;
      if (key.length >= 8 || named || inChat) hit = true;
    }
    return { rows: kept, hit: hit };
  }

  function displayFrom(msg, hit) {
    var sender = "";
    var chatName = "";
    try { sender = msg.notifyName || (msg.senderObj && (msg.senderObj.pushname || msg.senderObj.name)) || ""; } catch (e) {}
    try {
      chatName = (msg.chat && (msg.chat.formattedTitle || msg.chat.name)) || "";
    } catch (e) {}
    return {
      kind: hit.kind,
      chatId: hit.chatId,
      senderId: hit.senderId,
      msgId: hit.msgId,
      chatName: String(chatName || "").trim().slice(0, 120),
      senderName: String(sender || "").trim().slice(0, 120),
      body: textOf(msg).trim().slice(0, 500),
      at: atMs(msg),
    };
  }

  function stillUnread(chat, msg) {
    if (msg && (msg.type === "revoked" || msg.isRevoked)) return false;
    if (chat && Number(chat.unreadCount) === 0) return false;
    return true;
  }

  if (root.__WHATRUST_TEST) {
    root.__whatrustMentionApi = {
      classify: classify,
      attach: attach,
      selfIdsFrom: selfIdsFrom,
      shouldSuppress: shouldSuppress,
      displayFrom: displayFrom,
      stillUnread: stillUnread,
      SETTINGS_COPY: SETTINGS_COPY,
      REPLAY_MS: REPLAY_MS,
    };
    return;
  }
  if (!root.location || root.location.origin !== "https://web.whatsapp.com") return;

  var prefs = { popup: false, sound: false };
  var suppressed = [];
  var watching = false;

  function invoke(cmd, args) {
    var tauri = root.__TAURI__;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") return Promise.reject("no_tauri");
    return tauri.core.invoke(cmd, args || {});
  }

  function remember(view) {
    if (!prefs.popup || !view.body) return;
    suppressed.push({
      key: view.body.slice(0, 240),
      sender: view.senderName,
      chat: view.chatName,
      until: Date.now() + 8000,
    });
    if (suppressed.length > 30) suppressed.shift();
  }

  root.__whatrustMentionSuppress = function (title, body) {
    var next = shouldSuppress(suppressed, title, body, Date.now());
    suppressed = next.rows;
    return next.hit;
  };

  root.__whatrustMentionChime = function () {
    var url = root.__MENTION_CHIME;
    if (!url || typeof root.Audio !== "function") return;
    try {
      var audio = new root.Audio(url);
      var play = audio.play();
      if (play && play.catch) play.catch(function () {});
    } catch (e) {}
  };

  root.__whatrustMentionSend = function (chatId, msgId, text, popupLabel, kind) {
    function finish(ok, error) {
      invoke("mention_sent", { label: popupLabel, ok: ok, error: error || "" }).catch(function () {});
    }
    var wpp = root.WPP;
    if (!wpp || !wpp.chat) {
      finish(false, "O WhatsApp ainda está abrindo. Tente de novo.");
      return;
    }
    var send;
    if (kind === "file" || kind === "voice") {
      if (typeof wpp.chat.sendFileMessage !== "function") {
        finish(false, "O WhatsApp ainda está abrindo. Tente de novo.");
        return;
      }
      send = invoke("mention_media", { label: popupLabel }).then(function (media) {
        var binary = atob(media.data || "");
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        var type = media.mime || (kind === "voice" ? "audio/webm" : "application/octet-stream");
        var blob = new Blob([bytes], { type: type });
        var file = new File([blob], media.filename || (kind === "voice" ? "voice.webm" : "file"), { type: type });
        var options = {
          quotedMsg: msgId,
          markIsRead: true,
          createChat: false,
          filename: file.name,
          mimetype: type,
        };
        if (kind === "voice") {
          options.type = "audio";
          options.isPtt = true;
        } else if (text) {
          options.caption = text;
        }
        return wpp.chat.sendFileMessage(chatId, file, options);
      });
    } else {
      if (typeof wpp.chat.sendTextMessage !== "function") {
        finish(false, "O WhatsApp ainda está abrindo. Tente de novo.");
        return;
      }
      send = Promise.resolve(wpp.chat.sendTextMessage(chatId, text, {
        quotedMsg: msgId,
        markIsRead: true,
        createChat: false,
      }));
    }
    Promise.resolve(send).then(function () { finish(true, ""); }, function () { finish(false, "Não foi possível enviar."); });
  };

  root.__whatrustMentionOpen = function (chatId) {
    var wpp = root.WPP;
    if (!wpp || !wpp.chat || typeof wpp.chat.openChatBottom !== "function") return;
    Promise.resolve(wpp.chat.openChatBottom(chatId)).catch(function () {});
  };

  function ensureWatch() {
    if (watching) return;
    var wpp = root.WPP;
    if (!wpp || typeof wpp.on !== "function") {
      setTimeout(ensureWatch, 500);
      return;
    }
    watching = attach(wpp, {
      now: function () { return Date.now(); },
      selfIds: function () { return selfIdsFrom(wpp); },
      emit: function (hit, msg) {
        if (!prefs.popup && !prefs.sound) return;
        var view = displayFrom(msg || {}, hit);
        remember(view);
        invoke("mention_event", {
          chatId: view.chatId,
          msgId: view.msgId,
          senderId: view.senderId,
          chatName: view.chatName,
          senderName: view.senderName,
          body: view.body,
          atMs: view.at,
          kind: view.kind,
        }).catch(function () {});
      },
    });
    // A visible popup stays while this chat is on screen. A revoked message
    // does not. Read-on-the-phone is checked only for alerts parked by the lock.
    if (watching && !ensureWatch.settled) {
      ensureWatch.settled = true;
      try {
        wpp.on("chat.msg_revoke", function (payload) {
          var id = payload && (payload.refId || payload.id);
          var text = typeof id === "string" ? id : widText(id);
          if (!text) return;
          invoke("mention_settled", { chatId: "", msgId: text }).catch(function () {});
        });
      } catch (e) {
        ensureWatch.settled = false;
      }
    }
    if (!watching) setTimeout(ensureWatch, 500);
  }

  root.__whatrustMentionFilter = function (token, rows) {
    var dropIds = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var row = rows[i] || {};
      if (!lookupUnread(row.chatId, row.msgId)) dropIds.push(String(row.msgId || ""));
    }
    invoke("mention_filter", { token: token, dropIds: dropIds }).catch(function () {});
  };

  function lookupUnread(chatId, msgId) {
    var wpp = root.WPP;
    var chat = null;
    var msg = null;
    try {
      if (wpp && wpp.chat && typeof wpp.chat.get === "function") {
        chat = wpp.chat.get(chatId);
        if (chat && typeof chat.then === "function") chat = null;
      }
      if (chat && chat.msgs && typeof chat.msgs.get === "function") msg = chat.msgs.get(msgId);
    } catch (e) {}
    return stillUnread(chat, msg);
  }

  root.__whatrustMentionPrefs = function (next) {
    prefs.popup = !!(next && next.popup);
    prefs.sound = !!(next && next.sound);
    if (prefs.popup || prefs.sound) ensureWatch();
  };
  if (root.__WHATRUST_MENTION) root.__whatrustMentionPrefs(root.__WHATRUST_MENTION);
})();

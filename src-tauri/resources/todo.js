/* Per-account to-do list inside web.whatsapp.com.
 *
 * The button sits under the account switcher, in the same rail cell, so it
 * cannot land beside it. Messages are captured from the message menu, and a
 * summarized voice card can add that summary as a task while keeping the
 * link to the voice message. The actions are drawn beside that menu, never
 * inside it: writing into the menu, or opening another popover, makes
 * WhatsApp close it immediately on some accounts. While the menu is open,
 * the other page scripts leave the document alone. The panel is an overlay:
 * WhatsApp's own nodes stay in the DOM.
 */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  if (!root.location || root.location.origin !== "https://web.whatsapp.com") return;

  var DAY = 86400000;
  var CHEVRON_ICON = /chevron|down-context|keyboard-arrow-down|menu-down|context-menu|msg-options/;
  var CHEVRON_LABEL = /context menu|menu de contexto|op[cç][oõ]es da mensagem|message options|mais op[cç][oõ]es/;

  function L(pt, en) {
    return root.__WR_LANG === "en" ? en : pt;
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

  function chatFromId(id) {
    var match = /^(?:true|false)_([^_]+@[^_]+)_/.exec(id || "");
    return match ? match[1] : "";
  }

  // WhatsApp Web now puts only the message id on the row. The chat is the open
  // conversation. A device suffix (`1555:14@lid`) is the same chat as `1555@lid`.
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
    if (!local || !host) return "";
    if (/[\s_@]/.test(local) || /[\s_@:]/.test(host)) return "";
    if (host === "broadcast") return "";
    return local + "@" + host;
  }

  function chatForMark(messageChat, activeChat) {
    return normalizeChatId(messageChat) || normalizeChatId(activeChat) || "";
  }

  function parsePlain(value) {
    var text = String(value || "").replace(/[\u200e\u200f\u200b\u2066-\u2069]/g, "");
    var match = /^\[(\d{1,2}:\d{2}(?:\s*[AP]M)?)[,\s]+([^\]]+)\]\s*([^:\n]{0,160})/.exec(text);
    if (!match) return { time: "", sender: "" };
    return { time: (match[1] + ", " + match[2]).trim(), sender: (match[3] || "").trim() };
  }

  function dayStart(now, offsetMin) {
    var offsetMinutes = Math.max(-840, Math.min(840, Number(offsetMin) || 0));
    var offset = offsetMinutes * 60000;
    var local = now + offset;
    var startLocal = local - ((local % DAY) + DAY) % DAY;
    return Math.max(0, startLocal - offset);
  }

  function tagIs(el, name) {
    return !!el && String(el.tagName || "").toLowerCase() === name;
  }

  function walk(node, fn) {
    if (!node) return;
    fn(node);
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i], fn);
  }

  function hasId(el, id) {
    var node = el;
    var guard = 0;
    while (node && guard < 40) {
      if (node.id === id) return true;
      node = node.parentElement || null;
      guard += 1;
    }
    return false;
  }

  function attr(node, name) {
    if (!node || !node.getAttribute) return "";
    return node.getAttribute(name) || "";
  }

  function classOf(node) {
    var raw = attr(node, "class");
    if (!raw && node && typeof node.className === "string") raw = node.className;
    return raw || "";
  }

  function rectOf(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    var rect = el.getBoundingClientRect();
    if (!rect || rect.width == null || rect.height == null) return null;
    return rect;
  }

  function collectButtons(el) {
    var out = [];
    walk(el, function (node) {
      if (node !== el && (tagIs(node, "button") || attr(node, "role") === "button")) out.push(node);
    });
    return out;
  }

  function findRail(doc) {
    if (!doc || typeof doc.getElementById !== "function") return null;
    var app = doc.getElementById("app") || doc.body;
    if (!app) return null;
    var seen = [];
    function add(el) {
      if (!el || seen.indexOf(el) !== -1) return;
      seen.push(el);
    }
    walk(app, function (node) {
      if (tagIs(node, "header") || tagIs(node, "nav")) add(node);
    });
    var kids = app.children || [];
    for (var i = 0; i < kids.length; i++) {
      add(kids[i]);
      var grand = kids[i].children || [];
      for (var j = 0; j < grand.length && j < 8; j++) add(grand[j]);
    }
    var best = null;
    var bestScore = -1;
    for (var n = 0; n < seen.length; n++) {
      var el = seen[n];
      if (el.id === "main" || hasId(el, "main") || hasId(el, "pane-side") || hasId(el, "side")) continue;
      var rect = rectOf(el);
      if (!rect || rect.width < 40 || rect.width > 96 || rect.height < 200 || rect.width * 3 > rect.height) continue;
      var buttons = collectButtons(el);
      if (buttons.length < 2) continue;
      var score = buttons.length * 1000 - rect.left;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  function buttonLabel(el) {
    return (attr(el, "aria-label") || attr(el, "title") || (el && el.textContent) || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isMetaButton(el) {
    if (/meta\s*ai/.test(buttonLabel(el))) return true;
    var hit = false;
    walk(el, function (node) {
      var icon = (attr(node, "data-icon") + " " + attr(node, "data-testid")).toLowerCase();
      if (icon.indexOf("meta") !== -1) hit = true;
    });
    return hit;
  }

  function findMetaButton(rail) {
    if (!rail) return null;
    var buttons = collectButtons(rail);
    for (var i = 0; i < buttons.length; i++) {
      if (isMetaButton(buttons[i])) return buttons[i];
    }
    return null;
  }

  // The account switcher is the anchor. Meta AI is only a fallback, because a
  // to-do button beside that icon looks like part of WhatsApp's own rail.
  function chooseAnchor(doc) {
    if (!doc || typeof doc.getElementById !== "function") return null;
    var switcher = doc.getElementById("__whatrust_accounts");
    if (switcher && switcher.parentNode) return { el: switcher, mode: "switcher" };
    var controls = doc.getElementById("__whatrust_controls");
    if (controls && controls.parentNode) return { el: controls, mode: "switcher" };
    var rail = findRail(doc);
    if (!rail) return null;
    var meta = findMetaButton(rail);
    if (meta && meta.parentNode) return { el: meta, mode: "rail" };
    var buttons = collectButtons(rail);
    var last = buttons.length ? buttons[buttons.length - 1] : null;
    if (last && last.parentNode) return { el: last, mode: "rail" };
    return null;
  }

  // "below" hangs the button under a horizontal switcher. "after" keeps it in
  // a column that already stacks downward (the rail, or a vertical header).
  function anchorPlacement(mode, flexDirection, width, height) {
    if (mode !== "switcher") return "after";
    if (width < 96 && height > 200) return "after";
    if (String(flexDirection || "").indexOf("column") === 0) return "after";
    return "below";
  }

  function markedText(node) {
    var kids = node && node.children || [];
    var lines = [];
    for (var i = 0; i < kids.length; i++) {
      var bit = kids[i] && kids[i].textContent ? String(kids[i].textContent).trim() : "";
      if (bit) lines.push(bit);
    }
    if (lines.length) return lines.join("\n");
    return String(node && node.textContent || "").trim();
  }

  // The voice card tags the transcript and the summary. Button labels live in
  // the same box, so an untagged box that already has children contributes
  // nothing. A plain text node, which is all older cards stored, still counts.
  function voiceFrom(box) {
    var text = "";
    var summary = "";
    var tagged = false;
    walk(box, function (node) {
      if (node === box) return;
      if (attr(node, "data-wr-voice-text")) {
        tagged = true;
        text = markedText(node);
      }
      if (attr(node, "data-wr-voice-summary")) {
        tagged = true;
        summary = markedText(node);
      }
    });
    if (!tagged) {
      var kids = box.children || [];
      if (kids.length) return "";
      return String(box.textContent || "");
    }
    if (text && summary) return text + "\n" + summary;
    return text || summary;
  }

  function extractDom(row) {
    if (!row) return null;
    var id = attr(row, "data-id");
    var token = messageToken(id);
    if (!token) return null;
    var plain = attr(row, "data-pre-plain-text");
    var text = "";
    var voice = "";
    var kind = "other";
    walk(row, function (node) {
      if (!plain && attr(node, "data-pre-plain-text")) plain = attr(node, "data-pre-plain-text");
      if (!text && classOf(node).indexOf("selectable-text") !== -1 && node.textContent) text = String(node.textContent);
      if (attr(node, "data-wr-voice")) voice = voiceFrom(node);
      var icon = attr(node, "data-icon").toLowerCase();
      if (icon.indexOf("audio") !== -1 || icon.indexOf("ptt") !== -1) kind = "voice";
      else if (icon.indexOf("image") !== -1) kind = "image";
      else if (icon.indexOf("video") !== -1) kind = "video";
      else if (icon.indexOf("document") !== -1) kind = "document";
    });
    if (voice) text = text ? text + "\n" + voice : voice;
    if (kind === "other" && text) kind = "text";
    var parsed = parsePlain(plain);
    return {
      msg_id: id,
      msg_token: token,
      chat_id: normalizeChatId(id),
      chat_name: "",
      sender: parsed.sender,
      snippet: String(text || "").replace(/\u0000/g, "").slice(0, 1000),
      msg_timestamp: parsed.time,
      kind: kind,
      from_me: messageOutgoing(row, id),
    };
  }

  // The bubble class is the direction. A bare message id has no true_/false_ prefix.
  function messageOutgoing(row, id) {
    var cur = row;
    for (var i = 0; cur && i < 8; i++) {
      var cls = classOf(cur);
      if (/(?:^|\s)message-out(?:\s|$)/.test(cls)) return true;
      if (/(?:^|\s)message-in(?:\s|$)/.test(cls)) return false;
      cur = cur.parentElement || null;
    }
    return typeof id === "string" && id.indexOf("true_") === 0;
  }

  function isWatch(item) {
    return !!item && (item.kind === "waiting" || item.kind === "owe");
  }

  function isTask(item) {
    return !!item && !isWatch(item);
  }

  var SKIP_MESSAGE = {
    protocol: 1,
    e2e_notification: 1,
    gp2: 1,
    notification: 1,
    notification_template: 1,
    ciphertext: 1,
    revoked: 1,
    call_log: 1,
    album: 1,
    reaction: 1,
  };

  function markedAt(item) {
    var created = item && item.created_at || 0;
    var epoch = item && item.message && item.message.msg_epoch || 0;
    return created > epoch ? created : epoch;
  }

  function sameMessage(item, signal) {
    var msg = item && item.message || {};
    if (!signal) return false;
    if (signal.msg_id && msg.msg_id && signal.msg_id === msg.msg_id) return true;
    if (signal.msg_token && msg.msg_token && signal.msg_token === msg.msg_token) return true;
    if (signal.msg_id && msg.msg_token && messageToken(signal.msg_id) === msg.msg_token) return true;
    return false;
  }

  function chatKey(value) {
    var chat = normalizeChatId(value);
    return chat || String(value || "");
  }

  function sameWatchChat(itemChat, signalChat, lookup) {
    var left = normalizeChatId(itemChat);
    var right = normalizeChatId(signalChat);
    if (!left || !right) return false;
    if (left === right) return true;
    if (typeof lookup !== "function") return false;
    var leftResolved = lookup(left) || lookup(itemChat);
    var rightResolved = lookup(right) || lookup(signalChat);
    if (!leftResolved || !rightResolved) return false;
    return chatKey(leftResolved) === chatKey(rightResolved);
  }

  // A later message clears a watch only when it is newer than both the marked
  // message and the moment it was marked. Live events also have to be recent,
  // so opening a chat and loading its history does not clear a watch.
  function clearsWatch(item, signal, lookup) {
    if (!isWatch(item) || item.done || !signal) return false;
    if (!signal.type || SKIP_MESSAGE[signal.type]) return false;
    if (/@broadcast/.test(signal.chat_id || "")) return false;
    var itemChat = item.message && item.message.chat_id;
    if (!sameWatchChat(itemChat, signal.chat_id, lookup)) return false;
    if (sameMessage(item, signal)) return false;
    var at = signal.at_ms || 0;
    if (!at || at <= markedAt(item)) return false;
    if (signal.live) {
      var now = signal.now || 0;
      var age = now - at;
      if (!now || age > 120000 || age < -15000) return false;
    }
    if (item.kind === "waiting") return !signal.from_me;
    if (item.kind === "owe") return !!signal.from_me;
    return false;
  }

  function badgeFor(items, now, offsetMin) {
    var start = dayStart(now, offsetMin);
    var end = start + DAY;
    var overdue = 0;
    var today = 0;
    var open = 0;
    var anyDue = false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isTask(item) || item.done) continue;
      open += 1;
      var when = dueWhen(item, now);
      if (!when) continue;
      anyDue = true;
      if (when < start) overdue += 1;
      else if (when < end) today += 1;
    }
    var count = overdue + today;
    if (!count && !anyDue) count = open;
    return { count: count, overdue: overdue };
  }

  function replyBadge(items) {
    var open = 0;
    var fired = false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isWatch(item) || item.done) continue;
      open += 1;
      if (item.fired && (item.remind_at || item.snooze_until)) fired = true;
    }
    return { count: open, overdue: fired };
  }

  function blobOf(item) {
    var msg = item.message || {};
    return [item.title, item.note, msg.sender, msg.chat_name, msg.snippet].join("\n").toLowerCase();
  }

  function dueWhen(item, now) {
    if (!item) return 0;
    // A snooze is a promise to leave the task alone, so a future one wins
    // over a due date that is already in the past. An expired snooze does not.
    if (item.snooze_until && now != null && item.snooze_until > now) return item.snooze_until;
    var due = item.due_at || 0;
    var remind = item.remind_at || 0;
    // A reminder that already fired should not bury a due date that is still ahead.
    if (due && remind && now != null && remind < now && due >= now) return due;
    if (due && remind) return Math.min(due, remind);
    return due || remind || item.snooze_until || 0;
  }

  function sectionOf(item, now, offsetMin) {
    var start = dayStart(now, offsetMin);
    var end = start + DAY;
    var when = dueWhen(item, now);
    if (!when) return "none";
    if (when < start) return "overdue";
    if (when < end) return "today";
    return "upcoming";
  }

  function filterItems(items, mode, query, now, offsetMin) {
    var start = dayStart(now, offsetMin);
    var end = start + DAY;
    var q = String(query || "").trim().toLowerCase();
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isTask(item)) continue;
      if (mode === "done") {
        if (!item.done) continue;
      } else if (item.done) {
        continue;
      } else if (mode === "today") {
        var todayWhen = dueWhen(item, now);
        if (!(todayWhen >= start && todayWhen < end)) continue;
      } else if (mode === "upcoming") {
        if (!(dueWhen(item, now) >= end)) continue;
      } else if (mode !== "open") {
        continue;
      }
      if (q && blobOf(item).indexOf(q) === -1) continue;
      out.push(item);
    }
    return out;
  }

  function sortItems(items) {
    var rank = { high: 0, normal: 1, low: 2 };
    var copy = items.slice();
    copy.sort(function (a, b) {
      var delta = (rank[a.priority] == null ? 1 : rank[a.priority]) - (rank[b.priority] == null ? 1 : rank[b.priority]);
      if (delta) return delta;
      return (b.created_at || 0) - (a.created_at || 0);
    });
    return copy;
  }

  function groupItems(items, now, offsetMin) {
    var order = ["overdue", "today", "upcoming", "none"];
    var buckets = { overdue: [], today: [], upcoming: [], none: [] };
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || item.done || !isTask(item)) continue;
      var key = sectionOf(item, now, offsetMin);
      if (!buckets[key]) key = "none";
      buckets[key].push(item);
    }
    var out = [];
    for (var g = 0; g < order.length; g++) {
      if (!buckets[order[g]].length) continue;
      out.push({ id: order[g], items: sortItems(buckets[order[g]]) });
    }
    return out;
  }

  // An open to-do keeps the marker. A finished to-do must not cover an open watch,
  // or the reply disappears from the message.
  function markerChoice(taskAny, taskOpen, watch) {
    var item = taskOpen || watch || taskAny || null;
    return { item: item, replies: !taskOpen && !!watch };
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

  // The key's remote, then the chat model. from/to is not used here: in a
  // group those name the sender. A status broadcast is not a conversation.
  function rawDirectChat(msg) {
    if (!msg) return "";
    var id = msg.id;
    var raw = "";
    if (typeof id === "string") raw = chatFromId(id);
    if (!raw) raw = widText(id && id.remote);
    if (!raw && msg.chat && msg.chat.id) raw = widText(msg.chat.id);
    return raw;
  }

  function directChatId(msg) {
    var raw = rawDirectChat(msg);
    if (/@broadcast/.test(raw)) return "";
    return normalizeChatId(raw);
  }

  function messageChatId(msg) {
    var raw = rawDirectChat(msg);
    if (/@broadcast/.test(raw)) return "";
    var direct = normalizeChatId(raw);
    if (direct) return direct;
    if (!msg) return "";
    var id = msg.id;
    var fromMe = !!(id && id.fromMe);
    var fallback = widText(fromMe ? msg.to : msg.from);
    if (/@broadcast/.test(fallback)) return "";
    return normalizeChatId(fallback);
  }

  // A data-id that is a message is not a conversation. Device suffixes are
  // stripped, and a status broadcast is not a chat.
  function chatMarked(node) {
    var id = attr(node, "data-id");
    if (!id || messageToken(id)) return "";
    return normalizeChatId(id);
  }

  function firstChatId(node) {
    if (!node) return "";
    var found = "";
    walk(node, function (el) {
      if (found) return;
      var chat = chatMarked(el);
      if (chat) found = chat;
    });
    return found;
  }

  function chooseOpenChat(modelId, headerNode, selectedNode) {
    return normalizeChatId(modelId)
      || chatMarked(headerNode)
      || chatMarked(selectedNode)
      || firstChatId(selectedNode)
      || firstChatId(headerNode)
      || "";
  }

  function menuActions(task, watch, fromMe) {
    var rows = task ? ["open", "complete"] : ["add", "remind"];
    if (watch) rows.push("reply-open", "reply-clear");
    else if (fromMe) rows.push("waiting", "owe");
    else rows.push("owe", "waiting");
    return rows;
  }

  function filterWatches(items, mode, query) {
    var q = String(query || "").trim().toLowerCase();
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isWatch(item)) continue;
      if (mode === "cleared") {
        if (!item.done) continue;
      } else if (item.done) {
        continue;
      }
      if (q && blobOf(item).indexOf(q) === -1) continue;
      out.push(item);
    }
    return out;
  }

  function groupWatches(items) {
    var waiting = [];
    var owe = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || item.done) continue;
      if (item.kind === "owe") owe.push(item);
      else waiting.push(item);
    }
    function byMarked(a, b) {
      return (b.created_at || 0) - (a.created_at || 0);
    }
    waiting.sort(byMarked);
    owe.sort(byMarked);
    var out = [];
    if (waiting.length) out.push({ id: "waiting", items: waiting });
    if (owe.length) out.push({ id: "owe", items: owe });
    return out;
  }

  function isMenuRow(node) {
    if (!node || attr(node, "data-id")) return false;
    var role = attr(node, "role");
    if (tagIs(node, "li") || tagIs(node, "button") || role === "button" || role === "menuitem" || role === "option") return true;
    if (attr(node, "data-animate-dropdown-item")) return true;
    // WhatsApp's menu rows are sometimes plain divs that can be focused.
    return attr(node, "tabindex") !== "" && String(node.textContent || "").trim().length > 0;
  }

  function menuRows(el) {
    var rows = [];
    walk(el, function (node) {
      if (node === el || !isMenuRow(node) || attr(node, "data-wr-todo-menu")) return;
      var parent = node.parentElement || node.parentNode;
      var hops = 0;
      while (parent && parent !== el && hops < 8) {
        if (isMenuRow(parent)) return;
        parent = parent.parentElement || parent.parentNode;
        hops += 1;
      }
      var rect = rectOf(node);
      if (!rect || rect.width < 60 || rect.height < 16 || rect.height > 88) return;
      rows.push(node);
    });
    return rows;
  }

  function pointDistance(rect, point) {
    var dx = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;
    var dy = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
    return dx + dy;
  }

  function menuScore(el, point) {
    if (!el || (el.id && String(el.id).indexOf("__whatrust") === 0)) return -1;
    if (el.id === "app" || el.id === "main" || el.id === "side" || el.id === "pane-side") return -1;
    if (hasId(el, "pane-side") || hasId(el, "side")) return -1;
    if (attr(el, "data-id")) return -1;
    if (typeof el.querySelector === "function" && el.querySelector("[data-id]")) return -1;
    var rect = rectOf(el);
    if (!rect || rect.width < 140 || rect.width > 560 || rect.height < 48 || rect.height > 680) return -1;
    var rows = menuRows(el);
    if (rows.length < 2 || rows.length > 24) return -1;
    var dist = 0;
    if (point && typeof point.x === "number") {
      dist = pointDistance(rect, point);
      if (dist > 280) return -1;
    }
    // Distance decides. Otherwise a small menu across the screen outscores
    // the one sitting under the pointer, because the old score subtracted area.
    return 1000000 - Math.round(dist) * 1000 - Math.min(rect.width * rect.height, 900);
  }

  function collectMenus(rootNode) {
    var out = [];
    if (!rootNode) return out;
    if (typeof rootNode.querySelectorAll === "function") {
      var lists = rootNode.querySelectorAll("ul, [role='menu'], [role='listbox']");
      for (var i = 0; i < lists.length; i++) out.push(lists[i]);
      return out;
    }
    walk(rootNode, function (node) {
      if (tagIs(node, "ul") || attr(node, "role") === "menu" || attr(node, "role") === "listbox") out.push(node);
    });
    return out;
  }

  function findMenu(rootNode, point) {
    var nodes = collectMenus(rootNode);
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < nodes.length; i++) {
      var score = menuScore(nodes[i], point);
      if (score > bestScore) {
        best = nodes[i];
        bestScore = score;
      }
    }
    return best;
  }

  function isChevronTarget(node) {
    var cur = node;
    for (var i = 0; cur && i < 6; i++) {
      var icon = (attr(cur, "data-icon") + " " + attr(cur, "data-testid")).toLowerCase();
      if (CHEVRON_ICON.test(icon)) return true;
      var label = (attr(cur, "aria-label") + " " + attr(cur, "title")).toLowerCase();
      if (CHEVRON_LABEL.test(label)) return true;
      cur = cur.parentElement || cur.parentNode || null;
    }
    return false;
  }

  function indexMessages(items) {
    var any = Object.create(null);
    var open = Object.create(null);
    var watchAny = Object.create(null);
    var watchOpen = Object.create(null);
    function put(map, item) {
      var msg = item && item.message;
      if (!msg) return;
      if (msg.msg_token) map[msg.msg_token] = item;
      if (msg.msg_id) map[msg.msg_id] = item;
    }
    for (var i = 0; i < items.length; i++) {
      var doneItem = items[i];
      if (!doneItem || !doneItem.done) continue;
      put(isWatch(doneItem) ? watchAny : any, doneItem);
    }
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      if (!item || item.done) continue;
      if (isWatch(item)) {
        put(watchAny, item);
        put(watchOpen, item);
      } else {
        put(any, item);
        put(open, item);
      }
    }
    return { any: any, open: open, watches: { any: watchAny, open: watchOpen } };
  }

  function lookupMapped(map, extract) {
    if (!extract || !map) return null;
    return map[extract.msg_id] || map[extract.msg_token] || null;
  }

  // How far the rail stack must drop so its top sits clear of Meta AI.
  // `top` is the switcher's current top. A positive margin is one we already
  // applied, so a later measure does not add it again. `floor` is the top of
  // the next rail icon the stack must not cover.
  function clearanceFor(top, metaBottom, margin, stackHeight, floor) {
    if (metaBottom == null || !isFinite(metaBottom) || !isFinite(top)) return 0;
    var current = margin > 0 ? margin : 0;
    var naturalTop = top - current;
    var needed = Math.ceil(metaBottom + 20 - naturalTop);
    if (needed < 4) return 0;
    var limit = 240;
    if (floor != null && isFinite(floor) && stackHeight > 0) {
      var maxShift = Math.floor(floor - stackHeight - naturalTop);
      if (maxShift < 4) return 0;
      if (maxShift < limit) limit = maxShift;
    }
    return needed > limit ? limit : needed;
  }

  function alignedTo(rect, anchor, slop) {
    if (!rect || !anchor) return false;
    var mid = (rect.left + rect.right) / 2;
    var anchorMid = (anchor.left + anchor.right) / 2;
    return Math.abs(mid - anchorMid) <= slop;
  }

  // Meta AI counts even when its box starts below the switcher. The flower is
  // drawn on top of that box, which is the overlap on the rail.
  function pickClearance(switchRect, stackHeight, margin, rects) {
    if (!switchRect || !rects) return { shift: 0, meta: null };
    var current = margin > 0 ? margin : 0;
    var naturalTop = switchRect.top - current;
    var metaBottom = null;
    var chosen = null;
    var i;
    for (i = 0; i < rects.length; i++) {
      var meta = rects[i];
      if (!meta.meta || !alignedTo(meta, switchRect, 56)) continue;
      if (metaBottom == null || meta.bottom > metaBottom) {
        metaBottom = meta.bottom;
        chosen = meta;
      }
    }
    if (metaBottom == null) {
      for (i = 0; i < rects.length; i++) {
        var hit = rects[i];
        if (hit.meta || !alignedTo(hit, switchRect, 40)) continue;
        if (hit.bottom > naturalTop + 4 && hit.top < switchRect.bottom - 4) {
          if (metaBottom == null || hit.bottom > metaBottom) {
            metaBottom = hit.bottom;
            chosen = hit;
          }
        }
      }
    }
    var floor = null;
    if (metaBottom != null) {
      for (i = 0; i < rects.length; i++) {
        var below = rects[i];
        if (below.meta || !alignedTo(below, switchRect, 40)) continue;
        if (below.top < metaBottom + 8) continue;
        if (floor == null || below.top < floor) floor = below.top;
      }
    }
    return {
      shift: clearanceFor(switchRect.top, metaBottom, margin, stackHeight, floor == null ? null : floor - 8),
      meta: chosen,
    };
  }

  // "dark", "light", or null when the color is missing or fully transparent.
  // A transparent black background has luminance 0, so it must not count as dark.
  function themeFromColor(color) {
    if (color == null) return null;
    var text = String(color).replace(/\s+/g, " ").trim().toLowerCase();
    if (!text || text === "transparent") return null;
    if (text === "white") return "light";
    if (text === "black") return "dark";
    var r;
    var g;
    var b;
    var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
    if (hex) {
      var h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    } else {
      var parts = text.match(/[\d.]+/g);
      if (!parts || parts.length < 3) return null;
      if (parts.length >= 4 && +parts[3] === 0) return null;
      r = +parts[0];
      g = +parts[1];
      b = +parts[2];
    }
    var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum < 140 ? "dark" : "light";
  }

  function themePalette(dark) {
    if (dark) {
      return {
        panel: { bg: "#111b21", fg: "#e9edef", dim: "#8696a0", line: "#222d34", hover: "#202c33" },
        popup: { bg: "#233138", fg: "#e9edef", dim: "#8696a0", btn: "#2a3942", btnFg: "#ffffff", link: "#7dffb3", border: "0" },
        badgeRing: "#111b21",
      };
    }
    return {
      panel: { bg: "#ffffff", fg: "#111b21", dim: "#667781", line: "#e9edef", hover: "#f0f2f5" },
      popup: { bg: "#ffffff", fg: "#111b21", dim: "#667781", btn: "#f0f2f5", btnFg: "#111b21", link: "#008069", border: "1px solid #e9edef" },
      badgeRing: "#fff",
    };
  }

  function popupCss() {
    return [
      ".card{background:var(--bg);color:var(--fg);border:var(--stroke);box-shadow:0 8px 24px #0006}",
      ".sub{color:var(--dim)}",
      "button{background:var(--btn);color:var(--btn-fg)}",
      "button.primary{background:#1daa61;color:#042}",
      "button.primary.reply{background:#53bdeb;color:#042}",
      "input{background:var(--btn);color:var(--fg)}",
    ].join("");
  }

  if (root.__WHATRUST_TEST) {
    root.__whatrustTodoApi = {
      messageToken: messageToken,
      chatFromId: chatFromId,
      normalizeChatId: normalizeChatId,
      chatForMark: chatForMark,
      parsePlain: parsePlain,
      dayStart: dayStart,
      extractDom: extractDom,
      findRail: findRail,
      findMetaButton: findMetaButton,
      chooseAnchor: chooseAnchor,
      anchorPlacement: anchorPlacement,
      badgeFor: badgeFor,
      filterItems: filterItems,
      sortItems: sortItems,
      sectionOf: sectionOf,
      groupItems: groupItems,
      menuActions: menuActions,
      indexMessages: indexMessages,
      isWatch: isWatch,
      replyBadge: replyBadge,
      filterWatches: filterWatches,
      groupWatches: groupWatches,
      clearsWatch: clearsWatch,
      markerChoice: markerChoice,
      messageChatId: messageChatId,
      directChatId: directChatId,
      chooseOpenChat: chooseOpenChat,
      lookupMapped: lookupMapped,
      clearanceFor: clearanceFor,
      pickClearance: pickClearance,
      isTask: isTask,
      isChevronTarget: isChevronTarget,
      menuScore: menuScore,
      findMenu: findMenu,
      themeFromColor: themeFromColor,
      themePalette: themePalette,
      popupCss: popupCss,
    };
    return;
  }

  if (root.__whatrustTodoBoot) return;
  root.__whatrustTodoBoot = true;

  var items = [];
  var tracked = Object.create(null);
  var openTracked = Object.create(null);
  var watchOpen = Object.create(null);
  var open = false;
  var page = "todo";
  var filterMode = "open";
  var query = "";
  var searchOpen = false;
  var expandedId = "";
  var host;
  var shadow;
  var listEl;
  var searchEl;
  var quickEl;
  var countEl;
  var clearBtn;
  var tabButton;
  var tabBadge;
  var replyButton;
  var replyBadgeEl;
  var fallback;
  var fallbackLabel;
  var fallbackBadge;
  var replyFallback;
  var replyFallbackLabel;
  var replyFallbackBadge;
  var toastHost;
  var toastTimer;
  var alarmHost;
  var alarmShadow;
  var lastAlarms = [];
  var saveTimers = Object.create(null);
  var pending = null;
  var menuObserver = null;
  var menuTimer = 0;
  var recentNodes = [];
  var menuFound = false;
  var menuGone = 0;
  var menuFoundLogged = false;
  var menuMissLogged = false;
  var companion;
  var companionKey = "";
  var themeAppObserver = null;
  var themeAppNode = null;
  var themeTimer = 0;
  var themeKnown = null;
  var captureHost;
  var captureTimer = 0;
  var railWarned = false;
  var switcherWait = 0;
  var switcherTimer = 0;

  function tzOffset() {
    return -new Date().getTimezoneOffset();
  }

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === "function") return root.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
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

  function indexItems() {
    var indexed = indexMessages(items);
    tracked = indexed.any;
    openTracked = indexed.open;
    watchOpen = indexed.watches.open;
  }

  function lookupExtract(extract) {
    return lookupMapped(openTracked, extract);
  }

  function lookupWatch(extract) {
    return lookupMapped(watchOpen, extract);
  }

  function defaultTitle(kind) {
    if (kind === "voice") return L("Mensagem de voz", "Voice message");
    if (kind === "image") return L("Imagem", "Photo");
    if (kind === "video") return L("Vídeo", "Video");
    if (kind === "document") return L("Documento", "Document");
    return L("Mensagem do WhatsApp", "WhatsApp message");
  }

  function saveFailed() {
    showToast(L("Não foi possível salvar.", "Could not save that change."));
  }

  function inMain(node) {
    return hasId(node, "main");
  }

  function rowOf(node) {
    var cur = node;
    for (var i = 0; cur && i < 30; i++) {
      if (attr(cur, "data-id") && messageToken(attr(cur, "data-id"))) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function activeChatName() {
    var main = document.getElementById("main");
    if (!main) return "";
    var header = null;
    walk(main, function (node) {
      if (!header && tagIs(node, "header")) header = node;
    });
    if (!header) return "";
    var titled = null;
    walk(header, function (node) {
      if (!titled && attr(node, "title")) titled = node;
    });
    var text = titled ? attr(titled, "title") : header.textContent || "";
    return String(text).replace(/\s+/g, " ").trim().slice(0, 160);
  }

  function styleOf(node, prop) {
    if (!node) return "";
    try {
      return getComputedStyle(node)[prop] || "";
    } catch (e) {
      return "";
    }
  }

  // Light header text means WhatsApp is in dark mode. Same cutoff as the account controls.
  function themeFromInk(color) {
    var tone = themeFromColor(color);
    if (tone === "light") return "dark";
    if (tone === "dark") return "light";
    return null;
  }

  function chatListHeader() {
    var side = document.getElementById("side") || document.getElementById("pane-side");
    if (side && side.querySelector) {
      var inner = side.querySelector("header");
      if (inner) return inner;
    }
    var app = document.getElementById("app");
    if (!app || !app.querySelectorAll) return null;
    var headers = app.querySelectorAll("header,[role=banner]");
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].closest && headers[i].closest("#main")) continue;
      return headers[i];
    }
    return null;
  }

  function themeDark() {
    var ids = ["app", "side", "pane-side"];
    for (var i = 0; i < ids.length; i++) {
      var tone = themeFromColor(styleOf(document.getElementById(ids[i]), "backgroundColor"));
      if (tone) return tone === "dark";
    }
    var bodyTone = themeFromColor(styleOf(document.body, "backgroundColor"));
    if (bodyTone) return bodyTone === "dark";
    var ink = themeFromInk(styleOf(chatListHeader(), "color"));
    if (ink) return ink === "dark";
    return !!(root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function applyPopupVars(node, colors, dark) {
    if (!node) return;
    node.style.setProperty("--bg", colors.popup.bg);
    node.style.setProperty("--fg", colors.popup.fg);
    node.style.setProperty("--dim", colors.popup.dim);
    node.style.setProperty("--btn", colors.popup.btn);
    node.style.setProperty("--btn-fg", colors.popup.btnFg);
    node.style.setProperty("--link", colors.popup.link);
    node.style.setProperty("--stroke", colors.popup.border);
    node.style.colorScheme = dark ? "dark" : "light";
  }

  function paintTheme() {
    var dark = themeDark();
    var colors = themePalette(dark);
    if (host) {
      host.style.setProperty("--bg", colors.panel.bg);
      host.style.setProperty("--fg", colors.panel.fg);
      host.style.setProperty("--dim", colors.panel.dim);
      host.style.setProperty("--line", colors.panel.line);
      host.style.setProperty("--hover", colors.panel.hover);
      host.style.setProperty("--accent", page === "replies" ? "#53bdeb" : "#1daa61");
      host.style.colorScheme = dark ? "dark" : "light";
    }
    applyPopupVars(captureHost, colors, dark);
    applyPopupVars(alarmHost, colors, dark);
    if (toastHost) {
      toastHost.style.background = colors.popup.bg;
      toastHost.style.color = colors.popup.fg;
      toastHost.style.border = colors.popup.border;
      toastHost.style.colorScheme = dark ? "dark" : "light";
      var undo = toastHost.querySelector("[data-role=undo]");
      if (undo) undo.style.color = colors.popup.link;
    }
    if (companion && companion.style.display !== "none") {
      companion.style.background = colors.popup.bg;
      companion.style.color = colors.popup.fg;
      companion.style.border = colors.popup.border;
      companion.style.colorScheme = dark ? "dark" : "light";
    }
    paintBadge();
  }

  function applyTheme() {
    paintTheme();
  }

  var PANEL_CSS = [
    ":host{all:initial}",
    ".wrap{box-sizing:border-box;height:100%;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif;border-inline-end:1px solid var(--line)}",
    ".wrap *{box-sizing:border-box}",
    "header.top{display:flex;align-items:center;gap:8px;padding:12px 12px 4px}",
    "header.top h1{margin:0;font-size:18px;font-weight:600}",
    ".count{color:var(--dim);font-size:13px;font-weight:600}",
    ".spacer{flex:1}",
    "button,input,textarea,select{font:inherit;color:inherit}",
    "button{border:0;background:transparent;cursor:pointer;border-radius:8px}",
    "button:hover{background:var(--hover)}",
    "button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}",
    ".icon{width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;flex:none}",
    ".search{display:none;margin:0 12px 8px;padding:8px 10px;border:0;border-radius:8px;background:var(--hover);width:calc(100% - 24px)}",
    ".search.show{display:block}",
    ".quick{display:flex;gap:8px;padding:8px 12px}",
    ".quick.hide{display:none}",
    ".quick input{flex:1;min-width:0;border:1px solid var(--line);border-radius:10px;background:transparent;padding:8px 10px}",
    ".quick button{background:var(--accent);color:#042;font-weight:600;padding:0 12px;border-radius:10px;flex:none}",
    ".quick button:hover{filter:brightness(1.05)}",
    ".tabs{display:flex;gap:2px;padding:0 8px 8px;align-items:center;flex-wrap:wrap}",
    ".tabs button{padding:6px 8px;border-radius:8px;color:var(--dim)}",
    ".tabs button[aria-selected=true]{color:var(--fg);font-weight:600;box-shadow:inset 0 -2px 0 var(--accent)}",
    ".clear{display:none;margin-inline-start:auto;color:var(--dim);font-size:12px}",
    ".clear.show{display:inline-flex}",
    ".list{flex:1;overflow:auto;padding:0 12px 16px}",
    "h2{margin:12px 0 6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}",
    "h2.late{color:#d34545}",
    "article{border:1px solid var(--line);border-radius:12px;padding:8px;margin:0 0 8px}",
    "article.done{opacity:.62}",
    "article.open{border-color:color-mix(in srgb, var(--accent) 55%, var(--line))}",
    ".head{display:flex;gap:8px;align-items:flex-start}",
    ".check{width:22px;height:22px;margin-top:1px;border:1.5px solid var(--dim);border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0}",
    "article.done .check{background:var(--accent);color:#042;border-color:var(--accent)}",
    ".body{flex:1;min-width:0}",
    ".line{display:flex;gap:6px;align-items:center}",
    ".name{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".chip{flex:none;font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:1px 6px}",
    ".chip.late{color:#d34545;border-color:#d34545}",
    ".dot{width:8px;height:8px;min-width:8px;border-radius:50%;flex:none;padding:0;border:0}",
    ".dot.high{background:#d34545}",
    ".dot.normal{background:#8696a0}",
    ".dot.low{background:#53bdeb}",
    ".actions{display:none;gap:2px;flex:none}",
    "article:hover .actions,article:focus-within .actions,article.open .actions{display:flex}",
    ".actions button{color:var(--accent);font-size:12px;font-weight:600;padding:2px 4px}",
    ".foot{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}",
    ".foot button{color:var(--accent);font-size:12px;font-weight:600;padding:4px 8px}",
    ".foot button.go{background:color-mix(in srgb, var(--accent) 16%, transparent)}",
    ".foot button.go:hover{background:color-mix(in srgb, var(--accent) 28%, transparent)}",
    ".meta{color:var(--dim);font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".snippet{color:var(--dim);font-size:13px;margin:4px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}",
    ".detail{display:none;margin-top:8px}",
    "article.open .detail{display:block}",
    ".lbl{display:block;margin:8px 0 2px;color:var(--dim);font-size:11px}",
    ".detail input,.detail textarea,.detail select{width:100%;border:1px solid var(--line);border-radius:8px;background:transparent;padding:6px 8px}",
    ".detail textarea{min-height:52px;resize:vertical}",
    ".presets{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}",
    ".presets.times{display:grid;grid-template-columns:1fr 1fr}",
    ".presets.times button{text-align:center}",
    ".presets button,.ghost{border:1px solid var(--line);border-radius:8px;padding:4px 8px}",
    ".end{display:flex;gap:6px;margin-top:8px}",
    ".end .danger{margin-inline-start:auto}",
    ".presets button[aria-pressed=true]{background:var(--accent);color:#042;font-weight:600}",
    ".danger{color:#d34545}",
    ".empty{color:var(--dim);padding:28px 8px;text-align:center}",
    ".hint{display:block;margin-top:6px;font-size:12px}",
  ].join("");

  var ICON_TAB = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m4 6 1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>';
  var ICON_REPLY = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H10l-3 3v-3H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/></svg>';
  var ICON_SEARCH = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  function el(tag, text) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = text;
    return node;
  }

  function iconButton(svg, label) {
    var button = el("button");
    button.type = "button";
    button.className = "icon";
    button.innerHTML = svg;
    button.title = label;
    button.setAttribute("aria-label", label);
    return button;
  }

  function buildTab() {
    var button = el("button");
    button.type = "button";
    button.id = "__whatrust_todo_tab";
    button.innerHTML = ICON_TAB;
    tabBadge = el("span");
    tabBadge.style.cssText = "position:absolute;top:-2px;right:-2px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#1daa61;color:#042;font:10px/16px system-ui;text-align:center;display:none";
    button.appendChild(tabBadge);
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      togglePage("todo");
    });
    return button;
  }

  function buildReplyTab() {
    var button = el("button");
    button.type = "button";
    button.id = "__whatrust_todo_replies";
    button.innerHTML = ICON_REPLY;
    replyBadgeEl = el("span");
    replyBadgeEl.style.cssText = "position:absolute;top:-2px;right:-2px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#53bdeb;color:#042;font:10px/16px system-ui;text-align:center;display:none";
    button.appendChild(replyBadgeEl);
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      togglePage("replies");
    });
    return button;
  }

  function styleTab(button, mode) {
    button.dataset.mode = mode;
    var reply = button.id === "__whatrust_todo_replies";
    if (mode === "switcher") {
      var edge = reply ? "#53bdeb66" : "#00806966";
      var wash = reply ? "#53bdeb22" : "#00806922";
      button.style.cssText = "width:36px;height:36px;padding:0;border:1px solid " + edge + ";border-radius:50%;background:" + wash + ";color:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;outline-offset:3px;position:relative";
    } else {
      button.style.cssText = "width:40px;height:40px;margin:4px auto;padding:0;border:0;border-radius:12px;background:transparent;color:inherit;position:relative;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none";
    }
  }

  function ensureFallback() {
    if (fallback) return;
    fallback = el("button");
    fallback.type = "button";
    fallback.id = "__whatrust_todo_fallback";
    fallback.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:100000;display:none;gap:6px;align-items:center;padding:8px 12px;border:0;border-radius:999px;background:#1daa61;color:#042;font:13px system-ui;cursor:pointer";
    fallbackLabel = el("span", L("Tarefas", "To-Do"));
    fallbackBadge = el("span");
    fallbackBadge.style.cssText = "min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#fff;color:#042;font:10px/16px system-ui;text-align:center;display:none";
    fallback.append(fallbackLabel, fallbackBadge);
    fallback.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      togglePage("todo");
    });
    document.documentElement.appendChild(fallback);
    replyFallback = el("button");
    replyFallback.type = "button";
    replyFallback.id = "__whatrust_todo_reply_fallback";
    replyFallback.style.cssText = "position:fixed;left:12px;bottom:56px;z-index:100000;display:none;gap:6px;align-items:center;padding:8px 12px;border:0;border-radius:999px;background:#53bdeb;color:#042;font:13px system-ui;cursor:pointer";
    replyFallbackLabel = el("span", L("Respostas", "Replies"));
    replyFallbackBadge = el("span");
    replyFallbackBadge.style.cssText = "min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#fff;color:#042;font:10px/16px system-ui;text-align:center;display:none";
    replyFallback.append(replyFallbackLabel, replyFallbackBadge);
    replyFallback.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      togglePage("replies");
    });
    document.documentElement.appendChild(replyFallback);
  }

  function paintCount(badges, info, dark, calm) {
    var text = info.count > 99 ? "99+" : info.count ? String(info.count) : "";
    badges.forEach(function (badge) {
      if (!badge) return;
      badge.textContent = text;
      badge.style.display = text ? "inline-block" : "none";
      badge.style.background = info.overdue ? "#d34545" : (calm || "#1daa61");
      badge.style.color = info.overdue ? "#fff" : "#042";
      badge.style.boxShadow = "0 0 0 2px " + themePalette(!!dark).badgeRing;
    });
    return text;
  }

  function paintRailButton(button, title, active, color) {
    if (!button) return;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.style.boxShadow = active ? "inset 0 0 0 2px " + (color || "#1daa61") : "none";
    if (button.dataset.mode !== "switcher") {
      button.style.background = active ? "color-mix(in srgb, currentColor 12%, transparent)" : "transparent";
    }
  }

  function paintBadge() {
    if (!tabBadge && !fallbackBadge && !replyBadgeEl && !replyFallbackBadge) return;
    var dark = themeDark();
    var info = badgeFor(items, Date.now(), tzOffset());
    var text = paintCount([tabBadge, fallbackBadge], info, dark);
    var replies = replyBadge(items);
    var replyText = paintCount([replyBadgeEl, replyFallbackBadge], replies, dark, "#53bdeb");
    if (fallbackLabel) fallbackLabel.textContent = L("Tarefas", "To-Do");
    if (replyFallbackLabel) replyFallbackLabel.textContent = L("Respostas", "Replies");
    paintRailButton(tabButton, L("Lista de tarefas", "To-Do") + (text ? " (" + text + ")" : ""), open && page === "todo");
    paintRailButton(replyButton, L("Respostas", "Replies") + (replyText ? " (" + replyText + ")" : ""), open && page === "replies", "#53bdeb");
  }

  function insertAfter(anchor, button) {
    if (!anchor || !anchor.parentNode) return;
    button.dataset.pin = "";
    if (anchor.nextElementSibling !== button) anchor.parentNode.insertBefore(button, anchor.nextSibling);
  }

  function flexColumn(el) {
    try {
      return String(getComputedStyle(el).flexDirection || "").indexOf("column") === 0;
    } catch (e) {
      return false;
    }
  }

  function dropOtherStacks(keep) {
    if (!document.querySelectorAll) return;
    var nodes = document.querySelectorAll("[data-wr-todo-stack]");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] !== keep && nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  function paintedRect(el) {
    var self = rectOf(el);
    if (!self || self.width < 8 || self.height < 8 || self.width > 96 || self.height > 96) return null;
    var top = self.top;
    var bottom = self.bottom;
    var left = self.left;
    var right = self.right;
    if (el && typeof el.querySelectorAll === "function") {
      var list = el.querySelectorAll("svg, img, canvas");
      for (var i = 0; i < list.length; i++) {
        var r = rectOf(list[i]);
        if (!r || r.width < 8 || r.height < 8 || r.width > 96 || r.height > 96) continue;
        if (r.top < self.top - 20 || r.bottom > self.bottom + 36) continue;
        if (r.left < self.left - 16 || r.right > self.right + 16) continue;
        if (r.top < top) top = r.top;
        if (r.bottom > bottom) bottom = r.bottom;
        if (r.left < left) left = r.left;
        if (r.right > right) right = r.right;
      }
    }
    return { top: top, bottom: bottom, left: left, right: right, width: right - left, height: bottom - top };
  }

  var railMeta = null;

  function ownMeta(node) {
    var label = (attr(node, "aria-label") + " " + attr(node, "title")).toLowerCase();
    if (/meta\s*ai|meta\s*ia|ia da meta/.test(label)) return true;
    var icon = (attr(node, "data-icon") + " " + attr(node, "data-testid")).toLowerCase();
    if (icon.indexOf("meta") !== -1) return true;
    if (tagIs(node, "button") || attr(node, "role") === "button") {
      var text = (node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text.length > 0 && text.length < 40 && /meta\s*ai|meta\s*ia|ia da meta/.test(text)) return true;
    }
    return false;
  }

  // The flower paints past the control, so include that art. Skip icons that
  // belong to our own stack when Meta AI's node is the parent.
  function metaVisual(node, ignore) {
    if (!node || node === ignore || (ignore && ignore.contains && ignore.contains(node))) return null;
    var self = rectOf(node);
    var top = 1e15;
    var bottom = -1e15;
    var left = 1e15;
    var right = -1e15;
    var have = false;
    var holdsUs = ignore && node.contains && node.contains(ignore);
    if (!holdsUs && self && self.width >= 8 && self.height >= 8 && self.width <= 96 && self.height <= 120) {
      top = self.top;
      bottom = self.bottom;
      left = self.left;
      right = self.right;
      have = true;
    }
    var list = node.querySelectorAll ? node.querySelectorAll("svg, img, canvas") : [];
    for (var i = 0; i < list.length; i++) {
      if (ignore && ignore.contains && ignore.contains(list[i])) continue;
      var art = rectOf(list[i]);
      if (!art || art.width < 8 || art.height < 8 || art.width > 96 || art.height > 96) continue;
      if (have && (art.top < top - 32 || art.bottom > bottom + 64 || art.left < left - 24 || art.right > right + 24)) continue;
      if (art.top < top) top = art.top;
      if (art.bottom > bottom) bottom = art.bottom;
      if (art.left < left) left = art.left;
      if (art.right > right) right = art.right;
      have = true;
    }
    if (!have || !(right > left) || !(bottom > top)) return null;
    if (right - left > 120 || bottom - top > 160) return null;
    return { top: top, bottom: bottom + 4, left: left, right: right };
  }

  function railColumn(switcher) {
    var node = switcher && switcher.parentElement;
    for (var i = 0; node && i < 10; i++) {
      var rect = rectOf(node);
      if (rect && rect.width >= 40 && rect.width <= 120 && rect.height >= 200 && rect.width * 3 <= rect.height) return node;
      node = node.parentElement;
    }
    return findRail(document) || (switcher && switcher.closest && switcher.closest("header, nav")) || (switcher && switcher.parentElement);
  }

  function metaClearance(stack, switcher) {
    railMeta = null;
    var switchRect = rectOf(switcher);
    if (!switchRect || switchRect.height < 8) return 0;
    var margin = stack && stack.style ? parseFloat(stack.style.marginTop) || 0 : 0;
    var stackRect = rectOf(stack);
    var height = stackRect && stackRect.height > switchRect.height ? stackRect.height : switchRect.height;
    var scope = railColumn(switcher);
    var rects = [];
    if (scope) {
      walk(scope, function (node) {
        if (!node || node === stack || node === switcher) return;
        if (stack && stack.contains && stack.contains(node)) return;
        if (attr(node, "id").indexOf("__whatrust") === 0) return;
        if (ownMeta(node)) {
          var visual = metaVisual(node, stack);
          if (visual) rects.push({ top: visual.top, bottom: visual.bottom, left: visual.left, right: visual.right, meta: true });
          return;
        }
        if (!(tagIs(node, "button") || attr(node, "role") === "button")) return;
        var box = paintedRect(node);
        if (!box) return;
        rects.push({ top: box.top, bottom: box.bottom, left: box.left, right: box.right, meta: false });
      });
    }
    var picked = pickClearance(switchRect, height, margin, rects);
    railMeta = picked.meta;
    return picked.shift;
  }

  function coversMeta(rect) {
    if (!railMeta || !rect || rect.width < 8 || rect.height < 8) return false;
    var left = Math.max(rect.left, railMeta.left);
    var right = Math.min(rect.right, railMeta.right);
    return right - left > 12 && rect.top < railMeta.bottom - 4 && rect.bottom > railMeta.top + 4;
  }

  // Drop a fixed whatRust layer that sits on the rail flower. The rail stack
  // itself moves with margin; this is the notification card and the other overlays.
  function nudgeOffMeta(el) {
    if (!el || !el.style || el.style.display === "none") return;
    var rect = rectOf(el);
    if (!coversMeta(rect)) return;
    var next = Math.ceil(railMeta.bottom + 20);
    if (rect.top >= next - 1) return;
    el.style.top = next + "px";
    el.style.bottom = "auto";
  }

  function nudgeRailOverlays() {
    var rootNode = document.documentElement;
    if (rootNode && rootNode.style) {
      if (railMeta) rootNode.style.setProperty("--wr-meta-bottom", Math.ceil(railMeta.bottom + 20) + "px");
      else rootNode.style.removeProperty("--wr-meta-bottom");
    }
    nudgeOffMeta(alarmHost);
    nudgeOffMeta(toastHost);
    nudgeOffMeta(captureHost);
    nudgeOffMeta(host);
    nudgeOffMeta(fallback);
    nudgeOffMeta(replyFallback);
    if (!document.querySelectorAll) return;
    var notes = document.querySelectorAll("[data-whatrust='downloads']");
    for (var i = 0; i < notes.length; i++) nudgeOffMeta(notes[i]);
  }

  // One rail cell. The nav is a wrapping row of narrow icons, so a second
  // 36px circle would sit beside the switcher and spill into the chat list.
  // A full-width column keeps the checklist underneath it.
  function stackUnder(buttons, switcher) {
    var parent = switcher.parentNode;
    if (!parent) return;
    var stacked = attr(parent, "data-wr-todo-stack") === "1";
    var box = stacked ? parent.parentNode : parent;
    var stack = stacked ? parent : null;
    if (!stack) {
      stack = document.createElement("span");
      stack.setAttribute("data-wr-todo-stack", "1");
      parent.insertBefore(stack, switcher);
      stack.appendChild(switcher);
    }
    switcher.style.margin = "0";
    var cursor = switcher;
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      if (!button) continue;
      button.dataset.pin = "";
      button.style.position = "relative";
      button.style.zIndex = "";
      button.style.margin = "0";
      button.style.display = "flex";
      button.style.alignSelf = "center";
      if (cursor.nextElementSibling !== button) cursor.parentNode.insertBefore(button, cursor.nextSibling);
      cursor = button;
    }
    var column = flexColumn(box);
    var held = parseFloat(stack.style.marginTop) || 0;
    stack.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:6px;box-sizing:border-box;width:100%;max-width:100%;align-self:center;position:relative;z-index:2;margin:0;flex:" + (column ? "0 0 auto" : "0 0 100%");
    if (held) stack.style.marginTop = held + "px";
    var shift = metaClearance(stack, switcher);
    if (shift) stack.style.marginTop = shift + "px";
    else stack.style.marginTop = "";
    dropOtherStacks(stack);
  }

  function mountRail() {
    ensureFallback();
    var choice = chooseAnchor(document);
    if (!choice || choice.mode !== "switcher") {
      switcherWait += 1;
      if (switcherWait < 10) {
        clearTimeout(switcherTimer);
        switcherTimer = setTimeout(mountRail, 200);
        return;
      }
    } else switcherWait = 0;
    if (!choice) {
      railMeta = null;
      if (tabButton && tabButton.parentNode) tabButton.parentNode.removeChild(tabButton);
      if (replyButton && replyButton.parentNode) replyButton.parentNode.removeChild(replyButton);
      fallback.style.display = "inline-flex";
      if (replyFallback) replyFallback.style.display = "inline-flex";
      if (!railWarned) {
        railWarned = true;
        crumb("todo: nav-rail fallback");
      }
      return;
    }
    railWarned = false;
    fallback.style.display = "none";
    if (replyFallback) replyFallback.style.display = "none";
    if (!tabButton || !tabButton.isConnected) tabButton = buildTab();
    if (!replyButton || !replyButton.isConnected) replyButton = buildReplyTab();
    styleTab(tabButton, choice.mode);
    styleTab(replyButton, choice.mode);
    if (choice.el.id === "__whatrust_accounts") stackUnder([tabButton, replyButton], choice.el);
    else {
      insertAfter(choice.el, tabButton);
      insertAfter(tabButton, replyButton);
    }
    nudgeRailOverlays();
    paintBadge();
  }

  function buildPanel() {
    if (host) return;
    host = document.createElement("div");
    host.id = "__whatrust_todo";
    host.style.cssText = "position:fixed;z-index:100000;display:none;box-sizing:border-box";
    shadow = host.attachShadow({ mode: "open" });
    var style = el("style");
    style.textContent = PANEL_CSS;
    var wrap = el("div");
    wrap.className = "wrap";
    var header = el("header");
    header.className = "top";
    var title = el("h1", L("Lista de tarefas", "To-Do"));
    title.dataset.role = "title";
    countEl = el("span", "");
    countEl.className = "count";
    var spacer = el("span");
    spacer.className = "spacer";
    var searchBtn = iconButton(ICON_SEARCH, L("Buscar", "Search"));
    searchBtn.dataset.role = "search";
    searchBtn.addEventListener("click", function () {
      searchOpen = !searchOpen;
      if (!searchOpen) {
        query = "";
        if (searchEl) searchEl.value = "";
      }
      renderChrome();
      renderList();
      if (searchOpen && searchEl) searchEl.focus();
    });
    var close = iconButton(ICON_CLOSE, L("Fechar", "Close"));
    close.dataset.role = "close";
    close.addEventListener("click", closePanel);
    header.append(title, countEl, spacer, searchBtn, close);
    searchEl = el("input");
    searchEl.className = "search";
    searchEl.type = "search";
    searchEl.placeholder = L("Buscar", "Search");
    searchEl.addEventListener("input", function () {
      query = searchEl.value;
      renderList();
    });
    var form = el("form");
    form.className = "quick";
    quickEl = el("input");
    quickEl.type = "text";
    quickEl.placeholder = L("Adicionar uma tarefa…", "Add a task…");
    quickEl.setAttribute("aria-label", quickEl.placeholder);
    var add = el("button", L("Adicionar", "Add"));
    add.type = "submit";
    add.dataset.role = "add";
    form.append(quickEl, add);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (page === "replies") return;
      var text = quickEl.value.trim();
      if (!text) return;
      invoke("todo_add", {
        draft: { title: text, note: "", priority: "normal", repeat: "none" },
        tz_offset_minutes: tzOffset(),
      }).then(function (snapshot) {
        quickEl.value = "";
        filterMode = "open";
        applyState(snapshot);
        renderList();
      }).catch(function () {
        showToast(L("Não foi possível adicionar.", "Could not add that task."));
      });
    });
    var tabs = el("div");
    tabs.className = "tabs";
    tabs.setAttribute("role", "tablist");
    [
      ["open", L("Abertas", "Open")],
      ["today", L("Hoje", "Today")],
      ["upcoming", L("Em breve", "Upcoming")],
      ["done", L("Concluídas", "Done")],
    ].forEach(function (entry) {
      var button = el("button", entry[1]);
      button.type = "button";
      button.dataset.mode = entry[0];
      button.setAttribute("role", "tab");
      button.addEventListener("click", function () {
        filterMode = entry[0];
        renderList();
      });
      tabs.appendChild(button);
    });
    clearBtn = el("button", L("Limpar concluídas", "Clear completed"));
    clearBtn.type = "button";
    clearBtn.className = "clear";
    clearBtn.addEventListener("click", function () {
      invoke("todo_clear_done", page === "replies" ? { kind: "waiting" } : {}).then(applyState).catch(saveFailed);
    });
    tabs.appendChild(clearBtn);
    listEl = el("div");
    listEl.className = "list";
    wrap.append(header, searchEl, form, tabs, listEl);
    shadow.append(style, wrap);
    host.addEventListener("keydown", function (event) {
      event.stopPropagation();
    });
    document.documentElement.appendChild(host);
  }

  function renderChrome() {
    if (!shadow) return;
    applyTheme();
    var title = shadow.querySelector("[data-role=title]");
    if (title) title.textContent = page === "replies" ? L("Respostas", "Replies") : L("Lista de tarefas", "To-Do");
    var quick = shadow.querySelector(".quick");
    if (quick) quick.classList.toggle("hide", page === "replies");
    var searchBtn = shadow.querySelector("[data-role=search]");
    if (searchBtn) {
      var searchLabel = L("Buscar", "Search");
      searchBtn.title = searchLabel;
      searchBtn.setAttribute("aria-label", searchLabel);
      searchBtn.setAttribute("aria-pressed", searchOpen ? "true" : "false");
    }
    var close = shadow.querySelector("[data-role=close]");
    if (close) {
      close.title = L("Fechar", "Close");
      close.setAttribute("aria-label", close.title);
    }
    var add = shadow.querySelector("[data-role=add]");
    if (add) add.textContent = L("Adicionar", "Add");
    if (quickEl) {
      quickEl.placeholder = L("Adicionar uma tarefa…", "Add a task…");
      quickEl.setAttribute("aria-label", quickEl.placeholder);
    }
    if (searchEl) {
      searchEl.placeholder = L("Buscar", "Search");
      searchEl.classList.toggle("show", searchOpen);
    }
    var openCount = 0;
    for (var i = 0; i < items.length; i++) {
      var counted = items[i];
      if (!counted || counted.done) continue;
      if (page === "replies" ? isWatch(counted) : isTask(counted)) openCount += 1;
    }
    if (countEl) countEl.textContent = openCount ? String(openCount) : "";
    syncTabs();
    if (clearBtn) {
      clearBtn.textContent = page === "replies" ? L("Limpar resolvidas", "Clear cleared") : L("Limpar concluídas", "Clear completed");
      clearBtn.classList.toggle("show", page === "replies" ? filterMode === "cleared" : filterMode === "done");
    }
  }

  function syncTabs() {
    var tabs = shadow.querySelector(".tabs");
    if (!tabs || !clearBtn) return;
    var modes = page === "replies"
      ? [["open", L("Abertas", "Open")], ["cleared", L("Resolvidas", "Cleared")]]
      : [["open", L("Abertas", "Open")], ["today", L("Hoje", "Today")], ["upcoming", L("Em breve", "Upcoming")], ["done", L("Concluídas", "Done")]];
    var buttons = [];
    var node = tabs.firstChild;
    while (node) {
      if (node.getAttribute && node.getAttribute("data-mode")) buttons.push(node);
      node = node.nextSibling;
    }
    var same = buttons.length === modes.length;
    for (var i = 0; same && i < modes.length; i++) {
      if (buttons[i].dataset.mode !== modes[i][0]) same = false;
    }
    if (!same) {
      buttons.forEach(function (button) {
        if (button.parentNode) button.parentNode.removeChild(button);
      });
      modes.forEach(function (entry) {
        var button = el("button", entry[1]);
        button.type = "button";
        button.dataset.mode = entry[0];
        button.setAttribute("role", "tab");
        button.addEventListener("click", function () {
          filterMode = entry[0];
          renderList();
        });
        tabs.insertBefore(button, clearBtn);
      });
    }
    var current = tabs.querySelectorAll("button[data-mode]");
    for (var n = 0; n < current.length; n++) {
      var mode = current[n].dataset.mode;
      var label = "";
      for (var m = 0; m < modes.length; m++) if (modes[m][0] === mode) label = modes[m][1];
      current[n].textContent = label;
      current[n].setAttribute("aria-selected", String(mode === filterMode));
    }
  }

  function columnRect() {
    var side = document.getElementById("side");
    var sideRect = side && rectOf(side);
    if (sideRect && sideRect.width >= 80) return sideRect;
    var pane = document.getElementById("pane-side");
    var rect = pane && rectOf(pane);
    if (!rect) return null;
    var box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    var node = pane.parentElement;
    for (var i = 0; node && i < 5; i++) {
      var up = rectOf(node);
      if (!up) break;
      var widthOk = up.width >= rect.width - 4 && up.width <= rect.width + 120;
      var bottomOk = Math.abs(up.bottom - rect.bottom) <= 12;
      if (!widthOk || !bottomOk) break;
      if (up.left <= rect.left + 2 && up.top < box.top) {
        box.top = up.top;
        box.height = up.bottom - up.top;
        box.bottom = up.bottom;
      }
      node = node.parentElement;
    }
    return box;
  }

  function placePanel() {
    if (!host) return;
    var rect = columnRect();
    if (!rect || rect.width < 80) {
      host.style.left = "64px";
      host.style.top = "0px";
      host.style.width = "380px";
      host.style.height = "100vh";
      return;
    }
    var top = Math.max(0, rect.top);
    var limit = rect.top + rect.height;
    var switcher = document.getElementById("__whatrust_accounts");
    var header = switcher && switcher.closest ? switcher.closest("header") : null;
    var hr = header && rectOf(header);
    if (hr && hr.bottom > top + 8 && hr.bottom < limit - 80 && hr.left < rect.left + rect.width && hr.right > rect.left) {
      top = hr.bottom;
    }
    if (railMeta && rect.left < railMeta.right - 12 && rect.left + rect.width > railMeta.left + 12) {
      var cleared = Math.ceil(railMeta.bottom + 20);
      if (top < cleared && cleared < limit - 120) top = cleared;
    }
    host.style.left = Math.max(0, rect.left) + "px";
    host.style.top = top + "px";
    host.style.width = rect.width + "px";
    host.style.height = Math.max(120, limit - top) + "px";
  }

  function togglePage(next) {
    if (open && page === next) closePanel();
    else showPage(next, "");
  }

  function showPage(next, id) {
    var switching = page !== next;
    page = next;
    if (switching) {
      filterMode = "open";
      query = "";
      searchOpen = false;
      if (searchEl) searchEl.value = "";
      expandedId = "";
    }
    stopMenuWatch();
    buildPanel();
    open = true;
    host.style.display = "block";
    applyTheme();
    placePanel();
    if (id) {
      var item = items.filter(function (entry) { return entry.id === id; })[0];
      if (page === "replies") filterMode = item && item.done ? "cleared" : "open";
      else filterMode = item && item.done ? "done" : "open";
      query = "";
      searchOpen = false;
      if (searchEl) searchEl.value = "";
      expandedId = id;
    }
    renderChrome();
    renderList();
    paintBadge();
    hideCapture();
    if (id && shadow) {
      var node = shadow.querySelector('[data-todo-id="' + cssEscape(id) + '"]');
      if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
    }
  }

  function openPanel(id) {
    showPage("todo", id || "");
  }

  function openReplies(id) {
    showPage("replies", id || "");
  }

  function closePanel() {
    open = false;
    if (host) host.style.display = "none";
    paintBadge();
  }

  function priorityLabel(priority) {
    if (priority === "high") return L("Alta", "High");
    if (priority === "low") return L("Baixa", "Low");
    return L("Normal", "Normal");
  }

  function nextPriority(priority) {
    if (priority === "low") return "normal";
    if (priority === "normal") return "high";
    return "low";
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function toLocalInput(ms) {
    if (!ms) return "";
    var date = new Date(ms);
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function toDateInput(ms) {
    if (!ms) return "";
    var date = new Date(ms);
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function fromDateInput(value) {
    if (!value) return null;
    var parts = value.split("-");
    if (parts.length < 3) return null;
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0, 0).getTime();
  }

  function evening() {
    var date = new Date();
    date.setHours(18, 0, 0, 0);
    if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
    return date.getTime();
  }

  function tomorrowMorning() {
    var date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    return date.getTime();
  }

  function remindPresets() {
    return [
      [L("10 min", "10 min"), function () { return Date.now() + 10 * 60000; }],
      [L("1 h", "1 h"), function () { return Date.now() + 60 * 60000; }],
      [L("Noite", "Evening"), evening],
      [L("Amanhã 9h", "Tomorrow 9am"), tomorrowMorning],
    ];
  }

  function patch(id, fields) {
    var body = { id: id };
    Object.keys(fields).forEach(function (key) { body[key] = fields[key]; });
    return invoke("todo_update", { patch: body }).then(applyState);
  }

  function queuePatch(id, fields) {
    var key = id + Object.keys(fields).join(",");
    clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(function () {
      patch(id, fields).catch(saveFailed);
    }, 400);
  }

  function sectionLabel(id) {
    if (id === "overdue") return L("Atrasadas", "Overdue");
    if (id === "today") return L("Hoje", "Today");
    if (id === "upcoming") return L("Em breve", "Upcoming");
    if (id === "waiting") return L("Esperando resposta", "Waiting on them");
    if (id === "owe") return L("Devo uma resposta", "You owe a reply");
    return L("Sem data", "No date");
  }

  function chipText(item) {
    var when = dueWhen(item, Date.now());
    if (!when) return "";
    var start = dayStart(Date.now(), tzOffset());
    if (when < start) return L("Atrasada", "Overdue");
    if (when < start + DAY) return L("Hoje", "Today");
    try {
      return new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (e) {
      return toDateInput(when);
    }
  }

  function snippetLeft(item) {
    var msg = item.message;
    if (!msg || !msg.snippet) return "";
    var text = String(msg.snippet).trim();
    var title = String(item.title || "").trim();
    if (!text || text === title) return "";
    if (title && text.indexOf(title) === 0) return text.slice(title.length).replace(/^[\s:.-]+/, "").trim();
    return text;
  }

  function emptyCopy(mode, searching) {
    if (searching) return { title: L("Nenhum resultado.", "No matches."), hint: "" };
    if (page === "replies") {
      if (mode === "cleared") return { title: L("Nada resolvido.", "Nothing cleared."), hint: "" };
      return {
        title: L("Nada em aberto.", "Nothing waiting."),
        hint: L("Clique com o botão direito em uma mensagem e escolha Esperando resposta ou Devo uma resposta.", "Right-click a message and choose Waiting on them or I owe a reply."),
      };
    }
    if (mode === "today") return { title: L("Nada para hoje.", "Nothing due today."), hint: "" };
    if (mode === "upcoming") return { title: L("Nada agendado.", "Nothing scheduled."), hint: "" };
    if (mode === "done") return { title: L("Nenhuma tarefa concluída.", "No completed tasks."), hint: "" };
    return {
      title: L("Nada para fazer.", "Nothing to do."),
      hint: L("Clique com o botão direito em uma mensagem e escolha Adicionar à lista de tarefas.", "Right-click a message and choose Add to To-Do."),
    };
  }

  function appendEmpty(copy) {
    var empty = el("p");
    empty.className = "empty";
    empty.appendChild(document.createTextNode(copy.title));
    if (copy.hint) {
      var hint = el("span", copy.hint);
      hint.className = "hint";
      empty.appendChild(hint);
    }
    listEl.appendChild(empty);
  }

  function renderList() {
    if (!listEl) return;
    renderChrome();
    if (page === "replies") {
      renderReplyList();
      return;
    }
    var shown = filterItems(items, filterMode, query, Date.now(), tzOffset());
    if (filterMode === "done") {
      shown = shown.slice().sort(function (a, b) {
        return (b.completed_at || b.created_at || 0) - (a.completed_at || a.created_at || 0);
      });
    } else shown = sortItems(shown);
    listEl.replaceChildren();
    if (!shown.length) {
      appendEmpty(emptyCopy(filterMode, !!String(query || "").trim()));
      return;
    }
    if (filterMode === "open" && !String(query || "").trim()) {
      groupItems(shown, Date.now(), tzOffset()).forEach(function (group) {
        var heading = el("h2", sectionLabel(group.id));
        if (group.id === "overdue") heading.className = "late";
        listEl.appendChild(heading);
        group.items.forEach(function (item) { listEl.appendChild(renderCard(item)); });
      });
      return;
    }
    shown.forEach(function (item) { listEl.appendChild(renderCard(item)); });
  }

  function renderReplyList() {
    var shown = filterWatches(items, filterMode, query);
    if (filterMode === "cleared") {
      shown = shown.slice().sort(function (a, b) {
        return (b.completed_at || b.created_at || 0) - (a.completed_at || a.created_at || 0);
      });
    }
    listEl.replaceChildren();
    if (!shown.length) {
      appendEmpty(emptyCopy(filterMode, !!String(query || "").trim()));
      return;
    }
    if (filterMode === "open" && !String(query || "").trim()) {
      groupWatches(shown).forEach(function (group) {
        listEl.appendChild(el("h2", sectionLabel(group.id)));
        group.items.forEach(function (item) { listEl.appendChild(renderWatchCard(item)); });
      });
      return;
    }
    shown.forEach(function (item) { listEl.appendChild(renderWatchCard(item)); });
  }

  function inTwoDays() {
    var date = new Date();
    date.setDate(date.getDate() + 2);
    date.setHours(9, 0, 0, 0);
    return date.getTime();
  }

  function replyPresets() {
    return [
      [L("1 h", "1 h"), function () { return Date.now() + 60 * 60000; }],
      [L("Noite", "Evening"), evening],
      [L("Amanhã 9h", "Tomorrow 9am"), tomorrowMorning],
      [L("Em 2 dias", "In 2 days"), inTwoDays],
    ];
  }

  function remindChip(item) {
    var now = Date.now();
    var when = item.snooze_until && item.snooze_until > now ? item.snooze_until : (item.remind_at || 0);
    if (!when) return "";
    if (item.fired && when <= now) return L("Agora", "Now");
    var start = dayStart(now, tzOffset());
    if (when < start) return L("Atrasado", "Late");
    try {
      if (when < start + DAY) return new Date(when).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      return new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (e) {
      return "";
    }
  }

  function watchQuote(item) {
    var msg = item.message || {};
    var chat = String(msg.chat_name || "").trim();
    var text = String(msg.snippet || item.title || "").trim();
    if (!text || text === chat) return "";
    return text;
  }

  function watchDoneLabel(item, done) {
    if (done) return L("Reabrir", "Reopen");
    if (item.kind === "owe") return L("Já respondi", "I replied");
    return L("Eles responderam", "They replied");
  }

  function renderWatchCard(item) {
    var card = el("article");
    card.dataset.todoId = item.id;
    card.className = "watch" + (item.done ? " done" : "") + (item.id === expandedId ? " open" : "");
    var head = el("div");
    head.className = "head";
    var check = el("button", item.done ? "✓" : "");
    check.type = "button";
    check.className = "check";
    check.title = watchDoneLabel(item, item.done);
    check.setAttribute("aria-label", check.title);
    check.addEventListener("click", function () {
      var was = !!item.done;
      invoke("todo_toggle_done", { id: item.id, done: !was }).then(function (snapshot) {
        applyState(snapshot);
        showToast(was ? L("Reaberta.", "Reopened.") : watchDoneLabel(item, false) + ".", {
          label: L("Desfazer", "Undo"),
          fn: function () { invoke("todo_toggle_done", { id: item.id, done: was }).then(applyState).catch(saveFailed); },
        });
      }).catch(saveFailed);
    });
    var body = el("div");
    body.className = "body";
    var line = el("div");
    line.className = "line";
    var msg = item.message || {};
    var chat = String(msg.chat_name || "").trim() || item.title || L("Sem título", "Untitled");
    var name = el("div", chat);
    name.className = "name";
    line.appendChild(name);
    var flat = filterMode !== "open" || !!String(query || "").trim();
    if (flat) {
      var kindChip = el("span", item.kind === "owe" ? L("Devo resposta", "You owe") : L("Esperando", "Waiting"));
      kindChip.className = "chip";
      line.appendChild(kindChip);
    }
    var chip = remindChip(item);
    if (chip) {
      var chipEl = el("span", chip);
      chipEl.className = "chip" + (item.fired && !item.done ? " late" : "");
      line.appendChild(chipEl);
    }
    body.appendChild(line);
    var quote = watchQuote(item);
    if (quote) {
      var snippet = el("div", quote);
      snippet.className = "snippet";
      body.appendChild(snippet);
    }
    var foot = el("div");
    foot.className = "foot";
    if (item.message) {
      var jump = el("button", L("Abrir conversa", "Open chat"));
      jump.type = "button";
      jump.className = "go";
      jump.addEventListener("click", function () { jumpTo(item); });
      foot.appendChild(jump);
    }
    if (!item.done) {
      var snooze = el("button", L("Adiar 1 h", "Snooze 1h"));
      snooze.type = "button";
      snooze.addEventListener("click", function () {
        invoke("todo_snooze", { id: item.id, until_ms: Date.now() + 60 * 60000 }).then(applyState).catch(saveFailed);
      });
      foot.appendChild(snooze);
    }
    if (foot.childNodes.length) body.appendChild(foot);
    if (item.id === expandedId) body.appendChild(renderWatchDetail(item));
    head.append(check, body);
    card.appendChild(head);
    card.addEventListener("click", function (event) {
      var target = event.target;
      if (target && target.closest && target.closest("button, input, textarea, select, a, .detail")) return;
      expandedId = expandedId === item.id ? "" : item.id;
      renderList();
    });
    return card;
  }

  function renderWatchDetail(item) {
    var detail = el("div");
    detail.className = "detail";
    var noteLabel = el("span", L("Nota", "Note"));
    noteLabel.className = "lbl";
    var note = el("textarea");
    note.value = item.note || "";
    note.addEventListener("input", function () {
      queuePatch(item.id, { note: note.value });
    });
    var remindLabel = el("span", L("Lembrete", "Reminder"));
    remindLabel.className = "lbl";
    var presets = el("div");
    presets.className = "presets times";
    replyPresets().forEach(function (preset) {
      var button = el("button", preset[0]);
      button.type = "button";
      button.addEventListener("click", function () {
        patch(item.id, { remind_at: preset[1]() }).catch(saveFailed);
      });
      presets.appendChild(button);
    });
    var when = el("input");
    when.type = "datetime-local";
    when.value = toLocalInput(item.snooze_until || item.remind_at);
    when.addEventListener("change", function () {
      var ms = new Date(when.value).getTime();
      if (!ms) return;
      patch(item.id, { remind_at: ms }).catch(saveFailed);
    });
    detail.append(noteLabel, note, remindLabel, presets, when);
    var end = el("div");
    end.className = "end";
    if (item.remind_at || item.snooze_until) {
      var clear = el("button", L("Sem lembrete", "No reminder"));
      clear.type = "button";
      clear.className = "ghost";
      clear.addEventListener("click", function () {
        patch(item.id, { clear_remind: true }).catch(saveFailed);
      });
      end.appendChild(clear);
    }
    var del = el("button", L("Excluir", "Delete"));
    del.type = "button";
    del.className = "ghost danger";
    del.addEventListener("click", function () {
      var draft = draftFrom(item);
      invoke("todo_delete", { id: item.id }).then(function (snapshot) {
        if (expandedId === item.id) expandedId = "";
        applyState(snapshot);
        showToast(L("Removida.", "Removed."), {
          label: L("Desfazer", "Undo"),
          fn: function () {
            invoke("todo_add", { draft: draft, tz_offset_minutes: tzOffset() }).then(applyState).catch(saveFailed);
          },
        });
      }).catch(saveFailed);
    });
    end.appendChild(del);
    detail.appendChild(end);
    return detail;
  }

  function renderCard(item) {
    var card = el("article");
    card.dataset.todoId = item.id;
    card.className = (item.done ? "done" : "") + (item.id === expandedId ? " open" : "");
    var head = el("div");
    head.className = "head";
    var check = el("button", item.done ? "✓" : "");
    check.type = "button";
    check.className = "check";
    check.title = item.done ? L("Reabrir", "Reopen") : L("Concluir", "Complete");
    check.addEventListener("click", function () {
      var was = !!item.done;
      invoke("todo_toggle_done", { id: item.id, done: !was }).then(function (snapshot) {
        applyState(snapshot);
        showToast(was ? L("Tarefa reaberta.", "Task reopened.") : L("Tarefa concluída.", "Task completed."), {
          label: L("Desfazer", "Undo"),
          fn: function () { invoke("todo_toggle_done", { id: item.id, done: was }).then(applyState).catch(saveFailed); },
        });
      }).catch(saveFailed);
    });
    var body = el("div");
    body.className = "body";
    var line = el("div");
    line.className = "line";
    var name = el("div", item.title || L("Sem título", "Untitled"));
    name.className = "name";
    line.appendChild(name);
    var chip = chipText(item);
    if (chip) {
      var chipEl = el("span", chip);
      chipEl.className = "chip" + (sectionOf(item, Date.now(), tzOffset()) === "overdue" ? " late" : "");
      line.appendChild(chipEl);
    }
    var dot = el("button");
    dot.type = "button";
    dot.className = "dot " + (item.priority || "normal");
    dot.title = priorityLabel(item.priority);
    dot.setAttribute("aria-label", priorityLabel(item.priority));
    dot.addEventListener("click", function () {
      patch(item.id, { priority: nextPriority(item.priority) }).catch(saveFailed);
    });
    line.appendChild(dot);
    var actions = el("div");
    actions.className = "actions";
    if (item.message) {
      var jump = el("button", L("Abrir", "Jump"));
      jump.type = "button";
      jump.title = L("Ir para a mensagem", "Jump to message");
      jump.addEventListener("click", function () { jumpTo(item); });
      actions.appendChild(jump);
    }
    if (!item.done) {
      var snooze = el("button", L("Adiar 1 h", "Snooze 1h"));
      snooze.type = "button";
      snooze.title = L("Adiar por 1 hora", "Snooze for 1 hour");
      snooze.addEventListener("click", function () {
        var until = Date.now() + 60 * 60000;
        var prevSnooze = item.snooze_until || 0;
        var prevRemind = item.remind_at || 0;
        invoke("todo_snooze", { id: item.id, until_ms: until }).then(function (snapshot) {
          applyState(snapshot);
          showToast(L("Adiada por 1 hora.", "Snoozed for 1 hour."), {
            label: L("Desfazer", "Undo"),
            fn: function () {
              var restore = prevSnooze > Date.now()
                ? invoke("todo_snooze", { id: item.id, until_ms: prevSnooze })
                : invoke("todo_update", { patch: prevRemind ? { id: item.id, remind_at: prevRemind } : { id: item.id, clear_remind: true } });
              restore.then(applyState).catch(saveFailed);
            },
          });
        }).catch(saveFailed);
      });
      actions.appendChild(snooze);
    }
    line.appendChild(actions);
    body.appendChild(line);
    var msg = item.message;
    if (msg && (msg.chat_name || msg.sender)) {
      var meta = el("div", [msg.chat_name, msg.sender].filter(Boolean).join(" · "));
      meta.className = "meta";
      body.appendChild(meta);
    }
    var quote = snippetLeft(item);
    if (quote) {
      var snippet = el("div", quote);
      snippet.className = "snippet";
      body.appendChild(snippet);
    }
    if (item.id === expandedId) body.appendChild(renderDetail(item));
    head.append(check, body);
    card.appendChild(head);
    card.addEventListener("click", function (event) {
      var target = event.target;
      if (target && target.closest && target.closest("button, input, textarea, select, a, .detail")) return;
      expandedId = expandedId === item.id ? "" : item.id;
      renderList();
    });
    return card;
  }

  function renderDetail(item) {
    var detail = el("div");
    detail.className = "detail";
    function label(text) {
      return el("span", text);
    }
    var titleLabel = label(L("Título", "Title"));
    titleLabel.className = "lbl";
    var title = el("input");
    title.type = "text";
    title.value = item.title || "";
    title.addEventListener("input", function () {
      if (!title.value.trim()) return;
      queuePatch(item.id, { title: title.value });
    });
    var noteLabel = label(L("Nota", "Note"));
    noteLabel.className = "lbl";
    var note = el("textarea");
    note.value = item.note || "";
    note.placeholder = L("Nota", "Note");
    note.addEventListener("input", function () {
      queuePatch(item.id, { note: note.value });
    });
    var dueLabel = label(L("Prazo", "Due"));
    dueLabel.className = "lbl";
    var due = el("input");
    due.type = "date";
    due.value = toDateInput(item.due_at);
    due.addEventListener("change", function () {
      if (!due.value) patch(item.id, { clear_due: true }).catch(saveFailed);
      else patch(item.id, { due_at: fromDateInput(due.value) }).catch(saveFailed);
    });
    var remindLabel = label(L("Lembrete", "Reminder"));
    remindLabel.className = "lbl";
    var presets = el("div");
    presets.className = "presets";
    remindPresets().forEach(function (preset) {
      var button = el("button", preset[0]);
      button.type = "button";
      button.addEventListener("click", function () {
        patch(item.id, { remind_at: preset[1](), repeat: item.repeat || "none" }).catch(saveFailed);
      });
      presets.appendChild(button);
    });
    var when = el("input");
    when.type = "datetime-local";
    when.value = toLocalInput(item.snooze_until || item.remind_at);
    when.addEventListener("change", function () {
      var ms = new Date(when.value).getTime();
      if (!ms) return;
      patch(item.id, { remind_at: ms }).catch(saveFailed);
    });
    var repeatLabel = label(L("Repetir", "Repeat"));
    repeatLabel.className = "lbl";
    var repeat = el("select");
    [
      ["none", L("Não repetir", "Do not repeat")],
      ["daily", L("Diária", "Daily")],
      ["weekly", L("Semanal", "Weekly")],
    ].forEach(function (entry) {
      var option = el("option", entry[1]);
      option.value = entry[0];
      if ((item.repeat || "none") === entry[0]) option.selected = true;
      repeat.appendChild(option);
    });
    repeat.addEventListener("change", function () {
      patch(item.id, { repeat: repeat.value }).catch(saveFailed);
    });
    var priLabel = label(L("Prioridade", "Priority"));
    priLabel.className = "lbl";
    var priRow = el("div");
    priRow.className = "presets";
    ["low", "normal", "high"].forEach(function (level) {
      var button = el("button", priorityLabel(level));
      button.type = "button";
      button.setAttribute("aria-pressed", String((item.priority || "normal") === level));
      button.addEventListener("click", function () {
        patch(item.id, { priority: level }).catch(saveFailed);
      });
      priRow.appendChild(button);
    });
    detail.append(titleLabel, title, noteLabel, note, dueLabel, due, remindLabel, presets, when, repeatLabel, repeat, priLabel, priRow);
    if (item.remind_at || item.snooze_until) {
      var clear = el("button", L("Sem lembrete", "No reminder"));
      clear.type = "button";
      clear.className = "ghost";
      clear.addEventListener("click", function () {
        patch(item.id, { clear_remind: true }).catch(saveFailed);
      });
      detail.appendChild(clear);
    }
    var del = el("button", L("Excluir", "Delete"));
    del.type = "button";
    del.className = "ghost danger";
    del.addEventListener("click", function () {
      var draft = draftFrom(item);
      invoke("todo_delete", { id: item.id }).then(function (snapshot) {
        if (expandedId === item.id) expandedId = "";
        applyState(snapshot);
        showToast(L("Tarefa excluída.", "Task deleted."), {
          label: L("Desfazer", "Undo"),
          fn: function () {
            invoke("todo_add", { draft: draft, tz_offset_minutes: tzOffset() }).then(applyState).catch(saveFailed);
          },
        });
      }).catch(saveFailed);
    });
    detail.appendChild(del);
    return detail;
  }

  function draftFrom(item) {
    var draft = {
      title: item.title,
      note: item.note || "",
      priority: item.priority || "normal",
      repeat: item.repeat || "none",
    };
    if (item.due_at) draft.due_at = item.due_at;
    if (item.remind_at) draft.remind_at = item.remind_at;
    if (item.message) draft.message = item.message;
    if (isWatch(item)) draft.kind = item.kind;
    return draft;
  }

  var clearQueue = [];
  var clearing = Object.create(null);
  var catchupChatAt = Object.create(null);
  var wppWatching = false;

  function isLockedError(err) {
    var msg = err && typeof err === "object" && err.message ? String(err.message) : String(err || "");
    return msg.indexOf("locked") !== -1;
  }

  function clearWatch(item, manual) {
    if (!item || item.done || clearing[item.id]) return;
    clearing[item.id] = true;
    invoke("todo_toggle_done", { id: item.id, done: true }).then(function (snapshot) {
      delete clearing[item.id];
      applyState(snapshot);
      var chat = (item.message && item.message.chat_name) || L("essa conversa", "this chat");
      var text = manual
        ? L("Marcada como resolvida.", "Marked as cleared.")
        : (item.kind === "owe" ? L("Você respondeu em ", "You replied in ") : L("Responderam em ", "Replied: ")) + chat;
      showToast(text, {
        label: L("Desfazer", "Undo"),
        fn: function () {
          invoke("todo_toggle_done", { id: item.id, done: false }).then(applyState).catch(function (err) {
            if (!isLockedError(err)) saveFailed();
          });
        },
      });
    }).catch(function (err) {
      delete clearing[item.id];
      if (isLockedError(err)) {
        if (clearQueue.indexOf(item.id) === -1) clearQueue.push(item.id);
        return;
      }
      if (manual) saveFailed();
    });
  }

  function flushClears() {
    if (!clearQueue.length) return;
    var ids = clearQueue.slice();
    clearQueue = [];
    ids.forEach(function (id) {
      var item = null;
      for (var i = 0; i < items.length; i++) if (items[i] && items[i].id === id) item = items[i];
      if (item && !item.done && isWatch(item)) clearWatch(item, false);
    });
  }

  function readChat(id) {
    var wpp = root.WPP;
    if (!id || !wpp || !wpp.chat || typeof wpp.chat.get !== "function") return "";
    try {
      var chat = wpp.chat.get(id);
      if (!chat || typeof chat.then === "function") return "";
      return widText(chat.id);
    } catch (e) {
      return "";
    }
  }

  function lookupChat(id) {
    var found = readChat(id);
    if (found) return found;
    var plain = normalizeChatId(id);
    if (!plain || plain === id) return "";
    return readChat(plain);
  }

  function signalFromWpp(msg, live) {
    if (!msg) return null;
    var id = msg.id;
    var serialized = typeof id === "string" ? id : widText(id);
    var fromMe = !!(id && id.fromMe) || serialized.indexOf("true_") === 0;
    var at = Number(msg.t || 0);
    if (at > 0 && at < 1e12) at *= 1000;
    return {
      chat_id: messageChatId(msg),
      from_me: fromMe,
      at_ms: at,
      msg_id: serialized,
      msg_token: messageToken(serialized),
      type: msg.type || (msg.attributes && msg.attributes.type) || "",
      live: !!live,
      now: Date.now(),
    };
  }

  function applySignal(signal) {
    if (!signal) return;
    var hit = [];
    for (var i = 0; i < items.length; i++) {
      if (clearsWatch(items[i], signal, lookupChat)) hit.push(items[i]);
    }
    hit.forEach(function (item) { clearWatch(item, false); });
  }

  function runCatchup() {
    var wpp = root.WPP;
    if (!wpp || !wpp.isReady || !wpp.chat || typeof wpp.chat.getMessages !== "function") return;
    var now = Date.now();
    var seen = Object.create(null);
    items.forEach(function (item) {
      if (!isWatch(item) || item.done) return;
      var raw = item.message && item.message.chat_id;
      if (!raw) return;
      var id = lookupChat(raw) || raw;
      if (seen[id]) return;
      if (now - (catchupChatAt[id] || 0) < 60000) return;
      seen[id] = true;
      catchupChatAt[id] = now;
      Promise.resolve(wpp.chat.getMessages(id, { count: 30 })).then(function (list) {
        var msgs = list || [];
        for (var n = 0; n < msgs.length; n++) {
          var signal = signalFromWpp(msgs[n], false);
          if (signal) applySignal(signal);
        }
      }).catch(function () {});
    });
  }

  function armReplyWatch() {
    (function tick() {
      var wpp = root.WPP;
      if (!wpp || !wpp.isReady || typeof wpp.on !== "function") {
        setTimeout(tick, 500);
        return;
      }
      if (!wppWatching) {
        wppWatching = true;
        try {
          wpp.on("chat.new_message", function (msg) {
            var signal = signalFromWpp(msg, true);
            if (!signal) return;
            // Opening a chat replays older messages through this event. Those
            // stay off the live rule, but they should still reach catch-up,
            // which clears from the timestamp alone.
            var age = signal.now - signal.at_ms;
            if (signal.at_ms && (age > 120000 || age < -15000)) {
              runCatchup();
              return;
            }
            applySignal(signal);
          });
        } catch (e) {
          wppWatching = false;
          setTimeout(tick, 1000);
          return;
        }
      }
      runCatchup();
    })();
  }

  function applyState(snapshot) {
    if (!snapshot || !snapshot.items) return snapshot;
    items = snapshot.items;
    indexItems();
    paintBadge();
    paintMarkers();
    var typing = shadow && shadow.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(shadow.activeElement.tagName);
    if (open && !typing) renderList();
    var nextAlarms = snapshot.alarms || [];
    if (alarmIds(nextAlarms) !== alarmIds(lastAlarms)) showAlarms(nextAlarms, false);
    flushClears();
    runCatchup();
    return snapshot;
  }

  function alarmIds(list) {
    return (list || []).map(function (alarm) {
      return alarm ? (alarm.id || "") + ":" + (alarm.kind || "") : "";
    }).join("\n");
  }

  var refreshTries = 0;
  function refresh() {
    return invoke("todo_list", { tz_offset_minutes: tzOffset() }).then(function (snapshot) {
      refreshTries = 0;
      return applyState(snapshot);
    }).catch(function () {
      if (refreshTries >= 8) return;
      refreshTries += 1;
      setTimeout(refresh, 500);
    });
  }

  function showToast(text, action) {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:100005;display:none;gap:8px;align-items:center;padding:10px 14px;border-radius:12px;font:14px system-ui;box-shadow:0 8px 24px #0006;max-width:min(440px,calc(100vw - 24px));box-sizing:border-box";
      document.documentElement.appendChild(toastHost);
    }
    toastHost.replaceChildren();
    toastHost.appendChild(document.createTextNode(text));
    var undoId = typeof action === "string" ? action : "";
    var buttonAction = action && typeof action === "object" ? action : null;
    if (undoId) {
      buttonAction = {
        label: L("Desfazer", "Undo"),
        fn: function () {
          invoke("todo_delete", { id: undoId }).then(applyState).catch(saveFailed);
          toastHost.style.display = "none";
        },
      };
    }
    if (buttonAction && buttonAction.label) {
      var undo = el("button", buttonAction.label);
      undo.type = "button";
      undo.dataset.role = "undo";
      undo.style.cssText = "border:0;background:transparent;cursor:pointer;font:inherit";
      undo.addEventListener("click", function () {
        if (buttonAction.fn) buttonAction.fn();
        toastHost.style.display = "none";
      });
      toastHost.appendChild(undo);
    }
    toastHost.style.display = "flex";
    paintTheme();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastHost.style.display = "none"; }, 5000);
  }

  function hideCapture() {
    clearTimeout(captureTimer);
    if (captureHost) captureHost.style.display = "none";
  }

  function ensureCapture() {
    if (captureHost) return;
    captureHost = document.createElement("div");
    captureHost.id = "__whatrust_todo_capture";
    captureHost.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:100004;display:none;width:min(440px,calc(100vw - 24px))";
    var captureShadow = captureHost.attachShadow({ mode: "open" });
    captureHost._shadow = captureShadow;
    var style = el("style");
    style.textContent = popupCss() + ".card{border-radius:14px;padding:12px 14px;font:14px/1.4 system-ui}.task{font-weight:600;margin:2px 0 8px}.sub{font-size:12px;margin-top:-6px;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.row{display:flex;flex-wrap:wrap;gap:6px}.row+.row{margin-top:8px}button,input{font:inherit}button{border:0;border-radius:8px;padding:6px 8px;cursor:pointer}input{margin-top:8px;width:100%;box-sizing:border-box;border:0;border-radius:8px;padding:6px 8px}";
    captureShadow.appendChild(style);
    captureHost.addEventListener("mouseenter", function () { clearTimeout(captureTimer); });
    captureHost.addEventListener("mouseleave", scheduleCaptureHide);
    document.documentElement.appendChild(captureHost);
  }

  function scheduleCaptureHide() {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(hideCapture, 9000);
  }

  function showCapture(item, emphasize, restoreKind) {
    if (!item) return;
    ensureCapture();
    paintTheme();
    var captureShadow = captureHost._shadow;
    var old = captureShadow.querySelector(".card");
    if (old) old.parentNode.removeChild(old);
    var card = el("div");
    card.className = "card";
    var watch = isWatch(item);
    var heading = el("div", watch
      ? L("Avisar se continuar em aberto?", "Check back if this is still open?")
      : emphasize
      ? L("Quando devemos lembrar?", "When should we remind you?")
      : L("Adicionada à lista de tarefas.", "Added to the to-do list."));
    var task = el("div", item.title || "");
    task.className = "task";
    var msg = item.message;
    if (watch && msg && msg.chat_name) task.textContent = msg.chat_name;
    card.append(heading, task);
    var quote = watch ? watchQuote(item) : "";
    if (quote) {
      var sub = el("div", quote);
      sub.className = "sub";
      card.appendChild(sub);
    } else if (!watch && msg && (msg.chat_name || msg.sender)) {
      var meta = el("div", [msg.chat_name, msg.sender].filter(Boolean).join(" · "));
      meta.className = "sub";
      card.appendChild(meta);
    }
    var row = el("div");
    row.className = "row";
    var tail = el("div");
    tail.className = "row";
    function act(parent, label, primary, fn) {
      var button = el("button", label);
      button.type = "button";
      if (primary) button.className = watch ? "primary reply" : "primary";
      button.addEventListener("click", function () { fn(); });
      parent.appendChild(button);
      return button;
    }
    act(watch ? tail : row, L("Desfazer", "Undo"), false, function () {
      if (restoreKind) {
        var done = restoreKind === item.kind ? Promise.resolve() : patch(item.id, { kind: restoreKind });
        done.then(hideCapture).catch(saveFailed);
        return;
      }
      invoke("todo_delete", { id: item.id }).then(function (snapshot) {
        applyState(snapshot);
        hideCapture();
      }).catch(saveFailed);
    });
    var presets = watch ? replyPresets() : [
      [L("1 h", "1 h"), function () { return Date.now() + 60 * 60000; }],
      [L("Noite", "Evening"), evening],
      [L("Amanhã 9h", "Tomorrow 9am"), tomorrowMorning],
    ];
    presets.forEach(function (preset) {
      act(row, preset[0], false, function () {
        patch(item.id, { remind_at: preset[1]() }).then(function () {
          hideCapture();
          showToast(L("Lembrete definido.", "Reminder set."));
        }).catch(saveFailed);
      });
    });
    var pick = el("input");
    pick.type = "datetime-local";
    pick.style.display = emphasize ? "block" : "none";
    pick.addEventListener("change", function () {
      var ms = new Date(pick.value).getTime();
      if (!ms) return;
      patch(item.id, { remind_at: ms }).then(function () {
        hideCapture();
        showToast(L("Lembrete definido.", "Reminder set."));
      }).catch(saveFailed);
    });
    act(watch ? tail : row, L("Escolher…", "Pick…"), false, function () {
      pick.style.display = "block";
      clearTimeout(captureTimer);
      if (typeof pick.showPicker === "function") {
        try { pick.showPicker(); } catch (e) {}
      }
      pick.focus();
    });
    if (watch) {
      act(tail, L("Sem lembrete", "No reminder"), false, function () {
        if (item.remind_at || item.snooze_until) patch(item.id, { clear_remind: true }).then(hideCapture).catch(saveFailed);
        else hideCapture();
      });
    }
    act(watch ? tail : row, L("Editar", "Edit"), true, function () {
      hideCapture();
      if (watch) openReplies(item.id);
      else openPanel(item.id);
    });
    card.append(row, pick);
    if (watch) card.appendChild(tail);
    captureShadow.appendChild(card);
    captureHost.style.display = "block";
    scheduleCaptureHide();
  }

  function addExtract(extract, opts) {
    if (!extract) return;
    var known = lookupExtract(extract);
    var before = Object.create(null);
    items.forEach(function (item) { before[item.id] = true; });
    var msg = {
      msg_id: extract.msg_id,
      msg_token: extract.msg_token,
      chat_id: chatForMark(extract.chat_id, "") || null,
      chat_name: extract.chat_name || activeChatName(),
      sender: extract.sender || "",
      snippet: extract.snippet || "",
      msg_timestamp: extract.msg_timestamp || null,
      kind: extract.kind || "other",
      msg_epoch: extract.msg_epoch || null,
    };
    var explicit = opts && opts.title ? String(opts.title).replace(/\s+/g, " ").trim() : "";
    var title = explicit || (msg.snippet || "").split("\n")[0].trim() || defaultTitle(msg.kind);
    invoke("todo_add", {
      draft: { title: title.slice(0, 300), message: msg },
      tz_offset_minutes: tzOffset(),
    }).then(function (snapshot) {
      applyState(snapshot);
      var added = (snapshot.items || []).filter(function (item) { return !before[item.id]; })[0];
      if (added) showCapture(added, !!(opts && opts.remind));
      else if (known) {
        showToast(L("Essa mensagem já está na lista.", "That message is already on the list."), {
          label: L("Abrir", "Open"),
          fn: function () { openPanel(known.id); },
        });
      } else showToast(L("Adicionada à lista de tarefas.", "Added to the to-do list."));
    }).catch(function () {
      showToast(L("Não foi possível adicionar.", "Could not add that task."));
    });
  }

  function findOpenWatch(list, extract) {
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!isWatch(item) || item.done) continue;
      var msg = item.message || {};
      if (extract.msg_token && msg.msg_token === extract.msg_token) return item;
      if (extract.msg_id && msg.msg_id === extract.msg_id) return item;
    }
    return null;
  }

  function activeChatModel() {
    var wpp = root.WPP;
    if (!wpp || !wpp.chat || typeof wpp.chat.getActiveChat !== "function") return null;
    try {
      var chat = wpp.chat.getActiveChat();
      if (!chat || typeof chat.then === "function") return null;
      return chat;
    } catch (e) {
      return null;
    }
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

  function serializedOf(id) {
    if (!id) return "";
    if (typeof id === "string") return id;
    if (typeof id._serialized === "string") return id._serialized;
    if (typeof id.toString === "function") {
      try {
        var text = String(id.toString());
        if (text && text !== "[object Object]") return text;
      } catch (e) {}
    }
    return "";
  }

  // The open conversation. The message row often has only the bare message id,
  // so the chat has to come from here.
  function openChatId() {
    var chat = activeChatModel();
    var modelId = chat ? widText(chat.id) : "";
    var header = null;
    var main = document.getElementById("main");
    if (main) {
      walk(main, function (node) {
        if (!header && tagIs(node, "header")) header = node;
      });
    }
    var side = document.getElementById("pane-side") || document.getElementById("side");
    var selected = side && side.querySelector ? side.querySelector('[aria-selected="true"]') : null;
    return chooseOpenChat(modelId, header, selected);
  }

  function loadedMessage(token) {
    if (!token) return null;
    var chat = activeChatModel();
    var list = modelList(chat && chat.msgs);
    for (var i = 0; i < list.length; i++) {
      var msg = list[i];
      var id = msg && msg.id;
      var bare = id && typeof id.id === "string" ? id.id : "";
      var serialized = serializedOf(id);
      if (bare === token || (serialized && messageToken(serialized) === token)) return msg;
    }
    return null;
  }

  function applyWppMessage(extract, msg) {
    if (!extract || !msg) return extract;
    var type = msg.type || (msg.attributes && msg.attributes.type) || "";
    if (type === "ptt" || type === "audio") extract.kind = "voice";
    else if (type === "image") extract.kind = "image";
    else if (type === "video") extract.kind = "video";
    else if (type === "document") extract.kind = "document";
    else if (type === "chat" && extract.kind === "other") extract.kind = "text";
    var body = msg.body || msg.caption || (msg.attributes && (msg.attributes.body || msg.attributes.caption)) || "";
    if (body && !extract.snippet) extract.snippet = String(body).slice(0, 1000);
    var chatId = directChatId(msg);
    if (chatId) extract.chat_id = chatId;
    if (!extract.chat_name && msg.chat && msg.chat.name) extract.chat_name = String(msg.chat.name).slice(0, 160);
    var sent = Number(msg.t || (msg.attributes && msg.attributes.t) || 0);
    if (sent > 0 && sent < 1e12) sent *= 1000;
    if (sent > 0) extract.msg_epoch = sent;
    var serialized = serializedOf(msg.id);
    if (/^(?:true|false)_[^_\s]+@[^_\s]+_/.test(serialized) && serialized.length <= 180) extract.msg_id = serialized;
    return extract;
  }

  function addWatch(extract, kind) {
    if (!extract) return;
    extract.chat_id = chatForMark(extract.chat_id, openChatId());
    if (!extract.chat_id) {
      crumb("todo: mark refused no-chat");
      showToast(L("Não foi possível marcar essa mensagem.", "Could not mark that message."));
      return;
    }
    var previous = findOpenWatch(items, extract);
    var before = Object.create(null);
    items.forEach(function (item) { before[item.id] = true; });
    var msg = {
      msg_id: extract.msg_id,
      msg_token: extract.msg_token,
      chat_id: chatForMark(extract.chat_id, ""),
      chat_name: extract.chat_name || activeChatName(),
      sender: extract.sender || "",
      snippet: extract.snippet || "",
      msg_timestamp: extract.msg_timestamp || null,
      kind: extract.kind || "other",
      msg_epoch: extract.msg_epoch || null,
    };
    var title = (msg.snippet || "").split("\n")[0].trim() || defaultTitle(msg.kind);
    invoke("todo_add", {
      draft: { title: title.slice(0, 300), message: msg, kind: kind },
      tz_offset_minutes: tzOffset(),
    }).then(function (snapshot) {
      applyState(snapshot);
      var added = (snapshot.items || []).filter(function (item) { return !before[item.id]; })[0];
      var watch = added || findOpenWatch(snapshot.items || [], extract);
      if (watch) showCapture(watch, false, previous ? previous.kind : "");
      else showToast(kind === "owe" ? L("Devo uma resposta.", "You owe a reply.") : L("Esperando resposta.", "Waiting on them."));
    }).catch(function (err) {
      var reason = err && err.message ? err.message : err;
      crumb("todo: mark refused " + String(reason || "error").replace(/\s+/g, " ").slice(0, 120));
      showToast(L("Não foi possível marcar essa mensagem.", "Could not mark that message."));
    });
  }

  function enrich(extract) {
    if (!extract) return Promise.resolve(extract);
    var token = extract.msg_token || messageToken(extract.msg_id);
    var loaded = loadedMessage(token);
    if (loaded) applyWppMessage(extract, loaded);
    if (!extract.chat_id) extract.chat_id = openChatId();
    // A bare row id is not a message key. Asking WA-JS for it searches the
    // wrong id and rejects, which used to drop the mark.
    var lookup = "";
    if (!loaded && /^(?:true|false)_/.test(extract.msg_id || "")) lookup = extract.msg_id;
    var wpp = root.WPP;
    if (!lookup || !wpp || !wpp.isReady || !wpp.chat || typeof wpp.chat.getMessageById !== "function") {
      return Promise.resolve(extract);
    }
    var pending;
    try {
      pending = wpp.chat.getMessageById(lookup);
    } catch (e) {
      return Promise.resolve(extract);
    }
    return Promise.resolve(pending).then(function (msg) {
      if (msg) applyWppMessage(extract, msg);
      if (!extract.chat_id) extract.chat_id = openChatId();
      return extract;
    }).catch(function () {
      if (!extract.chat_id) extract.chat_id = openChatId();
      return extract;
    });
  }

  function withExtract(extract, fn) {
    try {
      Promise.resolve(enrich(extract)).then(function (next) {
        fn(next || extract);
      }).catch(function () {
        fn(extract);
      });
    } catch (e) {
      fn(extract);
    }
  }

  function menuLabel(action) {
    if (action === "add") return L("Adicionar à lista de tarefas", "Add to To-Do");
    if (action === "remind") return L("Lembrar desta mensagem…", "Remind me about this…");
    if (action === "open") return L("Abrir na lista de tarefas", "Open in To-Do");
    if (action === "waiting") return L("Esperando resposta", "Waiting on them");
    if (action === "owe") return L("Devo uma resposta", "I owe a reply");
    if (action === "reply-open") return L("Abrir em Respostas", "Open in Replies");
    if (action === "reply-clear") return L("Marcar como resolvida", "Mark cleared");
    return L("Concluir tarefa", "Mark done");
  }

  function menuIcon(action) {
    var path = '<path d="M12 5v14M5 12h14"/>';
    if (action === "remind") path = '<circle cx="12" cy="13" r="7"/><path d="M12 10v3.5l2 1.5M9 5.5a4 4 0 0 1 6 0"/>';
    else if (action === "waiting" || action === "reply-open") path = '<path d="M6 6h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H10l-3 3v-3H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/>' + (action === "waiting" ? '<circle cx="9" cy="12" r=".9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r=".9" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r=".9" fill="currentColor" stroke="none"/>' : "");
    else if (action === "owe") path = '<path d="M8 7h9a3 3 0 0 1 0 6H8"/><path d="M11 10 8 13l3 3"/>';
    else if (action === "complete" || action === "reply-clear") path = '<circle cx="12" cy="12" r="8"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>';
    else if (action === "open") path = '<path d="M9 7h10M9 12h10M9 17h10"/><path d="m4 7 1 1 2-2M4 12l1 1 2-2M4 17l1 1 2-2"/>';
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>";
  }

  function pendingMenuActions(extract) {
    var mine = !!(extract && extract.from_me);
    return menuActions(lookupExtract(extract), lookupWatch(extract), mine);
  }

  function runMenuAction(action, extract, existing) {
    if (action === "add") withExtract(extract, function (next) { addExtract(next, null); });
    else if (action === "remind") withExtract(extract, function (next) { addExtract(next, { remind: true }); });
    else if (action === "waiting" || action === "owe") withExtract(extract, function (next) { addWatch(next, action); });
    else if (action === "reply-open") {
      var openWatch = lookupWatch(extract);
      if (openWatch) openReplies(openWatch.id);
    } else if (action === "reply-clear") {
      var clearable = lookupWatch(extract);
      if (clearable) clearWatch(clearable, true);
    } else if (action === "open" && existing) openPanel(existing.id);
    else if (action === "complete" && existing) completeItem(existing.id);
    stopMenuWatch();
  }

  function completeItem(id) {
    invoke("todo_toggle_done", { id: id, done: true }).then(function (snapshot) {
      applyState(snapshot);
      showToast(L("Tarefa concluída.", "Task completed."), {
        label: L("Desfazer", "Undo"),
        fn: function () { invoke("todo_toggle_done", { id: id, done: false }).then(applyState).catch(saveFailed); },
      });
    }).catch(saveFailed);
  }

  function runMenuNode(node, event) {
    if (!node || node.getAttribute("data-wr-fired") === "1") return;
    var action = node.getAttribute("data-wr-todo-action");
    if (!action || !pending || !pending.extract) return;
    var extract = pending.extract;
    node.setAttribute("data-wr-fired", "1");
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    runMenuAction(action, extract, lookupExtract(extract));
  }

  function ensureCompanion() {
    if (companion) return;
    companion = el("div");
    companion.id = "__whatrust_todo_menu";
    companion.style.cssText = "position:fixed;z-index:100003;display:none;box-sizing:border-box;overflow:hidden;box-shadow:0 12px 28px #0006;margin:0;border:0;padding:0";
    document.documentElement.appendChild(companion);
  }

  function presentCompanion() {
    companion.style.display = "block";
    companion.style.margin = "0";
    companion.style.border = "0";
  }

  function hideCompanion() {
    companionKey = "";
    if (!companion) return;
    companion.style.display = "none";
  }

  function fillCompanion(existing, extract) {
    companion.replaceChildren();
    pendingMenuActions(extract).forEach(function (action) {
      var button = el("button");
      button.type = "button";
      button.style.cssText = "display:flex;align-items:center;gap:10px;width:100%;text-align:start;padding:10px 14px;border:0;border-top:1px solid #8696a033;background:transparent;color:inherit;font:14px system-ui;cursor:pointer";
      button.innerHTML = menuIcon(action);
      button.appendChild(document.createTextNode(menuLabel(action)));
      button.setAttribute("data-wr-todo-menu", "1");
      button.setAttribute("data-wr-todo-action", action);
      companion.appendChild(button);
    });
  }

  function showCompanion(menu, extract) {
    ensureCompanion();
    var existing = lookupExtract(extract);
    var watch = lookupWatch(extract);
    var key = (existing ? "task:" + existing.id : "add") + ":" + (watch ? watch.id + ":" + watch.kind : "new") + ":" + (extract.msg_token || extract.msg_id || "");
    if (companionKey !== key) {
      companionKey = key;
      fillCompanion(existing, extract);
    }
    var rect = rectOf(menu);
    if (!rect) return;
    var viewW = root.innerWidth || 800;
    var viewH = root.innerHeight || 800;
    var width = Math.max(180, Math.min(rect.width, viewW - 16));
    companion.style.width = width + "px";
    presentCompanion();
    var h = companion.offsetHeight || 88;
    var top = rect.bottom;
    var above = top + h > viewH - 8;
    if (above) top = Math.max(8, rect.top - h);
    companion.style.left = Math.max(8, Math.min(rect.left, viewW - width - 8)) + "px";
    companion.style.top = top + "px";
    companion.style.borderRadius = above ? "12px 12px 0 0" : "0 0 12px 12px";
    paintCompanion(menu);
  }

  function paintCompanion(menu) {
    if (!companion) return;
    var colors = themePalette(themeDark());
    var bg = colors.popup.bg;
    if (menu) {
      try {
        var color = getComputedStyle(menu).backgroundColor;
        if (themeFromColor(color)) bg = color;
      } catch (e) {}
    }
    companion.style.background = bg;
    companion.style.color = colors.popup.fg;
    companion.style.border = colors.popup.border;
    companion.style.colorScheme = themeDark() ? "dark" : "light";
  }

  function locateMenu() {
    if (!pending) return null;
    var point = { x: pending.x, y: pending.y };
    var best = findMenu(document.body, point);
    var bestScore = best ? menuScore(best, point) : -1;
    for (var n = 0; n < recentNodes.length; n++) {
      var cur = recentNodes[n];
      for (var d = 0; cur && d < 6; d++) {
        var score = menuScore(cur, point);
        if (score > bestScore) {
          best = cur;
          bestScore = score;
        }
        cur = cur.parentElement;
      }
    }
    return best;
  }

  function showCompanionAtPoint() {
    if (!pending) return;
    ensureCompanion();
    var extract = pending.extract;
    var existing = lookupExtract(extract);
    var watch = lookupWatch(extract);
    var key = "point:" + (existing ? existing.id : "add") + ":" + (watch ? watch.id + ":" + watch.kind : "new") + ":" + (extract.msg_token || extract.msg_id || "");
    if (companionKey !== key) {
      companionKey = key;
      fillCompanion(existing, extract);
    }
    var viewW = root.innerWidth || 800;
    var viewH = root.innerHeight || 800;
    companion.style.width = "240px";
    presentCompanion();
    var height = companion.offsetHeight || 88;
    companion.style.left = Math.max(8, Math.min(pending.x, viewW - 248)) + "px";
    companion.style.top = Math.max(8, Math.min(pending.y, viewH - height - 8)) + "px";
    companion.style.borderRadius = "12px";
    paintCompanion(null);
  }

  function syncMenu() {
    if (!pending) return;
    var menu = locateMenu();
    if (!menu) {
      var companionOpen = companion && companion.style.display !== "none";
      if (pending.fallback && !menuFound && !companionOpen && Date.now() - pending.at > 350) showCompanionAtPoint();
      return;
    }
    if (!menuFound && !menuFoundLogged) {
      menuFoundLogged = true;
      crumb("todo: message menu found");
    }
    menuFound = true;
    if (companion && companion.style.display !== "none") {
      showCompanion(menu, pending.extract);
      return;
    }
    var stamp = pending.at;
    setTimeout(function () {
      if (!pending || pending.at !== stamp) return;
      var current = locateMenu();
      if (!current) return;
      showCompanion(current, pending.extract);
    }, 0);
  }

  function stopMenuWatch() {
    pending = null;
    menuFound = false;
    if (typeof root.__whatrustMenuHold === "function") root.__whatrustMenuHold("todo", false);
    else root.__whatrustMenuHold = false;
    recentNodes = [];
    clearTimeout(menuTimer);
    menuTimer = 0;
    if (menuObserver) {
      menuObserver.disconnect();
      menuObserver = null;
    }
    hideCompanion();
  }

  function armMenuWatch(extract, x, y, fallback) {
    if (!extract) return;
    pending = { extract: extract, at: Date.now(), x: x, y: y, fallback: !!fallback };
    menuFound = false;
    menuGone = 0;
    if (typeof root.__whatrustMenuHold === "function") root.__whatrustMenuHold("todo", true);
    else root.__whatrustMenuHold = true;
    recentNodes = [];
    if (!menuObserver && typeof MutationObserver === "function") {
      menuObserver = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes || [];
          for (var j = 0; j < added.length; j++) {
            if (added[j] && added[j].nodeType === 1) recentNodes.push(added[j]);
          }
        }
        if (recentNodes.length > 40) recentNodes = recentNodes.slice(-40);
        syncMenu();
      });
      menuObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    syncMenu();
    clearTimeout(menuTimer);
    (function pump() {
      if (!pending) return;
      var age = Date.now() - pending.at;
      syncMenu();
      if (!pending) return;
      if (!menuFound && pending.fallback && age > 400 && !menuMissLogged) {
        menuMissLogged = true;
        crumb("todo: message menu not found; showing actions at the cursor");
      }
      if (!menuFound && !pending.fallback && age > 2200) {
        if (!menuMissLogged) {
          menuMissLogged = true;
          crumb("todo: message menu not found");
        }
        stopMenuWatch();
        return;
      }
      if (age > 30000 || (!menuFound && age > 12000)) {
        stopMenuWatch();
        return;
      }
      if (menuFound && !locateMenu()) {
        menuGone += 1;
        if (menuGone < 3) {
          menuTimer = setTimeout(pump, 120);
          return;
        }
        // The message menu closed on its own. Keep the actions until the user
        // picks one or clicks away.
        if (companion && companion.style.display !== "none") menuFound = false;
        else {
          stopMenuWatch();
          return;
        }
      } else menuGone = 0;
      menuTimer = setTimeout(pump, 120);
    })();
  }

  function isOurControl(node) {
    var cur = node;
    for (var i = 0; cur && i < 8; i++) {
      if (attr(cur, "data-wr-todo-badge") || attr(cur, "data-wr-todo-menu")) return true;
      if (cur.id && String(cur.id).indexOf("__whatrust_todo") === 0) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isRowMenuButton(node, row) {
    var cur = node;
    for (var i = 0; cur && cur !== row && i < 8; i++) {
      if (tagIs(cur, "button") || attr(cur, "role") === "button") {
        var rect = rectOf(cur);
        var rowRect = rectOf(row);
        if (!rect || !rowRect || rect.width > 48 || rect.height > 48) return false;
        if (rowRect.right - rect.right > 36) return false;
        if (rect.top - rowRect.top > 36) return false;
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function directBadge(row) {
    var kids = row && row.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (attr(kids[i], "data-wr-todo-badge")) return kids[i];
    }
    return null;
  }

  function paintMarkers() {
    var main = document.getElementById("main");
    if (!main || !main.querySelectorAll) return;
    var rows = main.querySelectorAll("[data-id]");
    var seen = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var token = messageToken(attr(row, "data-id"));
      var rowId = attr(row, "data-id");
      var choice = markerChoice(
        tracked[rowId] || tracked[token],
        openTracked[rowId] || openTracked[token],
        watchOpen[rowId] || watchOpen[token]
      );
      var item = choice.item;
      var replyOnly = choice.replies;
      var badge = directBadge(row);
      if (!item) {
        if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
        continue;
      }
      var mark = item.done ? "done" : replyOnly ? (item.kind === "owe" ? "owe" : "waiting") : "task";
      var tone = item.fired && !item.done ? "#d34545" : replyOnly ? "#53bdeb" : "#1daa61";
      var label = replyOnly
        ? (item.kind === "owe" ? L("Devo uma resposta", "I owe a reply") : L("Esperando resposta", "Waiting on them"))
        : (item.done ? L("Tarefa concluída", "Completed task") : L("Tarefa", "Task"));
      if (!badge) {
        badge = el("button");
        badge.type = "button";
        badge.setAttribute("data-wr-todo-badge", item.id);
        badge.style.cssText = "position:absolute;left:2px;top:2px;z-index:3;width:18px;height:18px;border:0;border-radius:50%;background:" + tone + ";color:#042;font:12px/18px system-ui;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0";
        (function (node) {
          node.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            var id = node.getAttribute("data-wr-todo-badge");
            if (node.getAttribute("data-wr-todo-page") === "replies") openReplies(id);
            else openPanel(id);
          });
        })(badge);
        try {
          if (getComputedStyle(row).position === "static") row.style.position = "relative";
        } catch (e) {}
        row.appendChild(badge);
      }
      if (badge.getAttribute("data-wr-mark") !== mark) {
        badge.setAttribute("data-wr-mark", mark);
        badge.innerHTML = mark === "waiting"
          ? '<svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true"><circle cx="4.2" cy="9" r="1.25" fill="#042"/><circle cx="9" cy="9" r="1.25" fill="#042"/><circle cx="13.8" cy="9" r="1.25" fill="#042"/></svg>'
          : mark === "owe"
          ? '<svg viewBox="0 0 18 18" width="13" height="13" fill="none" stroke="#042" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6.5h6.2a2.4 2.4 0 0 1 0 4.8H7"/><path d="M8.6 9.2 6 11.8l2.6 2.6"/></svg>'
          : mark === "done" ? "✓" : "•";
      }
      badge.title = label;
      badge.setAttribute("aria-label", label);
      badge.style.background = tone;
      if (attr(badge, "data-wr-todo-badge") !== item.id) badge.setAttribute("data-wr-todo-badge", item.id);
      badge.setAttribute("data-wr-todo-page", replyOnly ? "replies" : "todo");
      seen.push(badge);
    }
    var marks = main.querySelectorAll("[data-wr-todo-badge]");
    for (var j = 0; j < marks.length; j++) {
      if (seen.indexOf(marks[j]) === -1 && marks[j].parentNode) marks[j].parentNode.removeChild(marks[j]);
    }
  }

  function findRow(item) {
    var main = document.getElementById("main");
    if (!main || !item || !item.message) return null;
    var rows = main.querySelectorAll("[data-id]");
    var token = item.message.msg_token;
    var id = item.message.msg_id;
    for (var i = 0; i < rows.length; i++) {
      var data = attr(rows[i], "data-id");
      if (data === id || data === token || messageToken(data) === token) return rows[i];
    }
    return null;
  }

  function highlight(row) {
    if (!row) return;
    if (row.scrollIntoView) row.scrollIntoView({ block: "center", behavior: "smooth" });
    var previous = row.style.boxShadow;
    row.style.boxShadow = "inset 0 0 0 3px #1daa61";
    setTimeout(function () { row.style.boxShadow = previous; }, 2000);
  }

  function jumpIds(item) {
    var msg = item.message || {};
    var ids = [];
    if (msg.msg_id) ids.push(msg.msg_id);
    if (msg.chat_id && msg.msg_token) {
      ids.push("false_" + msg.chat_id + "_" + msg.msg_token);
      ids.push("true_" + msg.chat_id + "_" + msg.msg_token);
    }
    return ids;
  }

  function resolvedChat(chat) {
    return lookupChat(chat) || chat;
  }

  function openBottom(chat) {
    var wpp = root.WPP;
    var id = resolvedChat(chat);
    if (!id || !wpp || !wpp.chat || typeof wpp.chat.openChatBottom !== "function") {
      showToast(L("Não foi possível abrir essa mensagem.", "Could not open that message."));
      return;
    }
    Promise.resolve(wpp.chat.openChatBottom(id)).then(function () {
      showToast(L("A conversa foi aberta. A mensagem não está mais no histórico local.", "The chat was opened. That message is no longer in local history."));
    }).catch(function () {
      showToast(L("Não foi possível abrir essa mensagem.", "Could not open that message."));
    });
  }

  function tryOpenAt(item, ids, index) {
    var chat = resolvedChat(item.message && item.message.chat_id);
    var wpp = root.WPP;
    if (!chat || !wpp || !wpp.chat || typeof wpp.chat.openChatAt !== "function" || index >= ids.length) {
      openBottom(chat);
      return;
    }
    Promise.resolve(wpp.chat.openChatAt(chat, ids[index])).then(function () {
      setTimeout(function () {
        var row = findRow(item);
        if (row) highlight(row);
      }, 500);
    }).catch(function () { tryOpenAt(item, ids, index + 1); });
  }

  function jumpTo(item) {
    closePanel();
    var row = findRow(item);
    if (row) {
      highlight(row);
      return;
    }
    if (!root.WPP || !root.WPP.isReady) {
      showToast(L("O WhatsApp ainda não está pronto.", "WhatsApp is not ready yet."));
      return;
    }
    tryOpenAt(item, jumpIds(item), 0);
  }

  function showAlarms(alarms, summary) {
    lastAlarms = alarms || [];
    if (!alarmHost) {
      alarmHost = document.createElement("div");
      alarmHost.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:100002;display:none;width:min(440px,calc(100vw - 24px))";
      alarmShadow = alarmHost.attachShadow({ mode: "open" });
      var style = el("style");
      style.textContent = popupCss() + ".card{border-radius:12px;padding:12px;margin:0 0 8px;font:14px/1.4 system-ui}.sub{margin-top:4px}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}button{border:0;border-radius:8px;padding:6px 8px;cursor:pointer}.row.watch button{flex:1 1 calc(50% - 8px);text-align:center}.row.watch button.primary{flex:1 1 100%}";
      alarmShadow.appendChild(style);
      document.documentElement.appendChild(alarmHost);
    }
    paintTheme();
    var cards = alarmShadow.querySelectorAll(".card");
    for (var c = 0; c < cards.length; c++) cards[c].parentNode.removeChild(cards[c]);
    if (!lastAlarms.length) {
      alarmHost.style.display = "none";
      return;
    }
    alarmHost.style.display = "block";
    nudgeOffMeta(alarmHost);
    if (summary && lastAlarms.length > 1) {
      var intro = el("div");
      intro.className = "card";
      intro.textContent = L("Lembretes pendentes", "Pending reminders") + ": " + lastAlarms.length;
      alarmShadow.appendChild(intro);
    }
    lastAlarms.forEach(function (alarm) {
      var card = el("div");
      card.className = "card";
      var match = items.filter(function (item) { return item.id === alarm.id; })[0];
      var watchAlarm = (match && isWatch(match)) || alarm.kind === "waiting" || alarm.kind === "owe";
      var heading = alarm.title || L("Lembrete", "Reminder");
      if (alarm.kind === "waiting") heading = L("Ainda sem resposta", "Still waiting") + (alarm.chat_name ? ": " + alarm.chat_name : "");
      if (alarm.kind === "owe") heading = L("Você ainda deve uma resposta", "You still owe a reply") + (alarm.chat_name ? ": " + alarm.chat_name : "");
      var title = el("div", heading);
      var detail = null;
      if (watchAlarm && alarm.title && alarm.title !== heading) {
        detail = el("div", alarm.title);
        detail.className = "sub";
      }
      var row = el("div");
      row.className = watchAlarm ? "row watch" : "row";
      function act(label, primary, fn) {
        var button = el("button", label);
        button.type = "button";
        if (primary === "reply") button.className = "primary reply";
        else if (primary) button.className = "primary";
        button.addEventListener("click", fn);
        row.appendChild(button);
      }
      if (watchAlarm) {
        if (match && match.message) act(L("Abrir conversa", "Open chat"), "reply", function () { jumpTo(match); });
        else if (alarm.chat_id) act(L("Abrir conversa", "Open chat"), "reply", function () { openBottom(alarm.chat_id); });
        act(L("1 h", "1 h"), false, function () {
          invoke("todo_snooze", { id: alarm.id, until_ms: Date.now() + 60 * 60000 }).then(applyState).catch(saveFailed);
        });
        act(L("Amanhã 9h", "Tomorrow 9am"), false, function () {
          invoke("todo_snooze", { id: alarm.id, until_ms: tomorrowMorning() }).then(applyState).catch(saveFailed);
        });
        act(alarm.kind === "owe" ? L("Já respondi", "I replied") : L("Eles responderam", "They replied"), false, function () {
          invoke("todo_toggle_done", { id: alarm.id, done: true }).then(applyState).catch(saveFailed);
        });
        act(L("Dispensar", "Dismiss"), false, function () {
          invoke("todo_dismiss_alarm", { id: alarm.id }).then(applyState).catch(saveFailed);
        });
      } else {
        act(L("10 min", "10 min"), false, function () {
          invoke("todo_snooze", { id: alarm.id, until_ms: Date.now() + 10 * 60000 }).then(applyState).catch(saveFailed);
        });
        act(L("1 h", "1 h"), false, function () {
          invoke("todo_snooze", { id: alarm.id, until_ms: Date.now() + 60 * 60000 }).then(applyState).catch(saveFailed);
        });
        act(L("Amanhã 9h", "Tomorrow 9am"), false, function () {
          invoke("todo_snooze", { id: alarm.id, until_ms: tomorrowMorning() }).then(applyState).catch(saveFailed);
        });
        act(L("Concluir", "Done"), true, function () {
          invoke("todo_toggle_done", { id: alarm.id, done: true }).then(applyState).catch(saveFailed);
        });
        act(L("Dispensar", "Dismiss"), false, function () {
          invoke("todo_dismiss_alarm", { id: alarm.id }).then(applyState).catch(saveFailed);
        });
        if (match && match.message) {
          act(L("Abrir", "Open"), false, function () { jumpTo(match); });
        }
      }
      if (detail) card.append(title, detail, row);
      else card.append(title, row);
      alarmShadow.appendChild(card);
    });
  }

  root.__whatrustTodoFromVoice = function (payload) {
    var id = payload && payload.id;
    if (!id || !messageToken(id)) return;
    var summary = String(payload.summary || "").replace(/\s+/g, " ").trim();
    if (!summary) return;
    var row = null;
    if (root.document && root.document.querySelectorAll) {
      var found = root.document.querySelectorAll('[data-id="' + cssEscape(id) + '"]');
      if (found && found.length) row = found[0];
    }
    var extract = row ? extractDom(row) : null;
    if (!extract) {
      extract = {
        msg_id: id,
        msg_token: messageToken(id),
        chat_id: normalizeChatId(id) || null,
        chat_name: "",
        sender: "",
        snippet: "",
        msg_timestamp: null,
        kind: "voice",
      };
    }
    extract.kind = "voice";
    var spoken = String(payload.transcript || "").replace(/\u0000/g, "").trim();
    if (spoken) extract.snippet = spoken.slice(0, 1000);
    enrich(extract).then(function (next) {
      if (!next) return;
      if (spoken) next.snippet = spoken.slice(0, 1000);
      next.kind = "voice";
      addExtract(next, { title: summary });
    }).catch(function () {
      if (spoken) extract.snippet = spoken.slice(0, 1000);
      extract.kind = "voice";
      addExtract(extract, { title: summary });
    });
  };

  root.__whatrustTodoState = applyState;
  root.__whatrustTodoAlarm = function (payload) {
    if (!payload) return;
    var alarms = payload.alarms || [];
    var summary = !!payload.summary;
    refresh().then(function () {
      showAlarms(alarms, summary);
    }, function () {
      showAlarms(alarms, summary);
    });
  };

  var previousRelang = root.__wrRelang;
  root.__wrRelang = function () {
    if (typeof previousRelang === "function") previousRelang();
    paintBadge();
    if (open) renderList();
  };

  // Window capture runs before WhatsApp's own menu handler, which removes the
  // row on pointerdown for incoming messages and swallows the click.
  window.addEventListener("pointerdown", function (event) {
    var path = typeof event.composedPath === "function" ? event.composedPath() : null;
    if (!path || !path.length) path = event.target ? [event.target] : [];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (!node || !node.getAttribute || node.getAttribute("data-wr-todo-menu") !== "1") continue;
      runMenuNode(node, event);
      return;
    }
  }, true);

  document.addEventListener("pointerdown", function (event) {
    if (!companion || companion.style.display === "none") return;
    if (pending && Date.now() - pending.at < 280) return;
    if (event.target && companion.contains(event.target)) return;
    if (isOurControl(event.target)) return;
    var menu = locateMenu();
    if (menu && menu.contains && event.target && menu.contains(event.target)) return;
    stopMenuWatch();
  }, true);

  document.addEventListener("contextmenu", function (event) {
    if (isOurControl(event.target)) return;
    var row = rowOf(event.target);
    if (!row || !inMain(row)) return;
    armMenuWatch(extractDom(row), event.clientX, event.clientY, true);
  }, true);

  document.addEventListener("click", function (event) {
    if (isOurControl(event.target)) return;
    var row = rowOf(event.target);
    if (!row || !inMain(row)) return;
    if (!isChevronTarget(event.target) && !isRowMenuButton(event.target, row)) return;
    armMenuWatch(extractDom(row), event.clientX, event.clientY, false);
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && open) {
      var active = shadow && shadow.activeElement;
      if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
        if (typeof active.blur === "function") active.blur();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }
  }, true);

  document.addEventListener("click", function (event) {
    if (!open) return;
    var rail = findRail(document);
    if (!rail || !rail.contains(event.target)) return;
    if (tabButton && tabButton.contains(event.target)) return;
    if (replyButton && replyButton.contains(event.target)) return;
    closePanel();
  }, true);

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      if (pending || (typeof root.__whatrustPageBusy === "function" && root.__whatrustPageBusy())) {
        schedule();
        return;
      }
      bindThemeApp();
      mountRail();
      paintMarkers();
      if (open) placePanel();
    }, 200);
  }

  function bindThemeApp() {
    var app = document.getElementById("app");
    if (app === themeAppNode) return;
    if (themeAppObserver) {
      themeAppObserver.disconnect();
      themeAppObserver = null;
    }
    themeAppNode = app;
    if (app && typeof MutationObserver === "function") {
      themeAppObserver = new MutationObserver(scheduleTheme);
      themeAppObserver.observe(app, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    }
    scheduleTheme();
  }

  function scheduleTheme() {
    if (themeTimer) return;
    themeTimer = setTimeout(function () {
      themeTimer = 0;
      var dark = themeDark();
      if (dark === themeKnown) return;
      themeKnown = dark;
      paintTheme();
    }, 200);
  }

  function armThemeWatch() {
    if (typeof MutationObserver === "function") {
      var observer = new MutationObserver(scheduleTheme);
      var filter = ["class", "style", "data-theme"];
      if (document.documentElement) observer.observe(document.documentElement, { attributes: true, attributeFilter: filter });
      if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: filter });
    }
    if (root.matchMedia) {
      var media = root.matchMedia("(prefers-color-scheme: dark)");
      if (media.addEventListener) media.addEventListener("change", scheduleTheme);
      else if (media.addListener) media.addListener(scheduleTheme);
    }
    bindThemeApp();
    scheduleTheme();
  }

  function arm() {
    if (!document.documentElement) return;
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("scroll", function () {
      if (!menuFound && pending && pending.fallback && Date.now() - pending.at > 700 && companion && companion.style.display !== "none") {
        stopMenuWatch();
      }
      schedule();
    }, true);
    root.addEventListener("resize", schedule);
    schedule();
    armThemeWatch();
    refresh();
    armReplyWatch();
    crumb("todo: injected");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arm);
  else arm();

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      refresh();
      runCatchup();
    }
  });

  // The badge is a local-time idea, so it goes stale across midnight even when
  // nothing else changes. The message markers do not depend on the clock.
  setInterval(paintBadge, 60_000);
  // A reply can land without a fresh event the live rule will accept. Catch-up
  // is already limited to one fetch per chat a minute.
  setInterval(runCatchup, 60_000);
})();

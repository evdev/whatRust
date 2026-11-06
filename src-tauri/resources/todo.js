/* Per-account to-do list inside web.whatsapp.com.
 *
 * The button sits under the account switcher, in the header's own flow (or on
 * the left rail, if that switcher is not there). Messages are captured from
 * the message menu. WhatsApp
 * redraws that menu from its own state, so an item added inside it may be
 * removed; a copy is then drawn against the menu's edge instead. The panel is
 * an overlay: WhatsApp's own nodes stay in the DOM.
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
      if (attr(node, "data-wr-voice") && node.textContent) voice = String(node.textContent);
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
      chat_id: chatFromId(id),
      chat_name: "",
      sender: parsed.sender,
      snippet: String(text || "").replace(/\u0000/g, "").slice(0, 1000),
      msg_timestamp: parsed.time,
      kind: kind,
    };
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
      if (!item || item.done) continue;
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
      if (!item) continue;
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
      if (!item || item.done) continue;
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

  function menuActions(existing) {
    return existing ? ["open", "complete"] : ["add", "remind"];
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
    function put(map, item) {
      var msg = item && item.message;
      if (!msg) return;
      if (msg.msg_token) map[msg.msg_token] = item;
      if (msg.msg_id) map[msg.msg_id] = item;
    }
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].done) put(any, items[i]);
    }
    for (var j = 0; j < items.length; j++) {
      if (items[j] && !items[j].done) {
        put(any, items[j]);
        put(open, items[j]);
      }
    }
    return { any: any, open: open };
  }

  if (root.__WHATRUST_TEST) {
    root.__whatrustTodoApi = {
      messageToken: messageToken,
      chatFromId: chatFromId,
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
      isChevronTarget: isChevronTarget,
      menuScore: menuScore,
      findMenu: findMenu,
    };
    return;
  }

  if (root.__whatrustTodoBoot) return;
  root.__whatrustTodoBoot = true;

  var items = [];
  var tracked = Object.create(null);
  var openTracked = Object.create(null);
  var open = false;
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
  var fallback;
  var fallbackLabel;
  var fallbackBadge;
  var hover;
  var hoverTimer;
  var hoverRow;
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
  var menuInjects = 0;
  var menuFound = false;
  var menuGone = 0;
  var menuFoundLogged = false;
  var menuMissLogged = false;
  var companion;
  var companionKey = "";
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
  }

  function lookupExtract(extract) {
    if (!extract) return null;
    return openTracked[extract.msg_id] || openTracked[extract.msg_token] || null;
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

  function themeDark() {
    var app = document.getElementById("app") || document.body;
    var color = "";
    try {
      color = app ? getComputedStyle(app).backgroundColor : "";
    } catch (e) {}
    var parts = color && color.match(/[\d.]+/g);
    if (parts && parts.length >= 3) {
      return 0.2126 * +parts[0] + 0.7152 * +parts[1] + 0.0722 * +parts[2] < 140;
    }
    return root.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme() {
    if (!host) return;
    var dark = themeDark();
    host.style.setProperty("--bg", dark ? "#111b21" : "#ffffff");
    host.style.setProperty("--fg", dark ? "#e9edef" : "#111b21");
    host.style.setProperty("--dim", dark ? "#8696a0" : "#667781");
    host.style.setProperty("--line", dark ? "#222d34" : "#e9edef");
    host.style.setProperty("--hover", dark ? "#202c33" : "#f0f2f5");
    host.style.setProperty("--accent", "#1daa61");
    host.style.colorScheme = dark ? "dark" : "light";
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
    ".meta{color:var(--dim);font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".snippet{color:var(--dim);font-size:13px;margin:4px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}",
    ".detail{display:none;margin-top:8px}",
    "article.open .detail{display:block}",
    ".lbl{display:block;margin:8px 0 2px;color:var(--dim);font-size:11px}",
    ".detail input,.detail textarea,.detail select{width:100%;border:1px solid var(--line);border-radius:8px;background:transparent;padding:6px 8px}",
    ".detail textarea{min-height:52px;resize:vertical}",
    ".presets{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}",
    ".presets button,.ghost{border:1px solid var(--line);border-radius:8px;padding:4px 8px}",
    ".presets button[aria-pressed=true]{background:var(--accent);color:#042;font-weight:600}",
    ".danger{color:#d34545}",
    ".empty{color:var(--dim);padding:28px 8px;text-align:center}",
    ".hint{display:block;margin-top:6px;font-size:12px}",
  ].join("");

  var ICON_TAB = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m4 6 1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>';
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
      if (open) closePanel();
      else openPanel();
    });
    return button;
  }

  function styleTab(button, mode) {
    button.dataset.mode = mode;
    if (mode === "switcher") {
      button.style.cssText = "width:36px;height:36px;padding:0;border:1px solid #00806966;border-radius:50%;background:#00806922;color:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;outline-offset:3px;position:relative";
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
      if (open) closePanel();
      else openPanel();
    });
    document.documentElement.appendChild(fallback);
  }

  function paintBadge() {
    if (!tabBadge && !fallbackBadge) return;
    var info = badgeFor(items, Date.now(), tzOffset());
    var text = info.count > 99 ? "99+" : info.count ? String(info.count) : "";
    var dark = themeDark();
    [tabBadge, fallbackBadge].forEach(function (badge) {
      if (!badge) return;
      badge.textContent = text;
      badge.style.display = text ? "inline-block" : "none";
      badge.style.background = info.overdue ? "#d34545" : "#1daa61";
      badge.style.color = info.overdue ? "#fff" : "#042";
      badge.style.boxShadow = "0 0 0 2px " + (dark ? "#111b21" : "#fff");
    });
    if (fallbackLabel) fallbackLabel.textContent = L("Tarefas", "To-Do");
    if (tabButton) {
      var title = L("Lista de tarefas", "To-Do") + (text ? " (" + text + ")" : "");
      tabButton.title = title;
      tabButton.setAttribute("aria-label", title);
      tabButton.setAttribute("aria-pressed", open ? "true" : "false");
      tabButton.style.boxShadow = open ? "inset 0 0 0 2px #1daa61" : "none";
      if (tabButton.dataset.mode !== "switcher") {
        tabButton.style.background = open ? "color-mix(in srgb, currentColor 12%, transparent)" : "transparent";
      }
    }
  }

  function insertAfter(anchor, button) {
    if (!anchor || !anchor.parentNode) return;
    button.dataset.pin = "";
    if (anchor.nextElementSibling !== button) anchor.parentNode.insertBefore(button, anchor.nextSibling);
  }

  function canGrow(box) {
    if (!box || !box.style || box === document.body || box === document.documentElement) return false;
    try {
      var max = parseFloat(getComputedStyle(box).maxHeight);
      if (max && max < 96) return false;
    } catch (e) {}
    return true;
  }

  function releaseGrowth(box) {
    if (!box || !box.dataset || box.dataset.wrTodoGrown !== "1") return;
    box.style.minHeight = "";
    box.style.alignItems = box.dataset.wrTodoAlign || "";
    delete box.dataset.wrTodoGrown;
    delete box.dataset.wrTodoAlign;
  }

  function growBox(box, stack) {
    if (!canGrow(box)) return false;
    if (box.dataset.wrTodoGrown !== "1") {
      box.dataset.wrTodoAlign = box.style.alignItems || "";
      box.dataset.wrTodoGrown = "1";
    }
    // Top-align the row so the switcher stays beside the other header icons
    // and the extra height becomes a second row instead of a covering overlay.
    box.style.alignItems = "flex-start";
    var pad = 0;
    var borderBox = false;
    try {
      var style = getComputedStyle(box);
      borderBox = style.boxSizing === "border-box";
      pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
        + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    } catch (e) {}
    var stackRect = rectOf(stack);
    var stackH = stackRect && stackRect.height > 40 ? stackRect.height : 76;
    var needed = Math.ceil(stackH + (borderBox ? pad : 0));
    box.style.minHeight = Math.max(needed, 96) + "px";
    return true;
  }

  function dropOtherStacks(keep) {
    if (!document.querySelectorAll) return;
    var nodes = document.querySelectorAll("[data-wr-todo-stack]");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] !== keep && nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  function unwrapStack(switcher) {
    var stack = switcher.parentNode;
    if (!stack || attr(stack, "data-wr-todo-stack") !== "1") return;
    var box = stack.parentNode;
    if (box) box.insertBefore(switcher, stack);
    switcher.style.marginInlineStart = stack.style.marginInlineStart || "8px";
    if (stack.parentNode) stack.parentNode.removeChild(stack);
    releaseGrowth(box);
  }

  // Keep the button in normal flow, directly under the switcher, and make the
  // header tall enough for that second row. A header that cannot grow gets the
  // button beside the switcher, never a fixed overlay on the search field.
  function stackUnder(button, switcher) {
    var parent = switcher.parentNode;
    if (!parent) return;
    button.dataset.pin = "";
    button.style.position = "relative";
    button.style.zIndex = "";
    button.style.margin = "0";
    button.style.display = "flex";
    var stacked = attr(parent, "data-wr-todo-stack") === "1";
    var box = stacked ? parent.parentNode : parent;
    var before = rectOf(box);
    if (!canGrow(box)) {
      if (stacked) unwrapStack(switcher);
      insertAfter(switcher, button);
      dropOtherStacks(null);
      return;
    }
    var stack = stacked ? parent : null;
    if (!stack) {
      stack = document.createElement("span");
      stack.setAttribute("data-wr-todo-stack", "1");
      stack.style.cssText = "display:inline-flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:4px;flex:0 0 auto;align-self:flex-start;margin-inline-start:" + (switcher.style.marginInlineStart || "8px");
      switcher.style.margin = "0";
      parent.insertBefore(stack, switcher);
      stack.appendChild(switcher);
    }
    if (switcher.nextElementSibling !== button) stack.appendChild(button);
    if (!growBox(box, stack) || stackCoversNext(box, before, button)) {
      unwrapStack(switcher);
      insertAfter(switcher, button);
      dropOtherStacks(null);
      return;
    }
    dropOtherStacks(stack);
  }

  // A fixed-size header can accept a taller min-height and still paint on top
  // of the search row. If growing it overlaps the next row, or the button
  // still hangs out of it, the button goes beside the switcher instead.
  function stackCoversNext(box, before, button) {
    var after = rectOf(box);
    var buttonRect = rectOf(button);
    if (buttonRect && after && buttonRect.bottom > after.bottom + 2) return true;
    var next = box && box.nextElementSibling;
    var nextRect = next && rectOf(next);
    if (!before || !after || !nextRect || after.height <= before.height + 4) return false;
    var overlap = Math.min(after.bottom, nextRect.bottom) - Math.max(after.top, nextRect.top);
    return overlap > 12;
  }

  function placementFor(switcher) {
    var parent = switcher.parentNode;
    var dir = "";
    var rect = parent ? rectOf(parent) : null;
    try {
      if (parent) dir = getComputedStyle(parent).flexDirection || "";
    } catch (e) {}
    return anchorPlacement("switcher", dir, rect ? rect.width : 0, rect ? rect.height : 0);
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
      if (tabButton && tabButton.parentNode) tabButton.parentNode.removeChild(tabButton);
      fallback.style.display = "inline-flex";
      if (!railWarned) {
        railWarned = true;
        crumb("todo: nav-rail fallback");
      }
      return;
    }
    railWarned = false;
    fallback.style.display = "none";
    if (!tabButton || !tabButton.isConnected) tabButton = buildTab();
    styleTab(tabButton, choice.mode);
    var stacked = choice.el.parentNode && attr(choice.el.parentNode, "data-wr-todo-stack");
    var how = choice.el.id === "__whatrust_accounts" ? placementFor(choice.el) : "after";
    if (choice.el.id === "__whatrust_accounts" && (stacked || how === "below")) stackUnder(tabButton, choice.el);
    else {
      insertAfter(choice.el, tabButton);
      var parentRect = choice.el.parentNode && rectOf(choice.el.parentNode);
      if (choice.el.id === "__whatrust_accounts" && parentRect && parentRect.width < 96) {
        choice.el.style.margin = "4px auto";
        tabButton.style.margin = "4px auto";
      }
    }
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
      invoke("todo_clear_done").then(applyState).catch(saveFailed);
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
    if (title) title.textContent = L("Lista de tarefas", "To-Do");
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
    for (var i = 0; i < items.length; i++) if (items[i] && !items[i].done) openCount += 1;
    if (countEl) countEl.textContent = openCount ? String(openCount) : "";
    shadow.querySelectorAll(".tabs button[data-mode]").forEach(function (button) {
      var mode = button.dataset.mode;
      button.textContent = mode === "open" ? L("Abertas", "Open")
        : mode === "today" ? L("Hoje", "Today")
        : mode === "upcoming" ? L("Em breve", "Upcoming")
        : L("Concluídas", "Done");
      button.setAttribute("aria-selected", String(mode === filterMode));
    });
    if (clearBtn) {
      clearBtn.textContent = L("Limpar concluídas", "Clear completed");
      clearBtn.classList.toggle("show", filterMode === "done");
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
    host.style.left = Math.max(0, rect.left) + "px";
    host.style.top = top + "px";
    host.style.width = rect.width + "px";
    host.style.height = Math.max(120, limit - top) + "px";
  }

  function openPanel(id) {
    stopMenuWatch();
    buildPanel();
    open = true;
    host.style.display = "block";
    applyTheme();
    placePanel();
    if (id) {
      var item = items.filter(function (entry) { return entry.id === id; })[0];
      filterMode = item && item.done ? "done" : "open";
      query = "";
      searchOpen = false;
      if (searchEl) searchEl.value = "";
      expandedId = id;
    }
    renderChrome();
    renderList();
    paintBadge();
    hideCapture();
    if (id) {
      var node = shadow.querySelector('[data-todo-id="' + cssEscape(id) + '"]');
      if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
    }
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
    if (mode === "today") return { title: L("Nada para hoje.", "Nothing due today."), hint: "" };
    if (mode === "upcoming") return { title: L("Nada agendado.", "Nothing scheduled."), hint: "" };
    if (mode === "done") return { title: L("Nenhuma tarefa concluída.", "No completed tasks."), hint: "" };
    return {
      title: L("Nada para fazer.", "Nothing to do."),
      hint: L("Clique com o botão direito em uma mensagem e escolha Adicionar à lista de tarefas.", "Right-click a message and choose Add to To-Do."),
    };
  }

  function renderList() {
    if (!listEl) return;
    renderChrome();
    var shown = filterItems(items, filterMode, query, Date.now(), tzOffset());
    if (filterMode === "done") {
      shown = shown.slice().sort(function (a, b) {
        return (b.completed_at || b.created_at || 0) - (a.completed_at || a.created_at || 0);
      });
    } else shown = sortItems(shown);
    listEl.replaceChildren();
    if (!shown.length) {
      var copy = emptyCopy(filterMode, !!String(query || "").trim());
      var empty = el("p");
      empty.className = "empty";
      empty.appendChild(document.createTextNode(copy.title));
      if (copy.hint) {
        var hint = el("span", copy.hint);
        hint.className = "hint";
        empty.appendChild(hint);
      }
      listEl.appendChild(empty);
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
    return draft;
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
    return snapshot;
  }

  function alarmIds(list) {
    return (list || []).map(function (alarm) { return alarm && alarm.id; }).join("\n");
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
      toastHost.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:100005;display:none;gap:8px;align-items:center;padding:10px 14px;border-radius:12px;background:#111b21;color:#fff;font:14px system-ui;box-shadow:0 8px 24px #0006;max-width:min(440px,calc(100vw - 24px))";
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
      undo.style.cssText = "border:0;background:transparent;color:#7dffb3;cursor:pointer;font:inherit";
      undo.addEventListener("click", function () {
        if (buttonAction.fn) buttonAction.fn();
        toastHost.style.display = "none";
      });
      toastHost.appendChild(undo);
    }
    toastHost.style.display = "flex";
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
    style.textContent = ".card{background:#111b21;color:#fff;border-radius:14px;padding:12px 14px;font:14px/1.4 system-ui;box-shadow:0 8px 24px #0006}.task{font-weight:600;margin:2px 0 8px}.sub{color:#8696a0;font-size:12px;margin-top:-6px;margin-bottom:8px}.row{display:flex;flex-wrap:wrap;gap:6px}button,input{font:inherit}button{border:0;border-radius:8px;padding:6px 8px;background:#2a3942;color:#fff;cursor:pointer}button.primary{background:#1daa61;color:#042}input{margin-top:8px;width:100%;box-sizing:border-box;border:0;border-radius:8px;padding:6px 8px;background:#2a3942;color:#fff}";
    captureShadow.appendChild(style);
    captureHost.addEventListener("mouseenter", function () { clearTimeout(captureTimer); });
    captureHost.addEventListener("mouseleave", scheduleCaptureHide);
    document.documentElement.appendChild(captureHost);
  }

  function scheduleCaptureHide() {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(hideCapture, 9000);
  }

  function showCapture(item, emphasize) {
    if (!item) return;
    ensureCapture();
    var captureShadow = captureHost._shadow;
    var old = captureShadow.querySelector(".card");
    if (old) old.parentNode.removeChild(old);
    var card = el("div");
    card.className = "card";
    var heading = el("div", emphasize
      ? L("Quando devemos lembrar?", "When should we remind you?")
      : L("Adicionada à lista de tarefas.", "Added to the to-do list."));
    var task = el("div", item.title || "");
    task.className = "task";
    card.append(heading, task);
    var msg = item.message;
    if (msg && (msg.chat_name || msg.sender)) {
      var sub = el("div", [msg.chat_name, msg.sender].filter(Boolean).join(" · "));
      sub.className = "sub";
      card.appendChild(sub);
    }
    var row = el("div");
    row.className = "row";
    function act(label, primary, fn) {
      var button = el("button", label);
      button.type = "button";
      if (primary) button.className = "primary";
      button.addEventListener("click", function () { fn(); });
      row.appendChild(button);
      return button;
    }
    act(L("Desfazer", "Undo"), false, function () {
      invoke("todo_delete", { id: item.id }).then(function (snapshot) {
        applyState(snapshot);
        hideCapture();
      }).catch(saveFailed);
    });
    [
      [L("1 h", "1 h"), function () { return Date.now() + 60 * 60000; }],
      [L("Noite", "Evening"), evening],
      [L("Amanhã 9h", "Tomorrow 9am"), tomorrowMorning],
    ].forEach(function (preset) {
      act(preset[0], false, function () {
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
    act(L("Escolher…", "Pick…"), false, function () {
      pick.style.display = "block";
      clearTimeout(captureTimer);
      if (typeof pick.showPicker === "function") {
        try { pick.showPicker(); } catch (e) {}
      }
      pick.focus();
    });
    act(L("Editar", "Edit"), true, function () {
      hideCapture();
      openPanel(item.id);
    });
    card.append(row, pick);
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
      chat_id: extract.chat_id || null,
      chat_name: extract.chat_name || activeChatName(),
      sender: extract.sender || "",
      snippet: extract.snippet || "",
      msg_timestamp: extract.msg_timestamp || null,
      kind: extract.kind || "other",
    };
    var title = (msg.snippet || "").split("\n")[0].trim() || defaultTitle(msg.kind);
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

  function enrich(extract) {
    var wpp = root.WPP;
    if (!extract || !wpp || !wpp.isReady || !wpp.chat || typeof wpp.chat.getMessageById !== "function" || !extract.msg_id) {
      return Promise.resolve(extract);
    }
    return wpp.chat.getMessageById(extract.msg_id).then(function (msg) {
      if (!msg) return extract;
      var type = msg.type || (msg.attributes && msg.attributes.type) || "";
      if (type === "ptt" || type === "audio") extract.kind = "voice";
      else if (type === "image") extract.kind = "image";
      else if (type === "video") extract.kind = "video";
      else if (type === "document") extract.kind = "document";
      else if (type === "chat" && extract.kind === "other") extract.kind = "text";
      var body = msg.body || msg.caption || (msg.attributes && (msg.attributes.body || msg.attributes.caption)) || "";
      if (body && !extract.snippet) extract.snippet = String(body).slice(0, 1000);
      var remote = msg.id && (msg.id.remote || msg.id.from);
      var serializedRemote = remote && (remote._serialized || remote);
      if (!extract.chat_id && typeof serializedRemote === "string") extract.chat_id = serializedRemote;
      if (!extract.chat_name && msg.chat && msg.chat.name) extract.chat_name = String(msg.chat.name).slice(0, 160);
      var serialized = "";
      if (typeof msg.id === "string") serialized = msg.id;
      else if (msg.id && typeof msg.id._serialized === "string") serialized = msg.id._serialized;
      if (/^(?:true|false)_[^_\s]+@[^_\s]+_/.test(serialized) && serialized.length <= 180) {
        extract.msg_id = serialized;
      }
      return extract;
    }).catch(function () { return extract; });
  }

  function menuLabel(action) {
    if (action === "add") return L("Adicionar à lista de tarefas", "Add to To-Do");
    if (action === "remind") return L("Lembrar desta mensagem…", "Remind me about this…");
    if (action === "open") return L("Abrir na lista de tarefas", "Open in To-Do");
    return L("Concluir tarefa", "Mark done");
  }

  function runMenuAction(action, extract, existing) {
    if (action === "add") enrich(extract).then(function (next) { addExtract(next, null); });
    else if (action === "remind") enrich(extract).then(function (next) { addExtract(next, { remind: true }); });
    else if (action === "open" && existing) openPanel(existing.id);
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

  function sampleRow(menu) {
    var rows = menuRows(menu);
    return rows.length ? rows[0] : null;
  }

  function writeLabel(node, label) {
    var target = null;
    var best = -1;
    walk(node, function (elNode) {
      var kids = elNode.children || [];
      if (kids.length) return;
      var text = String(elNode.textContent || "").trim();
      if (text.length >= best) {
        target = elNode;
        best = text.length;
      }
    });
    walk(node, function (elNode) {
      if (elNode === target || !elNode.childNodes) return;
      for (var i = elNode.childNodes.length - 1; i >= 0; i--) {
        if (elNode.childNodes[i].nodeType === 3) elNode.removeChild(elNode.childNodes[i]);
      }
    });
    if (target) target.textContent = label;
    else node.textContent = label;
  }

  function makeMenuNode(menu, label, action) {
    var sample = sampleRow(menu);
    var node;
    var cloned = false;
    if (sample && sample.cloneNode) {
      try {
        node = sample.cloneNode(true);
        cloned = true;
      } catch (e) {
        node = null;
      }
    }
    if (cloned && node) {
      if (node.removeAttribute) node.removeAttribute("id");
      var icons = [];
      walk(node, function (elNode) {
        if (tagIs(elNode, "svg") || tagIs(elNode, "img") || attr(elNode, "data-icon")) icons.push(elNode);
      });
      for (var i = 0; i < icons.length; i++) {
        if (icons[i].parentNode) icons[i].parentNode.removeChild(icons[i]);
      }
      writeLabel(node, label);
      if (String(node.textContent || "").replace(/\s+/g, " ").trim() !== label) node.textContent = label;
    } else {
      var tag = String(menu.tagName || "").toLowerCase() === "ul" ? "li" : "button";
      node = el(tag, label);
      node.style.cssText = "display:block;width:100%;text-align:start;padding:10px 16px;cursor:pointer;background:transparent;border:0;color:inherit;font:inherit";
    }
    node.setAttribute("data-wr-todo-menu", "1");
    if (node.style) node.style.cursor = "pointer";
    node.addEventListener("mousedown", function (event) {
      event.preventDefault();
      event.stopPropagation();
    }, true);
    node.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      action();
    }, true);
    return node;
  }

  function countOurs(menu) {
    var n = 0;
    var visible = 0;
    walk(menu, function (node) {
      if (!attr(node, "data-wr-todo-menu")) return;
      n += 1;
      var rect = rectOf(node);
      if (rect && rect.width > 40 && rect.height > 10) visible += 1;
    });
    return { n: n, visible: visible };
  }

  function stripOurs(menu) {
    var found = [];
    walk(menu, function (node) {
      if (attr(node, "data-wr-todo-menu")) found.push(node);
    });
    for (var i = 0; i < found.length; i++) {
      if (found[i].parentNode) found[i].parentNode.removeChild(found[i]);
    }
  }

  function injectMenu(menu, extract) {
    if (!menu || !extract) return;
    stripOurs(menu);
    var existing = lookupExtract(extract);
    var sample = sampleRow(menu);
    var parent = sample && sample.parentNode ? sample.parentNode : menu;
    var anchor = sample || null;
    menuActions(existing).forEach(function (action) {
      var node = makeMenuNode(menu, menuLabel(action), function () {
        runMenuAction(action, extract, existing);
      });
      if (anchor && anchor.parentNode === parent) parent.insertBefore(node, anchor);
      else parent.appendChild(node);
    });
  }

  function ensureCompanion() {
    if (companion) return;
    companion = el("div");
    companion.id = "__whatrust_todo_menu";
    companion.setAttribute("popover", "manual");
    companion.style.cssText = "position:fixed;z-index:100003;display:none;box-sizing:border-box;overflow:hidden;box-shadow:0 12px 28px #0006;margin:0;border:0;padding:0;inset:auto";
    document.documentElement.appendChild(companion);
  }

  function presentCompanion() {
    companion.style.display = "block";
    companion.style.margin = "0";
    companion.style.border = "0";
    if (typeof companion.showPopover !== "function") return;
    try {
      if (!companion.matches || !companion.matches(":popover-open")) companion.showPopover();
    } catch (e) {}
  }

  function hideCompanion() {
    companionKey = "";
    if (!companion) return;
    companion.style.display = "none";
    if (typeof companion.hidePopover !== "function") return;
    try { companion.hidePopover(); } catch (e) {}
  }

  function fillCompanion(existing, extract) {
    companion.replaceChildren();
    menuActions(existing).forEach(function (action) {
      var button = el("button", menuLabel(action));
      button.type = "button";
      button.style.cssText = "display:block;width:100%;text-align:start;padding:10px 14px;border:0;border-top:1px solid #8696a033;background:transparent;color:inherit;font:14px system-ui;cursor:pointer";
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        runMenuAction(action, extract, existing);
      });
      companion.appendChild(button);
    });
  }

  function showCompanion(menu, extract) {
    ensureCompanion();
    var existing = lookupExtract(extract);
    var key = existing ? "open:" + existing.id : "add:" + (extract.msg_token || extract.msg_id || "");
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
    var bg = themeDark() ? "#233138" : "#ffffff";
    try {
      var color = getComputedStyle(menu).backgroundColor;
      if (color && color !== "transparent" && color.indexOf("0, 0, 0, 0") === -1) bg = color;
    } catch (e) {}
    companion.style.background = bg;
    companion.style.color = themeDark() ? "#e9edef" : "#111b21";
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
    var key = "point:" + (existing ? existing.id : (extract.msg_token || extract.msg_id || ""));
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
    companion.style.background = themeDark() ? "#233138" : "#ffffff";
    companion.style.color = themeDark() ? "#e9edef" : "#111b21";
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
    var ours = countOurs(menu);
    if (ours.visible < 2 && menuInjects < 2) {
      menuInjects += 1;
      injectMenu(menu, pending.extract);
      ours = countOurs(menu);
    }
    if (ours.visible >= 2) hideCompanion();
    else showCompanion(menu, pending.extract);
  }

  function stopMenuWatch() {
    pending = null;
    menuFound = false;
    menuInjects = 0;
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
    menuInjects = 0;
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
        // The native menu can close because our menu took focus. Keep the
        // actions on screen until the user picks one or clicks away.
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
      if (attr(cur, "data-wr-todo-hover") || attr(cur, "data-wr-todo-badge") || attr(cur, "data-wr-todo-menu")) return true;
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

  function ensureHover() {
    if (hover) return;
    hover = el("button", "+");
    hover.type = "button";
    hover.setAttribute("data-wr-todo-hover", "1");
    hover.style.cssText = "position:fixed;z-index:20;width:22px;height:22px;border-radius:6px;cursor:pointer;display:none;font:14px/20px system-ui;padding:0";
    hover.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (hover._item) openPanel(hover._item.id);
      else enrich(hover._extract).then(function (next) { addExtract(next, null); });
    });
    hover.addEventListener("mouseenter", function () { clearTimeout(hoverTimer); });
    hover.addEventListener("mouseleave", hideHoverSoon);
    document.documentElement.appendChild(hover);
  }

  function hideHoverSoon() {
    clearTimeout(hoverTimer);
    hoverRow = null;
    hoverTimer = setTimeout(function () {
      if (hover) hover.style.display = "none";
    }, 250);
  }

  function positionHover(row) {
    ensureHover();
    var rect = rectOf(row);
    if (!rect) return;
    if (row !== hoverRow || hover.style.display !== "block") {
      var extract = extractDom(row);
      if (!extract) return;
      hoverRow = row;
      hover._extract = extract;
      hover._item = lookupExtract(extract);
      hover.textContent = hover._item ? "✓" : "+";
      hover.title = hover._item ? L("Abrir na lista de tarefas", "Open in To-Do") : L("Adicionar à lista de tarefas", "Add to To-Do");
      var dark = themeDark();
      hover.style.background = dark ? "#111b21cc" : "#ffffffcc";
      hover.style.color = dark ? "#d1d7db" : "#3b4a54";
      hover.style.border = "1px solid " + (dark ? "#ffffff22" : "#00000022");
    }
    hover.style.display = "block";
    if (rect.height < 72) {
      hover.style.left = Math.max(8, rect.left + 8) + "px";
      hover.style.top = Math.max(8, rect.top + (rect.height - 22) / 2) + "px";
    } else {
      hover.style.left = Math.max(8, rect.right - 30) + "px";
      hover.style.top = Math.max(8, rect.bottom - 28) + "px";
    }
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
      var item = tracked[attr(row, "data-id")] || tracked[token];
      var badge = directBadge(row);
      if (!item) {
        if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
        continue;
      }
      var mark = item.done ? "✓" : "•";
      var tone = item.fired && !item.done ? "#d34545" : "#1daa61";
      if (!badge) {
        badge = el("button", mark);
        badge.type = "button";
        badge.setAttribute("data-wr-todo-badge", item.id);
        badge.style.cssText = "position:absolute;left:2px;top:2px;z-index:3;width:18px;height:18px;border:0;border-radius:50%;background:" + tone + ";color:#042;font:12px system-ui;cursor:pointer;padding:0";
        (function (node) {
          node.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            openPanel(node.getAttribute("data-wr-todo-badge"));
          });
        })(badge);
        try {
          if (getComputedStyle(row).position === "static") row.style.position = "relative";
        } catch (e) {}
        row.appendChild(badge);
      } else if (badge.textContent !== mark) {
        badge.textContent = mark;
      }
      badge.style.background = tone;
      if (attr(badge, "data-wr-todo-badge") !== item.id) badge.setAttribute("data-wr-todo-badge", item.id);
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

  function openBottom(chat) {
    var wpp = root.WPP;
    if (!chat || !wpp || !wpp.chat || typeof wpp.chat.openChatBottom !== "function") {
      showToast(L("Não foi possível abrir essa mensagem.", "Could not open that message."));
      return;
    }
    Promise.resolve(wpp.chat.openChatBottom(chat)).then(function () {
      showToast(L("A conversa foi aberta. A mensagem não está mais no histórico local.", "The chat was opened. That message is no longer in local history."));
    }).catch(function () {
      showToast(L("Não foi possível abrir essa mensagem.", "Could not open that message."));
    });
  }

  function tryOpenAt(item, ids, index) {
    var chat = item.message && item.message.chat_id;
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
      style.textContent = ".card{background:#111b21;color:#fff;border-radius:12px;padding:12px;margin:0 0 8px;font:14px system-ui;box-shadow:0 8px 24px #0006}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}button{border:0;border-radius:8px;padding:6px 8px;background:#2a3942;color:#fff;cursor:pointer}button.primary{background:#1daa61;color:#042}";
      alarmShadow.appendChild(style);
      document.documentElement.appendChild(alarmHost);
    }
    var cards = alarmShadow.querySelectorAll(".card");
    for (var c = 0; c < cards.length; c++) cards[c].parentNode.removeChild(cards[c]);
    if (!lastAlarms.length) {
      alarmHost.style.display = "none";
      return;
    }
    alarmHost.style.display = "block";
    if (summary && lastAlarms.length > 1) {
      var intro = el("div");
      intro.className = "card";
      intro.textContent = L("Lembretes pendentes", "Pending reminders") + ": " + lastAlarms.length;
      alarmShadow.appendChild(intro);
    }
    lastAlarms.forEach(function (alarm) {
      var card = el("div");
      card.className = "card";
      var title = el("div", alarm.title || L("Lembrete", "Reminder"));
      var row = el("div");
      row.className = "row";
      function act(label, primary, fn) {
        var button = el("button", label);
        button.type = "button";
        if (primary) button.className = "primary";
        button.addEventListener("click", fn);
        row.appendChild(button);
      }
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
      var match = items.filter(function (item) { return item.id === alarm.id; })[0];
      if (match && match.message) {
        act(L("Abrir", "Open"), false, function () { jumpTo(match); });
      }
      card.append(title, row);
      alarmShadow.appendChild(card);
    });
  }

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

  document.addEventListener("mouseover", function (event) {
    var row = rowOf(event.target);
    if (!row || !inMain(row)) return;
    if (isChevronTarget(event.target) || isRowMenuButton(event.target, row)) {
      hideHoverSoon();
      return;
    }
    clearTimeout(hoverTimer);
    positionHover(row);
  }, true);

  document.addEventListener("mouseout", function (event) {
    if (!hover || hover.style.display === "none") return;
    if (event.relatedTarget === hover) return;
    hideHoverSoon();
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
    closePanel();
  }, true);

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      mountRail();
      paintMarkers();
      if (open) placePanel();
    }, 200);
  }

  function arm() {
    if (!document.documentElement) return;
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("scroll", function () {
      if (hover) hover.style.display = "none";
      if (!menuFound && pending && pending.fallback && Date.now() - pending.at > 700 && companion && companion.style.display !== "none") {
        stopMenuWatch();
      }
      schedule();
    }, true);
    root.addEventListener("resize", schedule);
    schedule();
    refresh();
    crumb("todo: injected");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arm);
  else arm();

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });

  // The badge is a local-time idea, so it goes stale across midnight even when
  // nothing else changes. The message markers do not depend on the clock.
  setInterval(paintBadge, 60_000);
})();

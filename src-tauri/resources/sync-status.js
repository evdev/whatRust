/* Offline indicator for a WhatsApp session that stopped syncing.
 *
 * After the computer sleeps, or the window sits unused, WhatsApp's socket can
 * die while the chat list still looks signed in. The page then has no banner
 * and its own reconnect control never appears, so there is nothing to click.
 * This watches the session and, when sync is gone or can no longer be trusted,
 * shows a small rail button with Reconnect. Reconnect uses the same recovery as a stuck
 * WhatsApp reconnect button: drop the service worker, then reload the page.
 *
 * The socket's own state is not enough. On a live session it stays the string
 * "CONNECTED" while the bytes move on a MessagePort, not on the Worker
 * "message" event. A reading that merely stayed connected, or a network
 * "online" event after wake, is not proof that sync resumed. Incoming port
 * messages are. A few minutes without one means the session has stopped,
 * including when timers kept running and the clock never jumped.
 */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;

  var LIMITS = {
    stallMs: 3 * 60 * 1000,
    hiddenStallMs: 30 * 60 * 1000,
    // A freeze this long is a night away. Give a living channel a few seconds
    // to deliver a message before warning; a reconnect still gets the longer grace.
    immediateMs: 10 * 60 * 1000,
    proveMs: 5 * 1000,
    graceMs: 20 * 1000,
    holdMs: 12 * 1000,
    pendingHoldMs: 30 * 1000,
    browserHoldMs: 4 * 1000,
    trafficSettleMs: 2 * 1000,
  };
  var PENDING = { OPENING: 1, PAIRING: 1, SYNCING: 1, RESUMING: 1, CONNECTING: 1 };
  var DEAD_TRANSPORT = { DISCONNECTED: 1, DISCONNECTING: 1, OFFLINE: 1 };
  // Phrases WhatsApp shows when the linked computer is down. Kept off the
  // message list: a quoted "not connected" inside a chat is not the banner.
  var OFFLINE_TEXT = /phone not connected|computer not connected|your computer is not connected|not connected to the internet|no internet|click to reconnect|telefone desconectado|computador desconectado|computador n[aã]o est[aá] conectad|n[aã]o est[aá] conectad|sem conex[aã]o|sem internet|clique para reconectar|tel[eé]fono desconectado|sin conexi[oó]n|sin internet|haz clic para volver a conectar|nicht verbunden|keine verbindung|erneut verbinden|pas connect[eé]|aucune connexion|se reconnecter/i;

  function L(pt, en) {
    return root.__WR_LANG === "en" ? en : pt;
  }

  function clone(state) {
    return {
      lastTick: state.lastTick,
      wakeAt: state.wakeAt,
      stallGap: state.stallGap,
      stallToken: state.stallToken,
      hiddenAt: state.hiddenAt,
      trafficAt: state.trafficAt,
      liveSince: state.liveSince,
      sawLiveEvent: state.sawLiveEvent,
      reading: state.reading,
      offlineSince: state.offlineSince,
      pendingSince: state.pendingSince,
      browserOfflineSince: state.browserOfflineSince,
      domOffline: state.domOffline,
      loggedIn: state.loggedIn,
      dismissedReason: state.dismissedReason,
    };
  }

  function initialState() {
    return {
      lastTick: null,
      wakeAt: null,
      stallGap: 0,
      stallToken: 0,
      hiddenAt: null,
      trafficAt: null,
      liveSince: null,
      sawLiveEvent: false,
      reading: null,
      offlineSince: null,
      pendingSince: null,
      browserOfflineSince: null,
      domOffline: false,
      loggedIn: false,
      dismissedReason: "",
    };
  }

  function enumName(wpp, value, name) {
    if (value == null) return "";
    var table = wpp && wpp.whatsapp && wpp.whatsapp.enums && wpp.whatsapp.enums[name];
    if (table) {
      for (var key in table) {
        if (Object.prototype.hasOwnProperty.call(table, key) && table[key] === value) return String(key);
      }
    }
    return typeof value === "string" ? value : "";
  }

  // null: WA-JS is not on the page yet. pending: WhatsApp is mid-handshake.
  // live: socket and network both say the session can receive messages.
  function connectionReading(wpp) {
    if (!wpp || !wpp.conn) return null;
    var online;
    try {
      online = typeof wpp.conn.isOnline === "function" ? wpp.conn.isOnline() : undefined;
    } catch (e) {
      online = undefined;
    }
    var stream = {};
    try {
      if (typeof wpp.conn.getStreamData === "function") stream = wpp.conn.getStreamData() || {};
    } catch (e2) {
      stream = {};
    }
    var sock = null;
    try {
      sock = wpp.whatsapp && wpp.whatsapp.Socket;
    } catch (e3) {
      sock = null;
    }
    var stateName = enumName(wpp, sock && sock.state, "SOCKET_STATE");
    var transportName = enumName(wpp, sock && sock.stream, "SOCKET_STREAM");
    var hasSocket = !!(sock && sock.state != null);
    if (online === false || DEAD_TRANSPORT[transportName]) return { live: false, pending: false };
    if (hasSocket) {
      if (stateName === "CONNECTED") {
        if (PENDING[transportName]) return { live: false, pending: true };
        return { live: true, pending: false };
      }
      if (!stateName || PENDING[stateName]) return { live: false, pending: true };
      return { live: false, pending: false };
    }
    var mode = stream.mode || "";
    var info = stream.info || "";
    if (mode === "QR" || PENDING[info] || mode === "SYNCING") return { live: false, pending: true };
    if (mode === "MAIN" && info === "NORMAL") return { live: true, pending: false };
    if (
      mode === "OFFLINE" ||
      info === "OFFLINE" ||
      mode === "CONFLICT" ||
      mode === "PROXYBLOCK" ||
      mode === "TOS_BLOCK" ||
      mode === "SMB_TOS_BLOCK" ||
      mode === "DEPRECATED_VERSION"
    ) {
      return { live: false, pending: false };
    }
    return { live: false, pending: true };
  }

  function pageSaysOffline(doc) {
    if (!doc || !doc.querySelectorAll) return false;
    var nodes;
    try {
      nodes = doc.querySelectorAll("[role='alert'], [role='status'], [data-testid*='alert'], [data-testid*='reconnect'], [data-icon='alert-phone'], [data-icon='alert-computer']");
    } catch (e) {
      return false;
    }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el) continue;
      if (el.closest && el.closest("#__whatrust_sync_tab, [data-whatrust-sync], #main, [data-id]")) continue;
      var text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length < 240 && OFFLINE_TEXT.test(text)) return true;
    }
    return false;
  }

  function chatsOpen(doc) {
    if (!doc || !doc.getElementById) return false;
    if (!doc.getElementById("pane-side") && !doc.getElementById("side")) return false;
    try {
      if (doc.querySelector && doc.querySelector("[data-testid='qrcode'], [data-testid='link-device-qrcode'], [data-testid='qr-code']")) return false;
    } catch (e) {}
    return true;
  }

  function armStall(state, now, gap) {
    var next = clone(state);
    next.wakeAt = now;
    next.stallGap = gap > 0 ? gap : 0;
    next.stallToken = (state.stallToken || 0) + 1;
    next.trafficAt = null;
    next.sawLiveEvent = false;
    return next;
  }

  function noteTick(state, now, stallMs) {
    var next = clone(state);
    var gap = state.lastTick == null ? 0 : now - state.lastTick;
    if (state.lastTick != null && gap >= stallMs) next = armStall(next, now, gap);
    next.lastTick = now;
    return next;
  }

  function noteVisibility(state, hidden, now, hiddenStallMs) {
    var next = clone(state);
    if (hidden) {
      if (state.hiddenAt == null) next.hiddenAt = now;
      return next;
    }
    if (state.hiddenAt != null && now - state.hiddenAt >= hiddenStallMs) next = armStall(next, now, now - state.hiddenAt);
    next.hiddenAt = null;
    return next;
  }

  function noteTraffic(state, now) {
    var next = clone(state);
    next.trafficAt = now;
    return next;
  }

  function noteReading(state, reading, now, fromEvent) {
    // The event flag still forces an immediate recheck. It is not evidence:
    // wake fires "online" while a dead socket stays CONNECTED.
    void fromEvent;
    var next = clone(state);
    var was = state.reading;
    next.reading = reading;
    if (reading && reading.pending) {
      if (state.pendingSince == null) next.pendingSince = now;
    } else {
      next.pendingSince = null;
    }
    if (reading && reading.live === false && !reading.pending) {
      if (state.offlineSince == null) next.offlineSince = now;
    } else {
      next.offlineSince = null;
    }
    if (reading && reading.live) {
      if (state.liveSince == null) next.liveSince = now;
    } else {
      next.liveSince = null;
    }
    // A network "online" event while the socket never left CONNECTED is how a
    // dead session looks after wake. Only a real drop-and-return counts.
    if (state.wakeAt && reading && reading.live && was && was.live === false) next.sawLiveEvent = true;
    return next;
  }

  function noteBrowser(state, online, now) {
    var next = clone(state);
    if (online) next.browserOfflineSince = null;
    else if (state.browserOfflineSince == null) next.browserOfflineSince = now;
    return next;
  }

  function noteDom(state, offline) {
    var next = clone(state);
    next.domOffline = !!offline;
    return next;
  }

  function noteLoggedIn(state, loggedIn) {
    var next = clone(state);
    next.loggedIn = !!loggedIn;
    return next;
  }

  function elapsed(since, now) {
    if (since == null) return 0;
    var gap = now - since;
    return gap > 0 ? gap : 0;
  }

  function judge(s) {
    if (!s.loggedIn) return "hidden";
    var reason = "hidden";
    var reading = s.reading;
    if (s.domOffline) reason = "offline";
    else if ((s.browserOfflineForMs || 0) >= s.browserHoldMs) reason = "offline";
    else if (reading && reading.pending && (s.pendingForMs || 0) >= s.pendingHoldMs) reason = "offline";
    else if (reading && reading.live === false && !reading.pending && (s.offlineForMs || 0) >= s.holdMs) reason = "offline";
    else if (s.stalled && !(reading && reading.pending) && (s.sinceWakeMs || 0) >= s.graceMs && !s.confirmedSinceWake) reason = "stale";
    else if (s.trafficSilent && !(s.stalled && (s.sinceWakeMs || 0) < s.graceMs)) reason = "stale";
    if (reason !== "hidden" && s.dismissedReason === reason) return "hidden";
    return reason;
  }

  function graceFor(gap, limits) {
    var lim = limits || LIMITS;
    return (gap || 0) >= lim.immediateMs ? lim.proveMs : lim.graceMs;
  }

  function assess(state, now, limits) {
    var lim = limits || LIMITS;
    var stalled = state.wakeAt != null;
    var reading = state.reading;
    var live = !!(reading && reading.live);
    var confirmed = !stalled || !!(
      (state.sawLiveEvent && live) ||
      (state.trafficAt != null && state.trafficAt >= state.wakeAt + lim.trafficSettleMs && live)
    );
    var trafficAge = state.trafficAt == null ? null : elapsed(state.trafficAt, now);
    var liveFor = elapsed(state.liveSince, now);
    var trafficSilent = !!(
      live &&
      state.liveSince != null &&
      liveFor >= lim.stallMs &&
      (trafficAge == null || trafficAge >= lim.stallMs)
    );
    return judge({
      loggedIn: state.loggedIn,
      domOffline: state.domOffline,
      browserOfflineForMs: elapsed(state.browserOfflineSince, now),
      reading: reading,
      offlineForMs: elapsed(state.offlineSince, now),
      pendingForMs: elapsed(state.pendingSince, now),
      stalled: stalled,
      sinceWakeMs: stalled ? elapsed(state.wakeAt, now) : 0,
      confirmedSinceWake: confirmed,
      trafficSilent: trafficSilent,
      dismissedReason: state.dismissedReason || "",
      graceMs: graceFor(state.stallGap, lim),
      holdMs: lim.holdMs,
      pendingHoldMs: lim.pendingHoldMs,
      browserHoldMs: lim.browserHoldMs,
    });
  }

  function settleDismiss(state, now, limits) {
    var next = clone(state);
    if (assess(withDismiss(state, ""), now, limits) === "hidden") next.dismissedReason = "";
    return next;
  }

  function withDismiss(state, reason) {
    var next = clone(state);
    next.dismissedReason = reason;
    return next;
  }

  function noteDismiss(state, now, limits) {
    var reason = assess(withDismiss(state, ""), now, limits);
    if (reason === "hidden") return clone(state);
    return withDismiss(state, reason);
  }

  // WhatsApp delivers socket traffic on a MessagePort (and sometimes a Worker
  // onmessage). The Worker "message" event on the constructor stays quiet, so
  // a hook there never learns that sync is alive. Wrap the listeners the page
  // installs afterwards. removeEventListener has to see the same function the
  // page passed in, or WhatsApp leaks a handler every time it rebinds.
  function watchSocketMessages(target) {
    var pairs = typeof target.WeakMap === "function" ? new target.WeakMap() : null;
    var keys = pairs ? null : [];
    var vals = pairs ? null : [];
    function remember(fn, wrapped) {
      if (pairs) pairs.set(fn, wrapped);
      else { keys.push(fn); vals.push(wrapped); }
    }
    function recall(fn) {
      if (!fn) return fn;
      if (pairs) return pairs.has(fn) ? pairs.get(fn) : null;
      var i = keys.indexOf(fn);
      return i === -1 ? null : vals[i];
    }
    function bump() {
      if (typeof target.__wrSyncTraffic === "function") target.__wrSyncTraffic();
    }
    function wrapListener(fn) {
      if (!fn || fn.__wrSyncMsg) return fn;
      var prev = recall(fn);
      if (prev) return prev;
      var wrapped;
      if (typeof fn === "function") {
        wrapped = function () {
          bump();
          return fn.apply(this, arguments);
        };
      } else if (typeof fn === "object" && typeof fn.handleEvent === "function") {
        var inner = fn.handleEvent;
        wrapped = {
          handleEvent: function () {
            bump();
            return inner.apply(fn, arguments);
          }
        };
      } else {
        return fn;
      }
      wrapped.__wrSyncMsg = true;
      remember(fn, wrapped);
      return wrapped;
    }
    function patch(proto) {
      if (!proto || proto.__wrSyncMsgPatch) return;
      var add = proto.addEventListener;
      var remove = proto.removeEventListener;
      var desc = null;
      try { desc = Object.getOwnPropertyDescriptor(proto, "onmessage"); } catch (e) { desc = null; }
      if (typeof add !== "function" && !(desc && typeof desc.set === "function")) return;
      if (typeof add === "function") {
        proto.addEventListener = function (type, fn, opts) {
          if (type === "message") fn = wrapListener(fn);
          return add.call(this, type, fn, opts);
        };
        if (typeof remove === "function") {
          proto.removeEventListener = function (type, fn, opts) {
            if (type === "message") fn = recall(fn) || fn;
            return remove.call(this, type, fn, opts);
          };
        }
      }
      if (desc && typeof desc.set === "function") {
        try {
          Object.defineProperty(proto, "onmessage", {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set: function (fn) { return desc.set.call(this, wrapListener(fn)); }
          });
        } catch (e2) {}
      }
      proto.__wrSyncMsgPatch = true;
    }
    patch(target.MessagePort && target.MessagePort.prototype);
    patch(target.Worker && target.Worker.prototype);
  }

  function watchWorkers(target) {
    var current = target.Worker;
    if (typeof current !== "function" || current.__wrSyncWatch) return;
    function Watched(url, opts) {
      var worker = new current(url, opts);
      try {
        worker.addEventListener("message", function () {
          if (typeof target.__wrSyncTraffic === "function") target.__wrSyncTraffic();
        });
      } catch (e) {}
      return worker;
    }
    Watched.prototype = current.prototype;
    Watched.__wrSyncWatch = true;
    try {
      Object.setPrototypeOf(Watched, current);
    } catch (e2) {}
    try {
      target.Worker = Watched;
    } catch (e3) {}
  }

  function mount(target) {
    if (target.__wrSyncMounted) return;
    target.__wrSyncMounted = true;
    var doc = target.document;
    if (!doc || !doc.documentElement) {
      target.__wrSyncMounted = false;
      var retry = function () { mount(target); };
      if (typeof target.setTimeout === "function") target.setTimeout(retry, 500);
      else setTimeout(retry, 500);
      return;
    }
    var state = initialState();
    var reported = null;
    var graceTimer = 0;
    var eventPending = false;
    var trafficPending = false;
    var trafficQueued = false;
    var RECONNECT_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
    // A small rail button, not a banner: it joins the whatRust shortcut stack
    // so it sits above the Media icon and clear of Meta AI, never covering
    // the conversation.
    var tab = doc.createElement("button");
    tab.type = "button";
    tab.id = "__whatrust_sync_tab";
    try { tab.innerHTML = RECONNECT_SVG; } catch (svgErr) { tab.textContent = "↻"; }
    tab.setAttribute("data-whatrust-sync", "1");
    tab.setAttribute("role", "status");
    tab.setAttribute("aria-live", "polite");
    tab.hidden = true;
    tab.style.cssText = "width:40px;height:40px;margin:4px auto;padding:0;border:0;border-radius:12px;display:none;align-items:center;justify-content:center;cursor:pointer;flex:none;position:relative";
    function todoStack() {
      if (!doc.querySelector) return null;
      try {
        return doc.querySelector("[data-wr-todo-stack='native']") || doc.querySelector("[data-wr-todo-stack='1']");
      } catch (stackErr) { return null; }
    }
    function placeTab() {
      var stack = todoStack();
      if (stack) {
        var switcher = false;
        try { switcher = stack.getAttribute && stack.getAttribute("data-wr-todo-stack") === "1"; } catch (modeErr) {}
        tab.style.position = "relative";
        tab.style.left = "";
        tab.style.right = "";
        tab.style.top = "";
        tab.style.bottom = "";
        tab.style.zIndex = "";
        tab.style.margin = switcher ? "0" : "4px auto";
        tab.style.width = switcher ? "36px" : "40px";
        tab.style.height = switcher ? "36px" : "40px";
        tab.style.borderRadius = switcher ? "50%" : "12px";
        var last = stack.lastElementChild !== undefined ? stack.lastElementChild : stack.lastChild;
        if (tab.parentNode !== stack || last !== tab) stack.appendChild(tab);
      } else {
        if (tab.parentNode !== doc.documentElement) doc.documentElement.appendChild(tab);
        tab.style.position = "fixed";
        tab.style.left = "12px";
        tab.style.bottom = "188px";
        tab.style.zIndex = "100000";
        tab.style.margin = "0";
        tab.style.width = "40px";
        tab.style.height = "40px";
        tab.style.borderRadius = "12px";
      }
    }
    placeTab();
    function stop(event) {
      if (event && event.stopPropagation) event.stopPropagation();
    }
    function paint(reason) {
      var show = reason === "offline" || reason === "stale";
      if (show) placeTab();
      else if (!tab.isConnected && doc.documentElement) placeTab();
      tab.hidden = !show;
      tab.style.display = show ? "flex" : "none";
      if (!show) return;
      if (reason === "offline") {
        tab.style.background = "#d34545";
        tab.style.color = "#fff";
      } else {
        tab.style.background = "#f0bd68";
        tab.style.color = "#30230b";
      }
      var sentence = reason === "offline"
        ? L("O WhatsApp está offline.", "WhatsApp is offline.")
        : L("O WhatsApp parou de sincronizar.", "WhatsApp stopped syncing.");
      var action = L("Reconectar", "Reconnect");
      var full = sentence + " — " + action;
      tab.title = full;
      tab.setAttribute("aria-label", full);
    }
    function invoke(cmd, args) {
      var tauri = target.__TAURI__;
      if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") return Promise.resolve(false);
      return Promise.resolve(tauri.core.invoke(cmd, args)).then(function () { return true; }, function () { return false; });
    }
    function report(offline, shown) {
      if (target.__whatrustLocked) {
        reported = null;
        return;
      }
      if (reported === offline) return;
      var pending = offline;
      invoke("report_sync_offline", { offline: offline }).then(function (ok) {
        if (ok) reported = pending;
      });
      if (shown) invoke("dlog", { msg: "sync: offline button shown" });
    }
    // A suspicion can be dismissed. A session that is actually down stays on
    // the tray, so Reconnect is still there after the bar is closed.
    function publish() {
      var now = Date.now();
      state = settleDismiss(state, now, LIMITS);
      var raw = assess(withDismiss(state, ""), now, LIMITS);
      var shown = assess(state, now, LIMITS);
      paint(shown);
      report(raw === "offline" || shown !== "hidden", shown !== "hidden");
    }
    var wppBound = false;
    var socketBound = false;
    function bindWpp() {
      var wpp = target.WPP;
      if (!wpp) return;
      function liveEvent() {
        eventPending = true;
        check();
      }
      if (!wppBound && typeof wpp.on === "function") {
        wppBound = true;
        ["conn.online", "conn.stream_mode_changed", "conn.stream_info_changed"].forEach(function (name) {
          try { wpp.on(name, liveEvent); } catch (e) {}
        });
      }
      var sock = null;
      try { sock = wpp.whatsapp && wpp.whatsapp.Socket; } catch (e2) {}
      if (sock && !socketBound && typeof sock.on === "function") {
        socketBound = true;
        try { sock.on("change:state", liveEvent); } catch (e3) {}
        try { sock.on("change:stream", liveEvent); } catch (e4) {}
      }
    }
    function scheduleGrace() {
      if (graceTimer || state.wakeAt == null) return;
      var left = graceFor(state.stallGap) - (Date.now() - state.wakeAt);
      if (left < 0) return;
      graceTimer = 1;
      var fire = function () {
        graceTimer = 0;
        check();
      };
      // Called as a method: a bare setTimeout throws in the webview.
      if (typeof target.setTimeout === "function") target.setTimeout(fire, left + 50);
      else setTimeout(fire, left + 50);
    }
    function check() {
      bindWpp();
      var now = Date.now();
      state = noteTick(state, now, LIMITS.stallMs);
      state = noteLoggedIn(state, chatsOpen(doc));
      state = noteDom(state, pageSaysOffline(doc));
      var online = true;
      try {
        if (target.navigator && target.navigator.onLine === false) online = false;
      } catch (e) {}
      state = noteBrowser(state, online, now);
      if (trafficPending) {
        trafficPending = false;
        state = noteTraffic(state, now);
      }
      state = noteReading(state, connectionReading(target.WPP), now, eventPending);
      eventPending = false;
      publish();
      var grace = graceFor(state.stallGap || 0);
      // A message queued at the wake instant is not proof (it has to arrive
      // after the settle time). Still arm the prove timer, or the button waits
      // on the slow poll.
      if (state.wakeAt != null && now - state.wakeAt < grace) scheduleGrace();
    }
    tab.addEventListener("click", function (event) {
      stop(event);
      if (typeof target.__whatrustRecoverConnection === "function") target.__whatrustRecoverConnection();
      else invoke("reload_account_page");
    });
    // A small button has no room for a second control: right-click snoozes it.
    tab.addEventListener("contextmenu", function (event) {
      if (event && event.preventDefault) event.preventDefault();
      stop(event);
      state = noteDismiss(state, Date.now(), LIMITS);
      publish();
    });
    target.__wrSyncTraffic = function () {
      trafficPending = true;
      if (trafficQueued) return;
      trafficQueued = true;
      var fire = function () {
        trafficQueued = false;
        check();
      };
      // The sync port can deliver dozens of messages a second. One check per
      // beat is enough to notice silence, and it keeps the chat list responsive.
      if (typeof target.setTimeout === "function") target.setTimeout(fire, 200);
      else setTimeout(fire, 200);
    };
    target.__wrSyncRefresh = check;
    var previousRelang = target.__wrRelang;
    target.__wrRelang = function () {
      if (typeof previousRelang === "function") previousRelang();
      paint(assess(state, Date.now(), LIMITS));
    };
    watchSocketMessages(target);
    watchWorkers(target);
    // The shortcut stack is rebuilt on DOM churn; rejoin it if we were dropped.
    try {
      if (typeof target.MutationObserver === "function" && doc.documentElement) {
        var stackWatch = new target.MutationObserver(function () {
          if (tab.isConnected) return;
          var current = todoStack();
          if (current && tab.parentNode !== current) placeTab();
        });
        stackWatch.observe(doc.documentElement, { childList: true, subtree: true });
      }
    } catch (watchErr) {}
    function on(type, fn) {
      if (target.addEventListener) target.addEventListener(type, fn);
    }
    on("online", check);
    on("offline", check);
    on("focus", check);
    on("pageshow", check);
    if (doc.addEventListener) {
      doc.addEventListener("visibilitychange", function () {
        var hidden = doc.visibilityState === "hidden";
        state = noteVisibility(state, hidden, Date.now(), LIMITS.hiddenStallMs);
        if (!hidden) check();
        else scheduleGrace();
      });
    }
    if (typeof target.setInterval === "function") target.setInterval(check, 5000);
    else setInterval(check, 5000);
    check();
    target.__wrSyncInspect = function () {
      return { state: clone(state), shown: assess(state, Date.now(), LIMITS) };
    };
  }

  var api = {
    LIMITS: LIMITS,
    initialState: initialState,
    connectionReading: connectionReading,
    pageSaysOffline: pageSaysOffline,
    chatsOpen: chatsOpen,
    noteTick: noteTick,
    noteVisibility: noteVisibility,
    noteTraffic: noteTraffic,
    noteReading: noteReading,
    noteBrowser: noteBrowser,
    noteDom: noteDom,
    noteLoggedIn: noteLoggedIn,
    noteDismiss: noteDismiss,
    settleDismiss: settleDismiss,
    judge: judge,
    graceFor: graceFor,
    assess: assess,
    watchSocketMessages: watchSocketMessages,
    mount: mount,
  };
  root.__wrSyncStatus = api;
  if (root.__WHATRUST_SYNC_TEST) return;
  if (!root.location || root.location.origin !== "https://web.whatsapp.com") return;
  mount(root);
})();

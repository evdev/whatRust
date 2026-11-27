/* Offline indicator for a WhatsApp session that stopped syncing.
 *
 * After the computer sleeps, or the window sits unused, WhatsApp's socket can
 * die while the chat list still looks signed in. The page then has no banner
 * and its own reconnect control never appears, so there is nothing to click.
 * This watches the session and, when sync is gone or can no longer be trusted,
 * shows a bar with Reconnect. Reconnect uses the same recovery as a stuck
 * WhatsApp reconnect button: drop the service worker, then reload the page.
 *
 * A clock jump of a few minutes is sleep (hidden-page timer clamps stay near
 * one minute). Hiding the window for half an hour is the "left in the tray
 * overnight" case, where timers may still have been running. A reading that
 * merely stayed "connected" across that gap is not proof the socket woke up.
 */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;

  var LIMITS = {
    stallMs: 3 * 60 * 1000,
    hiddenStallMs: 30 * 60 * 1000,
    // A freeze this long is a night away, not a reconnect WhatsApp is about to finish.
    immediateMs: 10 * 60 * 1000,
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
      if (el.closest && el.closest("#__whatrust_sync, [data-whatrust-sync], #main, [data-id]")) continue;
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
    if (state.wakeAt && reading && reading.live && (fromEvent || (was && was.live === false))) next.sawLiveEvent = true;
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
    if (reason !== "hidden" && s.dismissedReason === reason) return "hidden";
    return reason;
  }

  function assess(state, now, limits) {
    var lim = limits || LIMITS;
    var stalled = state.wakeAt != null;
    var confirmed = !stalled || !!(
      (state.sawLiveEvent && state.reading && state.reading.live) ||
      (state.trafficAt != null && state.trafficAt >= state.wakeAt + lim.trafficSettleMs && state.reading && state.reading.live)
    );
    return judge({
      loggedIn: state.loggedIn,
      domOffline: state.domOffline,
      browserOfflineForMs: elapsed(state.browserOfflineSince, now),
      reading: state.reading,
      offlineForMs: elapsed(state.offlineSince, now),
      pendingForMs: elapsed(state.pendingSince, now),
      stalled: stalled,
      sinceWakeMs: stalled ? elapsed(state.wakeAt, now) : 0,
      confirmedSinceWake: confirmed,
      dismissedReason: state.dismissedReason || "",
      graceMs: (state.stallGap || 0) >= lim.immediateMs ? 0 : lim.graceMs,
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
    var host = doc.createElement("div");
    host.id = "__whatrust_sync";
    host.setAttribute("data-whatrust-sync", "1");
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    host.hidden = true;
    host.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483000";
    var shadow = host.attachShadow({ mode: "open" });
    var style = doc.createElement("style");
    style.textContent = ":host{all:initial}button{font:600 13px system-ui,sans-serif;cursor:pointer}button:focus-visible{outline:2px solid #111;outline-offset:2px}.bar{display:flex;align-items:center;justify-content:center;gap:12px;box-sizing:border-box;min-height:44px;padding:8px 16px;background:#fff4ce;color:#1c1c1c;font:600 14px/1.3 system-ui,sans-serif;box-shadow:0 1px 0 #0003}.reconnect{border:0;border-radius:16px;padding:6px 14px;background:#008069;color:#fff}.dismiss{border:0;background:transparent;color:#1c1c1c;text-decoration:underline;padding:6px 4px}";
    var bar = doc.createElement("div");
    bar.className = "bar";
    var text = doc.createElement("span");
    var reconnect = doc.createElement("button");
    reconnect.type = "button";
    reconnect.className = "reconnect";
    var dismiss = doc.createElement("button");
    dismiss.type = "button";
    dismiss.className = "dismiss";
    bar.appendChild(text);
    bar.appendChild(reconnect);
    bar.appendChild(dismiss);
    shadow.appendChild(style);
    shadow.appendChild(bar);
    doc.documentElement.appendChild(host);
    function stop(event) {
      if (event && event.stopPropagation) event.stopPropagation();
    }
    host.addEventListener("click", stop);
    host.addEventListener("pointerdown", stop);
    function paint(reason) {
      if (!host.isConnected && doc.documentElement) doc.documentElement.appendChild(host);
      var show = reason === "offline" || reason === "stale";
      host.hidden = !show;
      if (!show) return;
      var sentence = reason === "offline"
        ? L("O WhatsApp está offline.", "WhatsApp is offline.")
        : L("O WhatsApp parou de sincronizar.", "WhatsApp stopped syncing.");
      var action = L("Reconectar", "Reconnect");
      var later = L("Agora não", "Not now");
      if (text.textContent !== sentence) text.textContent = sentence;
      if (reconnect.textContent !== action) reconnect.textContent = action;
      reconnect.setAttribute("aria-label", action);
      if (dismiss.textContent !== later) dismiss.textContent = later;
      dismiss.setAttribute("aria-label", later);
    }
    function invoke(cmd, args) {
      var tauri = target.__TAURI__;
      if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") return Promise.resolve(false);
      return Promise.resolve(tauri.core.invoke(cmd, args)).then(function () { return true; }, function () { return false; });
    }
    function report(offline, barShown) {
      if (target.__whatrustLocked) {
        reported = null;
        return;
      }
      if (reported === offline) return;
      var pending = offline;
      invoke("report_sync_offline", { offline: offline }).then(function (ok) {
        if (ok) reported = pending;
      });
      if (barShown) invoke("dlog", { msg: "sync: offline bar shown" });
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
      var left = LIMITS.graceMs - (Date.now() - state.wakeAt);
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
      var grace = (state.stallGap || 0) >= LIMITS.immediateMs ? 0 : LIMITS.graceMs;
      if (state.wakeAt != null && !state.sawLiveEvent && now - state.wakeAt < grace) scheduleGrace();
    }
    reconnect.addEventListener("click", function (event) {
      stop(event);
      if (typeof target.__whatrustRecoverConnection === "function") target.__whatrustRecoverConnection();
      else invoke("reload_account_page");
    });
    dismiss.addEventListener("click", function (event) {
      stop(event);
      state = noteDismiss(state, Date.now(), LIMITS);
      publish();
    });
    target.__wrSyncTraffic = function () {
      trafficPending = true;
      check();
    };
    target.__wrSyncRefresh = check;
    var previousRelang = target.__wrRelang;
    target.__wrRelang = function () {
      if (typeof previousRelang === "function") previousRelang();
      paint(assess(state, Date.now(), LIMITS));
    };
    watchWorkers(target);
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
    assess: assess,
    mount: mount,
  };
  root.__wrSyncStatus = api;
  if (root.__WHATRUST_SYNC_TEST) return;
  if (!root.location || root.location.origin !== "https://web.whatsapp.com") return;
  mount(root);
})();

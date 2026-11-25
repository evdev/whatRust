/* Scheduled delivery transport. Rust owns authorization, durable attempts, and
 * retry policy. A local model (or a resolved send promise) alone is not proof.
 * WA-JS 4.8.2 supports messageId for both text and media; media forwards the
 * prepared key through productMsgOptions. Never select/open/read a chat here. */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  if (!root.__WHATRUST_TEST && (!root.location || root.location.origin !== "https://web.whatsapp.com")) return;
  if (root.__wrScheduleDeliver) return;
  var session = root.crypto.randomUUID();
  var started = false, locked = root.__whatrustLocked !== false, alive = true, busy = false;
  var reporting = false, reportAgain = false, authBlocked = false;
  var used = new Set(), lastReport = "", epoch = 0;
  var CHUNK = 256 * 1024, MAX_FILE = 100 * 1024 * 1024, TOKEN_CAP = 1024;
  function invoke(cmd, args) { return root.__TAURI__.core.invoke(cmd, args); }
  function wid(value) {
    if (!value) return "";
    return typeof value === "string" ? value : value._serialized || String(value);
  }
  var observedSocket = null, observedStream = null, diagnostics = new Set(), lastDiagnostic = "";
  function read(fn) { try { return fn(); } catch (_) { return undefined; } }
  function socketValue(value, enumName, name) {
    var enums = read(function () { return root.WPP.whatsapp.enums[enumName]; });
    return value != null && (enums && enums[name] != null ? value === enums[name] : value === name);
  }
  function streamData() { return read(function () { return root.WPP.conn.getStreamData(); }) || {}; }
  function socket() { return read(function () { return root.WPP.whatsapp.Socket; }); }
  function identity() {
    try {
      if (authBlocked || root.WPP.conn.isAuthenticated() !== true) return null;
      if (streamData().mode === "QR") return null;
      var sock = socket(), value = sock && sock.state;
      if (socketValue(value, "SOCKET_STATE", "UNPAIRED") || socketValue(value, "SOCKET_STATE", "UNPAIRED_IDLE")) return null;
      // Always the phone WID; never switch to LID when it later becomes known.
      var id = wid(root.WPP.conn.getMyUserWid());
      var m = /^(\d+)(?::\d+)?@(c\.us|s\.whatsapp\.net)$/.exec(id);
      return m ? m[1] + "@c.us" : null;
    } catch (_) { return null; }
  }
  function state() {
    var nowLocked = root.__whatrustLocked !== false;
    if (locked !== nowLocked) { locked = nowLocked; epoch++; }
    var id = identity(), stream = streamData(), sock = socket();
    var socketState = read(function () { return sock.state; });
    var socketStream = read(function () { return sock.stream; });
    var online = read(function () { return root.WPP.conn.isOnline(); });
    var connected = socketValue(socketState, "SOCKET_STATE", "CONNECTED");
    var transport = socketValue(socketStream, "SOCKET_STREAM", "CONNECTED");
    // Socket.stream is optional and not consumed by this WA-JS bundle. Only
    // recognized negative values can veto state; an unknown hint cannot.
    var transportBlocked = ["DISCONNECTED", "DISCONNECTING", "CONNECTING", "OPENING", "RESUMING", "OFFLINE", "SYNCING", "PAIRING"].some(function (name) {
      return socketValue(socketStream, "SOCKET_STREAM", name);
    });
    var hasSocket = socketState != null;
    // The real Socket model is current connection evidence. Loader completion
    // and isMainReady are historical latches; neither can authorize or veto it.
    // If a runtime has no socket signals, retain the strict public fallback.
    var live = hasSocket ? connected && !transportBlocked && online !== false :
      online === true && stream.mode === "MAIN" && stream.info === "NORMAL";
    var reason = !alive ? "document_closed" : locked ? "locked" : authBlocked ? "authentication_blocked" : !id ? "identity_unavailable" :
      !live ? (online === false ? "network_offline" : hasSocket ? "socket_unavailable" : "stream_unavailable") : hasSocket ? "ready_socket" : "ready_stream";
    // All diagnostic values are fixed labels. Never serialize runtime strings,
    // identity, message keys, chat IDs, or message contents to the log.
    lastDiagnostic = "reason=" + reason + " socket=" + (socketState == null ? "absent" : connected ? "connected" : "other") +
      " transport=" + (socketStream == null ? "absent" : transport ? "connected" : "other") +
      " public=" + (stream.mode === "MAIN" && stream.info === "NORMAL" ? "ready" : "other") +
      " loader=" + (read(function () { return root.WPP.isFullReady; }) === true ? "full" : "pending") +
      " main=" + (read(function () { return root.WPP.conn.isMainReady(); }) === true ? "ready" : "pending");
    return { session_id: session, identity: id, ready: reason === "ready_socket" || reason === "ready_stream" };
  }
  function diagnose() {
    if (diagnostics.has(lastDiagnostic) || diagnostics.size >= 24) return;
    diagnostics.add(lastDiagnostic);
    try { Promise.resolve(invoke("dlog", { msg: "scheduler readiness: " + lastDiagnostic })).catch(function () {}); } catch (_) {}
  }
  function observeModels() {
    var sock = socket(), stream = read(function () { return root.WPP.whatsapp.Stream; });
    function changed() { epoch++; report(); }
    if (sock && sock !== observedSocket && typeof sock.on === "function") {
      observedSocket = sock;
      sock.on("change:state", changed); sock.on("change:stream", changed);
    }
    if (stream && stream !== observedStream && typeof stream.on === "function") {
      observedStream = stream;
      stream.on("change:mode", changed); stream.on("change:info", changed);
    }
  }
  async function report(force) {
    if (reporting) { reportAgain = reportAgain || force === true; return; }
    observeModels();
    var s = state(), key = JSON.stringify(s);
    diagnose();
    if (key === lastReport && force !== true) return;
    reporting = true;
    lastReport = key;
    try {
      await invoke("schedule_report", s);
      if (typeof root.__wrScheduleChanged === "function") root.__wrScheduleChanged();
    } catch (_) { if (lastReport === key) lastReport = ""; }
    finally {
      reporting = false;
      var again = reportAgain; reportAgain = false;
      if (again || JSON.stringify(state()) !== key) report(again);
    }
  }
  root.__wrScheduleDeliveryRefresh = function (force) {
    if (!started) root.__wrScheduleDeliveryStart();
    return report(force === true);
  };
  root.__wrScheduleDeliveryStart = function () {
    if (started || !root.WPP || typeof root.WPP.on !== "function") return;
    started = true;
    var w = root.WPP;
    ["conn.authenticated", "conn.main_ready", "conn.online", "conn.logout", "conn.require_auth", "conn.stream_mode_changed", "conn.stream_info_changed"].forEach(function (event) {
      w.on(event, function () {
        if (event === "conn.logout" || event === "conn.require_auth") authBlocked = true;
        if (event === "conn.authenticated") authBlocked = false;
        epoch++; report();
      });
    });
    // Register before the immediate snapshot: these callbacks observe future
    // loader events only. Rebind models as exports become available.
    ["onInjected", "onReady", "onFullReady"].forEach(function (name) {
      if (typeof w[name] === "function") w[name](function () { epoch++; report(); });
    });
    report();
  };
  function allowed(job, generation) {
    var s = state();
    return s.ready && generation === epoch && job.session_id === session && job.identity === s.identity;
  }
  function keyMatches(id, chat) {
    return typeof id === "string" && id.length < 300 && id.indexOf("true_" + chat + "_") === 0 && id.length > chat.length + 6;
  }
  function evidence(result, expected) {
    if (!result || wid(result.id) !== expected) return "unknown";
    var ack = result.ack;
    // Unknown ACK values, pending ACK, missing ACK, and negative ACK remain
    // uncertain. Do not infer server acceptance from JavaScript truthiness.
    if (!Number.isInteger(ack) || ack < 1 || ack > 4) return "unknown";
    var runtimeAck = root.WPP.whatsapp && root.WPP.whatsapp.enums && root.WPP.whatsapp.enums.ACK;
    if (runtimeAck && ["SENT", "RECEIVED", "READ", "PLAYED"].some(function (name, index) {
      return runtimeAck[name] != null && runtimeAck[name] !== index + 1;
    })) return "unknown";
    var code = result.sendMsgResult;
    if (code != null) {
      var actual = typeof code === "object" ? code.messageSendResult : code;
      var enums = root.WPP.whatsapp && root.WPP.whatsapp.enums;
      var ok = enums && enums.SendMsgResult && enums.SendMsgResult.OK;
      if (actual == null || ok == null || actual !== ok) return "unknown";
    }
    return "sent";
  }
  function bounded(promise, timeout) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("delivery_timeout")); }, timeout || 60000);
      Promise.resolve(promise).then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }
  function preSubmissionError(error, kind) {
    var ErrorType = root.WPP.util && root.WPP.util.WPPError;
    if (typeof ErrorType !== "function" || !(error instanceof ErrorType)) return false;
    // Verified in bundled 4.8.2: these throw before addAndSendMsgToChat or
    // prepared-media sendToChat. Do not extend this to native/network errors.
    return error.code === "chat_not_found" ||
      error.code === "message_key_is_not_from_me" ||
      error.code === "message_key_remote_id_is_not_same_of_chat" ||
      (kind === "file" && error.code === "file_too_large") ||
      (kind === "text" && error.code === "can_not_send_message_to_this_groupType");
  }
  async function fileFor(job, generation) {
    var a = job.attachment;
    if (!a || !["image", "video", "document", "voice"].includes(a.mode) || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > MAX_FILE || typeof a.name !== "string" || !a.name || typeof a.mime !== "string") throw new Error("invalid_attachment");
    if (a.mode === "voice" && (a.name !== "voice-note.ogg" || a.mime !== "audio/ogg; codecs=opus" || a.size > 4 * 1024 * 1024 || a.caption || job.text)) throw new Error("invalid_voice_message");
    if ((a.mode === "image" && !a.mime.startsWith("image/")) || (a.mode === "video" && !a.mime.startsWith("video/"))) throw new Error("invalid_media_type");
    var pieces = [];
    for (var offset = 0; offset < a.size;) {
      if (!allowed(job, generation)) throw new Error("unavailable");
      var b64 = await bounded(invoke("schedule_delivery_chunk", { token: job.token, offset: offset }));
      if (typeof b64 !== "string" || b64.length > Math.ceil(CHUNK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw new Error("invalid_chunk");
      var raw = root.atob(b64), expected = Math.min(CHUNK, a.size - offset);
      if (raw.length !== expected) throw new Error("invalid_chunk_size");
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      pieces.push(bytes); offset += bytes.length;
    }
    return new root.File(pieces, a.name, { type: a.mime });
  }
  root.__wrScheduleDeliver = async function (job) {
    if (!job || typeof job.token !== "string" || !job.token || used.has(job.token)) return;
    used.add(job.token);
    // This is only a recent duplicate guard. Durable Rust prepare is the
    // authority after eviction or document reload and must reject used tokens.
    if (used.size > TOKEN_CAP) used.delete(used.values().next().value);
    var messageId = job.message_id || null, outcome = "unavailable", submitted = false;
    var generation = epoch;
    async function finish() {
      try { await bounded(invoke("schedule_delivery_result", { token: job.token, outcome: outcome, message_id: messageId })); } catch (_) {}
    }
    if (busy) { await finish(); return; }
    busy = true;
    try {
      if (!allowed(job, generation)) return;
      var chat = job.chat_id;
      if (job.operation === "reconcile") {
        outcome = "unknown";
        if (typeof chat !== "string" || !/^[^\s_@]+@(c\.us|s\.whatsapp\.net|lid|g\.us)$/.test(chat)) return;
        if (!keyMatches(messageId, chat)) return;
        var msg = await bounded(root.WPP.chat.getMessageById(messageId));
        if (allowed(job, generation)) outcome = evidence(msg, messageId);
        return;
      }
      if (typeof chat !== "string" || !/^[^\s_@]+@(c\.us|s\.whatsapp\.net|lid|g\.us)$/.test(chat) || !root.WPP.chat.get(chat)) { outcome = "rejected"; return; }
      if (job.operation !== "send" || messageId || !["text", "file"].includes(job.kind)) { outcome = "rejected"; return; }
      if (job.kind === "text" && (typeof job.text !== "string" || !job.text.trim())) { outcome = "rejected"; return; }
      var file;
      if (job.kind === "file") {
        try { file = await fileFor(job, generation); }
        catch (error) { outcome = allowed(job, generation) ? "rejected" : "unavailable"; return; }
      }
      if (!allowed(job, generation)) return;
      messageId = wid(await bounded(root.WPP.chat.generateMessageID(chat)));
      if (!keyMatches(messageId, chat)) { messageId = null; outcome = "rejected"; return; }
      await bounded(invoke("schedule_delivery_prepare", { token: job.token, message_id: messageId }));
      if (!allowed(job, generation)) return;
      var opts = { messageId: messageId, createChat: false, markIsRead: false, waitForAck: true };
      var sending;
      submitted = true;
      outcome = "unknown";
      if (job.kind === "text") sending = root.WPP.chat.sendTextMessage(chat, job.text, opts);
      else {
        if (job.attachment.mode === "voice") {
          opts.type = "audio"; opts.isPtt = true;
        } else {
          opts.type = job.attachment.mode; opts.caption = job.attachment.caption || "";
        }
        opts.filename = job.attachment.name; opts.mimetype = job.attachment.mime;
        sending = root.WPP.chat.sendFileMessage(chat, file, opts);
      }
      var result = await bounded(sending, job.kind === "file" ? 9 * 60 * 1000 : 60000);
      outcome = evidence(result, messageId);
    } catch (error) {
      outcome = submitted || job.operation === "reconcile" ? "unknown" : "unavailable";
      if (submitted && job.operation === "send" && preSubmissionError(error, job.kind)) outcome = "rejected";
    }
    finally { busy = false; await finish(); }
  };
  if (root.addEventListener) root.addEventListener("pagehide", function () { alive = false; epoch++; report(); });
  root.__wrScheduleDeliveryStart();
})();

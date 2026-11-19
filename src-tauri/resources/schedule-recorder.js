/* Explicit, editor-scoped microphone capture for scheduled voice notes. */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  if (!root.__WHATRUST_TEST && (!root.location || root.location.origin !== "https://web.whatsapp.com")) return;
  var RATE = 16000, SECONDS = 120, MAX_BYTES = 8 * 1024 * 1024;
  function L(pt, en) { return root.__WR_LANG === "en" ? en : pt; }
  function message(error) {
    var name = error && error.name;
    if (name === "NotAllowedError" || name === "SecurityError") return L("Permita o acesso ao microfone nas configurações do sistema e tente novamente.", "Allow microphone access in system settings, then try again.");
    if (name === "NotFoundError" || name === "OverconstrainedError") return L("Nenhum microfone foi encontrado.", "No microphone was found.");
    return L("Não foi possível gravar a mensagem de voz. Verifique o microfone e tente novamente.", "Could not record the voice note. Check your microphone and try again.");
  }
  function wavBytes(samples) {
    var buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
    function mark(at, text) { for (var i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); }
    mark(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); mark(8, "WAVE");
    mark(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    mark(36, "data"); view.setUint32(40, samples.length * 2, true);
    for (var i = 0; i < samples.length; i++) {
      var sample = Math.min(1, Math.max(-1, samples[i] || 0));
      view.setInt16(44 + i * 2, sample * (sample < 0 ? 0x8000 : 0x7fff), true);
    }
    return buffer;
  }
  root.__wrCreateScheduleRecorder = function (options) {
    options = options || {};
    var button = root.document.createElement("button"), state = "idle", disabled = false, disposed = false;
    var epoch = 0, stream = null, recorder = null, timer = null, context = null;
    button.type = "button";
    button.className = "wr-schedule-record";
    button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:7px;border:1px solid currentColor;border-radius:50%;background:transparent;color:inherit;cursor:pointer;flex-shrink:0";
    function changed(file) { if (!disposed && options.onChange) options.onChange(file || null); }
    function paint() {
      var recording = state === "recording";
      var label = recording ? L("Parar gravação", "Stop recording") : state === "starting" ? L("Aguardando microfone…", "Waiting for microphone…") : state === "preparing" ? L("Preparando áudio…", "Preparing voice note…") : L("Gravar mensagem de voz (até 2 minutos)", "Record a voice note (up to 2 minutes)");
      button.title = label; button.setAttribute("aria-label", label); button.setAttribute("aria-pressed", String(recording));
      button.setAttribute("aria-busy", String(state === "starting" || state === "preparing"));
      button.disabled = disposed || disabled || state === "starting" || state === "preparing";
      button.style.color = recording ? "#e55b6b" : "inherit";
      button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8">' + (recording ? '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>' : '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-4 0h8"/>') + '</svg>';
    }
    function closeContext() {
      var ctx = context; context = null;
      if (ctx) { try { Promise.resolve(ctx.close()).catch(function () {}); } catch (_) {} }
    }
    function stopTracks() {
      var active = stream; stream = null;
      if (active) active.getTracks().forEach(function (track) { try { track.stop(); } catch (_) {} });
    }
    function clearTimer() { if (timer !== null) root.clearTimeout(timer); timer = null; }
    function cancel() {
      epoch++; clearTimer();
      var rec = recorder; recorder = null;
      if (rec) {
        rec.ondataavailable = rec.onstop = rec.onerror = null;
        if (rec.state !== "inactive") { try { rec.stop(); } catch (_) {} }
      }
      stopTracks(); closeContext(); state = "idle"; paint();
    }
    function fail(error, token, text) {
      if (disposed || token !== epoch) return;
      cancel(); changed(null);
      if (!disposed && options.onError) options.onError(text || message(error));
    }
    async function convert(blob, token) {
      var Context = root.AudioContext || root.webkitAudioContext;
      context = new Context();
      var ctx = context, decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      if (disposed || token !== epoch) return null;
      var duration = Math.min(SECONDS, decoded.duration), channels = decoded.numberOfChannels;
      if (!Number.isFinite(duration) || duration <= 0 || !channels || channels > 8 || decoded.sampleRate > 192000) throw new Error("invalid audio");
      var frames = Math.max(1, Math.ceil(duration * RATE));
      var offline = new root.OfflineAudioContext(1, frames, RATE);
      var length = Math.min(decoded.length, Math.ceil(duration * decoded.sampleRate));
      var mono = offline.createBuffer(1, length, decoded.sampleRate), target = mono.getChannelData(0);
      for (var c = 0; c < channels; c++) {
        var src = decoded.getChannelData(c);
        for (var i = 0; i < length; i++) target[i] += src[i] / channels;
      }
      var source = offline.createBufferSource(); source.buffer = mono; source.connect(offline.destination); source.start();
      var rendered = await offline.startRendering();
      if (disposed || token !== epoch) return null;
      return new root.File([wavBytes(rendered.getChannelData(0))], "voice-note.wav", { type: "audio/wav" });
    }
    function finish() {
      if (state !== "recording" || !recorder) return;
      state = "preparing"; clearTimer(); paint(); changed(null);
      if (disposed || state !== "preparing" || !recorder) return;
      try { recorder.stop(); stopTracks(); } catch (error) { fail(error, epoch); }
    }
    async function start() {
      if (disposed || disabled || state !== "idle") return;
      var token = ++epoch;
      state = "starting"; paint(); changed(null);
      if (disposed || token !== epoch) return;
      try {
        if (!root.navigator.mediaDevices || !root.navigator.mediaDevices.getUserMedia || !root.MediaRecorder || !(root.AudioContext || root.webkitAudioContext) || !root.OfflineAudioContext) throw new Error("unsupported");
        var acquired = await root.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: RATE }, video: false });
        if (disposed || token !== epoch) { acquired.getTracks().forEach(function (track) { track.stop(); }); return; }
        stream = acquired;
        var mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"].find(function (type) { return root.MediaRecorder.isTypeSupported && root.MediaRecorder.isTypeSupported(type); });
        var rec = new root.MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 });
        recorder = rec;
        var chunks = [], size = 0;
        rec.ondataavailable = function (event) {
          if (disposed || token !== epoch || !event.data || !event.data.size) return;
          size += event.data.size;
          if (size > MAX_BYTES) { chunks = []; fail(null, token, L("A gravação é muito grande. Grave uma mensagem mais curta.", "The recording is too large. Record a shorter voice note.")); return; }
          chunks.push(event.data);
        };
        rec.onerror = function (event) { fail(event.error, token); };
        rec.onstop = async function () {
          if (disposed || token !== epoch) return;
          clearTimer(); stopTracks(); recorder = null; state = "preparing"; paint(); changed(null);
          if (disposed || token !== epoch) return;
          try {
            if (!size) throw new Error("empty audio");
            var blob = new root.Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }); chunks = [];
            var file = await convert(blob, token);
            if (disposed || token !== epoch || !file) return;
            closeContext(); state = "idle"; paint(); changed(file);
          } catch (error) { fail(error, token, L("Não foi possível preparar o áudio. Grave novamente.", "Could not prepare the voice note. Please record again.")); }
        };
        rec.start(250); state = "recording";
        timer = root.setTimeout(finish, SECONDS * 1000); paint(); changed(null);
      } catch (error) { fail(error, token); }
    }
    function click() { if (state === "recording") finish(); else start(); }
    function dispose() {
      if (disposed) return;
      disposed = true; cancel(); button.removeEventListener("click", click); root.removeEventListener("pagehide", dispose);
    }
    button.addEventListener("click", click); root.addEventListener("pagehide", dispose); paint();
    return { button: button, busy: function () { return state !== "idle"; }, setDisabled: function (value) {
      disabled = !!value;
      if (disabled && state !== "idle") { cancel(); changed(null); } else paint();
    }, dispose: dispose };
  };
  if (root.__WHATRUST_TEST) root.__wrScheduleRecorderTest = { wavBytes: wavBytes };
})();

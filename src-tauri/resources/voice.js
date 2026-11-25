/* Voice-note transcripts for web.whatsapp.com.
 *
 * WA-JS (injected before this file) downloads a note without pressing play.
 * The bytes are framed as [u16 big-endian id length][utf-8 id][u64 big-endian
 * message time][audio] and handed to Rust, which calls FluidVoice. Rust also
 * translates and summarizes, so this page never sees an API key. A transcript
 * stays on screen only while WhatsApp is still showing that message.
 */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  if (!root.location || root.location.origin !== "https://web.whatsapp.com") return;

  function L(pt, en) {
    return root.__WR_LANG === "en" ? en : pt;
  }

  function isMessageId(id) {
    return typeof id === "string" && id.length >= 12 && id.length <= 180 && /^(true|false)_[^_]+_.+$/.test(id);
  }

  function isVoiceMessage(msg) {
    if (!msg) return false;
    var type = msg.type || (msg.attributes && msg.attributes.type) || "";
    return type === "ptt" || type === "audio";
  }

  function messageType(msg) {
    return (msg && (msg.type || (msg.attributes && msg.attributes.type))) || "";
  }

  var MAX_VIDEO_BYTES = 64 * 1024 * 1024;
  var MAX_WAV_BYTES = 20 * 1024 * 1024;

  // Mono 16 kHz PCM WAV, as required by GenieX. No audio leaves this webview
  // until it is sent to the local application.
  function pcmWav(samples) {
    if (samples.length * 2 + 44 > MAX_WAV_BYTES) throw new Error("too_large");
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    function tag(at, text) { for (var i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); }
    tag(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); tag(8, "WAVE");
    tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    tag(36, "data"); view.setUint32(40, samples.length * 2, true);
    for (var n = 0; n < samples.length; n++) {
      var s = Math.max(-1, Math.min(1, samples[n] || 0));
      view.setInt16(44 + n * 2, s < 0 ? s * 32768 : s * 32767, true);
    }
    return new Uint8Array(buffer);
  }

  function checkAudioDuration(buffer) {
    return new Promise(function (resolve, reject) {
      var media = root.document.createElement("audio");
      var url = root.URL.createObjectURL(new Blob([buffer]));
      var timer = setTimeout(function () { finish("audio_decode"); }, 15000);
      function finish(error) {
        clearTimeout(timer);
        media.onloadedmetadata = media.onerror = null;
        media.removeAttribute("src");
        media.load();
        root.URL.revokeObjectURL(url);
        if (error) reject(new Error(error)); else resolve();
      }
      media.preload = "metadata";
      media.onloadedmetadata = function () {
        var seconds = media.duration;
        if (!isFinite(seconds) || seconds <= 0) return finish("audio_decode");
        if (Math.ceil(seconds * 16000) * 2 + 44 > MAX_WAV_BYTES) return finish("too_large");
        finish();
      };
      media.onerror = function () { finish("audio_decode"); };
      media.src = url;
    });
  }

  async function toWav(buffer) {
    var Context = root.AudioContext || root.webkitAudioContext;
    var Offline = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!Context || !Offline) throw new Error("audio_decode");
    await checkAudioDuration(buffer);
    var context = new Context();
    try {
      var decoded = await context.decodeAudioData(buffer);
      var frames = Math.ceil(decoded.duration * 16000);
      if (!frames || frames * 2 + 44 > MAX_WAV_BYTES) throw new Error("too_large");
      var offline = new Offline(1, frames, 16000);
      var source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(0);
      var rendered = await offline.startRendering();
      return pcmWav(rendered.getChannelData(0));
    } catch (e) {
      if (e && e.message === "too_large") throw e;
      throw new Error("audio_decode");
    } finally { await context.close().catch(function () {}); }
  }

  function messageFlag(msg, name) {
    if (!msg) return false;
    if (msg[name]) return true;
    var attrs = msg.attributes;
    return !!(attrs && attrs[name]);
  }

  function isVideoMessage(msg) {
    if (!msg) return false;
    var type = messageType(msg);
    if (type !== "video" && type !== "ptv") return false;
    if (messageFlag(msg, "isGif") || messageFlag(msg, "asGif") || messageFlag(msg, "gifPlayback")) return false;
    if (messageFlag(msg, "isViewOnce") || messageFlag(msg, "viewOnce") || messageFlag(msg, "isViewOnceV2")) return false;
    return true;
  }

  function mediaBytes(msg) {
    if (!msg) return 0;
    var raw = msg.size || msg.fileLength;
    if (!raw && msg.attributes) raw = msg.attributes.size || msg.attributes.fileLength;
    if (raw && typeof raw === "object" && typeof raw.toNumber === "function") raw = raw.toNumber();
    var n = Number(raw);
    return n > 0 && isFinite(n) ? n : 0;
  }

  function looksLikeVoiceRow(row) {
    if (!row || !row.querySelector) return false;
    var selectors = [
      '[data-icon="audio-play"]',
      '[data-icon="audio-pause"]',
      '[data-icon="ptt-status"]',
      '[data-icon="audio-download"]',
      '[data-testid="audio-player"]',
      '[data-testid="ptt-duration"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      if (row.querySelector(selectors[i])) return true;
    }
    if (row.querySelector("canvas") && /\b\d{1,2}:\d{2}\b/.test(row.innerText || "")) return true;
    var buttons = row.querySelectorAll("button,[role='button']");
    for (var b = 0; b < buttons.length; b++) {
      if (isVoiceControl(buttons[b].getAttribute("aria-label") || "")) return true;
    }
    return false;
  }

  function isVoiceControl(label) {
    return /voice message|mensagem de voz|nota de voz|mensaje de voz|audio message|mensagem de áudio|mensaje de audio/.test(
      String(label).toLowerCase()
    );
  }

  function isVideoControl(label) {
    var text = String(label).toLowerCase();
    if (/video call|chamada de v|llamada de v|videochamada|video-call/.test(text)) return false;
    return /video message|mensagem de vídeo|mensaje de video|video note|mensagem de vídeo instant|play video|reproduzir vídeo/.test(text);
  }

  function directMedia(parent) {
    var kids = parent && parent.children;
    if (!kids) return false;
    for (var i = 0; i < kids.length; i++) {
      var tag = String(kids[i].tagName || "").toLowerCase();
      if (tag === "img" || tag === "video") return true;
    }
    return false;
  }

  function isMessageMeta(node) {
    if (!node || !node.getAttribute) return false;
    var test = node.getAttribute("data-testid") || "";
    var icon = node.getAttribute("data-icon") || "";
    if (test === "msg-time" || test === "msg-dblcheck" || test === "msg-check") return true;
    if (icon === "msg-check" || icon === "msg-dblcheck") return true;
    return !!(node.querySelector && node.querySelector("[data-testid='msg-time'], [data-testid='msg-dblcheck'], [data-testid='msg-check'], [data-icon='msg-check'], [data-icon='msg-dblcheck']"));
  }

  // A video thumbnail draws its length on the picture. A message clock such as
  // "10:30" sits with the check marks, so an image is not a video.
  function durationOnThumbnail(row) {
    var nodes = row.querySelectorAll("span, div");
    var limit = Math.min(nodes.length, 80);
    for (var i = 0; i < limit; i++) {
      var node = nodes[i];
      if (node.childElementCount) continue;
      var text = (node.textContent || "").trim();
      if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) continue;
      var parent = node.parentElement;
      if (!parent || parent === row || (parent.getAttribute && parent.getAttribute("data-id"))) continue;
      if (isMessageMeta(parent) || isMessageMeta(node)) continue;
      if (directMedia(parent)) return true;
    }
    return false;
  }

  function looksLikeVideoRow(row) {
    if (!row || !row.querySelector) return false;
    if (row.querySelector("video, [data-icon='media-play'], [data-icon='video-pip'], [data-icon='msg-video'], [data-testid='media-play'], [data-testid='video-content']")) {
      return true;
    }
    var buttons = row.querySelectorAll("button,[role='button']");
    for (var b = 0; b < buttons.length; b++) {
      if (isVideoControl(buttons[b].getAttribute("aria-label") || "")) return true;
    }
    return durationOnThumbnail(row);
  }

  // WhatsApp can render an unplayed video as an ordinary image thumbnail,
  // without a stable play icon or duration. The message model is checked
  // before showing a button, so image thumbnails are safe candidates too.
  function mayContainVideo(row) {
    return looksLikeVideoRow(row) || !!(row && row.querySelector && row.querySelector("img"));
  }

  function serializedId(value) {
    if (!value) return "";
    if (typeof value === "string") return isMessageId(value) ? value : "";
    if (typeof value !== "object") return "";
    if (typeof value._serialized === "string" && isMessageId(value._serialized)) return value._serialized;
    try {
      if (typeof value.toString === "function") {
        var text = String(value.toString());
        if (text !== "[object Object]" && isMessageId(text)) return text;
      }
    } catch (e) {}
    return "";
  }

  function idFromProps(props) {
    if (!props || typeof props !== "object") return "";
    var direct = serializedId(props.id);
    if (direct) return direct;
    var bags = [props.msg, props.message, props.data, props.model];
    for (var i = 0; i < bags.length; i++) {
      if (!bags[i] || typeof bags[i] !== "object") continue;
      var id = serializedId(bags[i].id) || serializedId(bags[i]);
      if (id) return id;
    }
    return "";
  }

  function idFromFiber(start) {
    var node = start;
    for (var depth = 0; node && depth < 8; depth++) {
      var keys;
      try {
        keys = Object.keys(node);
      } catch (e) {
        keys = [];
      }
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (
          key.indexOf("__reactFiber") !== 0 &&
          key.indexOf("__reactInternalInstance") !== 0 &&
          key.indexOf("__reactProps") !== 0
        ) {
          continue;
        }
        var cur = node[key];
        for (var step = 0; cur && step < 30; step++) {
          try {
            var id = idFromProps(cur.memoizedProps) || idFromProps(cur.pendingProps) || idFromProps(cur);
            if (id) return id;
          } catch (e) {}
          cur = cur.return || null;
        }
      }
      node = node.parentElement;
    }
    return "";
  }

  function messageIdOf(row) {
    var node = row;
    for (var depth = 0; node && depth < 8; depth++) {
      if (node.getAttribute) {
        var id = node.getAttribute("data-id");
        if (isMessageId(id)) return id;
      }
      node = node.parentElement;
    }
    return idFromFiber(row);
  }

  function intersectsViewport(row, viewport) {
    if (!row || typeof row.getBoundingClientRect !== "function") return false;
    var rect = row.getBoundingClientRect();
    var width = viewport && viewport.width ? viewport.width : root.innerWidth || 800;
    var height = viewport && viewport.height ? viewport.height : root.innerHeight || 800;
    return rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width && rect.height > 0;
  }

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === "function") return root.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function pack(id, bytes, at) {
    var idBytes = new TextEncoder().encode(id);
    var out = new Uint8Array(2 + idBytes.length + 8 + bytes.length);
    out[0] = (idBytes.length >> 8) & 255;
    out[1] = idBytes.length & 255;
    out.set(idBytes, 2);
    var time = Number(at);
    if (!isFinite(time) || time < 0) time = 0;
    if (time > 0 && time < 1e12) time *= 1000;
    var hi = Math.floor(time / 4294967296);
    var lo = time % 4294967296;
    var offset = 2 + idBytes.length;
    out[offset] = (hi >>> 24) & 255;
    out[offset + 1] = (hi >>> 16) & 255;
    out[offset + 2] = (hi >>> 8) & 255;
    out[offset + 3] = hi & 255;
    out[offset + 4] = (lo >>> 24) & 255;
    out[offset + 5] = (lo >>> 16) & 255;
    out[offset + 6] = (lo >>> 8) & 255;
    out[offset + 7] = lo & 255;
    out.set(bytes, offset + 8);
    return out;
  }

  var PAINT_CACHE = 32;
  // Skip, error, and offer markers outlive the row so a scroll does not
  // download the same note again. Cap them so a long-lived page cannot
  // keep one entry for every message it has ever seen.
  var MARKER_CAP = 400;

  function capIdMap(map, keep, cap) {
    if (!map) return;
    var limit = cap || MARKER_CAP;
    var keys = Object.keys(map);
    if (keys.length <= limit) return;
    var spare = [];
    for (var i = 0; i < keys.length; i++) {
      if (keep && keep[keys[i]]) continue;
      spare.push(keys[i]);
    }
    var extra = keys.length - limit;
    for (var d = 0; d < spare.length && d < extra; d++) delete map[spare[d]];
  }

  function releasedView(released, id) {
    if (!released) return null;
    for (var i = released.length - 1; i >= 0; i--) {
      if (released[i] && released[i].id === id) return released[i];
    }
    return null;
  }

  function rememberReleased(released, view) {
    for (var i = released.length - 1; i >= 0; i--) {
      if (released[i] && released[i].id === view.id) released.splice(i, 1);
    }
    released.push(view);
    while (released.length > PAINT_CACHE) released.shift();
  }

  // Drop transcript text once WhatsApp has detached the row. Error and skip
  // markers stay: they are small, and dropping them would download the audio
  // again. A running transcription stays until it finishes.
  function retainVisible(known, anchors, connected, busy, released) {
    Object.keys(known).forEach(function (id) {
      var anchor = anchors[id];
      if (anchor && anchor.isConnected === false) delete anchors[id];
      if (connected[id] || busy[id]) return;
      var view = known[id];
      var status = view && view.status;
      if (!view || view.skip || status === "error" || status === "hidden" || status === "offer") return;
      if (status === "ready") rememberReleased(released, view);
      delete known[id];
      delete anchors[id];
    });
    var keep = Object.create(null);
    Object.keys(connected || {}).forEach(function (id) { keep[id] = true; });
    Object.keys(busy || {}).forEach(function (id) { keep[id] = true; });
    capIdMap(known, keep, MARKER_CAP);
    capIdMap(anchors, keep, MARKER_CAP);
  }

  function createQueue(limit, run) {
    var queued = [];
    var active = 0;
    var seen = Object.create(null);
    function pump() {
      while (active < limit && queued.length) {
        var id = queued.shift();
        if (seen[id] !== "queued") continue;
        seen[id] = "run";
        active += 1;
        (function (current) {
          Promise.resolve()
            .then(function () { return run(current); })
            .then(
              function () { seen[current] = "done"; },
              function () { delete seen[current]; }
            )
            .then(function () {
              active -= 1;
              pump();
            });
        })(id);
      }
    }
    return {
      add: function (id) {
        if (!id || seen[id]) return false;
        seen[id] = "queued";
        queued.push(id);
        pump();
        return true;
      },
      forget: function (id) {
        if (seen[id] === "run") return false;
        delete seen[id];
        return true;
      },
      state: function (id) { return seen[id] || ""; },
    };
  }

  // A finished attempt must not block the next one. A running attempt stays.
  function enqueueMissing(queue, id) {
    if (queue.state(id) === "done") queue.forget(id);
    return queue.add(id);
  }

  var BOX_STYLE = "margin-top:6px;padding:8px 10px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;white-space:pre-wrap;user-select:text;";
  var BUTTON_STYLE = "margin-top:6px;margin-right:8px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;cursor:pointer";
  var SUMMARY_STYLE = "margin-top:6px;padding:6px 10px;border-radius:8px;background:rgba(255,196,120,0.9);color:#3a2415;font-weight:700;";
  var SUMMARY_LIST_STYLE = "margin:2px 0 0;padding:0 0 0 18px;list-style:disc outside;color:#3a2415;font:inherit;font-weight:700;";
  var SUMMARY_ITEM_STYLE = "margin:2px 0;padding:0;color:#3a2415;font-weight:700;";
  var PANEL_ALPHA = 0.62;

  function parseColor(value) {
    var text = String(value || "").trim();
    var rgb = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
    if (rgb) {
      var alpha = 1;
      if (rgb[4] !== undefined) alpha = rgb[4].indexOf("%") === -1 ? parseFloat(rgb[4]) : parseFloat(rgb[4]) / 100;
      return { r: Math.round(parseFloat(rgb[1])), g: Math.round(parseFloat(rgb[2])), b: Math.round(parseFloat(rgb[3])), a: alpha };
    }
    var srgb = text.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\)$/);
    if (!srgb) return null;
    return {
      r: Math.round(parseFloat(srgb[1]) * 255),
      g: Math.round(parseFloat(srgb[2]) * 255),
      b: Math.round(parseFloat(srgb[3]) * 255),
      a: srgb[4] === undefined ? 1 : parseFloat(srgb[4]),
    };
  }

  function fallbackPaint(id) {
    if (String(id || "").indexOf("true_") === 0) return { background: { r: 217, g: 253, b: 211, a: 1 }, color: "#111b21" };
    return { background: { r: 255, g: 255, b: 255, a: 1 }, color: "#111b21" };
  }

  function bubbleAnchor(row) {
    if (!row || !row.querySelectorAll) return row;
    var buttons = row.querySelectorAll("button,[role='button']");
    for (var b = 0; b < buttons.length; b++) {
      if (isVoiceControl(buttons[b].getAttribute("aria-label") || "")) return buttons[b];
    }
    return row.querySelector("[data-testid='audio-player'],canvas,[data-icon='audio-play']") || row;
  }

  function wideEnough(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") return true;
    var rect = node.getBoundingClientRect();
    return rect.width >= 100;
  }

  function bubblePaint(row) {
    if (!row || typeof root.getComputedStyle !== "function") return null;
    var anchor = bubbleAnchor(row);
    var node = anchor && anchor !== row ? anchor.parentElement : anchor;
    for (var i = 0; node && i < 12; i++) {
      if (node !== anchor && wideEnough(node)) {
        try {
          var style = root.getComputedStyle(node);
          var bg = parseColor(style.backgroundColor);
          if (bg && bg.a > 0.45) return { background: bg, color: style.color || "" };
        } catch (e) {}
      }
      if (node === row) break;
      node = node.parentElement;
    }
    return null;
  }

  function panelStyle(id, paint) {
    var chosen = paint && paint.background ? paint : fallbackPaint(id);
    var bg = chosen.background;
    var color = chosen.color || "#111b21";
    return BOX_STYLE + "background:rgba(" + bg.r + "," + bg.g + "," + bg.b + "," + PANEL_ALPHA + ");color:" + color;
  }

  function explain(code) {
    var text = code && code.message ? code.message : code;
    text = String(text || "error");
    if (text.indexOf("fluidvoice") !== -1) return L("FluidVoice não respondeu. Abra o FluidVoice e ative a API local.", "FluidVoice did not respond. Open FluidVoice and turn on its local API.");
    if (text.indexOf("geniex_missing") !== -1 || text.indexOf("geniex_model_missing") !== -1) return L("Instale o GenieX e o modelo Q8 em Configurações → Transcrição.", "Install GenieX and the Q8 model in Settings → Transcription.");
    if (text.indexOf("geniex_") !== -1) return L("A transcrição local falhou. Verifique o GenieX e a NPU nas configurações.", "Local transcription failed. Check GenieX and NPU availability in Settings.");
    if (text.indexOf("audio_decode") !== -1) return L("Não foi possível decodificar o áudio deste arquivo.", "Could not decode this audio on this computer.");
    if (text.indexOf("no_audio") !== -1) return L("Este vídeo não tem áudio para transcrever.", "This video has no audio to transcribe.");
    if (text.indexOf("too_large") !== -1) return L("Esta nota é longa demais para transcrever.", "This note is too long to transcribe.");
    if (text.indexOf("no_key") !== -1) return L("Falta a chave da API nas configurações.", "The API key is missing in Settings.");
    if (text === "cli_missing") return L("Programa não encontrado. Confira o caminho nas configurações.", "CLI executable not found. Check the program path in Settings.");
    if (text === "cli_auth") return L("Entre na sua conta no Antigravity CLI.", "Sign in to your account in Antigravity CLI.");
    if (text === "cli_flags") return L("Atualize o programa para usar o modo restrito.", "Update the CLI to use the required restricted mode.");
    if (text === "cli_timeout") return L("O programa demorou demais para responder.", "The CLI request timed out.");
    if (text === "cli_failed") return L("O programa não respondeu. Confira se você entrou na sua conta pelo programa.", "The CLI request failed. Check that you're signed in to the program.");
    if (text.indexOf("llm") !== -1) return L("A IA não respondeu.", "The AI provider did not respond.");
    if (text.indexOf("no_transcript") !== -1) return L("Ainda não há transcrição.", "There is no transcript yet.");
    if (text.indexOf("locked") !== -1) return L("O whatRust está bloqueado.", "whatRust is locked.");
    return L("Não foi possível transcrever.", "Could not transcribe.");
  }

  // FluidVoice answers 400 while its decoder is busy or still loading. The same
  // bytes succeed a moment later, so keep the row loading and try again.
  // `attempt` is how many refusals this note has seen. Zero means show the error.
  function audioRetryDelay(notice, attempt) {
    var text = String(notice && notice.message ? notice.message : notice || "");
    if (text.indexOf("bad_audio") === -1) return 0;
    if (attempt < 1 || attempt > 8) return 0;
    return Math.min(8000, attempt * 1000);
  }

  function stopEvent(event) {
    event.stopPropagation();
  }

  function summaryPoints(value) {
    var lines = String(value || "").split("\n");
    var points = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s*(?:[-*•–—]|\d{1,2}[.)])\s+/, "").trim();
      if (line) points.push(line);
    }
    return points;
  }

  function renderBox(row, view, prefs) {
    var doc = root.document;
    if (!row || !view || !view.id || !doc) return null;
    var existing = row.querySelectorAll("[data-wr-voice]");
    var box = null;
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].getAttribute("data-wr-voice") === view.id) box = existing[i];
      else if (existing[i].parentNode) existing[i].parentNode.removeChild(existing[i]);
    }
    if (!box) {
      box = doc.createElement("div");
      box.setAttribute("data-wr-voice", view.id);
      box.addEventListener("pointerdown", stopEvent);
      box.addEventListener("click", stopEvent);
      row.appendChild(box);
    }
    box.style.cssText = view.status === "offer" ? "margin-top:6px;" : panelStyle(view.id, bubblePaint(row));
    var translation = prefs && prefs.translate
      && (!prefs.translation_key || view.translation_key === prefs.translation_key)
      ? view.translation : "";
    var signature = [
      view.status || "",
      view.text || "",
      translation || "",
      view.summary || "",
      view.summaryStatus || "",
      view.notice || "",
      prefs && prefs.translate ? "1" : "0",
    ].join("\n");
    if (box.getAttribute("data-sig") === signature) return box;
    box.setAttribute("data-sig", signature);
    while (box.firstChild) box.removeChild(box.firstChild);

    function addText(value, gap, marker) {
      var node = doc.createElement("div");
      if (marker) node.setAttribute(marker, "1");
      if (gap) node.style.marginTop = "4px";
      node.style.whiteSpace = "pre-wrap";
      node.textContent = value;
      box.appendChild(node);
    }

    if (view.status === "offer") {
      addButton(L("Transcrever", "Transcribe"), function () {
        if (typeof root.__whatrustVideoTranscribe === "function") root.__whatrustVideoTranscribe(view.id);
      });
      return box;
    }
    if (view.status === "loading") addText(L("Transcrevendo…", "Transcribing…"));
    if (view.status === "error") {
      var notice = String(view.notice || "error");
      if (view.media === "video" && notice.indexOf("too_large") !== -1) {
        addText(L("Este vídeo é longo demais para transcrever.", "This video is too long to transcribe."));
      } else addText(explain(notice));
      addButton(L("Tentar de novo", "Try again"), function () {
        if (typeof root.__whatrustVoiceRetry === "function") root.__whatrustVoiceRetry(view.id);
      });
    }
    if (view.status === "ready") {
      addText(
        view.text && String(view.text).trim() ? view.text : L("Sem fala reconhecida.", "No speech recognized."),
        false,
        "data-wr-voice-text"
      );
      if (translation) addText(translation, true);
      if (view.notice) addText(explain(view.notice), true);
      addSummary(view.summary);
      addButton(
        view.summaryStatus === "loading" ? L("Resumindo…", "Summarizing…") : L("Resumir", "Summarize"),
        function () {
          if (typeof root.__whatrustVoiceSummarize === "function") root.__whatrustVoiceSummarize(view.id);
        }
      );
      if (summaryPoints(view.summary).length) {
        addButton(L("Adicionar à lista de tarefas", "Add to To-Do"), function () {
          if (typeof root.__whatrustTodoFromVoice === "function") {
            root.__whatrustTodoFromVoice({
              id: view.id,
              summary: view.summary,
              transcript: view.text || "",
            });
          }
        });
      }
    }
    return box;

    function addSummary(value) {
      var points = summaryPoints(value);
      if (!points.length) return;
      var card = doc.createElement("div");
      card.style.cssText = SUMMARY_STYLE;
      var label = doc.createElement("div");
      label.textContent = L("Resumo", "Summary");
      card.appendChild(label);
      var list = doc.createElement("ul");
      list.setAttribute("data-wr-voice-summary", "1");
      list.style.cssText = SUMMARY_LIST_STYLE;
      for (var i = 0; i < points.length; i++) {
        var item = doc.createElement("li");
        item.style.cssText = SUMMARY_ITEM_STYLE;
        item.textContent = points[i];
        list.appendChild(item);
      }
      card.appendChild(list);
      box.appendChild(card);
    }

    function addButton(label, action) {
      var button = doc.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.cssText = BUTTON_STYLE;
      button.addEventListener("click", function (event) {
        stopEvent(event);
        action();
      });
      box.appendChild(button);
    }
  }

  if (root.__WHATRUST_TEST) {
    root.__whatrustVoiceApi = {
      isMessageId: isMessageId,
      isVoiceMessage: isVoiceMessage,
      isVideoMessage: isVideoMessage,
      looksLikeVoiceRow: looksLikeVoiceRow,
      chatApiReady: chatApiReady,
      audioRetryDelay: audioRetryDelay,
      looksLikeVideoRow: looksLikeVideoRow,
      mayContainVideo: mayContainVideo,
      messageIdOf: messageIdOf,
      intersectsViewport: intersectsViewport,
      pack: pack,
      createQueue: createQueue,
      retainVisible: retainVisible,
      capIdMap: capIdMap,
      enqueueMissing: enqueueMissing,
      releasedView: releasedView,
      renderBox: renderBox,
      panelStyle: panelStyle,
      parseColor: parseColor,
      pcmWav: pcmWav,
      toWav: toWav,
    };
    return;
  }

  if (root.__WHATRUST_AUDIO_SMOKE) root.__whatrustAudioSmoke = { toWav: toWav, pack: pack, view: function (id) { return known[id]; }, state: function (id) { return { checking: !!checking[id], queued: queue.state(id), retryAt: retryAt[id] || 0, enabled: prefs.enabled }; } };

  var prefs = { enabled: false, video: false, translate: false, geniex: false, target: "English" };
  function crumb(msg) {
    var tauri = root.__TAURI__;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") return;
    tauri.core.invoke("dlog", { msg: String(msg).slice(0, 280) }).catch(function () {});
  }
  crumb("voice: injected");
  function dismissConflict() {
    if (!root.document || !root.document.querySelectorAll) return;
    var nodes = root.document.querySelectorAll("button, [role='button']");
    for (var i = 0; i < nodes.length; i++) {
      var label = (nodes[i].innerText || nodes[i].textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (label === "use here" || label === "usar aqui") {
        nodes[i].click();
        crumb("voice: use-here");
        return;
      }
    }
  }
  var waitTimer = setInterval(function () {
    if (root.WPP && root.WPP.isReady) {
      clearInterval(waitTimer);
      return;
    }
    dismissConflict();
  }, 1000);
  var known = Object.create(null);
  var anchors = Object.create(null);
  var released = [];
  var times = Object.create(null);
  var openChat = "";
  var checking = Object.create(null);
  var retryAt = Object.create(null);
  var retryCount = Object.create(null);
  var retryToken = Object.create(null);
  var translationRequests = Object.create(null);
  var armed = false;
  var scheduled = false;
  function invoke(cmd, args) {
    var tauri = root.__TAURI__;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") {
      return Promise.reject("no_tauri");
    }
    return tauri.core.invoke(cmd, args === undefined ? {} : args);
  }

  function findRows(id) {
    if (!root.document) return [];
    var found = root.document.querySelectorAll('[data-id="' + cssEscape(id) + '"]');
    if (found.length) return found;
    var el = anchors[id];
    if (el && el.isConnected !== false) return [el];
    return [];
  }

  function paint(id) {
    if (typeof root.__whatrustPageBusy === "function" && root.__whatrustPageBusy()) {
      setTimeout(function () { paint(id); }, 250);
      return;
    }
    var view = known[id];
    if (!view || view.skip || view.status === "hidden") return;
    var rows = findRows(id);
    for (var i = 0; i < rows.length; i++) renderBox(rows[i], view, prefs);
    if (rows.length && view.status === "ready" && prefs.translate
        && prefs.translation_key && view.translation_key !== prefs.translation_key) {
      refreshTranslation(id, view);
    }
  }

  function refreshTranslation(id, view) {
    var currentPrefs = prefs;
    if (translationRequests[id] === currentPrefs) return;
    translationRequests[id] = currentPrefs;
    invoke("voice_lookup", { id: id }).then(function (looked) {
      if (prefs !== currentPrefs || known[id] !== view || !looked || looked.status !== "ready"
          || looked.translation_key !== currentPrefs.translation_key) return;
      view.translation = looked.translation;
      view.translation_key = looked.translation_key;
      if (!view.summaryStatus || view.summaryStatus !== "error") view.notice = looked.notice;
      paint(id);
    }).catch(function () {}).then(function () {
      if (translationRequests[id] === currentPrefs) delete translationRequests[id];
    });
  }

  var queue = createQueue(2, function (id) {
    known[id] = { id: id, status: "loading" };
    paint(id);
    return root.WPP.chat.downloadMedia(id).then(function (blob) {
      if (!blob || typeof blob.arrayBuffer !== "function") throw new Error("bad_audio");
      if (typeof blob.size === "number" && blob.size > MAX_WAV_BYTES) throw new Error("too_large");
      return blob.arrayBuffer();
    }).then(function (buffer) {
      return prefs.geniex ? toWav(buffer) : new Uint8Array(buffer);
    }).then(function (bytes) {
      if (!bytes.length) throw new Error("bad_audio");
      return invoke("transcribe_voice", pack(id, bytes, times[id])).then(function (view) {
        crumb("voice: transcribed bytes=" + bytes.length);
        return view;
      });
    }).then(function (view) {
      delete times[id];
      delete retryCount[id];
      delete retryToken[id];
      known[id] = view && view.status ? view : { id: id, status: "error", notice: "error" };
      paint(id);
      if (known[id].status === "loading") watchLoading(id);
    }).catch(function (error) {
      settleFailure(id, error, "");
    });
  });

  var videoQueue = createQueue(1, function (id) {
    if (!prefs.video) return;
    known[id] = { id: id, status: "loading", media: "video" };
    paint(id);
    return root.WPP.chat.downloadMedia(id).then(function (blob) {
      if (!prefs.video) return null;
      if (!blob || typeof blob.arrayBuffer !== "function") throw new Error("bad_audio");
      if (typeof blob.size === "number" && blob.size > MAX_VIDEO_BYTES) throw new Error("too_large");
      if (!blob.size) throw new Error("bad_audio");
      return blob.arrayBuffer();
    }).then(function (buffer) {
      if (!buffer || !prefs.video) return null;
      return prefs.geniex ? toWav(buffer) : new Uint8Array(buffer);
    }).then(function (bytes) {
      if (!bytes || !prefs.video) return null;
      if (!bytes.length) throw new Error("bad_audio");
      if (bytes.length > MAX_VIDEO_BYTES) throw new Error("too_large");
      return invoke("transcribe_video", pack(id, bytes, times[id])).then(function (view) {
        crumb("video: transcribed bytes=" + bytes.length);
        return view;
      });
    }).then(function (view) {
      delete times[id];
      delete retryCount[id];
      delete retryToken[id];
      if (!view || !prefs.video) {
        if (known[id] && known[id].status === "loading") delete known[id];
        return;
      }
      if (view.status) view.media = "video";
      known[id] = view.status ? view : { id: id, status: "error", notice: "error", media: "video" };
      paint(id);
      if (known[id].status === "loading") watchLoading(id);
    }).catch(function (error) {
      if (!prefs.video) return;
      settleFailure(id, error, "video");
    });
  });

  root.__whatrustVideoTranscribe = function (id) {
    if (!prefs.video || !isMessageId(id)) return;
    var view = known[id];
    if (view && (view.status === "loading" || view.status === "ready")) return;
    if (view && view.bytes > MAX_VIDEO_BYTES) {
      known[id] = { id: id, status: "error", media: "video", notice: "too_large" };
      paint(id);
      return;
    }
    videoQueue.forget(id);
    delete known[id];
    delete retryAt[id];
    videoQueue.add(id);
  };

  var prefsReady = false;

  root.__whatrustVoiceEnsure = function (id) {
    if (!isMessageId(id)) return;
    var tries = 0;
    function kick() {
      if (prefs.enabled) {
        var view = known[id];
        // A note that failed before its media was ready has to be able to
        // start again when the popup asks. consider() otherwise keeps the error.
        if (view && view.status === "error") {
          delete known[id];
          delete retryAt[id];
          queue.forget(id);
        }
        consider(id);
        return;
      }
      if (!prefsReady && tries < 20) {
        tries += 1;
        setTimeout(kick, 400);
      }
    }
    whenReady(kick);
  };

  root.__whatrustVoiceRetry = function (id) {
    delete retryToken[id];
    delete retryCount[id];
    var view = known[id];
    var target = view && view.media === "video" ? videoQueue : queue;
    if (!target.forget(id)) return;
    delete known[id];
    delete retryAt[id];
    target.add(id);
  };

  function settleFailure(id, error, media) {
    var notice = String(error && error.message ? error.message : error);
    var attempt = (retryCount[id] || 0) + 1;
    var wait = audioRetryDelay(notice, attempt);
    if (wait) {
      retryCount[id] = attempt;
      var token = {};
      retryToken[id] = token;
      var loading = { id: id, status: "loading" };
      if (media) loading.media = media;
      known[id] = loading;
      paint(id);
      crumb("voice: retry");
      setTimeout(function () {
        if (retryToken[id] !== token) return;
        var target = media === "video" ? videoQueue : queue;
        target.forget(id);
        if (target.add(id)) return;
        if (media === "video") considerVideo(id);
        else consider(id);
      }, wait);
      return;
    }
    delete retryCount[id];
    delete retryToken[id];
    var failed = { id: id, status: "error", notice: notice };
    if (media) failed.media = media;
    known[id] = failed;
    crumb(media === "video" ? "video: fail" : "voice: fail");
    paint(id);
  }

  root.__whatrustVoiceSummarize = function (id) {
    var view = known[id];
    if (!view || view.status !== "ready" || view.summaryStatus === "loading") return;
    view.summaryStatus = "loading";
    paint(id);
    invoke("summarize_voice", { id: id }).then(function (result) {
      view.summary = result && result.summary ? result.summary : "";
      view.summaryStatus = "ready";
      view.notice = "";
      paint(id);
    }).catch(function (error) {
      view.summaryStatus = "error";
      view.notice = String(error && error.message ? error.message : error);
      paint(id);
    });
  };

  function messageTime(msg) {
    var at = Number(msg && (msg.t || msg.timestamp) || 0);
    if (!isFinite(at) || at < 0) return 0;
    if (at > 0 && at < 1e12) at *= 1000;
    return at;
  }

  function watchLoading(id) {
    setTimeout(function () {
      var view = known[id];
      if (!view || view.status !== "loading") return;
      var state = queue.state(id);
      var video = videoQueue.state(id);
      if (state === "queued" || state === "run" || video === "queued" || video === "run") return;
      delete known[id];
      if (view.media === "video") considerVideo(id);
      else consider(id);
    }, 1500);
  }

  function finishVideo(id, looked, bytes) {
    if (!prefs.video || !looked || (known[id] && known[id].skip)) return;
    if (looked.status === "disabled") return;
    if (looked.status === "ready") {
      looked.media = "video";
      known[id] = looked;
      paint(id);
      return;
    }
    if (looked.status === "loading") {
      known[id] = { id: id, status: "loading", media: "video" };
      paint(id);
      watchLoading(id);
      return;
    }
    if (looked.status === "missing") {
      known[id] = { id: id, status: "offer", media: "video", bytes: bytes || 0 };
      paint(id);
    }
  }

  function consider(id) {
    if (!prefs.enabled || known[id] || checking[id]) return;
    if (retryAt[id] && Date.now() < retryAt[id]) return;
    var cached = releasedView(released, id);
    if (cached && cached.status === "ready") {
      known[id] = cached;
      paint(id);
    }
    checking[id] = true;
    var at = 0;
    root.WPP.chat.getMessageById(id).then(function (msg) {
      at = messageTime(msg);
      if (isVideoMessage(msg)) {
        times[id] = at;
        if (!prefs.video) {
          known[id] = { id: id, media: "video", status: "hidden" };
          return null;
        }
        var bytes = mediaBytes(msg);
        return invoke("voice_lookup", { id: id }).then(function (looked) {
          finishVideo(id, looked, bytes);
          return null;
        });
      }
      if (!isVoiceMessage(msg)) known[id] = { skip: true };
      else return invoke("voice_lookup", { id: id });
      return null;
    }).then(function (looked) {
      if (!looked || known[id] && known[id].skip) return;
      if (looked.status === "disabled") return;
      if (looked.status === "ready") {
        known[id] = looked;
        paint(id);
        return;
      }
      if (looked.status === "loading") {
        known[id] = { id: id, status: "loading" };
        paint(id);
        watchLoading(id);
        return;
      }
      if (looked.status === "missing") {
        times[id] = at;
        // A previous attempt can still be marked done: the row was missing
        // after a crash, or another caller owned it and then dropped it.
        known[id] = { id: id, status: "loading" };
        if (!enqueueMissing(queue, id)) watchLoading(id);
        paint(id);
      }
    }).catch(function () {
      retryAt[id] = Date.now() + 5000;
    }).then(function () {
      delete checking[id];
    });
  }

  function considerVideo(id) {
    if (!prefs.video || known[id] || checking[id]) return;
    if (retryAt[id] && Date.now() < retryAt[id]) return;
    checking[id] = true;
    var bytes = 0;
    root.WPP.chat.getMessageById(id).then(function (msg) {
      times[id] = messageTime(msg);
      if (!isVideoMessage(msg)) {
        if (!isVoiceMessage(msg)) known[id] = { skip: true };
        return null;
      }
      bytes = mediaBytes(msg);
      return invoke("voice_lookup", { id: id });
    }).then(function (looked) {
      finishVideo(id, looked, bytes);
    }).catch(function () {
      retryAt[id] = Date.now() + 5000;
    }).then(function () {
      delete checking[id];
    });
  }

  function clearVideoUi() {
    Object.keys(known).forEach(function (id) {
      var view = known[id];
      if (!view || view.media !== "video") return;
      videoQueue.forget(id);
      var rows = findRows(id);
      for (var i = 0; i < rows.length; i++) {
        var boxes = rows[i].querySelectorAll("[data-wr-voice]");
        for (var b = 0; b < boxes.length; b++) {
          if (boxes[b].getAttribute("data-wr-voice") === id && boxes[b].parentNode) {
            boxes[b].parentNode.removeChild(boxes[b]);
          }
        }
      }
      delete known[id];
      delete anchors[id];
      delete retryAt[id];
    });
  }

  function noteChat(id) {
    var parts = /^(?:true|false)_([^_]+)_/.exec(id || "");
    var chat = parts ? parts[1] : "";
    if (!chat) return;
    if (openChat && openChat !== chat) released.length = 0;
    openChat = chat;
  }

  function sweep() {
    var connected = Object.create(null);
    var busy = Object.create(null);
    Object.keys(known).forEach(function (id) {
      var rows = findRows(id);
      for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].isConnected !== false) connected[id] = true;
      }
      var state = queue.state(id);
      var video = videoQueue.state(id);
      if (state === "queued" || state === "run" || video === "queued" || video === "run") busy[id] = true;
    });
    retainVisible(known, anchors, connected, busy, released);
    // `checking` means a fetch is in flight. Dropping it would start a second
    // download of the same note. Retry times are only a cooldown.
    var now = Date.now();
    Object.keys(retryAt).forEach(function (id) {
      if (!(retryAt[id] > now)) delete retryAt[id];
    });
    capIdMap(retryAt, null, MARKER_CAP);
  }

  function scan() {
    if ((!prefs.enabled && !prefs.video) || !root.document) return;
    var main = root.document.getElementById("main") || root.document;
    var rows = main.querySelectorAll("[data-id]");
    if (prefs.enabled) {
      for (var i = 0; i < rows.length; i++) {
        var id = rows[i].getAttribute("data-id");
        if (!isMessageId(id) || !looksLikeVoiceRow(rows[i]) || !intersectsViewport(rows[i])) continue;
        anchors[id] = rows[i];
        noteChat(id);
        consider(id);
      }
    }
    var controls = prefs.enabled ? main.querySelectorAll("button,[role='button']") : [];
    for (var c = 0; c < controls.length; c++) {
      if (!isVoiceControl(controls[c].getAttribute("aria-label") || "")) continue;
      var voiceRow = controls[c].closest('[data-testid="msg-container"]');
      if (!voiceRow || !intersectsViewport(voiceRow)) continue;
      var voiceId = messageIdOf(voiceRow);
      if (!isMessageId(voiceId)) continue;
      anchors[voiceId] = voiceRow;
      noteChat(voiceId);
      consider(voiceId);
    }
    if (prefs.video) {
      for (var v = 0; v < rows.length; v++) {
        var videoId = rows[v].getAttribute("data-id");
        if (!isMessageId(videoId) || !mayContainVideo(rows[v]) || !intersectsViewport(rows[v])) continue;
        anchors[videoId] = rows[v];
        noteChat(videoId);
        considerVideo(videoId);
      }
      // Some WhatsApp versions keep the message ID in React props instead of
      // a data-id attribute, as with voice messages above.
      var videoRows = main.querySelectorAll('[data-testid="msg-container"]');
      for (var vr = 0; vr < videoRows.length; vr++) {
        if (!mayContainVideo(videoRows[vr]) || !intersectsViewport(videoRows[vr])) continue;
        var fallbackId = messageIdOf(videoRows[vr]);
        if (!isMessageId(fallbackId)) continue;
        anchors[fallbackId] = videoRows[vr];
        noteChat(fallbackId);
        considerVideo(fallbackId);
      }
    }
    sweep();
    Object.keys(known).forEach(paint);
  }

  var menuQuietUntil = 0;
  function noteMenuGesture(event) {
    var target = event && event.target;
    if (!target || !target.closest || !target.closest("#main")) return;
    menuQuietUntil = Date.now() + 1000;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      if ((typeof root.__whatrustPageBusy === "function" && root.__whatrustPageBusy()) || Date.now() < menuQuietUntil) {
        schedule();
        return;
      }
      scan();
    }, 300);
  }

  function arm() {
    if (armed || !root.document || !root.document.documentElement) return;
    armed = true;
    if (root.document.addEventListener) {
      root.document.addEventListener("pointerdown", noteMenuGesture, true);
      root.document.addEventListener("contextmenu", noteMenuGesture, true);
    }
    new MutationObserver(schedule).observe(root.document.documentElement, { childList: true, subtree: true });
    root.document.addEventListener("scroll", schedule, true);
    schedule();
    crumb("voice: watching");
  }

  // isReady waits on conn.main_init. That event is not replayed, so a page
  // that was already connected — the usual case for a second account — leaves
  // the flag false forever. The chat methods and the live connection are enough.
  function chatApiReady(wpp) {
    try {
      if (!wpp || !wpp.chat) return false;
      if (typeof wpp.chat.getMessageById !== "function") return false;
      if (typeof wpp.chat.downloadMedia !== "function") return false;
    } catch (e) {
      return false;
    }
    var loaderReady = false;
    try { loaderReady = !!wpp.isReady; } catch (e) { loaderReady = false; }
    if (loaderReady) return true;
    try {
      var conn = wpp.conn;
      return !!(conn && typeof conn.isMainReady === "function" && conn.isMainReady());
    } catch (e) {
      return false;
    }
  }

  function whenReady(done) {
    var waits = 0;
    (function tick() {
      var ready = false;
      try { ready = chatApiReady(root.WPP); } catch (e) { ready = false; }
      if (ready) {
        done();
        return;
      }
      waits += 1;
      if (waits === 25) crumb("voice: waiting for chat api");
      setTimeout(tick, 400);
    })();
  }

  root.__whatrustVoicePrefs = function (next) {
    prefsReady = true;
    released.length = 0;
    if (next && typeof next === "object") {
      prefs = {
        enabled: !!next.enabled,
        video: !!next.video,
        translate: !!next.translate,
        translation_key: next.translation_key || "",
        geniex: !!next.geniex,
        target: next.target || "English",
      };
    }
    if (prefs.video) {
      Object.keys(known).forEach(function (id) {
        if (known[id] && known[id].status === "hidden") delete known[id];
      });
    } else clearVideoUi();
    if (!prefs.enabled && !prefs.video) return;
    whenReady(function () {
      arm();
      schedule();
      Object.keys(known).forEach(function (id) {
        var view = known[id];
        if (!view || view.skip || view.status !== "ready") return;
        if (view.media === "video" && !prefs.video) return;
        paint(id);
        if (prefs.translate && !view.translation) refreshTranslation(id, view);
      });
    });
  };

  whenReady(function () {
    invoke("voice_prefs").then(function (next) {
      root.__whatrustVoicePrefs(next || { enabled: true, video: false, translate: false, target: "English" });
    }).catch(function () {
      root.__whatrustVoicePrefs({ enabled: true, video: false, translate: false, target: "English" });
    });
  });
})();

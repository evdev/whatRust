/* Scheduled messages. File bytes only come from locally selected original Files. */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  if (!root.__WHATRUST_TEST && (!root.location || root.location.origin !== "https://web.whatsapp.com")) return;
  function L(pt, en) { return root.__WR_LANG === "en" ? en : pt; }
  function chatId(value) {
    var raw = typeof value === "string" ? value : value && (value._serialized || String(value)) || "";
    return /^(?:\d+(?::\d+)?@(c\.us|lid|s\.whatsapp\.net)|\d+(?:-\d+)*@g\.us)$/.test(raw) ? raw.replace(/:\d+@/, "@") : "";
  }
  function activeChat() {
    try {
      var chat = root.WPP.chat.getActiveChat();
      var id = chat && !chat.then && chatId(chat.id);
      return id ? { id: id, name: String(chat.formattedTitle || chat.name || id) } : null;
    } catch (_) { return null; }
  }
  function scheduleChat(context) {
    var id = context && chatId(context.id);
    return id ? { id: id, name: String(context.name || id) } : activeChat();
  }
  var ACTION = "button,[role='button']";
  var SEND = "[data-icon='send'],[data-icon^='wds-ic-send'],[data-testid='compose-btn-send'],[data-testid='send'],[aria-label='Send' i],[aria-label='Send message' i],[aria-label='Enviar' i],[aria-label='Enviar mensagem' i]";
  var MIC = "[data-icon='ptt'],[data-icon='mic'],[data-icon='microphone'],[data-icon^='wds-ic-mic'],[data-testid='compose-btn-ptt'],[aria-label='Voice message' i],[aria-label='Record voice message' i],[aria-label='Mensagem de voz' i],[aria-label='Gravar mensagem de voz' i]";
  function visible(node) {
    return node && !node.closest("[hidden],[aria-hidden='true']") && node.getClientRects().length > 0;
  }
  function nativeAction(scope, selector) {
    if (!scope) return null;
    for (var match of scope.querySelectorAll(selector)) {
      var action = match.closest(ACTION) || match.querySelector(ACTION);
      if (action && scope.contains(action) && visible(action)) return action;
    }
    return null;
  }
  function composerContext(doc) {
    var main = doc.querySelector("#main");
    if (!main) return null;
    var editable = "[contenteditable='true']";
    var input = Array.from(main.querySelectorAll("[data-testid='conversation-compose-box-input']" + editable + ", [data-testid='conversation-compose-box-input'] " + editable + ", footer " + editable)).find(visible);
    if (!input) return null;
    var scope = input.closest("footer,[data-testid='conversation-compose-box']") ||
      input.closest("[data-testid='conversation-compose-box-input']").parentElement;
    if (!scope) return null;
    return { input: input, scope: scope, action: nativeAction(scope, SEND) || nativeAction(scope, MIC) };
  }
  function actionSlot(action, scope, controls) {
    // Step out of single-button wrappers. WhatsApp often gives those wrappers
    // the width of the native button, so siblings inserted inside are clipped.
    while (action.parentElement && action.parentElement !== scope &&
        Array.from(action.parentElement.children).every(function (child) { return child === action || child === controls; })) {
      action = action.parentElement;
    }
    return action;
  }
  function draftText(input) {
    if (!input) return "";
    // WhatsApp renders some emoji as img nodes; innerText omits their alt text.
    if (input.querySelector && input.querySelector("img[alt]")) {
      function read(node) {
        if (node.nodeType === 3) return node.nodeValue || "";
        var tag = String(node.tagName || "").toLowerCase();
        if (tag === "img") return node.getAttribute("data-plain-text") || node.getAttribute("alt") || "";
        if (tag === "br") return "\n";
        var text = "", children = Array.from(node.childNodes || []);
        children.forEach(function (child, i) {
          var block = /^(div|p)$/.test(String(child.tagName || "").toLowerCase());
          if (block && i > 0 && text.slice(-1) !== "\n") text += "\n";
          text += read(child);
        });
        return text;
      }
      return read(input).replace(/\r\n/g, "\n");
    }
    return String(input.innerText === undefined ? input.textContent || "" : input.innerText).replace(/\r\n/g, "\n");
  }
  var ATTACHMENT_MIMES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp", pdf: "application/pdf" };
  function attachmentMime(file) {
    var mime = String(file.type || "").toLowerCase();
    if (mime && mime !== "application/octet-stream") return mime;
    var extension = file.name.toLowerCase().split(".").pop();
    return Object.prototype.hasOwnProperty.call(ATTACHMENT_MIMES, extension) ? ATTACHMENT_MIMES[extension] : "application/octet-stream";
  }
  function mode(file) { var mime = attachmentMime(file); return /^image\//.test(mime) ? "image" : /^video\//.test(mime) ? "video" : "document"; }
  function originalFiles(files) {
    return !!files && files.length > 0 && files.length <= 200 && files.every(function (f) { return typeof root.File === "function" && f instanceof root.File && f.size > 0 && f.size <= 100 * 1024 * 1024; }) && files.reduce(function (sum, f) { return sum + f.size; }, 0) <= 500 * 1024 * 1024;
  }
  function captureObjectURLs(urlApi) {
    var originals = new Map();
    if (!urlApi || typeof urlApi.createObjectURL !== "function") return originals;
    var create = urlApi.createObjectURL, revoke = urlApi.revokeObjectURL;
    urlApi.createObjectURL = function (object) {
      var url = create.apply(this, arguments);
      if (typeof root.File === "function" && object instanceof root.File) {
        originals.set(url, object);
        while (originals.size > 64) originals.delete(originals.keys().next().value);
      }
      return url;
    };
    if (typeof revoke === "function") urlApi.revokeObjectURL = function (url) { originals.delete(url); return revoke.apply(this, arguments); };
    return originals;
  }
  function verifyNativePreview(capture, container, urls) {
    if (!capture || capture.files.length !== 1 || capture.edited || !container || container.getAttribute("data-testid") !== "media-editor") return null;
    var media = Array.from(container.querySelectorAll("img[src^='blob:'],video[src^='blob:']"));
    var caption = container.querySelector("[data-testid='media-caption-input-container'] [contenteditable='true']");
    var once = container.querySelector("[data-icon='view-once'],[data-icon='view-once-off']");
    var onceControl = once && once.closest("button,[role='button']");
    var off = once && once.getAttribute("data-icon") === "view-once-off" || onceControl && (onceControl.getAttribute("aria-pressed") === "false" || onceControl.getAttribute("aria-checked") === "false");
    var file = media.length === 1 && urls.get(media[0].getAttribute("src"));
    if (file !== capture.files[0] || !caption || !off || container.querySelector("canvas,[data-testid*='crop'],[data-view-once='true'],[aria-pressed='true']")) return null;
    var node = media[0];
    while (node && node !== container) {
      var style = root.getComputedStyle(node);
      if (style.transform && style.transform !== "none" || style.clipPath && style.clipPath !== "none" || style.filter && style.filter !== "none") return null;
      node = node.parentElement;
    }
    if (node !== container) return null;
    return { chat: capture.chat, files: [file], captions: [draftText(caption)], text: draftText(caption), fromPreview: true, previewContainer: container };
  }
  function latestReview(rows) {
    var out = Object.create(null), unresolved = [];
    (rows || []).forEach(function (row) {
      if (row.state !== "missed") { unresolved.push(row); return; }
      if (!out[row.schedule_id] || row.due_ms > out[row.schedule_id].due_ms) out[row.schedule_id] = row;
    });
    return Object.keys(out).map(function (key) { return out[key]; }).concat(unresolved);
  }
  function reviewActions(row) { return row.state === "uncertain" ? ["skip"] : row.state === "failed" ? ["retry", "skip"] : ["send", "skip"]; }
  function reviewActionAvailable(state, occurrenceId, action, busy, locked) {
    var row = (state.review || []).find(function (item) { return item.occurrence_id === occurrenceId; });
    return !busy && !locked && !!row && reviewActions(row).indexOf(action) !== -1 && (action === "skip" || !!state.can_send);
  }
  function messagePreview(row) {
    if (row.text) return row.text;
    return (row.attachments || []).map(function (file) {
      return file.caption ? file.name + " · " + file.caption : file.name;
    }).join("\n");
  }
  function otherAccountPending(state) {
    return (state.pending_accounts || []).filter(function (item) { return item.count > 0 && item.account_id !== state.current_account_id; });
  }
  function validTime(local, zone) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local)) return false;
    var parts = local.match(/\d+/g).map(Number), d = new Date(0);
    d.setUTCFullYear(parts[0], parts[1] - 1, parts[2]); d.setUTCHours(parts[3], parts[4], 0, 0);
    if (d.getUTCFullYear() !== parts[0] || d.getUTCMonth() !== parts[1] - 1 || d.getUTCDate() !== parts[2] || d.getUTCHours() !== parts[3] || d.getUTCMinutes() !== parts[4]) return false;
    try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); return true; } catch (_) { return false; }
  }
  function localDate(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + "T" + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  }
  function invoke(command, args) {
    if (!root.__TAURI__ || !root.__TAURI__.core) return Promise.reject(new Error(L("Aplicativo indisponível.", "App unavailable.")));
    return root.__TAURI__.core.invoke(command, args || {});
  }
  async function clearSavedDraft(capture) {
    var current = activeChat();
    if (!capture || !capture.input || !current || current.id !== capture.chat.id || !capture.input.isConnected || draftText(capture.input) !== capture.text) return false;
    var api = root.WPP && root.WPP.chat;
    if (!api || typeof api.setInputText !== "function") return false;
    await api.setInputText("", capture.chat.id);
    return true;
  }
  async function stageFiles(files, captions, voice) {
    if (!originalFiles(files)) throw new Error(L("Selecione arquivos originais não vazios: até 200 arquivos, 100 MiB por arquivo e 500 MiB no total.", "Select nonempty original files: up to 200 files, 100 MiB per file and 500 MiB total."));
    var stage = await invoke("schedule_stage_begin", { files: files.map(function (f, i) { return { name: f.name, mime: attachmentMime(f), size: f.size, mode: voice ? "voice" : mode(f), caption: voice ? "" : captions[i] || "" }; }) });
    try {
      for (var i = 0; i < files.length; i++) {
        for (var offset = 0; offset < files[i].size; offset += 262144) {
          var bytes = new Uint8Array(await files[i].slice(offset, offset + 262144).arrayBuffer());
          var binary = "";
          for (var n = 0; n < bytes.length; n++) binary += String.fromCharCode(bytes[n]);
          await invoke("schedule_stage_chunk", { stage_id: stage, file_index: i, offset: offset, data: root.btoa(binary) });
        }
      }
      return stage;
    } catch (error) { await invoke("schedule_stage_discard", { stage_id: stage }).catch(function () {}); throw error; }
  }
  if (root.__WHATRUST_TEST) {
    root.__whatrustScheduleUiApi = { chatId: chatId, scheduleChat: scheduleChat, draftText: draftText, latestReview: latestReview, reviewActions: reviewActions, messagePreview: messagePreview, validTime: validTime, originalFiles: originalFiles, clearSavedDraft: clearSavedDraft, stageFiles: stageFiles, attachmentMime: attachmentMime, captureObjectURLs: captureObjectURLs, verifyNativePreview: verifyNativePreview, otherAccountPending: otherAccountPending, errorText: errorText, composerContext: composerContext, actionSlot: actionSlot };
    root.__whatrustScheduleUiApi.reviewActionAvailable = reviewActionAvailable;
    return;
  }
  var doc = root.document, snapshot = { schedules: [], review: [] }, panel, panelCleanup, shadow, controls, previewButton, nudge, listView, refreshIssued = 0, refreshApplied = 0, captured = null, refreshPending = false, dismissedReview = "";
  var pdfPreviewQueue = Promise.resolve();
  var pendingReview = Object.create(null);
  var originalURLs = captureObjectURLs(root.URL);
  function preview() {
    var candidates = doc.querySelectorAll("[data-testid='media-editor'],[data-testid='media-caption-input-container']");
    return Array.from(candidates).find(function (node) { return node.getAttribute("data-testid") === "media-editor" && visible(node); }) || Array.from(candidates).find(visible);
  }
  function el(tag, text, parent) { var n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (parent) parent.appendChild(n); return n; }
  function button(text, fn, parent) { var b = el("button", text, parent); b.type = "button"; b.addEventListener("click", fn); return b; }
  function errorText(error) {
    var text = String(error && error.message || error);
    var messages = {
      attachment_stage_busy: L("Outro envio de arquivos está em andamento. Aguarde e tente novamente.", "Another file upload is in progress. Wait and try again."),
      date_in_past: L("Escolha uma data e hora futuras no fuso original.", "Choose a future date and time in the original time zone."),
      delivery_in_progress: L("Esta mensagem está sendo enviada. Aguarde o resultado antes de alterar o agendamento.", "This message is being sent. Wait for the result before changing its schedule."),
      account_unavailable: L("Esta conta está indisponível. Abra e desbloqueie a conta para continuar.", "This account is unavailable. Open and unlock the account to continue."),
      schedule_changed: L("O agendamento mudou. Abra-o novamente e tente outra vez.", "The schedule changed. Reopen it and try again.")
    };
    for (var key in messages) if (text.indexOf(key) !== -1) return messages[key];
    return L("Não foi possível atualizar os agendamentos. ", "Could not update scheduled messages. ") + text.slice(0, 240);
  }
  function createPanel(title) {
    var previous = doc.activeElement;
    closePanel();
    panel = el("div"); panel.id = "__whatrust_schedule";
    var owner = panel;
    shadow = panel.attachShadow({ mode: "open" });
    el("style", ":host{font:14px/1.5 system-ui;color-scheme:light dark}*{box-sizing:border-box}dialog{color:light-dark(#172127,#e9edef);background:light-dark(#fff,#202c33);border:1px solid #8696a055;border-radius:16px;padding:24px;width:560px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto}dialog::backdrop{background:#0007}h2{font-size:20px;margin:0 0 12px}p{overflow-wrap:anywhere}label{display:block;margin:12px 0}input,select,textarea{font:inherit;color:inherit;background:light-dark(#f0f2f5,#111b21);border:1px solid #8696a077;border-radius:6px;padding:8px;max-width:100%;width:100%}textarea{min-height:100px;resize:vertical}button{font:inherit;border:1px solid #8696a066;border-radius:8px;padding:8px 12px;cursor:pointer;margin:5px 6px 5px 0;color:inherit;background:light-dark(#f0f2f5,#34454f)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #25d366;outline-offset:2px}button:disabled{opacity:.5;cursor:wait}.primary{background:#21c063;color:#082316}article{border-top:1px solid #8696a044;padding:12px 0}.status{white-space:pre-wrap}.row{display:flex;gap:12px}.row>label{flex:1;min-width:0}", shadow);
    el("style", `
      .schedule-editor{width:388px;padding:14px;line-height:1.35}
      .schedule-editor [hidden]{display:none!important}
      .schedule-editor h2{font-size:18px;margin:0 0 2px}
      .schedule-recipient,.schedule-zone,.schedule-files{color:light-dark(#52636c,#aebac1);font-size:12px;margin:0}
      .schedule-recipient{margin-bottom:9px}
      .schedule-editor form{display:grid;gap:8px}
      .schedule-editor label{margin:0;min-width:0;font-size:13px}
      .schedule-editor label>input,.schedule-editor label>select,.schedule-editor label>textarea{display:block;margin-top:3px}
      .schedule-editor textarea{min-height:56px;height:56px}
      .schedule-editor input,.schedule-editor select,.schedule-editor textarea{padding:6px 8px}
      .schedule-zone{display:block;margin-top:3px}
      .schedule-quick{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}
      .schedule-repeat-options{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:8px}
      .schedule-tools,.schedule-actions{display:flex;align-items:center;gap:6px}
      .schedule-tools .schedule-media-button{display:inline-grid;place-items:center;width:34px;height:34px;padding:0;border-radius:50%}
      .schedule-attachments{display:grid;gap:5px;min-width:0}
      .schedule-attachment-heading{display:flex;justify-content:space-between;align-items:center}
      .schedule-previews{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,130px),1fr));gap:6px;max-height:190px;overflow:auto}
      .schedule-preview-card{min-width:0;overflow:hidden;border:1px solid #8696a055;border-radius:8px;background:light-dark(#f3f6f7,#18242b)}
      .schedule-preview-name{padding:5px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
      .schedule-preview-card img,.schedule-preview-card video{display:block;width:100%;height:107px;object-fit:contain;background:light-dark(#ebeff1,#111b21)}
      .schedule-preview-card img[data-pdf-page]{background:white}
      .schedule-preview-card audio{display:block;width:100%;height:38px}
      .schedule-editor button{margin:0;padding:6px 10px}
      .schedule-editor .schedule-link{background:transparent;border-color:transparent;flex:none;padding-inline:4px}
      .schedule-actions{justify-content:flex-end;padding-top:2px}
      .schedule-editor .status{margin:0;font-size:12px}
      .schedule-editor .status:empty{display:none}
    `, shadow);
    var dialog = el("dialog", undefined, shadow); dialog.setAttribute("aria-label", title);
    el("h2", title, dialog);
    dialog.addEventListener("close", function () {
      if (panel !== owner) return;
      closePanel();
      if (previous && previous.isConnected) previous.focus();
    });
    doc.body.appendChild(panel); dialog.showModal();
    return dialog;
  }
  function createListPage(container, title) {
    var host = el("div");
    host.id = "__whatrust_schedule_page";
    var pageShadow = host.attachShadow({ mode: "open" });
    el("style", `
      :host{display:block;height:100%;font:13px/1.4 system-ui,sans-serif}
      *{box-sizing:border-box}
      .schedule-page{
        --base:light-dark(#f2f6f5,#10191e);--surface:light-dark(#fff,#1b282f);
        --edge:light-dark(#dbe6e2,#344750);--muted:light-dark(#526970,#a9bbc2);
        --accent:light-dark(#006752,#72dfbc);--active:light-dark(#e0f3ec,#214139);
        height:100%;display:flex;flex-direction:column;overflow:hidden;
        background:var(--base);color:light-dark(#172127,#e9edef);border-inline-end:1px solid var(--edge)
      }
      [hidden],p:empty{display:none!important}
      button{margin:0;min-height:30px;padding:4px 9px;border:1px solid var(--edge);border-radius:7px;background:transparent;color:inherit;font:inherit;line-height:1.3;cursor:pointer}
      button:disabled{cursor:default;opacity:.5}
      button:not(:disabled):hover,.schedule-more summary:hover{background:var(--active)}
      button:focus-visible,.schedule-more summary:focus-visible,.schedule-list-pane:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
      .schedule-page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;background:var(--surface);padding:14px 14px 10px}
      .schedule-page-header h2{font-size:18px;line-height:1.25;margin:0;letter-spacing:-.025em}
      .schedule-page-header p{margin:3px 0 0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
      button.schedule-close{border:0;font-size:19px;min-width:30px;padding:0;color:var(--muted)}
      .schedule-tabs{display:grid;grid-template-columns:.9fr 1.15fr;gap:4px;padding:0 12px 9px;background:var(--surface);border-bottom:1px solid var(--edge)}
      .schedule-tabs button{display:flex;align-items:center;justify-content:center;gap:5px;min-height:36px;border-color:transparent;font-weight:600;color:var(--muted);padding:4px}
      .schedule-tabs button[aria-selected=true]{background:var(--active);color:var(--accent)}
      .schedule-count{display:inline-grid;place-items:center;min-width:18px;padding:0 4px;border-radius:99px;background:var(--surface);font-size:11px;font-variant-numeric:tabular-nums}
      .schedule-list-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:10px 11px 12px}
      .schedule-list-pane{display:grid;gap:7px}
      .schedule-list-status{margin:0 0 8px;color:var(--muted);overflow-wrap:anywhere}
      .schedule-list-alert{padding:7px 8px;background:light-dark(#fff4db,#382b18);color:light-dark(#704800,#ffd388);border-radius:7px;margin:0;overflow-wrap:anywhere}
      .schedule-card{padding:8px 9px;margin:0;border:1px solid var(--edge);border-radius:10px;background:var(--surface);min-width:0}
      .schedule-review-card{border-inline-start:3px solid var(--mark)}
      .schedule-card[data-state=missed]{--mark:light-dark(#a36310,#f1b451);--tag:light-dark(#fff1d8,#382b18);--tag-text:light-dark(#754900,#ffce7a)}
      .schedule-card[data-state=failed]{--mark:light-dark(#b74440,#ef827c);--tag:light-dark(#ffedeb,#422626);--tag-text:light-dark(#982927,#ffb0a8)}
      .schedule-card[data-state=uncertain]{--mark:light-dark(#6665a8,#a6a6f8);--tag:light-dark(#efeeff,#303050);--tag-text:light-dark(#504e8e,#cbcaff)}
      .schedule-card-top{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}
      .schedule-card-footer{display:flex;align-items:flex-end;justify-content:space-between;gap:6px}
      .schedule-card-footer>div:first-child{min-width:0}
      .schedule-card-top strong{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
      .schedule-card p{margin:4px 0;color:var(--muted);overflow-wrap:anywhere}
      .schedule-card .schedule-snippet{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:inherit;white-space:pre-line;min-width:0}
      .schedule-due,.schedule-meta{font-size:11px;color:var(--muted);overflow-wrap:anywhere}
      .schedule-card .schedule-due{display:block;margin-bottom:3px;font-size:12px;color:var(--accent);font-weight:650}
      .schedule-review-card .schedule-due{margin:0 0 4px;font-size:11px;color:var(--muted);font-weight:400}
      .schedule-pill{flex:none;border-radius:99px;background:var(--tag);color:var(--tag-text);padding:2px 7px;font-size:11px;font-weight:650}
      .schedule-card-actions{display:flex;justify-content:flex-end;gap:5px;flex-wrap:wrap}
      .schedule-card-actions .schedule-send-action{background:var(--active);color:var(--accent);font-weight:650;border-color:transparent}
      .schedule-more summary{cursor:pointer;list-style:none;text-align:center;border:1px solid var(--edge);border-radius:7px;min-width:30px;padding:4px 6px;font-weight:700;line-height:20px}
      .schedule-more summary::-webkit-details-marker{display:none}
      .schedule-more[open] button{margin-top:6px}
      .schedule-empty{padding:18px 10px;text-align:center;color:var(--muted);margin:0}
    `, pageShadow);
    var page = el("section", undefined, pageShadow);
    page.className = "schedule-page"; page.setAttribute("aria-label", title);
    container.replaceChildren(host);
    return page;
  }
  function closePanel() {
    if (panel) panel.remove();
    panel = null; shadow = null;
    var cleanup = panelCleanup; panelCleanup = null;
    if (cleanup) cleanup();
  }
  function field(parent, title, type, value) { var label = el("label", title, parent), input = el("input", undefined, label); input.type = type; input.value = value || ""; return input; }
  function select(parent, title, options, value) { var label = el("label", title, parent), input = el("select", undefined, label); options.forEach(function (o) { var opt = el("option", o[1], input); opt.value = o[0]; }); input.value = value; return input; }
  function plusIcon(button) {
    var ns = "http://www.w3.org/2000/svg", svg = doc.createElementNS(ns, "svg"), path = doc.createElementNS(ns, "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "21"); svg.setAttribute("height", "21"); svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", "M12 5v14M5 12h14"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "2"); path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path); button.appendChild(svg);
  }
  function attachmentPreviews(grid) {
    var urls = [], observer, generation = 0;
    function clear() {
      generation++;
      if (observer) observer.disconnect(); observer = null;
      urls.forEach(function (url) { root.URL.revokeObjectURL(url); }); urls = [];
      grid.replaceChildren();
    }
    function media(tag, blob, card, name, pdf) {
      var item = el(tag), url = root.URL.createObjectURL(blob);
      urls.push(url);
      if (tag === "img") { item.alt = name; item.decoding = "async"; item.loading = "lazy"; }
      else { item.controls = true; item.preload = "metadata"; item.setAttribute("aria-label", name); }
      if (pdf) item.setAttribute("data-pdf-page", "1");
      item.addEventListener("error", function () { item.remove(); }, { once: true });
      item.src = url; card.prepend(item);
    }
    function paint(selected, voice) {
      clear();
      var current = generation, pending = new Map();
      if (typeof root.IntersectionObserver === "function") {
        observer = new root.IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting || !pending.has(entry.target) || current !== generation) return;
            observer.unobserve(entry.target);
            var show = pending.get(entry.target); pending.delete(entry.target); show();
          });
        }, { root: grid });
      }
      selected.forEach(function (file) {
        var card = el("div", undefined, grid); card.className = "schedule-preview-card";
        var name = voice ? L("Nota de voz", "Voice note") : file.name;
        var filename = el("div", name, card); filename.className = "schedule-preview-name"; filename.title = name;
        if (!(typeof root.File === "function" && file instanceof root.File)) return;
        var mime = attachmentMime(file), type = voice ? "audio" : mode(file);
        if (type === "image" || type === "video" || type === "audio") {
          // OS drag/drop sometimes omits MIME. Keep the bytes and set the format
          // explicitly so a local preview and WhatsApp use the same media type.
          media(type === "image" ? "img" : type, file.type === mime ? file : file.slice(0, file.size, mime), card, name, false);
        } else if (mime === "application/pdf" && typeof root.__wrSchedulePdfPreview === "function") {
          var show = function () {
            pdfPreviewQueue = pdfPreviewQueue.then(function () {
              if (current === generation && card.isConnected) return root.__wrSchedulePdfPreview(file);
            }).then(function (blob) {
              if (blob && current === generation && card.isConnected) media("img", blob, card, L("Primeira página de ", "First page of ") + name, true);
            }).catch(function () {});
          };
          if (observer) { pending.set(card, show); observer.observe(card); } else show();
        }
      });
    }
    return { paint: paint, clear: clear };
  }
  function openEditor(existing, source) {
    var chat = existing ? { id: existing.chat_id, name: existing.chat_name } : source && source.chat || activeChat();
    if (!chat) return showScheduledPage(false, false);
    var savedFiles = existing && existing.attachments || [];
    var text = existing ? (savedFiles.length ? savedFiles[0].caption || "" : existing.text) : source ? source.text : "";
    var files = source && source.files || [], captions = source && source.captions || [], voiceFile = null;
    var retained = savedFiles.map(function (a) { return a.id; });
    var dialog = createPanel(existing ? L("Editar agendamento", "Edit schedule") : L("Agendar mensagem", "Schedule message"));
    dialog.className = "schedule-editor";
    el("p", chat.name, dialog).className = "schedule-recipient";
    var form = el("form", undefined, dialog);
    form.noValidate = true;
    var label = el("label", undefined, form), messageLabel = el("span", "", label);
    var area = el("textarea", undefined, label); area.value = text;
    var zone = existing ? existing.time_zone : Intl.DateTimeFormat().resolvedOptions().timeZone;
    var when = field(form, L("Enviar em", "Send on"), "datetime-local", existing ? existing.local_at : localDate(new Date(Date.now() + 3600000))); when.required = true;
    var timeZone = el("span", zone, when.parentNode);
    timeZone.id = "schedule-time-zone"; timeZone.className = "schedule-zone";
    when.setAttribute("aria-describedby", timeZone.id);
    var repeat = existing && existing.repeat;
    var quick = el("div", undefined, form); quick.className = "schedule-quick";
    var unit = select(quick, L("Repetir", "Repeat"), [["", L("Não repetir", "Does not repeat")], ["day", L("Diariamente", "Daily")], ["week", L("Semanalmente", "Weekly")], ["month", L("Mensalmente", "Monthly")], ["year", L("Anualmente", "Yearly")]], repeat ? repeat.unit : "");
    var repeatOptions = el("div", undefined, form); repeatOptions.className = "schedule-repeat-options";
    var intervalLabel = el("label", undefined, repeatOptions), intervalTitle = el("span", "", intervalLabel);
    var interval = el("input", undefined, intervalLabel); interval.type = "number"; interval.value = repeat ? String(repeat.interval) : "1"; interval.min = "1"; interval.max = "1000"; interval.step = "1";
    var ending = select(repeatOptions, L("Termina", "Ends"), [["", L("Nunca", "Never")], ["date", L("Em uma data", "On a date")], ["count", L("Após alguns envios", "After a number of sends")]], repeat && repeat.end_date ? "date" : repeat && repeat.max_sends ? "count" : "");
    var until = field(form, L("Data do último envio", "Last send date"), "date", repeat && repeat.end_date);
    var count = field(form, L("Número de envios bem-sucedidos", "Number of successful sends"), "number", repeat && repeat.max_sends ? String(repeat.max_sends) : "1"); count.min = "1"; count.max = "4294967295"; count.step = "1";
    var intervalLabels = { day: L("Intervalo em dias", "Every (days)"), week: L("Intervalo em semanas", "Every (weeks)"), month: L("Intervalo em meses", "Every (months)"), year: L("Intervalo em anos", "Every (years)") };
    function recurrenceVisibility() { repeatOptions.hidden = !unit.value; intervalTitle.textContent = intervalLabels[unit.value] || ""; until.parentNode.hidden = !unit.value || ending.value !== "date"; count.parentNode.hidden = !unit.value || ending.value !== "count"; }
    unit.onchange = ending.onchange = recurrenceVisibility; recurrenceVisibility();
    var tools = el("div", undefined, quick); tools.className = "schedule-tools";
    var picker = el("input", undefined, form); picker.type = "file"; picker.multiple = true; picker.hidden = true;
    var attach = button("", function () { picker.click(); }, tools); attach.className = "schedule-media-button";
    plusIcon(attach);
    var attachments = el("div", undefined, form); attachments.className = "schedule-attachments";
    var heading = el("div", undefined, attachments); heading.className = "schedule-attachment-heading";
    var fileList = el("span", "", heading); fileList.className = "schedule-files"; fileList.setAttribute("aria-live", "polite");
    var remove = button(L("Remover", "Remove"), function () {
      voiceFile = null; files = []; captions = []; retained = []; picker.value = "";
      status.textContent = source && source.previewFallback ? previewHelp : "";
      paintFiles(); attach.focus();
    }, heading); remove.className = "schedule-link";
    remove.setAttribute("aria-label", L("Remover todos os anexos", "Remove all attachments"));
    var grid = el("div", undefined, attachments); grid.className = "schedule-previews";
    var previews = attachmentPreviews(grid);
    var status = el("p", "", form); status.className = "status"; status.setAttribute("role", "status");
    var previewHelp = L("Selecione os arquivos originais no seletor. A prévia do WhatsApp ficará aberta.", "Select the original files in the picker. The WhatsApp preview will stay open.");
    if (source && source.previewFallback) status.textContent = previewHelp;
    var actions = el("div", undefined, form); actions.className = "schedule-actions";
    button(L("Cancelar", "Cancel"), function () { dialog.close(); }, actions);
    var save = el("button", existing ? L("Salvar", "Save") : L("Agendar", "Schedule"), actions); save.type = "submit"; save.className = "primary";
    var busy = false, recorder;
    function hasVoice() { return !!voiceFile || (retained.length > 0 && savedFiles[0].mode === "voice"); }
    function updateControls() {
      var recording = recorder && recorder.busy();
      attach.disabled = busy || !!recording || hasVoice();
      save.disabled = busy || !!recording;
      if (recorder) recorder.setDisabled(busy || hasVoice() || !!files.length || !!retained.length || !!(source && source.previewFallback));
    }
    function paintFiles() {
      var selected = voiceFile ? [voiceFile] : files.length ? files : retained.length ? savedFiles : [];
      var voice = hasVoice();
      fileList.textContent = voice ? L("Nota de voz", "Voice note") : selected.length + L(" arquivo(s)", " file(s)");
      attachments.hidden = !selected.length;
      attach.title = selected.length ? L("Trocar arquivos", "Change files") : L("Anexar arquivos", "Attach files");
      attach.setAttribute("aria-label", attach.title);
      label.hidden = voice;
      messageLabel.textContent = selected.length ? L("Legenda do primeiro arquivo", "Caption for first file") : L("Mensagem", "Message");
      area.placeholder = selected.length ? L("Legenda opcional", "Optional caption") : L("Escreva uma mensagem", "Write a message");
      previews.paint(selected, voice);
      updateControls();
    }
    if (typeof root.__wrCreateScheduleRecorder === "function") {
      recorder = root.__wrCreateScheduleRecorder({
        onChange: function (file) {
          if (file && !root.__whatrustLocked && dialog.isConnected) {
            voiceFile = file;
            status.textContent = area.value.trim() ? L("A nota de voz será enviada separadamente do texto.", "The voice note will be sent on its own.") : "";
            paintFiles();
          }
          else updateControls();
        },
        onError: function (message) { status.textContent = message; }
      });
      recorder.button.classList.add("schedule-media-button"); tools.appendChild(recorder.button);
    }
    panelCleanup = function () { if (recorder) recorder.dispose(); previews.clear(); };
    picker.onchange = function () {
      if (!picker.files.length || hasVoice() || busy || (recorder && recorder.busy())) return;
      var selected = Array.from(picker.files);
      if (!originalFiles(selected)) { status.textContent = L("Selecione até 200 arquivos. Limite de 100 MiB por arquivo e 500 MiB no total.", "Choose up to 200 files, with a limit of 100 MiB per file and 500 MiB total."); picker.value = ""; return; }
      files = selected; captions = []; retained = []; status.textContent = ""; paintFiles();
    };
    paintFiles();
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (busy || (recorder && recorder.busy())) return;
      if (root.__whatrustLocked) { status.textContent = L("Desbloqueie a conta para continuar.", "Unlock the account to continue."); return; }
      if (source && source.previewFallback && !files.length) { status.textContent = previewHelp; return; }
      var voice = hasVoice(), sendFiles = voiceFile ? [voiceFile] : files;
      var n = Number(interval.value), max = Number(count.value);
      if (!validTime(when.value, zone) || unit.value && (!Number.isInteger(n) || n < 1 || n > 1000 || ending.value === "date" && (!until.value || until.value < when.value.slice(0, 10)) || ending.value === "count" && (!Number.isSafeInteger(max) || max < 1 || max > Number(count.max))) || !area.value.trim() && !sendFiles.length && !retained.length) {
        status.textContent = L("Confira a mensagem, data e repetição.", "Check the message, date and recurrence."); return;
      }
      busy = true; var stage = null;
      // Freeze the form and payload during staging so a second selection cannot change bytes.
      var controls = Array.from(dialog.querySelectorAll("input,select,textarea,button")); controls.forEach(function (c) { c.disabled = true; });
      try {
        var body = { id: existing ? existing.id : null, revision: existing ? existing.revision : null, chat_id: chat.id, chat_name: chat.name, text: sendFiles.length || retained.length ? "" : area.value, first_caption: retained.length && !voice ? area.value : null, local_at: when.value, time_zone: zone, repeat: unit.value ? { unit: unit.value, interval: n, end_date: ending.value === "date" ? until.value : null, max_sends: ending.value === "count" ? max : null } : null, stage_id: null, keep_attachment_ids: retained };
        if (sendFiles.length) { var cc = sendFiles.map(function (_, i) { return i === 0 ? area.value : captions[i] || ""; }); stage = await stageFiles(sendFiles.slice(), cc, voice); body.stage_id = stage; }
        if (root.__whatrustLocked) throw new Error(L("Conta bloqueada.", "Account locked."));
        await invoke("schedule_save", { input: body }); stage = null;
        // Close the source preview only when it still matches the saved capture.
        if (source && !source.fromPreview && !voice) await clearSavedDraft(source).catch(function () {});
        if (source && source.previewContainer) {
          var still = verifiedPreview(preview());
          if (still && still.previewContainer === source.previewContainer && still.files[0] === source.files[0] && still.text === source.text) {
            var cancelPreview = source.previewContainer.querySelector("[data-icon='media-cancel']");
            cancelPreview = cancelPreview && cancelPreview.closest("button,[role='button']");
            if (cancelPreview) cancelPreview.click();
          }
        }
        if (dialog.isConnected) dialog.close();
        if (listView) { scheduleMount(); listView.reload(); }
        else root.__wrScheduleChanged();
      } catch (error) { if (stage) await invoke("schedule_stage_discard", { stage_id: stage }).catch(function () {}); status.textContent = errorText(error); }
      finally { busy = false; controls.forEach(function (c) { c.disabled = false; }); updateControls(); }
    });
    dialog.addEventListener("cancel", function (event) { if (busy) event.preventDefault(); });
    if (text || files.length || retained.length) when.focus(); else area.focus();
  }
  function openList(container, options, closePage, initialTab) {
    var chatOnly = options.chatOnly, current = options.chat;
    var filter = chatOnly ? current.id : "";
    var title = L("Mensagens agendadas", "Scheduled messages");
    var page = createListPage(container, title);
    var header = el("header", undefined, page); header.className = "schedule-page-header";
    var heading = el("div", undefined, header);
    el("h2", title, heading);
    el("p", chatOnly ? current.name : L("Todas as conversas desta conta", "All chats in this account"), heading);
    var headerActions = el("div", undefined, header); headerActions.className = "schedule-card-actions";
    if (chatOnly) {
      var add = button("+", function () {
        var draft = captureComposer();
        openEditor(null, draft && draft.chat.id === filter ? draft : { chat: current, text: "" });
      }, headerActions);
      add.title = L("Agendar mensagem", "Schedule a message"); add.setAttribute("aria-label", add.title);
    }
    var close = button("×", closePage, headerActions); close.className = "schedule-close";
    close.title = L("Fechar", "Close"); close.setAttribute("aria-label", close.title);
    if (nudge) nudge.remove();
    var tablist = el("div", undefined, page); tablist.className = "schedule-tabs";
    tablist.setAttribute("role", "tablist"); tablist.setAttribute("aria-label", title);
    var content = el("div", undefined, page); content.className = "schedule-list-scroll";
    var status = el("p", L("Carregando…", "Loading…"), content); status.className = "schedule-list-status"; status.setAttribute("role", "status");
    var tabs = {}, panes = {}, counts = {}, selected = initialTab || (options.missedOnly ? "attention" : "");
    function showTab(key) {
      selected = key;
      ["upcoming", "attention"].forEach(function (name) {
        var active = name === key;
        tabs[name].setAttribute("aria-selected", String(active)); tabs[name].tabIndex = active ? 0 : -1;
        panes[name].hidden = !active;
      });
      content.scrollTop = 0;
    }
    [["upcoming", L("Próximas", "Upcoming")], ["attention", L("Requer atenção", "Needs attention")]].forEach(function (entry) {
      var key = entry[0], label = entry[1];
      var tab = tabs[key] = button(label, function () { showTab(key); }, tablist);
      tab.id = "schedule-tab-" + key; tab.setAttribute("role", "tab"); tab.setAttribute("data-schedule-tab", key);
      tab.setAttribute("aria-controls", "schedule-pane-" + key);
      counts[key] = el("span", "0", tab); counts[key].className = "schedule-count";
      tab.addEventListener("keydown", function (event) {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        var next = event.key === "Home" ? "upcoming" : event.key === "End" ? "attention" : key === "upcoming" ? "attention" : "upcoming";
        showTab(next); tabs[next].focus();
      });
      var pane = panes[key] = el("section", undefined, content); pane.className = "schedule-list-pane";
      pane.id = "schedule-pane-" + key; pane.setAttribute("role", "tabpanel"); pane.setAttribute("data-schedule-pane", key);
      pane.tabIndex = 0; pane.setAttribute("aria-labelledby", tab.id); pane.hidden = true;
      tab.tabIndex = -1; tab.setAttribute("aria-selected", "false");
    });
    var availability = el("p", "", panes.attention); availability.className = "schedule-list-alert"; availability.setAttribute("role", "status");
    var entries = [];
    var view = {
      container: container,
      close: closePage,
      reload: function () { if (isCurrent()) openList(container, options, closePage, selected); },
      update: updateAvailability
    };
    function isCurrent() { return listView === view && page.isConnected; }
    function updateAvailability() {
      if (!isCurrent()) return;
      entries.forEach(function (entry) { entry.buttons.forEach(function (item) {
        item.button.disabled = !reviewActionAvailable(snapshot, entry.id, item.action, entry.busy || pendingReview[entry.id], root.__whatrustLocked);
      });
        var live = (snapshot.review || []).find(function (item) { return item.occurrence_id === entry.id; });
        entry.notice.textContent = !live || live.state !== entry.state ? L("Este envio pendente mudou. Reabra a lista para revisar o resultado e as ações disponíveis.", "This pending send changed. Reopen the list to review its result and available actions.") : "";
      });
      var needsConnection = entries.some(function (entry) { return entry.state !== "uncertain"; });
      availability.textContent = needsConnection && !snapshot.can_send ? L("Envio indisponível. Mantenha esta conta do WhatsApp aberta e conectada.", "Sending unavailable. Keep this WhatsApp account open and connected.") : "";
    }
    listView = view;
    // Opening the review also samples the active connection in case WhatsApp
    // became ready without a fresh event from its webview.
    if (typeof root.__wrScheduleDeliveryRefresh === "function") root.__wrScheduleDeliveryRefresh().catch(function () {});
    refresh().then(function () {
      if (!isCurrent()) return;
      status.textContent = "";
      var reviews = latestReview(snapshot.review).filter(function (r) { return !filter || r.chat_id === filter; }).sort(function (a, b) { return b.due_ms - a.due_ms; });
      var schedules = (snapshot.schedules || []).filter(function (s) { return s.next_due_ms != null && (!filter || s.chat_id === filter); }).sort(function (a, b) { return a.next_due_ms - b.next_due_ms; });
      counts.attention.textContent = String(reviews.length); counts.upcoming.textContent = String(schedules.length);
      var locale = root.__WR_LANG === "en" ? "en" : "pt-BR";
      function dateTime(ms, zone, parent) {
        var date = new Date(ms), time = el("time", new Intl.DateTimeFormat(locale, { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(date), parent);
        time.setAttribute("datetime", date.toISOString()); time.className = "schedule-due";
      }
      function previewText(row, target) {
        var hasVoice = (row.attachments || []).some(function (file) { return file.mode === "voice"; });
        var snippet = hasVoice ? L("Nota de voz", "Voice note") : messagePreview(row);
        if (snippet) { var preview = el("p", snippet, target); preview.className = "schedule-snippet"; preview.title = snippet; }
      }
      if (!reviews.length) el("p", L("Nenhum envio precisa de atenção.", "No sends need attention."), panes.attention).className = "schedule-empty";
      if (!schedules.length) el("p", L("Nenhum envio agendado.", "No upcoming sends."), panes.upcoming).className = "schedule-empty";
      reviews.forEach(function (r) {
        var entry = { id: r.occurrence_id, state: r.state, busy: false, buttons: [] }; entries.push(entry);
        var row = el("article", undefined, panes.attention); row.className = "schedule-card schedule-review-card"; row.setAttribute("data-state", r.state);
        var top = el("div", undefined, row); top.className = "schedule-card-top";
        el("strong", r.chat_name || r.chat_id, top).title = r.chat_name || r.chat_id;
        el("span", r.state === "uncertain" ? L("Verificar envio", "Check delivery") : r.state === "failed" ? L("Incompleto", "Incomplete") : L("Perdido", "Missed"), top).className = "schedule-pill";
        previewText(r, row);
        if (r.state === "uncertain") el("p", L("Verifique a conversa antes de agendar outro envio.", "Check the chat before scheduling another send."), row).className = "schedule-meta";
        if (r.state === "failed") el("p", L("Só as partes pendentes serão reenviadas.", "Retry sends only the remaining parts."), row).className = "schedule-meta";
        entry.notice = el("p", "", row); entry.notice.className = "schedule-meta"; entry.notice.setAttribute("role", "status");
        var footer = el("div", undefined, row); footer.className = "schedule-card-footer";
        dateTime(r.due_ms, undefined, footer);
        var actions = el("div", undefined, footer); actions.className = "schedule-card-actions";
        reviewActions(r).forEach(function (action) { var b = button(action === "skip" ? L("Pular", "Skip") : action === "retry" ? L("Tentar novamente", "Retry") : L("Enviar agora", "Send now"), async function () {
          if (!isCurrent() || !reviewActionAvailable(snapshot, entry.id, action, entry.busy || pendingReview[entry.id], root.__whatrustLocked)) return;
          entry.busy = true; pendingReview[entry.id] = true; view.update();
          try { await invoke("schedule_decide", { occurrence_id: r.occurrence_id, action: action }); view.reload(); }
          catch (error) { if (isCurrent()) status.textContent = errorText(error); }
          finally { entry.busy = false; delete pendingReview[entry.id]; if (listView) listView.update(); }
        }, actions); if (action !== "skip") b.className = "schedule-send-action"; entry.buttons.push({ action: action, button: b }); });
      });
      schedules.forEach(function (s) {
        var row = el("article", undefined, panes.upcoming); row.className = "schedule-card";
        dateTime(s.next_due_ms, s.time_zone, row);
        var top = el("div", undefined, row); top.className = "schedule-card-top";
        el("strong", s.chat_name || s.chat_id, top).title = s.chat_name || s.chat_id;
        previewText(s, row);
        var units = { day: L("dias", "days"), week: L("semanas", "weeks"), month: L("meses", "months"), year: L("anos", "years") };
        var regular = { day: L("Diariamente", "Daily"), week: L("Semanalmente", "Weekly"), month: L("Mensalmente", "Monthly"), year: L("Anualmente", "Yearly") };
        var repeat = s.repeat && (s.repeat.interval === 1 ? regular[s.repeat.unit] : L("A cada ", "Every ") + s.repeat.interval + " " + units[s.repeat.unit]);
        var footer = el("div", undefined, row); footer.className = "schedule-card-footer";
        var metadata = el("div", undefined, footer);
        el("p", [repeat, s.time_zone].filter(Boolean).join(" · "), metadata).className = "schedule-meta";
        if (s.repeat && (s.repeat.end_date || s.repeat.max_sends)) el("p", s.repeat.end_date ? L("Até ", "Through ") + s.repeat.end_date : (s.successful_sends || 0) + "/" + s.repeat.max_sends + L(" envios", " sends"), metadata).className = "schedule-meta";
        var actions = el("div", undefined, footer); actions.className = "schedule-card-actions";
        button(L("Editar", "Edit"), function () { openEditor(s); }, actions);
        var more = el("details", undefined, actions); more.className = "schedule-more";
        var moreLabel = el("summary", "⋯", more); moreLabel.title = L("Mais opções", "More options"); moreLabel.setAttribute("aria-label", moreLabel.title);
        var cancelling = false;
        button(L("Cancelar agendamento", "Cancel schedule"), async function (event) {
          if (cancelling || !isCurrent() || root.__whatrustLocked) return;
          cancelling = true; event.target.disabled = true;
          try { await invoke("schedule_cancel", { id: s.id, revision: s.revision }); view.reload(); }
          catch (error) { if (isCurrent()) { status.textContent = errorText(error); event.target.disabled = false; } }
          finally { cancelling = false; }
        }, more);
      });
      showTab(selected || (reviews.length ? "attention" : "upcoming"));
      view.update();
    }).catch(function (error) { if (isCurrent()) status.textContent = errorText(error); });
  }
  function showScheduledPage(chatOnly, missedOnly, context) {
    if (root.__whatrustLocked || typeof root.__wrShowScheduledPage !== "function") return;
    var chat = chatOnly ? scheduleChat(context) : null;
    if (!chatOnly || chat) root.__wrShowScheduledPage({ chatOnly: chatOnly, chat: chat, missedOnly: missedOnly });
  }
  function captureComposer() {
    var context = composerContext(doc), chat = activeChat();
    return chat && context ? { input: context.input, chat: chat, text: draftText(context.input), files: [], captions: [] } : null;
  }
  // Never fetch blob URLs: only identities observed at local createObjectURL.
  // The normal path is deliberately singular and rejects every edit interaction.
  function verifiedPreview(container) {
    if (!captured || !container || !container.isConnected || Date.now() - captured.at > 300000 || !activeChat() || activeChat().id !== captured.chat.id || !originalFiles(captured.files)) return null;
    return verifyNativePreview(captured, container, originalURLs);
  }
  function captureFiles(event) {
    if (event.target && event.target.closest && event.target.closest("#__whatrust_schedule")) return;
    var files = event.type === "drop" ? event.dataTransfer && event.dataTransfer.files : event.target && event.target.type === "file" ? event.target.files : null;
    var chat = activeChat();
    if (files && files.length && chat) captured = { files: Array.from(files), chat: chat, at: Date.now() };
  }
  function clockButton(text, fn) {
    var b = button("", fn); b.setAttribute("aria-label", text); b.title = text; b.setAttribute("data-wr-schedule", "1");
    b.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:0 0 36px;width:36px;height:36px;padding:6px;margin:0 4px;border:0;border-radius:50%;cursor:pointer;background:transparent;color:var(--icon,#8696a0)";
    var svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "24"); svg.setAttribute("height", "24"); svg.setAttribute("aria-hidden", "true");
    var path = doc.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"); path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.8"); svg.appendChild(path); b.appendChild(svg); return b;
  }
  function mount() {
    if (root.__whatrustLocked) { if (controls) controls.remove(); if (previewButton) previewButton.remove(); if (nudge) nudge.remove(); return; }
    var context = composerContext(doc), chat = activeChat(), nativePreview = preview();
    if (context && !nativePreview) {
      if (!controls) {
        controls = el("span");
        controls.setAttribute("data-wr-schedule", "1");
        controls.style.cssText = "display:inline-flex;align-items:center;flex:none;white-space:nowrap";
        controls.appendChild(clockButton(L("Agendar mensagem", "Schedule message"), function () {
          var source = captureComposer();
          if (source) openEditor(null, source);
          else {
            var dialog = createPanel(L("Agendar mensagem", "Schedule message"));
            el("p", L("Aguarde o WhatsApp carregar esta conversa e tente novamente.", "Wait for WhatsApp to load this chat, then try again."), dialog);
            button(L("Fechar", "Close"), function () { dialog.close(); }, dialog);
          }
        }));
      }
      var slot = context.action && actionSlot(context.action, context.scope, controls);
      if (slot && (controls.parentNode !== slot.parentNode || controls.nextSibling !== slot)) slot.parentNode.insertBefore(controls, slot);
      else if (!slot && controls.parentNode !== context.scope) context.scope.appendChild(controls);
    } else if (controls) controls.remove();
    if (chat && nativePreview) {
      if (!previewButton) previewButton = clockButton(L("Agendar arquivos", "Schedule files"), function () { var source = verifiedPreview(preview()); openEditor(null, source || { chat: activeChat(), text: "", files: [], captions: [], fromPreview: true, previewFallback: true }); });
      var send = nativeAction(nativePreview, SEND);
      if (send) {
        previewButton.style.position = "static";
        if (previewButton.parentNode !== send.parentNode || previewButton.nextSibling !== send) send.parentNode.insertBefore(previewButton, send);
      } else {
        previewButton.style.position = "fixed"; previewButton.style.right = "24px"; previewButton.style.bottom = "88px"; previewButton.style.zIndex = "10000"; previewButton.style.background = "var(--panel-background,#202c33)";
        if (previewButton.parentNode !== doc.body) doc.body.appendChild(previewButton);
      }
    } else if (previewButton) previewButton.remove();
  }
  async function refresh() {
    if (root.__whatrustLocked) {
      refreshApplied = ++refreshIssued;
      if (listView) listView.close();
      closePanel(); snapshot = { schedules: [], review: [] }; captured = null;
      if (nudge) nudge.remove(); mount();
      if (typeof root.__wrScheduleAccountCountsChanged === "function") root.__wrScheduleAccountCountsChanged([]);
      return snapshot;
    }
    var request = ++refreshIssued;
    var next = await invoke("schedule_snapshot");
    if (root.__whatrustLocked) return refresh();
    if (next && request > refreshApplied) {
      refreshApplied = request;
      snapshot = next;
      if (listView) listView.update();
      if (typeof root.__whatrustScheduleSnapshot === "function") root.__whatrustScheduleSnapshot(next);
      if (typeof root.__wrScheduleAccountCountsChanged === "function") root.__wrScheduleAccountCountsChanged(next.pending_accounts || []);
      showReviewNudge();
    }
    return snapshot;
  }
  function showReviewNudge() {
    var rows = latestReview(snapshot.review), others = otherAccountPending(snapshot);
    var key = rows.length ? "own:" + rows.map(function (r) { return r.occurrence_id; }).sort().join("|") : "accounts:" + others.map(function (item) { return item.account_id + ":" + item.count; }).sort().join("|");
    if (nudge) nudge.remove();
    if (listView || (!rows.length && !others.length) || key === dismissedReview || doc.hidden || !doc.hasFocus()) return;
    nudge = el("div"); nudge.id = "__whatrust_schedule_nudge";
    nudge.setAttribute("role", "region");
    nudge.setAttribute("aria-label", L("Envios agendados pendentes", "Pending scheduled sends"));
    nudge.style.cssText = "position:fixed;top:76px;right:24px;z-index:10000;border-radius:10px;padding:10px;background:var(--panel-background,#202c33);color:var(--primary,#e9edef);box-shadow:0 2px 10px #0005;font:14px system-ui";
    var count = rows.length || others.reduce(function (sum, item) { return sum + item.count; }, 0);
    button(L("Revisar envios pendentes", "Review pending sends") + " (" + count + ")", function () {
      dismissedReview = key; nudge.remove();
      if (rows.length) showScheduledPage(false, true);
      else if (typeof root.__wrScheduleOpenAccountPicker === "function") root.__wrScheduleOpenAccountPicker();
    }, nudge);
    var dismiss = button("×", function () { dismissedReview = key; nudge.remove(); }, nudge); dismiss.setAttribute("aria-label", L("Dispensar aviso e manter envios pendentes", "Dismiss notice and keep sends pending"));
    doc.body.appendChild(nudge);
  }
  root.__wrMountScheduledPage = function (container, options, close) {
    if (root.__whatrustLocked) return;
    openList(container, options, close);
    return function () {
      if (listView && listView.container === container) listView = null;
      container.replaceChildren();
    };
  };
  root.__whatrustScheduleOpen = function (chatOnly, chat) { showScheduledPage(!!chatOnly, false, chat); };
  root.__whatrustScheduleMissed = function () { showScheduledPage(false, true); };
  root.dispatchEvent(new Event("whatrust-schedule-ready"));
  function scheduleMount() {
    if (refreshPending) return;
    refreshPending = true;
    setTimeout(function () { refreshPending = false; mount(); }, 100);
  }
  root.__wrScheduleChanged = function () { scheduleMount(); refresh().catch(function () {}); };
  doc.addEventListener("change", captureFiles, true); doc.addEventListener("drop", captureFiles, true);
  doc.addEventListener("click", function (event) {
    var container = preview(), target = event.target;
    if (!captured || !container || !target || !container.contains(target)) return;
    var control = target.closest && target.closest("button,[role='button']");
    if (!control) return;
    if (control.hasAttribute("data-wr-schedule")) return;
    // Any preview control can change crop, order, view-once or file identity.
    // Once used, require the dialog's original-file picker for this preview.
    captured.edited = true;
  }, true);
  doc.addEventListener("visibilitychange", function () { if (!doc.hidden) root.__wrScheduleChanged(); });
  root.addEventListener("focus", root.__wrScheduleChanged);
  root.addEventListener("pagehide", function () { if (listView) listView.close(); closePanel(); });
  var oldRelang = root.__wrRelang;
  root.__wrRelang = function () {
    if (oldRelang) oldRelang();
    if (controls) { controls.remove(); controls = null; }
    if (previewButton) { previewButton.remove(); previewButton = null; }
    if (listView) listView.reload();
    mount();
  };
  function ready() {
    if (!doc.body) return;
    new MutationObserver(scheduleMount).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden", "contenteditable", "data-icon", "hidden"] });
    mount(); root.__wrScheduleChanged();
  }
  if (doc.body) ready(); else doc.addEventListener("DOMContentLoaded", ready, { once: true });
})();

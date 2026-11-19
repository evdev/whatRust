/* Scheduled messages. File bytes only come from locally selected original Files. */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  if (!root.__WHATRUST_TEST && (!root.location || root.location.origin !== "https://web.whatsapp.com")) return;
  function L(pt, en) { return root.__WR_LANG === "en" ? en : pt; }
  function chatId(value) {
    var raw = typeof value === "string" ? value : value && value._serialized || "";
    return /^(?:\d+(?::\d+)?@(c\.us|lid|s\.whatsapp\.net)|\d+(?:-\d+)*@g\.us)$/.test(raw) ? raw.replace(/:\d+@/, "@") : "";
  }
  function activeChat() {
    try {
      var chat = root.WPP.chat.getActiveChat();
      var id = chat && !chat.then && chatId(chat.id);
      return id ? { id: id, name: String(chat.formattedTitle || chat.name || id) } : null;
    } catch (_) { return null; }
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
  function mode(file) { return /^image\//.test(file.type) ? "image" : /^video\//.test(file.type) ? "video" : "document"; }
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
  async function stageFiles(files, captions) {
    if (!originalFiles(files)) throw new Error(L("Selecione arquivos originais não vazios: até 200 arquivos, 100 MiB por arquivo e 500 MiB no total.", "Select nonempty original files: up to 200 files, 100 MiB per file and 500 MiB total."));
    var stage = await invoke("schedule_stage_begin", { files: files.map(function (f, i) { return { name: f.name, mime: f.type || "application/octet-stream", size: f.size, mode: mode(f), caption: captions[i] || "" }; }) });
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
    root.__whatrustScheduleUiApi = { chatId: chatId, draftText: draftText, latestReview: latestReview, reviewActions: reviewActions, messagePreview: messagePreview, validTime: validTime, originalFiles: originalFiles, clearSavedDraft: clearSavedDraft, stageFiles: stageFiles, captureObjectURLs: captureObjectURLs, verifyNativePreview: verifyNativePreview, otherAccountPending: otherAccountPending, errorText: errorText };
    return;
  }
  var doc = root.document, snapshot = { schedules: [], review: [] }, panel, shadow, clock, shortcut, previewButton, nudge, captured = null, refreshPending = false, dismissedReview = "";
  var SEND_ICON = "[data-icon='send'],[data-icon='wds-ic-send'],[data-icon='wds-ic-send-filled']";
  var MIC_ICON = "[data-icon='ptt'],[data-icon='mic'],[data-icon='microphone'],[data-icon='wds-ic-mic'],[data-icon='wds-ic-mic-filled']";
  var originalURLs = captureObjectURLs(root.URL);
  function composer() { return doc.querySelector("#main footer [contenteditable='true'][role='textbox']") || doc.querySelector("#main footer [contenteditable='true'][data-tab]"); }
  function preview() { return doc.querySelector("[data-testid='media-editor']") || doc.querySelector("[data-testid='media-caption-input-container']"); }
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
    var dialog = el("dialog", undefined, shadow); dialog.setAttribute("aria-label", title); el("h2", title, dialog);
    dialog.addEventListener("close", function () {
      if (panel !== owner) return;
      closePanel();
      if (previous && previous.isConnected) previous.focus();
    });
    doc.body.appendChild(panel); dialog.showModal();
    return dialog;
  }
  function closePanel() { if (panel) panel.remove(); panel = null; shadow = null; }
  function field(parent, title, type, value) { var label = el("label", title, parent), input = el("input", undefined, label); input.type = type; input.value = value || ""; return input; }
  function select(parent, title, options, value) { var label = el("label", title, parent), input = el("select", undefined, label); options.forEach(function (o) { var opt = el("option", o[1], input); opt.value = o[0]; }); input.value = value; return input; }
  function openEditor(existing, source) {
    var chat = existing ? { id: existing.chat_id, name: existing.chat_name } : source && source.chat || activeChat();
    if (!chat) return openList(false);
    var savedFiles = existing && existing.attachments || [];
    var text = existing ? (savedFiles.length ? savedFiles[0].caption || "" : existing.text) : source ? source.text : "";
    var files = source && source.files || [], captions = source && source.captions || [];
    var retained = savedFiles.map(function (a) { return a.id; });
    var dialog = createPanel(existing ? L("Editar agendamento", "Edit schedule") : L("Agendar mensagem", "Schedule message"));
    el("p", chat.name, dialog);
    var label = el("label", L("Mensagem / primeira legenda", "Message / first caption"), dialog), area = el("textarea", undefined, label); area.value = text;
    var zone = existing ? existing.time_zone : Intl.DateTimeFormat().resolvedOptions().timeZone;
    el("p", L("Fuso original: ", "Original time zone: ") + zone, dialog);
    var when = field(dialog, L("Data e hora locais", "Local date and time"), "datetime-local", existing ? existing.local_at : localDate(new Date(Date.now() + 3600000))); when.required = true;
    var repeat = existing && existing.repeat;
    var unit = select(dialog, L("Repetir", "Repeat"), [["", L("Uma vez", "Once")], ["day", L("Dias", "Days")], ["week", L("Semanas", "Weeks")], ["month", L("Meses", "Months")], ["year", L("Anos", "Years")]], repeat ? repeat.unit : "");
    var interval = field(dialog, L("A cada N períodos", "Every N periods"), "number", repeat ? String(repeat.interval) : "1"); interval.min = "1"; interval.max = "1000"; interval.step = "1";
    var ending = select(dialog, L("Encerrar repetição", "End recurrence"), [["", L("Sem limite", "No limit")], ["date", L("Data final (inclusive)", "End date (inclusive)")], ["count", L("Máximo de envios bem-sucedidos", "Maximum successful sends")]], repeat && repeat.end_date ? "date" : repeat && repeat.max_sends ? "count" : "");
    var until = field(dialog, L("Data final (inclusive)", "End date (inclusive)"), "date", repeat && repeat.end_date);
    var count = field(dialog, L("Máximo de envios bem-sucedidos", "Maximum successful sends"), "number", repeat && repeat.max_sends ? String(repeat.max_sends) : "1"); count.min = "1"; count.step = "1";
    function recurrenceVisibility() { interval.parentNode.hidden = ending.parentNode.hidden = !unit.value; until.parentNode.hidden = !unit.value || ending.value !== "date"; count.parentNode.hidden = !unit.value || ending.value !== "count"; }
    unit.onchange = ending.onchange = recurrenceVisibility; recurrenceVisibility();
    var picker = field(dialog, L("Fotos, vídeos ou documentos", "Photos, videos or documents"), "file"); picker.multiple = true;
    var fileList = el("p", "", dialog);
    function paintFiles() { fileList.textContent = files.length ? files.map(function (f) { return f.name; }).join(" · ") : existing && retained.length ? (existing.attachments || []).map(function (a) { return a.name; }).join(" · ") : L("Nenhum arquivo selecionado", "No files selected"); }
    paintFiles();
    picker.onchange = function () { files = Array.from(picker.files || []); captions = []; retained = []; paintFiles(); };
    button(L("Remover arquivos", "Remove files"), function () { files = []; captions = []; retained = []; picker.value = ""; paintFiles(); }, dialog);
    var status = el("p", "", dialog); status.className = "status"; status.setAttribute("role", "status");
    var previewHelp = L("Selecione os arquivos originais no seletor. A prévia do WhatsApp ficará aberta.", "Select the original files in the picker. The WhatsApp preview will stay open.");
    if (source && source.previewFallback) status.textContent = previewHelp;
    var busy = false;
    var save = button(L("Salvar agendamento", "Save schedule"), async function () {
      if (busy) return;
      if (root.__whatrustLocked) { status.textContent = L("Desbloqueie a conta para continuar.", "Unlock the account to continue."); return; }
      if (source && source.previewFallback && !files.length) { status.textContent = previewHelp; return; }
      var n = Number(interval.value), max = Number(count.value);
      if (!validTime(when.value, zone) || unit.value && (!Number.isInteger(n) || n < 1 || n > 1000 || ending.value === "date" && (!until.value || until.value < when.value.slice(0, 10)) || ending.value === "count" && (!Number.isSafeInteger(max) || max < 1)) || !area.value.trim() && !files.length && !retained.length) {
        status.textContent = L("Confira a mensagem, data e repetição.", "Check the message, date and recurrence."); return;
      }
      busy = true; save.disabled = true; cancel.disabled = true; var stage = null;
      // Freeze the form and payload during staging so a second selection cannot change bytes.
      var controls = Array.from(dialog.querySelectorAll("input,select,textarea,button")); controls.forEach(function (c) { c.disabled = true; });
      try {
        var body = { id: existing ? existing.id : null, revision: existing ? existing.revision : null, chat_id: chat.id, chat_name: chat.name, text: files.length || retained.length ? "" : area.value, first_caption: retained.length ? area.value : null, local_at: when.value, time_zone: zone, repeat: unit.value ? { unit: unit.value, interval: n, end_date: ending.value === "date" ? until.value : null, max_sends: ending.value === "count" ? max : null } : null, stage_id: null, keep_attachment_ids: retained };
        if (files.length) { var cc = files.map(function (_, i) { return i === 0 ? area.value : captions[i] || ""; }); stage = await stageFiles(files.slice(), cc); body.stage_id = stage; }
        if (root.__whatrustLocked) throw new Error(L("Conta bloqueada.", "Account locked."));
        await invoke("schedule_save", { input: body }); stage = null;
        // Close the source preview only when it still matches the saved capture.
        if (source && !source.fromPreview) await clearSavedDraft(source).catch(function () {});
        if (source && source.previewContainer) {
          var still = verifiedPreview(preview());
          if (still && still.previewContainer === source.previewContainer && still.files[0] === source.files[0] && still.text === source.text) {
            var cancelPreview = source.previewContainer.querySelector("[data-icon='media-cancel']");
            cancelPreview = cancelPreview && cancelPreview.closest("button,[role='button']");
            if (cancelPreview) cancelPreview.click();
          }
        }
        if (dialog.isConnected) closePanel();
        root.__wrScheduleChanged();
      } catch (error) { if (stage) await invoke("schedule_stage_discard", { stage_id: stage }).catch(function () {}); status.textContent = errorText(error); }
      finally { busy = false; controls.forEach(function (c) { c.disabled = false; }); }
    }, dialog); save.className = "primary";
    var cancel = button(L("Voltar", "Back"), function () { dialog.close(); }, dialog);
    dialog.addEventListener("cancel", function (event) { if (busy) event.preventDefault(); });
    area.focus();
  }
  function openList(chatOnly, missedOnly) {
    var current = activeChat(), filter = chatOnly && current ? current.id : "";
    var dialog = createPanel(missedOnly ? L("Envios pendentes", "Pending sends") : L("Mensagens agendadas", "Scheduled messages"));
    var content = el("div", undefined, dialog), status = el("p", L("Carregando…", "Loading…"), dialog); status.setAttribute("role", "status");
    if (current && !missedOnly) button(L("Nova mensagem nesta conversa", "New message in this chat"), function () { openEditor(null, captureComposer()); }, dialog);
    button(L("Fechar", "Close"), function () { dialog.close(); }, dialog);
    refresh().then(function () {
      if (!dialog.isConnected) return;
      content.replaceChildren(); status.textContent = "";
      var reviews = latestReview(snapshot.review).filter(function (r) { return !filter || r.chat_id === filter; });
      reviews.forEach(function (r) {
        var row = el("article", undefined, content); el("strong", r.chat_name || r.chat_id, row);
        el("p", messagePreview(r), row).className = "status";
        el("p", new Date(r.due_ms).toLocaleString() + " · " + (r.state === "uncertain" ? L("Resultado ambíguo. Verifique a conversa antes de criar outro envio.", "Ambiguous result. Check the chat before creating another send.") : r.state === "failed" ? L("Envio incompleto. Tente enviar somente as partes pendentes.", "Delivery incomplete. Retry sends only the remaining parts.") : L("Horário perdido", "Missed time")), row);
        reviewActions(r).forEach(function (action) { var b = button(action === "skip" ? L("Pular", "Skip") : action === "retry" ? L("Tentar novamente", "Retry") : L("Enviar agora", "Send now"), async function () {
          Array.from(row.querySelectorAll("button")).forEach(function (x) { x.disabled = true; });
          try { await invoke("schedule_decide", { occurrence_id: r.occurrence_id, action: action }); openList(chatOnly, missedOnly); }
          catch (error) { status.textContent = errorText(error); Array.from(row.querySelectorAll("button")).forEach(function (x) { x.disabled = false; }); }
        }, row); if ((root.__whatrustLocked || !snapshot.can_send) && action !== "skip") b.disabled = true; });
      });
      if (!missedOnly) (snapshot.schedules || []).filter(function (s) { return !filter || s.chat_id === filter; }).forEach(function (s) {
        var row = el("article", undefined, content); el("strong", s.chat_name || s.chat_id, row); el("p", messagePreview(s), row).className = "status";
        var nextAt = s.next_due_ms ? new Intl.DateTimeFormat(root.__WR_LANG === "en" ? "en" : "pt-BR", { timeZone: s.time_zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(s.next_due_ms)) : L("Sem próximo envio", "No upcoming send");
        el("p", nextAt + " · " + s.time_zone, row);
        var units = { day: L("dias", "days"), week: L("semanas", "weeks"), month: L("meses", "months"), year: L("anos", "years") };
        el("p", (s.repeat ? L("A cada ", "Every ") + s.repeat.interval + " " + units[s.repeat.unit] + (s.repeat.end_date ? L(" até ", " through ") + s.repeat.end_date : "") + (s.repeat.max_sends ? L("; máximo de ", "; maximum ") + s.repeat.max_sends : "") : L("Uma vez", "Once")) + " · " + (s.successful_sends || 0) + L(" envios bem-sucedidos", " successful sends"), row);
        var edit = button(L("Editar", "Edit"), function () { openEditor(s); }, row); edit.disabled = !s.next_due_ms;
        button(L("Cancelar agendamento", "Cancel schedule"), async function (event) { event.target.disabled = true; try { await invoke("schedule_cancel", { id: s.id, revision: s.revision }); openList(chatOnly, missedOnly); } catch (error) { status.textContent = errorText(error); event.target.disabled = false; } }, row);
      });
      if (!content.children.length) status.textContent = L("Nenhuma mensagem pendente.", "No pending messages.");
    }).catch(function (error) { status.textContent = errorText(error); });
  }
  function captureComposer() { var input = composer(), chat = activeChat(); return chat ? { input: input, chat: chat, text: draftText(input), files: [], captions: [] } : null; }
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
    if (root.__whatrustLocked) { if (clock) clock.remove(); if (shortcut) shortcut.remove(); if (previewButton) previewButton.remove(); if (nudge) nudge.remove(); return; }
    if (root.__whatrustPageBusy && root.__whatrustPageBusy()) return;
    var input = composer(), chat = activeChat(), nativePreview = preview();
    var footer = input && input.closest("footer"), anchor = footer && (footer.querySelector(SEND_ICON) || footer.querySelector(MIC_ICON));
    anchor = anchor && anchor.closest("button,[role='button']");
    if (chat && anchor && !nativePreview) {
      if (!clock) clock = clockButton(L("Agendar mensagem", "Schedule message"), function () { var source = captureComposer(); if (source) openEditor(null, source); });
      if (clock.parentNode !== anchor.parentNode || clock.nextSibling !== anchor) anchor.parentNode.insertBefore(clock, anchor);
      if (!shortcut) shortcut = button(L("Agendadas", "Scheduled"), function () { openList(true); });
      shortcut.setAttribute("aria-label", L("Agendamentos desta conversa", "Schedules in this chat")); shortcut.setAttribute("data-wr-schedule", "1"); shortcut.style.cssText = "border:0;background:transparent;color:var(--icon,#8696a0);font:12px system-ui;cursor:pointer;padding:4px";
      if (shortcut.parentNode !== clock.parentNode) clock.parentNode.insertBefore(shortcut, clock);
    } else { if (clock) clock.remove(); if (shortcut) shortcut.remove(); }
    if (chat && nativePreview) {
      if (!previewButton) previewButton = clockButton(L("Agendar arquivos", "Schedule files"), function () { var source = verifiedPreview(preview()); openEditor(null, source || { chat: activeChat(), text: "", files: [], captions: [], fromPreview: true, previewFallback: true }); });
      var send = nativePreview.querySelector(SEND_ICON); send = send && send.closest("button,[role='button']");
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
      closePanel(); snapshot = { schedules: [], review: [] }; captured = null;
      if (nudge) nudge.remove(); mount();
      if (typeof root.__wrScheduleAccountCountsChanged === "function") root.__wrScheduleAccountCountsChanged([]);
      return snapshot;
    }
    var next = await invoke("schedule_snapshot");
    if (root.__whatrustLocked) return refresh();
    if (next) {
      snapshot = next;
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
    if ((!rows.length && !others.length) || key === dismissedReview || doc.hidden || !doc.hasFocus()) return;
    nudge = el("div"); nudge.id = "__whatrust_schedule_nudge";
    nudge.setAttribute("role", "region");
    nudge.setAttribute("aria-label", L("Envios agendados pendentes", "Pending scheduled sends"));
    nudge.style.cssText = "position:fixed;top:76px;right:24px;z-index:10000;border-radius:10px;padding:10px;background:var(--panel-background,#202c33);color:var(--primary,#e9edef);box-shadow:0 2px 10px #0005;font:14px system-ui";
    var count = rows.length || others.reduce(function (sum, item) { return sum + item.count; }, 0);
    button(L("Revisar envios pendentes", "Review pending sends") + " (" + count + ")", function () {
      dismissedReview = key; nudge.remove();
      if (rows.length) openList(false, true);
      else if (typeof root.__wrScheduleOpenAccountPicker === "function") root.__wrScheduleOpenAccountPicker();
    }, nudge);
    var dismiss = button("×", function () { dismissedReview = key; nudge.remove(); }, nudge); dismiss.setAttribute("aria-label", L("Dispensar aviso e manter envios pendentes", "Dismiss notice and keep sends pending"));
    doc.body.appendChild(nudge);
  }
  root.__whatrustScheduleOpen = function (chatOnly) { if (!root.__whatrustLocked) openList(!!chatOnly); };
  root.__whatrustScheduleMissed = function () { if (!root.__whatrustLocked) openList(false, true); };
  root.__wrScheduleChanged = function () { refresh().catch(function () {}); };
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
  var oldRelang = root.__wrRelang;
  root.__wrRelang = function () { if (oldRelang) oldRelang(); if (clock) { clock.remove(); clock = null; } if (shortcut) { shortcut.remove(); shortcut = null; } if (previewButton) { previewButton.remove(); previewButton = null; } mount(); };
  function ready() {
    if (!doc.body) return;
    new MutationObserver(function () { if (refreshPending) return; refreshPending = true; setTimeout(function () { refreshPending = false; mount(); }, 150); }).observe(doc.body, { childList: true, subtree: true });
    mount(); root.__wrScheduleChanged();
  }
  if (doc.body) ready(); else doc.addEventListener("DOMContentLoaded", ready, { once: true });
})();

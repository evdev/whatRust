(function () {
  "use strict";
  if (location.origin !== "https://web.whatsapp.com" || !window.__wrLoadCalendarChrono) return;

  function namedDate(months) {
    return new RegExp("(?:\\b\\d{1,2}(?:st|nd|rd|th|º)?(?:\\s+de)?\\s+(?:" + months + ")\\b|\\b(?:" + months + ")\\.?\\s+\\d{1,2}\\b)", "i");
  }
  var names = {
    en: namedDate("jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"),
    pt: namedDate("jan(?:eiro)?|fev(?:ereiro)?|mar(?:ço)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?")
  };
  var relative = {
    en: /^(?:(?:on|this|next)\s+)*(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    pt: /^(?:(?:na|no|próxim[oa]|nesta?|neste)\s+)*(?:hoje|amanhã|segunda(?:-feira)?|terça(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sábado|domingo)(?!\p{L})/iu
  };
  var clock = /(?:\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?![\d:])|\b(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*[ap]\.?m\.?(?!\p{L})|\b(?:noon|midnight|meio-dia|meia-noite)\b)/iu;
  var isoDate = /\b\d{4}-\d{2}-\d{2}(?=\b|T)/i;
  var explicitZone = /(?:\b(?:UTC|GMT)\s*)?([+-])([01]\d|2[0-3]):?([0-5]\d)$|\b(?:UTC|GMT)$|Z$/i;
  var incomplete = /^\s*(?:[–—-]\s*\d|(?:to|until|through|às|até|a)\s+\d|\/\d|[+-]\d|(?:UTC|GMT|[ECMP][DS]?T|CET|CEST|BST|IST|JST|BRT)\b|[A-Za-z_]+\/[A-Za-z_]+)/i;
  var sentinel = new Date(2000, 0, 1, 12);

  function wallTime(component) {
    var year = component.get("year"), month = component.get("month"), day = component.get("day");
    var hour = component.get("hour"), minute = component.get("minute"), second = component.get("second");
    if (year < 1000 || year > 9999 || hour === null) return null;
    var time = new Date(Date.UTC(year, month - 1, day, hour, minute || 0, second || 0));
    if (time.getUTCFullYear() !== year || time.getUTCMonth() !== month - 1 ||
        time.getUTCDate() !== day || time.getUTCHours() !== hour) return null;
    return time;
  }

  function matches(value, lang, sent, sourceInstant) {
    var found = [];
    var needsSent = false;
    // Discard ordinary conversation before initializing the parser.
    if (value.length > 4096 || !clock.test(value.replace(/(\d)T(?=\d)/i, "$1 "))) return { found: found, needsSent: needsSent };
    var parse = window.__wrLoadCalendarChrono()[lang];
    for (var result of parse(value, sent || sentinel, { forwardDate: true })) {
      var phrase = result.text;
      var zoneMatch = explicitZone.exec(phrase);
      var phraseClock = (zoneMatch ? phrase.slice(0, zoneMatch.index) : phrase).replace(/(\d)T(?=\d)/i, "$1 ");
      if (!result.start.isCertain("hour") || !clock.test(phraseClock)) continue;
      if (incomplete.test(value.slice(result.index + phrase.length))) continue;
      var hasDate = isoDate.test(phrase) || names[lang].test(phrase);
      var isRelative = relative[lang].test(phrase);
      if (!hasDate && !isRelative) continue;
      // Match a year in the date portion, never a compact time-zone offset.
      var explicitYear = hasDate && /\b\d{4}\b/.test(phraseClock);
      if (!sent && (!explicitYear || isRelative)) { needsSent = true; continue; }
      var zone = "local";
      if (result.start.isCertain("timezoneOffset") && !zoneMatch) continue;
      if (zoneMatch) {
        zone = zoneMatch[1] ? zoneMatch[1] + zoneMatch[2] + ":" + zoneMatch[3] : "+00:00";
        var offset = zoneMatch[1] ? (zoneMatch[1] === "-" ? -1 : 1) * (+zoneMatch[2] * 60 + +zoneMatch[3]) : 0;
        if (!result.start.isCertain("timezoneOffset") || result.start.get("timezoneOffset") !== offset) continue;
        if (sent && (!explicitYear || isRelative)) {
          var inZone = parse(phrase, { instant: sourceInstant || sent, timezone: offset }, { forwardDate: true });
          if (inZone.length !== 1 || inZone[0].text !== phrase) continue;
          result = inZone[0];
        }
        if (result.end && result.end.isCertain("timezoneOffset") && result.end.get("timezoneOffset") !== offset) continue;
      }
      if (result.end) {
        var clocks = phraseClock.match(new RegExp(clock.source, "giu")) || [];
        var sharedPeriod = /\b\d{1,2}(?::[0-5]\d)?\s*(?:to|[-–—])\s*(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*[ap]\.?m\.?/i;
        if (clocks.length < 2 && !sharedPeriod.test(phraseClock)) continue;
      }
      var start = wallTime(result.start);
      if (!start) continue;
      var end = result.end ? wallTime(result.end) : new Date(start.getTime() + 30 * 60000);
      if (!end || end <= start) continue;
      found.push({
        kind: "calendar", start: result.index, end: result.index + phrase.length, phrase: phrase,
        draft: { start: start.toISOString().slice(0, 19), end: end.toISOString().slice(0, 19), zone: zone }
      });
    }
    return { found: found, needsSent: needsSent };
  }

  async function sentDate(body) {
    var row = body.closest("[data-id]");
    var id = row && row.getAttribute("data-id");
    var chat = window.WPP && window.WPP.chat;
    if (!/^(?:true|false)_/.test(id || "") || !chat || typeof chat.getMessageById !== "function") return null;
    try {
      var message = await chat.getMessageById(id);
      if (row.getAttribute("data-id") !== id) return null;
      var timestamp = Number(message && (message.t || (message.attributes && message.attributes.t)));
      if (timestamp > 0 && timestamp < 1e12) timestamp *= 1000;
      if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 86400000) return null;
      return new Date(timestamp);
    } catch (_) { return null; }
  }

  function label(pt, en) { return window.__WR_LANG === "en" ? en : pt; }
  var preview = null;
  function dismiss() {
    if (!preview) return;
    var dialog = preview;
    preview = null;
    if (typeof dialog.close === "function") dialog.close();
    dialog.remove();
  }

  function review(match, available) {
    if (!available()) return;
    dismiss();
    var dialog = document.createElement("dialog");
    var native = typeof dialog.showModal === "function";
    var focused = document.activeElement;
    if (!native) {
      dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
    }
    var host = native ? document.createElement("div") : dialog;
    if (native) {
      Object.assign(dialog.style, {
        background: "transparent", border: "0", padding: "0",
        maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)"
      });
      dialog.append(host);
    }
    var shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = `
      :host { display: block; box-sizing: border-box; color: var(--primary, #182528); background: var(--panel-background, #fff); color-scheme: light dark;
        border: 1px solid var(--border-strong, #718087); border-radius: 14px; padding: 0;
        width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 32px);
        box-shadow: 0 12px 42px #0005; font: 14px/1.4 system-ui, sans-serif; }
      :host([role=dialog]) { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
        z-index: 2147483647; overflow: auto; box-shadow: 0 0 0 100vmax #0006; }
      form { display: grid; gap: 12px; padding: 20px; }
      h2 { font-size: 20px; margin: 0; } p { margin: 0; }
      label { display: grid; gap: 4px; }
      input { box-sizing: border-box; width: 100%; padding: 8px; border-radius: 6px;
        border: 1px solid var(--border-strong, #718087); font: inherit;
        color: inherit; background: var(--compose-input-background, transparent); }
      .footer { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      button { cursor: pointer; padding: 8px 12px; border: 1px solid var(--border-strong, #718087); border-radius: 7px;
        font: inherit; color: inherit; background: transparent; }
      button[type=submit] { background: #006b54; color: #fff; border-color: #006b54; }
      button:focus-visible, input:focus-visible { outline: 2px solid #00a884; outline-offset: 2px; }
      button:disabled { opacity: .6; cursor: wait; }
      [hidden] { display: none; }`;
    var form = document.createElement("form");
    var heading = document.createElement("h2");
    heading.textContent = label("Revisar evento", "Review event");
    dialog.setAttribute("aria-label", heading.textContent);
    form.append(heading);
    function field(name, type, value) {
      var container = document.createElement("label");
      container.textContent = name;
      var input = document.createElement("input");
      input.type = type;
      input.required = true;
      if (type === "datetime-local") input.step = "1";
      else input.maxLength = 160;
      input.value = value;
      container.append(input);
      form.append(container);
      return input;
    }
    var title = field(label("Título", "Title"), "text", label("Evento do WhatsApp", "WhatsApp event"));
    var start = field(label("Início", "Start"), "datetime-local", match.draft.start);
    var end = field(label("Fim", "End"), "datetime-local", match.draft.end);
    var zone = match.draft.zone;
    if (zone === "local") zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    var timezone = document.createElement("p");
    timezone.textContent = label("Fuso horário: ", "Time zone: ") + (/^[+-]/.test(zone) ? "UTC" + zone : zone);
    var status = document.createElement("p");
    status.setAttribute("role", "status");
    status.hidden = true;
    var buttons = document.createElement("div");
    buttons.className = "footer";
    function button(text, type) {
      var control = document.createElement("button");
      control.type = type;
      control.textContent = text;
      buttons.append(control);
      return control;
    }
    var cancel = button(label("Cancelar", "Cancel"), "button");
    var save = button(label("Salvar .ics", "Save .ics"), "button");
    var open = button(label("Abrir no calendário", "Open in Calendar"), "submit");
    save.hidden = true;
    form.append(timezone, status, buttons);
    shadow.append(style, form);
    document.body.append(dialog);
    preview = dialog;

    async function handoff(exportOnly) {
      if (open.disabled || !available() || preview !== dialog || !form.reportValidity()) return;
      var messages = {
        invalid_time: label("Verifique a data e a hora.", "Check the date and time."),
        missing_time: label("Este horário não existe no fuso exibido. Escolha outro horário.", "This time does not exist in the displayed time zone. Choose a different time."),
        ambiguous_time: label("Este horário ocorre duas vezes. Escolha outro horário.", "This time occurs twice. Choose a different time."),
        invalid_range: label("O fim deve ser depois do início.", "The end must be after the start."),
        invalid_event: label("Insira um título válido.", "Enter a valid title."),
        open_failed: label("Não foi possível abrir o calendário padrão. Você pode salvar o evento.", "Could not open the default calendar. You can save the event."),
        export_failed: label("Não foi possível salvar o evento.", "Could not save the event.")
      };
      status.hidden = true;
      open.disabled = save.disabled = true;
      try {
        var done = await window.__TAURI__.core.invoke("calendar_event", {
          draft: { title: title.value.trim(), start: start.value, end: end.value, zone: zone },
          save: exportOnly
        });
        if (done && preview === dialog) dismiss();
      } catch (error) {
        status.textContent = messages[String(error)] || messages.export_failed;
        status.hidden = false;
        if (String(error) === "open_failed") save.hidden = false;
      } finally {
        open.disabled = save.disabled = false;
      }
    }
    cancel.addEventListener("click", dismiss);
    save.addEventListener("click", function () { handoff(true); });
    form.addEventListener("submit", function (event) { event.preventDefault(); handoff(false); });
    dialog.addEventListener("close", function () {
      if (preview === dialog) preview = null;
      dialog.remove();
    });
    if (native) dialog.showModal();
    else {
      var previousFocus = focused;
      dialog.addEventListener("keydown", function (event) {
        if (event.key === "Escape") { event.preventDefault(); dismiss(); previousFocus?.focus(); }
        if (event.key !== "Tab") return;
        var last = open.disabled ? cancel : open;
        if ((event.shiftKey && shadow.activeElement === title) || (!event.shiftKey && shadow.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : title).focus();
        }
      });
    }
    title.focus();
  }

  function zonedWallTime(value, zone) {
    var wall = Date.parse(value + "Z");
    if (!Number.isFinite(wall)) return null;
    if (/^[+-]/.test(zone)) return Date.parse(value + zone);
    try {
      var formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
      });
      function asWall(at) {
        var parts = {};
        formatter.formatToParts(at).forEach(function (p) { parts[p.type] = p.value; });
        return Date.parse(parts.year + "-" + parts.month + "-" + parts.day + "T" +
          parts.hour + ":" + parts.minute + ":" + parts.second + "Z");
      }
      var offsets = new Set([-86400000, 0, 86400000].map(function (offset) {
        return asWall(wall + offset) - (wall + offset);
      }));
      var candidates = Array.from(offsets).map(function (offset) { return wall - offset; })
        .filter(function (at) { return wall === asWall(at); });
      return candidates.length === 1 ? candidates[0] : null;
    } catch (_) { return null; }
  }

  window.__wrAttentionDate = function (value, at, zone) {
    if (!Number.isFinite(at) || at <= 0) return null;
    var sent = new Date(at);
    // Anchor relative phrases to the date of the source turn in the account's
    // zone. Chrono reads a local reference date for unzoned phrases.
    try {
      var parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).formatToParts(sent).reduce(function (value, part) {
        value[part.type] = part.value;
        return value;
      }, {});
      var localWall = new Date(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
      var times = new Set();
      ["en", "pt"].forEach(function (lang) {
        matches(value, lang, localWall, sent).found.forEach(function (match) {
          var draft = match.draft;
          var due = zonedWallTime(draft.start, draft.zone === "local" ? zone : draft.zone);
          if (Number.isFinite(due)) times.add(due);
        });
      });
      return times.size === 1 ? times.values().next().value : null;
    } catch (_) { return null; }
  };
  if (window.__wrCalendarLinks !== false) {
    window.__wrCalendarActions = { matches: matches, sentDate: sentDate, review: review, dismiss: dismiss };
  }
})();

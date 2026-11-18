// A companion to WhatsApp's chat search. Read its query without changing its
// editor or result list. The shortcut also works if WhatsApp moves the field.
(function () {
  "use strict";
  const root = window;
  if (root.location.origin !== "https://web.whatsapp.com" || root.__whatrustCloseTranscriptSearch) return;

  const doc = root.document;
  const launcherCss = `
    :host{display:flex;flex:none;min-width:0;padding:0 12px 6px;color:var(--primary,#54656f)}
    button{font:500 13px system-ui;color:inherit;background:transparent;border:1px solid #8696a056;
      border-radius:16px;padding:4px 11px;cursor:pointer}
    button:hover{background:#8696a01a}
    button:focus-visible{outline:2px solid #21a766;outline-offset:2px}
  `;
  const panelCss = `
    dialog{box-sizing:border-box;width:min(520px,calc(100vw - 28px));max-height:calc(100vh - 28px);
      padding:0;overflow:hidden;border:1px solid #8696a04d;border-radius:14px;
      background:var(--panel-background,#fff);color:var(--primary,#111b21);
      box-shadow:0 14px 42px #0004;font:14px/1.45 system-ui}
    dialog::backdrop{background:#0005}
    .panel{box-sizing:border-box;display:flex;flex-direction:column;max-height:calc(100vh - 30px);padding:16px}
    header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
    h2{font-size:17px;margin:0}
    button,input{font:inherit;color:inherit}
    button{cursor:pointer}
    .close,.hit{border:0;background:transparent}
    .close{font-size:20px;line-height:30px;width:32px;border-radius:50%;padding:0}
    .close:hover,.hit:hover{background:#8696a01c}
    input{box-sizing:border-box;width:100%;border:1px solid #8696a069;border-radius:8px;
      padding:9px 10px;background:var(--search-input-background,#8696a013);outline-offset:2px}
    input:not(:hover){filter:var(--wr-transcript-input-filter,none)}
    input:focus-visible,button:focus-visible{outline:2px solid #21a766}
    p{margin:10px 0 0;opacity:.75}
    ul{list-style:none;overflow:auto;min-height:0;padding:2px;margin:4px -2px -2px}
    li+li{border-top:1px solid #8696a034}
    .hit{display:block;width:100%;text-align:start;padding:9px 7px;border-radius:6px;overflow-wrap:anywhere}
    .meta,.preview{display:block}
    .meta{color:var(--secondary,#54656f);font-size:12px;margin-bottom:3px}
    .hit:not(:hover) .preview{filter:var(--wr-transcript-preview-filter,none)}
    .hit:not(:hover) .chat{filter:var(--wr-transcript-name-filter,var(--wr-transcript-preview-filter,none))}
    .panel{filter:var(--wr-transcript-idle-filter,none)}
    mark{background:#21c06340;color:inherit;border-radius:2px}
  `;

  let launcher, launchButton, nativeField;
  let dialog, title, closeButton, input, status, hits;
  let timer, generation = 0;

  function L(pt, en) {
    return root.__WR_LANG === "en" ? en : pt;
  }

  function element(tag, content) {
    const node = doc.createElement(tag);
    if (content) node.textContent = content;
    return node;
  }

  function shadowFor(host, css) {
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(element("style", css));
    return shadow;
  }

  function nativeSearchField(side) {
    return [...side.querySelectorAll('input, [contenteditable="true"]')].find(field => {
      if (field.closest('#pane-side [role="listitem"], [data-id]')) return false;
      const label = (field.getAttribute("aria-label") || "") + " " + (field.getAttribute("placeholder") || "");
      return (field.type === "search" || field.getAttribute("role") === "searchbox" ||
        field.getAttribute("data-tab") === "3" || /search|pesquis|procur|busca/i.test(label)) &&
        field.getClientRects().length > 0;
    });
  }

  function searchRow(field, side) {
    // Insert beside the search controls, before the part of the sidebar that
    // scrolls. Some versions nest both underneath a shared wrapper.
    const list = side.querySelector("#pane-side");
    let row = field;
    while (row.parentElement !== side && row.parentElement !== list && !(list && row.parentElement.contains(list))) {
      row = row.parentElement;
    }
    return row;
  }

  function mountLauncher() {
    const side = doc.getElementById("side");
    if (!side?.contains(nativeField) || !nativeField.getClientRects().length) {
      nativeField = side && nativeSearchField(side);
    }
    if (!nativeField) {
      launcher?.remove();
      return;
    }
    if (!launcher) {
      launcher = element("span");
      launcher.id = "__whatrust_transcript_search";
      launchButton = element("button");
      launchButton.type = "button";
      launchButton.setAttribute("aria-haspopup", "dialog");
      launchButton.addEventListener("click", () => openSearch());
      shadowFor(launcher, launcherCss).append(launchButton);
      relabel();
    }
    const row = searchRow(nativeField, side);
    if (row.nextElementSibling !== launcher) row.after(launcher);
  }

  function relabel() {
    const label = L("Buscar em transcrições", "Search transcripts");
    if (launchButton) {
      launchButton.textContent = L("Transcrições", "Transcripts");
      launchButton.title = label;
      launchButton.setAttribute("aria-label", label);
    }
    if (dialog) {
      title.textContent = label;
      input.placeholder = L("Buscar em áudios e vídeos", "Search voice notes and videos");
      input.setAttribute("aria-label", label);
      closeButton.setAttribute("aria-label", L("Fechar", "Close"));
    }
  }

  function buildDialog() {
    const host = element("div");
    const shadow = shadowFor(host, panelCss);
    dialog = element("dialog");
    dialog.setAttribute("aria-labelledby", "transcript-title");
    const panel = element("div");
    panel.className = "panel";
    const header = element("header");
    title = element("h2");
    title.id = "transcript-title";
    closeButton = element("button", "×");
    closeButton.className = "close";
    closeButton.type = "button";
    closeButton.addEventListener("click", closeSearch);
    header.append(title, closeButton);
    input = element("input");
    input.type = "search";
    input.maxLength = 160;
    input.autocomplete = "off";
    input.addEventListener("input", updateSearch);
    status = element("p");
    status.setAttribute("role", "status");
    hits = element("ul");
    panel.append(header, input, status, hits);
    dialog.append(panel);
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      closeSearch();
    });
    shadow.append(dialog);
    doc.body.append(host);
    relabel();
  }

  function openSearch() {
    if (root.__whatrustLocked || !doc.querySelector("#side, #pane-side, #main")) return false;
    if (!dialog) buildDialog();
    if (dialog.open) {
      input.focus();
      return true;
    }
    const query = nativeField?.isConnected ? (nativeField.value ?? nativeField.textContent) : "";
    input.value = Array.from((query || "").trim()).slice(0, 160).join("");
    dialog.showModal();
    input.focus();
    updateSearch();
    return true;
  }

  function closeSearch() {
    clearTimeout(timer);
    generation++;
    if (!dialog) return;
    input.value = "";
    hits.replaceChildren();
    status.textContent = "";
    if (dialog.open) dialog.close();
  }

  function updateSearch() {
    clearTimeout(timer);
    const request = ++generation;
    const query = input.value.trim();
    hits.replaceChildren();
    if (!query) {
      status.textContent = L("Digite uma palavra ou frase.", "Enter a word or phrase.");
      return;
    }
    status.textContent = L("Buscando…", "Searching…");
    timer = setTimeout(async () => {
      try {
        const results = await root.__TAURI__.core.invoke("search_transcripts", { query });
        if (request === generation && dialog.open) renderResults(results);
      } catch (error) {
        if (request !== generation || !dialog.open) return;
        if (error === "locked") closeSearch();
        else status.textContent = L("Não foi possível buscar nas transcrições.", "Could not search transcripts.");
      }
    }, 180);
  }

  function chatName(id) {
    try {
      const chat = root.WPP?.chat?.get(id);
      return chat?.formattedTitle || chat?.name || chat?.contact?.name || "";
    } catch {
      return "";
    }
  }

  function renderResults(results) {
    const { hits: matches, has_more: hasMore } = results;
    status.textContent = !matches.length ? L("Nenhuma transcrição encontrada.", "No matching transcripts.") :
      hasMore ? L("Mostrando as 50 mais recentes. Refine a busca para ver outras.", "Showing the 50 newest matches. Refine your search to see others.") :
      L(matches.length + " resultado(s)", matches.length + (matches.length === 1 ? " match" : " matches"));
    const formatDate = new Intl.DateTimeFormat(L("pt-BR", "en"), { dateStyle: "medium", timeStyle: "short" });
    const names = new Map();
    for (const hit of matches) {
      const row = element("li");
      const button = element("button");
      button.className = "hit";
      button.type = "button";
      const media = hit.media === "video" ? L("Vídeo", "Video") : L("Mensagem de voz", "Voice note");
      const meta = element("span", media);
      meta.className = "meta";
      if (!names.has(hit.chat)) names.set(hit.chat, chatName(hit.chat));
      const name = names.get(hit.chat);
      if (name) {
        const chat = element("span", " · " + name);
        chat.className = "chat";
        meta.append(chat);
      }
      if (hit.at_ms) meta.append(" · " + formatDate.format(hit.at_ms));
      const preview = element("span");
      preview.className = "preview";
      preview.append(hit.before, element("mark", hit.matched), hit.after);
      button.append(meta, preview);
      button.addEventListener("click", () => {
        closeSearch();
        root.__whatrustJumpToMessage(hit.id, hit.chat);
      });
      row.append(button);
      hits.append(row);
    }
  }

  root.__whatrustCloseTranscriptSearch = closeSearch;
  const previousRelang = root.__wrRelang;
  root.__wrRelang = () => {
    previousRelang?.();
    relabel();
    if (dialog?.open) updateSearch();
  };
  root.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey ||
      event.code !== "KeyF" || event.isComposing || event.repeat) return;
    if (openSearch()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  let mountTimer;
  new MutationObserver(() => {
    if (mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = 0;
      mountLauncher();
    }, 100);
  }).observe(doc, { childList: true, subtree: true });
  mountLauncher();
})();

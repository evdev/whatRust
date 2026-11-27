/* Account inbox and WhatsApp message collection for Needs Attention. */
(function () {
  "use strict";
  const root = window;
  if (location.origin !== "https://web.whatsapp.com" || root.__wrAttention) return;

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const OVERLAP = 2 * MINUTE;
  const PAGE_SIZE = 40;
  const MAX_PAGES = 4;
  const MAX_CHATS = 32;
  const L = (pt, en) => root.__WR_LANG === "en" ? en : pt;
  const invoke = (command, args = {}) => Promise.resolve().then(() => root.__TAURI__.core.invoke(command, args));
  let snapshot = null;
  let mounted = null;
  let latestRequest = 0;
  let refreshPending;
  let mutations = 0;
  let wakeTimer;
  let tickPending;

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, callback, className) {
    const node = el("button", text, className);
    node.type = "button";
    node.addEventListener("click", callback);
    return node;
  }

  function dateLabel(ms) {
    return new Date(ms).toLocaleString(root.__WR_LANG === "en" ? "en" : "pt-BR", {
      dateStyle: "medium", timeStyle: "short",
    });
  }

  function localInput(ms) {
    const date = new Date(ms);
    return new Date(ms - date.getTimezoneOffset() * MINUTE).toISOString().slice(0, 16);
  }

  function showInInbox(item, now) {
    return item.state === "open" && !item.muted
      && !(item.snooze_until > now) && !(item.eligible_at > now)
      && (item.kind !== "waiting" || (item.due_at && item.due_at <= now));
  }

  function badge() {
    if (!snapshot || root.__whatrustLocked) return { count: 0, overdue: false };
    const now = Date.now();
    const visible = snapshot.items.filter(item => item.actionable ?? (showInInbox(item, now)
      && (item.manual || (snapshot.enabled && snapshot.awake))));
    return { count: visible.length, overdue: visible.some(item => item.due_at && item.due_at < now) };
  }

  function applyState(value) {
    if (!value || !Array.isArray(value.items)) return;
    const previous = snapshot;
    snapshot = value;
    if (!value.enabled) clearCollection();
    if (value.next_check !== previous?.next_check || value.enabled !== previous?.enabled) {
      clearTimeout(wakeTimer);
      if (value.enabled && value.next_check > Date.now() + 1000) {
        wakeTimer = setTimeout(tick, Math.max(1000, value.next_check - Date.now() - 9000));
      }
    }
    root.dispatchEvent(new Event("whatrust-attention-update"));
    mounted?.render();
  }

  function refresh() {
    if (root.__whatrustLocked) {
      snapshot = null;
      clearCollection();
      root.dispatchEvent(new Event("whatrust-attention-update"));
      mounted?.close();
      return Promise.resolve(null);
    }
    if (refreshPending) return refreshPending;
    if (mutations) return Promise.resolve(snapshot);
    const seq = ++latestRequest;
    refreshPending = invoke("attention_list").then(value => {
      if (seq === latestRequest && !root.__whatrustLocked) applyState(value);
      return value;
    }).catch(() => null).finally(() => { refreshPending = null; });
    return refreshPending;
  }

  async function mutate(command, args) {
    // A slow list response must not undo a user action in the visible inbox.
    const seq = ++latestRequest;
    mutations++;
    try {
      const value = await invoke(command, args);
      if (!root.__whatrustLocked && seq === latestRequest) applyState(value);
      return value;
    } finally {
      mutations--;
      if (!mutations) setTimeout(refresh, 0);
    }
  }

  function action(id, name, fields) {
    return mutate("attention_action", { id, action: name, ...fields });
  }

  function mark(message) {
    const copy = {
      msg_id: message.msg_id || "", msg_token: message.msg_token || "",
      chat_id: message.chat_id || null, chat_name: message.chat_name || "",
      sender: message.sender || "", snippet: message.snippet || "",
      msg_timestamp: message.msg_timestamp || null, msg_epoch: message.msg_epoch || null,
      kind: message.kind || "other",
    };
    return action("", "manual", { message: copy });
  }

  const CSS = `
    .attention{height:100%;box-sizing:border-box;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif;border-inline-end:1px solid var(--line)}
    .attention *{box-sizing:border-box}
    .attention [hidden]{display:none!important}
    .attention header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 12px 6px}
    .attention h1{margin:0;font-size:18px;font-weight:600}
    .attention h2{margin:6px 0;font-size:13px;font-weight:650;overflow-wrap:anywhere}
    .attention h3{margin:0;font-size:14px;overflow-wrap:anywhere}
    .attention p{margin:0}
    .attention button,.attention input,.attention select{color:inherit;background:var(--hover);font:inherit;border:1px solid var(--line);border-radius:8px;padding:6px 9px;max-width:100%}
    .attention button{cursor:pointer}
    .attention button:hover:not(:disabled){filter:brightness(.9)}
    .attention button:disabled{cursor:default;opacity:.6}
    .attention button.primary,.attention button[aria-pressed=true]{background:#f0bd68;border-color:#f0bd68;color:#30230b}
    .attention button.close{background:transparent;border:0;padding:3px 9px;font-size:22px}
    .attention .status{color:var(--dim);padding:0 12px 8px;font-size:12px;display:grid;gap:4px}
    .attention .status button{justify-self:start}
    .attention nav{display:flex;gap:5px;flex-wrap:wrap;padding:0 12px 10px}
    .attention nav button,.attention .actions button{font-size:12px}
    .attention .body{padding:0 12px 12px;min-height:0;overflow:auto;flex:1}
    .attention section + section{margin-top:12px}
    .attention article,.attention form{background:var(--bg);padding:11px;border:1px solid var(--line);border-radius:10px;margin:0 0 7px;display:grid;gap:8px}
    .attention blockquote{margin:0;padding:2px 0 2px 8px;border-inline-start:2px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}
    .attention .actions{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
    .attention .muted{color:var(--dim);font-size:12px}
    .attention .due{color:#b9543c;font-weight:650}
    .attention .empty{padding:16px 0;color:var(--dim)}
    .attention label{display:grid;gap:4px}
    .attention form{margin:2px 0 0}
    .attention form input,.attention form select{width:100%}
    .attention .error{color:#b9543c;font-weight:600}
    .attention details{padding:0 12px 8px}
    .attention details summary{cursor:pointer;font-size:12px;color:var(--dim)}
    .attention details .actions{margin-top:6px}
  `;

  function detailTime(item) {
    const now = Date.now();
    if (item.snooze_until > now) return L("Adiado até ", "Snoozed until ") + dateLabel(item.snooze_until);
    if (item.due_at) return L("Prazo ", "Due ") + dateLabel(item.due_at);
    return "";
  }

  function kindLabel(kind) {
    if (kind === "waiting") return L("Esperando resposta", "Waiting on them");
    if (kind === "reply") return L("Devo uma resposta", "Reply needed");
    return L("Ação pendente", "Action needed");
  }

  function mount(slot, options) {
    let section = "inbox";
    let editor = null;
    let fingerprint = "";
    let active = true;
    const style = el("style", CSS);
    const frame = el("div", null, "attention");
    const head = el("header");
    const close = button("×", options.close, "close");
    close.setAttribute("aria-label", L("Fechar", "Close"));
    head.append(el("h1", L("Precisa de atenção", "Needs Attention")), close);
    const status = el("div", null, "status");
    status.setAttribute("role", "status");
    const scope = el("details");
    scope.append(el("summary", L("Cobertura da conversa", "Chat coverage")));
    const scopeBody = el("div", null, "actions");
    scope.append(scopeBody);
    const nav = el("nav");
    nav.setAttribute("aria-label", L("Seções da caixa de entrada", "Inbox sections"));
    const body = el("div", null, "body");
    frame.append(head, status, scope, nav, body);
    slot.replaceChildren(style, frame);

    const error = () => options.toast(L("Não foi possível salvar essa alteração.", "Could not save that change."));

    function undo(id) {
      return action(id, "undo").then(value => {
        if (value?.undo_note) options.toast(L("O item de destino foi mantido.", "The destination item was kept."));
      }).catch(error);
    }

    function accept(id, name, fields, allowUndo = true) {
      return action(id, name, fields).then(value => {
        if (allowUndo) options.toast(L("Alteração salva.", "Change saved."), {
          label: L("Desfazer", "Undo"),
          fn: () => undo(id),
        });
        return value;
      });
    }

    function renderStatus() {
      status.replaceChildren();
      const state = snapshot;
      const text = (line) => status.append(el("p", line));
      if (!state) {
        text(L("Carregando…", "Loading…"));
        return;
      }
      if (!state.enabled) {
        text(L("Verificações automáticas desativadas. Você pode marcar mensagens manualmente.", "Automatic checks are off. You can mark messages manually."));
        status.append(button(L("Abrir configurações", "Open settings"), () => invoke("open_app_panel").catch(error)));
        return;
      }
      if (state.provider) {
        const provider = { openai: "OpenAI Luna", gemini: "Gemini Decision", jev: "TypeSafe Jev" }[state.provider];
        if (provider) text(provider);
      }
      if (state.last_checked) text(L("Última verificação ", "Last successful check ") + dateLabel(state.last_checked));
      else text(L("Aguardando a primeira verificação.", "Waiting for the first check."));
      if (state.since) text(L("Cobertura a partir de ", "Coverage starts ") + dateLabel(state.since));
      if (state.pending) text(L("Conversas pendentes ", "Pending chats ") + state.pending);
      const coverage = typeof state.coverage === "string" ? state.coverage : "";
      if (coverage === "complete" && state.coverage_through) text(L("Cobertura até ", "Coverage through ") + dateLabel(state.coverage_through));
      if (coverage === "partial" || state.coverage?.partial) text(L("Cobertura parcial. Algumas mensagens ainda não estão disponíveis.", "Partial coverage. Some messages are still unavailable."));
      if (coverage === "offline" || state.coverage?.offline) text(L("WhatsApp desconectado. As verificações serão retomadas após a conexão.", "WhatsApp is offline. Checks resume after reconnecting."));
      const pauses = {
        budget: L("Pausado pelo limite mensal.", "Paused at the monthly limit."),
        credentials: L("Confira a chave da API.", "Check the API key."),
        credit: L("Confira o saldo do provedor.", "Check the provider balance."),
        throttled: L("Limite temporário do provedor.", "Temporary provider rate limit."),
        offline: L("WhatsApp desconectado. As verificações serão retomadas após a conexão.", "WhatsApp is offline. Checks resume after reconnecting."),
        review: L("Uma parte da conversa precisa de revisão.", "Some conversation history needs review."),
        request: L("O provedor não conseguiu processar a solicitação. As conversas continuam na fila.", "The provider couldn't process the request. Pending chats stay queued."),
        provider: L("Provedor indisponível. As conversas continuam na fila.", "Provider unavailable. Pending chats stay queued."),
      };
      if (state.pause) text(pauses[state.pause] || pauses.provider);
      if (!state.key_configured || state.pause === "request") status.append(button(L("Abrir configurações", "Open settings"), () => invoke("open_app_panel").catch(error)));
      if (state.next_check && !state.pause && state.key_configured) text(L("Próxima verificação ", "Next check ") + dateLabel(state.next_check));
    }

    function renderScope() {
      const current = options.activeChat();
      scope.hidden = !snapshot?.enabled || !current?.id;
      if (scope.hidden) return;
      const excluded = (snapshot.excluded_chats || []).includes(current.id);
      const group = current.id.endsWith("@g.us");
      const allowed = (snapshot.group_chats || []).includes(current.id);
      scopeBody.replaceChildren(el("p", current.name || L("Conversa atual", "Current chat")));
      scopeBody.append(button(excluded ? L("Incluir", "Include chat") : L("Excluir", "Exclude chat"), () => {
        accept("", excluded ? "include_chat" : "exclude_chat", { chat_id: current.id }, false).then(tick).catch(error);
      }));
      if (group) scopeBody.append(button(allowed ? L("Desativar grupo", "Disable group") : L("Ativar grupo", "Enable group"), () => {
        accept("", allowed ? "disable_group" : "enable_group", { chat_id: current.id }, false).then(tick).catch(error);
      }));
    }

    function setEditor(box, form) {
      editor?.remove();
      editor = form;
      box.append(form);
      form.querySelector("input,select,button")?.focus();
    }

    function field(form, label, input) {
      const node = el("label", label);
      node.append(input);
      form.append(node);
      return input;
    }

    function formControls(form, label, submit) {
      const row = el("div", null, "actions");
      const save = el("button", label, "primary");
      save.type = "submit";
      const cancel = button(L("Cancelar", "Cancel"), () => {
        form.remove();
        editor = null;
      });
      row.append(save, cancel);
      const hint = el("p", "", "error");
      hint.setAttribute("role", "alert");
      form.append(row, hint);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        save.disabled = true;
        cancel.disabled = true;
        hint.textContent = "";
        try {
          await submit();
          form.remove();
          editor = null;
          render();
        } catch {
          hint.textContent = L("Não foi possível salvar. Tente novamente.", "Could not save. Try again.");
          save.disabled = false;
          cancel.disabled = false;
        }
      });
      return save;
    }

    function editSnooze(box, item, name) {
      const form = el("form");
      const when = el("input");
      when.type = "datetime-local";
      when.required = true;
      when.min = localInput(Date.now() + MINUTE);
      const previous = name === "follow_at" ? item.due_at : item.snooze_until;
      when.value = localInput(previous > Date.now() + MINUTE ? previous : Date.now() + HOUR);
      field(form, name === "follow_at" ? L("Acompanhar em", "Follow up at") : L("Mostrar novamente em", "Show again at"), when);
      formControls(form, L("Salvar", "Save"), () => accept(item.id, name, { until: new Date(when.value).getTime() }));
      setEditor(box, form);
    }

    function editMute(box, item) {
      const form = el("form");
      form.append(el("p", L("Ocultar sugestões automáticas deste tipo nesta conversa?", "Hide automatic suggestions of this kind in this chat?")));
      form.append(el("p", [item.message?.chat_name, kindLabel(item.kind)].filter(Boolean).join(" · "), "muted"));
      formControls(form, L("Silenciar", "Mute"), () => accept(item.id, "mute"));
      setEditor(box, form);
    }

    function editMove(box, item, task) {
      const form = el("form");
      const title = el("input");
      title.type = "text";
      title.maxLength = 300;
      title.required = true;
      title.value = item.title;
      field(form, L("Título", "Title"), title);
      const due = el("input");
      const remind = el("input");
      due.type = remind.type = "datetime-local";
      const direction = el("select");
      if (task) {
        if (item.due_at) due.value = localInput(item.due_at);
        field(form, L("Prazo", "Due date"), due);
      } else {
        for (const [key, label] of [["", L("Escolher…", "Choose…")], ["owe", L("Devo uma resposta", "I owe a reply")], ["waiting", L("Esperando resposta", "Waiting on them")]]) {
          const option = el("option", label);
          option.value = key;
          direction.append(option);
        }
        direction.required = true;
        direction.value = item.kind === "waiting" ? "waiting" : item.kind === "reply" ? "owe" : "";
        field(form, L("Direção da resposta", "Reply direction"), direction);
        form.append(el("p", L("Uma nova mensagem na direção escolhida pode encerrar o acompanhamento, mesmo sobre outro assunto.", "A later message in the selected direction can clear the watch, even on another subject."), "muted"));
      }
      field(form, L("Lembrete", "Reminder"), remind);
      const select = el("select");
      const matchField = field(form, L("Salvar como", "Save as"), select).parentElement;
      matchField.hidden = true;
      const notice = el("p", "", "muted");
      form.append(notice);
      const save = formControls(form, L("Salvar", "Save"), async () => {
        const kind = task ? "task" : direction.value;
        const draft = { title: title.value.trim(), kind };
        if (task && due.value) draft.due_at = new Date(due.value).getTime();
        if (remind.value) draft.remind_at = new Date(remind.value).getTime();
        const value = await mutate("attention_move", { id: item.id, draft, existing_id: select.value || null });
        const moved = value?.items?.find(entry => entry.id === item.id);
        if (moved?.moved_id) {
          options.openDestination(moved.moved_id, moved.moved_kind || kind);
        }
        options.toast(task ? L("Movido para Tarefas.", "Moved to To-Do.") : L("Movido para Respostas.", "Moved to Replies."), {
          label: L("Desfazer", "Undo"),
          fn: () => undo(item.id),
        });
      });
      let matchesSeq = 0;
      const loadMatches = async () => {
        const kind = task ? "task" : direction.value;
        const seq = ++matchesSeq;
        save.disabled = true;
        matchField.hidden = true;
        notice.textContent = "";
        select.replaceChildren();
        if (!kind) return;
        try {
          const matches = await invoke("attention_matches", { id: item.id, kind });
          if (seq !== matchesSeq) return;
          const create = el("option", L("Criar item separado", "Create separate item"));
          create.value = "";
          select.append(create);
          for (const match of matches) {
            const prefix = match.kind === "task" ? "" : (match.kind === "waiting" ? L("Esperando resposta", "Waiting on them") : L("Devo uma resposta", "I owe a reply")) + " · ";
            const option = el("option", L("Usar item existente: ", "Use existing: ") + prefix + match.title);
            option.value = match.id;
            select.append(option);
          }
          matchField.hidden = !matches.length;
          save.disabled = false;
        } catch {
          if (seq !== matchesSeq) return;
          notice.replaceChildren(button(L("Tentar carregar destinos novamente", "Retry checking destinations"), loadMatches));
        }
      };
      select.addEventListener("change", () => {
        const linked = !!select.value;
        title.disabled = due.disabled = remind.disabled = linked;
        notice.textContent = linked ? L("O item existente manterá seus próprios detalhes.", "The existing item will keep its details.") : "";
      });
      direction.addEventListener("change", () => {
        title.disabled = due.disabled = remind.disabled = false;
        loadMatches();
      });
      setEditor(box, form);
      loadMatches();
    }

    function card(item) {
      const box = el("article");
      box.setAttribute("data-attention-id", item.id);
      const time = detailTime(item);
      box.append(el("p", kindLabel(item.kind) + (time ? " · " + time : ""), time && item.due_at < Date.now() ? "muted due" : "muted"));
      box.append(el("h3", item.title || kindLabel(item.kind)));
      if (item.message?.snippet) box.append(el("blockquote", item.message.snippet));
      else if (item.message) box.append(el("p", L("O trecho original não está disponível.", "The original excerpt is unavailable."), "muted"));
      const row = el("div", null, "actions");
      const doAction = (label, name, className, pressed) => {
        const node = button(label, () => {
          node.disabled = true;
          accept(item.id, name).catch(() => { node.disabled = false; error(); });
        }, className);
        if (pressed !== undefined) node.setAttribute("aria-pressed", String(pressed));
        row.append(node);
      };
      if (item.message?.chat_id) {
        const source = item.message.msg_id || item.message.msg_token;
        const unavailable = item.unavailable || !source || item.message.kind === "revoked";
        row.append(button(unavailable ? L("Abrir conversa", "Open chat") : L("Abrir mensagem", "Open message"), () => {
          if (unavailable) options.openChat(item.message.chat_id);
          else options.openMessage(item.message);
        }));
      }
      if (item.state === "moved") {
        if (item.moved_id) row.append(button(L("Abrir destino", "Open destination"), () => options.openDestination(item.moved_id, item.moved_kind)));
        row.append(button(L("Desfazer", "Undo"), () => undo(item.id)));
      } else if (item.state === "done" || item.state === "dismissed") {
        doAction(L("Reabrir", "Reopen"), "reopen");
      } else {
        if (item.review_close && section === "review") {
          box.append(el("p", L("Uma mensagem posterior pode ter resolvido este item.", "A later message may have resolved this item."), "muted"));
          const later = item.resolution_message;
          if (later?.snippet) box.append(el("blockquote", later.snippet));
          if (later?.chat_id && (later.msg_id || later.msg_token)) {
            row.append(button(L("Abrir mensagem posterior", "Open later message"), () => options.openMessage(later)));
          }
          doAction(L("Já resolvido", "Already handled"), "already_handled", "primary");
          doAction(L("Manter aberto", "Keep open"), "keep_open");
        }
        row.append(button(L("Mover para Tarefas", "Move to To-Do"), () => editMove(box, item, true), "primary"));
        row.append(button(L("Mover para acompanhamento", "Move to Follow-up"), () => editMove(box, item, false)));
        doAction(L("Concluir", "Done"), "done");
        row.append(button(L("Adiar…", "Snooze…"), () => editSnooze(box, item, "snooze")));
        if (item.kind === "waiting") row.append(button(L("Definir acompanhamento…", "Set follow-up time…"), () => editSnooze(box, item, "follow_at")));
        doAction(L("Dispensar", "Dismiss"), "dismiss");
        if (!item.manual) {
          doAction(L("Útil", "Useful"), "useful", "", item.vote === "useful");
          doAction(L("Não é útil", "Not useful"), "not_useful");
          const more = el("details");
          more.append(el("summary", L("Mais opções", "More options")));
          const actions = el("div", null, "actions");
          actions.append(button(L("Muito cedo…", "Too soon…"), () => editSnooze(box, item, "too_soon")));
          actions.append(button(L("Já resolvido", "Already handled"), () => accept(item.id, "already_handled").catch(error)));
          if (!item.muted) actions.append(button(L("Silenciar este tipo", "Mute this kind"), () => editMute(box, item)));
          more.append(actions);
          box.append(row, more);
        }
      }
      if (!row.parentNode) box.append(row);
      if (item.mute_suggested && !item.muted && item.state !== "moved") {
        box.append(button(L("Silenciar sugestões parecidas…", "Mute similar suggestions…"), () => editMute(box, item)));
      }
      return box;
    }

    function render() {
      if (!active || root.__whatrustLocked) return;
      const state = snapshot;
      const now = Date.now();
      const activeItems = state?.items || [];
      const next = JSON.stringify([section, state, activeItems.map(item => [showInInbox(item, now), Math.sign((item.due_at || 0) - now), item.snooze_until > now]), options.activeChat()]);
      if (editor?.isConnected || next === fingerprint) return;
      fingerprint = next;
      const previousPosition = body.scrollTop;
      renderStatus();
      renderScope();
      nav.replaceChildren();
      const views = [
        ["inbox", L("Caixa de entrada", "Inbox")],
        ["waiting", L("Esperando", "Waiting")],
        ["review", L("Revisão", "Review")],
        ["history", L("Histórico", "History")],
        ["rules", L("Preferências", "Preferences")],
      ];
      for (const [key, text] of views) {
        const tab = button(text, () => {
          section = key;
          editor?.remove();
          editor = null;
          body.scrollTop = 0;
          render();
          nav.querySelector('[aria-pressed="true"]')?.focus();
        });
        tab.setAttribute("aria-pressed", String(section === key));
        nav.append(tab);
      }
      body.replaceChildren();
      if (!state) return;
      if (section === "rules") {
        const rules = state.rules || [];
        if (!rules.length) body.append(el("p", L("Nenhuma regra de silêncio.", "No mute rules."), "empty"));
        for (const rule of rules) {
          const entry = el("article");
          entry.append(el("h3", rule.chat_name || L("Conversa", "Chat")));
          entry.append(el("p", kindLabel(rule.kind), "muted"));
          entry.append(button(L("Remover regra", "Remove rule"), () => accept(rule.id, "unmute", null, false).catch(error)));
          body.append(entry);
        }
        body.append(button(L("Redefinir preferências aprendidas", "Reset learned preferences"), () => {
          const confirm = el("form");
          confirm.append(el("p", L("Remover votos e regras aprendidas desta conta?", "Remove votes and learned rules for this account?")));
          formControls(confirm, L("Redefinir", "Reset"), () => accept("", "reset", null, false));
          setEditor(body, confirm);
        }));
        return;
      }
      const visible = activeItems.filter(item => {
        if (section === "history") return ["done", "dismissed", "moved"].includes(item.state);
        if (item.state !== "open" && item.state !== "review") return false;
        if (section === "review") return item.state === "review" || item.muted || item.review_close;
        if (section === "waiting") return item.state === "open" && !item.muted && !showInInbox(item, now)
          && (item.kind === "waiting" || item.snooze_until > now);
        return showInInbox(item, now) && (item.actionable !== false || !state.awake);
      });
      if (!visible.length) {
        const complete = state.enabled && state.coverage_through && !state.pending && !state.pause
          && !activeItems.some(item => item.state === "review" || item.review_close)
          && (state.coverage === "complete" || (state.coverage && !state.coverage.partial && !state.coverage.offline));
        body.append(el("p", section === "inbox" && complete
          ? L("Tudo em dia.", "All caught up.") : L("Nenhum item aqui.", "Nothing here yet."), "empty"));
        return;
      }
      visible.sort((a, b) => {
        const aDue = a.due_at || Infinity;
        const bDue = b.due_at || Infinity;
        if (aDue !== bDue) return aDue - bDue;
        if ((a.rank || 0) !== (b.rank || 0)) return (b.rank || 0) - (a.rank || 0);
        return (b.message?.msg_epoch || 0) - (a.message?.msg_epoch || 0);
      });
      const groups = new Map();
      for (const item of visible) {
        const key = item.message?.chat_id || "";
        if (!groups.has(key)) {
          const group = el("section");
          group.append(el("h2", item.message?.chat_name || L("Conversa", "Chat")));
          body.append(group);
          groups.set(key, group);
        }
        groups.get(key).append(card(item));
      }
      body.scrollTop = previousPosition;
    }

    const closeView = () => {
      active = false;
      if (mounted?.close === options.close) mounted = null;
      slot.replaceChildren();
    };
    mounted = { render, close: options.close };
    render();
    tick();
    return closeView;
  }

  const liveQueue = new Map();
  let liveTimer;
  let subscribed;
  let discovery;
  let offline = false;
  let discoveryRetryAt = 0;

  function clearCollection() {
    liveQueue.clear();
    clearTimeout(liveTimer);
    liveTimer = null;
    discovery = null;
    discoveryRetryAt = 0;
  }

  function idOf(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value._serialized === "string") return value._serialized;
    const out = value.toString?.();
    return out && out !== "[object Object]" ? out : "";
  }

  function stamp(value) {
    const time = Number(value) || 0;
    return time > 0 && time < 1e12 ? time * 1000 : time;
  }

  function canonicalChat(id) {
    return idOf(id).replace(/:\d+@/, "@");
  }

  function chatFor(id) {
    return canonicalChat(id?.remote || /^(?:true|false)_([^_]+)_/.exec(idOf(id))?.[1]);
  }

  function messageToken(id) {
    const rest = /^(?:true|false)_[^_]+_(.+)$/.exec(id)?.[1];
    return rest ? rest.replace(/_[^_@]+@[^_]+$/, "") : "";
  }

  function allowed(chat, state = snapshot) {
    if (!state?.enabled || root.__whatrustLocked || !/@(?:c\.us|s\.whatsapp\.net|lid|g\.us)$/i.test(chat)) return false;
    if ((state.excluded_chats || []).includes(chat)) return false;
    return !chat.endsWith("@g.us") || (state.group_chats || []).includes(chat);
  }

  function mapMessage(raw, chatHint, nameHint, edited = false) {
    if (!raw) return null;
    const data = raw.attributes || raw;
    const msgKey = raw.id || data.id;
    const id = idOf(msgKey);
    const token = messageToken(id);
    const chat = chatFor(msgKey) || chatHint;
    const sent = stamp(raw.t || data.t || data.timestamp);
    if (!token || !chat || !sent || !allowed(chat)) return null;
    const format = raw.type || data.type;
    const kinds = { chat: "text", ptt: "voice", audio: "voice", image: "image", video: "video", document: "document" };
    if (!Object.hasOwn(kinds, format) && format !== "revoked") return null;
    const deleted = format === "revoked";
    const snippet = deleted ? "" : String(raw.caption || data.caption || (format === "chat" ? (raw.body || data.body || "") : "")).slice(0, 1000);
    if (!deleted && format === "chat" && !snippet.trim()) return null;
    const fromMe = msgKey?.fromMe === true || id.startsWith("true_");
    const quote = idOf(raw.quotedMsg?.id || data.quotedMsg?.id || raw.quotedStanzaID || data.quotedStanzaID);
    const sender = fromMe ? L("Você", "You") : String(raw.sender?.formattedName || raw.sender?.name || raw.notifyName || data.notifyName || "").slice(0, 160);
    const chatName = String(nameHint || raw.chat?.formattedTitle || raw.chat?.name || "").slice(0, 160);
    const speaker = fromMe ? "" : idOf(raw.author || data.author || msgKey?.participant || raw.from || data.from);
    const duration = Number(raw.ephemeralDuration || data.ephemeralDuration || raw.chat?.ephemeralDuration) || 0;
    const version = stamp(raw.latestEditSenderTimestampMs || data.latestEditSenderTimestampMs);
    let due = null;
    try {
      if (!deleted && snippet) due = root.__wrAttentionDate?.(snippet, sent, snapshot?.time_zone);
    } catch {
      // Keep the evidence available even when the date parser is unavailable.
    }
    return {
      message: {
        msg_id: id, msg_token: token, chat_id: chat, chat_name: chatName, sender, snippet,
        msg_epoch: sent, kind: kinds[format] || "other",
      },
      at_ms: sent, from_me: fromMe, quoted_id: quote || null, kind: kinds[format] || "other",
      speaker: speaker || null, deleted, unavailable: !deleted && !snippet,
      edited_at: version || (edited ? Date.now() : null),
      expires_at: duration > 0 && (raw.isEphemeral || data.isEphemeral || data.ephemeralDuration) ? sent + duration * 1000 : null,
      due_at: Number.isFinite(due) ? due : null,
    };
  }

  function connected() {
    const wpp = root.WPP;
    if (!wpp?.isReady || !wpp.chat || root.__whatrustLocked) return false;
    try {
      return wpp.conn?.isMainReady?.() !== false && wpp.conn?.isAuthenticated?.() !== false
        && wpp.conn?.isOnline?.() !== false;
    } catch {
      return false;
    }
  }

  async function ingest(messages, coverage) {
    if (!snapshot?.enabled || root.__whatrustLocked) return;
    const allowedMessages = messages.filter(row => allowed(row.message.chat_id));
    if (!allowedMessages.length && !coverage) return;
    await invoke("attention_ingest", { messages: allowedMessages, coverage });
  }

  function flushSoon() {
    if (!liveTimer) liveTimer = setTimeout(flush, 350);
  }

  async function flush() {
    liveTimer = null;
    if (!snapshot?.enabled || root.__whatrustLocked) return;
    const sent = Array.from(liveQueue).slice(0, PAGE_SIZE);
    if (!sent.length) return;
    try {
      await ingest(sent.map(([, row]) => row));
      for (const [id, row] of sent) {
        if (liveQueue.get(id) === row) liveQueue.delete(id);
      }
      if (liveQueue.size) flushSoon();
    } catch {
      // Keep entries until accepted. Recovery also reads back from the last
      // persisted discovery position if this account view goes away.
      if (!liveTimer) liveTimer = setTimeout(flush, 5000);
    }
  }

  function queue(row) {
    if (!row || (!row.deleted && row.at_ms < (snapshot?.backfill_from || snapshot?.since || 0) - OVERLAP)) return;
    const id = row.message.msg_id;
    if (!liveQueue.get(id)?.deleted || row.deleted) liveQueue.set(id, row);
    if (liveQueue.size > 1000) liveQueue.delete(liveQueue.keys().next().value);
    flushSoon();
  }

  function onRevoke(payload) {
    const id = idOf(payload?.refId);
    const token = messageToken(id);
    const chat = chatFor(payload?.refId);
    if (!token || !allowed(chat)) return;
    queue({
      message: { msg_id: id, msg_token: token, chat_id: chat, kind: "other" },
      at_ms: Date.now(), from_me: id.startsWith("true_"), deleted: true,
    });
  }

  function arm() {
    const wpp = root.WPP;
    if (!wpp?.isReady || typeof wpp.on !== "function" || wpp === subscribed) return;
    subscribed = wpp;
    wpp.on("chat.new_message", raw => {
      if (snapshot?.enabled) queue(mapMessage(raw));
    });
    wpp.on("chat.msg_edited", payload => {
      if (snapshot?.enabled) queue(mapMessage(payload?.msg, undefined, undefined, true));
    });
    wpp.on("chat.msg_revoke", onRevoke);
    const reconnect = online => {
      if (online === false) {
        discovery = null;
        offline = true;
      }
      tick();
    };
    wpp.on("conn.online", reconnect);
    wpp.on("conn.main_ready", reconnect);
    wpp.on("conn.logout", () => reconnect(false));
  }

  function bounded(job) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WhatsApp history timed out")), 4500);
      Promise.resolve().then(job).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  function scopeKey(state) {
    return JSON.stringify([state.since, state.backfill_from, state.excluded_chats, state.group_chats]);
  }

  async function startDiscovery(state) {
    const now = Date.now();
    const boundary = state.backfill_from || state.catch_up_from || state.since || now;
    const retentionStart = state.oldest_available || 0;
    const oldest = Math.max(state.backfill_from || state.since || 0, boundary - OVERLAP, retentionStart);
    const list = await bounded(() => root.WPP.chat.list({ ignoreGroupMetadata: true }));
    if (!Array.isArray(list)) throw new Error("WhatsApp chat list unavailable");
    const chats = [];
    for (const raw of list) {
      const id = canonicalChat(raw.id);
      if (!allowed(id, state)) continue;
      const latest = stamp(raw.t || raw.attributes?.t || raw.lastMessage?.t);
      if ((!latest && !raw.lastReceivedKey && !raw.unreadCount) || (latest && latest < oldest)) continue;
      chats.push({ id, name: raw.formattedTitle || raw.name || "", cursor: "", oldestAt: Infinity });
    }
    return { through: now, boundary, oldest, chats, index: 0, incomplete: boundary < retentionStart,
      failed: false, scope: scopeKey(state) };
  }

  async function advanceChat(scan, chat) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const options = chat.cursor
        ? { count: PAGE_SIZE, direction: "before", id: chat.cursor }
        : { count: PAGE_SIZE };
      const rawMessages = await bounded(() => root.WPP.chat.getMessages(chat.id, options));
      if (!Array.isArray(rawMessages)) throw new Error("WhatsApp messages unavailable");
      if (!rawMessages.length) return chat.oldestAt <= scan.boundary ? "complete" : "partial";
      let earliest = null;
      const rows = [];
      for (const raw of rawMessages) {
        const id = idOf(raw.id);
        const at = stamp(raw.t || raw.attributes?.t);
        if (!id || !at) continue;
        if (id !== chat.cursor && (!earliest || at < earliest.at)) earliest = { id, at };
        if (at < scan.oldest) continue;
        const row = mapMessage(raw, chat.id, chat.name);
        if (row) rows.push(row);
      }
      if (snapshot?.enabled && scopeKey(snapshot) === scan.scope && connected()) await ingest(rows);
      else throw new Error("WhatsApp discovery paused");
      if (!earliest || earliest.at > chat.oldestAt) return "partial";
      if (earliest.at <= scan.oldest) return "complete";
      if (rawMessages.length < PAGE_SIZE) return earliest.at <= scan.boundary ? "complete" : "partial";
      chat.cursor = earliest.id;
      chat.oldestAt = earliest.at;
    }
    return "more";
  }

  async function collect(state) {
    if (!state?.enabled || root.__whatrustLocked) return;
    if (!connected()) {
      offline = true;
      discovery = null;
      await ingest([], { through: state.catch_up_from || state.since || 0, partial: true, offline: true });
      return;
    }
    if (offline) {
      offline = false;
      discovery = null;
      discoveryRetryAt = 0;
    }
    if (Date.now() < discoveryRetryAt) return;
    if (!discovery || discovery.scope !== scopeKey(state)) discovery = await startDiscovery(state);
    const scan = discovery;
    const started = Date.now();
    const count = Math.min(MAX_CHATS, scan.chats.length - scan.index);
    for (let checked = 0; scan.index < scan.chats.length && checked < count && Date.now() - started < 40_000; checked++) {
      const chat = scan.chats[scan.index];
      if (discovery !== scan || !snapshot?.enabled || !connected() || scopeKey(snapshot) !== scan.scope) return;
      let step;
      try {
        step = allowed(chat.id) ? await advanceChat(scan, chat) : "complete";
      } catch {
        // Keep the shared cursor behind any failed read. Other chats can still
        // be discovered in this pass, and a later pass can retry the failure.
        scan.failed = true;
        scan.index++;
        continue;
      }
      if (step === "more") {
        scan.chats.push(scan.chats.splice(scan.index, 1)[0]);
        continue;
      }
      scan.incomplete ||= step === "partial";
      scan.index++;
    }
    if (discovery !== scan || !snapshot?.enabled || !connected() || scopeKey(snapshot) !== scan.scope) return;
    const exhausted = scan.index === scan.chats.length;
    const finished = exhausted && !scan.failed;
    await ingest([], {
      through: finished ? scan.through : (state.catch_up_from || state.since || 0),
      since: scan.boundary,
      finished,
      partial: !finished || scan.incomplete,
    });
    if (exhausted) {
      discovery = null;
      discoveryRetryAt = Date.now() + MINUTE / 2;
    }
  }

  function tick() {
    if (!tickPending) tickPending = refresh().then(async state => {
      arm();
      try {
        await collect(state);
      } catch {
        if (state?.enabled) await ingest([], { through: state.catch_up_from || state.since || 0, partial: true, offline: !connected() }).catch(() => {});
      }
    }).finally(() => { tickPending = null; });
    return tickPending;
  }

  root.__wrAttention = { mount, badge, mark, refresh };
  root.__whatrustAttentionRefresh = refresh;
  root.dispatchEvent(new Event("whatrust-attention-ready"));
  root.addEventListener("online", tick);
  root.addEventListener("offline", tick);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  setInterval(tick, MINUTE);
  const ready = () => { arm(); if (!subscribed) setTimeout(ready, 1000); };
  ready();
  tick();
})();

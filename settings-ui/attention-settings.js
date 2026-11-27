(() => {
  "use strict";
  const host = document.getElementById("attention-settings");
  const status = document.getElementById("attention-settings-status");
  const call = window.__TAURI__.core.invoke;
  const l = (en, pt) => document.documentElement.lang.startsWith("pt") ? pt : en;
  const providers = {
    openai: ["OpenAI · GPT-6 Luna", 0.10],
    gemini: ["Google · Gemini Decision 1", 0.10],
    jev: ["TypeSafe · Jev 1.14", 0.042]
  };
  const minutesPerDay = 24 * 60;
  const intervals = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440];

  function clockTime(minutes) {
    const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
    const minute = String(minutes % 60).padStart(2, "0");
    return hour + ":" + minute;
  }
  function intervalLabel(minutes) {
    if (minutes === minutesPerDay) return l("Once per active window", "Uma vez por período ativo");
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    const parts = [];
    if (hours) parts.push(hours + " " + (hours === 1 ? l("hour", "hora") : l("hours", "horas")));
    if (remainder) parts.push(remainder + " " + (remainder === 1 ? l("minute", "minuto") : l("minutes", "minutos")));
    return l("Every ", "A cada ") + parts.join(" ");
  }

  function el(tag, text, props) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    return Object.assign(element, props);
  }
  function input(type, props) { return el("input", "", { type, ...props }); }
  function select(entries) {
    const menu = el("select");
    for (const [value, label] of entries) menu.add(el("option", label, { value }));
    return menu;
  }
  function row(label, control, hint) {
    const node = el("label", "", { className: "row" });
    const title = el("span", "", { className: "row-text" });
    title.append(el("span", label, { className: "row-title" }));
    if (hint) title.append(el("span", hint, { className: "row-subtitle" }));
    node.append(title, control);
    return node;
  }
  function usd(amount) {
    return new Intl.NumberFormat(document.documentElement.lang, {
      style: "currency", currency: "USD"
    }).format(amount);
  }
  let data;
  let selected = "";
  let saving = false;
  let refreshKeyPreview;
  function render() {
    const entry = data.accounts.find(account => account.id === selected) || data.accounts[0];
    if (!entry) return;
    selected = entry.id;
    const profile = select(data.accounts.map(account => [account.id, account.name]));
    profile.value = selected;
    profile.onchange = () => { selected = profile.value; render(); };
    const enabled = input("checkbox", { checked: entry.prefs.enabled });
    const provider = select(Object.entries(providers).map(([id, [name]]) => [id, name]));
    provider.value = entry.prefs.provider;
    const schedule = entry.schedule;
    const start = input("time", { value: clockTime(schedule.start_minute), required: true });
    const end = input("time", { value: clockTime(schedule.end_minute), required: true });
    const availableIntervals = [...new Set([...intervals, schedule.interval_minutes])].sort((a, b) => a - b);
    const frequency = select(availableIntervals.map(minutes => [String(minutes), intervalLabel(minutes)]));
    frequency.value = schedule.interval_minutes;
    const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const zone = input("text", { value: entry.since || entry.prefs.schedule ? entry.prefs.time_zone : deviceZone, required: true, maxLength: 64 });
    const budget = input("number", { value: Number(data.budget_cents) / 100, min: 0, max: 1000, step: 0.01, required: true });
    const key = input("password", { autocomplete: "off", spellcheck: false, maxLength: 512 });
    const reuse = input("checkbox", { checked: entry.prefs.use_saved_gemini });
    const reuseRow = row(l("Use saved Gemini key", "Usar a chave Gemini salva"), reuse, l(
      "Use the key from Transcription when Needs Attention has no Gemini key of its own.",
      "Usa a chave da Transcrição quando Precisa de atenção não tem uma chave Gemini própria."
    ));
    const consent = input("checkbox");
    const consentRow = row(l("Allow the selected provider to process eligible messages", "Permitir que o provedor selecionado processe mensagens elegíveis"), consent);
    const providerNote = el("p", "", { className: "group-note" });
    const backfill = select([["0", l("New activity only", "Somente atividade nova")], ["1", l("Past day", "Último dia")], ["3", l("Past 3 days", "Últimos 3 dias")], ["7", l("Past 7 days", "Últimos 7 dias")]]);
    const chats = input("number", { value: 10, min: 0, max: 100000, step: 1 });
    const tokens = input("number", { value: 2000, min: 0, max: 1000000, step: 1 });
    const estimate = el("p", "", { className: "group-note" });
    const summary = el("div", "", { className: "boxed-list" });
    const form = el("form");
    const box = el("div", "", { className: "boxed-list" });
    const save = el("button", l("Save Needs Attention", "Salvar Precisa de atenção"), { type: "submit" });
    const remove = el("button", l("Remove key", "Remover chave"), { type: "button", className: "secondary" });

    function currentSchedule() {
      return {
        start_minute: start.valueAsNumber / 60000,
        end_minute: end.valueAsNumber / 60000,
        interval_minutes: Number(frequency.value)
      };
    }

    function update() {
      reuseRow.hidden = provider.value !== "gemini" || !data.saved_gemini;
      consentRow.hidden = !(enabled.checked && (!entry.prefs.enabled
        || entry.prefs.provider !== provider.value
        || entry.prefs.use_saved_gemini !== (!reuseRow.hidden && reuse.checked)));
      consent.required = !consentRow.hidden;
      backfill.disabled = !enabled.checked;
      const preview = data.providers[provider.value] || (reuse.checked && !reuseRow.hidden ? data.saved_gemini : null);
      key.placeholder = preview || l("Paste a project API key", "Cole uma chave de API do projeto");
      remove.disabled = !data.providers[provider.value];
      const notes = {
        openai: l("Eligible linked OpenAI API credits can cover Decisions usage.", "Os créditos elegíveis da API OpenAI podem cobrir o uso de Decisions."),
        gemini: l("Use a paid Gemini project for customer messages. Google can use free-tier input to improve its products.", "Use um projeto Gemini pago para mensagens de clientes. O Google pode usar os dados do plano gratuito para melhorar seus produtos."),
        jev: l("TypeSafe processes eligible excerpts using Jev 1.14.", "A TypeSafe processa os trechos elegíveis com Jev 1.14.")
      };
      providerNote.textContent = notes[provider.value];
      const current = currentSchedule();
      if (!Number.isFinite(current.start_minute) || !Number.isFinite(current.end_minute)) {
        estimate.textContent = l("Enter both times to estimate the cost.", "Informe os dois horários para estimar o custo.");
        return;
      }
      const activeMinutes = (current.end_minute + minutesPerDay - current.start_minute) % minutesPerDay || minutesPerDay;
      const checksPerDay = Math.ceil(activeMinutes / current.interval_minutes);
      const cost = 30 * checksPerDay * (chats.valueAsNumber || 0) * (tokens.valueAsNumber || 0) * providers[provider.value][1] / 1000000;
      const lookback = Number(backfill.value) * cost / 30;
      const cadence = checksPerDay === 1
        ? l("1 scheduled check per day", "1 verificação programada por dia")
        : checksPerDay + l(" scheduled checks per day", " verificações programadas por dia");
      estimate.textContent = cadence + " · " + l("Estimated 30-day gross cost", "Custo bruto estimado em 30 dias") + " " + usd(cost)
        + (lookback ? " · " + l("Lookback estimate", "Estimativa do histórico") + " " + usd(lookback) : "");
    }
    for (const node of [enabled, provider, reuse, backfill, start, end, frequency, chats, tokens]) node.oninput = update;
    provider.onchange = () => { key.value = ""; consent.checked = false; update(); };
    box.append(
      row(l("Account", "Conta"), profile),
      row(l("Enable automatic checks", "Ativar verificações automáticas"), enabled),
      row(l("Decision provider", "Provedor de decisões"), provider),
      row(l("API key", "Chave de API"), key),
      reuseRow, consentRow,
      row(l("Active from", "Ativo a partir de"), start),
      row(l("Active until", "Ativo até"), end, l(
        "An earlier end time means the next day. Matching times keep checks active all day.",
        "Um horário final mais cedo indica o dia seguinte. Horários iguais mantêm as verificações ativas o dia todo."
      )),
      row(l("Check frequency", "Frequência das verificações"), frequency),
      row(l("Time zone", "Fuso horário"), zone),
      row(l("Lookback", "Histórico"), backfill),
      row(l("Monthly device budget (USD)", "Limite mensal do dispositivo (USD)"), budget)
    );
    const actions = el("div", "", { className: "group-actions" });
    actions.append(save, remove);
    form.append(box, providerNote, actions);
    const calculator = el("div", "", { className: "boxed-list" });
    const calculatorHeading = el("h3", l("Cost calculator", "Calculadora de custo"));
    const calculatorHint = el("p", l(
      "These assumptions only change the estimate below. The monthly device budget controls spending.",
      "Essas estimativas só alteram o cálculo abaixo. O limite mensal do dispositivo controla os gastos."
    ), { className: "group-note" });
    calculator.append(
      row(l("Estimated changed chats per check", "Estimativa de conversas alteradas por verificação"), chats),
      row(l("Estimated input tokens per changed chat", "Estimativa de tokens de entrada por conversa alterada"), tokens)
    );
    const accountUsage = data.usage.filter(usage => usage.account === selected);
    for (const usage of accountUsage) {
      const description = usage.calls + " " + l("calls", "chamadas") + " · " + usage.tokens.toLocaleString() + " tokens"
        + (usage.estimated_calls ? " · " + usage.estimated_calls + " " + l("estimated calls", "chamadas estimadas") : "");
      summary.append(row(usage.provider, el("span", usd(usage.estimated_usd)), description));
    }
    host.replaceChildren(form, calculatorHeading, calculatorHint, calculator, estimate, summary);
    async function complete(work, saveForm) {
      if (saving) return;
      saving = true;
      save.disabled = remove.disabled = true;
      try {
        await work();
        data = await call("attention_settings");
        if (saveForm) {
          render();
          window.dispatchEvent(new Event("whatrust-attention-settings-saved"));
          status.textContent = l("Saved.", "Salvo.");
        } else {
          status.textContent = l("Key removed.", "Chave removida.");
        }
      } catch (error) {
        status.textContent = l("Could not save Needs Attention. Check the account, key, and time zone.", "Não foi possível salvar. Confira a conta, a chave e o fuso horário.");
      } finally { saving = false; save.disabled = false; update(); }
    }
    form.onsubmit = event => {
      event.preventDefault();
      const enteredKey = key.value.trim();
      const options = {
        enabled: enabled.checked, provider: provider.value, schedule: currentSchedule(),
        time_zone: zone.value.trim(), use_saved_gemini: !reuseRow.hidden && reuse.checked,
        consent: consent.checked, backfill_days: enabled.checked ? Number(backfill.value) : 0
      };
      const budgetCents = Math.round(budget.valueAsNumber * 100);
      complete(async () => {
        await call("attention_configure", {
          account_id: entry.id, options, budget_cents: budgetCents
        });
        if (enteredKey) await call("attention_set_key", { provider: options.provider, key: enteredKey });
      }, true);
    };
    remove.onclick = async () => {
      const selectedProvider = provider.value;
      if (!await Dlg.confirm("This provider's saved key will be deleted from this computer.", {
        title: "Remove key", okLabel: "Remove", danger: true
      })) return;
      complete(() => call("attention_set_key", { provider: selectedProvider, key: "", remove: true }));
    };
    refreshKeyPreview = update;
    update();
  }
  window.addEventListener("whatrust-ai-key-changed", ({ detail }) => {
    if (data && detail.provider === "gemini") {
      data.saved_gemini = detail.preview;
      refreshKeyPreview?.();
    }
  });
  call("attention_settings").then(value => { data = value; render(); }).catch(() => {
    status.textContent = l("Needs Attention settings could not load.", "Não foi possível carregar as configurações.");
  });
})();

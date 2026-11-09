const invoke = window.__TAURI__.core.invoke;
const LANGS = ["pt-BR", "en"];
const BOOLS = ["close_to_tray", "start_minimized", "autostart", "notifications", "hotkey_enabled", "blur_hotkey_enabled", "menu_bar_icon", "menubar_only", "hide_dock_icon", "notify_when_focused", "notify_active_chat", "respect_muted", "single_window", "auto_update_check", "auto_update_install", "voice_transcribe", "translate_enabled", "show_message_device", "standin_enabled"];
const STANDIN_BACKENDS = ["api", "claude_cli", "grok_cli", "codex_cli"];
const AI_PROVIDERS = ["openrouter", "gemini", "anthropic"];
const LIST_PROVIDERS = ["gemini", "anthropic"];
let translateModels = { openrouter: "", gemini: "", anthropic: "" };
let summaryModels = { openrouter: "", gemini: "", anthropic: "" };
let shownProvider = "openrouter";
let standinModels = { openrouter: "", gemini: "", anthropic: "" };
let standinCliModels = { claude_cli: "", grok_cli: "", codex_cli: "" };
let legacyCliModel = "";
let standinBins = { claude_cli: "", grok_cli: "", codex_cli: "" };
let standinShown = "api";
let standinCli = false;
let personaLoaded = false;
let keyFlags = { openrouter: false, gemini: false, anthropic: false };
// Successful model lists, keyed by provider. Null means not loaded yet.
let modelCatalogs = { gemini: null, anthropic: null };
// Model lists for each program, keyed by backend plus the program path that
// produced them. A new path must not reuse the previous program's list.
let cliModelCatalogs = {};
let catalogToken = 0;
let cliCatalogToken = 0;
let catalogLoading = false;
const ZOOM_DEFAULT = 1;
const SINGLE_WINDOW_SUBTITLE = "Uma janela com um seletor de contas; as contas ocultas continuam conectadas. Requer reiniciar o whatRust.";

// The menu-bar rows are macOS-only. get_settings reports the OS this build targets
// in `platform`; the rows start hidden and appear here once it is known.
function setMacRows(visible) {
  document.querySelectorAll(".mac-only").forEach((el) => (el.hidden = !visible));
}

// The "Show menu bar icon" subtitle as authored in the markup; kept so it can
// be restored when menu-bar-only is turned back off.
const MENU_ICON_SUBTITLE = "Quando desativado, clique no ícone do Dock para abrir o whatRust";

// In menu-bar-only mode the tray icon is the app's only entry point and the
// backend keeps it visible, so the switch is locked on.
let menuBarIconChecked = true;

function syncMenuBarIconRow() {
  const only = document.getElementById("menubar_only").checked || document.getElementById("hide_dock_icon").checked;
  const icon = document.getElementById("menu_bar_icon");
  icon.disabled = only;
  icon.checked = only ? true : menuBarIconChecked;
  document.getElementById("menu_bar_icon_subtitle").textContent = only
    ? "O ícone da bandeja é o único ponto de entrada no modo somente barra de menus, por isso permanece visível"
    : MENU_ICON_SUBTITLE;
}

// settings.json holds a zoom factor, not a preset name, and the zoom shortcuts
// (Ctrl +/-/wheel) land on levels the four presets do not offer. Show an exact
// match when there is one; otherwise add a temporary "NN%" option so the control
// reflects the real value instead of pretending it is the nearest preset.
function selectNearestZoom(value) {
  const sel = document.getElementById("zoom");
  for (const o of [...sel.options]) if (o.dataset.custom) o.remove();
  const exact = [...sel.options].find((o) => Math.abs(parseFloat(o.value) - value) < 0.005);
  if (exact) {
    sel.value = exact.value;
    return;
  }
  const opt = document.createElement("option");
  opt.dataset.custom = "1";
  opt.value = String(value);
  opt.textContent = Math.round(value * 100) + "%";
  const after = [...sel.options].find((o) => parseFloat(o.value) > value);
  sel.insertBefore(opt, after || null);
  sel.value = opt.value;
}

// The chosen download folder (null = the system Downloads folder). Kept here
// because save() rebuilds the whole settings object from the page.
let downloadDir = null;

function showDownloadDir() {
  const sub = document.getElementById("download_dir_subtitle");
  sub.textContent = downloadDir || "Pasta Downloads do sistema";
  sub.title = downloadDir || "";
  document.getElementById("reset_download_dir").disabled = !downloadDir;
}

function showIcon(custom) {
  document.getElementById("icon_subtitle").textContent = custom ? "Personalizado" : "Padrão";
  document.getElementById("reset_icon").disabled = !custom;
}

function flash(message, ms = 4000) {
  const note = document.getElementById("note");
  note.textContent = message;
  setTimeout(() => { if (note.textContent === message) note.textContent = ""; }, ms);
}

async function chooseDownloadDir() {
  try {
    const dir = await invoke("pick_download_dir");
    if (!dir) return;
    const previous = downloadDir;
    downloadDir = dir;
    showDownloadDir();
    // save() shows a refusal in the note; then go back to what is stored.
    if (!(await save())) {
      downloadDir = previous;
      showDownloadDir();
    }
  } catch (e) { flash(String(e)); }
}

async function resetDownloadDir() {
  downloadDir = null;
  showDownloadDir();
  await save();
}

async function chooseIcon() {
  try {
    if (await invoke("choose_app_icon")) { showIcon(true); flash("Alterações salvas ✓", 1500); }
  } catch (e) { flash(String(e), 6000); }
}

async function resetIcon() {
  try {
    await invoke("reset_app_icon");
    showIcon(false);
    flash("Alterações salvas ✓", 1500);
  } catch (e) { flash(String(e), 6000); }
}

async function load() {
  const s = await invoke("get_settings");
  setMacRows(s.platform === "macos");
  // Title bar (Linux): auto hides it on tiling window managers like Hyprland.
  document.getElementById("title_bar_row").hidden = s.platform !== "linux";
  document.getElementById("title_bar").value = ["show", "hide"].includes(s.title_bar) ? s.title_bar : "auto";
  document.getElementById("title_bar_subtitle").textContent = s.tiling_wm
    ? t("Detectado: {0}. No modo automático a barra fica oculta.", [s.tiling_wm])
    : "Gerenciadores de janelas lado a lado, como o Hyprland, não usam barra de título.";
  if (/Win/.test(navigator.platform || navigator.userAgent)) {
    const startupRow = document.getElementById("start_minimized").closest("label");
    startupRow.querySelector(".row-title").textContent = "Iniciar minimizado com o Windows";
    startupRow.querySelector(".row-subtitle").textContent = "Vale apenas ao entrar no Windows. Ao abrir pelo atalho, a janela sempre aparece.";
  }
  for (const f of BOOLS) {
    const el = document.getElementById(f);
    if (el) el.checked = !!s[f];
  }
  // Menu-bar-only needs WKWebView's inactive-scheduling policy (macOS 14+).
  // Below that the backend ignores the setting, so don't offer the switch.
  const menubarOnly = document.getElementById("menubar_only");
  menubarOnly.disabled = !s.menubar_supported;
  if (s.platform === "macos" && !s.menubar_supported) {
    menubarOnly.checked = false;
    document.getElementById("menubar_only_subtitle").textContent =
      "Requer macOS 14 (Sonoma) ou superior — este Mac não consegue manter um painel oculto conectado";
  }
  // Single-window mode (Linux/macOS): applies after a restart; menu-bar-only wins.
  const swRow = document.getElementById("single_window_row");
  swRow.hidden = !s.single_window_supported;
  const swNote = document.getElementById("single_window_subtitle");
  if (s.single_window_supported && !!s.single_window !== !!s.single_window_active) {
    swNote.textContent = s.single_window && s.menubar_only
      ? "Reinicie o whatRust para aplicar. O modo somente barra de menus tem prioridade sobre esta opção."
      : "Reinicie o whatRust para aplicar a mudança.";
  } else {
    swNote.textContent = SINGLE_WINDOW_SUBTITLE;
  }
  document.getElementById("hotkey").value = s.hotkey || "CmdOrCtrl+Shift+W";
  document.getElementById("blur_hotkey").value = s.blur_hotkey || "CmdOrCtrl+Shift+B";
  selectNearestZoom(Number.isFinite(s.zoom) ? s.zoom : ZOOM_DEFAULT);
  const lang = LANGS.includes(s.language) ? s.language : "en";
  document.getElementById("language").value = lang;
  if (I18n.lang() !== lang) I18n.setLang(lang);
  document.getElementById("fluidvoice_port").value = String(s.fluidvoice_port || 47733);
  document.getElementById("translate_target_lang").value = s.translate_target_lang || "English";
  translateModels = {
    openrouter: s.ai_model_openrouter || "",
    gemini: s.ai_model_gemini || "",
    anthropic: s.ai_model_anthropic || "",
  };
  summaryModels = {
    openrouter: s.summary_model_openrouter || translateModels.openrouter,
    gemini: s.summary_model_gemini || translateModels.gemini,
    anthropic: s.summary_model_anthropic || translateModels.anthropic,
  };
  document.getElementById("ai_provider").value = AI_PROVIDERS.includes(s.ai_provider) ? s.ai_provider : "openrouter";
  shownProvider = document.getElementById("ai_provider").value;
  standinCli = !!s.standin_cli_available;
  standinModels = {
    openrouter: s.standin_model_openrouter || "",
    gemini: s.standin_model_gemini || "",
    anthropic: s.standin_model_anthropic || "",
  };
  standinCliModels = {
    claude_cli: s.standin_model_claude || "",
    grok_cli: s.standin_model_grok || "",
    codex_cli: s.standin_model_codex || "",
  };
  standinBins = {
    claude_cli: s.standin_claude_bin || "",
    grok_cli: s.standin_grok_bin || "",
    codex_cli: s.standin_codex_bin || "",
  };
  const standinBackend = STANDIN_BACKENDS.includes(s.standin_backend) ? s.standin_backend : "api";
  legacyCliModel = s.standin_cli_model || "";
  document.getElementById("standin_backend").value = standinBackend;
  standinShown = standinBackend;
  document.getElementById("standin_delay_secs").value = String(s.standin_delay_secs || 10);
  document.getElementById("standin_hourly_limit").value = String(s.standin_hourly_limit || 12);
  syncStandinAvailability();
  showStandinFields();
  loadPersona();
  keyFlags = {
    openrouter: !!s.ai_key_openrouter,
    gemini: !!s.ai_key_gemini,
    anthropic: !!s.ai_key_anthropic,
  };
  refreshKeyState();
  syncModelControls();
  menuBarIconChecked = document.getElementById("menu_bar_icon").checked;
  syncMenuBarIconRow();
  downloadDir = s.download_dir || null;
  showDownloadDir();
  showIcon(!!s.custom_icon);
  loadProxy(s);
}

// --- Proxy (issue #52) ---
let proxyInUse = "";
let proxySupported = true;
let proxySaved = { proxy_mode: "off", proxy_host: "", proxy_port: 0 };

function proxyUrl(mode, host, port) {
  if (mode === "off") return "";
  const h = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
  return mode + "://" + h.toLowerCase() + ":" + port;
}

function syncProxyRows() {
  const off = document.getElementById("proxy_mode").value === "off";
  document.querySelectorAll(".proxy-field").forEach((el) => (el.hidden = off));
}

// The restart hint shows while the saved proxy differs from the one the open
// webviews were created with.
function syncProxyRestart() {
  const saved = proxyUrl(proxySaved.proxy_mode, proxySaved.proxy_host || "", proxySaved.proxy_port || 0);
  const running = proxyInUse.replace(/\/$/, "");
  document.getElementById("proxy_restart").hidden = saved.replace(/\/$/, "") === running;
}

function loadProxy(s) {
  proxyInUse = s.proxy_in_use || "";
  proxySupported = s.proxy_supported !== false;
  proxySaved = { proxy_mode: s.proxy_mode || "off", proxy_host: s.proxy_host || "", proxy_port: s.proxy_port || 0 };
  const mode = document.getElementById("proxy_mode");
  mode.value = proxySaved.proxy_mode;
  if (!proxySupported) {
    mode.disabled = true;
    mode.value = "off";
  }
  document.getElementById("proxy_host").value = proxySaved.proxy_host;
  document.getElementById("proxy_port").value = proxySaved.proxy_port ? String(proxySaved.proxy_port) : "";
  syncProxyRows();
  syncProxyRestart();
}

async function save() {
  const s = await invoke("get_settings");
  for (const f of BOOLS) {
    const el = document.getElementById(f);
    if (el) s[f] = el.checked;
  }
  const hk = document.getElementById("hotkey").value.trim();
  s.hotkey = hk || "CmdOrCtrl+Shift+W";
  s.blur_hotkey = document.getElementById("blur_hotkey").value.trim() || "CmdOrCtrl+Shift+B";
  s.zoom = parseFloat(document.getElementById("zoom").value) || ZOOM_DEFAULT;
  s.title_bar = document.getElementById("title_bar").value || "auto";
  s.language = document.getElementById("language").value;
  commitModelFields();
  s.fluidvoice_port = parseInt(document.getElementById("fluidvoice_port").value, 10) || 47733;
  s.translate_target_lang = document.getElementById("translate_target_lang").value.trim() || "English";
  s.ai_provider = document.getElementById("ai_provider").value;
  s.ai_model_openrouter = translateModels.openrouter;
  s.ai_model_gemini = translateModels.gemini;
  s.ai_model_anthropic = translateModels.anthropic;
  s.summary_model_openrouter = summaryModels.openrouter;
  s.summary_model_gemini = summaryModels.gemini;
  s.summary_model_anthropic = summaryModels.anthropic;
  commitStandinFields();
  s.standin_backend = document.getElementById("standin_backend").value;
  s.standin_model_openrouter = standinModels.openrouter;
  s.standin_model_gemini = standinModels.gemini;
  s.standin_model_anthropic = standinModels.anthropic;
  s.standin_model_claude = standinCliModels.claude_cli;
  s.standin_model_grok = standinCliModels.grok_cli;
  s.standin_model_codex = standinCliModels.codex_cli;
  // A leftover single model from an older settings file is only meaningful for
  // the program that was selected then. Rust already moved that case. Once a
  // program is selected here, drop the leftover so it is not applied to a
  // different program.
  if (document.getElementById("standin_backend").value === "api") {
    s.standin_cli_model = legacyCliModel;
  } else {
    s.standin_cli_model = "";
    legacyCliModel = "";
  }
  s.standin_claude_bin = standinBins.claude_cli;
  s.standin_grok_bin = standinBins.grok_cli;
  s.standin_codex_bin = standinBins.codex_cli;
  s.standin_delay_secs = parseInt(document.getElementById("standin_delay_secs").value, 10) || 10;
  s.standin_hourly_limit = parseInt(document.getElementById("standin_hourly_limit").value, 10) || 12;
  s.download_dir = downloadDir;
  if (proxySupported) {
    s.proxy_mode = document.getElementById("proxy_mode").value;
    s.proxy_host = document.getElementById("proxy_host").value.trim();
    const port = document.getElementById("proxy_port").value.trim();
    // Anything but plain digits becomes 0, which the backend rejects.
    s.proxy_port = /^[0-9]{1,5}$/.test(port) ? parseInt(port, 10) : 0;
  }
  const note = document.getElementById("note");
  try {
    if (personaLoaded) {
      await invoke("autoreply_save_persona", {
        text: document.getElementById("standin_persona").value,
      });
    }
    const warn = await invoke("set_settings", { settings: s });
    const saved = await invoke("get_settings");
    proxySaved = { proxy_mode: saved.proxy_mode, proxy_host: saved.proxy_host, proxy_port: saved.proxy_port };
    document.getElementById("proxy_host").value = saved.proxy_host;
    syncProxyRestart();
    if (warn) {
      note.textContent = t("Salvo com observação: {0}", [warn]);
      setTimeout(() => (note.textContent = ""), 6000);
    } else {
      note.textContent = "Alterações salvas ✓";
      setTimeout(() => (note.textContent = ""), 1500);
    }
    return true;
  } catch (e) {
    note.textContent = String(e);
    return false;
  }
}

// --- Accounts ---
let accountsBusy = false;

async function accountAction(action) {
  if (accountsBusy) return;
  accountsBusy = true;
  document.querySelectorAll('#accounts-list button, .add-row input, .add-row button, #startup_account')
    .forEach(el => { el.disabled = true; });
  const note = document.getElementById('accounts-note');
  note.textContent = 'Aguarde…';
  try {
    await action();
    note.textContent = '';
  } catch (error) {
    note.textContent = String(error);
  } finally {
    accountsBusy = false;
    document.getElementById('new_account_name').disabled = false;
    document.getElementById('add_account').disabled = false;
    document.getElementById('startup_account').disabled = false;
    await loadAccounts();
  }
}

function accountMenu(a, accounts, anchor) {
  const previous=document.getElementById("account-actions");if(previous){if(previous.dataset.open==="true")previous.hidePopover();previous.remove();}
  const menu = document.createElement("div"); menu.id="account-actions";menu.className="account-actions";
  const nativePopover=typeof menu.showPopover==="function";
  if(nativePopover)menu.setAttribute("popover", "auto");
  else {menu.style.position="fixed";menu.style.zIndex="9999";menu.showPopover=()=>{menu.style.display="block";menu.dataset.open="true";};menu.hidePopover=()=>{menu.style.display="none";menu.dataset.open="false";anchor.focus({preventScroll:true});};}menu.setAttribute("role", "menu");menu.setAttribute("aria-label", t("Ações de {0}", [a.name]));
  const actions = [
    ["Abrir conta", () => accountAction(() => invoke("open_account", {id:a.id}))],
    ...( /Win/.test(navigator.platform || navigator.userAgent) ? [[a.detached ? "Reintegrar à janela" : "Abrir em janela separada", () => accountAction(() => invoke(a.detached?"attach_account":"detach_account",{id:a.id}))]] : []),
    ["Usar ao iniciar",()=>accountAction(()=>invoke("set_default_account",{id:a.id}))],
    ["Renomear",async()=>{const name=await Dlg.prompt("",{title:"Renomear conta",value:a.name,okLabel:"Renomear",requiredMessage:"Informe um nome."});if(name!==null&&name!==a.name)await accountAction(()=>invoke("rename_account",{id:a.id,name}));}],
  ];
  const index=accounts.findIndex(x=>x.id===a.id);
  for(const [delta,label] of [[-1,"Mover para cima"],[1,"Mover para baixo"]]) {
    if(index+delta<0||index+delta>=accounts.length)continue;
    actions.push([label,()=>accountAction(()=>{const ids=accounts.map(x=>x.id);[ids[index],ids[index+delta]]=[ids[index+delta],ids[index]];return invoke("reorder_accounts",{ids});})]);
  }
  if(accounts.length>1)actions.push(["Remover conta",async()=>{if(await Dlg.confirm("A sessão local desta conta será apagada. Para usá-la novamente, você precisará ler o QR code.",{title:t('Remover "{0}"?',[a.name]),okLabel:"Remover",danger:true}))await accountAction(()=>invoke("remove_account",{id:a.id}));}]);
  for(const [label,action] of actions){const button=document.createElement("button");button.type="button";button.textContent=label;button.setAttribute("role","menuitem");if(label==="Remover conta")button.className="danger";button.onclick=()=>{menu.hidePopover();menu.dataset.open="false";action();};menu.appendChild(button);}
  const lifecycle=new AbortController();
  const originalHide=menu.hidePopover.bind(menu);
  function afterClose(){menu.dataset.open="false";anchor.setAttribute("aria-expanded","false");lifecycle.abort();if(anchor.isConnected&&!document.querySelector('.dlg-backdrop,.account-actions[data-open="true"]'))anchor.focus({preventScroll:true});}
  menu.hidePopover=()=>{originalHide();afterClose();};
  function place(){
    const r=anchor.getBoundingClientRect(),m=menu.getBoundingClientRect(),padding=12,gap=6;
    const pane=document.querySelector('.prefs').getBoundingClientRect();
    if(!anchor.isConnected||r.bottom<pane.top||r.top>pane.bottom){menu.hidePopover();return;}
    const below=Math.max(0,innerHeight-padding-r.bottom-gap),above=Math.max(0,r.top-gap-padding),natural=menu.scrollHeight+2;
    const down=below>=natural||below>=above;
    menu.style.maxHeight=Math.max(40,Math.min(innerHeight-24,down?below:above))+"px";
    const height=menu.getBoundingClientRect().height;
    const top=down?r.bottom+gap:r.top-height-gap;
    menu.style.left=Math.max(padding,Math.min(r.right-m.width,innerWidth-m.width-padding))+"px";
    menu.style.top=Math.max(padding,Math.min(top,innerHeight-height-padding))+"px";
  }
  menu.addEventListener("toggle",e=>{menu.dataset.open=String(e.newState==="open");anchor.setAttribute("aria-expanded",String(e.newState==="open"));if(e.newState==="closed")afterClose();});
  menu.addEventListener("keydown",e=>{
    if(e.key==="Escape"){e.preventDefault();menu.hidePopover();return;}
    const buttons=[...menu.querySelectorAll("button")],at=buttons.indexOf(document.activeElement);
    if(["ArrowDown","ArrowUp","Home","End"].includes(e.key)){e.preventDefault();const next=e.key==="Home"?0:e.key==="End"?buttons.length-1:(at+(e.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length;buttons[next].focus();}
  });
  window.addEventListener("resize",place,{signal:lifecycle.signal});
  document.addEventListener("scroll",place,{capture:true,signal:lifecycle.signal});
  if(!nativePopover)document.addEventListener("pointerdown",e=>{if(!menu.contains(e.target)&&!anchor.contains(e.target))menu.hidePopover();},{signal:lifecycle.signal});
  document.body.appendChild(menu);menu.showPopover();menu.dataset.open="true";anchor.setAttribute("aria-expanded","true");place();menu.querySelector("button").focus();

}
function renderAccounts(accounts) {
  const list=document.getElementById("accounts-list"),startup=document.getElementById("startup_account");
  if(document.getElementById("account-actions")?.dataset.open==="true")return;
  list.replaceChildren();startup.replaceChildren();
  for(const a of accounts){
    const option=document.createElement("option");option.value=a.id;option.textContent=a.name;option.selected=a.is_default;startup.appendChild(option);
    const row=document.createElement("div");row.className="account-row";
    const avatar=document.createElement("span");avatar.className="account-avatar";avatar.setAttribute("aria-hidden","true");avatar.textContent=a.name.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase();
    const open=document.createElement("button");open.type="button";open.className="account-open";open.setAttribute("aria-label",t("Abrir {0}",[a.name]));
    const name=document.createElement("span");name.className="acct-name";name.textContent=a.name;
    const info=document.createElement("span");info.className="acct-subtitle";info.textContent=a.detached?"Em janela separada":a.is_default?"Conta ao iniciar":"WhatsApp";open.append(name,info);open.onclick=()=>accountAction(()=>invoke("open_account",{id:a.id}));
    row.append(avatar,open);
    if(a.unread){const badge=document.createElement("span");badge.className="acct-unread";badge.textContent=a.unread;badge.title=t("{0} conversas não lidas",[a.unread]);row.appendChild(badge);}
    const more=document.createElement("button");more.type="button";more.className="account-more";more.textContent="⋮";more.setAttribute("aria-label",t("Opções de {0}",[a.name]));more.setAttribute("aria-haspopup","menu");more.onclick=()=>accountMenu(a,accounts,more);row.appendChild(more);list.appendChild(row);
  }
}

async function loadAccounts() {
  try {
    const accounts = await invoke("list_accounts");
    renderAccounts(accounts);
  } catch (e) {
    document.getElementById('accounts-note').textContent = t('Não foi possível carregar as contas: {0}', [String(e)]);
  }
}

async function addAccount() {
  const input = document.getElementById("new_account_name");
  const name = input.value.trim();
  if (!name || accountsBusy) return;
  await accountAction(async () => {
    await invoke("add_account", { name });
    input.value = "";
  });
}

window.addEventListener("DOMContentLoaded", () => {
  // The macOS rows stay hidden until load() knows the platform.
  document.getElementById("menubar_only").addEventListener("change", syncMenuBarIconRow);
  document.getElementById("hide_dock_icon").addEventListener("change", syncMenuBarIconRow);
  load();
  loadAccounts();
  loadLock();
  wireLock();
  document.getElementById("save").addEventListener("click", save);
  // Fork: update switches are commented out of the settings page.
  // The update switches apply at once, like zoom and language.
  // for (const id of ["auto_update_check", "auto_update_install"]) {
  //   document.getElementById(id).addEventListener("change", save);
  // }
  document.getElementById("proxy_mode").addEventListener("change", syncProxyRows);
  document.getElementById("proxy_restart_btn").addEventListener("click", async () => {
    try {
      await invoke("restart_app");
    } catch (e) {
      document.getElementById("note").textContent = String(e);
    }
  });
  document.getElementById("add_account").addEventListener("click", addAccount);
  document.getElementById('startup_account').addEventListener('change', event => {
    const id = event.target.value;
    accountAction(() => invoke('set_default_account', { id }));
  });
  document.getElementById("new_account_name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addAccount();
  });
  document.getElementById("record_hotkey").addEventListener("click", () => toggleRecording("hotkey", "record_hotkey"));
  document.getElementById("record_blur_hotkey").addEventListener("click", () => toggleRecording("blur_hotkey", "record_blur_hotkey"));
  document.getElementById("choose_download_dir").addEventListener("click", chooseDownloadDir);
  document.getElementById("reset_download_dir").addEventListener("click", resetDownloadDir);
  document.getElementById("choose_icon").addEventListener("click", chooseIcon);
  document.getElementById("reset_icon").addEventListener("click", resetIcon);
  // Zoom saves on change rather than on Save: picking a size you cannot see the
  // effect of is guesswork, and the webview applies it immediately.
  document.getElementById("zoom").addEventListener("change", save);
  document.getElementById("title_bar").addEventListener("change", save);
  // The zoom shortcuts change it from the WhatsApp window; catch up on return.
  window.addEventListener("focus", () => {
    invoke("get_settings").then((s) => {
      if (Number.isFinite(s.zoom)) selectNearestZoom(s.zoom);
    }).catch(() => {});
  });
  // Language applies at once, like zoom.
  document.getElementById("language").addEventListener("change", async () => {
    I18n.setLang(document.getElementById("language").value);
    await save();
  });
  document.getElementById("ai_provider").addEventListener("change", () => {
    commitStandinFields();
    commitModelFields();
    shownProvider = document.getElementById("ai_provider").value;
    refreshKeyState();
    syncModelControls();
    showStandinFields();
  });
  document.getElementById("standin_backend").addEventListener("change", () => {
    commitStandinFields();
    syncStandinAvailability();
    showStandinFields();
    // The old program's result would otherwise be read as this one's.
    document.getElementById("standin_cli_state").textContent = "Not checked yet.";
  });
  document.getElementById("save_persona").addEventListener("click", savePersona);
  document.getElementById("open_persona").addEventListener("click", () => {
    invoke("autoreply_open_persona").catch((e) => {
      document.getElementById("note").textContent = errorText(e);
    });
  });
  document.getElementById("reset_persona").addEventListener("click", resetPersona);
  document.getElementById("check_standin_cli").addEventListener("click", checkStandinCli);
  for (const id of ["translate_model", "summary_model"]) {
    document.getElementById(id).addEventListener("input", commitModelFields);
  }
  for (const id of ["translate_model_select", "summary_model_select"]) {
    document.getElementById(id).addEventListener("change", commitModelFields);
  }
  document.getElementById("standin_model").addEventListener("input", commitStandinFields);
  document.getElementById("standin_model_select").addEventListener("change", commitStandinFields);
  document.getElementById("standin_bin").addEventListener("change", () => {
    commitStandinFields();
    if (standinShown === "api") return;
    // The path selects which installed program, so the list has to be read again.
    fillCliModelSelect(standinShown);
    loadCliModelCatalog(standinShown);
  });
  document.getElementById("test_fluidvoice").addEventListener("click", testFluidVoice);
  document.getElementById("save_ai_key").addEventListener("click", saveAiKey);
  document.getElementById("remove_ai_key").addEventListener("click", removeAiKey);
  document.getElementById("ai_key").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveAiKey();
  });
});

function standinUsesList() {
  return standinShown !== "api" || usesModelList(shownProvider);
}

function commitStandinFields() {
  const bin = document.getElementById("standin_bin").value.trim();
  if (standinShown !== "api") standinBins[standinShown] = bin;
  if (!standinUsesList()) {
    standinModels[shownProvider] = document.getElementById("standin_model").value.trim();
    return;
  }
  const select = document.getElementById("standin_model_select");
  // A disabled list is still loading, so keep the saved id.
  if (select.hidden || select.disabled) return;
  const model = select.value.trim();
  if (standinShown === "api") standinModels[shownProvider] = model;
  else standinCliModels[standinShown] = model;
}

function showStandinFields() {
  const backend = document.getElementById("standin_backend").value;
  const cli = backend !== "api";
  const listed = cli || usesModelList(shownProvider);
  const input = document.getElementById("standin_model");
  const select = document.getElementById("standin_model_select");
  input.hidden = listed;
  select.hidden = !listed;
  if (cli) fillCliModelSelect(backend);
  else if (listed) fillStandinModelSelect();
  else input.value = standinModels[shownProvider] || "";
  document.getElementById("standin_bin").closest("label").hidden = !cli;
  document.getElementById("standin_bin").value = cli ? (standinBins[backend] || "") : "";
  document.getElementById("check_standin_cli").disabled = !cli || !standinCli;
  document.getElementById("standin_session_row").hidden = !cli;
  standinShown = backend;
  if (cli) loadCliModelCatalog(backend);
}

function syncStandinAvailability() {
  const select = document.getElementById("standin_backend");
  for (const opt of select.options) {
    if (opt.value !== "api") opt.disabled = !standinCli;
  }
  if (!standinCli && select.value !== "api") select.value = "api";
  if (!standinCli) {
    document.getElementById("standin_backend_hint").textContent =
      "In this install, only the API key is available.";
  }
}

async function loadPersona() {
  try {
    const text = await invoke("autoreply_get_persona");
    personaLoaded = true;
    document.getElementById("standin_persona").value = text || "";
  } catch (e) {}
}

async function savePersona() {
  const note = document.getElementById("note");
  try {
    await invoke("autoreply_save_persona", {
      text: document.getElementById("standin_persona").value,
    });
    note.textContent = "Saved ✓";
    setTimeout(() => (note.textContent = ""), 1500);
  } catch (e) {
    note.textContent = errorText(e);
  }
}

async function resetPersona() {
  try {
    const text = await invoke("autoreply_reset_persona");
    personaLoaded = true;
    document.getElementById("standin_persona").value = text || "";
  } catch (e) {
    document.getElementById("note").textContent = errorText(e);
  }
}

async function checkStandinCli() {
  const status = document.getElementById("standin_cli_state");
  status.textContent = "Checking…";
  await save();
  try {
    const result = await invoke("standin_cli_status");
    status.textContent = result && result.detail ? result.detail : "";
  } catch (e) {
    status.textContent = errorText(e);
  }
}

function usesModelList(provider) {
  return LIST_PROVIDERS.includes(provider);
}

function commitModelFields() {
  if (usesModelList(shownProvider)) {
    const translate = document.getElementById("translate_model_select").value.trim();
    const summary = document.getElementById("summary_model_select").value.trim();
    if (translate) translateModels[shownProvider] = translate;
    if (summary) summaryModels[shownProvider] = summary;
    return;
  }
  translateModels[shownProvider] = document.getElementById("translate_model").value.trim();
  summaryModels[shownProvider] = document.getElementById("summary_model").value.trim();
}

function syncModelControls() {
  const listed = usesModelList(shownProvider);
  document.getElementById("translate_model").hidden = listed;
  document.getElementById("summary_model").hidden = listed;
  document.getElementById("translate_model_select").hidden = !listed;
  document.getElementById("summary_model_select").hidden = !listed;
  if (!listed) {
    catalogToken += 1;
    catalogLoading = false;
    document.getElementById("translate_model").value = translateModels[shownProvider] || "";
    document.getElementById("summary_model").value = summaryModels[shownProvider] || "";
    document.getElementById("translate_model_hint").textContent = "Nome do modelo aceito por esse provedor.";
    return;
  }
  renderModelSelects();
  loadModelCatalog(shownProvider);
}

function renderModelSelects() {
  const models = modelCatalogs[shownProvider] || [];
  fillModelSelect("translate_model_select", translateModels[shownProvider], models);
  fillModelSelect("summary_model_select", summaryModels[shownProvider], models);
  if (document.getElementById("standin_backend").value === "api") fillStandinModelSelect();
}

function fillStandinModelSelect() {
  fillModelSelect(
    "standin_model_select",
    standinModels[shownProvider],
    modelCatalogs[shownProvider] || [],
    { id: "", label: "Same as the summary model" },
    true,
  );
}

function cliCatalogKey(backend) {
  return backend + "\n" + (standinBins[backend] || "");
}

function fillCliModelSelect(backend) {
  const loaded = cliModelCatalogs[cliCatalogKey(backend)];
  fillModelSelect(
    "standin_model_select",
    standinCliModels[backend],
    loaded || [],
    { id: "", label: "Program default" },
    false,
  );
  if (!loaded) document.getElementById("standin_model_select").disabled = true;
}

function fillModelSelect(id, saved, models, leading, requiresKey) {
  const select = document.getElementById(id);
  const options = models
    .filter((model) => model && model.id)
    .map((model) => ({ id: model.id, label: model.label || model.id }));
  if (saved && !options.some((model) => model.id === saved)) {
    options.unshift({ id: saved, label: saved });
  }
  const choices = leading ? [leading, ...options] : options;
  select.replaceChildren();
  for (const model of choices) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    if (model.id) option.title = model.id;
    select.appendChild(option);
  }
  select.value = saved || (leading ? leading.id : "");
  const needsKey = requiresKey !== false;
  select.disabled = (needsKey && (catalogLoading || !keyFlags[shownProvider])) || options.length === 0;
}

async function loadCliModelCatalog(backend) {
  const key = cliCatalogKey(backend);
  if (cliModelCatalogs[key]) return;
  const token = ++cliCatalogToken;
  const bin = standinBins[backend] || "";
  document.getElementById("standin_model_select").disabled = true;
  try {
    const models = await invoke("list_standin_cli_models", { backend, bin });
    if (token !== cliCatalogToken) return;
    // An empty answer is not cached, so the next visit can try again.
    if (Array.isArray(models) && models.length) cliModelCatalogs[key] = models;
  } catch (e) {
    if (token !== cliCatalogToken) return;
  }
  if (document.getElementById("standin_backend").value === backend) fillCliModelSelect(backend);
}

async function loadModelCatalog(provider) {
  const hint = document.getElementById("translate_model_hint");
  if (!keyFlags[provider]) {
    catalogLoading = false;
    hint.textContent = "Guarde a chave da API para listar os modelos.";
    renderModelSelects();
    return;
  }
  if (modelCatalogs[provider]) {
    catalogLoading = false;
    hint.textContent = modelCatalogs[provider].length
      ? "Modelos principais disponíveis para esta chave."
      : "Nenhum modelo principal disponível para esta chave.";
    renderModelSelects();
    return;
  }
  const token = ++catalogToken;
  catalogLoading = true;
  hint.textContent = "Carregando modelos…";
  document.getElementById("translate_model_select").disabled = true;
  document.getElementById("summary_model_select").disabled = true;
  if (document.getElementById("standin_backend").value === "api") {
    document.getElementById("standin_model_select").disabled = true;
  }
  try {
    const models = await invoke("list_ai_models", { provider });
    if (token !== catalogToken || shownProvider !== provider) return;
    modelCatalogs[provider] = Array.isArray(models) ? models : [];
    hint.textContent = modelCatalogs[provider].length
      ? "Modelos principais disponíveis para esta chave."
      : "Nenhum modelo principal disponível para esta chave.";
  } catch (e) {
    if (token !== catalogToken || shownProvider !== provider) return;
    const message = errorText(e);
    hint.textContent = message;
    setKeyStatus(message, "bad");
  }
  if (token !== catalogToken || shownProvider !== provider) return;
  catalogLoading = false;
  renderModelSelects();
}

function errorText(error) {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  return String(error);
}

function setKeyStatus(text, tone) {
  const el = document.getElementById("ai_key_state");
  el.textContent = text;
  el.className = "key-status" + (tone && tone !== "ok" ? " " + tone : "");
}

function refreshKeyState() {
  const on = keyFlags[document.getElementById("ai_provider").value];
  setKeyStatus(on ? "Chave guardada neste Mac." : "Nenhuma chave guardada.", "ok");
}

async function testFluidVoice() {
  const status = document.getElementById("fluidvoice_status");
  status.textContent = "Verificando…";
  try {
    const port = parseInt(document.getElementById("fluidvoice_port").value, 10) || 47733;
    const result = await invoke("fluidvoice_status", { port });
    status.textContent = result.ok && result.version
      ? result.detail + " (" + result.version + ")"
      : result.detail;
  } catch (e) {
    status.textContent = String(e);
  }
}

async function saveAiKey() {
  const provider = document.getElementById("ai_provider").value;
  const input = document.getElementById("ai_key");
  const key = input.value.trim();
  const button = document.getElementById("save_ai_key");
  if (!key) {
    setKeyStatus("Digite a chave da API.", "warn");
    return;
  }
  button.disabled = true;
  // Drop a list request already in flight. Leaving catalogLoading set would
  // keep every model menu disabled after this check finishes.
  catalogToken += 1;
  catalogLoading = false;
  setKeyStatus("Verificando a chave…", "ok");
  try {
    const result = await invoke("set_ai_key", { provider, key, remove: false });
    keyFlags[provider] = !!result.stored;
    if (result.accepted) input.value = "";
    if (result.accepted && usesModelList(provider)) {
      modelCatalogs[provider] = Array.isArray(result.models) ? result.models : [];
    }
    if (document.getElementById("ai_provider").value === provider) {
      setKeyStatus(result.detail || "", result.tone || "ok");
      syncModelControls();
    }
  } catch (e) {
    catalogLoading = false;
    if (document.getElementById("ai_provider").value === provider) {
      setKeyStatus(errorText(e), "bad");
      if (usesModelList(provider)) renderModelSelects();
    }
  } finally {
    button.disabled = false;
  }
}

async function removeAiKey() {
  const provider = document.getElementById("ai_provider").value;
  if (!keyFlags[provider]) {
    setKeyStatus("Nenhuma chave guardada.", "ok");
    return;
  }
  if (!await Dlg.confirm("A chave guardada deste provedor será apagada deste Mac.", {
    title: "Remover chave",
    okLabel: "Remover",
    danger: true,
  })) return;
  try {
    const result = await invoke("set_ai_key", { provider, key: "", remove: true });
    keyFlags[provider] = false;
    modelCatalogs[provider] = null;
    setKeyStatus(result.detail || "A chave deste provedor foi removida deste Mac.", "ok");
    if (provider === shownProvider) syncModelControls();
  } catch (e) {
    setKeyStatus(errorText(e), "bad");
  }
}

// --- App lock ---

async function loadLock() {
  let s;
  try {
    s = await invoke("get_lock_status");
  } catch (e) {
    return;
  }
  const disabled = document.getElementById("lock-disabled");
  const enabled = document.getElementById("lock-enabled");
  disabled.hidden = s.enabled;
  enabled.hidden = !s.enabled;

  if (s.enabled) {
    const row = document.getElementById("biometric_row");
    row.hidden = !s.biometric_available;
    document.getElementById("biometric_label").textContent = t("Usar {0}", [s.biometric_label]);
    document.getElementById("biometric_enabled").checked = s.biometric_enabled;
    document.getElementById("lock_on_launch").checked = s.lock_on_launch;
    document.getElementById("lock_on_hide").checked = s.lock_on_hide;
    document.getElementById("idle_min").value = String(Math.round(s.idle_secs / 60));
  }
}

async function saveLockOptions() {
  const idleMin = parseInt(document.getElementById("idle_min").value, 10) || 0;
  await invoke("set_app_lock_options", {
    lockOnLaunch: document.getElementById("lock_on_launch").checked,
    lockOnHide: document.getElementById("lock_on_hide").checked,
    idleSecs: Math.max(0, idleMin) * 60,
  });
}

function wireLock() {
  document.getElementById("enable_lock").addEventListener("click", async () => {
    const a = document.getElementById("lock_pw1").value;
    const b = document.getElementById("lock_pw2").value;
    try {
      await invoke("set_app_lock_password", { new: a, confirm: b });
      document.getElementById("lock_pw1").value = "";
      document.getElementById("lock_pw2").value = "";
      await loadLock();
    } catch (e) { await Dlg.alert(String(e), { title: "Não foi possível ativar o bloqueio" }); }
  });

  document.getElementById("lock_now").addEventListener("click", async () => {
    try { await invoke("lock_app"); } catch (e) { await Dlg.alert(String(e), { title: "Não foi possível bloquear" }); }
  });

  document.getElementById("change_pw").addEventListener("click", async () => {
    const current = await Dlg.prompt("", {
      title: "Senha atual",
      password: true,
      okLabel: "Continuar",
      requiredMessage: "Informe sua senha atual.",
    });
    if (current === null) return;
    const next = await Dlg.prompt("Pelo menos 6 caracteres.", {
      title: "Nova senha",
      password: true,
      okLabel: "Alterar",
      requiredMessage: "Informe uma nova senha.",
    });
    if (next === null) return;
    try {
      await invoke("change_app_lock_password", { current, new: next, confirm: next });
      await Dlg.alert("Sua senha de bloqueio foi alterada.", { title: "Senha alterada" });
    } catch (e) { await Dlg.alert(String(e), { title: "Não foi possível alterar a senha" }); }
  });

  document.getElementById("disable_lock").addEventListener("click", async () => {
    const current = await Dlg.prompt("Informe sua senha atual para desativar o bloqueio.", {
      title: "Desativar bloqueio",
      password: true,
      okLabel: "Desativar",
      danger: true,
      requiredMessage: "Informe sua senha atual.",
    });
    if (current === null) return;
    try {
      await invoke("disable_app_lock", { current });
      await loadLock();
    } catch (e) { await Dlg.alert(String(e), { title: "Não foi possível desativar o bloqueio" }); }
  });

  document.getElementById("biometric_enabled").addEventListener("change", async (e) => {
    try {
      await invoke("set_biometric_enabled", { enabled: e.target.checked });
    } catch (err) {
      e.target.checked = !e.target.checked; // revert on failure
      await Dlg.alert(String(err), { title: "Não foi possível alterar a biometria" });
    }
    await loadLock();
  });

  const reportLockOptionFailure = (e) => Dlg.alert(String(e), { title: "Não foi possível salvar" });
  for (const id of ["lock_on_launch", "lock_on_hide"]) {
    document.getElementById(id).addEventListener("change", () => saveLockOptions().catch(reportLockOptionFailure));
  }
  document.getElementById("idle_min").addEventListener("change", () => saveLockOptions().catch(reportLockOptionFailure));
}

// --- Shortcut recorder ---

let recordingHotkey = false;
let hotkeyPrev = "";
let recordInputId = "hotkey";
let recordBtnId = "record_hotkey";
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function setHotkeyHint(msg) {
  const hint = document.getElementById("hotkey_hint");
  if (!msg) { hint.hidden = true; hint.textContent = ""; }
  else { hint.textContent = msg; hint.hidden = false; }
}

function stopRecording(restore) {
  if (!recordingHotkey) return;
  recordingHotkey = false;
  window.removeEventListener("keydown", onRecordKeydown, true);
  window.removeEventListener("blur", onRecordBlur, true);
  const btn = document.getElementById(recordBtnId);
  btn.textContent = "Gravar";
  btn.classList.remove("recording");
  if (restore) document.getElementById(recordInputId).value = hotkeyPrev;
}

function onRecordBlur() { setHotkeyHint(""); stopRecording(true); }

function onRecordKeydown(e) {
  e.preventDefault();
  e.stopPropagation();
  if (MODIFIER_KEYS.has(e.key)) return;            // ignore bare modifiers
  if (e.key === "Escape") { setHotkeyHint(""); stopRecording(true); return; }
  const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
  const accel = window.HotkeyFmt.comboToAccelerator(mods, e.code);
  if (accel === null) { setHotkeyHint("Tecla não suportada. Tente outra."); return; }
  if (!window.HotkeyFmt.isValidCombo(mods, e.code)) {
    setHotkeyHint("Inclua Ctrl, Alt ou Shift.");
    return;
  }
  document.getElementById(recordInputId).value = accel;
  setHotkeyHint("");
  stopRecording(false);
}

function toggleRecording(inputId, btnId) {
  if (recordingHotkey) { setHotkeyHint(""); stopRecording(true); return; }
  recordingHotkey = true;
  recordInputId = inputId;
  recordBtnId = btnId;
  hotkeyPrev = document.getElementById(inputId).value;
  const btn = document.getElementById(btnId);
  btn.textContent = "Pressione as teclas… (Esc cancela)";
  btn.classList.add("recording");
  setHotkeyHint("");
  window.addEventListener("keydown", onRecordKeydown, true);
  window.addEventListener("blur", onRecordBlur, true);
}

const invoke = window.__TAURI__.core.invoke;
const LANGS = ["pt-BR", "en"];
const BOOLS = ["close_to_tray", "start_minimized", "autostart", "notifications", "hotkey_enabled", "blur_hotkey_enabled", "menu_bar_icon", "menubar_only", "hide_dock_icon", "notify_when_focused", "notify_active_chat", "respect_muted", "single_window", "auto_update_check", "auto_update_install", "voice_transcribe", "video_transcribe", "translate_enabled", "show_message_device", "standin_enabled", "hide_app_banner"];
const AI_PROVIDERS = ["openrouter", "gemini", "anthropic"];
const TEXT_CLI_PROVIDERS = ["claude_cli", "codex_cli", "antigravity_cli"];
const STANDIN_CLI_PROVIDERS = [...TEXT_CLI_PROVIDERS, "grok_cli"];
const STANDIN_BACKENDS = ["api", ...STANDIN_CLI_PROVIDERS, "hermes", "grok_bot"];
const LIST_PROVIDERS = ["gemini", "anthropic"];
let translateModels = { openrouter: "", gemini: "", anthropic: "" };
let summaryModels = { openrouter: "", gemini: "", anthropic: "" };
let shownProvider = "openrouter";
let shownCli = "";
let standinModels = { openrouter: "", gemini: "", anthropic: "" };
let standinCliModels = {};
let legacyCliModel = "";
let standinBins = {};
let standinShown = "api";
let standinCli = false;
let personaLoaded = false;
let keyFlags = { openrouter: false, gemini: false, anthropic: false };
// Successful model lists, keyed by provider. Null means not loaded yet.
let modelCatalogs = { gemini: null, anthropic: null };
// Model lists for each program, keyed by backend plus the program path that
// produced them. A new path must not reuse the previous program's list.
let cliModelCatalogs = {};
const cliCatalogRequests = new Set();
let catalogToken = 0;
let catalogLoading = false;
const ZOOM_DEFAULT = 1;
const SINGLE_WINDOW_SUBTITLE = "One window with an account switcher. An account loads only when you open it, and opening another does not close the first. Requires restarting whatRust.";

// The menu-bar rows are macOS-only. get_settings reports the OS this build targets
// in `platform`; the rows start hidden and appear here once it is known.
function setMacRows(visible) {
  document.querySelectorAll(".mac-only").forEach((el) => (el.hidden = !visible));
}

// The "Show menu bar icon" subtitle as authored in the markup; kept so it can
// be restored when menu-bar-only is turned back off.
const MENU_ICON_SUBTITLE = "When off, click the Dock icon to open whatRust";

// In menu-bar-only mode the tray icon is the app's only entry point and the
// backend keeps it visible, so the switch is locked on.
let menuBarIconChecked = true;

function syncMenuBarIconRow() {
  const only = document.getElementById("menubar_only").checked || document.getElementById("hide_dock_icon").checked;
  const icon = document.getElementById("menu_bar_icon");
  icon.disabled = only;
  icon.checked = only ? true : menuBarIconChecked;
  document.getElementById("menu_bar_icon_subtitle").textContent = only
    ? "The tray icon is the only entry point in menu-bar-only mode, so it stays visible"
    : MENU_ICON_SUBTITLE;
}

// One account's mention switches. Delivery stays enabled only while a type is
// on. The sound file and the built-in chime belong to the selected account.
const MENTION_TYPES = ["mention_mentions", "mention_replies", "mention_direct", "mention_everyone"];

function readMentionForm() {
  return window.mentionAlertForm.normalizePrefs({
    mentions: document.getElementById("mention_mentions").checked,
    replies: document.getElementById("mention_replies").checked,
    direct: document.getElementById("mention_direct").checked,
    everyone: document.getElementById("mention_everyone").checked,
    sound: document.getElementById("mention_alert_sound").checked,
    popup: document.getElementById("mention_alert_popup").checked,
    sound_file: mentionSoundFile,
  });
}

function applyMentionChrome(view) {
  const sound = document.getElementById("mention_alert_sound");
  const popup = document.getElementById("mention_alert_popup");
  sound.disabled = !view.soundEnabled;
  popup.disabled = !view.popupEnabled;
  const idle = document.getElementById("mention_alert_idle");
  idle.hidden = !view.idle && !view.typesOff;
  idle.textContent = view.typesOff
    ? "With every type off, this alert does nothing."
    : "With the sound and the popup off, this alert does nothing.";
  document.getElementById("mention_alert_sound_file_row").hidden = !view.fileVisible;
  const soundOn = sound.checked && !sound.disabled;
  document.getElementById("choose_mention_sound").disabled = !soundOn;
  document.getElementById("preview_mention_sound").disabled = !soundOn;
  document.getElementById("reset_mention_sound").disabled = !soundOn || !mentionSoundFile;
  showMentionSound();
}

function writeMentionForm(prefs) {
  const view = window.mentionAlertForm.viewMentionAccount(prefs);
  document.getElementById("mention_mentions").checked = view.prefs.mentions;
  document.getElementById("mention_replies").checked = view.prefs.replies;
  document.getElementById("mention_direct").checked = view.prefs.direct;
  document.getElementById("mention_everyone").checked = view.prefs.everyone;
  document.getElementById("mention_alert_sound").checked = view.prefs.sound;
  document.getElementById("mention_alert_popup").checked = view.prefs.popup;
  mentionSoundFile = view.prefs.sound_file;
  applyMentionChrome(view);
}

function stashMentionForm() {
  if (!mentionAccountId) return;
  mentionAccounts[mentionAccountId] = readMentionForm();
}

function pruneMentionAccounts() {
  if (!mentionAccountList.length) return;
  const ids = new Set(mentionAccountList.map((account) => account.id));
  for (const id of Object.keys(mentionAccounts)) {
    if (!ids.has(id)) delete mentionAccounts[id];
  }
}

function prefsForMention(id) {
  if (mentionAccounts[id]) return mentionAccounts[id];
  if (mentionLegacy) return window.mentionAlertForm.normalizePrefs(mentionLegacy);
  return window.mentionAlertForm.blankPrefs();
}

function syncMentionAlert() {
  stashMentionForm();
  applyMentionChrome(window.mentionAlertForm.viewMentionAccount(readMentionForm()));
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
let mentionSoundFile = null;
let mentionAccounts = {};
let mentionAccountId = null;
let mentionAccountList = [];
let mentionLegacy = null;
let mentionSettingsReady = false;

function showMentionSound() {
  const sub = document.getElementById("mention_alert_sound_file_subtitle");
  if (mentionSoundFile) {
    sub.textContent = "Custom sound";
    sub.title = mentionSoundFile;
  } else {
    sub.textContent = window.mentionAlertForm.builtinName(mentionAccountId || "default");
    sub.title = "";
  }
  const sound = document.getElementById("mention_alert_sound");
  const soundOn = sound.checked && !sound.disabled;
  document.getElementById("reset_mention_sound").disabled = !soundOn || !mentionSoundFile;
}

function showDownloadDir() {
  const sub = document.getElementById("download_dir_subtitle");
  sub.textContent = downloadDir || "System Downloads folder";
  sub.title = downloadDir || "";
  document.getElementById("reset_download_dir").disabled = !downloadDir;
}

function showIcon(custom) {
  document.getElementById("icon_subtitle").textContent = custom ? "Custom" : "Default";
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
    if (await invoke("choose_app_icon")) { showIcon(true); flash("Changes saved ✓", 1500); }
  } catch (e) { flash(String(e), 6000); }
}

async function resetIcon() {
  try {
    await invoke("reset_app_icon");
    showIcon(false);
    flash("Changes saved ✓", 1500);
  } catch (e) { flash(String(e), 6000); }
}

async function chooseMentionSound() {
  if (!mentionAccountId) return;
  try {
    const name = await invoke("choose_mention_sound", { accountId: mentionAccountId });
    if (!name) return;
    mentionSoundFile = name;
    stashMentionForm();
    showMentionSound();
    flash("Changes saved ✓", 1500);
  } catch (e) { flash(String(e), 6000); }
}

async function resetMentionSound() {
  if (!mentionAccountId) return;
  try {
    await invoke("reset_mention_sound", { accountId: mentionAccountId });
    mentionSoundFile = null;
    stashMentionForm();
    showMentionSound();
    flash("Changes saved ✓", 1500);
  } catch (e) { flash(String(e), 6000); }
}

let hostPlatform = "";
let hostGeniex = false;

function paintChatSummaryConsent(on) {
  const state = document.getElementById("chat_summary_consent_state");
  const revoke = document.getElementById("chat_summary_revoke");
  if (!state || !revoke) return;
  state.textContent = on ? "Allowed on this computer." : "Not allowed yet.";
  revoke.hidden = !on;
}

async function load() {
  const s = await invoke("get_settings");
  hostPlatform = s.platform;
  hostGeniex = !!s.geniex_transcription;
  setMacRows(s.platform === "macos");
  document.getElementById("fluidvoice_install_row").hidden = s.platform !== "windows" || hostGeniex;
  document.getElementById("fluidvoice_port_row").hidden = hostGeniex;
  document.getElementById("geniex_install_row").hidden = !hostGeniex;
  document.getElementById("geniex_model_row").hidden = !hostGeniex;
  // Title bar (Linux): auto hides it on tiling window managers like Hyprland.
  document.getElementById("title_bar_row").hidden = s.platform !== "linux";
  document.getElementById("title_bar").value = ["show", "hide"].includes(s.title_bar) ? s.title_bar : "auto";
  document.getElementById("title_bar_subtitle").textContent = s.tiling_wm
    ? t("Detected: {0}. In automatic mode the bar is hidden.", [s.tiling_wm])
    : "Tiling window managers such as Hyprland don't use a title bar.";
  // Rendering (Linux, issue #87): software rendering for GPUs too old for
  // WebKit's GPU compositor. Read at startup, so changes apply after a restart.
  document.getElementById("rendering_row").hidden = s.platform !== "linux";
  document.getElementById("rendering").value = s.rendering === "software" ? "software" : "auto";
  document.getElementById("rendering_subtitle").textContent = s.legacy_gpu
    ? t("Old graphics card detected: Automatic already renders without the GPU.")
    : "Use Compatible if the window stays blank on an old graphics card. Applies after restarting whatRust.";
  if (/Win/.test(navigator.platform || navigator.userAgent)) {
    const startupRow = document.getElementById("start_minimized").closest("label");
    startupRow.querySelector(".row-title").textContent = "Start minimized with Windows";
    startupRow.querySelector(".row-subtitle").textContent = "Applies only at Windows sign-in. When opened from a shortcut, the window always appears.";
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
      "Requires macOS 14 (Sonoma) or later — this Mac cannot keep a hidden panel connected";
  }
  // Single-window mode (Linux/macOS): applies after a restart; menu-bar-only wins.
  const swRow = document.getElementById("single_window_row");
  swRow.hidden = !s.single_window_supported;
  const swNote = document.getElementById("single_window_subtitle");
  if (s.single_window_supported && !!s.single_window !== !!s.single_window_active) {
    swNote.textContent = s.single_window && s.menubar_only
      ? "Restart whatRust to apply. Menu-bar-only mode takes priority over this option."
      : "Restart whatRust to apply the change.";
  } else {
    swNote.textContent = SINGLE_WINDOW_SUBTITLE;
  }
  document.getElementById("hotkey").value = window.HotkeyFmt.toDisplay(s.hotkey || "CmdOrCtrl+Shift+W");
  document.getElementById("blur_hotkey").value = window.HotkeyFmt.toDisplay(s.blur_hotkey || "CmdOrCtrl+Shift+B");
  selectNearestZoom(Number.isFinite(s.zoom) ? s.zoom : ZOOM_DEFAULT);
  const lang = LANGS.includes(s.language) ? s.language : "en";
  document.getElementById("language").value = lang;
  if (I18n.lang() !== lang) I18n.setLang(lang);
  if (hostGeniex) {
    document.getElementById("voice_backend_desc").textContent = "Shows transcripts under voice notes using Qwen3-ASR Q8 locally on this computer.";
    document.getElementById("video_backend_desc").textContent = "Shows a transcription button on videos using Qwen3-ASR Q8 locally.";
    document.getElementById("test_fluidvoice").textContent = "Test NPU";
    void refreshTranscriptionStatus();
  }
  document.getElementById("fluidvoice_port").value = String(s.fluidvoice_port || 47733);
  document.getElementById("translate_target_lang").value = s.translate_target_lang || "English";
  translateModels = {
    openrouter: s.ai_model_openrouter || "",
    gemini: s.ai_model_gemini || "",
    anthropic: s.ai_model_anthropic || "",
    claude_cli: s.ai_model_claude_cli || "",
    codex_cli: s.ai_model_codex_cli || "",
    antigravity_cli: s.ai_model_antigravity_cli || "",
  };
  summaryModels = {
    openrouter: s.summary_model_openrouter || translateModels.openrouter,
    gemini: s.summary_model_gemini || translateModels.gemini,
    anthropic: s.summary_model_anthropic || translateModels.anthropic,
    claude_cli: s.summary_model_claude_cli || "",
    codex_cli: s.summary_model_codex_cli || "",
    antigravity_cli: s.summary_model_antigravity_cli || "",
  };
  standinCli = !!s.standin_cli_available;
  shownProvider = AI_PROVIDERS.includes(s.ai_provider) ? s.ai_provider : "openrouter";
  shownCli = standinCli && TEXT_CLI_PROVIDERS.includes(s.ai_cli_backend) ? s.ai_cli_backend : "";
  const aiProvider = document.getElementById("ai_provider");
  aiProvider.value = shownCli || shownProvider;
  for (const opt of aiProvider.options) {
    if (TEXT_CLI_PROVIDERS.includes(opt.value)) opt.disabled = !standinCli;
  }
  paintChatSummaryConsent(!!s.chat_summary_consent);
  standinModels = {
    openrouter: s.standin_model_openrouter || "",
    gemini: s.standin_model_gemini || "",
    anthropic: s.standin_model_anthropic || "",
  };
  standinCliModels = {
    claude_cli: s.standin_model_claude || "",
    grok_cli: s.standin_model_grok || "",
    codex_cli: s.standin_model_codex || "",
    antigravity_cli: s.standin_model_antigravity || "",
  };
  standinBins = {
    claude_cli: s.standin_claude_bin || "",
    grok_cli: s.standin_grok_bin || "",
    codex_cli: s.standin_codex_bin || "",
    antigravity_cli: s.standin_antigravity_bin || "",
  };
  const standinBackend = STANDIN_BACKENDS.includes(s.standin_backend) ? s.standin_backend : "api";
  legacyCliModel = s.standin_cli_model || "";
  document.getElementById("standin_backend").value = standinBackend;
  standinShown = standinBackend;
  document.getElementById("standin_delay_secs").value = String(s.standin_delay_secs || 10);
  document.getElementById("standin_hourly_limit").value = String(s.standin_hourly_limit || 12);
  document.getElementById("standin_hermes_url").value = s.standin_hermes_url || "";
  document.getElementById("standin_agent_timeout_secs").value = String(s.standin_agent_timeout_secs || 150);
  document.getElementById("standin_agent_runs_per_hour").value = String(s.standin_agent_runs_per_hour || 20);
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
  loadMentionAccounts(s);
  showIcon(!!s.custom_icon);
  loadProxy(s);
}

function loadMentionAccounts(s) {
  mentionAccounts = {};
  if (s.mention_accounts && typeof s.mention_accounts === "object") {
    mentionLegacy = null;
    for (const [id, prefs] of Object.entries(s.mention_accounts)) {
      mentionAccounts[id] = window.mentionAlertForm.normalizePrefs(prefs);
    }
  } else {
    mentionLegacy = window.mentionAlertForm.legacyPrefs(s);
  }
  mentionSettingsReady = true;
  renderMentionAccountSelect(false);
}

function renderMentionAccountSelect(keepForm) {
  if (!mentionSettingsReady) return;
  const sel = document.getElementById("mention_account");
  if (!sel) return;
  if (keepForm) stashMentionForm();
  pruneMentionAccounts();
  const previous = mentionAccountId;
  sel.replaceChildren();
  for (const account of mentionAccountList) {
    const opt = document.createElement("option");
    opt.value = account.id;
    opt.textContent = account.name;
    sel.appendChild(opt);
  }
  if (!mentionAccountList.length) {
    mentionAccountId = null;
    return;
  }
  const keep = mentionAccountList.some((account) => account.id === previous)
    ? previous
    : mentionAccountList[0].id;
  mentionAccountId = keep;
  sel.value = keep;
  writeMentionForm(prefsForMention(keep));
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
  const hk = window.HotkeyFmt.fromDisplay(document.getElementById("hotkey").value.trim());
  s.hotkey = hk || "CmdOrCtrl+Shift+W";
  s.blur_hotkey = window.HotkeyFmt.fromDisplay(document.getElementById("blur_hotkey").value.trim()) || "CmdOrCtrl+Shift+B";
  s.zoom = parseFloat(document.getElementById("zoom").value) || ZOOM_DEFAULT;
  s.title_bar = document.getElementById("title_bar").value || "auto";
  s.rendering = document.getElementById("rendering").value || "auto";
  s.language = document.getElementById("language").value;
  commitModelFields();
  s.fluidvoice_port = parseInt(document.getElementById("fluidvoice_port").value, 10) || 47733;
  s.translate_target_lang = document.getElementById("translate_target_lang").value.trim() || "English";
  s.ai_provider = shownProvider;
  s.ai_cli_backend = shownCli;
  s.ai_model_openrouter = translateModels.openrouter;
  s.ai_model_gemini = translateModels.gemini;
  s.ai_model_anthropic = translateModels.anthropic;
  s.ai_model_claude_cli = translateModels.claude_cli;
  s.ai_model_codex_cli = translateModels.codex_cli;
  s.ai_model_antigravity_cli = translateModels.antigravity_cli;
  s.summary_model_openrouter = summaryModels.openrouter;
  s.summary_model_gemini = summaryModels.gemini;
  s.summary_model_anthropic = summaryModels.anthropic;
  s.summary_model_claude_cli = summaryModels.claude_cli;
  s.summary_model_codex_cli = summaryModels.codex_cli;
  s.summary_model_antigravity_cli = summaryModels.antigravity_cli;
  commitStandinFields();
  s.standin_backend = document.getElementById("standin_backend").value;
  s.standin_model_openrouter = standinModels.openrouter;
  s.standin_model_gemini = standinModels.gemini;
  s.standin_model_anthropic = standinModels.anthropic;
  s.standin_model_claude = standinCliModels.claude_cli;
  s.standin_model_grok = standinCliModels.grok_cli;
  s.standin_model_codex = standinCliModels.codex_cli;
  s.standin_model_antigravity = standinCliModels.antigravity_cli;
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
  s.standin_antigravity_bin = standinBins.antigravity_cli;
  s.standin_delay_secs = parseInt(document.getElementById("standin_delay_secs").value, 10) || 10;
  s.standin_hourly_limit = parseInt(document.getElementById("standin_hourly_limit").value, 10) || 12;
  s.standin_hermes_url = document.getElementById("standin_hermes_url").value.trim();
  s.standin_agent_timeout_secs = parseInt(document.getElementById("standin_agent_timeout_secs").value, 10) || 150;
  s.standin_agent_runs_per_hour = parseInt(document.getElementById("standin_agent_runs_per_hour").value, 10) || 20;
  s.download_dir = downloadDir;
  if (mentionSettingsReady) {
    stashMentionForm();
    pruneMentionAccounts();
    for (const account of mentionAccountList) {
      if (!mentionAccounts[account.id]) mentionAccounts[account.id] = prefsForMention(account.id);
    }
    s.mention_accounts = mentionAccounts;
  }
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
    loadMentionAccounts(saved);
    proxySaved = { proxy_mode: saved.proxy_mode, proxy_host: saved.proxy_host, proxy_port: saved.proxy_port };
    document.getElementById("proxy_host").value = saved.proxy_host;
    document.getElementById("standin_hermes_url").value = saved.standin_hermes_url || "";
    document.getElementById("standin_agent_timeout_secs").value = String(saved.standin_agent_timeout_secs || 150);
    document.getElementById("standin_agent_runs_per_hour").value = String(saved.standin_agent_runs_per_hour || 20);
    syncProxyRestart();
    if (warn) {
      note.textContent = t("Saved with a note: {0}", [warn]);
      setTimeout(() => (note.textContent = ""), 6000);
    } else {
      note.textContent = "Changes saved ✓";
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
  note.textContent = 'Please wait…';
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
  else {menu.style.position="fixed";menu.style.zIndex="9999";menu.showPopover=()=>{menu.style.display="block";menu.dataset.open="true";};menu.hidePopover=()=>{menu.style.display="none";menu.dataset.open="false";anchor.focus({preventScroll:true});};}menu.setAttribute("role", "menu");menu.setAttribute("aria-label", t("Actions for {0}", [a.name]));
  const actions = [
    ["Open account", () => accountAction(() => invoke("open_account", {id:a.id}))],
    ...( /Win/.test(navigator.platform || navigator.userAgent) ? [[a.detached ? "Return to the main window" : "Open in a separate window", () => accountAction(() => invoke(a.detached?"attach_account":"detach_account",{id:a.id}))]] : []),
    ["Use on startup",()=>accountAction(()=>invoke("set_default_account",{id:a.id}))],
    ["Change photo",()=>pickAccountPhoto(a.id)],
    ...(a.photo?[["Remove photo",()=>accountAction(()=>invoke("remove_account_photo",{id:a.id}))]]:[]),
    ["Rename",async()=>{const name=await Dlg.prompt("",{title:"Rename account",value:a.name,okLabel:"Rename",requiredMessage:"Enter a name."});if(name!==null&&name!==a.name)await accountAction(()=>invoke("rename_account",{id:a.id,name}));}],
  ];
  const index=accounts.findIndex(x=>x.id===a.id);
  for(const [delta,label] of [[-1,"Move up"],[1,"Move down"]]) {
    if(index+delta<0||index+delta>=accounts.length)continue;
    actions.push([label,()=>accountAction(()=>{const ids=accounts.map(x=>x.id);[ids[index],ids[index+delta]]=[ids[index+delta],ids[index]];return invoke("reorder_accounts",{ids});})]);
  }
  if(accounts.length>1)actions.push(["Remove account",async()=>{if(await Dlg.confirm("This account's local session will be deleted. To use it again, you will need to scan the QR code.",{title:t('Remove "{0}"?',[a.name]),okLabel:"Remove",danger:true}))await accountAction(()=>invoke("remove_account",{id:a.id}));}]);
  for(const [label,action] of actions){const button=document.createElement("button");button.type="button";button.textContent=label;button.setAttribute("role","menuitem");if(label==="Remove account")button.className="danger";button.onclick=()=>{menu.hidePopover();menu.dataset.open="false";action();};menu.appendChild(button);}
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
const PHOTO_MAX_BYTES = 5 * 1024 * 1024, PHOTO_SIZE = 96;

// Pick a PNG/JPEG, crop it to a centred square, scale it to 96x96 and hand the
// PNG bytes to the backend (which validates and stores them per account).
function pickAccountPhoto(id) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg";
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const note = document.getElementById("accounts-note");
    if (file.size > PHOTO_MAX_BYTES) { note.textContent = t("The image is larger than 5 MB."); return; }
    await accountAction(async () => {
      let png;
      try {
        const bmp = await createImageBitmap(file);
        const side = Math.min(bmp.width, bmp.height);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = PHOTO_SIZE;
        canvas.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
        const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
        png = Array.from(new Uint8Array(await blob.arrayBuffer()));
      } catch (e) {
        throw new Error(t("The image could not be read."));
      }
      await invoke("set_account_photo", { id, png });
    });
  };
  input.click();
}

function renderAccounts(accounts) {
  const list=document.getElementById("accounts-list"),startup=document.getElementById("startup_account");
  if(document.getElementById("account-actions")?.dataset.open==="true")return;
  list.replaceChildren();startup.replaceChildren();
  for(const a of accounts){
    const option=document.createElement("option");option.value=a.id;option.textContent=a.name;option.selected=a.is_default;startup.appendChild(option);
    const row=document.createElement("div");row.className="account-row";
    const avatar=document.createElement("span");avatar.className="account-avatar";avatar.setAttribute("aria-hidden","true");if(a.photo){const img=document.createElement("img");img.src=a.photo;img.alt="";avatar.classList.add("has-photo");avatar.appendChild(img);}else avatar.textContent=a.name.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase();
    const open=document.createElement("button");open.type="button";open.className="account-open";open.setAttribute("aria-label",t("Open {0}",[a.name]));
    const name=document.createElement("span");name.className="acct-name";name.textContent=a.name;
    const info=document.createElement("span");info.className="acct-subtitle";info.textContent=a.detached?"In a separate window":a.is_default?"Account on startup":"WhatsApp";open.append(name,info);open.onclick=()=>accountAction(()=>invoke("open_account",{id:a.id}));
    row.append(avatar,open);
    if(a.unread){const badge=document.createElement("span");badge.className="acct-unread";badge.textContent=a.unread;badge.title=t("{0} unread chats",[a.unread]);row.appendChild(badge);}
    const more=document.createElement("button");more.type="button";more.className="account-more";more.textContent="⋮";more.setAttribute("aria-label",t("Options for {0}",[a.name]));more.setAttribute("aria-haspopup","menu");more.onclick=()=>accountMenu(a,accounts,more);row.appendChild(more);list.appendChild(row);
  }
}

async function loadAccounts() {
  try {
    mentionAccountList = await invoke("list_accounts");
    renderAccounts(mentionAccountList);
    renderMentionAccountSelect(true);
  } catch (e) {
    document.getElementById('accounts-note').textContent = t('Could not load the accounts: {0}', [String(e)]);
  }
}

// Code contributors, credited on the About page. Links open in the browser
// through the backend, which builds the github.com address itself.
const CONTRIBUTORS = ["karem505", "matheuscardosoj", "janbridley", "maerlin", "LILQK", "vrieza", "t43riz"];
function renderContributors() {
  const list = document.getElementById("contributors");
  if (!list) return;
  for (const login of CONTRIBUTORS) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "https://github.com/" + login;
    a.textContent = login;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      invoke("open_contributor", { login }).catch(() => {});
    });
    li.appendChild(a);
    list.appendChild(li);
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
  document.getElementById("mention_account").addEventListener("change", () => {
    const next = document.getElementById("mention_account").value;
    if (!next || next === mentionAccountId) return;
    // Keep the account on screen in memory. Save writes every account; saving
    // here would also persist unrelated half-edited settings and could fail
    // on them, which would look like the account switch itself failed.
    if (mentionAccountId) mentionAccounts[mentionAccountId] = readMentionForm();
    mentionAccountId = next;
    writeMentionForm(prefsForMention(next));
  });
  for (const id of MENTION_TYPES) {
    document.getElementById(id).addEventListener("change", syncMentionAlert);
  }
  document.getElementById("mention_alert_sound").addEventListener("change", syncMentionAlert);
  document.getElementById("mention_alert_popup").addEventListener("change", syncMentionAlert);
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
  renderContributors();
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
  document.getElementById("choose_mention_sound").addEventListener("click", chooseMentionSound);
  document.getElementById("reset_mention_sound").addEventListener("click", resetMentionSound);
  document.getElementById("preview_mention_sound").addEventListener("click", () => {
    if (!mentionAccountId) return;
    invoke("preview_mention_sound", { accountId: mentionAccountId }).catch((error) => flash(String(error), 6000));
  });
  // Zoom saves on change rather than on Save: picking a size you cannot see the
  // effect of is guesswork, and the webview applies it immediately.
  document.getElementById("zoom").addEventListener("change", save);
  document.getElementById("title_bar").addEventListener("change", save);
  document.getElementById("rendering").addEventListener("change", save);
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
    const provider = document.getElementById("ai_provider").value;
    shownCli = TEXT_CLI_PROVIDERS.includes(provider) ? provider : "";
    if (!shownCli) shownProvider = provider;
    refreshKeyState();
    syncModelControls();
    showStandinFields();
  });
  document.getElementById("standin_backend").addEventListener("change", () => {
    commitStandinFields();
    syncStandinAvailability();
    showStandinFields();
    if (shownCli && standinShown === "api" && usesModelList(shownProvider)) loadModelCatalog(shownProvider);
    // The old program's result would otherwise be read as this one's.
    document.getElementById("standin_cli_state").textContent = "Not checked yet.";
  });
  document.getElementById("save_hermes_key").addEventListener("click", () => saveStandinSecret("hermes", false));
  document.getElementById("remove_hermes_key").addEventListener("click", () => saveStandinSecret("hermes", true));
  document.getElementById("save_grok").addEventListener("click", () => saveStandinSecret("grok_bot", false));
  document.getElementById("remove_grok").addEventListener("click", () => saveStandinSecret("grok_bot", true));
  document.getElementById("copy_grok_routine").addEventListener("click", async () => {
    const note = document.getElementById("note");
    const text = document.getElementById("grok_routine_prompt").textContent;
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = "Copied ✓";
      setTimeout(() => (note.textContent = ""), 1500);
    } catch (e) {
      note.textContent = t("Could not copy. Select the instructions and copy them.");
    }
  });
  document.getElementById("chat_summary_revoke").addEventListener("click", async () => {
    try {
      await invoke("clear_chat_summary_consent");
      paintChatSummaryConsent(false);
      flash("Changes saved ✓", 1500);
    } catch (e) { flash(String(e), 6000); }
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
  const aiBin = document.getElementById("ai_cli_bin");
  const standinBin = document.getElementById("standin_bin");
  aiBin.addEventListener("input", () => {
    standinBins[shownCli] = aiBin.value.trim();
    if (shownCli === standinShown) standinBin.value = aiBin.value;
  });
  standinBin.addEventListener("input", () => {
    standinBins[standinShown] = standinBin.value.trim();
    if (shownCli === standinShown) aiBin.value = standinBin.value;
  });
  aiBin.addEventListener("change", () => refreshCliModelCatalog(shownCli));
  standinBin.addEventListener("change", () => refreshCliModelCatalog(standinShown));
  document.getElementById("test_fluidvoice").addEventListener("click", testFluidVoice);
  document.getElementById("install_fluidvoice").addEventListener("click", () => {
    offerFluidVoiceInstall(false);
  });
  document.getElementById("install_geniex").addEventListener("click", async () => {
    try { await invoke("open_fluidvoice_windows"); } catch (e) { document.getElementById("fluidvoice_status").textContent = errorText(e); }
  });
  document.getElementById("download_geniex_model").addEventListener("click", async () => {
    const button = document.getElementById("download_geniex_model");
    button.disabled = true;
    document.getElementById("fluidvoice_status").textContent = "Downloading Qwen3-ASR Q8. This may take several minutes…";
    try { await invoke("geniex_download"); await refreshTranscriptionStatus(); }
    catch (e) { document.getElementById("fluidvoice_status").textContent = t("Model download failed. Check that GenieX is installed, you have network access and sufficient disk space, then try again. ({0})", [errorText(e)]); }
    finally { button.disabled = false; }
  });
  document.getElementById("voice_transcribe").addEventListener("change", () => {
    if (hostPlatform === "windows" && !hostGeniex && document.getElementById("voice_transcribe").checked) {
      offerFluidVoiceIfMissing();
    }
  });
  document.getElementById("video_transcribe").addEventListener("change", () => {
    if (hostPlatform === "windows" && !hostGeniex && document.getElementById("video_transcribe").checked) {
      offerFluidVoiceIfMissing();
    }
  });
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
  const backendSelect = document.getElementById("standin_backend");
  const providerOption = document.querySelector(`#ai_provider option[value="${shownProvider}"]`);
  backendSelect.querySelector('option[value="api"]').textContent = providerOption.textContent;
  const backend = backendSelect.value;
  const cli = STANDIN_CLI_PROVIDERS.includes(backend);
  const agent = backend === "hermes" || backend === "grok_bot";
  const listed = cli || (!agent && usesModelList(shownProvider));
  const input = document.getElementById("standin_model");
  const select = document.getElementById("standin_model_select");
  document.getElementById("standin_model_row").hidden = agent;
  input.hidden = listed || agent;
  select.hidden = !listed || agent;
  if (cli) fillCliModelSelect(backend);
  else if (listed) fillStandinModelSelect();
  else if (!agent) input.value = standinModels[shownProvider] || "";
  document.getElementById("standin_bin").closest("label").hidden = !cli;
  document.getElementById("standin_bin").value = cli ? (standinBins[backend] || "") : "";
  document.getElementById("check_standin_cli").disabled = !cli || !standinCli;
  document.getElementById("standin_session_row").hidden = !cli;
  document.getElementById("standin_hermes_row").hidden = backend !== "hermes";
  document.getElementById("standin_hermes_key_row").hidden = backend !== "hermes";
  document.getElementById("standin_grok_row").hidden = backend !== "grok_bot";
  document.getElementById("standin_timeout_row").hidden = !agent;
  document.getElementById("standin_runs_row").hidden = !agent;
  standinShown = backend;
  if (cli) loadCliModelCatalog(backend);
  if (agent) refreshAgentStatus();
}

function syncStandinAvailability() {
  const select = document.getElementById("standin_backend");
  for (const opt of select.options) {
    if (STANDIN_CLI_PROVIDERS.includes(opt.value)) opt.disabled = !standinCli;
  }
  if (!standinCli && STANDIN_CLI_PROVIDERS.includes(select.value)) select.value = "api";
  if (!standinCli) {
    document.getElementById("standin_backend_hint").textContent =
      "In this install, the command-line programs are not available. The API key, Hermes, and Grok Bot still work.";
  }
}

async function refreshAgentStatus() {
  try {
    const status = await invoke("standin_agent_status");
    const host = document.getElementById("standin_grok_host");
    if (status.grok_ready && status.grok_host) {
      host.textContent = t("Webhook host: {0}.", [status.grok_host]);
    } else {
      host.textContent = "No webhook saved yet.";
    }
    document.getElementById("standin_hermes_key_state").textContent = status.hermes_key_stored
      ? "A key is stored on this computer, not in settings and not in WhatsApp."
      : "Stored on this computer, not in settings and not in WhatsApp.";
  } catch (e) {}
}

async function saveStandinSecret(kind, remove) {
  const note = document.getElementById("note");
  try {
    await invoke("set_standin_secret", {
      kind,
      secret: remove ? "" : (kind === "hermes"
        ? document.getElementById("standin_hermes_key").value
        : document.getElementById("standin_grok_key").value),
      url: kind === "grok_bot" ? document.getElementById("standin_grok_url").value : "",
      remove,
    });
    document.getElementById("standin_hermes_key").value = "";
    document.getElementById("standin_grok_key").value = "";
    document.getElementById("standin_grok_url").value = "";
    await refreshAgentStatus();
    note.textContent = "Saved ✓";
    setTimeout(() => (note.textContent = ""), 1500);
  } catch (e) {
    note.textContent = errorText(e);
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
  if (shownCli) {
    const translate = document.getElementById("translate_model_select");
    const summary = document.getElementById("summary_model_select");
    if (!translate.disabled) translateModels[shownCli] = translate.value;
    if (!summary.disabled) summaryModels[shownCli] = summary.value;
    return;
  }
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
  const listed = !!shownCli || usesModelList(shownProvider);
  for (const id of ["ai_key_row", "ai_key_actions", "ai_key_state", "ai_key_note"]) {
    document.getElementById(id).hidden = !!shownCli;
  }
  document.getElementById("ai_cli_bin_row").hidden = !shownCli;
  document.getElementById("ai_cli_bin").value = standinBins[shownCli] || "";
  document.getElementById("translate_model_hint").hidden = !!shownCli;
  document.getElementById("translate_model").hidden = listed;
  document.getElementById("summary_model").hidden = listed;
  document.getElementById("translate_model_select").hidden = !listed;
  document.getElementById("summary_model_select").hidden = !listed;
  if (shownCli) {
    refreshCliModelCatalog(shownCli);
    if (standinShown === "api" && usesModelList(shownProvider)) loadModelCatalog(shownProvider);
    return;
  }
  if (!listed) {
    catalogToken += 1;
    catalogLoading = false;
    document.getElementById("translate_model").value = translateModels[shownProvider] || "";
    document.getElementById("summary_model").value = summaryModels[shownProvider] || "";
    document.getElementById("translate_model_hint").textContent = "Model name accepted by that provider.";
    return;
  }
  renderModelSelects();
  loadModelCatalog(shownProvider);
}

function renderModelSelects() {
  if (!shownCli) {
    const models = modelCatalogs[shownProvider] || [];
    fillModelSelect("translate_model_select", translateModels[shownProvider], models);
    fillModelSelect("summary_model_select", summaryModels[shownProvider], models);
  }
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

function renderTextCliModels() {
  const models = cliModelCatalogs[cliCatalogKey(shownCli)] || [];
  const defaultModel = { id: "", label: "Program default" };
  fillModelSelect("translate_model_select", translateModels[shownCli], models, defaultModel, false);
  fillModelSelect("summary_model_select", summaryModels[shownCli], models, defaultModel, false);
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
  if (!loaded && backend !== "antigravity_cli") document.getElementById("standin_model_select").disabled = true;
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
  select.disabled = (needsKey && (catalogLoading || !keyFlags[shownProvider]))
    || (options.length === 0 && (needsKey || !leading));
}

function refreshCliModelCatalog(backend) {
  if (shownCli && shownCli === backend) renderTextCliModels();
  if (standinShown === backend) fillCliModelSelect(backend);
  loadCliModelCatalog(backend);
}

async function loadCliModelCatalog(backend) {
  const key = cliCatalogKey(backend);
  if (cliModelCatalogs[key] || cliCatalogRequests.has(key)) return;
  cliCatalogRequests.add(key);
  const bin = standinBins[backend] || "";
  try {
    const models = await invoke("list_standin_cli_models", { backend, bin });
    if (Array.isArray(models) && models.length) cliModelCatalogs[key] = models;
  } catch {
    // Keep the saved model and program default available.
  } finally {
    cliCatalogRequests.delete(key);
  }
  if (key === cliCatalogKey(backend)) {
    if (shownCli === backend) renderTextCliModels();
    if (standinShown === backend) fillCliModelSelect(backend);
  }
}

async function loadModelCatalog(provider) {
  const hint = document.getElementById("translate_model_hint");
  const setHint = (text) => {
    if (!shownCli) hint.textContent = text;
  };
  if (!keyFlags[provider]) {
    catalogLoading = false;
    setHint("Save the API key to list models.");
    renderModelSelects();
    return;
  }
  if (modelCatalogs[provider]) {
    catalogLoading = false;
    setHint(modelCatalogs[provider].length
      ? "Main models available for this key."
      : "No main model is available for this key.");
    renderModelSelects();
    return;
  }
  const token = ++catalogToken;
  catalogLoading = true;
  setHint("Loading models…");
  if (!shownCli) {
    document.getElementById("translate_model_select").disabled = true;
    document.getElementById("summary_model_select").disabled = true;
  }
  if (document.getElementById("standin_backend").value === "api") {
    document.getElementById("standin_model_select").disabled = true;
  }
  try {
    const models = await invoke("list_ai_models", { provider });
    if (token !== catalogToken || shownProvider !== provider) return;
    modelCatalogs[provider] = Array.isArray(models) ? models : [];
    setHint(modelCatalogs[provider].length
      ? "Main models available for this key."
      : "No main model is available for this key.");
  } catch (e) {
    if (token !== catalogToken || shownProvider !== provider) return;
    const message = errorText(e);
    setHint(message);
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
  const on = keyFlags[shownProvider];
  setKeyStatus(on ? "Key saved on this computer." : "No key saved.", "ok");
}

async function offerFluidVoiceIfMissing() {
  try {
    const port = parseInt(document.getElementById("fluidvoice_port").value, 10) || 47733;
    const result = await invoke("fluidvoice_status", { port });
    if (result.ok) return;
  } catch {
    // A failed check is the same as no answer: offer the installer.
  }
  await offerFluidVoiceInstall(true);
}

async function offerFluidVoiceInstall(missing) {
  const message = missing
    ? "FluidVoice did not respond. Transcription uses that separate app, and the Windows version is still in beta. Open the official installer? Then turn on the local API in FluidVoice."
    : "FluidVoice is a separate app, and the Windows version is still in beta. whatRust opens the official installer in the browser. Then turn on the local API in FluidVoice.";
  if (!await Dlg.confirm(message, { title: "Install FluidVoice?", okLabel: "Open installer" })) return;
  try {
    await invoke("open_fluidvoice_windows");
  } catch (e) {
    document.getElementById("fluidvoice_status").textContent = errorText(e);
  }
}

async function testFluidVoice() {
  if (hostGeniex) {
    const status = document.getElementById("fluidvoice_status");
    status.textContent = "Testing the NPU. Loading the model may take a minute…";
    try { await invoke("geniex_test"); status.textContent = "GenieX and the Q8 model responded on the NPU."; }
    catch (e) { status.textContent = t("NPU test failed. Confirm GenieX and the Q8 model are installed and this computer has a supported Snapdragon NPU. ({0})", [errorText(e)]); }
    return;
  }
  await refreshTranscriptionStatus();
}

async function refreshTranscriptionStatus() {
  const status = document.getElementById("fluidvoice_status");
  status.textContent = "Checking…";
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
    setKeyStatus("Enter the API key.", "warn");
    return;
  }
  button.disabled = true;
  // Drop a list request already in flight. Leaving catalogLoading set would
  // keep every model menu disabled after this check finishes.
  catalogToken += 1;
  catalogLoading = false;
  setKeyStatus("Checking the key…", "ok");
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
    setKeyStatus("No key saved.", "ok");
    return;
  }
  if (!await Dlg.confirm("This provider's saved key will be deleted from this computer.", {
    title: "Remove key",
    okLabel: "Remove",
    danger: true,
  })) return;
  try {
    const result = await invoke("set_ai_key", { provider, key: "", remove: true });
    keyFlags[provider] = false;
    modelCatalogs[provider] = null;
    setKeyStatus(result.detail || "This provider's key was removed from this computer.", "ok");
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
    document.getElementById("biometric_label").textContent = t("Use {0}", [s.biometric_label]);
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
    } catch (e) { await Dlg.alert(String(e), { title: "Could not turn on the lock" }); }
  });

  document.getElementById("lock_now").addEventListener("click", async () => {
    try { await invoke("lock_app"); } catch (e) { await Dlg.alert(String(e), { title: "Could not lock" }); }
  });

  document.getElementById("change_pw").addEventListener("click", async () => {
    const current = await Dlg.prompt("", {
      title: "Current password",
      password: true,
      okLabel: "Continue",
      requiredMessage: "Enter your current password.",
    });
    if (current === null) return;
    const next = await Dlg.prompt("At least 6 characters.", {
      title: "New password",
      password: true,
      okLabel: "Change",
      requiredMessage: "Enter a new password.",
    });
    if (next === null) return;
    try {
      await invoke("change_app_lock_password", { current, new: next, confirm: next });
      await Dlg.alert("Your lock password was changed.", { title: "Password changed" });
    } catch (e) { await Dlg.alert(String(e), { title: "Could not change the password" }); }
  });

  document.getElementById("disable_lock").addEventListener("click", async () => {
    const current = await Dlg.prompt("Enter your current password to turn off the lock.", {
      title: "Turn off lock",
      password: true,
      okLabel: "Turn off",
      danger: true,
      requiredMessage: "Enter your current password.",
    });
    if (current === null) return;
    try {
      await invoke("disable_app_lock", { current });
      await loadLock();
    } catch (e) { await Dlg.alert(String(e), { title: "Could not turn off the lock" }); }
  });

  document.getElementById("biometric_enabled").addEventListener("change", async (e) => {
    try {
      await invoke("set_biometric_enabled", { enabled: e.target.checked });
    } catch (err) {
      e.target.checked = !e.target.checked; // revert on failure
      await Dlg.alert(String(err), { title: "Could not change biometrics" });
    }
    await loadLock();
  });

  const reportLockOptionFailure = (e) => Dlg.alert(String(e), { title: "Could not save" });
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
  btn.textContent = "Record";
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
  if (accel === null) { setHotkeyHint("Unsupported key. Try another."); return; }
  if (!window.HotkeyFmt.isValidCombo(mods, e.code)) {
    setHotkeyHint("Include Ctrl, Alt or Shift.");
    return;
  }
  document.getElementById(recordInputId).value = window.HotkeyFmt.toDisplay(accel);
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
  btn.textContent = "Press the keys… (Esc cancels)";
  btn.classList.add("recording");
  setHotkeyHint("");
  window.addEventListener("keydown", onRecordKeydown, true);
  window.addEventListener("blur", onRecordBlur, true);
}

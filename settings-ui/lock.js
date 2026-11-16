const invoke = window.__TAURI__.core.invoke;
const pwd = document.getElementById("password");
const errEl = document.getElementById("error");

let busy = false;

async function tryUnlock() {
  if (busy) return;
  const password = pwd.value;
  if (!password) { errEl.textContent = "Enter your password."; return; }
  busy = true;
  document.getElementById("unlock").disabled = true;
  document.getElementById("biometric").disabled = true;
  errEl.textContent = "";
  try {
    const ok = await invoke("unlock_password", { password });
    if (!ok) {
      errEl.textContent = "Wrong password. Try again.";
      pwd.value = "";
      pwd.focus();
    }
  } catch (e) {
    const wait = /^throttled:(\d+)$/.exec(String(e));
    errEl.textContent = wait
      ? t("Too many attempts. Try again in {0}s.", [wait[1]])
      : t("Could not unlock. Try again.");
  } finally {
    busy = false;
    document.getElementById("unlock").disabled = false;
    document.getElementById("biometric").disabled = false;
  }
}

async function tryBiometric() {
  if (busy) return;
  busy = true;
  document.getElementById("unlock").disabled = true;
  document.getElementById("biometric").disabled = true;
  errEl.textContent = "";
  try {
    const ok = await invoke("unlock_biometric");
    if (!ok) errEl.textContent = "Could not confirm biometrics. Enter your password.";
  } catch (e) {
    errEl.textContent = "Could not unlock. Try again.";
  } finally {
    busy = false;
    document.getElementById("unlock").disabled = false;
    document.getElementById("biometric").disabled = false;
  }
}

async function init() {
  document.getElementById("unlock").addEventListener("click", tryUnlock);
  pwd.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });

  const bio = document.getElementById("biometric");
  bio.addEventListener("click", tryBiometric);

  document.getElementById("reset").addEventListener("click", async (e) => {
    e.preventDefault();
    const ok = await Dlg.confirm(
      "This signs out every account in this app and removes the lock. You will need to link WhatsApp again with the QR code. Your chats stay on your phone.",
      { title: "Reset whatRust?", okLabel: "Reset", danger: true }
    );
    if (!ok) return;
    try {
      await invoke("reset_app_lock", { confirmed: true });
    } catch (err) {
      errEl.textContent = "Could not reset the app. Try again.";
    }
  });

  try {
    const s = await invoke("get_lock_status");
    if (s.biometric_enabled) {
      bio.textContent = s.biometric_label ? t("Use {0}", [s.biometric_label]) : t("Use biometrics");
      bio.hidden = false;
      tryBiometric(); // auto-prompt on load
    }
  } catch (_) {
    // status unavailable — password still works
  }
  pwd.focus();
}

window.addEventListener("DOMContentLoaded", init);

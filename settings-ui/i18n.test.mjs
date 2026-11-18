// Run: node settings-ui/i18n.test.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const defaultI18n = require("./i18n.js");
assert.equal(defaultI18n.lang(), "en");
assert.equal(defaultI18n.t("Save"), "Save");
delete require.cache[require.resolve("./i18n.js")];
globalThis.__WR_LANG = "pt-BR";
const I18n = require("./i18n.js");
const { PT, norm, t } = I18n;
const dir = new URL(".", import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), "utf8");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n       " + e.message.split("\n").join("\n       ")); }
}

// Text that is the same in both languages, or a proper name.
const SAME = new Set(["whatRust", "WhatsApp", "OK", "Português (Brasil)", "English", "⇄", "⋮", "⚙", "1.0x",
  "CmdOrCtrl+Shift+W", "CmdOrCtrl+Shift+B", "whatrust --toggle", "Esc", "SOCKS5", "HTTP", "127.0.0.1", "1080", "https://"]);

function visibleTexts(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<code>[\s\S]*?<\/code>/g, "<code></code>")
    .replace(/<pre class="standin-prompt"[\s\S]*?<\/pre>/g, "<pre></pre>");
  const out = [];
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const s = norm(m[1].replace(/&[a-z]+;/g, " "));
    if (s) out.push(s);
  }
  for (const m of html.matchAll(/\b(?:aria-label|title|placeholder)="([^"]+)"/g)) out.push(norm(m[1]));
  return out;
}

check("Portuguese translates English source strings", () => {
  assert.equal(t("Save"), "Salvar");
  assert.equal(t("Open {0}", ["Ana"]), "Abrir Ana");
  assert.equal(t("NPU test failed. Confirm GenieX and the Q8 model are installed and this computer has a supported Snapdragon NPU. ({0})", ["erro"]), "Falha no teste da NPU. Confirme se o GenieX e o modelo Q8 estão instalados e se este computador tem uma NPU Snapdragon compatível. (erro)");
});

check("placeholders match between English and Portuguese", () => {
  for (const [en, pt] of Object.entries(PT)) {
    for (let i = 0; i < 4; i++) {
      assert.equal(en.includes(`{${i}}`), pt.includes(`{${i}}`), `placeholder {${i}} in "${en}"`);
    }
  }
});

check("every static string in the HTML pages is an English source string", () => {
  const missing = [];
  for (const f of ["index.html", "lock.html", "shell.html", "mention-popup.html"]) {
    for (const s of visibleTexts(read(f))) {
      if (!(s in PT) && !SAME.has(s)) missing.push(`${f}: ${s}`);
    }
  }
  assert.deepEqual(missing, []);
});

check("every t(\"…\") literal in the scripts is an English source string", () => {
  const missing = [];
  for (const f of ["main.js", "panel.js", "lock.js", "shell.js", "dialog.js", "hotkey.js", "updates.js", "mention-popup.js"]) {
    for (const m of read(f).matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) {
      const s = norm(m[2].replace(/\\(.)/g, "$1"));
      if (!(s in PT)) missing.push(`${f}: ${s}`);
    }
  }
  assert.deepEqual(missing, []);
});

check("strings assigned to the page by the scripts are English source strings", () => {
  // textContent = "…" / Dlg.*("…", {title: "…", okLabel: "…"}) literals.
  const missing = [];
  const re = /(?:textContent\s*=\s*|title\s*:\s*|okLabel\s*:\s*|requiredMessage\s*:\s*|aria-label",\s*|Dlg\.(?:alert|confirm|prompt)\(\s*|new Error\(\s*|showError\(\s*)(["'])((?:\\.|(?!\1).)*[A-Za-zÀ-ú](?:\\.|(?!\1).)*)\1/g;
  for (const f of ["main.js", "lock.js", "panel.js", "updates.js", "mention-popup.js"]) {
    for (const m of read(f).matchAll(re)) {
      const s = norm(m[2].replace(/\\(.)/g, "$1"));
      if (!/[À-ú]|\s/.test(s) && !(s in PT)) {
        // single-word ASCII strings (ids, "Mac") are not UI text unless in PT already
        continue;
      }
      if (!(s in PT) && !SAME.has(s)) missing.push(`${f}: ${s}`);
    }
  }
  assert.deepEqual(missing, []);
});

check("both language options are offered", () => {
  const html = read("index.html");
  assert.match(html, /<option value="pt-BR">/);
  assert.match(html, /<option value="en">/);
});

if (failures) { console.log(`\n${failures} i18n test(s) failed`); process.exit(1); }
console.log("\nall i18n tests passed");

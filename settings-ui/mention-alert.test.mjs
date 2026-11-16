// Run: node settings-ui/mention-alert.test.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./mention-alert.js", import.meta.url), "utf8");
const context = {};
vm.createContext(context);
vm.runInContext(source, context, { filename: "mention-alert.js" });
const apply = context.mentionAlertForm.applyMentionAlertToggle;

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else {
    failures++;
    console.error("FAIL  " + msg);
  }
}

const off = apply({ mention_alert: false, mention_alert_sound: false, mention_alert_popup: false }, false);
assert(!off.soundEnabled && !off.popupEnabled && !off.idle, "a master that is off disables the other switches");
assert(!off.state.mention_alert_sound && !off.state.mention_alert_popup, "turning nothing on leaves the stored switches alone");

const armed = apply({ mention_alert: true, mention_alert_sound: false, mention_alert_popup: false }, true);
assert(armed.state.mention_alert && armed.state.mention_alert_sound && armed.state.mention_alert_popup,
  "turning the master on enables the sound and the popup");
assert(armed.soundEnabled && armed.popupEnabled && !armed.idle, "both switches are usable after the master is turned on");

const soundOnly = apply({ mention_alert: true, mention_alert_sound: true, mention_alert_popup: false }, false);
assert(soundOnly.state.mention_alert_sound && !soundOnly.state.mention_alert_popup && !soundOnly.idle,
  "leaving the master on does not turn a switch back on");

const idle = apply({ mention_alert: true, mention_alert_sound: false, mention_alert_popup: false }, false);
assert(idle.idle, "sound and popup both off is the idle hint");

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall mention alert form tests passed");

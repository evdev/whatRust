// Run: node settings-ui/mention-alert.test.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./mention-alert.js", import.meta.url), "utf8");
const context = {};
vm.createContext(context);
vm.runInContext(source, context, { filename: "mention-alert.js" });
const form = context.mentionAlertForm;

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else {
    failures++;
    console.error("FAIL  " + msg);
  }
}

const fresh = form.blankPrefs();
assert(!fresh.mentions && !fresh.replies && !fresh.direct && !fresh.everyone, "a new account alerts on nothing");
assert(fresh.sound && fresh.popup && !fresh.sound_file, "sound and popup are ready for the first type");

const off = form.viewMentionAccount(fresh);
assert(off.typesOff && !off.soundEnabled && !off.popupEnabled && !off.fileVisible && !off.idle,
  "with every type off the delivery switches do nothing");

const legacyOff = form.legacyPrefs({ mention_alert: false, mention_alert_sound: true, mention_alert_popup: true });
assert(!legacyOff.mentions && !legacyOff.everyone && legacyOff.sound && legacyOff.popup,
  "an old master switch that is off leaves every type off");
const legacyOn = form.legacyPrefs({
  mention_alert: true,
  mention_alert_sound: false,
  mention_alert_popup: true,
  mention_alert_sound_file: "mention-alert.mp3",
});
assert(legacyOn.mentions && legacyOn.replies && legacyOn.direct && !legacyOn.everyone, "an old master switch turns on the three original types");
assert(!legacyOn.sound && legacyOn.popup && !legacyOn.sound_file, "the old sound and popup switches are kept");

const shown = form.viewMentionAccount({ mentions: true, sound: true, popup: false });
assert(shown.prefs.mentions && shown.fileVisible && !shown.idle && shown.soundEnabled,
  "one enabled type uses the sound and popup switches as they are");
const idle = form.viewMentionAccount({ mentions: true, sound: false, popup: false });
assert(idle.idle && !idle.fileVisible, "sound and popup both off is the idle hint");

assert(form.builtinName("default") === "Built-in chime", "the first account keeps the original chime");
assert(form.builtinName("acct-1") === "Built-in bell", "the next account has a different built-in");
assert(form.builtinName("acct-2") === "Built-in ping", "the third account has its own built-in");
assert(form.builtinName("acct-3") === "Built-in tone", "the fourth account has its own built-in");
assert(form.builtinName("acct-4") === "Built-in bell", "later accounts repeat the extra tones");
assert(form.builtinIndex("acct-1") !== form.builtinIndex("default"), "two accounts do not share a built-in by default");

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall mention alert form tests passed");

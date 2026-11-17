/* Form rules for one account's mention alert. Delivery still follows the
 * Rust truth table: a matched type with the popup on shows the popup, and
 * the sound switch decides whether that also plays. With every type off, or
 * with sound and popup both off, the alert does nothing. Keep builtinIndex
 * in step with mention_sound::builtin_index. */
(function (root) {
  "use strict";

  var BUILTIN = ["Built-in chime", "Built-in bell", "Built-in ping", "Built-in tone"];

  function blankPrefs() {
    return {
      mentions: false,
      replies: false,
      direct: false,
      everyone: false,
      sound: true,
      popup: true,
      sound_file: null,
    };
  }

  function normalizePrefs(raw) {
    var next = blankPrefs();
    if (!raw) return next;
    next.mentions = !!raw.mentions;
    next.replies = !!raw.replies;
    next.direct = !!raw.direct;
    next.everyone = !!raw.everyone;
    next.sound = !!raw.sound;
    next.popup = !!raw.popup;
    next.sound_file = raw.sound_file || null;
    return next;
  }

  function legacyPrefs(settings) {
    var on = !!(settings && settings.mention_alert);
    return {
      mentions: on,
      replies: on,
      direct: on,
      everyone: false,
    sound: !settings || settings.mention_alert_sound !== false,
    popup: !settings || settings.mention_alert_popup !== false,
    // The shared file is copied per account in Rust. Putting its old name here
    // would not play, and a later save would look like the sound was cleared.
    sound_file: null,
  };
  }

  function builtinIndex(accountId) {
    if (!accountId || accountId === "default") return 0;
    var match = /^acct-(\d+)$/.exec(accountId);
    if (!match) return 1;
    var n = parseInt(match[1], 10);
    if (!n) return 1;
    return ((n - 1) % 3) + 1;
  }

  function builtinName(accountId) {
    return BUILTIN[builtinIndex(accountId)] || BUILTIN[0];
  }

  function viewMentionAccount(prefs) {
    var next = normalizePrefs(prefs);
    var typesOn = next.mentions || next.replies || next.direct || next.everyone;
    return {
      prefs: next,
      typesOn: typesOn,
      soundEnabled: typesOn,
      popupEnabled: typesOn,
      idle: typesOn && !next.sound && !next.popup,
      typesOff: !typesOn,
      fileVisible: typesOn && next.sound,
    };
  }

  root.mentionAlertForm = {
    blankPrefs: blankPrefs,
    normalizePrefs: normalizePrefs,
    legacyPrefs: legacyPrefs,
    builtinIndex: builtinIndex,
    builtinName: builtinName,
    viewMentionAccount: viewMentionAccount,
  };
})(typeof window !== "undefined" ? window : globalThis);

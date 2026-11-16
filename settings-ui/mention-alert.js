/* Form rules for the mention alert switches. The delivery truth table lives
 * in Rust (`mention_alert_plan`). Turning the master switch on enables the
 * sound and the popup; either can then be turned off. While the master is
 * off, the other two do nothing. */
(function (root) {
  "use strict";

  function applyMentionAlertToggle(state, turnedOn) {
    var next = {
      mention_alert: !!(state && state.mention_alert),
      mention_alert_sound: !!(state && state.mention_alert_sound),
      mention_alert_popup: !!(state && state.mention_alert_popup),
    };
    if (turnedOn) {
      next.mention_alert = true;
      next.mention_alert_sound = true;
      next.mention_alert_popup = true;
    }
    return {
      soundEnabled: next.mention_alert,
      popupEnabled: next.mention_alert,
      idle: next.mention_alert && !next.mention_alert_sound && !next.mention_alert_popup,
      state: next,
    };
  }

  root.mentionAlertForm = { applyMentionAlertToggle: applyMentionAlertToggle };
})(typeof window !== "undefined" ? window : globalThis);

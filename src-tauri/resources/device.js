/* Source-device icon beside each message time.
 *
 * The sending client is not a field WhatsApp shows, but it is baked into the
 * message id. The shapes below are the ones Baileys' getDevice and the
 * WhatsApp Plus extension both key off:
 *
 *   Apple (iPhone, and the Mac companion, which shares this generator) — prefix "3A"
 *   Computer — WhatsApp Web is "3E" plus 20 more characters ("3EB0" + 18 hex),
 *              WhatsApp Desktop is prefix "3F" or an 18-character id
 *   Android — 21 characters, 32 characters, or anything longer than 22 that
 *             is not the desktop "3F" prefix
 *
 * Length is checked before the "3A" prefix on purpose. Android ids are random,
 * so about 1 in 256 of them start with 3A; a long id is Android anyway.
 * Anything that matches none of these stays unmarked.
 *
 * Current WhatsApp Web puts the bare message id on the row's data-id.
 * Older builds use "true_<chat>_<id>" (and a trailing "_<participant>" in groups).
 */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  if (!root.location || root.location.origin !== "https://web.whatsapp.com") return;

  var enabled = root.__WHATRUST_DEVICE !== false;

  function L(pt, en) {
    return root.__WR_LANG === "en" ? en : pt;
  }

  function label(kind) {
    if (kind === "apple") return L("Enviada de um aparelho Apple", "Sent from an Apple device");
    if (kind === "android") return L("Enviada de um Android", "Sent from Android");
    if (kind === "computer") return L("Enviada de um computador", "Sent from a computer");
    return "";
  }

  // Order matters. See the file header.
  function deviceOf(id) {
    if (typeof id !== "string" || !id) return "";
    if (id.length > 22 && id.indexOf("3F") !== 0) return "android";
    if (id.indexOf("3F") === 0) return "computer";
    if (id.indexOf("3A") === 0) return "apple";
    if (/^3E.{20}$/.test(id)) return "computer";
    if (id.length === 21 || id.length === 32) return "android";
    if (id.length === 18) return "computer";
    return "";
  }

  function messageToken(value) {
    if (typeof value !== "string" || !value) return "";
    var legacy = /^(?:true|false)_([^_]+@[^_]+)_(.+)$/.exec(value);
    if (legacy) {
      var rest = legacy[2];
      var cut = rest.lastIndexOf("_");
      if (cut > 0 && /^[^_@]+@[^_]+$/.test(rest.slice(cut + 1))) return rest.slice(0, cut);
      return rest;
    }
    if (/^[0-9A-Za-z]{16,80}$/.test(value)) return value;
    return "";
  }

  function attr(node, name) {
    if (!node || !node.getAttribute) return "";
    return node.getAttribute(name) || "";
  }

  function normTime(value) {
    return String(value || "")
      .replace(/[\u200e\u200f\u200b\u2066-\u2069]/g, "")
      .replace(/[\s\u00a0\u202f]+/g, " ")
      .trim()
      .toUpperCase();
  }

  function rawPlain(row) {
    var plain = attr(row, "data-pre-plain-text");
    if (plain) return plain;
    var node = row.querySelector && row.querySelector("[data-pre-plain-text]");
    return node ? attr(node, "data-pre-plain-text") : "";
  }

  function timeFromPlain(row) {
    var match = /^\[(\d{1,2}:\d{2}(?: [AP]M)?)/.exec(normTime(rawPlain(row)));
    return match ? match[1] : "";
  }

  function isLeaf(el) {
    return !el.children || el.children.length === 0;
  }

  function clockSpan(row) {
    if (!row || !row.querySelectorAll) return null;
    var expected = timeFromPlain(row);
    var nodes = row.querySelectorAll("span, div");
    var last = null;
    var matched = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isLeaf(el) || attr(el, "data-wr-device")) continue;
      var text = normTime(el.textContent);
      if (!/^\d{1,2}:\d{2}( ?[AP]M)?$/.test(text)) continue;
      last = el;
      if (expected && text === expected) matched = el;
    }
    if (expected) return matched;
    return last;
  }

  function nestedMessage(node, main) {
    var parent = node.parentElement;
    while (parent && parent !== main) {
      if (messageToken(attr(parent, "data-id"))) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function messageNodes(main) {
    if (!main || !main.querySelectorAll) return [];
    var all = main.querySelectorAll("[data-id]");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (!messageToken(attr(all[i], "data-id"))) continue;
      if (nestedMessage(all[i], main)) continue;
      out.push(all[i]);
    }
    return out;
  }

  function svgEl(paths) {
    var doc = root.document;
    if (!doc || typeof doc.createElementNS !== "function") return null;
    var svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (svg.style) svg.style.display = "block";
    for (var i = 0; i < paths.length; i++) {
      var path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "currentColor");
      if (paths[i].rule) path.setAttribute("fill-rule", paths[i].rule);
      path.setAttribute("d", paths[i].d);
      svg.appendChild(path);
    }
    return svg;
  }

  var GLYPH = {
    apple: [{ d: "M16.37 1.43c0 1.14-.5 2.27-1.18 3.08-.74.9-1.99 1.57-2.99 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.57-2.27 1.2-2.98.81-.94 2.15-1.64 3.25-1.68.03.13.06.28.06.43zM20.94 17.14c-.03.07-.46 1.58-1.52 3.12-.94 1.37-1.94 2.73-3.43 2.76-1.47.03-1.94-.87-3.62-.87-1.68 0-2.2.84-3.59.9-1.41.06-2.48-1.48-3.43-2.84-1.86-2.7-3.28-7.63-1.37-10.96.94-1.64 2.63-2.68 4.46-2.71 1.4-.03 2.71.94 3.57.94.85 0 2.45-1.16 4.13-1 .7.03 2.67.28 3.93 2.13-.1.06-2.35 1.37-2.32 4.1.03 3.26 2.86 4.35 2.89 4.36z" }],
    android: [{ d: "M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.3-.16-.69-.04-.85.26l-1.87 3.24a11.43 11.43 0 0 0-8.92 0L6.67 5.71c-.16-.3-.55-.42-.85-.26-.3.16-.42.55-.26.85l1.84 3.18C4.2 10.86 2.5 13.27 2 16.5h20c-.5-3.23-2.2-5.64-4.4-7.02zM8.2 14.2a1.15 1.15 0 1 1 0-2.3 1.15 1.15 0 0 1 0 2.3zm7.6 0a1.15 1.15 0 1 1 0-2.3 1.15 1.15 0 0 1 0 2.3z" }],
    computer: [{ d: "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v10h16V5H4z", rule: "evenodd" }],
  };

  function timeColor(clock) {
    try {
      if (typeof root.getComputedStyle !== "function") return "";
      return root.getComputedStyle(clock).color || "";
    } catch (e) {
      return "";
    }
  }

  function iconElement(kind, clock) {
    var doc = root.document;
    var span = doc.createElement("span");
    span.setAttribute("data-wr-device", kind);
    span.setAttribute("title", label(kind));
    span.setAttribute("aria-hidden", "true");
    span.style.cssText = "display:inline-flex;align-items:center;align-self:center;width:13px;height:13px;margin-inline-end:3px;flex:none;color:inherit;user-select:none;line-height:0";
    var color = timeColor(clock);
    if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") span.style.color = color;
    var graphic = svgEl(GLYPH[kind] || []);
    if (graphic) span.appendChild(graphic);
    return span;
  }

  function paint(node) {
    if (!node || !node.getAttribute) return;
    var kind = enabled ? deviceOf(messageToken(attr(node, "data-id"))) : "";
    var existing = node.querySelector && node.querySelector("[data-wr-device]");
    if (!kind) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    var clock = clockSpan(node);
    if (!clock || !clock.parentNode) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing && existing.getAttribute("data-wr-device") === kind && existing.nextSibling === clock) return;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    clock.parentNode.insertBefore(iconElement(kind, clock), clock);
  }

  function conversation() {
    var doc = root.document;
    if (!doc || !doc.getElementById) return null;
    var main = doc.getElementById("main");
    if (main) return main;
    var sample = doc.querySelector && doc.querySelector("[data-pre-plain-text]");
    if (!sample) return null;
    var node = sample.parentElement;
    for (var i = 0; node && node !== doc.body && i < 12; i++) {
      if (node.scrollHeight > node.clientHeight + 40) return node;
      node = node.parentElement;
    }
    return null;
  }

  function scan() {
    var main = conversation();
    if (!main || !main.querySelectorAll) return;
    var nodes = messageNodes(main);
    var seen = [];
    for (var i = 0; i < nodes.length; i++) {
      paint(nodes[i]);
      var icon = nodes[i].querySelector && nodes[i].querySelector("[data-wr-device]");
      if (icon) seen.push(icon);
    }
    var icons = main.querySelectorAll("[data-wr-device]");
    for (var j = 0; j < icons.length; j++) {
      if (seen.indexOf(icons[j]) === -1 && icons[j].parentNode) icons[j].parentNode.removeChild(icons[j]);
    }
  }

  function relabel(scope) {
    var rootEl = scope || root.document;
    if (!rootEl || !rootEl.querySelectorAll) return;
    var nodes = rootEl.querySelectorAll("[data-wr-device]");
    for (var i = 0; i < nodes.length; i++) {
      var text = label(nodes[i].getAttribute("data-wr-device"));
      if (text) nodes[i].setAttribute("title", text);
    }
  }

  function setEnabled(on) {
    enabled = !!on;
  }

  if (root.__WHATRUST_TEST) {
    root.__whatrustDeviceApi = {
      deviceOf: deviceOf,
      messageToken: messageToken,
      messageNodes: messageNodes,
      clockSpan: clockSpan,
      paint: paint,
      scan: scan,
      conversation: conversation,
      label: label,
      relabel: relabel,
      setEnabled: setEnabled,
      isEnabled: function () { return enabled; },
    };
    return;
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      scan();
    }, 120);
  }

  root.__whatrustDevicePrefs = function (on) {
    setEnabled(on);
    scan();
  };

  var previousRelang = root.__wrRelang;
  root.__wrRelang = function () {
    if (typeof previousRelang === "function") previousRelang();
    relabel(root.document);
  };

  var armed = false;
  function arm() {
    if (armed || !root.document || !root.document.documentElement) return;
    armed = true;
    new MutationObserver(schedule).observe(root.document.documentElement, { childList: true, subtree: true });
    root.document.addEventListener("scroll", schedule, true);
    scan();
  }

  (function wait() {
    if (root.document && root.document.getElementById && root.document.getElementById("main")) arm();
    else setTimeout(wait, 400);
  })();
})();

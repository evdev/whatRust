import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const window = { __WHATRUST_TEST: true };
vm.runInNewContext(readFileSync(new URL("./message-actions.js", import.meta.url), "utf8"), {
  window, location: { origin: "https://web.whatsapp.com" }
});
const classify = window.__wrMessageActionClassify;
assert.equal(classify("+1 (303) 555-0123").kind, "phone");
assert.equal(classify("orders+test@example.com").kind, "email");
assert.equal(classify("123 Main St, Denver, CO 80202").kind, "address");
assert.equal(classify("https://example.com/3035550123"), null);
assert.equal(classify("2026-11-25"), null);
assert.equal(classify("441234567890"), null);
assert.equal(classify("+44 20 7946 0958").kind, "phone");
console.log("message action recognition passed");

// Simulate WhatsApp removing its menu during pointerdown on a companion button.
const listeners = {};
const scheduled = [];
const opened = [];
let activeMenu = null;
let panel = null;
const row = { contains: () => false };
const target = { textContent: "+1 (303) 555-0123", closest: () => row };
const makeElement = () => ({
  style: {}, children: [], isConnected: true, handlers: {},
  setAttribute() {},
  appendChild(child) { this.children.push(child); },
  addEventListener(name, handler) { this.handlers[name] = handler; },
  getBoundingClientRect() { return { left: 50, top: 50, right: 250, bottom: 90, width: 200, height: 40 }; },
  getClientRects() { return this.isConnected ? [1] : []; },
  contains() { return false; },
  remove() { this.isConnected = false; }
});
const doc = {
  documentElement: { getAttribute: () => "off" },
  body: { appendChild(node) { panel = node; } },
  createElement: makeElement,
  addEventListener(name, fn) { listeners[name] = fn; },
  querySelectorAll() { return activeMenu ? [activeMenu] : []; }
};
const root = {
  __WR_MESSAGE_ACTIONS: true, __WR_LANG: "en", __whatrustLocked: false,
  getSelection: () => null, open: (url) => opened.push(url)
};
class Observer { observe() {} }
vm.runInNewContext(readFileSync(new URL("./message-actions.js", import.meta.url), "utf8"), {
  window: root, document: doc, location: { origin: "https://web.whatsapp.com" },
  MutationObserver: Observer, innerWidth: 900, innerHeight: 600,
  setTimeout: fn => { scheduled.push(fn); return scheduled.length; }, clearTimeout() {}
});
let suppressed = false;
listeners.pointerdown({ target, button: 0, clientX: 50, clientY: 50,
  preventDefault() { suppressed = true; }, stopPropagation() { suppressed = true; } });
assert.equal(suppressed, false, "WhatsApp receives the original gesture");
activeMenu = makeElement();
activeMenu.textContent = "Copy phone number";
activeMenu.closest = () => null;
scheduled.shift()();
scheduled.shift()();
assert.equal(panel.children.length, 1);
assert.deepEqual(panel.children.map(child => child.textContent), ["Open dialer"]);
panel.children[0].handlers.pointerdown({ type: "pointerdown", button: 0, preventDefault() {}, stopPropagation() {} });
assert.deepEqual(opened, ["tel:+13035550123"]);
assert.equal(panel.isConnected, false);
assert.equal(activeMenu.isConnected, true, "WhatsApp menu is untouched");
console.log("message action menu interaction passed");
activeMenu = makeElement();
activeMenu.textContent = "ReplyReply privatelyCopyReactForward";
activeMenu.closest = () => null;
row.contains = () => true;
root.getSelection = () => ({ anchorNode: {}, focusNode: {}, toString: () => "123 Main St, Denver, CO" });
listeners.pointerdown({ target, button: 2, clientX: 50, clientY: 50,
  preventDefault() { throw new Error("WhatsApp gesture was suppressed"); },
  stopPropagation() { throw new Error("WhatsApp gesture was suppressed"); } });
assert.equal(scheduled.length, 0, "right-clicking an address does not add a menu");
assert.equal(activeMenu.isConnected, true, "WhatsApp menu remains intact");
console.log("address right-click leaves WhatsApp menu alone");
activeMenu = makeElement();
activeMenu.textContent = "Reply Copy Forward";
activeMenu.closest = () => null;
root.getSelection = () => ({ anchorNode: {}, focusNode: {}, toString: () => "test+sample@example.com" });
listeners.pointerdown({ target, button: 2, clientX: 50, clientY: 50,
  preventDefault() { throw new Error("WhatsApp gesture was suppressed"); },
  stopPropagation() { throw new Error("WhatsApp gesture was suppressed"); } });
scheduled.shift()();
scheduled.shift()();
assert.equal(panel.children[0].textContent, "Compose email");
panel.children[0].handlers.pointerdown({ type: "pointerdown", button: 0, preventDefault() {}, stopPropagation() {} });
assert.equal(opened[1], "mailto:test%2Bsample@example.com");
console.log("email action beside existing menu passed");

// Highlighting must leave the original text nodes and native links in place.
const storedHighlights = new Map();
const decorationListeners = {};
const clickedUrls = [];
const checkedDates = [];
const reviewed = [];
const scans = [];
const observers = [];
const mutations = [];
const scroller = { nodeType: 1, clientHeight: 480, overflowY: "auto", parentElement: null, closest: () => null };
const bodySelector = "[data-id] [data-pre-plain-text] .selectable-text";
function makeBody(text) {
  const body = { nodeType: 1, parentElement: scroller, isConnected: true,
    matches: selector => selector === bodySelector || selector === ".selectable-text",
    querySelectorAll: () => [], closest: selector => selector === bodySelector ? body : null };
  body.text = { nodeType: 3, nodeValue: text, isConnected: true, parentElement: body };
  return body;
}
const visible = makeBody("1600 Pennsylvania Ave, Washington, DC 20500 | 845-285-2800");
const approaching = makeBody("123 Main St | 303-555-0123");
const distant = makeBody("456 Elm St | 202-555-0190");
const rows = [visible, approaching, distant];
let main = { contains: element => element === scroller || rows.includes(element), querySelectorAll: () => rows };
let resize;
class Intersection {
  constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
  observe(body) { this.targets.add(body); }
  unobserve(body) { this.targets.delete(body); }
  disconnect() { this.targets.clear(); }
  move(...entries) { this.callback(entries.map(([target, isIntersecting]) => ({ target, isIntersecting }))); }
}
class Changes extends Observer {
  constructor(callback) { super(); mutations.push(callback); }
  disconnect() {}
}
const decorationDoc = {
  documentElement: { getAttribute: () => "off", appendChild() {} },
  body: { appendChild() {} },
  createElement: makeElement,
  getElementById: () => main,
  createTreeWalker(body) { scans.push(body); let done = false; return { nextNode() { if (done) return null; done = true; return body.text; } }; },
  createRange() { return { setStart(node, offset) { this.node = node; this.start = offset; }, setEnd(node, offset) { this.end = offset; }, getClientRects() { return [{ left: 10, right: 200, top: 10, bottom: 30 }]; } }; },
  caretRangeFromPoint() { return { startContainer: visible.text, startOffset: 8 }; },
  addEventListener(name, fn) { decorationListeners[name] = fn; },
  querySelectorAll: () => []
};
const decorationWindow = {
  __WR_MESSAGE_ACTIONS: true, CSS: { highlights: storedHighlights }, Highlight: Set, IntersectionObserver: Intersection,
  ResizeObserver: class extends Observer { constructor(callback) { super(); resize = callback; } disconnect() {} },
  getComputedStyle: element => ({ overflowY: element.overflowY || "visible" }), addEventListener() {},
  getSelection: () => ({ isCollapsed: true }), open: url => clickedUrls.push(url),
  __wrCalendarActions: {
    matches(text) {
      checkedDates.push(text);
      return {
        found: text.startsWith("December") ? [{ kind: "calendar", start: 0, end: text.length, phrase: text }] : [],
        needsSent: false
      };
    },
    review(match) { reviewed.push(match.phrase); },
    dismiss() {}
  }
};
vm.runInNewContext(readFileSync(new URL("./message-actions.js", import.meta.url), "utf8"), {
  window: decorationWindow, document: decorationDoc, location: { origin: "https://web.whatsapp.com" },
  MutationObserver: Changes, NodeFilter: { SHOW_TEXT: 4 }, setTimeout, clearTimeout
});
assert.equal(scans.length, 0, "opening chat only registers bodies, it does not read their text");
assert.equal(observers[0].options.root, scroller, "the margin applies to the inner chat scrollport");
assert.equal(observers[0].options.rootMargin, "480px 0px");
observers[0].move([visible, true], [approaching, true], [distant, false]);
assert.deepEqual(scans, [visible, approaching]);
assert.deepEqual(checkedDates, [visible.text.nodeValue, approaching.text.nodeValue]);
const highlighted = () => [...storedHighlights.get("whatrust-message-actions")].map(range => range.node.nodeValue.slice(range.start, range.end));
assert.deepEqual(highlighted(), ["1600 Pennsylvania Ave, Washington, DC 20500", "845-285-2800", "123 Main St", "303-555-0123"]);
const addressClick = { button: 0, detail: 1, clientX: 30, clientY: 20, target: { closest: selector => selector === "#main [data-id]" ? {} : null }, preventDefault() { throw Error("native action suppressed"); }, stopPropagation() { throw Error("native action suppressed"); } };
decorationListeners.click(addressClick);
assert.deepEqual(clickedUrls, ["https://www.google.com/maps/search/?api=1&query=1600%20Pennsylvania%20Ave%2C%20Washington%2C%20DC%2020500"]);
decorationListeners.click({ ...addressClick, clientY: 50 });
assert.equal(clickedUrls.length, 1, "clicks outside the address do not open Maps");
decorationWindow.getSelection = () => ({ isCollapsed: false, toString: () => "selected text" });
decorationListeners.click(addressClick);
assert.equal(clickedUrls.length, 1, "selecting text does not open Maps");

const updateBodies = mutations[0];
distant.text.nodeValue = "789 Walnut Ave";
approaching.text.nodeValue = "125 Main St";
updateBodies([{ type: "characterData", target: distant.text }, { type: "characterData", target: approaching.text }]);
assert.deepEqual(scans, [visible, approaching, approaching], "an edit scans that bubble only if it is in the buffer");
observers[0].move([visible, false], [approaching, false], [distant, true]);
assert.deepEqual(highlighted(), ["789 Walnut Ave"], "a scroll jump only activates the destination and drops previous highlights");
decorationWindow.getSelection = () => ({ isCollapsed: true });
decorationListeners.click(addressClick);
assert.equal(clickedUrls.length, 1, "a scrolled-out address no longer has a click action");
observers[0].move([visible, true]);
assert.deepEqual(scans, [visible, approaching, approaching, distant], "scrolling back reuses matches for unchanged bubbles");
assert.equal(highlighted().length, 3);

const newMessage = makeBody("987 High St");
rows.push(newMessage);
rows.splice(rows.indexOf(approaching), 1);
updateBodies([{ type: "childList", target: scroller, addedNodes: [newMessage], removedNodes: [approaching] }]);
assert.deepEqual([...observers[0].targets], [visible, distant, newMessage]);
assert.equal(scans.length, 4, "a newly loaded offscreen message is registered without parsing it");
scroller.clientHeight = 640;
resize();
assert.equal(observers[1].options.rootMargin, "640px 0px");
observers[0].move([newMessage, true]);
assert.equal(scans.length, 4, "stale intersection notifications are ignored after resize");
observers[1].move([newMessage, true]);
assert.equal(scans.at(-1), newMessage);

visible.text.nodeValue = "December 4, 2026 at 3 PM";
updateBodies([{ type: "characterData", target: visible.text }]);
decorationListeners.click(addressClick);
assert.deepEqual(reviewed, [visible.text.nodeValue], "the exact calendar highlight opens the review");
assert.equal(clickedUrls.length, 1, "review does not launch an external handler");

main = null;
updateBodies([{ type: "childList", target: decorationDoc.documentElement, addedNodes: [], removedNodes: [] }]);
assert.equal(observers[1].targets.size, 0);
assert.deepEqual(highlighted(), [], "switching away from the chat clears its highlights");
decorationWindow.__wrMessageActionsPrefs(false);
assert.equal(storedHighlights.size, 0);
console.log("address and phone recognition checks nearby messages and caches unchanged results");
let readyCallback;
const earlyDoc = { documentElement: null, addEventListener(name, callback) { assert.equal(name, "DOMContentLoaded"); readyCallback = callback; } };
vm.runInNewContext(readFileSync(new URL("./message-actions.js", import.meta.url), "utf8"), {
  window: {}, document: earlyDoc, location: { origin: "https://web.whatsapp.com" }
});
assert.equal(typeof readyCallback, "function", "initialization waits for the document");
console.log("early injection waits for the document");

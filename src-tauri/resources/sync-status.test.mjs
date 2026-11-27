// Run: node --test src-tauri/resources/sync-status.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./sync-status.js", import.meta.url), "utf8");
const bridge = fs.readFileSync(new URL("./bridge.js", import.meta.url), "utf8");

function load() {
  const sandbox = {
    __WHATRUST_SYNC_TEST: true,
    Object,
    String,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "sync-status.js" });
  return sandbox.__wrSyncStatus;
}

function liveSocket(overrides = {}) {
  return {
    conn: {
      isOnline: () => (overrides.online === undefined ? true : overrides.online),
      getStreamData: () => overrides.stream || { mode: "MAIN", info: "NORMAL" },
    },
    whatsapp: {
      enums: {
        SOCKET_STATE: { CONNECTED: 1, TIMEOUT: 2, OPENING: 3, CONFLICT: 4 },
        SOCKET_STREAM: { CONNECTED: 1, DISCONNECTED: 2, RESUMING: 3 },
      },
      Socket: overrides.socket === null ? undefined : {
        state: overrides.state === undefined ? 1 : overrides.state,
        stream: overrides.transport,
      },
    },
  };
}

test("bridge exposes the recovery hook the offline bar calls", () => {
  assert.match(bridge, /window\.__whatrustRecoverConnection\s*=\s*function/);
});

test("a connected socket is live and a dead one is not", () => {
  const api = load();
  function reading(value, live, pending) {
    assert.equal(value.live, live);
    assert.equal(value.pending, pending);
  }
  reading(api.connectionReading(liveSocket()), true, false);
  reading(api.connectionReading(liveSocket({ online: false })), false, false);
  reading(api.connectionReading(liveSocket({ state: 2 })), false, false);
  reading(api.connectionReading(liveSocket({ transport: 2 })), false, false);
  reading(api.connectionReading(liveSocket({ transport: 3 })), false, true);
  reading(api.connectionReading(liveSocket({ state: 3 })), false, true);
  assert.equal(api.connectionReading(null), null);
  reading(
    api.connectionReading({ conn: { isOnline: () => true, getStreamData: () => ({ mode: "OFFLINE", info: "OFFLINE" }) } }),
    false,
    false
  );
});

test("whatsapp's own offline copy counts, a chat quoting it does not", () => {
  const api = load();
  const alert = {
    textContent: "Your computer is not connected. Click to reconnect.",
    closest: () => null,
  };
  const quoted = {
    textContent: "Your computer is not connected",
    closest: (sel) => (sel.includes("#main") ? {} : null),
  };
  const ours = {
    textContent: "WhatsApp is offline.",
    closest: (sel) => (sel.includes("__whatrust_sync") ? {} : null),
  };
  const doc = {
    querySelectorAll: () => [alert, quoted, ours],
  };
  assert.equal(api.pageSaysOffline(doc), true);
  doc.querySelectorAll = () => [quoted, ours];
  assert.equal(api.pageSaysOffline(doc), false);
});

test("the login screen is not treated as a signed-in session", () => {
  const api = load();
  const ids = new Set(["pane-side"]);
  const doc = {
    getElementById: (id) => (ids.has(id) ? {} : null),
    querySelector: (sel) => (sel.includes("qrcode") ? {} : null),
  };
  assert.equal(api.chatsOpen(doc), false);
  doc.querySelector = () => null;
  assert.equal(api.chatsOpen(doc), true);
  ids.delete("pane-side");
  assert.equal(api.chatsOpen(doc), false);
});

test("a minute of timer clamp is not sleep, and a long freeze is", () => {
  const api = load();
  let state = api.noteTick(api.initialState(), 1_000, api.LIMITS.stallMs);
  state = api.noteTick(state, 1_000 + 60_000, api.LIMITS.stallMs);
  assert.equal(state.wakeAt, null);
  state = api.noteTick(state, 1_000 + 60_000 + api.LIMITS.stallMs, api.LIMITS.stallMs);
  assert.equal(state.wakeAt, 1_000 + 60_000 + api.LIMITS.stallMs);
  assert.equal(state.sawLiveEvent, false);
});

test("a night away shows the reconnect bar as soon as the clock jumps", () => {
  const api = load();
  const limits = api.LIMITS;
  let state = api.noteLoggedIn(api.initialState(), true);
  state = api.noteReading(state, { live: true, pending: false }, 0, false);
  state = api.noteTick(state, 0, limits.stallMs);
  const morning = 8 * 60 * 60 * 1000;
  state = api.noteTick(state, morning, limits.stallMs);
  assert.equal(api.assess(state, morning, limits), "stale");
  assert.equal(api.assess(state, morning + limits.graceMs, limits), "stale");
  state = api.noteDismiss(state, morning + limits.graceMs, limits);
  assert.equal(api.assess(state, morning + limits.graceMs, limits), "hidden");
  const droppedAt = morning + limits.graceMs + 1000;
  state = api.noteReading(state, { live: false, pending: false }, droppedAt, false);
  assert.equal(api.assess(state, droppedAt + limits.holdMs, limits), "offline");
});

test("a live event or later socket traffic clears the stale warning", () => {
  const api = load();
  const limits = api.LIMITS;
  let state = api.noteLoggedIn(api.initialState(), true);
  state = api.noteReading(state, { live: true, pending: false }, 0, false);
  state = api.noteTick(state, 0, limits.stallMs);
  state = api.noteTick(state, limits.stallMs, limits.stallMs);
  const wake = state.wakeAt;
  state = api.noteTraffic(state, wake);
  assert.equal(api.assess(state, wake + limits.graceMs, limits), "stale");
  state = api.noteTraffic(state, wake + limits.trafficSettleMs);
  assert.equal(api.assess(state, wake + limits.graceMs, limits), "hidden");

  state = api.noteTick(state, wake + limits.graceMs + limits.stallMs, limits.stallMs);
  const again = state.wakeAt;
  state = api.noteReading(state, { live: true, pending: false }, again, true);
  assert.equal(api.assess(state, again + limits.graceMs, limits), "hidden");
});

test("hiding the window overnight is a stall; a short hide is not", () => {
  const api = load();
  const limits = api.LIMITS;
  let state = api.noteVisibility(api.initialState(), true, 0, limits.hiddenStallMs);
  state = api.noteVisibility(state, false, 60_000, limits.hiddenStallMs);
  assert.equal(state.wakeAt, null);
  state = api.noteVisibility(state, true, 120_000, limits.hiddenStallMs);
  state = api.noteVisibility(state, false, 120_000 + limits.hiddenStallMs, limits.hiddenStallMs);
  assert.equal(state.wakeAt, 120_000 + limits.hiddenStallMs);
});

test("a handshake still in progress is not called stale, and a stuck one is offline", () => {
  const api = load();
  const limits = api.LIMITS;
  let state = api.noteLoggedIn(api.initialState(), true);
  state = api.noteTick(state, 0, limits.stallMs);
  state = api.noteTick(state, limits.stallMs, limits.stallMs);
  const wake = state.wakeAt;
  state = api.noteReading(state, { live: false, pending: true }, wake, false);
  assert.equal(api.assess(state, wake + limits.graceMs, limits), "hidden");
  assert.equal(api.assess(state, wake + limits.pendingHoldMs, limits), "offline");
});

test("the browser being offline and whatsapp's banner show immediately enough to act", () => {
  const api = load();
  const limits = api.LIMITS;
  let state = api.noteLoggedIn(api.initialState(), true);
  state = api.noteReading(state, { live: true, pending: false }, 0, false);
  state = api.noteBrowser(state, false, 0);
  assert.equal(api.assess(state, limits.browserHoldMs - 1, limits), "hidden");
  assert.equal(api.assess(state, limits.browserHoldMs, limits), "offline");
  state = api.noteBrowser(state, true, limits.browserHoldMs);
  state = api.noteDom(state, true);
  assert.equal(api.assess(state, limits.browserHoldMs, limits), "offline");
  state = api.noteLoggedIn(state, false);
  assert.equal(api.assess(state, limits.browserHoldMs, limits), "hidden");
});

test("the bar appears after a long idle and reconnect reloads the page", () => {
  let clock = 5_000;
  const timeouts = [];
  const calls = [];
  const ids = new Set(["pane-side"]);
  const listeners = {};
  function Node(tag) {
    this.tag = tag;
    this.children = [];
    this.hidden = false;
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this.textContent = "";
    this.isConnected = false;
  }
  Node.prototype.setAttribute = function (name, value) { this.attrs[name] = String(value); };
  Node.prototype.addEventListener = function (type, fn) { (this.listeners[type] ||= []).push(fn); };
  Node.prototype.appendChild = function (child) {
    child.parent = this;
    if (!this.children.includes(child)) this.children.push(child);
    child.isConnected = true;
    return child;
  };
  Node.prototype.attachShadow = function () {
    const shadow = new Node("#shadow");
    this.shadowRoot = shadow;
    return shadow;
  };
  const documentElement = new Node("html");
  documentElement.isConnected = true;
  const doc = {
    documentElement,
    visibilityState: "visible",
    createElement: (tag) => new Node(tag),
    getElementById: (id) => (ids.has(id) ? { id } : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  const target = {
    __WHATRUST_SYNC_TEST: true,
    __WR_LANG: "en",
    document: doc,
    navigator: { onLine: true },
    WPP: liveSocket(),
    addEventListener() {},
    Object,
    String,
    Promise,
    Array,
    setTimeout(fn, ms) { timeouts.push({ fn, ms }); },
    setInterval() {},
    __whatrustRecoverConnection() { calls.push("recover"); },
    __TAURI__: { core: { invoke: async (cmd, args) => { calls.push({ cmd, args }); return null; } } },
  };
  target.__WR_LANG = "en";
  target.Date = { now: () => clock };
  target.window = target;
  target.globalThis = target;
  target.__wrSyncStatus = null;
  vm.runInNewContext(source, target, { filename: "sync-status.js" });
  const api = target.__wrSyncStatus;
  try {
    api.mount(target);
    const host = documentElement.children.find((child) => child.id === "__whatrust_sync");
    assert.ok(host, "banner is mounted");
    assert.equal(host.hidden, true);
    clock += api.LIMITS.stallMs + 10;
    target.__wrSyncRefresh();
    assert.equal(host.hidden, true, "still inside the grace period");
    assert.ok(timeouts.some((timer) => timer.ms >= api.LIMITS.graceMs));
    clock += api.LIMITS.graceMs + 50;
    timeouts.at(-1).fn();
    assert.equal(host.hidden, false);
    const bar = host.shadowRoot.children.find((child) => child.children && child.children.length);
    const sentence = bar.children[0].textContent;
    const reconnect = bar.children[1];
    const dismiss = bar.children[2];
    assert.equal(sentence, "WhatsApp stopped syncing.");
    assert.equal(reconnect.textContent, "Reconnect");
    reconnect.listeners.click.forEach((fn) => fn({ stopPropagation() {} }));
    assert.ok(calls.includes("recover"));
    assert.ok(calls.some((call) => call.cmd === "report_sync_offline" && call.args.offline === true));
    dismiss.listeners.click.forEach((fn) => fn({ stopPropagation() {} }));
    assert.equal(host.hidden, true);
    const offlineCalls = calls.filter((call) => call.cmd === "report_sync_offline");
    assert.equal(offlineCalls.at(-1).args.offline, false, "dismissing a suspicion clears the tray too");
  } finally {
    clock = 0;
  }
});

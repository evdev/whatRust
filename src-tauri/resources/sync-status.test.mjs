// Run: node --test src-tauri/resources/sync-status.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { MessageChannel } from "node:worker_threads";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./sync-status.js", import.meta.url), "utf8");
const bridge = fs.readFileSync(new URL("./bridge.js", import.meta.url), "utf8");
const classicWorker = fs.readFileSync(new URL("./classic-worker.js", import.meta.url), "utf8");

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

test("bridge exposes the recovery hook the offline button calls", () => {
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
  reading(api.connectionReading(liveSocket({ state: 4 })), false, true);
  reading(api.connectionReading(liveSocket({ state: "FUTURE_STATE" })), false, true);
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
    closest: (sel) => (sel.includes("__whatrust_sync_tab") ? {} : null),
  };
  const hidden = { ...alert, getClientRects: () => [] };
  const doc = {
    querySelectorAll: () => [alert, quoted, ours, hidden],
  };
  assert.equal(api.pageSaysOffline(doc), true);
  doc.querySelectorAll = () => [quoted, ours, hidden];
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

test("a night away shows the reconnect button as soon as the clock jumps", () => {
  const api = load();
  const limits = api.LIMITS;
  let state = api.noteLoggedIn(api.initialState(), true);
  state = api.noteReading(state, { live: true, pending: false }, 0, false);
  state = api.noteTick(state, 0, limits.stallMs);
  const morning = 8 * 60 * 60 * 1000;
  state = api.noteTick(state, morning, limits.stallMs);
  assert.equal(api.assess(state, morning, limits), "hidden", "a living channel still has the prove window");
  assert.equal(api.assess(state, morning + limits.proveMs, limits), "stale");
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
  assert.equal(api.assess(state, again + limits.graceMs, limits), "stale", "staying connected is not a fresh socket");
  state = api.noteReading(state, { live: false, pending: true }, again, false);
  state = api.noteReading(state, { live: true, pending: false }, again, false);
  assert.equal(api.assess(state, again + limits.graceMs, limits), "hidden");
});

test("a connected session can sit quiet for an hour with no warning", () => {
  const api = load();
  const limits = api.LIMITS;
  let state = api.noteLoggedIn(api.initialState(), true);
  state = api.noteReading(state, { live: true, pending: false }, 0, false);
  state = api.noteTraffic(state, 0);
  for (let now = 0; now <= 60 * 60_000; now += 60_000) {
    state = api.noteTick(state, now, limits.stallMs);
    assert.equal(api.assess(state, now, limits), "hidden");
  }
});

test("only message ports attached to the WhatsApp worker count as sync traffic", { timeout: 2000 }, async (t) => {
  const api = load();
  class Worker extends EventTarget {
    messageListeners = 0;
    addEventListener(type, listener) {
      if (type === "message") this.messageListeners++;
      super.addEventListener(type, listener);
    }
    postMessage(message, options) {
      const ports = Array.isArray(options) ? options : options.transfer;
      this.remotePort = structuredClone(ports[0], { transfer: ports });
    }
  }
  const target = { MessageChannel, Worker };
  vm.runInNewContext(classicWorker, { window: target });
  // The bridge installs another Worker wrapper between these two scripts.
  const ClassicWorker = target.Worker;
  target.Worker = function (url, options) { return new ClassicWorker(url, options); };
  let hits = 0;
  api.watchSocketMessages(target, () => { hits++; });
  const worker = new target.Worker("https://web.whatsapp.com/static_resources/webworker_v1/init_script/");
  const other = new target.Worker("https://web.whatsapp.com/other.js");
  assert.equal(worker.messageListeners, 1);
  assert.equal(other.messageListeners, 0);

  async function receive(port, remote) {
    t.after(() => { port.close(); remote.close(); });
    const received = new Promise((resolve) => { port.onmessage = resolve; });
    remote.postMessage("test");
    assert.equal((await received).data, "test");
  }

  const unrelated = new target.MessageChannel();
  other.postMessage({}, [unrelated.port2]);
  await receive(unrelated.port1, other.remotePort);
  worker.dispatchEvent(new MessageEvent("message", { data: "worker_started" }));
  assert.equal(hits, 0);

  const outgoing = new target.MessageChannel();
  worker.postMessage({}, { transfer: [outgoing.port2] });
  await receive(outgoing.port1, worker.remotePort);
  assert.equal(hits, 1);

  const incoming = new MessageChannel();
  worker.dispatchEvent(new MessageEvent("message", { ports: [incoming.port1] }));
  worker.dispatchEvent(new MessageEvent("message", { ports: [incoming.port1] }));
  await receive(incoming.port1, incoming.port2);
  assert.equal(hits, 2, "the same port is observed once");
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
  state = api.noteVisibility(api.initialState(), true, 0, limits.hiddenStallMs);
  state = api.noteTraffic(state, limits.hiddenStallMs - 1);
  state = api.noteVisibility(state, false, limits.hiddenStallMs, limits.hiddenStallMs);
  assert.equal(state.wakeAt, null, "recent traffic proves the hidden account kept syncing");
});

test("a slow handshake is normal, and a stuck one is only suspected stale", () => {
  const api = load();
  const limits = api.LIMITS;
  let state = api.noteLoggedIn(api.initialState(), true);
  state = api.noteTick(state, 0, limits.stallMs);
  state = api.noteTick(state, limits.stallMs, limits.stallMs);
  const wake = state.wakeAt;
  state = api.noteReading(state, { live: false, pending: true }, wake, false);
  assert.equal(api.assess(state, wake + limits.graceMs, limits), "hidden");
  assert.equal(api.assess(state, wake + limits.pendingHoldMs, limits), "stale");
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

test("the rail reconnects and sends tray updates in order even if IPC is slow", async () => {
  let clock = 5_000;
  const timeouts = [];
  const calls = [];
  const pendingReports = [];
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
    this.title = "";
    this.isConnected = false;
  }
  Node.prototype.setAttribute = function (name, value) { this.attrs[name] = String(value); };
  Node.prototype.getAttribute = function (name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; };
  Node.prototype.addEventListener = function (type, fn) { (this.listeners[type] ||= []).push(fn); };
  Node.prototype.appendChild = function (child) {
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((node) => node !== child);
    }
    child.parentNode = this;
    this.children = this.children.filter((node) => node !== child);
    this.children.push(child);
    child.isConnected = true;
    return child;
  };
  Object.defineProperty(Node.prototype, "lastChild", { get() { return this.children[this.children.length - 1] || null; } });
  const documentElement = new Node("html");
  documentElement.isConnected = true;
  const stack = new Node("span");
  stack.setAttribute("data-wr-todo-stack", "native");
  documentElement.appendChild(stack);
  const doc = {
    documentElement: null,
    visibilityState: "visible",
    createElement: (tag) => new Node(tag),
    getElementById: (id) => (ids.has(id) ? { id } : null),
    querySelector: (sel) => (doc.documentElement && sel.includes("data-wr-todo-stack") ? stack : null),
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
    __TAURI__: { core: { invoke(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === "report_sync_status") {
        return new Promise((resolve, reject) => pendingReports.push({ resolve, reject }));
      }
      return Promise.resolve();
    } } },
  };
  target.Date = { now: () => clock };
  target.window = target;
  target.globalThis = target;
  target.__wrSyncStatus = null;
  vm.runInNewContext(source, target, { filename: "sync-status.js" });
  const api = target.__wrSyncStatus;
  api.mount(target);
  assert.equal(typeof target.__wrWatchSyncWorker, "function", "the watcher starts before the DOM exists");
  pendingReports.shift().resolve();
  await setImmediate();
  doc.documentElement = documentElement;
  target.__wrSyncRefresh();
  const tab = stack.children.find((child) => child.id === "__whatrust_sync_tab");
  assert.ok(tab, "the sync button joins the shortcut stack");
  assert.equal(stack.lastChild, tab, "it sits last, right above Media");
  assert.equal(tab.hidden, true);
  assert.equal(tab.style.display, "none");
  clock += api.LIMITS.stallMs + 10;
  target.__wrSyncRefresh();
  assert.equal(tab.hidden, true, "still inside the grace period");
  assert.ok(timeouts.some((timer) => timer.ms >= api.LIMITS.graceMs));
  clock += api.LIMITS.graceMs + 50;
  timeouts.at(-1).fn();
  assert.equal(tab.hidden, false);
  assert.equal(tab.style.display, "flex");
  assert.equal(tab.style.position, "relative", "no fixed banner covering the chat");
  assert.equal(tab.getAttribute("aria-label"), "WhatsApp may have stopped syncing. — Reconnect");
  assert.equal(tab.getAttribute("role"), null, "the native button keeps its accessible role");
  assert.equal(tab.style.background, "#f0bd68");
  tab.listeners.click.forEach((fn) => fn({ stopPropagation() {} }));
  assert.ok(calls.includes("recover"));

  const statusCalls = () => calls.filter((call) => call.cmd === "report_sync_status").map((call) => call.args.status);
  assert.deepEqual(statusCalls(), ["online", "stale"]);
  tab.listeners.contextmenu.forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
  assert.equal(tab.hidden, true);
  assert.deepEqual(statusCalls(), ["online", "stale"], "wait for the pending report before clearing it");
  pendingReports.shift().resolve();
  await setImmediate();
  assert.deepEqual(statusCalls(), ["online", "stale", "online"], "dismissing a suspicion clears the tray too");
  pendingReports.shift().reject(new Error("temporary failure"));
  await setImmediate();
  target.__wrSyncRefresh();
  assert.deepEqual(statusCalls(), ["online", "stale", "online", "online"], "retry a failed report on the next check");
  pendingReports.shift().resolve();
  await setImmediate();

  target.navigator.onLine = false;
  target.__wrSyncRefresh();
  clock += api.LIMITS.browserHoldMs;
  target.__wrSyncRefresh();
  assert.equal(tab.getAttribute("aria-label"), "WhatsApp is offline. — Reconnect");
  assert.equal(statusCalls().at(-1), "offline");
  tab.listeners.contextmenu.forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
  assert.equal(tab.hidden, true);
  assert.equal(statusCalls().at(-1), "offline", "dismissing the button keeps a real disconnection on the tray");
  pendingReports.shift().resolve();
});

// Run with: node --test src-tauri/resources/privacy.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('./privacy.js', import.meta.url), 'utf8');

// Minimal DOM: enough for privacy.js to build its style and panel.
function node(tag) {
  return {
    tag, children: [], attrs: {}, hidden: false, textContent: '', style: {},
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    addEventListener() {},
    attachShadow() { return node('#shadow'); },
  };
}

function harness({ stored = null, documentElement = true, invoke = null } = {}) {
  const listeners = {}, docListeners = {};
  const store = new Map(stored ? [['whatrust.privacy.v2', JSON.stringify(stored)]] : []);
  const html = node('html');
  const document = {
    documentElement: documentElement ? html : null,
    body: null, head: node('head'),
    createElement: node,
    addEventListener(ev, fn) { docListeners[ev] = fn; },
  };
  const window = { addEventListener(ev, fn) { listeners[ev] = fn; }, __WR_LANG: 'en', location: { origin: 'https://web.whatsapp.com' } };
  if (invoke) window.__TAURI__ = { core: { invoke } };
  runInNewContext(source, {
    window, document,
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) },
    setTimeout: () => 0, clearTimeout() {}, console,
  });
  return { window, document, html, listeners, docListeners, store };
}

test('mask leaves notifications alone while the blur is off', () => {
  const { window } = harness();
  const r = window.__whatrustPrivacy.mask('Alice', { body: 'hi', icon: 'x' });
  assert.equal(JSON.stringify(r), JSON.stringify({ title: 'Alice', options: { body: 'hi', icon: 'x' } }));
});

test('mask hides sender, text and photo while the blur is on', () => {
  const { window } = harness();
  window.__whatrustPrivacy.toggle();
  const r = window.__whatrustPrivacy.mask('Alice', { body: 'hi', icon: 'x', tag: 't' });
  assert.equal(r.title, 'WhatsApp');
  assert.equal(r.options.body, 'New message');
  assert.equal(r.options.icon, undefined);
  assert.equal(r.options.tag, 't');
});

test('init still runs when the script starts before <html> exists (WebView2)', () => {
  const { docListeners, document, html } = harness({ documentElement: false, stored: { on: true } });
  assert.equal(typeof docListeners.DOMContentLoaded, 'function');
  document.documentElement = html; document.body = node('body');
  assert.doesNotThrow(() => docListeners.DOMContentLoaded());
});

 test('saved privacy setting masks custom notifications', () => {
  const { window } = harness({ stored: { on: true } });
  assert.equal(window.__whatrustPrivacy.masksNotifications(), true);
  window.__whatrustPrivacy.toggle();
  assert.equal(window.__whatrustPrivacy.masksNotifications(), false);
});

test('native privacy receives saved state and later changes in order', async () => {
  const calls = [];
  const { window, document, html, docListeners } = harness({ stored: { on: true }, invoke: (command, args) => { calls.push([command, args.masked]); return Promise.resolve(); } });
  document.documentElement = html; document.body = node('body');
  docListeners.DOMContentLoaded();
  window.__whatrustPrivacy.toggle();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, [['set_notification_privacy', true], ['set_notification_privacy', false]]);
});

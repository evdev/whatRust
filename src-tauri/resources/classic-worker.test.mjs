// Run with: node --test src-tauri/resources/classic-worker.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('./classic-worker.js', import.meta.url), 'utf8');

function boot(win) {
  function NativeWorker(url, opts) {
    this.url = url;
    this.opts = opts;
  }
  win.Worker = NativeWorker;
  runInNewContext(source, { window: win });
}

test('the WhatsApp worker bootstrap is opened as a classic worker', () => {
  const win = {};
  boot(win);
  const url = 'https://web.whatsapp.com/static_resources/webworker_v1/init_script/?__spin_r=1';
  const worker = new win.Worker(url, { type: 'module', name: 'WAWebBackendWorker' });
  assert.equal(worker.opts.type, 'classic');
  assert.equal(worker.opts.name, 'WAWebBackendWorker');
  assert.equal(worker.url, url);
});

test('other module workers are left alone', () => {
  const win = {};
  boot(win);
  const worker = new win.Worker('https://example.com/real-module.js', { type: 'module' });
  assert.equal(worker.opts.type, 'module');
  const plain = new win.Worker('https://example.com/classic.js');
  assert.equal(plain.opts, undefined);
});

test('a classic bootstrap worker is not rewritten', () => {
  const win = {};
  boot(win);
  const url = 'https://web.whatsapp.com/static_resources/webworker_v1/init_script/?__spin_r=1';
  const worker = new win.Worker(url, { type: 'classic', name: 'WAWebBackendWorker' });
  assert.equal(worker.opts.type, 'classic');
});

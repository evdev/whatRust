import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { File } from 'node:buffer';
const source = fs.readFileSync(new URL('./schedule-delivery.js', import.meta.url), 'utf8');
const chat = '222@c.us', id = 'true_222@c.us_ABC';
class WPPError extends Error { constructor(code) { super(code); this.code = code; } }

test('scheduled voice sends Ogg Opus as PTT with durable preparation and no caption', async () => {
  const f = fixture({ size: 15 });
  f.job.kind = 'file'; f.job.text = '';
  f.job.attachment = { id: 'voice', name: 'voice-note.ogg', mime: 'audio/ogg; codecs=opus', mode: 'voice', size: 15, caption: '' };
  f.w.chat.sendFileMessage = async (...args) => {
    assert.equal(f.calls.at(-1).cmd, 'schedule_delivery_prepare');
    f.sends.push(args); return { id, ack: 1 };
  };
  await f.root.__wrScheduleDeliver(f.job);
  const [, file, opts] = f.sends[0];
  assert.equal(file.size, 15); assert.equal(file.name, 'voice-note.ogg');
  assert.equal(file.type, 'audio/ogg; codecs=opus');
  assert.equal(opts.type, 'audio'); assert.equal(opts.isPtt, true);
  assert.equal(opts.mimetype, 'audio/ogg; codecs=opus');
  assert.equal('caption' in opts, false); assert.equal(opts.messageId, id);
  assert.equal(f.result().outcome, 'sent');
});

test('scheduled voice rejects WAV, oversized payloads, text, and captions before preparing', async () => {
  for (const override of [{ mime: 'audio/wav' }, { name: 'voice-note.wav' }, { size: 4 * 1024 * 1024 + 1 }, { caption: 'caption' }, { text: 'draft' }]) {
    const f = fixture({ size: 15 }); f.job.kind = 'file'; f.job.text = override.text || '';
    f.job.attachment = { id: 'voice', name: 'voice-note.ogg', mime: 'audio/ogg; codecs=opus', mode: 'voice', size: 15, caption: '', ...override };
    await f.root.__wrScheduleDeliver(f.job);
    assert.equal(f.result().outcome, 'rejected'); assert.equal(f.sends.length, 0);
    assert.equal(f.calls.some(c => c.cmd === 'schedule_delivery_prepare'), false);
  }
});
function fixture(options = {}) {
  const calls = [], handlers = {}, sends = [];
  let identity = '111@c.us';
  const w = {
    isFullReady: true, isInjected: true,
    on: (e, fn) => { handlers[e] = fn; },
    whatsapp: { enums: { SendMsgResult: { OK: 'OK' }, ...options.enums }, Socket: options.socket },
    util: { WPPError },
    conn: { getMyUserWid: () => identity, isAuthenticated: () => true, isMainReady: () => true, isOnline: () => true, getStreamData: () => ({ mode: 'MAIN', info: 'NORMAL' }) },
    chat: {
      get: () => ({}), generateMessageID: async () => id,
      getMessageById: async () => options.message || { id, ack: 1 },
      sendTextMessage: (...args) => { sends.push(args); return options.send ? options.send(...args) : Promise.resolve(options.result || { id, ack: 1, sendMsgResult: { messageSendResult: 'OK' } }); },
      sendFileMessage: (...args) => { sends.push(args); return Promise.resolve({ id, ack: 1 }); },
    },
  };
  const root = {
    __WHATRUST_TEST: true, __whatrustLocked: options.locked || false,
    crypto: { randomUUID: () => options.session || 'document-1' }, WPP: options.late ? undefined : w,
    File, atob: s => Buffer.from(s, 'base64').toString('binary'),
    __TAURI__: { core: { invoke: async (cmd, args) => {
      calls.push({ cmd, ...args });
      if (options.invoke) return options.invoke(cmd, args, root);
      if (cmd === 'schedule_delivery_chunk') return Buffer.alloc(Math.min(262144, options.size - args.offset), 7).toString('base64');
    } } },
    addEventListener: (e, fn) => { handlers[e] = fn; },
  };
  vm.runInNewContext(source, { window: root, setTimeout, clearTimeout, Uint8Array });
  const job = { token: 'capability', session_id: options.session || 'document-1', identity: '111@c.us', chat_id: chat, operation: 'send', kind: 'text', text: 'hello', attachment: null, message_id: null };
  return { root, w, calls, handlers, sends, job, identity: value => { identity = value; }, result: () => calls.filter(c => c.cmd === 'schedule_delivery_result').at(-1) };
}
test('durably prepares before text send; no chat selection or read side effect', async () => {
  const f = fixture({ send: async () => { assert.equal(f.calls.at(-1).cmd, 'schedule_delivery_prepare'); return { id, ack: 1 }; } });
  await f.root.__wrScheduleDeliver(f.job);
  assert.equal(f.result().outcome, 'sent');
  assert.equal(f.sends[0][2].markIsRead, false);
  assert.equal(f.sends[0][2].createChat, false);
  assert.equal(f.sends[0][2].messageId, id);
  await f.root.__wrScheduleDeliver(f.job);
  assert.equal(f.sends.length, 1);
});
test('pending, invalid, failed ACK or mismatched ID never establishes success', async () => {
  for (const result of [{ id, ack: 0 }, { id, ack: -1 }, { id, ack: 5 }, { id, ack: '1' }, { id: id + 'X', ack: 1 }, { id, ack: 1, sendMsgResult: { messageSendResult: 'ERROR' } }]) {
    const f = fixture({ result }); await f.root.__wrScheduleDeliver(f.job); assert.equal(f.result().outcome, 'unknown');
  }
});
test('post-submission error remains unknown and is never retried', async () => {
  const f = fixture({ send: () => { throw Error('disconnected'); } });
  await f.root.__wrScheduleDeliver(f.job); await f.root.__wrScheduleDeliver(f.job);
  assert.equal(f.result().outcome, 'unknown'); assert.equal(f.sends.length, 1);
});
test('an incompatible runtime ACK mapping fails closed', async () => {
  const f = fixture(); f.w.whatsapp.enums.ACK = { SENT: 7 };
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.result().outcome, 'unknown');
});
test('logout remains blocked until authentication even if cached getters lag', async () => {
  const f = fixture(); f.handlers['conn.logout']();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(c => c.cmd === 'schedule_report').at(-1).identity, null);
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.sends.length, 0);
  f.handlers['conn.authenticated'](); f.job.token = 'second-token';
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.sends.length, 1);
});
test('cached identity is hidden on QR or unauthenticated sessions, retained when authenticated offline', async () => {
  for (const [authenticated, mode, expected] of [[false, 'MAIN', null], [true, 'QR', null], [true, 'OFFLINE', '111@c.us']]) {
    const f = fixture(); f.w.conn.isAuthenticated = () => authenticated;
    f.w.conn.getStreamData = () => ({ mode, info: 'OFFLINE' });
    await f.root.__wrScheduleDeliveryRefresh(true);
    await new Promise(resolve => setImmediate(resolve));
    const report = f.calls.filter(c => c.cmd === 'schedule_report').at(-1);
    assert.equal(report.identity, expected); assert.equal(report.ready, false);
  }
});
test('live stream resumption blocks delivery despite historical readiness and online network', async () => {
  for (const stream of [{ mode: 'MAIN', info: 'RESUMING' }, { mode: 'MAIN', info: 'CONNECTING' }, { mode: 'OFFLINE', info: 'NORMAL' }, { mode: 'SYNCING', info: 'SYNCING' }]) {
    const f = fixture(); f.w.conn.getStreamData = () => stream;
    f.handlers['conn.stream_info_changed'](); await f.root.__wrScheduleDeliver(f.job);
    assert.equal(f.sends.length, 0); assert.equal(f.result().outcome, 'unavailable');
  }
});
test('only bundled pre-submission WPPError codes are safe rejections', async () => {
  for (const [error, expected] of [[new WPPError('chat_not_found'), 'rejected'], [new WPPError('message_key_remote_id_is_not_same_of_chat'), 'rejected'], [new WPPError('network_error'), 'unknown'], [Object.assign(new Error('generic'), { code: 'chat_not_found' }), 'unknown']]) {
    const f = fixture({ send: async () => { throw error; } });
    await f.root.__wrScheduleDeliver(f.job); assert.equal(f.result().outcome, expected);
  }
  const f = fixture(); f.job.kind = 'file'; f.job.attachment = { id: 'f', name: 'x', size: 1, mime: 'image/png', mode: 'image' };
  f.w.chat.sendFileMessage = async () => { throw new WPPError('file_too_large'); };
  f.root.__TAURI__.core.invoke = async (cmd, args) => { f.calls.push({ cmd, ...args }); if (cmd === 'schedule_delivery_chunk') return 'YQ=='; };
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.result().outcome, 'rejected');
});
test('durable prepare prevents replay after recent token eviction', async () => {
  const prepared = new Set();
  const f = fixture({ invoke: async (cmd, args) => {
    if (cmd === 'schedule_delivery_prepare') { if (prepared.has(args.token)) throw Error('used'); prepared.add(args.token); }
  } });
  await f.root.__wrScheduleDeliver(f.job);
  for (let n = 0; n < 1024; n++) await f.root.__wrScheduleDeliver({ ...f.job, token: 'filler-' + n, session_id: 'old-document' });
  await f.root.__wrScheduleDeliver(f.job);
  assert.equal(f.sends.length, 1); assert.equal(f.result().outcome, 'unavailable');
});
test('document reload cannot replay an already prepared capability', async () => {
  const prepared = new Set();
  const invoke = async (cmd, args) => {
    if (cmd === 'schedule_delivery_prepare') { if (prepared.has(args.token)) throw Error('used'); prepared.add(args.token); }
  };
  const first = fixture({ invoke }); await first.root.__wrScheduleDeliver(first.job);
  const reloaded = fixture({ invoke, session: 'document-2' });
  await reloaded.root.__wrScheduleDeliver(reloaded.job);
  assert.equal(first.sends.length, 1); assert.equal(reloaded.sends.length, 0);
  assert.equal(reloaded.result().outcome, 'unavailable');
});
test('lock, identity, document session, readiness and existing chat gate submission', async () => {
  for (const alter of [f => { f.root.__whatrustLocked = true; }, f => f.identity('333@c.us'), f => { f.job.session_id = 'previous-document'; }, f => { f.w.conn.isOnline = () => false; }, f => { f.w.conn.isAuthenticated = () => false; }, f => { f.w.chat.get = () => null; }]) {
    const f = fixture(); alter(f); await f.root.__wrScheduleDeliver(f.job); assert.equal(f.sends.length, 0);
  }
});
test('locking after durable prepare prevents WPP invocation', async () => {
  const f = fixture({ invoke: async (cmd, _, root) => { if (cmd === 'schedule_delivery_prepare') root.__whatrustLocked = true; } });
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.sends.length, 0); assert.equal(f.result().outcome, 'unavailable');
});
test('media reconstructs exactly one file from bounded chunks with explicit mode and caption', async () => {
  for (const mode of ['image', 'video', 'document']) {
    const size = 262145, f = fixture({ size });
    f.job.kind = 'file'; f.job.attachment = { id: 'file-1', name: 'file.bin', size, mime: mode === 'document' ? 'application/pdf' : mode + '/test', mode, caption: 'caption' };
    await f.root.__wrScheduleDeliver(f.job);
    assert.equal(f.result().outcome, 'sent');
    const [actualChat, file, opts] = f.sends[0];
    assert.equal(actualChat, chat); assert.ok(file instanceof File); assert.equal(file.size, size);
    assert.equal(opts.type, mode); assert.equal(opts.caption, 'caption'); assert.equal(opts.markIsRead, false);
    assert.deepEqual(f.calls.filter(c => c.cmd === 'schedule_delivery_chunk').map(c => c.offset), [0, 262144]);
  }
});
test('malformed attachment or truncated chunks reject before prepare/send', async () => {
  const f = fixture({ invoke: async cmd => cmd === 'schedule_delivery_chunk' ? 'YQ==' : undefined });
  f.job.kind = 'file'; f.job.attachment = { id: 'f', name: 'x', size: 10, mime: 'image/png', mode: 'image' };
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.result().outcome, 'rejected'); assert.equal(f.sends.length, 0);
  assert.equal(f.calls.some(c => c.cmd === 'schedule_delivery_prepare'), false);
});
test('reconciliation uses exact durable key, absence and intermediate ACK remain unknown', async () => {
  for (const message of [{ id, ack: 1 }, { id, ack: 0 }, { id: id + 'X', ack: 2 }]) {
    const f = fixture({ message }); f.job.operation = 'reconcile'; f.job.message_id = id;
    await f.root.__wrScheduleDeliver(f.job);
    assert.equal(f.result().outcome, message.id === id && message.ack === 1 ? 'sent' : 'unknown'); assert.equal(f.sends.length, 0);
  }
  const f = fixture(); f.w.chat.getMessageById = async () => { throw Error('not found'); };
  f.job.operation = 'reconcile'; f.job.message_id = id;
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.result().outcome, 'unknown');
});
test('an uncached chat never rejects a reconciliation or prevents exact key evidence', async () => {
  for (const found of [true, false]) {
    const f = fixture(); f.w.chat.get = () => null;
    f.w.chat.getMessageById = async () => { if (!found) throw Error('not found'); return { id, ack: 1 }; };
    f.job.operation = 'reconcile'; f.job.message_id = id;
    await f.root.__wrScheduleDeliver(f.job);
    assert.equal(f.result().outcome, found ? 'sent' : 'unknown');
    assert.equal(f.sends.length, 0);
  }
});
test('late WA-JS startup is event driven and readiness reports force refresh', async () => {
  const f = fixture({ late: true }); assert.equal(f.calls.length, 0);
  f.root.WPP = f.w; f.root.__wrScheduleDeliveryStart();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.find(c => c.cmd === 'schedule_report').ready, true);
  f.root.__whatrustLocked = true; await f.root.__wrScheduleDeliveryRefresh();
  assert.equal(f.calls.at(-1).ready, false);
  const count = f.calls.length; await f.root.__wrScheduleDeliveryRefresh(true); assert.equal(f.calls.length, count + 1);
  f.handlers.pagehide(); await new Promise(resolve => setImmediate(resolve));
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.sends.length, 0);
});

test('connected real socket overrides absent or stale loader and public stream hints', async () => {
  for (const transport of [undefined, 'CONNECTED', 'unrecognized-hint', null]) {
    const f = fixture({ socket: { state: 'CONNECTED', stream: transport } });
    f.w.isFullReady = false; f.w.conn.isMainReady = () => false;
    f.w.conn.getStreamData = () => ({ mode: 'OFFLINE', info: 'RESUMING' });
    await f.root.__wrScheduleDeliveryRefresh(true);
    assert.equal(f.calls.filter(c => c.cmd === 'schedule_report').at(-1).ready, true);
    await f.root.__wrScheduleDeliver(f.job); assert.equal(f.result().outcome, 'sent');
  }
});

test('absent public stream export does not hide identity or block a connected socket', async () => {
  const f = fixture({ socket: { state: 'CONNECTED' } });
  f.w.conn.getStreamData = () => { throw Error('not materialized'); };
  delete f.w.conn.isMainReady; delete f.w.isFullReady; delete f.w.conn.isOnline;
  await f.root.__wrScheduleDeliveryRefresh(true);
  const s = f.calls.filter(c => c.cmd === 'schedule_report').at(-1);
  assert.equal(s.ready, true); assert.equal(s.identity, '111@c.us');
});

test('socket offline, reconnecting, unpaired and explicit network offline veto stale ready hints', async () => {
  for (const sock of [{ state: 'OPENING' }, { state: 'UNPAIRED' }, { state: 'UNPAIRED_IDLE' }, { state: 'CONNECTED', stream: 'DISCONNECTED' }, { state: 'CONNECTED', stream: 'RESUMING' }, { state: 'unknown-pii-value' }]) {
    const f = fixture({ socket: sock });
    await f.root.__wrScheduleDeliver(f.job); assert.equal(f.sends.length, 0);
    await f.root.__wrScheduleDeliveryRefresh(true);
    assert.equal(f.calls.filter(c => c.cmd === 'schedule_report').at(-1).ready, false);
    assert.equal(f.calls.filter(c => c.cmd === 'dlog').some(c => c.msg.includes('unknown-pii-value')), false);
  }
  const f = fixture({ socket: { state: 'CONNECTED' } }); f.w.conn.isOnline = () => false;
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.sends.length, 0);
});

test('socket readiness uses exported runtime enums including non-string values', async () => {
  const f = fixture({ socket: { state: 9, stream: 3 }, enums: { SOCKET_STATE: { CONNECTED: 9 }, SOCKET_STREAM: { CONNECTED: 3 } } });
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.result().outcome, 'sent');
  f.w.whatsapp.Socket.state = 'CONNECTED'; f.job.token = 'second';
  await f.root.__wrScheduleDeliver(f.job); assert.equal(f.sends.length, 1);
});

test('socket model changes report readiness immediately without loader events or polling', async () => {
  const modelEvents = {};
  const sock = { state: 'OPENING', stream: 'DISCONNECTED', on: (name, fn) => { modelEvents[name] = fn; } };
  const f = fixture({ socket: sock });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(c => c.cmd === 'schedule_report').at(-1).ready, false);
  sock.state = 'CONNECTED'; sock.stream = 'CONNECTED'; modelEvents['change:state']();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(c => c.cmd === 'schedule_report').at(-1).ready, true);
  sock.stream = 'DISCONNECTED'; modelEvents['change:stream']();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(c => c.cmd === 'schedule_report').at(-1).ready, false);
});

test('loader callbacks register before snapshot and bind models that appear later', async () => {
  const f = fixture({ late: true }), callbacks = {}, events = {};
  for (const name of ['onInjected', 'onReady', 'onFullReady']) f.w[name] = fn => { callbacks[name] = fn; };
  f.w.isInjected = true; f.w.isFullReady = true; f.root.WPP = f.w;
  await f.root.__wrScheduleDeliveryRefresh();
  assert.equal(Object.keys(callbacks).length, 3);
  f.w.whatsapp.Socket = { state: 'OPENING', on: (name, fn) => { events[name] = fn; } };
  callbacks.onReady(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof events['change:state'], 'function');
  assert.equal(f.calls.filter(c => c.cmd === 'schedule_report').at(-1).ready, false);
});

test('readiness diagnostics contain fixed labels, deduplicate repeated states and bound churn', async () => {
  const f = fixture({ socket: { state: 'CONNECTED' } });
  for (let i = 0; i < 50; i++) {
    f.w.whatsapp.Socket.state = i % 2 ? 'CONNECTED' : 'private-state-' + i;
    await f.root.__wrScheduleDeliveryRefresh(true);
  }
  const logs = f.calls.filter(c => c.cmd === 'dlog');
  assert.equal(logs.length, 2);
  for (const log of logs) {
    assert.equal(/111|222|ABC|hello|private-state/.test(log.msg), false);
    assert.match(log.msg, /^scheduler readiness: reason=[a-z_]+ socket=(absent|connected|other) transport=(absent|connected|other) public=(ready|other) loader=(full|pending) main=(ready|pending)$/);
  }
});

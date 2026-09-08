'use strict';
const test = require('node:test');
const assert = require('node:assert');

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); return { ok: true }; }
  async delete(k) { this.map.delete(k); return { ok: true }; }
  async list(opts) {
    const prefix = (opts && opts.prefix) || '';
    const names = [];
    for (const k of this.map.keys()) if (k.startsWith(prefix)) names.push(k);
    names.sort();
    return { keys: names.map((name) => ({ name })), cursor: null, list_complete: true };
  }
}

test('worker sync: create, join, ops y since', async (t) => {
  const mod = await import('../worker/index.js');
  const w = mod.default, T = w._test;
  const kv = new FakeKV();

  await kv.put('sub|dev1', '{}');
  await kv.put('sub|dev2', '{}');

  const created = await T.handleSyncCreate({ TIMERS: kv }, { deviceId: 'dev1' });
  assert.equal(created.status, 200);
  const { code } = await created.json();
  assert.match(code, /^MT-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  assert.ok(await kv.get('acct|' + code));
  assert.ok(await kv.get('state|' + code));

  const again = await T.handleSyncCreate({ TIMERS: kv }, { deviceId: 'dev1' });
  assert.equal((await again.json()).code, code, 'el codigo es estable por dispositivo');

  const joined = await T.handleSyncJoin({ TIMERS: kv }, { deviceId: 'dev2', code: code.toLowerCase() });
  assert.equal(joined.status, 200);
  const jd = await joined.json();
  assert.equal(jd.code, code);
  assert.equal(jd.since, 0);
  assert.deepEqual(jd.timers, []);
  assert.ok(await kv.get('link|dev2'));
});

test('worker sync: crear/unirse funciona sin notificaciones (push opcional)', async (t) => {
  const mod = await import('../worker/index.js');
  const w = mod.default, T = w._test;
  const kv = new FakeKV();
  await T.getVapid(kv);

  const created = await T.handleSyncCreate({ TIMERS: kv }, { deviceId: 'dev1' });
  assert.equal(created.status, 200);
  const code = (await created.json()).code;
  assert.ok(await kv.get('link|dev1'));
  assert.ok(await kv.get('acctdev|' + code + '|dev1'));

  const joined = await T.handleSyncJoin({ TIMERS: kv }, { deviceId: 'dev2', code });
  assert.equal(joined.status, 200);
  assert.ok(await kv.get('link|dev2'));

  const past = Date.now() - 5000;
  await T.handleSyncOps({ TIMERS: kv }, { code, ops: [{
    op: 'upsert', id: 't1', cat: 'custom', label: 'Sin push', mode: 'once',
    intervalMs: 0, startAt: past - 3600000, endAt: past, warnMs: null, done: false, ts: past
  }] });

  let pushes = 0;
  globalThis.fetch = async () => { pushes++; return { ok: true, status: 201, url: 'x' }; };
  try { await w.scheduled({}, { TIMERS: kv }); } finally { globalThis.fetch = undefined; }
  assert.equal(pushes, 0, 'sin suscripcion aun no hay push');

  const kp1 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const p256dh1 = T.bytesToB64u(T.ecJwkToRaw(await crypto.subtle.exportKey('jwk', kp1.privateKey)));
  const auth1 = T.bytesToB64u(crypto.getRandomValues(new Uint8Array(16)));
  const s1 = await T.handleSubscribe({ TIMERS: kv }, {
    endpoint: 'https://push.example/p1', keys: { p256dh: p256dh1, auth: auth1 }, deviceId: 'dev1'
  });
  assert.equal((await s1.json()).deviceId, 'dev1', 'subscribe usa el deviceId del cliente');
  assert.ok(await kv.get('sub|dev1'));

  const past2 = Date.now() - 5000;
  await T.handleSyncOps({ TIMERS: kv }, { code, ops: [{
    op: 'upsert', id: 't2', cat: 'custom', label: 'Con push', mode: 'once',
    intervalMs: 0, startAt: past2 - 3600000, endAt: past2, warnMs: null, done: false, ts: past2
  }] });

  pushes = 0;
  globalThis.fetch = async () => { pushes++; return { ok: true, status: 201, url: 'x' }; };
  try { await w.scheduled({}, { TIMERS: kv }); } finally { globalThis.fetch = undefined; }
  assert.equal(pushes, 1, 'solo el dispositivo suscrito recibe el fan-out');
});

test('worker sync: upsert/delete y last-write-wins', async (t) => {
  const mod = await import('../worker/index.js');
  const T = mod.default._test;
  const kv = new FakeKV();
  const code = 'MT-AAAA-AAAA';
  await kv.put('acct|' + code, '1');

  const base = {
    id: 't1', cat: 'claim', label: 'Claim', mode: 'once', count: 4,
    intervalMs: 7200000, startAt: 1000, endAt: 2000, warnMs: null, done: false, ts: 100
  };
  let res = await T.handleSyncOps({ TIMERS: kv }, { code, ops: [Object.assign({ op: 'upsert' }, base)] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).since, 1);
  assert.equal(JSON.parse(await kv.get('state|' + code)).timers.t1.count, 4, 'el contador persiste en el backend');

  res = await T.handleSyncOps({ TIMERS: kv }, { code, ops: [{ op: 'upsert', id: 't1', ts: 50, label: 'viejo' }] });
  assert.equal((await res.json()).since, 2);
  assert.equal(JSON.parse(await kv.get('state|' + code)).timers.t1.label, 'Claim', 'ts menor no sobreescribe');

  res = await T.handleSyncOps({ TIMERS: kv }, { code, ops: [{ op: 'delete', id: 't1', ts: 60 }] });
  assert.equal((await res.json()).since, 3);
  assert.ok(JSON.parse(await kv.get('state|' + code)).timers.t1, 'delete con ts menor se ignora');

  res = await T.handleSyncOps({ TIMERS: kv }, { code, ops: [{ op: 'delete', id: 't1', ts: 200 }] });
  assert.equal((await res.json()).since, 4);
  assert.ok(!JSON.parse(await kv.get('state|' + code)).timers.t1, 'delete con ts mayor elimina');
});

test('worker sync: since devuelve ops nuevas y el seq cortado', async (t) => {
  const mod = await import('../worker/index.js');
  const T = mod.default._test;
  const kv = new FakeKV();
  const code = 'MT-BBBB-BBBB';
  await kv.put('acct|' + code, '1');
  await kv.put('state|' + code, JSON.stringify({ rev: 0, timers: {} }));

  await T.handleSyncOps({ TIMERS: kv }, { code, ops: [
    { op: 'upsert', id: 'a', ts: 1, label: 'A', endAt: 1 },
    { op: 'upsert', id: 'b', ts: 2, label: 'B', endAt: 2 }
  ] });

  const url = new URL('https://x/api/sync/since?code=' + code + '&since=1');
  const res = await T.handleSyncSince({ TIMERS: kv }, url);
  assert.equal(res.status, 200);
  const jd = await res.json();
  assert.equal(jd.since, 2);
  assert.equal(jd.ops.length, 1);
  assert.equal(jd.ops[0].id, 'b');
});

test('worker sync: normCode y padSeq', async (t) => {
  const mod = await import('../worker/index.js');
  const T = mod.default._test;
  assert.equal(T.normCode('mt-ab12-xyz!'), 'MT-AB12-XYZ');
  assert.equal(T.padSeq(7), '000000000007');
});

test('worker sync: fan-out a todos los dispositivos en el cron', async (t) => {
  const mod = await import('../worker/index.js');
  const w = mod.default, T = w._test;
  const kv = new FakeKV();
  await T.getVapid(kv);

  async function makeSub(dev, endpoint) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = T.bytesToB64u(T.ecJwkToRaw(jwk));
    const auth = T.bytesToB64u(crypto.getRandomValues(new Uint8Array(16)));
    await kv.put('sub|' + dev, JSON.stringify({ endpoint, p256dh: pub, auth }));
  }
  await makeSub('dev1', 'https://push.example/p1');
  await makeSub('dev2', 'https://push.example/p2');

  const created = await T.handleSyncCreate({ TIMERS: kv }, { deviceId: 'dev1' });
  const code = (await created.json()).code;
  await T.handleSyncJoin({ TIMERS: kv }, { deviceId: 'dev2', code });

  const past = Date.now() - 5000;
  await T.handleSyncOps({ TIMERS: kv }, { code, ops: [{
    op: 'upsert', id: 't1', cat: 'custom', label: 'Timer fanout', mode: 'once',
    intervalMs: 0, startAt: past - 3600000, endAt: past, warnMs: null, done: false, ts: past
  }] });
  assert.ok(await kv.get('sch|' + code + '|t1|fire'));

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, headers: init && init.headers });
    return { ok: true, status: 201, url };
  };
  try {
    await w.scheduled({}, { TIMERS: kv });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(sent.length, 2, 'un push por dispositivo');
  for (const s of sent) assert.match(s.headers.Authorization, /^vapid t=/);
  const state = JSON.parse(await kv.get('state|' + code));
  assert.equal(state.timers.t1.done, true, 'once se marca listo tras avisar');
  assert.ok(!(await kv.get('sch|' + code + '|t1|fire')), 'el aviso fire se limpia');
});

test('worker sync: al terminar, $daily se convierte en repetitivo de 24h en el cron', async (t) => {
  const mod = await import('../worker/index.js');
  const w = mod.default, T = w._test;
  const kv = new FakeKV();
  await T.getVapid(kv);

  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const pub = T.bytesToB64u(T.ecJwkToRaw(await crypto.subtle.exportKey('jwk', kp.privateKey)));
  const auth = T.bytesToB64u(crypto.getRandomValues(new Uint8Array(16)));
  await kv.put('sub|dev1', JSON.stringify({ endpoint: 'https://push.example/ciclo', p256dh: pub, auth }));

  const created = await T.handleSyncCreate({ TIMERS: kv }, { deviceId: 'dev1' });
  const code = (await created.json()).code;

  const now = Date.now();
  await T.handleSyncOps({ TIMERS: kv }, { code, ops: [{
    op: 'upsert', id: 'd1', cat: 'daily', label: '$daily', mode: 'once',
    intervalMs: 2 * 3600000, startAt: now - 2 * 3600000, endAt: now - 1000, warnMs: null, done: false, ts: now
  }] });
  assert.ok(await kv.get('sch|' + code + '|d1|fire'));

  let pushes = 0;
  globalThis.fetch = async () => { pushes++; return { ok: true, status: 201, url: 'x' }; };
  try {
    await w.scheduled({}, { TIMERS: kv });
  } finally {
    globalThis.fetch = undefined;
  }

  assert.equal(pushes, 1, 'un push por el ciclo vencido');
  const st = JSON.parse(await kv.get('state|' + code));
  const d = st.timers.d1;
  assert.equal(d.mode, 'repeat', 'se convierte en repetitivo al terminar');
  assert.equal(d.intervalMs, 86400000, 'el ciclo del daily es 24h');
  assert.equal(d.done, false);
  assert.ok(d.endAt > now, 'se reprograma a futuro');
  const fire = JSON.parse(await kv.get('sch|' + code + '|d1|fire'));
  assert.ok(fire && fire.fireAt >= d.endAt - 1, 'se replanea el siguiente ciclo');
});

test('worker sync: repeat se replanea en el cron', async (t) => {
  const mod = await import('../worker/index.js');
  const w = mod.default, T = w._test;
  const kv = new FakeKV();
  await T.getVapid(kv);

  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const pub = T.bytesToB64u(T.ecJwkToRaw(await crypto.subtle.exportKey('jwk', kp.privateKey)));
  const auth = T.bytesToB64u(crypto.getRandomValues(new Uint8Array(16)));
  await kv.put('sub|dev1', JSON.stringify({ endpoint: 'https://push.example/rep', p256dh: pub, auth }));

  const created = await T.handleSyncCreate({ TIMERS: kv }, { deviceId: 'dev1' });
  const code = (await created.json()).code;

  const intervalMs = 3600000;
  await T.handleSyncOps({ TIMERS: kv }, { code, ops: [{
    op: 'upsert', id: 'r1', cat: 'custom', label: 'Repeticion', mode: 'repeat',
    intervalMs, startAt: Date.now(), endAt: Date.now() + 60000, warnMs: null, done: false, ts: Date.now()
  }] });

  const now = Date.now();
  const state = JSON.parse(await kv.get('state|' + code));
  state.timers.r1.endAt = now - 2000;
  await kv.put('state|' + code, JSON.stringify(state));
  await kv.put('sch|' + code + '|r1|fire', JSON.stringify({ fireAt: now - 1000, title: 'R', msg: 'x', tag: 'r1' }));

  let pushes = 0;
  globalThis.fetch = async () => { pushes++; return { ok: true, status: 201, url: 'x' }; };
  try {
    await w.scheduled({}, { TIMERS: kv });
  } finally {
    globalThis.fetch = undefined;
  }

  assert.equal(pushes, 1, 'un push por el ciclo vencido');
  const st = JSON.parse(await kv.get('state|' + code));
  assert.ok(st.timers.r1.endAt > Date.now(), 'los repetitivos se replanean a futuro');
  assert.equal(st.timers.r1.done, false);
  const fire = JSON.parse(await kv.get('sch|' + code + '|r1|fire'));
  assert.ok(fire && fire.fireAt === st.timers.r1.endAt, 'se programa el siguiente ciclo');
});
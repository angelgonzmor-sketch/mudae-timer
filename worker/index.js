// Mudae Timer — backend sin dependencias para Cloudflare Workers.
// API:
//   GET  /api/health      -> { ok, vapid? }
//   GET  /api/vapid       -> { publicKey } (clave publica VAPID, genera y persiste la primera vez)
//   POST /api/subscribe   -> { endpoint, keys:{p256dh, auth} } => { deviceId }
//   POST /api/schedule    -> { deviceId, timerId, fireAt, title, body?, tag?, repeatMs? }
//   POST /api/cancel      -> { deviceId, timerId }
//   POST /api/unsubscribe -> { deviceId }
// Cron (1/min): envia los avisos vencidos y reprograma los ciclos repetitivos.
// Optimo: un solo despliegue (estaticos + API). Sin node_modules.

const VAPID_SUBJECT = 'mailto:mudae.timer@localhost';
const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64u(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDec(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function cat(...parts) {
  const bytes = [];
  for (const p of parts) {
    if (typeof p === 'number') bytes.push(p);
    else for (let i = 0; i < p.length; i++) bytes.push(p[i]);
  }
  return Uint8Array.from(bytes);
}
function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    }
  });
}

// ---------- Claves EC: raw <-> JWK ----------
function rawToJwk(raw) {
  if (!raw || raw.length !== 65 || raw[0] !== 4) throw new Error('invalida');
  return {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64u(raw.subarray(1, 33)),
    y: bytesToB64u(raw.subarray(33, 65))
  };
}
function ecJwkToRaw(jwk) {
  return cat([4], b64uDec(jwk.x), b64uDec(jwk.y));
}

// ---------- Crypto primitives ----------
async function hmacSign(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}
// HKDF-Expand puro mediante una ronda de HMAC (suficiente para 16 y 12 bytes).
async function hkdfExpand(prk, info, len) {
  const t1 = await hmacSign(prk, cat(info, [1]));
  return t1.slice(0, len);
}

// ---------- VAPID: gestion de pares y firma JWT (ES256) ----------
async function getVapid(store) {
  let pub = await store.get('vapid_pub');
  if (!pub) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    pub = bytesToB64u(ecJwkToRaw(jwk));
    await store.put('vapid_pub', pub);
    await store.put('vapid_priv', JSON.stringify(jwk), { expirationTtl: 63070000 }); // ~2 años, se renueva al generarse
  }
  const privRaw = await store.get('vapid_priv');
  if (!privRaw) throw new Error('vapid_priv missing');
  return { pub, priv: JSON.parse(privRaw) };
}

function toDerInt(bin) {
  let i = 0;
  while (i < bin.length - 1 && bin[i] === 0) i++;
  bin = bin.slice(i);
  if (bin[0] & 0x80) bin = cat([0], bin);
  return cat([2, bin.length], bin);
}
function p1363ToDer(sig) {
  const r = toDerInt(sig.slice(0, 32));
  const s = toDerInt(sig.slice(32, 64));
  return cat([0x30, r.length + s.length], r, s);
}
async function signVapidJwt(privJwk, aud) {
  const key = await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64u(enc.encode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: VAPID_SUBJECT })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + payload)));
  return header + '.' + payload + '.' + bytesToB64u(p1363ToDer(sig));
}

// ---------- Cifrado aes128gcm (RFC 8291) ----------
async function encryptAes128gcm(clientPubBytes, authBytes, payloadText) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverJwk = await crypto.subtle.exportKey('jwk', ecdh.privateKey);
  const serverPub = ecJwkToRaw(serverJwk);
  const clientKey = await crypto.subtle.importKey('jwk', rawToJwk(clientPubBytes), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, ecdh.privateKey, 256));

  const info = cat(enc.encode('WebPush: info'), [0], clientPubBytes, serverPub);
  const prk = await hmacSign(authBytes, shared);
  const ikm = await hkdfExpand(prk, info, 32);
  const cek = await hkdfExpand(ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const plaintext = cat([2], enc.encode(payloadText));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, plaintext));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const header = cat(salt, rs, [serverPub.length], serverPub);
  return cat(header, ct);
}

async function sendPush(store, sub, payload) {
  const vapid = await getVapid(store);
  const aud = new URL(sub.endpoint).origin;
  const token = await signVapidJwt(vapid.priv, aud);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': 'vapid t=' + token + ', k=' + vapid.pub
    },
    body: payload,
    signal: AbortSignal.timeout(20000)
  });
}

// ---------- Handlers de la API ----------
async function handleSubscribe(env, body) {
  if (!body || !body.endpoint || !body.keys || !body.keys.p256dh || !body.keys.auth) {
    return json({ error: 'faltan datos' }, 400);
  }
  const dev = sanitizeId(body.deviceId);
  let deviceId = dev;
  if (!deviceId) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body.endpoint)));
    deviceId = bytesToB64u(hash).slice(0, 22);
  }
  await env.TIMERS.put('sub|' + deviceId, JSON.stringify({
    endpoint: String(body.endpoint),
    p256dh: String(body.keys.p256dh),
    auth: String(body.keys.auth)
  }));
  return json({ ok: true, deviceId });
}

function sanitizeId(v) { return String(v || '').replace(/[|]/g, '_').slice(0, 80); }

async function handleSchedule(env, body) {
  if (!body || !body.deviceId || !body.timerId || !body.fireAt) return json({ error: 'faltan datos' }, 400);
  const dev = sanitizeId(body.deviceId);
  const tid = sanitizeId(body.timerId);
  const entry = {
    fireAt: Number(body.fireAt),
    title: String(body.title || 'Mudae Timer').slice(0, 200),
    msg: String(body.body || '').slice(0, 500),
    tag: String(body.tag || '').slice(0, 64),
    repeatMs: body.repeatMs ? Number(body.repeatMs) : null
  };
  if (!isFinite(entry.fireAt)) return json({ error: 'fireAt invalido' }, 400);
  const raw = await env.TIMERS.get('sub|' + dev);
  if (!raw) return json({ error: 'dispositivo no registrado' }, 404);
  await env.TIMERS.put('sch|' + dev + '|' + tid, JSON.stringify(entry));
  return json({ ok: true });
}

async function handleCancel(env, body) {
  if (!body || !body.deviceId || !body.timerId) return json({ error: 'faltan datos' }, 400);
  const dev = sanitizeId(body.deviceId);
  const tid = sanitizeId(body.timerId);
  await env.TIMERS.delete('sch|' + dev + '|' + tid);
  return json({ ok: true });
}

async function handleUnsubscribe(env, body) {
  if (!body || !body.deviceId) return json({ error: 'faltan datos' }, 400);
  const dev = sanitizeId(body.deviceId);
  await env.TIMERS.delete('sub|' + dev);
  const list = await env.TIMERS.list({ prefix: 'sch|' + dev + '|' });
  for (const item of list.keys) await env.TIMERS.delete(item.name);
  return json({ ok: true });
}

async function handleSyncCreate(env, body) {
  const dev = sanitizeId(body && body.deviceId);
  if (!dev) return json({ error: 'falta deviceId' }, 400);
  const existing = await env.TIMERS.get('link|' + dev);
  if (existing && (await env.TIMERS.get('acct|' + existing))) return json({ code: existing });
  let code;
  do { code = genCode(); } while (await env.TIMERS.get('acct|' + code));
  await env.TIMERS.put('acct|' + code, '1');
  await env.TIMERS.put('state|' + code, JSON.stringify({ rev: 0, timers: {} }));
  await env.TIMERS.put('link|' + dev, code);
  await env.TIMERS.put('acctdev|' + code + '|' + dev, '1');
  return json({ code });
}

async function handleSyncJoin(env, body) {
  const dev = sanitizeId(body && body.deviceId);
  const code = normCode(body && body.code);
  if (!dev || !code) return json({ error: 'faltan datos' }, 400);
  if (!(await env.TIMERS.get('acct|' + code))) {
    await env.TIMERS.put('acct|' + code, '1');
    await env.TIMERS.put('state|' + code, JSON.stringify({ rev: 0, timers: {} }));
  }
  await env.TIMERS.put('link|' + dev, code);
  await env.TIMERS.put('acctdev|' + code + '|' + dev, '1');
  const sRaw = await env.TIMERS.get('state|' + code);
  const s = sRaw ? JSON.parse(sRaw) : { rev: 0, timers: {} };
  const timers = Object.keys(s.timers || {}).map(function (id) { return s.timers[id]; });
  return json({ code: code, since: s.rev, timers: timers });
}

async function handleSyncOps(env, body) {
  const code = normCode(body && body.code);
  if (!code || !(await env.TIMERS.get('acct|' + code))) return json({ error: 'cuenta no existe' }, 404);
  const sRaw = await env.TIMERS.get('state|' + code);
  const state = sRaw ? JSON.parse(sRaw) : { rev: 0, timers: {} };
  const rev = await commitState(env, code, state, (body && body.ops) || []);
  return json({ since: rev });
}

async function handleSyncSince(env, url) {
  const code = normCode(url.searchParams.get('code'));
  const since = parseInt(url.searchParams.get('since'), 10) || 0;
  if (!code || !(await env.TIMERS.get('acct|' + code))) return json({ error: 'cuenta no existe' }, 404);
  const sRaw = await env.TIMERS.get('state|' + code);
  const s = sRaw ? JSON.parse(sRaw) : { rev: 0, timers: {} };
  const list = await env.TIMERS.list({ prefix: 'ops|' + code + '|' });
  const seqs = list.keys.map(function (k) { return parseInt(k.name.split('|')[2], 10); })
    .filter(function (n) { return Number.isFinite(n) && n > since; })
    .sort(function (a, b) { return a - b; })
    .slice(0, 200);
  const ops = [];
  for (const seq of seqs) {
    const raw = await env.TIMERS.get('ops|' + code + '|' + padSeq(seq));
    if (raw) ops.push(JSON.parse(raw));
  }
  return json({ since: s.rev, ops: ops });
}

// ---------- Sincronizacion entre dispositivos ----------
const SYNC_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function normCode(c) { return String(c || '').toUpperCase().replace(/[^0-9A-Z-]/g, '').slice(0, 16); }
function genCode() {
  let s = 'MT-';
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 4; j++) s += SYNC_ALPHABET[Math.floor(Math.random() * SYNC_ALPHABET.length)];
    if (i === 0) s += '-';
  }
  return s;
}
function padSeq(n) { return String(n).padStart(12, '0'); }
function fmtDur(ms) {
  ms = Math.max(0, Math.round(Number(ms) || 0));
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  if (!parts.length || s) parts.push(s + 's');
  return parts.join(' ');
}
// Normaliza un temporizador para almacenarlo/escribirlo (fuente de verdad compartida).
function normTimer(o, cur) {
  return {
    id: String(o.id),
    cat: o.cat || (cur && cur.cat) || 'custom',
    label: String(o.label || (cur && cur.label) || 'Tiempo').slice(0, 120),
    mode: o.mode || (cur && cur.mode) || 'once',
    intervalMs: Number(o.intervalMs != null ? o.intervalMs : (cur && cur.intervalMs)) || 0,
    startAt: Number(o.startAt != null ? o.startAt : (cur && cur.startAt)) || 0,
    endAt: Number(o.endAt != null ? o.endAt : (cur && cur.endAt)) || 0,
    warnMs: o.warnMs != null ? Number(o.warnMs) : (cur && cur.warnMs != null ? Number(cur.warnMs) : null),
    done: !!(o.done != null ? o.done : (cur && cur.done)),
    count: Number(o.count != null ? o.count : (cur && cur.count)) || 0,
    ts: Number(o.ts != null ? o.ts : (cur && cur.ts)) || 0
  };
}
function timerOp(t) { return Object.assign({ ts: t.ts }, t, { op: 'upsert' }); }

// Ciclo por defecto al terminar un temporizador "una vez" de estas categorias.
const CAT_CYCLE = { rollsreset: 3600000, kakerareact: 3600000, rollsmk: 3600000, kakera: 6604800, daily: 86400000, rt: 108000000, vote: 43200000 };

// Aplica ops a la cuenta y revierte al log (los dispositivos convergen via poll).
async function commitState(env, code, state, ops) {
  let seq = state.rev;
  for (const o of (ops || [])) {
    if (!o || !o.id) continue;
    seq += 1;
    await env.TIMERS.put('ops|' + code + '|' + padSeq(seq), JSON.stringify(o));
    const cur = state.timers[o.id];
    if (o.op === 'delete') {
      if (!cur || (cur.ts || 0) <= (o.ts || 0)) delete state.timers[o.id];
    } else if (!cur || (cur.ts || 0) <= (o.ts || 0)) {
      state.timers[o.id] = normTimer(o, cur);
    }
  }
  if (seq === state.rev) return state.rev;
  state.rev = seq;
  await env.TIMERS.put('state|' + code, JSON.stringify(state));
  await planSchedules(env, code, state);
  return seq;
}

// Recalcula los avisos pendientes de una cuenta (fan-out a todos sus dispositivos).
async function planSchedules(env, code, state) {
  const list = await env.TIMERS.list({ prefix: 'sch|' + code + '|' });
  for (const item of list.keys) await env.TIMERS.delete(item.name);
  const now = Date.now();
  for (const id of Object.keys(state.timers || {})) {
    const t = state.timers[id];
    if (t.done) continue;
    let fire = t.endAt;
    if (t.mode === 'repeat' && fire <= now) { while (fire <= now) fire += t.intervalMs; }
    await env.TIMERS.put('sch|' + code + '|' + id + '|fire', JSON.stringify({
      fireAt: Math.max(fire, now), title: t.label, msg: 'El comando ya está disponible.', tag: id
    }));
    if (t.warnMs) {
      const wf = t.endAt - t.warnMs;
      if (wf >= now && wf < fire) {
        await env.TIMERS.put('sch|' + code + '|' + id + '|warn', JSON.stringify({
          fireAt: Math.max(wf, now), title: t.label + ' casi listo', msg: 'Listo en ' + fmtDur(t.warnMs) + '.', tag: id + '-warn'
        }));
      }
    }
  }
}

// Envia un push a todos los dispositivos vinculados a una cuenta.
async function fanoutPush(env, code, rec) {
  const devList = await env.TIMERS.list({ prefix: 'acctdev|' + code + '|' });
  for (const dk of devList.keys) {
    const dev = dk.name.split('|')[2];
    const subRaw = await env.TIMERS.get('sub|' + dev);
    if (!subRaw) continue;
    let sub;
    try { sub = JSON.parse(subRaw); } catch (e) { continue; }
    let payload;
    try {
      payload = await encryptAes128gcm(
        b64uDec(sub.p256dh), b64uDec(sub.auth),
        JSON.stringify({ title: rec.title, body: rec.msg, tag: rec.tag })
      );
    } catch (e) { continue; }
    try {
      const res = await sendPush(env.TIMERS, sub, payload);
      if (res.status === 404 || res.status === 410) await env.TIMERS.delete('sub|' + dev);
    } catch (e) { continue; }
  }
}

// Aviso tipo "cuenta": se dispara y el estado decide repetir o marcar listo.
async function cronAccount(env, parts, item) {
  const code = parts[1], id = parts[2], kind = parts[3];
  const raw = await env.TIMERS.get(item.name);
  if (!raw) return;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { await env.TIMERS.delete(item.name); return; }
  if (rec.fireAt > Date.now()) return;

  if (kind === 'warn') {
    await fanoutPush(env, code, rec);
    await env.TIMERS.delete(item.name);
    return;
  }

  await fanoutPush(env, code, rec);
  const sRaw = await env.TIMERS.get('state|' + code);
  const state = sRaw ? JSON.parse(sRaw) : { rev: 0, timers: {} };
  const t = state.timers[id];
  if (!t) { await env.TIMERS.delete(item.name); return; }
  if (t.mode === 'repeat') {
    if (t.endAt <= rec.fireAt) {
      t.endAt = rec.fireAt + t.intervalMs;
      while (t.endAt <= Date.now()) t.endAt += t.intervalMs;
      t.startAt = t.endAt - t.intervalMs;
      t.ts = Date.now();
      await commitState(env, code, state, [timerOp(t)]);
    } else {
      await env.TIMERS.delete(item.name); // ya fue replaneado por otra via
    }
  } else if (!t.done) {
    if (CAT_CYCLE[t.cat]) {
      t.mode = 'repeat';
      t.intervalMs = CAT_CYCLE[t.cat];
      if (t.endAt <= rec.fireAt) t.endAt = rec.fireAt + t.intervalMs;
      while (t.endAt <= Date.now()) t.endAt += t.intervalMs;
      t.startAt = t.endAt - t.intervalMs;
      t.done = false;
      t.ts = Date.now();
      await commitState(env, code, state, [timerOp(t)]);
    } else {
      t.done = true;
      t.ts = Date.now();
      await commitState(env, code, state, [timerOp(t)]);
    }
  } else {
    await env.TIMERS.delete(item.name);
  }
}

// Aviso "por dispositivo" (legacy, sin sincronizacion: el frontend programa fireAt).
async function cronDevice(env, parts, item) {
  const dev = parts[1];
  const tid = parts.slice(2).join('|');
  const raw = await env.TIMERS.get(item.name);
  if (!raw) return;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { await env.TIMERS.delete(item.name); return; }
  if (rec.fireAt > Date.now()) return;

  const subRaw = await env.TIMERS.get('sub|' + dev);
  if (!subRaw) { await env.TIMERS.delete(item.name); return; }
  let sub;
  try { sub = JSON.parse(subRaw); } catch (e) { await env.TIMERS.delete(item.name); return; }

  let payload;
  try {
    payload = await encryptAes128gcm(
      b64uDec(sub.p256dh), b64uDec(sub.auth),
      JSON.stringify({ title: rec.title, body: rec.msg, tag: rec.tag })
    );
  } catch (e) { await env.TIMERS.delete(item.name); return; }

  let res;
  try { res = await sendPush(env.TIMERS, sub, payload); } catch (e) { return; }

  if (res.status === 404 || res.status === 410) {
    await env.TIMERS.delete('sub|' + dev);
    await env.TIMERS.delete(item.name);
    return;
  }
  if (res.ok || res.status === 201) {
    if (rec.repeatMs) {
      let next = rec.fireAt + rec.repeatMs;
      while (next <= Date.now()) next += rec.repeatMs;
      rec.fireAt = next;
      await env.TIMERS.put(item.name, JSON.stringify(rec));
    } else {
      await env.TIMERS.delete(item.name);
    }
  }
}

// ---------- Cron ----------
async function runCron(env) {
  let cursor;
  let keys = [];
  do {
    const list = await env.TIMERS.list({ prefix: 'sch|', cursor });
    keys = keys.concat(list.keys);
    cursor = list.cursor;
  } while (cursor);

  for (const item of keys) {
    const parts = item.name.split('|');
    if (parts.length === 4) await cronAccount(env, parts, item);
    else if (parts.length === 3) await cronDevice(env, parts, item);
    else await env.TIMERS.delete(item.name);
  }
}

// ---------- Enrutado ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') return json({ ok: true });
    if (method === 'GET' && pathname === '/api/health') return json({ ok: true });
    if (method === 'GET' && pathname === '/api/vapid') {
      try {
        const v = await getVapid(env.TIMERS);
        return json({ publicKey: v.pub });
      } catch (e) { return json({ error: 'no vapid' }, 500); }
    }
    if (method === 'GET' && pathname === '/api/sync/since') return handleSyncSince(env, url);
    if (method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      if (pathname === '/api/subscribe') return handleSubscribe(env, body);
      if (pathname === '/api/schedule') return handleSchedule(env, body);
      if (pathname === '/api/cancel') return handleCancel(env, body);
      if (pathname === '/api/unsubscribe') return handleUnsubscribe(env, body);
      if (pathname === '/api/sync/create') return handleSyncCreate(env, body);
      if (pathname === '/api/sync/join') return handleSyncJoin(env, body);
      if (pathname === '/api/sync/ops') return handleSyncOps(env, body);
    }
    if (pathname.startsWith('/api/')) return json({ error: 'no encontrado' }, 404);

    // Servir los estaticos (PWA). Con [assets] en wrangler.toml, env.ASSETS esta disponible.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(controller, env) {
    try { await runCron(env); } catch (e) {}
  },
  _test: {
    signVapidJwt,
    encryptAes128gcm,
    getVapid,
    bytesToB64u,
    b64uDec,
    ecJwkToRaw,
    rawToJwk,
    p1363ToDer,
    commitState,
    planSchedules,
    runCron,
    normCode,
    genCode,
    padSeq,
    fmtDur,
    handleSyncCreate,
    handleSyncJoin,
    handleSyncOps,
    handleSyncSince,
    handleSubscribe
  }
};
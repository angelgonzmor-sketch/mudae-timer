'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const nodeCrypto = require('node:crypto');
const { join } = require('node:path');

// Cargar el worker ESM como CommonJS para probarlo en Node.
const src = readFileSync(join(__dirname, '..', 'worker', 'index.js'), 'utf8')
  .replace('export default', 'module.exports =');
const mod = { exports: {} };
new Function('module', 'exports', 'require', src)(mod, mod.exports, require);
const wk = mod.exports._test;

const enc = new TextEncoder();
function concat(...parts) {
  const out = [];
  for (const p of parts) {
    if (typeof p === 'number') out.push(p);
    else for (let i = 0; i < p.length; i++) out.push(p[i]);
  }
  return Uint8Array.from(out);
}

// version de descifrado (espejo del algoritmo) para validar el cifrado del worker
async function decryptAes128gcm(clientPrivJwk, payload, auth) {
  const salt = payload.slice(0, 16);
  const rs = new DataView(payload.buffer, payload.byteOffset + 16).getUint32(0, false);
  const idlen = payload[20];
  const serverPub = payload.slice(21, 21 + idlen);
  const body = payload.slice(21 + idlen);

  const serverJwk = wk.rawToJwk(serverPub);
  const serverKey = await crypto.subtle.importKey('jwk', serverJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const clientKey = await crypto.subtle.importKey('jwk', clientPrivJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, clientKey, 256));

  const clientPub = wk.ecJwkToRaw(clientPrivJwk);
  const authBytes = auth || new Uint8Array(16).fill(7);

  async function hmac(k, d) {
    const key = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, d));
  }
  async function hkdfExpand(prk, info, len) {
    return (await hmac(prk, concat(info, 1))).slice(0, len);
  }

  const info = concat(enc.encode('WebPush: info'), 0, clientPub, serverPub);
  const prk = await hmac(authBytes, shared);
  const ikm = await hkdfExpand(prk, info, 32);
  const cek = await hkdfExpand(ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, body));
  return { plaintext: plain.slice(1), padByte: plain[0], rs };
}

test('aes128gcm: enviar y descifrar (RFC 8291)', async () => {
  const client = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = await crypto.subtle.exportKey('jwk', client.publicKey);
  const priv = await crypto.subtle.exportKey('jwk', client.privateKey);
  const clientPubRaw = wk.ecJwkToRaw(pub);

  const auth = new Uint8Array(16).fill(9);
  const message = '{"title":"Claim listo","body":"Ya puedes reclamar","tag":"a1"}';
  const payload = await wk.encryptAes128gcm(clientPubRaw, auth, message);

  const out = await decryptAes128gcm(priv, payload, auth);
  assert.equal(out.padByte, 2);
  assert.equal(new TextDecoder().decode(out.plaintext), message);
});

test('VAPID JWT: firma ES256 valida y verificable (DER ASN.1)', async () => {
  const keyPair = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = keyPair.publicKey.export({ format: 'jwk' });
  const privJwk = keyPair.privateKey.export({ format: 'jwk' });

  const token = await wk.signVapidJwt(privJwk, 'https://fcm.googleapis.com');
  const [h, p, sig] = token.split('.');

  // verificar con Node (espera firma DER ASN.1), usando la clave publica EC
  const verifier = nodeCrypto.createVerify('SHA256');
  verifier.update(h + '.' + p);
  const ok = verifier.verify({ key: pubJwk, format: 'jwk', dsaEncoding: 'der' }, Buffer.from(sig, 'base64'));
  assert.equal(ok, true);

  const header = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
  const payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  assert.equal(header.alg, 'ES256');
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));
  assert.ok(payload.sub.includes('mailto:'));
});

test('conversiones base64url / EC ida y vuelta', () => {
  const raw = concat([4], new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
  const jwk = wk.rawToJwk(raw);
  const back = wk.ecJwkToRaw(jwk);
  assert.deepEqual(Array.from(back), Array.from(raw));
  const b64 = wk.bytesToB64u(new Uint8Array([0, 1, 2, 254, 255]));
  assert.deepEqual(Array.from(wk.b64uDec(b64)), [0, 1, 2, 254, 255]);
});

test('getVapid: genera, persiste y reutiliza el par en KV', async () => {
  const store = {};
  const fake = {
    get: async (k) => store[k],
    put: async (k, v) => { store[k] = v; },
    list: async () => ({ keys: [] }),
    delete: async () => {}
  };
  const v1 = await wk.getVapid(fake);
  const v2 = await wk.getVapid(fake);
  assert.equal(v1.pub, v2.pub);
  assert.equal(v1.priv.d, v2.priv.d);
  assert.ok(v1.pub.length > 20);
});

test('subscribe: guarda bajo el deviceId del cliente o deriva del endpoint', async () => {
  const store = {};
  const kv = {
    get: async (k) => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = v; },
    list: async () => ({ keys: [] }),
    delete: async () => {}
  };
  const body = {
    endpoint: 'https://push.example/abc',
    keys: { p256dh: 'pub', auth: 'auth' }
  };

  const withId = await wk.handleSubscribe({ TIMERS: kv }, Object.assign({}, body, { deviceId: 'mi-dispositivo' }));
  assert.equal((await withId.json()).deviceId, 'mi-dispositivo');
  assert.ok(store['sub|mi-dispositivo'].includes('abc'));

  const derived = await wk.handleSubscribe({ TIMERS: kv }, body);
  const jd = await derived.json();
  assert.ok(jd.deviceId && jd.deviceId.length === 22, 'sin deviceId se deriva un hash del endpoint');
  assert.ok(store['sub|' + jd.deviceId], 'la suscripcion derivada tambien se guarda');
});

test('cron por dispositivo: un ciclo con repeatMs se replanea solo', async () => {
  const store = {};
  const kv = {
    get: async (k) => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = v; },
    delete: async (k) => { delete store[k]; },
    list: async ({ prefix }) => ({
      keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      cursor: undefined
    })
  };
  await wk.getVapid(kv);

  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const pub = wk.bytesToB64u(wk.ecJwkToRaw(pubJwk));
  const auth = wk.bytesToB64u(crypto.getRandomValues(new Uint8Array(16)));
  store['sub|dev2'] = JSON.stringify({ endpoint: 'https://push.example/rep', p256dh: pub, auth });

  store['sch|dev2|t1:fire'] = JSON.stringify({ fireAt: Date.now() - 1000, title: 'X', msg: 'listo', tag: 't1', repeatMs: 3600000 });
  store['sch|dev2|t2:fire'] = JSON.stringify({ fireAt: Date.now() - 500, title: 'Y', msg: 'listo', tag: 't2', repeatMs: null });

  globalThis.fetch = async () => ({ ok: true, status: 201, url: 'x' });
  try {
    await wk.runCron({ TIMERS: kv });
  } finally {
    globalThis.fetch = undefined;
  }

  assert.ok(store['sch|dev2|t1:fire'], 'un ciclo con repeatMs se replanea, no se borra');
  const sch = JSON.parse(store['sch|dev2|t1:fire']);
  assert.ok(sch.fireAt > Date.now(), 'el proximo ciclo se programa en el futuro');
  assert.equal(sch.repeatMs, 3600000);
  assert.equal(store['sch|dev2|t2:fire'], undefined, 'sin repeatMs el aviso se borra');
});
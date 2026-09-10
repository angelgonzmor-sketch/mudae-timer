'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const parse = require('../public/parse.js');

function createEl(tag) {
  const node = {
    tag, children: [], style: {}, dataset: {},
    className: '',
    textContent: '',
    value: '', type: '', name: '', checked: false,
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    focus() {},
    addEventListener() {},
    onclick: null,
    querySelector(sel) { return findOne(this, sel); },
    querySelectorAll(sel) { return findAll(this, sel); }
  };
  Object.defineProperty(node, 'innerHTML', {
    configurable: true,
    get() { return this._h; },
    set(v) { this._h = v; this.children.length = 0; }
  });
  return node;
}
function classTokens(el) { return String(el.className || el.classList || '').split(/\s+/).filter(Boolean); }
function matches(el, sel) {
  if (sel.startsWith('.')) {
    const tok = sel.slice(1);
    return classTokens(el).includes(tok) || String(el.name || '') === tok;
  }
  const attr = sel.match(/^(\w+)\[([\w-]+)=([\w-]+)\]/);
  if (attr) return el.tag === attr[1] && String(el[attr[2]]) === attr[3];
  if (/^[\w-]+$/.test(sel)) {
    if (sel === 'div') return el.tag === 'div';
    if (sel.startsWith('input[')) return el.tag === 'input';
    return false;
  }
  return false;
}
function walk(el, fn) {
  for (const c of el.children) { fn(c); walk(c, fn); }
}
function findOne(root, sel) {
  if (sel === 'input[name="mode"]:checked') return { value: 'once', checked: true };
  let out = null;
  walk(root, (c) => { if (!out && matches(c, sel)) out = c; });
  return out;
}
function findAll(root, sel) {
  const out = [];
  walk(root, (c) => { if (matches(c, sel)) out.push(c); });
  return out;
}
function cardByLabel(group, label) {
  let got = null;
  group.children.forEach((c) => {
    if (!got && String(c.className).includes('timer')) {
      let ok = false;
      walk(c, (cc) => { if (cc.className === 'tlabel' && String(cc.textContent) === label) ok = true; });
      if (ok) got = c;
    }
  });
  return got;
}
function buttonIn(card, txt) {
  let got = null;
  walk(card, (c) => { if (!got && c.tag === 'button' && String(c.textContent) === txt) got = c; });
  return got;
}

function makeDoc() {
  const store = {};
  const ids = ['timers', 'profileName', 'profileSel', 'addProfile', 'delProfile', 'addBtn',
    'pasteBtn', 'pushBtn', 'addCat', 'presets', 'addTime', 'addLabel', 'addWarn', 'addWarnTime',
    'addSave', 'pasteText', 'pasteDetect', 'taCopy', 'taCopyBtn', 'pasteResults', 'pasteAdd',
    'addModal', 'pasteModal', 'syncModal', 'syncBtn', 'sync-status', 'syncForce', 'syncHint', 'syncStatusText'];
  const els = {};
  for (const id of ids) els[id] = createEl('div');
  els.addTime.value = ''; els.addTime.tag = 'input'; els.addTime.type = 'text';
  els.addWarnTime.value = '5'; els.addWarnTime.tag = 'input'; els.addWarnTime.type = 'number'; els.addWarnTime.min = '1';
  els.addWarn.tag = 'input'; els.addWarn.type = 'checkbox'; els.addWarn.checked = false;
  els.addCat.tag = 'select';
  els.profileSel.tag = 'select';
  els.pasteText.tag = 'textarea';
  const doc = {
    store,
    hidden: false,
    visibilityState: 'visible',
    $: els,
    getElementById(id) { if (!els[id]) els[id] = createEl('div'); return els[id]; },
    createElement(tag) { return createEl(tag); },
    querySelector(sel) {
      if (sel === 'input[name="mode"]:checked') return { value: 'once', checked: true };
      return null;
    },
    querySelectorAll(sel) { return []; },
    addEventListener() {},
    body: createEl('body')
  };
  doc.ensure = function (sel) {
    // no-op helper: provide the add modal internals wiring
    return null;
  };
  return doc;
}

function bootApp(store) {
  const fetchCalls = [];
  const sFetch = (url, opts) => {
    fetchCalls.push({ url: String(url), opts: opts || {} });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  const globals = {
    localStorage: {
      _d: Object.assign({}, store || {}),
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; }
    },
    Notification: { permission: 'denied', requestPermission() { return Promise.resolve('denied'); } }
  };

  const doc = makeDoc();
  const context = {
    window: { MudaeParse: parse, AudioContext: undefined, fetch: sFetch, Notification: globals.Notification },
    document: doc,
    navigator: {},
    location: { protocol: 'http:', search: '', hash: '' },
    localStorage: globals.localStorage,
    Notification: globals.Notification,
    fetch: sFetch,
    setTimeout,
    confirm: () => true,
    prompt: () => null,
    alert: () => {}
  };
  context.window.window = context.window;
  context.window.document = doc;
  context.window.location = context.location;
  context.window.localStorage = globals.localStorage;
  context.window.Notification = globals.Notification;

  let onReady = null;
  const listeners = {};
  doc.addEventListener = (ev, fn) => {
    if (ev === 'DOMContentLoaded') onReady = fn;
    (listeners[ev] = listeners[ev] || []).push(fn);
  };

  const src = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
  globalThis.MudaeParse = parse;
  const fn = new Function('window', 'document', 'navigator', 'location', 'localStorage',
    'Notification', 'fetch', 'setTimeout', 'confirm', 'prompt', 'alert', 'AudioContext', src);
  fn(context.window, doc, context.navigator, context.location, globals.localStorage,
    globals.Notification, sFetch, global.setTimeout, context.confirm, context.prompt, context.alert, undefined);

  return { globals, doc, context, onReady, listeners, fetchCalls };
}

function withTicks(fn) {
  const intervals = [];
  const realInterval = global.setInterval;
  const realClear = global.clearInterval;
  global.setInterval = (f, ms) => { intervals.push({ fn: f, ms }); return intervals.length; };
  global.clearInterval = () => {};
  try { return fn(intervals); }
  finally { global.setInterval = realInterval; global.clearInterval = realClear; }
}

test('frontend: init sin crashear + anadir temporizador + render', () => {
  const { globals, doc, onReady, listeners, fetchCalls } = bootApp({});
  assert.equal(typeof onReady, 'function', 'debe registrar DOMContentLoaded');
  withTicks((intervals) => {
    onReady();

    // estado vacio -> hint
    const timers = doc.getElementById('timers');
    assert.ok(timers.children.some(c => String(c.textContent).includes('Sin temporizadores')));

    // barra de perfiles: ya hay un perfil por defecto
    assert.ok(doc.getElementById('profileSel').children.length >= 1);

    // sincronizacion: poll cada 30s y botones del modal cableados
    const poll30 = intervals.find(i => i.ms === 30000);
    assert.ok(poll30 && typeof poll30.fn === 'function', 'debe existir el poll de sync (30s)');
    assert.equal(typeof doc.getElementById('syncBtn').onclick, 'function', 'el boton Sincronizar abre el modal');
    assert.equal(typeof doc.getElementById('syncForce').onclick, 'function', 'Forzar sincronizacion cableado');
    assert.ok(doc.getElementById('sync-status'), 'existe el indicador de estado de sync');

    // deviceId estable se genera y persiste aun sin notificaciones
    const devId = globals.localStorage._d['mudaeDeviceId'];
    assert.ok(devId && String(devId).startsWith('d'), 'se genera un deviceId estable sin push');

    // simular "Anadir tiempo": claim 2h una vez
    doc.getElementById('addCat').value = 'claim';
    doc.getElementById('addTime').value = '2h';
    doc.getElementById('addLabel').value = '';
    doc.getElementById('addSave').onclick();

    // un temporizador creado y renderizado (dentro de la carpeta "En espera")
    const groups = () => timers.children;
    const findGroup = (title) => groups().find(g => String(g.children[0]?.textContent).includes(title));
    const cards = () => groups().flatMap(g => g.children.filter(c => String(c.className).includes('timer')));
    const espera = findGroup('En espera');
    assert.ok(espera, 'debe existir la carpeta En espera');
    assert.ok(!findGroup('Disponibles'), 'aun no hay carpeta Disponibles');
    assert.equal(cards().length, 1, 'una tarjeta dentro de la carpeta');
    const card = cards()[0];
    assert.ok(String(card.querySelector('.tlabel')?.textContent).includes('Claim'));
    assert.equal(parse.textToMs(String(card.querySelector('.count')?.textContent) || '1m') > 0, true);

    // persiste en localStorage
    const saved = JSON.parse(globals.localStorage._d['mudaeTimer.v1']);
    assert.equal(saved.profiles[0].timers.length, 1);
    assert.equal(saved.profiles[0].timers[0].intervalMs, 2 * 3600000);

    // --- editar tiempo: cambiar la duracion a 1h 30m ---
    const cardEl2 = cards()[0];
    const actionsEl = cardEl2.children.find(c => String(c.className).includes('actions'));
    const editBtn = actionsEl.children.find(b => String(b.textContent).includes('Editar tiempo'));
    assert.ok(editBtn, 'debe existir el boton de editar tiempo');
    editBtn.onclick({ stopPropagation() {} });
    doc.getElementById('editHours').value = '1';
    doc.getElementById('editMinutes').value = '30';
    doc.getElementById('editSave').onclick();
    const saved2 = JSON.parse(globals.localStorage._d['mudaeTimer.v1']);
    assert.equal(saved2.profiles[0].timers[0].intervalMs, 5400000, 'el tiempo editado aplica horas y minutos');
    assert.equal(timers.children.length >= 1, true, 'al editar la lista sigue renderizada');

    // --- bajo consumo: pestaña oculta no escribe el DOM ni mantiene red ---
    assert.ok(intervals.length >= 2, 'debe haber tanto el tick (1s) como el poll de sync (30s)');
    const vis = (listeners.visibilitychange || [])[0];
    assert.equal(typeof vis, 'function', 'debe registrarse el listener de visibilidad');

    const countEl = () => cards()[0]?.querySelector('.count');
    const before = String(countEl()?.textContent);

    doc.hidden = true;
    doc.visibilityState = 'hidden';
    intervals[0].fn(); // un tick en segundo plano: motor si, DOM no
    assert.equal(String(countEl()?.textContent), before, 'escondido no se reescribe el contador');

    vis(); // ocultar -> pausa el poll de sync
    assert.ok(intervals.every(it => it.fn !== undefined));

    doc.hidden = false;
    doc.visibilityState = 'visible';
    vis(); // visible -> resume + catch-up + render sin romper nada
    assert.ok(timers.children.length >= 1, 'al volver visible la lista sigue renderizada');

    // --- auto: al vencer, la tarjeta pasa sola de "En espera" a "Disponibles" ---
    const realNow = Date.now;
    try {
      Date.now = () => realNow.call(Date) + 7200000 + 1000; // el claim de 2h ya vencio
      intervals[0].fn(); // un tick -> done -> render
    } finally {
      Date.now = realNow;
    }
    const disp = findGroup('Disponibles');
    assert.ok(disp, 'el vencido aparece en Disponibles');
    assert.ok(!findGroup('En espera'), 'sin pendientes no se pinta la carpeta En espera');
    const doneCard = disp.children.find(c => String(c.className).includes('timer'));
    assert.ok(String(doneCard.querySelector('.count')?.textContent).includes('Listo'));

    // --- ciclo automatico: $daily al terminar pasa a repetirse cada 24h ---
    doc.getElementById('addCat').value = 'daily';
    doc.getElementById('addTime').value = '2h';
    doc.getElementById('addLabel').value = '';
    doc.getElementById('addSave').onclick();
    let saved3 = JSON.parse(globals.localStorage._d['mudaeTimer.v1']);
    const dailyOnce = saved3.profiles[0].timers.find(x => x.cat === 'daily');
    assert.equal(dailyOnce.mode, 'once', 'el daily se agrega como una vez');
    assert.ok(findGroup('En espera'), 'el nuevo diario aparece En espera');

    const realNow2 = Date.now;
    try {
      Date.now = () => realNow2.call(Date) + 2 * 3600000 + 1000; // el daily de 2h ya vencio
      intervals[0].fn(); // un tick -> se convierte en repeat 24h
    } finally {
      Date.now = realNow2;
    }
    saved3 = JSON.parse(globals.localStorage._d['mudaeTimer.v1']);
    const dailyCiclo = saved3.profiles[0].timers.find(x => x.cat === 'daily');
    assert.equal(dailyCiclo.mode, 'repeat', 'se convierte en repetitivo al terminar');
    assert.equal(dailyCiclo.intervalMs, 86400000, 'el ciclo del daily es 24h');
    assert.equal(dailyCiclo.done, false);
    assert.ok(dailyCiclo.endAt > Date.now(), 'se reprograma a futuro');
    assert.equal(findGroup('Disponibles').children.filter(c => String(c.className).includes('timer')).length, 1,
      'el daily no queda en Disponibles, solo el claim vencido');

    // --- aviso al terminar: un ciclo que completa tambien notifica (toast en la app) ---
    const noticesBefore = doc.body.children.filter(c => String(c.className) === 'notice').length;
    const realNow3 = Date.now;
    try {
      Date.now = () => realNow2.call(Date) + 26 * 3600000 + 10000; // siguiente ciclo del daily
      intervals[0].fn(); // un tick -> completa el ciclo y avisa
    } finally {
      Date.now = realNow3;
    }
    const noticesAfter = doc.body.children.filter(c => String(c.className) === 'notice').length;
    assert.equal(noticesAfter, noticesBefore + 1, 'cada ciclo que termina agrega un aviso');
    const notice = doc.body.children.find(c => String(c.className) === 'notice' && /disponible/i.test(String(c.textContent)));
    assert.ok(notice, 'el aviso de "disponible" aparece en la app sin permiso del navegador');

    // --- boton modo: una sola vez <-> ciclo ---
    let claimCard = disp.children.find(c => String(c.className).includes('timer'));
    const btnCiclo = buttonIn(claimCard, 'Ciclo');
    assert.ok(btnCiclo, 'una tarjeta de una sola vez muestra el boton Ciclo');
    btnCiclo.onclick({ stopPropagation() {} });
    let saved4 = JSON.parse(globals.localStorage._d['mudaeTimer.v1']);
    let claim = saved4.profiles[0].timers.find(x => x.cat === 'claim');
    assert.equal(claim.mode, 'repeat', 'pasa a ciclo');
    assert.equal(claim.intervalMs, 5400000, 'mantiene el intervalo de 1h 30m');
    assert.equal(claim.done, false);
    assert.ok(claim.endAt > Date.now(), 'un ciclo vencido se reprograma a futuro');
    assert.ok(!findGroup('Disponibles'), 'al pasar a ciclo sale de Disponibles');

    const espera2 = findGroup('En espera');
    assert.ok(espera2, 'sigue pintandose En espera');
    claimCard = cardByLabel(espera2, 'Claim');
    assert.ok(claimCard, 'la tarjeta Claim ahora esta En espera');
    const btnOnce = buttonIn(claimCard, 'Una vez');
    assert.ok(btnOnce, 'un ciclo muestra el boton Una vez');
    btnOnce.onclick({ stopPropagation() {} });
    saved4 = JSON.parse(globals.localStorage._d['mudaeTimer.v1']);
    claim = saved4.profiles[0].timers.find(x => x.cat === 'claim');
    assert.equal(claim.mode, 'once', 'vuelve a una sola vez');
    assert.equal(claim.done, false);
    assert.ok(claim.endAt > Date.now(), 'sigue contando sin reiniciar');

    // pulsar "Activar notificaciones" con permiso denegado no rompe nada ni cambia el id
    doc.getElementById('pushBtn').onclick();
    assert.equal(globals.localStorage._d['mudaeDeviceId'], devId, 'el deviceId estable no cambia');

    // sin conexion (navigator sin onLine): el sync no toca la red
    assert.equal(fetchCalls.length, 0, 'mientras no haya navigator.onLine no hay llamadas de sync');

    // --- migracion: $mk + $Rolls viejos se funden en uno solo "$rolls y $mk" ---
    const t0 = Date.now();
    globals.localStorage._d['mudaeTimer.v1'] = JSON.stringify({
      profiles: [{
        id: 'p1', name: 'Mi servidor', timers: [
          { id: 'a1', cat: 'kakerareact', label: '$mk', mode: 'repeat', intervalMs: 3600000, startAt: t0 - 60 * 60000, endAt: t0 + 60 * 60000, warnMs: null, warnSent: false, done: false, ts: t0 },
          { id: 'a2', cat: 'rollsreset', label: '$Rolls', mode: 'repeat', intervalMs: 3600000, startAt: t0 - 40 * 60000, endAt: t0 + 20 * 60000, warnMs: null, warnSent: false, done: false, ts: t0 }
        ], syncCode: null, syncSeq: 0, pendingOps: []
      }], active: 'p1'
    });
    onReady();
    const mig = JSON.parse(globals.localStorage._d['mudaeTimer.v1']);
    const migTimers = mig.profiles[0].timers;
    assert.equal(migTimers.length, 1, 'solo queda un temporizador');
    assert.equal(migTimers[0].cat, 'rollsmk', 'categoria unificada');
    assert.equal(migTimers[0].label, '$rolls y $mk');
    assert.equal(migTimers[0].mode, 'repeat', 'queda repetitivo');
    assert.equal(migTimers[0].intervalMs, 3600000, 'ciclo de una hora');
    assert.ok(migTimers[0].endAt > Date.now(), 'sigue el proximo aviso futuro');
  });
});

test('frontend: contador del badge (Reclamar/Reiniciar/catch-up)', () => {
  const now = Date.now();
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'b1', cat: 'rollsmk', label: '$rolls y $mk', mode: 'repeat', intervalMs: 3600000, startAt: now - 60000, endAt: now + 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: now }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { globals, doc, onReady } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded), 'mudaeDeviceId': 'd-test' });
  withTicks((intervals) => {
    onReady();

    const timersEl = doc.getElementById('timers');
    const findGroup = (title) => timersEl.children.find(g => String(g.children[0]?.textContent).includes(title));
    const card = () => cardByLabel(findGroup('En espera'), '$rolls y $mk');
    const badge = () => String(card()?.querySelector('.badge')?.textContent);
    assert.ok(card(), 'se renderiza la tarjeta del fusionado');
    assert.equal(badge(), '0', 'el badge empieza en 0');

    // un ciclo completado -> +1
    const realNow = Date.now;
    try {
      Date.now = () => realNow.call(Date) + 2 * 3600000 + 1000;
      intervals[0].fn();
    } finally { Date.now = realNow; }
    assert.equal(badge(), '1', 'un ciclo completado suma 1 al badge');
    const saved1 = JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers[0];
    assert.equal(saved1.count, 1, 'el contador persistido suma 1');

    // Ciclo: Reiniciar queda bloqueado con candado; Reclamar sigue habilitado
    const btnRestart = buttonIn(card(), 'Reiniciar');
    assert.ok(btnRestart, 'existe el boton Reiniciar');
    assert.equal(btnRestart.disabled, true, 'en ciclo Reiniciar esta bloqueado');
    assert.ok(!btnRestart.onclick, 'bloqueado no dispara nada');
    assert.ok(String(btnRestart.className).includes('btn-lock'), 'lleva candado (btn-lock)');
    const unlockedClaim = buttonIn(card(), 'Reclamar');
    assert.equal(!!unlockedClaim.disabled, false, 'en ciclo Reclamar sigue habilitado');
    assert.equal(typeof unlockedClaim.onclick, 'function', 'Reclamar dispara en ciclo');

    // Reclamar en ciclo: SOLO pone el contador a 0
    const endBeforeCycleClaim = saved1.endAt;
    unlockedClaim.onclick({ stopPropagation() {} });
    const savedClaim = JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers[0];
    assert.equal(savedClaim.count, 0, 'Reclamar en ciclo pone el contador a 0');
    assert.equal(savedClaim.endAt, endBeforeCycleClaim, 'Reclamar no toca el countdown');
    assert.equal(badge(), '0', 'el badge muestra 0 tras Reclamar');

    // Desbloqueo: cambiar el modo de ciclo a "Una vez"
    const btnOnce = buttonIn(card(), 'Una vez');
    assert.ok(btnOnce, 'el ciclo ofrece el boton Una vez');
    btnOnce.onclick({ stopPropagation() {} });

    // Reiniciar: reinicia el countdown pero NO toca el contador
    const newRestart = buttonIn(card(), 'Reiniciar');
    assert.equal(!!newRestart.disabled, false, 'tras pasar a Una vez Reiniciar queda habilitado');
    newRestart.onclick({ stopPropagation() {} });
    const saved2 = JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers[0];
    assert.equal(saved2.count, 0, 'Reiniciar conserva el contador');
    assert.ok(saved2.endAt > Date.now(), 'Reiniciar reprograma a futuro');
    assert.equal(badge(), '0', 'el badge no cambia al reiniciar');

    // catch-up: ciclos vencidos mientras la app estaba cerrada
    const overdueEnd = Date.now() - 2.5 * 3600000;
    globals.localStorage._d['mudaeTimer.v1'] = JSON.stringify({
      profiles: [{
        id: 'p1', name: 'Mi servidor', timers: [
          { id: 'c1', cat: 'rollsmk', label: '$rolls y $mk', mode: 'repeat', intervalMs: 3600000, startAt: overdueEnd - 3600000, endAt: overdueEnd, warnMs: null, warnSent: false, done: false, count: 0, ts: Date.now() }
        ], syncCode: null, syncSeq: 0, pendingOps: []
      }],
      active: 'p1'
    });
    onReady();
    const saved4 = JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers[0];
    assert.equal(saved4.count, 3, 'los ciclos vencidos mientras estaba cerrado suman');
    assert.equal(badge(), '3', 'el badge muestra la suma acumulada');
  });
});
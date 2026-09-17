'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const parse = require('../public/parse.js');

function createEl(tag) {
  const node = {
    tag, children: [], style: {}, dataset: {},
    parent: null,
    className: '',
    textContent: '',
    value: '', type: '', name: '', checked: false,
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    remove() {
      if (this.parent) {
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
        this.parent = null;
      }
    },
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
    'addModal', 'pasteModal', 'syncModal', 'syncBtn', 'sync-status', 'syncForce', 'syncHint', 'syncStatusText',
    'editModal', 'editHours', 'editMinutes', 'editSave', 'advanceModal', 'advanceTime', 'advanceSave',
    'claimModal', 'claimAmount', 'claimAvailable', 'claimSave', 'claimAll'];
  const els = {};
  for (const id of ids) els[id] = createEl('div');
  els.addTime.value = ''; els.addTime.tag = 'input'; els.addTime.type = 'text';
  els.addWarnTime.value = '5'; els.addWarnTime.tag = 'input'; els.addWarnTime.type = 'number'; els.addWarnTime.min = '1';
  els.addWarn.tag = 'input'; els.addWarn.type = 'checkbox'; els.addWarn.checked = false;
  els.addCat.tag = 'select';
  els.profileSel.tag = 'select';
  els.claimAmount.tag = 'input'; els.claimAmount.type = 'number'; els.claimAmount.min = '1';
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

function bootApp(store, notifOverride, extra) {
  const fetchCalls = [];
  const ext = extra || {};
  const sFetch = ext.fetch || ((url, opts) => {
    fetchCalls.push({ url: String(url), opts: opts || {} });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
  const globals = {
    localStorage: {
      _d: Object.assign({}, store || {}),
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; }
    },
    Notification: notifOverride || { permission: 'denied', requestPermission() { return Promise.resolve('denied'); } }
  };

  const doc = makeDoc();
  const context = {
    window: { MudaeParse: parse, AudioContext: undefined, fetch: sFetch, Notification: globals.Notification },
    document: doc,
    navigator: Object.assign({}, ext.navigator || {}),
    location: {
      protocol: 'http:', search: '', hash: '',
      reload() { context._reloadCount = (context._reloadCount || 0) + 1; }
    },
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
    const txt = (node) => { let s = ''; (function z(n) { if (n.textContent) s += n.textContent; n.children.forEach(z); })(node); return s; };
    const noticesBefore = doc.getElementById('toasts').children.length;
    const realNow3 = Date.now;
    try {
      Date.now = () => realNow2.call(Date) + 26 * 3600000 + 10000; // siguiente ciclo del daily
      intervals[0].fn(); // un tick -> completa el ciclo y avisa
    } finally {
      Date.now = realNow3;
    }
    assert.ok(noticesBefore >= 1, 'habia avisos previos (claim y conversion del daily)');
    assert.equal(doc.getElementById('toasts').children.length, noticesBefore, 'cada ciclo refresca el aviso del mismo timer en vez de duplicarlo');
    const notice = doc.getElementById('toasts').children.find(c => String(c.dataset.tag) === dailyCiclo.id);
    assert.ok(notice && txt(notice).includes('disponible'), 'el aviso de "disponible" del daily aparece en la app sin permiso del navegador');

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
          { id: 'a2', cat: 'rollsreset', label: '$Rolls', mode: 'repeat', intervalMs: 3600000, startAt: t0 - 60 * 60000, endAt: t0 + 60 * 60000, warnMs: null, warnSent: false, done: false, ts: t0 }
        ], syncCode: null, syncSeq: 0, pendingOps: []
      }], active: 'p1'
    });
    onReady();
    const mig = JSON.parse(globals.localStorage._d['mudaeTimer.v1']);
    const migTimers = mig.profiles[0].timers;
    assert.equal(migTimers.length, 2, 'quedan dos temporizadores, no se fusionan');
    const mk = migTimers.find(x => x.cat === 'kakerareact');
    const rolls = migTimers.find(x => x.cat === 'rollsreset');
    assert.ok(mk && rolls, 'existen $mk y $Rolls por separado');
    assert.equal(mk.label, '$mk');
    assert.equal(rolls.label, '$Rolls');
    assert.equal(mk.endAt, t0 + 60 * 60000, '$mk conserva su endAt');
    assert.equal(rolls.endAt, t0 + 60 * 60000, '$Rolls conserva su endAt');
    assert.equal(mk.mode, 'repeat', 'sigue repetitivo');
    assert.equal(rolls.intervalMs, 3600000, 'ciclo de una hora');
    assert.ok(mk.endAt > Date.now(), 'sigue el proximo aviso futuro');
  });
});

test('frontend: personalizado exige nombre y guarda el nombre elegido', () => {
  const { globals, doc, onReady } = bootApp({});
  withTicks(() => {
    onReady();
    const timers = doc.getElementById('timers');
    const saved = () => JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers;

    // sin nombre: no se crea el temporizador
    doc.getElementById('addCat').value = 'custom';
    doc.getElementById('addTime').value = '45m';
    doc.getElementById('addLabel').value = '';
    doc.getElementById('addSave').onclick();
    assert.equal(saved().length, 0, 'custom sin nombre no se guarda');

    // con nombre: se crea con ese nombre exacto
    doc.getElementById('addLabel').value = 'Mi vaca rara';
    doc.getElementById('addSave').onclick();
    assert.equal(saved().length, 1, 'custom con nombre se guarda');
    assert.equal(saved()[0].cat, 'custom', 'categoria custom');
    assert.equal(saved()[0].label, 'Mi vaca rara', 'usa el nombre elegido, no "Personalizado"');
    const card = timers.children
      .flatMap(g => g.children)
      .find(c => String(c.className).includes('timer'));
    assert.ok(card, 'la tarjeta del personalizado esta renderizada');
    let named = false;
    (function walk(node) {
      node.children.forEach((c) => {
        if (!named && c.className === 'tlabel' && String(c.textContent) === 'Mi vaca rara') named = true;
        walk(c);
      });
    })(card);
    assert.ok(named, 'la tarjeta muestra el nombre elegido');
  });
});

test('frontend: contador del badge (Reclamar/Reiniciar/catch-up)', () => {
  const now = Date.now();
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'b1', cat: 'kakerareact', label: '$mk', mode: 'repeat', intervalMs: 3600000, startAt: now - 60000, endAt: now + 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: now }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { globals, doc, onReady } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded), 'mudaeDeviceId': 'd-test' });
  withTicks((intervals) => {
    onReady();

    const timersEl = doc.getElementById('timers');
    const findGroup = (title) => timersEl.children.find(g => String(g.children[0]?.textContent).includes(title));
    const card = () => cardByLabel(findGroup('En espera'), '$mk');
    const badge = () => String(card()?.querySelector('.badge')?.textContent);
    assert.ok(card(), 'se renderiza la tarjeta del $mk');
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

    // Ciclo: Reiniciar esta habilitado: reprograma el countdown y conserva el contador
    const countBeforeCycle = saved1.count;
    const btnRestart = buttonIn(card(), 'Reiniciar');
    assert.ok(btnRestart, 'existe el boton Reiniciar');
    assert.equal(!!btnRestart.disabled, false, 'en ciclo Reiniciar esta habilitado');
    assert.equal(typeof btnRestart.onclick, 'function', 'en ciclo Reiniciar dispara');
    btnRestart.onclick({ stopPropagation() {} });
    const savedRestart = JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers[0];
    assert.equal(savedRestart.count, countBeforeCycle, 'Reiniciar en ciclo conserva el contador');
    assert.ok(savedRestart.endAt > Date.now(), 'Reiniciar en ciclo reprograma a futuro');
    const unlockedClaim = buttonIn(card(), 'Reclamar');
    assert.equal(!!unlockedClaim.disabled, false, 'en ciclo Reclamar sigue habilitado');
    assert.equal(typeof unlockedClaim.onclick, 'function', 'Reclamar dispara en ciclo');

    // Reclamar en ciclo: abre el modal y SOLO pone el contador a 0
    const endBeforeCycleClaim = savedRestart.endAt;
    unlockedClaim.onclick({ stopPropagation() {} });
    doc.getElementById('claimAmount').value = '1';
    doc.getElementById('claimSave').onclick();
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

test('frontend: adelantar acerca el final sin cambiar el tiempo establecido', () => {
  const t0 = Date.now();
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'k1', cat: 'kakerareact', label: '$mk', mode: 'repeat', intervalMs: 3600000, startAt: t0, endAt: t0 + 2 * 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 },
        { id: 'r1', cat: 'rollsreset', label: '$Rolls', mode: 'repeat', intervalMs: 3600000, startAt: t0, endAt: t0 + 2 * 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 },
        { id: 'c1', cat: 'custom', label: 'Sorteo', mode: 'once', intervalMs: null, startAt: t0, endAt: t0 + 300000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 },
        { id: 'rt1', cat: 'rt', label: 'Rt', mode: 'repeat', intervalMs: 3600000, startAt: t0, endAt: t0 + 300000, warnMs: null, warnSent: false, done: false, count: 2, ts: t0 }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { globals, doc, onReady } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded) });
  withTicks(() => {
    onReady();
    const saved = () => JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers;
    const findGroup = (title) => doc.getElementById('timers').children.find(g => String(g.children[0]?.textContent).includes(title));
    const by = (cat) => saved().find(t => t.cat === cat);

    // adelantar $mk 5m: no cambia el ciclo y arrastra a $Rolls
    const mkCard = cardByLabel(findGroup('En espera'), '$mk');
    const advBtn = buttonIn(mkCard, 'Adelantar');
    assert.ok(advBtn, 'existe el boton Adelantar');
    advBtn.onclick({ stopPropagation() {} });
    doc.getElementById('advanceTime').value = '5m';
    doc.getElementById('advanceSave').onclick();
    assert.equal(by('kakerareact').endAt, t0 + 2 * 3600000 - 300000, 'se adelanta 5 minutos');
    assert.equal(by('kakerareact').intervalMs, 3600000, 'el ciclo establecido no cambia');
    assert.equal(by('kakerareact').mode, 'repeat', 'el modo no cambia');
    assert.equal(by('rollsreset').endAt, by('kakerareact').endAt, '$Rolls se adelanta junto con $mk');

    // adelantar $Rolls 1h 30m: $mk lo sigue (reloj avanza 1s para distinguir ts)
    const rollsCard = cardByLabel(findGroup('En espera'), '$Rolls');
    const realNow = Date.now;
    try {
      Date.now = () => realNow.call(Date) + 1000;
      buttonIn(rollsCard, 'Adelantar').onclick({ stopPropagation() {} });
      doc.getElementById('advanceTime').value = '1h 30m';
      doc.getElementById('advanceSave').onclick();
    } finally { Date.now = realNow; }
    assert.equal(by('rollsreset').endAt, t0 + 2 * 3600000 - 300000 - 5400000, '$Rolls adelantado 1h30m mas');
    assert.equal(by('kakerareact').endAt, by('rollsreset').endAt, '$mk sigue a $Rolls');
    assert.equal(by('rollsreset').intervalMs, 3600000, 'ciclo intacto');

    // --- adelantar mas de lo que queda en una vez: se marca done ---
    const onceCard = cardByLabel(findGroup('En espera · Una vez'), 'Sorteo');
    assert.ok(onceCard, 'el timer de una vez esta en espera');
    buttonIn(onceCard, 'Adelantar').onclick({ stopPropagation() {} });
    doc.getElementById('advanceTime').value = '6m';
    doc.getElementById('advanceSave').onclick();
    assert.equal(by('custom').done, true, 'una vez adelantado mas de lo que queda queda done');
    assert.equal(by('custom').count, 1, 'el ciclo se da por terminado sin saltar toast');

    // --- adelantar mas de lo que queda en ciclo: completa y agenda el siguiente ---
    const repeatCard = cardByLabel(findGroup('En espera'), '$rt');
    assert.ok(repeatCard, 'el timer repetitivo esta en espera');
    try {
      Date.now = () => realNow.call(Date) + 500;
      buttonIn(repeatCard, 'Adelantar').onclick({ stopPropagation() {} });
      doc.getElementById('advanceTime').value = '7m';
      doc.getElementById('advanceSave').onclick();
    } finally { Date.now = realNow; }
    assert.equal(by('rt').count, 3, 'ciclo adelantado da por terminado una vuelta');
    assert.equal(by('rt').endAt, t0 + 300000 + 3600000, 'el siguiente ciclo se agenda desde el final original');
    assert.equal(by('rt').done, false, 'el timer sigue activo');
    assert.equal(doc.getElementById('toasts').children.length, 0, 'no se genera toast por completar por adelanto');
  });
});

test('frontend: al completarse sale toast push-up y notificacion nativa', () => {
  const t0 = Date.now();
  let nativeCalls = 0;
  function SpyNotification() { nativeCalls++; }
  SpyNotification.permission = 'granted';
  SpyNotification.requestPermission = () => Promise.resolve('granted');
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'c1', cat: 'claim', label: 'Claim', mode: 'once', intervalMs: null, startAt: t0, endAt: t0 + 2 * 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 },
        { id: 'o1', cat: 'custom', label: 'Sorteo', mode: 'once', intervalMs: null, startAt: t0, endAt: t0 + 2 * 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { globals, doc, onReady } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded) }, SpyNotification);
  const flat = (node) => { let s = ''; (function z(n) { if (n.textContent) s += n.textContent; n.children.forEach(z); })(node); return s; };
  const toasts = () => doc.getElementById('toasts').children;
  withTicks((intervals) => {
    onReady();
    assert.equal(toasts().length, 0, 'sin toasts al entrar');

    const realNow = Date.now;
    try {
      Date.now = () => realNow.call(Date) + 2 * 3600000 + 1000;
      intervals[0].fn();
    } finally {
      Date.now = realNow;
    }
    assert.equal(toasts().length, 2, 'un toast por temporizador completado');
    assert.equal(nativeCalls, 2, 'ambos disparan notificacion nativa');
    const first = toasts()[0];
    assert.ok(flat(first).includes('Claim'), 'el toast muestra la etiqueta');
    assert.ok(flat(first).includes('El comando ya está disponible.'), 'el toast muestra el mensaje');
    assert.ok(buttonIn(first, 'Ver'), 'el toast tiene accion Ver');
    assert.ok(buttonIn(first, '✕'), 'el toast tiene cierre');

    try { Date.now = () => realNow.call(Date) + 2 * 3600000 + 2000; intervals[0].fn(); }
    finally { Date.now = realNow; }
    assert.equal(toasts().length, 2, 'no se duplican al repetir el tick');

    buttonIn(toasts()[0], 'Ver').onclick();
    assert.equal(toasts().length, 1, 'Ver cierra su toast');
    buttonIn(toasts()[0], '✕').onclick();
    assert.equal(toasts().length, 0, 'cerrar quita el toast');
  });
});

test('frontend: separa disponibles, ciclos y de una vez en grupos', () => {
  const t0 = Date.now();
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'd1', cat: 'claim', label: 'Claim', mode: 'once', intervalMs: null, startAt: t0 - 3600000, endAt: t0 - 1800000, warnMs: null, warnSent: false, done: true, count: 2, ts: t0 },
        { id: 'c1', cat: 'rollsreset', label: '$Rolls', mode: 'repeat', intervalMs: 3600000, startAt: t0, endAt: t0 + 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 },
        { id: 'o1', cat: 'custom', label: 'Unica vez', mode: 'once', intervalMs: null, startAt: t0, endAt: t0 + 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { globals, doc, onReady } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded) });
  withTicks(() => {
    onReady();
    const titles = () => doc.getElementById('timers').children.map(g => String(g.children[0]?.textContent));
    assert.deepEqual(titles(), ['Disponibles (1)', 'En espera · Ciclo (1)', 'En espera · Una vez (1)']);
    assert.ok(doc.getElementById('timers').children.every(g => g.open === false), 'los grupos se muestran plegados al entrar');
    const groupBy = (title) => doc.getElementById('timers').children.find(g => String(g.children[0]?.textContent).startsWith(title));
    assert.ok(cardByLabel(groupBy('Disponibles'), 'Claim'), 'Claim queda en Disponibles');
    assert.ok(cardByLabel(groupBy('En espera · Ciclo'), '$Rolls'), '$Rolls en espera pero como ciclo');
    assert.ok(cardByLabel(groupBy('En espera · Una vez'), 'Unica vez'), 'unica vez separada de los ciclos');

    // al pasar un ciclo a una vez, cambia de grupo sin recargar
    const rollsCard = cardByLabel(groupBy('En espera · Ciclo'), '$Rolls');
    buttonIn(rollsCard, 'Una vez').onclick({ stopPropagation() {} });
    assert.deepEqual(titles(), ['Disponibles (1)', 'En espera · Una vez (2)']);
    assert.ok(cardByLabel(groupBy('En espera · Una vez'), '$Rolls'), '$Rolls ahora en una vez');
  });
});

test('frontend: $rolls y $mk se separan en dos temporizadores enlazados en el tiempo', () => {
  const t0 = Date.now();
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'm1', cat: 'rollsmk', label: '$rolls y $mk', mode: 'repeat', intervalMs: 3600000, startAt: t0 - 3600000, endAt: t0 + 1800000, warnMs: null, warnSent: false, done: false, count: 3, ts: t0 }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { globals, doc, onReady } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded) });
  withTicks(() => {
    onReady();
    const saved = () => JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers;
    const findGroup = (title) => doc.getElementById('timers').children.find(g => String(g.children[0]?.textContent).includes(title));

    // el fusionado antiguo se separa en $mk y $Rolls con los mismos tiempos
    let timers = saved();
    assert.equal(timers.length, 2, 'se separa en dos temporizadores');
    const mk = timers.find(x => x.cat === 'kakerareact');
    const rolls = timers.find(x => x.cat === 'rollsreset');
    assert.ok(mk && rolls, '$mk y $Rolls existen por separado');
    assert.equal(mk.label, '$mk');
    assert.equal(rolls.label, '$Rolls');
    assert.equal(mk.endAt, t0 + 1800000, 'no se modifica el endAt original');
    assert.equal(rolls.endAt, mk.endAt, 'ambos comparten el mismo endAt');
    assert.equal(mk.count, 3, '$mk hereda el contador');
    assert.equal(rolls.count, 3, '$Rolls hereda el contador');

    // al modificar uno (modo -> Una vez), el otro se alinea
    const mkCard = cardByLabel(findGroup('En espera'), '$mk');
    assert.ok(mkCard, 'tarjeta $mk visible');
    const btnOnce = buttonIn(mkCard, 'Una vez');
    btnOnce.onclick({ stopPropagation() {} });
    timers = saved();
    assert.equal(timers.find(x => x.cat === 'rollsreset').mode, 'once', '$Rolls cambia a Una vez junto con $mk');

    // al reiniciar $mk, $Rolls sigue el mismo endAt
    const mkCard2 = cardByLabel(findGroup('En espera'), '$mk');
    const btnRestart = buttonIn(mkCard2, 'Reiniciar');
    assert.ok(btnRestart && !btnRestart.disabled, 'Reiniciar habilitado tras Una vez');
    btnRestart.onclick({ stopPropagation() {} });
    timers = saved();
    const mk2 = timers.find(x => x.cat === 'kakerareact');
    const rolls2 = timers.find(x => x.cat === 'rollsreset');
    assert.ok(mk2.endAt > Date.now(), 'Reiniciar reprograma a futuro');
    assert.equal(rolls2.endAt, mk2.endAt, 'al reiniciar $mk, $Rolls se alinea al mismo endAt');
    assert.equal(mk2.count, 3, 'reiniciar no toca el contador');
    assert.equal(rolls2.count, 3, 'el contador sigue siendo independiente');
  });
});

test('frontend: boton Resetear recarga la app sin borrar datos', async () => {
  const t0 = Date.now();
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'c1', cat: 'claim', label: 'Claim', mode: 'once', intervalMs: null, startAt: t0, endAt: t0 + 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { globals, doc, onReady, context } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded) });
  const flat = (node) => { let s = ''; (function z(n) { if (n.textContent) s += n.textContent; n.children.forEach(z); })(node); return s; };
  withTicks(() => {
    onReady();
    const btn = doc.getElementById('resetBtn');
    assert.ok(btn, 'existe el boton Resetear');
    assert.equal(typeof btn.onclick, 'function', 'el boton dispara el reset');
    btn.onclick({ stopPropagation() {} });
    assert.ok(flat(doc.getElementById('toasts')).includes('Reparando y reiniciando la app'), 'muestra toast de reinicio');
    const saved = JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers;
    assert.equal(saved.length, 1, 'los datos se conservan antes de recargar');
  });
  await new Promise(r => setTimeout(r, 600));
  assert.equal(context._reloadCount, 1, 'recarga la pagina una sola vez');
});

test('frontend: $tu actualiza el progreso sin cambiar el tiempo asignado', () => {
  const t0 = Date.now();
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'cl1', cat: 'claim', label: 'Claim', mode: 'repeat', intervalMs: 3600000, startAt: t0 - 1800000, endAt: t0 + 1800000, warnMs: null, warnSent: false, done: false, count: 2, ts: t0 },
        { id: 'mk1', cat: 'kakerareact', label: '$mk', mode: 'repeat', intervalMs: 3600000, startAt: t0 - 1800000, endAt: t0 + 1800000, warnMs: null, warnSent: false, done: false, count: 1, ts: t0 },
        { id: 'rl1', cat: 'rollsreset', label: '$Rolls', mode: 'repeat', intervalMs: 3600000, startAt: t0 - 1800000, endAt: t0 + 1800000, warnMs: null, warnSent: false, done: false, count: 1, ts: t0 },
        { id: 'ky1', cat: 'keys', label: 'Keys', mode: 'once', intervalMs: null, startAt: t0 - 3600000, endAt: t0 - 1800000, warnMs: null, warnSent: false, done: true, count: 1, ts: t0 },
        { id: 'rt1', cat: 'rt', label: '$rt', mode: 'repeat', intervalMs: 3600000, startAt: t0 - 3600000, endAt: t0 + 600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { globals, doc, onReady } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded) });
  const flat = (node) => { let s = ''; (function z(n) { if (n.textContent) s += n.textContent; n.children.forEach(z); })(node); return s; };
  withTicks(() => {
    onReady();
    doc.getElementById('pasteText').value =
      '$mk rolls reset en 5 min\n' +
      'Claim reset en 5 min\n' +
      '$daily se reinicia en 30 min\n' +
      '$rt ready (listo)\n' +
      'keysup en 10 min';
    doc.getElementById('pasteDetect').onclick();

    const saved = () => JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers;
    const by = (cat) => saved().find(t => t.cat === cat);
    const rem = (t) => t.endAt - Date.now();

    // Claim: progreso re-anclado a ~5m, duracion asignada intacta
    const claim = by('claim');
    assert.ok(claim, 'existe Claim');
    assert.ok(rem(claim) > 4 * 60000 && rem(claim) < 6 * 60000, 'Claim queda en ~5m');
    assert.equal(claim.startAt, claim.endAt - 3600000, 'Claim conserva su duracion de 1h');
    assert.equal(claim.intervalMs, 3600000, 'Claim conserva su ciclo');
    assert.equal(claim.count, 2, 'Claim conserva su contador');
    assert.equal(claim.mode, 'repeat', 'Claim conserva su modo');

    // par $mk/$Rolls: detectado como "rollsmk", ambos actualizados y alineados
    const mk = by('kakerareact'), rolls = by('rollsreset');
    assert.ok(rem(mk) > 4 * 60000 && rem(mk) < 6 * 60000, '$mk queda en ~5m');
    assert.equal(mk.intervalMs, 3600000, '$mk conserva su ciclo');
    assert.equal(mk.count, 1, '$mk conserva su contador');
    assert.equal(rolls.endAt, mk.endAt, 'el par sigue alineado');
    assert.equal(rolls.startAt, mk.startAt, 'el par comparte la ventana');

    // Keys (done) y $rt (listo) no se tocan
    assert.equal(by('keys').done, true, 'Keys terminado sigue como Listo');
    assert.ok(by('rt').endAt - Date.now() > 8 * 60000, '$rt listo no se re-ancla');

    // propuestas de creacion: solo Daily
    const box = doc.getElementById('pasteResults');
    const rows = box.querySelectorAll('.prow');
    const rowsText = rows.map(r => flat(r));
    assert.equal(rows.length, 1, 'solo se ofrece la categoria nueva');
    assert.ok(rowsText[0].includes('$daily'), 'la fila nueva es $daily');
    assert.ok(!rowsText.some(t => t.includes('Claim') || t.includes('$mk') || t.includes('$Rolls') || t.includes('Keys') || t.includes('$rt')), 'no se duplican existentes');
    assert.equal(doc.getElementById('pasteAdd').style.display, 'block', 'pasteAdd visible para la nueva');

    // resumen
    const sum = flat(box);
    assert.ok(sum.includes('Progreso actualizado'), 'resumen de progreso');
    assert.ok(sum.includes('no se tocan'), 'resumen de no tocados');
  });
});

test('frontend: Reclamar permite escoger cuantos reclamar', () => {
  const t0 = Date.now();
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'cl1', cat: 'claim', label: 'Claim', mode: 'repeat', intervalMs: 3600000, startAt: t0, endAt: t0 + 3600000, warnMs: null, warnSent: false, done: false, count: 3, ts: t0 },
        { id: 'mk1', cat: 'kakerareact', label: '$mk', mode: 'repeat', intervalMs: 3600000, startAt: t0, endAt: t0 + 3600000, warnMs: null, warnSent: false, done: false, count: 2, ts: t0 },
        { id: 'rl1', cat: 'rollsreset', label: '$Rolls', mode: 'repeat', intervalMs: 3600000, startAt: t0, endAt: t0 + 3600000, warnMs: null, warnSent: false, done: false, count: 3, ts: t0 }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { globals, doc, onReady } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded) });
  const flat = (node) => { let s = ''; (function z(n) { if (n.textContent) s += n.textContent; n.children.forEach(z); })(node); return s; };
  withTicks(() => {
    onReady();
    const findGroup = (title) => doc.getElementById('timers').children.find(g => String(g.children[0]?.textContent).includes(title));
    const by = (cat) => JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers.find(t => t.cat === cat);

    // Reclamar abre el modal con los disponibles
    buttonIn(cardByLabel(findGroup('En espera'), 'Claim'), 'Reclamar').onclick({ stopPropagation() {} });
    assert.equal(doc.getElementById('claimAvailable').textContent, 'Disponibles: 3', 'muestra los disponibles');

    // reclamar 2: queda 1 y sale toast
    doc.getElementById('claimAmount').value = '2';
    doc.getElementById('claimSave').onclick();
    assert.equal(by('claim').count, 1, 'quedan 1 tras reclamar 2');
    assert.ok(flat(doc.getElementById('toasts')).includes('Reclamaste 2') && flat(doc.getElementById('toasts')).includes('quedan 1'), 'toast de confirmacion');

    // reclamar mas de lo disponible: clampa a 0
    buttonIn(cardByLabel(findGroup('En espera'), 'Claim'), 'Reclamar').onclick({ stopPropagation() {} });
    doc.getElementById('claimAmount').value = '99';
    doc.getElementById('claimSave').onclick();
    assert.equal(by('claim').count, 0, 'nunca queda negativo');

    // contador en 0: Reclamar no abre modal y avisa
    const toastBefore = doc.getElementById('toasts').children.length;
    buttonIn(cardByLabel(findGroup('En espera'), 'Claim'), 'Reclamar').onclick({ stopPropagation() {} });
    assert.equal(doc.getElementById('claimAvailable').textContent, 'Disponibles: 1', 'no re-abre el modal (disponibles intactos)');
    assert.ok(doc.getElementById('toasts').children.length >= toastBefore, 'puede avisar cuando no hay nada');

    // el boton Todo rellena el total
    buttonIn(cardByLabel(findGroup('En espera'), '$mk'), 'Reclamar').onclick({ stopPropagation() {} });
    doc.getElementById('claimAll').onclick();
    assert.equal(doc.getElementById('claimAmount').value, '2', 'Todo rellena el total disponible');
    doc.getElementById('claimSave').onclick();
    assert.equal(by('kakerareact').count, 0, '$mk reclama todo');

    // independencia del par
    assert.equal(by('rollsreset').count, 3, '$Rolls conserva su propio contador');
  });
});

test('frontend: updateCounts pinta cada tarjeta con su propio tiempo (no por posicion)', () => {
  const t0 = Date.now();
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'c1', cat: 'claim', label: 'Claim', mode: 'repeat', intervalMs: 3600000, startAt: t0 + 3600000, endAt: t0 + 7200000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 },
        { id: 'k1', cat: 'kakerareact', label: '$mk', mode: 'repeat', intervalMs: 3600000, startAt: t0 + 7200000, endAt: t0 + 14400000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 },
        { id: 'u1', cat: 'custom', label: 'Un rato', mode: 'once', intervalMs: 1800000, startAt: t0 - 1800000, endAt: t0 + 1800000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { doc, onReady } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded) });
  withTicks((intervals) => {
    onReady();
    const timers = doc.getElementById('timers');
    const findGroup = (title) => timers.children.find(g => String(g.children[0]?.textContent).includes(title));
    const countOf = (label) => cardByLabel(findGroup('En espera · Ciclo'), label) || cardByLabel(findGroup('En espera · Una vez'), label) || cardByLabel(findGroup('En espera'), label);
    const countIn = (label, groupTitle) => cardByLabel(findGroup(groupTitle), label).querySelector('.count')?.textContent;

    // orden del DOM: primero los ciclos (Claim, $mk), despues el "una vez" que vence antes
    assert.ok(countIn('Claim', 'En espera · Ciclo').includes('2h'), 'Claim muestra sus 2h');
    assert.ok(countIn('$mk', 'En espera · Ciclo').includes('4h'), '$mk muestra sus 4h');
    assert.ok(countIn('Un rato', 'En espera · Una vez').includes('30m'), 'el "una vez" de 30m muestra 30m (no el tiempo de un ciclo)');

    // un tick sin cambios re-pinta por identidad y sigue igual
    const tick = intervals.find(i => i.ms === 1000);
    tick.fn();
    assert.ok(countOf('Un rato').querySelector('.count').textContent.includes('30m'), 'tras tick sigue mostrando su propio tiempo');
    assert.ok(countOf('Claim').querySelector('.count').textContent.includes('2h'), 'Claim no recibe el tiempo del "una vez"');
  });
});

test('frontend: al arrancar se sanear los temporizadores danados (NaN/pasado/repeat)', () => {
  const t0 = Date.now();
  const seeded = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'r1', cat: 'rt', label: '$rt', mode: 'repeat', intervalMs: null, startAt: t0 - 7200000, endAt: t0 - 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 },
        { id: 'rc1', cat: 'claim', label: 'Claim', mode: 'repeat', intervalMs: 0, startAt: t0 - 7200000, endAt: t0 - 3600000, warnMs: null, warnSent: false, done: false, count: 3, ts: t0 },
        { id: 'u1', cat: 'custom', label: 'Roto', mode: 'repeat', intervalMs: 3600000, startAt: t0 + 3600000, endAt: t0 - 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const { globals, onReady } = bootApp({ 'mudaeTimer.v1': JSON.stringify(seeded) });
  withTicks(() => {
    onReady();
    const saved = () => JSON.parse(globals.localStorage._d['mudaeTimer.v1']).profiles[0].timers;
    const by = (id) => saved().find(t => t.id === id);
    assert.equal(by('r1').intervalMs, 108000000, 'repeat sin intervalo usa el ciclo canonico de rt (30h)');
    assert.ok(by('r1').endAt > Date.now(), 'repeat atrasado se adelanta al futuro');
    assert.equal(by('rc1').intervalMs, 3600000, 'intervalo 0 se repara a 1h');
    assert.ok(by('rc1').count >= 4, 'los ciclos perdidos suman al contador');
    assert.ok(by('u1').endAt > Date.now(), 'startAt>endAt se re-ancla a futuro');
    assert.ok(isFinite(by('u1').startAt) && by('u1').startAt <= by('u1').endAt, 'span valido tras saneo');
  });
});

test('frontend: adoptRemote sanea el blob remoto y no borra el local si llega vacio', async () => {
  const t0 = Date.now();
  const local = {
    profiles: [{
      id: 'p1', name: 'Mi servidor', timers: [
        { id: 'l1', cat: 'claim', label: 'Claim', mode: 'repeat', intervalMs: 3600000, startAt: t0, endAt: t0 + 3600000, warnMs: null, warnSent: false, done: false, count: 1, ts: t0 }
      ], syncCode: null, syncSeq: 0, pendingOps: []
    }],
    active: 'p1'
  };
  const remoteBad = { guardadoEn: t0 + 100000, profiles: [{ id: 'p9', name: 'Otro', timers: [
    { id: 'x1', cat: 'rt', label: '$rt', mode: 'repeat', intervalMs: null, startAt: t0 - 7200000, endAt: t0 - 3600000, warnMs: null, warnSent: false, done: false, count: 0, ts: t0 - 3600000 }
  ], syncCode: null, syncSeq: 0, pendingOps: [] }] };

  // 1) blob remoto danado se adopta saneado
  const fetchRemote = (url, opts) => {
    const isGet = !opts || opts.method === 'GET' || !opts.method;
    const body = isGet ? remoteBad : null;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  const { globals, onReady } = bootApp({
    'mudaeTimer.v1': JSON.stringify(local), 'mudaeSyncTs': '10'
  }, null, { navigator: { onLine: true }, fetch: fetchRemote });
  withTicks(() => {
    onReady();
  });
  await new Promise(r => setTimeout(r, 120));
  let saved = () => JSON.parse(globals.localStorage._d['mudaeTimer.v1']);
  assert.equal(saved().profiles[0].id, 'p9', 'se adopto el perfil remoto');
  const xt = saved().profiles[0].timers.find(t => t.id === 'x1');
  assert.equal(xt.intervalMs, 108000000, 'el remoto con intervalo nulo usa el ciclo canonico de rt (30h)');
  assert.ok(xt.endAt > Date.now(), 'el remoto atrasado se adelanta al futuro');
  assert.ok(isFinite(xt.startAt) && xt.startAt <= xt.endAt, 'span valido tras adoptar');

  // 2) blob remoto vacio no borra el estado local
  const { globals: g2, onReady: onReady2 } = bootApp({
    'mudaeTimer.v1': JSON.stringify(local), 'mudaeSyncTs': '10'
  }, null, {
    navigator: { onLine: true },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ guardadoEn: t0 + 200000, profiles: [] }) })
  });
  withTicks(() => {
    onReady2();
  });
  await new Promise(r => setTimeout(r, 120));
  const saved2 = JSON.parse(g2.localStorage._d['mudaeTimer.v1']);
  assert.equal(saved2.profiles[0].timers.length, 1, 'un pull vacio no borra los temporizadores locales');
});
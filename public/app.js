'use strict';
(function () {
  var LS_KEY = 'mudaeTimer.v1';
  var CATS = (window.MudaeParse && MudaeParse.CATEGORIES) || [];
  var CAT_BY_KEY = {};
  CATS.forEach(function (c) { CAT_BY_KEY[c.key] = c; });

  // Al terminar un temporizador "una vez" de estas categorias, pasa a repetirse con este ciclo.
  var CAT_CYCLE = { rollsreset: 3600000, kakerareact: 3600000, rollsmk: 3600000, kakera: 6604800, daily: 86400000, rt: 108000000, vote: 43200000 };
  var API = '/api';
  var TA_RECOMMENDED = '$ta claim daily keys kakerareact dk vote rt';

  var state = loadState() || defaultState();
  var deviceId = localStorage.getItem('mudaeDeviceId') || localStorage.getItem('deviceId') || null;
  if (!deviceId) {
    deviceId = 'd' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem('mudaeDeviceId', deviceId); } catch (e) {}
  } else {
    try { localStorage.setItem('mudaeDeviceId', deviceId); } catch (e) {}
  }
  var pushActive = false;
  var pushOK = false;
  var editTarget = null;

  function defaultState() {
    return {
      profiles: [{ id: 'p1', name: 'Mi servidor', timers: [] }],
      active: 'p1'
    };
  }

  // Funde los temporizadores viejos de $mk y $Rolls en uno solo ("$rolls y $mk").
  function migrateLegacy(prof) {
    var olds = prof.timers.filter(function (x) { return x.cat === 'kakerareact' || x.cat === 'rollsreset'; });
    if (!olds.length) return;
    var endAt = 0, st = 0;
    olds.forEach(function (x) { if (x.endAt > endAt) { endAt = x.endAt; st = x.startAt || 0; } });
    var now = Date.now();
    var t = {
      id: 'merge-rollsmk',
      cat: 'rollsmk',
      label: CAT_BY_KEY.rollsmk ? CAT_BY_KEY.rollsmk.day : '$rolls y $mk',
      mode: 'repeat',
      intervalMs: 3600000,
      startAt: st || endAt - 3600000,
      endAt: endAt > now ? endAt : now,
      warnMs: null,
      warnSent: false,
      done: false,
      count: 0,
      ts: now
    };
    prof.timers = prof.timers.filter(function (x) { return x.cat !== 'kakerareact' && x.cat !== 'rollsreset'; });
    prof.timers.push(t);
    olds.forEach(function (x) {
      if (deviceId && pushActive) api('POST', '/cancel', { deviceId: deviceId, timerId: x.id });
    });
    syncRemote(t);
  }

  function loadState() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return null; }
  }
  function save() {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    scheduleSync(false);
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function activeProfile() {
    return state.profiles.find(function (p) { return p.id === state.active; }) || state.profiles[0];
  }

  // ---------- Motor de tiempo ----------
  function advanceCatchUp(t) {
    if (t.mode !== 'repeat') return false;
    var ch = 0;
    while (t.endAt <= Date.now()) { t.endAt += t.intervalMs; ch++; }
    if (ch) t.count = (t.count || 0) + ch;
    return ch > 0;
  }
  function remaining(t) { return Math.max(0, t.endAt - Date.now()); }
  function progress(t) {
    var total = t.endAt - t.startAt;
    if (total <= 0) return 0;
    var done = Date.now() - t.startAt;
    return Math.max(0, Math.min(1, done / total));
  }
  function restartTimer(t, ms) {
    t.intervalMs = ms || t.intervalMs;
    t.startAt = Date.now();
    t.endAt = t.startAt + t.intervalMs;
    t.done = false;
    t.warnSent = false;
    t.ts = Date.now();
    syncRemote(t);
    save();
    render();
  }

  // Alterna entre "una sola vez" y "ciclo" (al terminar, se repite solo).
  function toggleMode(t) {
    if (t.mode === 'repeat') {
      t.mode = 'once';
    } else {
      t.mode = 'repeat';
      t.intervalMs = t.intervalMs || remaining(t) || 3600000;
      if (t.done || t.endAt <= Date.now()) {
        t.startAt = Date.now();
        t.endAt = t.startAt + t.intervalMs;
      }
    }
    t.done = false;
    t.warnSent = false;
    t.ts = Date.now();
    syncRemote(t);
    save();
    render();
  }

  function openEdit(t) {
    editTarget = t;
    var ms = t.intervalMs || remaining(t) || 3600000;
    document.getElementById('editHours').value = Math.floor(ms / 3600000);
    document.getElementById('editMinutes').value = Math.floor((ms % 3600000) / 60000);
    openModal('editModal');
  }

  // ---------- Notificaciones (local + push backend) ----------
  var pushStatus = document.createElement('span');

  function beep() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    var ctx = window.__beepCtx;
    if (!ctx) {
      try { ctx = window.__beepCtx = new Ctx(); } catch (e) { return; }
    }
    try {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      var t0 = ctx.currentTime;
      [0, 0.18, 0.36].forEach(function (dt, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = i === 0 ? 880 : 1100;
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.5, t0 + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.5);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0 + dt); o.stop(t0 + dt + 0.55);
      });
    } catch (e) {}
  }

  // Crea/desbloquea el audio con el primer gesto para que el sonido funcione siempre.
  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || window.__beepCtx) return;
      var ctx = window.__beepCtx = new Ctx();
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    } catch (e) {}
  }

  function localNotify(title, body, tag) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body: body, tag: tag || '', icon: 'icon.svg' }); } catch (e) {}
    }
    beep();
    flashNotice(body ? title + ': ' + body : title);
  }

  async function api(method, path, body) {
    try {
      var res = await fetch(API + path, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      return res.json();
    } catch (e) { return null; }
  }

  function syncRemote(t) {
    if (!deviceId || !pushActive) return;
    var base = { deviceId: deviceId, timerId: t.id };
    if (t.done) { api('POST', '/cancel', base); return; }
    var pl = {
      deviceId: deviceId, timerId: t.id + ':fire', fireAt: t.endAt,
      title: t.label, body: 'El comando ya está disponible.', tag: t.id
    };
    if (t.mode === 'repeat' && t.intervalMs) pl.repeatMs = t.intervalMs;
    api('POST', '/schedule', pl);
    if (t.warnMs) {
      api('POST', '/schedule', Object.assign({}, base, {
        timerId: t.id + ':warn', fireAt: t.endAt - t.warnMs,
        title: t.label + ' casi listo',
        body: 'Listo en ' + MudaeParse.msToText(t.warnMs) + '.', tag: t.id + '-warn'
      }));
    }
  }

  async function setupPush() {
    var btn = document.getElementById('pushBtn');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw 0;
      var reg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        var v = await api('GET', '/vapid');
        if (!v || !v.publicKey) throw 0;
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: v.publicKey });
      }
      var out = await api('POST', '/subscribe', { endpoint: sub.endpoint, keys: sub.toJSON().keys, deviceId: deviceId });
      if (!out || !out.deviceId) throw 0;
      deviceId = out.deviceId;
      try { localStorage.setItem('mudaeDeviceId', deviceId); localStorage.setItem('deviceId', deviceId); } catch (err) {}
      pushActive = true;
      activeProfile().timers.forEach(syncRemote);
      setPushStatus(true, 'Push activado');
    } catch (e) {
      pushActive = false;
      setPushStatus(false, 'Solo local (backend no disponible)');
    }
  }

  function setPushStatus(ok, txt) {
    pushStatus.textContent = 'Notificaciones: ' + txt;
    pushStatus.className = ok ? 'push-ok' : 'push-warn';
    document.getElementById('pushBtn').textContent = ok ? 'Reconectar push' : 'Activar notificaciones';
    pushOK = ok;
  }

  // ---------- Sincronizacion entre dispositivos (MantleDB, como "Horarios") ----------
  var SYNC_URL = 'https://mantledb.sh/v2/mudae-timer-sync-8xzP4QmK3c/estado';
  var SYNC_DELAY_MS = 1200;
  var syncTs = parseInt(localStorage.getItem('mudaeSyncTs') || '0', 10) || 0;
  var syncTimer = null, syncRetries = 0, syncPending = false;

  function setSyncStatus(txt) {
    var el = document.getElementById('sync-status');
    if (el) el.textContent = txt;
  }
  function onlineOk() {
    return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' && navigator.onLine;
  }

  // Serializa solo los datos de usuario (sin campos internos del sync antiguo).
  function blobForSync() {
    return state.profiles.map(function (p) {
      return {
        id: p.id, name: p.name,
        timers: (p.timers || []).map(function (t) {
          return {
            id: t.id, cat: t.cat, label: t.label, mode: t.mode,
            intervalMs: t.intervalMs, startAt: t.startAt, endAt: t.endAt,
            warnMs: t.warnMs, warnSent: t.warnSent, done: t.done, count: t.count, ts: t.ts
          };
        })
      };
    });
  }

  function scheduleSync(immediate) {
    syncPending = true;
    clearTimeout(syncTimer);
    setSyncStatus('⇅ Subiendo…');
    syncTimer = setTimeout(function () { pushState(); }, immediate ? 200 : SYNC_DELAY_MS);
  }

  function localTimerCount() {
    var prof = activeProfile();
    return (prof && prof.timers) ? prof.timers.length : 0;
  }

  async function pushState() {
    if (!onlineOk()) { setSyncStatus('⚠ Sin conexión'); return; }
    try {
      var cur = await fetch(SYNC_URL, { cache: 'no-store' });
      var remoto = cur.ok ? await cur.json() : null;
      var tsRemote = (remoto && remoto.guardadoEn) || 0;
      var remoteTimers = remoto && remoto.profiles
        ? remoto.profiles.reduce(function (n, p) { return n + (p.timers || []).length; }, 0) : 0;
      if (tsRemote > syncTs && remoto.profiles) { adoptRemote(remoto.profiles, tsRemote); return; }
      if (localTimerCount() === 0 && remoteTimers > 0 && remoto.profiles) {
        adoptRemote(remoto.profiles, tsRemote);
        return;
      }
      var guardadoEn = Date.now();
      var r = await fetch(SYNC_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guardadoEn: guardadoEn, profiles: blobForSync() })
      });
      if (!r.ok) throw new Error(String(r.status));
      syncTs = guardadoEn;
      syncRetries = 0;
      syncPending = false;
      try { localStorage.setItem('mudaeSyncTs', String(syncTs)); } catch (e) {}
      setSyncStatus('✓ Sincronizado');
    } catch (e) {
      syncRetries++;
      setSyncStatus('⚠ Sin conexión');
      if (syncRetries <= 3) syncTimer = setTimeout(function () { scheduleSync(true); }, 8000);
    }
  }

  async function pullSync() {
    if (!onlineOk()) return;
    if (syncTs === 0) {
      setSyncStatus('· Pega tu codigo en Sincronizar');
      return;
    }
    try {
      var r = await fetch(SYNC_URL, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      var remoto = await r.json();
      var tsRemote = (remoto && remoto.guardadoEn) || 0;
      if (tsRemote > syncTs && remoto.profiles) {
        adoptRemote(remoto.profiles, tsRemote);
        setSyncStatus('✓ Sincronizado');
      } else if (syncPending || tsRemote < syncTs) {
        scheduleSync(true);
      } else {
        setSyncStatus('✓ Sincronizado');
      }
    } catch (e) {
      if (syncTs === 0 && !localStorage.getItem(LS_KEY)) return;
      if (syncTs === 0) scheduleSync(true);
      else setSyncStatus('');
    }
  }

  function adoptRemote(profiles, tsRemote) {
    state.profiles = profiles;
    try { localStorage.setItem('mudaeSyncTs', String(tsRemote)); } catch (e) {}
    syncTs = tsRemote;
    syncPending = false;
    state.profiles.forEach(function (p) { (p.timers || []).forEach(advanceCatchUp); });
    save();
    render();
    if (pushActive) activeProfile().timers.forEach(syncRemote);
  }

  function initSync() {
    document.getElementById('syncBtn').onclick = function () { openModal('syncModal'); showSyncModal(); };
    document.getElementById('syncForce').onclick = function () {
      pullSync().then(function () { if (!syncPending) scheduleSync(true); });
    };
    document.getElementById('syncJoin').onclick = syncJoin;
    setSyncStatus(syncTs ? '✓ Sincronizado' : '');
  }
  function showSyncModal() {
    var st = document.getElementById('syncStatusText');
    if (st) st.textContent = document.getElementById('sync-status').textContent || 'Aun no sincronizado';
    var hint = document.getElementById('syncHint');
    if (hint) hint.textContent = 'Pega el codigo de tu sesion (como antes) y se aplicara la sesion mas reciente. '
      + 'Una vez unido, cada cambio se sube solo.';
    var input = document.getElementById('syncCode');
    if (input && !input.value) {
      try { input.value = localStorage.getItem('mudaeSyncCode') || ''; } catch (e) {}
    }
  }
  function syncJoin() {
    var input = document.getElementById('syncCode');
    var joinStatus = document.getElementById('syncJoinStatus');
    var code = (input && (input.value || '').trim()) || '';
    if (!code) {
      if (joinStatus) joinStatus.textContent = 'Pega un codigo para continuar.';
      if (input) input.focus();
      return;
    }
    if (joinStatus) joinStatus.textContent = 'Consultando la sesion mas reciente...';
    fetch(SYNC_URL, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (remoto) {
        if (!remoto || !remoto.profiles || !remoto.profiles.length) throw new Error('no hay datos de sesion');
        adoptRemote(remoto.profiles, (remoto && remoto.guardadoEn) || 0);
        try { localStorage.setItem('mudaeSyncCode', code); } catch (e) {}
        if (input) input.value = code;
        var n = remoto.profiles.reduce(function (c, p) { return c + (p.timers || []).length; }, 0);
        if (joinStatus) joinStatus.textContent = 'Sincronizado a la sesion mas reciente (' + n + ' temporizadores).';
        setSyncStatus('✓ Sincronizado');
      })
      .catch(function (e) {
        if (joinStatus) joinStatus.textContent = 'Error: ' + e.message;
      });
  }

  // ---------- Persistencia + render ----------
  function render() {
    var prof = activeProfile();
    document.getElementById('profileName').textContent = prof.name;
    var sel = document.getElementById('profileSel');
    var prev = sel.value;
    sel.innerHTML = '';
    state.profiles.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.value = prev || prof.id;

    var list = document.getElementById('timers');
    list.innerHTML = '';
    if (!prof.timers.length) {
      var hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'Sin temporizadores. Pega tu $tu o añade uno a mano.';
      list.appendChild(hint);
      return;
    }
    var ready = prof.timers.filter(function (t) { return t.done; });
    var wait = prof.timers.filter(function (t) { return !t.done; });
    ready.sort(function (a, b) { return (b.endAt || 0) - (a.endAt || 0); });
    wait.sort(function (a, b) { return remaining(a) - remaining(b); });
    if (wait.length) list.appendChild(group('En espera', wait));
    if (ready.length) list.appendChild(group('Disponibles', ready));
  }

  function group(title, timers) {
    var g = document.createElement('details');
    g.className = 'group';
    g.open = true;
    var sum = document.createElement('summary');
    sum.className = 'group-title';
    sum.textContent = title + ' (' + timers.length + ')';
    g.appendChild(sum);
    timers.forEach(function (t) { g.appendChild(card(t)); });
    return g;
  }

  function chip(txt, cls) {
    var s = document.createElement('span');
    s.className = 'chip ' + (cls || '');
    s.textContent = txt;
    return s;
  }

  function card(t) {
    var cat = CAT_BY_KEY[t.cat];
    var el = document.createElement('div');
    el.className = 'timer ' + (t.done ? 'done' : 'running');

    var head = document.createElement('div'); head.className = 'head';
    var badge = document.createElement('span'); badge.className = 'badge';
    var titleTxt = cat && cat.day ? cat.day : t.label;
    badge.textContent = String(t.count || 0);
    head.appendChild(badge);
    var title = document.createElement('div'); title.className = 'title';
    var l = document.createElement('div'); l.className = 'tlabel'; l.textContent = titleTxt;
    title.appendChild(l);
    head.appendChild(title);

    var count = document.createElement('div'); count.className = 'count';
    count.textContent = t.done ? 'Listo' : MudaeParse.msToText(remaining(t), remaining(t) < 3600000);
    if (t.done) count.classList.add('count-done');
    head.appendChild(count);
    el.appendChild(head);

    var barWrap = document.createElement('div'); barWrap.className = 'bar';
    var bar = document.createElement('div'); bar.className = 'bar-fill';
    bar.style.width = (t.done ? 100 : progress(t) * 100).toFixed(1) + '%';
    barWrap.appendChild(bar);
    el.appendChild(barWrap);

    var meta = document.createElement('div'); meta.className = 'meta';
    meta.appendChild(chip(t.mode === 'repeat' ? 'Repite cada ' + MudaeParse.msToText(t.intervalMs) : 'Una vez', 'info'));
    if (t.warnMs) meta.appendChild(chip('Aviso ' + MudaeParse.msToText(t.warnMs) + ' antes', 'warn'));
    el.appendChild(meta);

    var actions = document.createElement('div'); actions.className = 'actions';
    var btnRestart = document.createElement('button');
    btnRestart.textContent = 'Reiniciar';
    btnRestart.onclick = function (e) { e.stopPropagation(); restartTimer(t, t.intervalMs || 3600000); };
    actions.appendChild(btnRestart);
    var btnClaim = document.createElement('button');
    btnClaim.textContent = 'Reclamar';
    btnClaim.onclick = function (e) {
      e.stopPropagation();
      t.count = 0;
      t.ts = Date.now();
      syncRemote(t);
      save();
      render();
    };
    actions.appendChild(btnClaim);
    var btnMode = document.createElement('button');
    btnMode.textContent = t.mode === 'repeat' ? 'Una vez' : 'Ciclo';
    btnMode.className = 'ghost';
    btnMode.onclick = function (e) { e.stopPropagation(); toggleMode(t); };
    actions.appendChild(btnMode);
    var btnEdit = document.createElement('button');
    btnEdit.textContent = 'Editar tiempo';
    btnEdit.className = 'ghost';
    btnEdit.onclick = function (e) { e.stopPropagation(); openEdit(t); };
    actions.appendChild(btnEdit);
    if (t.mode === 'once') {
      var btnDone = document.createElement('button');
      btnDone.textContent = t.done ? 'Quitar listo' : 'Listo';
      btnDone.className = 'ghost';
      btnDone.onclick = function (e) {
        e.stopPropagation();
        t.done = !t.done;
        t.warnSent = true;
        t.ts = Date.now();
        syncRemote(t);
        save(); render();
      };
      actions.appendChild(btnDone);
    }
    var btnDel = document.createElement('button');
    btnDel.textContent = 'Eliminar';
    btnDel.className = 'ghost danger';
    btnDel.onclick = function (e) {
      e.stopPropagation();
      activeProfile().timers = activeProfile().timers.filter(function (x) { return x.id !== t.id; });
      if (deviceId) api('POST', '/cancel', { deviceId: deviceId, timerId: t.id });
      save(); render();
    };
    actions.appendChild(btnDel);
    el.appendChild(actions);
    return el;
  }

  // ---------- Añadir temporizador ----------
  function addTimer(opts) {
    var now = Date.now();
    var t = {
      id: uid(),
      cat: opts.cat || 'custom',
      label: opts.label || (CAT_BY_KEY[opts.cat] ? CAT_BY_KEY[opts.cat].day : 'Tiempo'),
      mode: opts.mode || 'once',
      intervalMs: opts.ms,
      startAt: now,
      endAt: now + opts.ms,
      warnMs: opts.warnMs || null,
      warnSent: false,
      done: false,
      count: 0,
      ts: now
    };
    activeProfile().timers.push(t);
    syncRemote(t);
    save();
    render();
  }

  function openModal(id) {
    document.getElementById(id).classList.add('open');
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove('open');
  }

  function initAddModal() {
    var sel = document.getElementById('addCat');
    sel.innerHTML = '';
    CATS.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.key; o.textContent = c.day;
      sel.appendChild(o);
    });
    var o = document.createElement('option');
    o.value = 'custom'; o.textContent = 'Personalizado';
    sel.appendChild(o);

    sel.addEventListener('change', function () {
      if (sel.value === 'kakera' && !document.getElementById('addTime').value) {
        document.getElementById('addTime').value = '110.08m';
      }
    });

    document.getElementById('addSave').onclick = function () {
      var cat = sel.value;
      var ms = MudaeParse.textToMs(document.getElementById('addTime').value);
      if (!ms) { document.getElementById('addTime').focus(); return; }
      var mode = document.querySelector('input[name="mode"]:checked').value;
      var warnMs = null;
      if (document.getElementById('addWarn').checked) {
        warnMs = MudaeParse.textToMs(document.getElementById('addWarnTime').value) || 300000;
      }
      var customLabel = document.getElementById('addLabel').value.trim();
      var label = customLabel || (cat === 'custom' ? 'Personalizado' : (CAT_BY_KEY[cat] ? CAT_BY_KEY[cat].day : 'Tiempo'));
      addTimer({ cat: cat, ms: ms, mode: mode, warnMs: warnMs, label: label });
      closeModal('addModal');
      document.getElementById('addTime').value = '';
    };
  }

  // ---------- Modal pegar $tu ----------
  function initPasteModal() {
    document.getElementById('taCopy').textContent = TA_RECOMMENDED;
    document.getElementById('taCopyBtn').onclick = function () {
      navigator.clipboard.writeText(TA_RECOMMENDED).then(function () {
        document.getElementById('taCopyBtn').textContent = '¡Copiado!';
        setTimeout(function () { document.getElementById('taCopyBtn').textContent = 'Copiar comando $ta recomendado'; }, 2000);
      });
    };
    document.getElementById('pasteDetect').onclick = function () {
      var text = document.getElementById('pasteText').value;
      var found = MudaeParse.parseTuText(text);
      var box = document.getElementById('pasteResults');
      box.innerHTML = '';
      if (!found.length) {
        box.textContent = 'No se detectó nada. Intenta pegar el texto completo de $tu, o usa "Añadir tiempo".';
        return;
      }
      found.forEach(function (r) {
        var row = document.createElement('div'); row.className = 'prow';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
        cb.dataset.i = String(found.indexOf(r));
        var name = document.createElement('span'); name.className = 'pname';
        var cat = CAT_BY_KEY[r.category];
        name.textContent = (cat ? cat.day : r.category) + (r.ready ? ' (listo)' : '');
        var timeIn = document.createElement('input'); timeIn.type = 'text';
        timeIn.value = r.ready ? '' : MudaeParse.msToText(r.ms, true);
        timeIn.dataset.i = String(found.indexOf(r));
        row.appendChild(cb); row.appendChild(name); row.appendChild(timeIn);
        box.appendChild(row);
      });
      document.getElementById('pasteAdd').style.display = 'block';
      document.getElementById('pasteAdd').onclick = function () {
        var rows = box.querySelectorAll('.prow');
        var added = 0;
        rows.forEach(function (row) {
          var cb = row.querySelector('.prow input[type=checkbox]');
          var timeIn = row.querySelector('.prow input[type=text]');
          if (!cb.checked) return;
          var f = found[Number(cb.dataset.i)];
          var ms = MudaeParse.textToMs(timeIn.value);
          if (ms == null) ms = 0;
          addTimer({ cat: f.category, ms: ms, mode: 'once', warnMs: null, label: CAT_BY_KEY[f.category] ? CAT_BY_KEY[f.category].day : f.category });
          added++;
        });
        document.getElementById('pasteText').value = '';
        box.innerHTML = '';
        document.getElementById('pasteAdd').style.display = 'none';
        closeModal('pasteModal');
        if (added) flashNotice(added + ' temporizador(es) añadido(s).');
      };
    };
  }

  function flashNotice(msg) {
    var n = document.createElement('div');
    n.className = 'notice';
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(function () { n.remove(); }, 2500);
  }

  // ---------- Perfiles ----------
  function initProfiles() {
    document.getElementById('profileSel').onchange = function (e) {
      state.active = e.target.value;
      save(); render();
    };
    document.getElementById('addProfile').onclick = function () {
      var name = prompt('Nombre del servidor/perfil:');
      if (!name) return;
      var p = { id: uid(), name: name, timers: [] };
      state.profiles.push(p);
      state.active = p.id;
      save(); render();
    };
    document.getElementById('delProfile').onclick = function () {
      var p = activeProfile();
      if (state.profiles.length <= 1) { flashNotice('Debe quedar al menos un perfil.'); return; }
      if (!confirm('Eliminar el perfil "' + p.name + '" y sus temporizadores?')) return;
      state.profiles = state.profiles.filter(function (x) { return x.id !== p.id; });
      state.active = state.profiles[0].id;
      save(); render();
    };
  }

  function isHidden() {
    return typeof document !== 'undefined' && document.hidden === true;
  }

  // ---------- Ticker ----------
  function tick() {
    var prof = activeProfile();
    var now = Date.now();
    var changed = false;
    prof.timers.forEach(function (t) {
      if (t.done) return;
      var rem = t.endAt - now;
      if (t.warnMs && !t.warnSent && rem > 0 && rem <= t.warnMs) {
        t.warnSent = true;
        localNotify(t.label + ' casi listo', 'Listo en ' + MudaeParse.msToText(t.warnMs) + '.', t.id + '-warn');
      }
      if (rem <= 0) {
        t.count = (t.count || 0) + 1;
        var catCycle = CAT_CYCLE[t.cat];
        if (t.mode === 'once' && catCycle) {
          t.mode = 'repeat';
          t.intervalMs = catCycle;
          t.startAt = t.endAt;
          t.endAt = t.endAt + catCycle;
          while (t.endAt <= Date.now()) t.endAt += t.intervalMs;
          t.warnSent = false;
          t.ts = Date.now();
          syncRemote(t);
        } else if (t.mode === 'repeat') {
          t.startAt = t.endAt;
          t.endAt = t.endAt + t.intervalMs;
          while (t.endAt <= Date.now()) t.endAt += t.intervalMs;
          t.warnSent = false;
          t.ts = Date.now();
          syncRemote(t);
        } else {
          t.done = true;
          t.ts = Date.now();
          syncRemote(t);
        }
        localNotify(t.label, 'El comando ya está disponible.', t.id);
        changed = true;
      }
    });
    var hidden = isHidden();
    if (changed) { save(); if (!hidden) render(); }
    else if (!hidden) updateCounts();
  }

  function updateCounts() {
    var prof = activeProfile();
    document.querySelectorAll('.timer.running').forEach(function (el, i) {
      var sorted = prof.timers.filter(function (x) { return !x.done; }).sort(function (a, b) { return (a.endAt - Date.now()) - (b.endAt - Date.now()); });
      var t = sorted[i];
      if (!t) { el.style.display = 'none'; return; }
      var c = el.querySelector('.count');
      c.textContent = MudaeParse.msToText(remaining(t), remaining(t) < 3600000);
      var bar = el.querySelector('.bar-fill');
      bar.style.width = (progress(t) * 100).toFixed(1) + '%';
    });
  }

  // ---------- Init ----------
  function init() {
    state = loadState() || defaultState();
    initProfiles();
    initAddModal();
    initPasteModal();
    initSync();
    document.getElementById('editSave').onclick = function () {
      if (!editTarget) return;
      var h = parseInt(document.getElementById('editHours').value, 10) || 0;
      var m = parseInt(document.getElementById('editMinutes').value, 10) || 0;
      var ms = h * 3600000 + m * 60000;
      if (ms <= 0) { document.getElementById('editMinutes').focus(); return; }
      restartTimer(editTarget, ms);
      editTarget = null;
      closeModal('editModal');
    };
    document.getElementById('addBtn').onclick = function () { openModal('addModal'); };
    document.getElementById('pasteBtn').onclick = function () { openModal('pasteModal'); };
    document.getElementById('pushBtn').onclick = function () {
      if (pushOK !== true) {
        if (!('Notification' in window)) { flashNotice('Notificaciones no soportadas aquí.'); return; }
        Notification.requestPermission().then(function (perm) {
          if (perm === 'granted') setupPush();
          else setPushStatus(false, 'Permiso denegado');
        });
      } else {
        setupPush();
      }
    };
    var opens = document.querySelectorAll('[data-close]');
    opens.forEach(function (b) { b.onclick = function () { closeModal(b.getAttribute('data-close')); }; });
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) closeModal(m.id); });
    });
    state.profiles.forEach(migrateLegacy);
    state.profiles.forEach(function (p) {
      p.timers.forEach(advanceCatchUp);
    });
    save(); render();
    setPushStatus(false, pushActive ? 'conectado al backend' : 'no conectado (activa push)');
    if (deviceId && location.protocol === 'https:') setupPush();
    setInterval(tick, 1000);
    setInterval(pullSync, 30000);
    if (typeof addEventListener === 'function') {
      addEventListener('online', function () { pullSync(); });
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pointerdown', unlockAudio, { once: true });
      window.addEventListener('keydown', unlockAudio, { once: true });
      window.addEventListener('beforeunload', function () {
        if (syncPending) {
          try {
            fetch(SYNC_URL, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ guardadoEn: Date.now(), profiles: blobForSync() }), keepalive: true
            });
          } catch (e) {}
        }
      });
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden !== true) {
          activeProfile().timers.forEach(advanceCatchUp);
          save(); render();
          pullSync();
          if (deviceId && 'Notification' in window && Notification.permission === 'granted' && !pushActive) {
            setupPush();
          }
        }
      });
    }
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
    pullSync();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
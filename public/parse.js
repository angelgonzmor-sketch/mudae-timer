/* Pure parser for Mudae $tu output. Works in both browser and Node. */
(function (root) {
  'use strict';

  var MS = { d: 86400000, h: 3600000, m: 60000, s: 1000 };

  /* Convierte "2h 30m", "90m", "1d", "1:05:30", "45s" a milisegundos. */
  function textToMs(str) {
    if (typeof str !== 'string') return null;
    str = str.trim();
    if (!str) return null;

    var clock = str.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (clock) {
      return ((Number(clock[1]) * 3600) + Number(clock[2]) * 60 + Number(clock[3] || 0)) * 1000;
    }

    var total = 0, found = false;
    var re = /(\d+(?:[.,]\d+)?)\s*(dias|dia|days|day|d|hrs|hours|horas|hora|hr|h|min|mins|minutos|minuto|minutes|minute|m|seg|segs|segundos|segundo|seconds|second|secs|sec|s)\b/gi;
    var m;
    while ((m = re.exec(str)) !== null) {
      var n = parseFloat(m[1].replace(',', '.'));
      var u = m[2].toLowerCase();
      if (u === 'd' || u === 'dia' || u === 'dias' || u === 'day' || u === 'days') total += n * MS.d;
      else if (u === 'h' || u === 'hr' || u === 'hrs' || u === 'hour' || u === 'hours' || u === 'hora' || u === 'horas') total += n * MS.h;
      else if (u === 'm' || u === 'min' || u === 'mins' || u === 'minute' || u === 'minutes' || u === 'minuto' || u === 'minutos') total += n * MS.m;
      else total += n * MS.s;
      found = true;
    }
    return found ? Math.round(total) : null;
  }

  /* Convierte milisegundos a texto corto: "1d 2h 30m", "Listo" si es 0. */
  function msToText(ms, withSeconds) {
    ms = Number(ms);
    if (!isFinite(ms)) return '—';
    var neg = ms < 0;
    ms = Math.abs(ms);
    if (ms === 0) return 'Listo';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var mi = Math.floor(s / 60); s -= mi * 60;
    var parts = [];
    if (d) parts.push(d + 'd');
    if (h) parts.push(h + 'h');
    if (mi) parts.push(mi + 'm');
    if ((withSeconds && s) || parts.length === 0) parts.push(s + 's');
    return (neg ? '-' : '') + parts.join(' ');
  }

  var CATEGORIES = [
    { key: 'claim',        day: 'Claim',           aliases: ['claim', 'next claim', 'reclamo', 'reclamar', 'reclama', 'marryup', 'matrimonio'] },
    { key: 'daily',        day: '$daily',        aliases: ['reinicio de $daily', 'dailyup', 'daily rolls reset', 'daily roll', 'daily reset', 'daily'] },
    { key: 'keys',         day: 'Keys',            aliases: ['bonus keys up', 'bonus keys', 'keysup', 'keys lvl', 'soulkeys', 'gold keys', 'llaves'] },
    { key: 'rollsmk',      day: '$rolls y $mk',  aliases: ['rolls reset', 'reset rolls', 'rollsreset', 'reinicio sera', 'rolls left', 'stacked rolls', 'kakerareact', '$mk', 'mk'] },
    { key: 'kakera',       day: 'Kakera',         aliases: ['kakera react', 'kakera reaction', 'reaccionar a kakera', 'react to kakera', 'kakera up', 'kakera'] },
    { key: 'rt',           day: '$rt',             aliases: ['$rt', 'reset claim timer', 'resetclaim', 'rt:'] },
    { key: 'dk',           day: '$dk',           aliases: ['dailykakera', 'daily kakera', '$dk', 'dk:'] },
    { key: 'pokemon',      day: '$p',            aliases: ['pokéslot', 'pokeslot', 'poke slot', 'pokemon', '$p', 'pokes'] },
    { key: 'vote',         day: '$vote',         aliases: ['top.gg', 'top gg', 'next vote', 'votar', 'voting', 'upvote', 'vote'] }
  ];
  // El desempate por "alias más largo" evita falsos positivos ("kakera react" > "kakera").

  /* Elige la categoría cuyo alias tiene la coincidencia MÁS larga en la línea. */
  /* Se normalizan minúsculas y acentos (NFD) para tolerar "será"/"sera". */
  function detectCategory(line) {
    var l = ' ' + String(line).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\*\*|`/g, '') + ' ';
    var bestKey = null, bestLen = 0, bestScore = 0;
    for (var i = 0; i < CATEGORIES.length; i++) {
      var c = CATEGORIES[i];
      for (var j = 0; j < c.aliases.length; j++) {
        var a = c.aliases[j];
        var idx = l.indexOf(a);
        if (idx >= 0) {
          if (a.length > bestLen || (a.length === bestLen && score(c.key) < bestScore)) {
            bestLen = a.length; bestScore = score(c.key); bestKey = c.key;
          }
        }
      }
    }
    return bestKey;
  }

  /* Desempata: orden de prioridad entre categorías parecidas. */
  function score(key) {
    var order = ['rollsmk', 'kakera', 'dk', 'rt', 'daily', 'keys', 'claim', 'vote', 'pokemon'];
    var i = order.indexOf(key);
    return i < 0 ? 50 : i;
  }

  var READY = /(ready|available|listo|disponible|ya puedes|now|ahora mismo|\u2705|\u2714|\u2713)/i;

  /* Analiza el texto pegado de $tu: devuelve [{category, ms, ready, raw}] en orden de aparición. */
  function parseTuText(text) {
    if (!text) return [];
    var results = [];
    var lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var cat = detectCategory(line);
      if (!cat) continue;
      var ms = textToMs(line);
      var ready = ms === 0 || READY.test(line);
      if (ms !== null || ready) {
        results.push({ category: cat, ms: ms === null ? 0 : ms, ready: ready, raw: line });
      }
    }
    return results;
  }

  var api = { textToMs: textToMs, msToText: msToText, CATEGORIES: CATEGORIES, detectCategory: detectCategory, parseTuText: parseTuText };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MudaeParse = api;
})(typeof self !== 'undefined' ? self : this);
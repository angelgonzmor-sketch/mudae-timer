'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { textToMs, msToText, detectCategory, parseTuText } = require('../public/parse.js');

test('textToMs: unidades comunes', () => {
  assert.equal(textToMs('2h'), 2 * 3600000);
  assert.equal(textToMs('2h 30m'), 2 * 3600000 + 30 * 60000);
  assert.equal(textToMs('90m'), 90 * 60000);
  assert.equal(textToMs('45s'), 45000);
  assert.equal(textToMs('1d'), 86400000);
  assert.equal(textToMs('1d 2h 3m 4s'), 86400000 + 2 * 3600000 + 3 * 60000 + 4000);
  assert.equal(textToMs('1:05:30'), (3600 + 300 + 30) * 1000);
  assert.equal(textToMs('1.5h'), 1.5 * 3600000);
  assert.equal(textToMs(''), null);
  assert.equal(textToMs('nada de tiempo'), null);
});

test('textToMs: español', () => {
  assert.equal(textToMs('1 hora 30 minutos'), 3600000 + 30 * 60000);
  assert.equal(textToMs('2 horas'), 2 * 3600000);
  assert.equal(textToMs('5 min'), 5 * 60000);
});

test('msToText', () => {
  assert.equal(msToText(0), 'Listo');
  assert.equal(msToText(2 * 3600000 + 30 * 60000), '2h 30m');
  assert.equal(msToText(3600000), '1h');
  assert.equal(msToText(60000), '1m');
  assert.equal(msToText(86400000 + 3600000), '1d 1h');
});

test('detectCategory: prioridad de alias largos', () => {
  assert.equal(detectCategory('Claim available in 2h'), 'claim');
  assert.equal(detectCategory('Rolls reset in 1h'), 'rollsmk');
  assert.equal(detectCategory('Daily reset: 4h'), 'daily');
  assert.equal(detectCategory('Daily kakera: 6h'), 'dk');
  assert.equal(detectCategory('Kakera react: 1h'), 'kakera');
  assert.equal(detectCategory('Vote: 12h'), 'vote');
  assert.equal(detectCategory('$rt: 6h'), 'rt');
});

test('parseTuText: mensaje simulado de $tu', () => {
  const sample = [
    '**Claim** — 2h 30m',
    'Daily reset: 20h',
    'Kakera: listo ahora',
    'Vote: 12h',
    'Pokéslot: 1h',
    'Rolls reset: 1h'
  ].join('\n');
  const out = parseTuText(sample);
  assert.equal(out.length, 6);
  const byCat = Object.fromEntries(out.map(r => [r.category, r]));
  assert.equal(byCat.claim.ms, 2 * 3600000 + 30 * 60000);
  assert.equal(byCat.daily.ms, 20 * 3600000);
  assert.equal(byCat.kakera.ready, true);
  assert.equal(byCat.vote.ms, 12 * 3600000);
  assert.equal(byCat.pokemon.ms, 3600000);
  assert.equal(byCat.rollsmk.ms, 3600000);
});

test('parseTuText: lista vacía y null-safe', () => {
  assert.deepEqual(parseTuText(''), []);
  assert.deepEqual(parseTuText(null), []);
  assert.deepEqual(parseTuText('texto sin categorías ni tiempos'), []);
});

test('detectCategory no debe fallar con palabras parecidas', () => {
  assert.notEqual(detectCategory('start of day'), 'rt'); // no confundir "start"
  assert.notEqual(detectCategory('dark theme server'), 'dk');
});

test('parseTuText: texto real de $tu (español)', () => {
  const sample = [
    'ringel72, puedes reclamar ahora mismo. El siguiente reclamo será en 1h 09 min.',
    'Tienes 0 rolls (+1 $mk) restantes.',
    'El siguiente reinicio será en 9 min.',
    'Siguiente reinicio de $daily en 15h 18 min.',
    '(Keys LVL 6+) 4.500:kakera:a recolectar antes del siguiente reinicio (1h 09 min.)',
    'Probabilidad de completar + reiniciar $bku en tu próximo $sw: 10%',
    '*No puedes reaccionar a kakera antes de 33 min.',
    'Poder: 39%',
    'Cada botón de kakera consume 50% de su poder de reacción.',
    'Tus personajes con 10+ llaves, consumen la mitad del poder (25%)',
    'Capital: 567:kakera:',
    '¡$rt está disponible!',
    'Siguiente $dk en 13h 03 min.',
    '¡$p está disponible!',
    'Puedes votar nuevamente en 7h 19 min.',
    'Tienes 0 reinicios de rolls en el inventario.',
    '(Beneficio 8) Clicks hoy: 0/40. Rolled today: 0/0',
    '(Beneficio 8) Clicks RESTANTES hoy: 0/40. NOT rolled today: 0/0',
    '(Beneficio 9) Rolleado hoy: 0/0',
    '(Beneficio 9) NO rolleado hoy: 0/0',
    'Capital: 200 :sp:',
    '0 :omegakey:'
  ].join('\n');
  const out = parseTuText(sample);
  const byCat = Object.fromEntries(out.map(r => [r.category, r]));

  assert.equal(out.length, 9, 'se detectan 9 líneas con tiempo/estado reales');
  assert.equal(byCat.claim.category, 'claim');
  assert.equal(byCat.claim.ms, 69 * 60000);
  assert.equal(byCat.claim.ready, true, '"ahora mismo" marca listo');
  assert.equal(byCat.rollsmk.ms, 9 * 60000);
  assert.equal(byCat.daily.ms, 15 * 3600000 + 18 * 60000);
  assert.equal(byCat.keys.ms, 69 * 60000);
  assert.equal(byCat.kakera.ms, 33 * 60000);
  assert.equal(byCat.rt.ready, true);
  assert.equal(byCat.dk.ms, 13 * 3600000 + 3 * 60000);
  assert.equal(byCat.pokemon.ready, true);
  assert.equal(byCat.vote.ms, 7 * 3600000 + 19 * 60000);
});
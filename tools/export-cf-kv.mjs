#!/usr/bin/env node
// Exporta el namespace KV de Cloudflare a export/kv.json y muestra los syncCodes.
//
// Uso:
//   node tools/export-cf-kv.mjs
//
// Requiere la CLI de wrangler auntenticada (la misma que usas para deploy).
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'export', 'kv.json');
const BINDING = 'TIMERS';

function wrangler(args) {
  return new Promise((resolve, reject) => {
    const c = spawn('npx', ['--yes', 'wrangler', ...args], { shell: true });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) => {
      if (code !== 0) reject(new Error(err.trim().split('\n')[0] || 'salida ' + code));
      else resolve(out);
    });
  });
}

const listKeys = () => wrangler(['kv', 'key', 'list', '--binding', BINDING]);
const getKey = (name) => wrangler(['kv', 'key', 'get', name, '--binding', BINDING, '--text']);

function parseList(stdout) {
  try {
    const arr = JSON.parse(stdout);
    return Array.isArray(arr) ? arr.map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean) : [];
  } catch {
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
}

async function main() {
  console.log('Listando claves del KV (binding "' + BINDING + '") ...');
  const names = parseList(await listKeys());
  console.log('Encontradas ' + names.length + ' claves. Descargando valores...');

  const map = {};
  let i = 0;
  for (const name of names) {
    try {
      map[name] = (await getKey(name)).replace(/\r?\n$/, '');
    } catch (e) {
      console.warn('  skip ' + name + ': ' + e.message);
    }
    if (++i % 25 === 0) console.log('  ' + i + '/' + names.length);
  }

  await mkdir(join(ROOT, 'export'), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(map, null, 2), 'utf8');
  console.log('Exportadas ' + Object.keys(map).length + ' claves en ' + OUTPUT);

  const codes = new Set();
  for (const name of Object.keys(map)) {
    const m = name.match(/^(?:state|acct)\|([A-Z0-9-]{3,})$/i);
    if (m) codes.add(m[1].toUpperCase());
  }
  if (codes.size) {
    console.log('\n=== syncCodes detectados (reintrodúcelos en la nueva URL) ===');
    for (const c of codes) console.log('  ' + c);
  } else {
    console.log('\nNo se detectaron syncCodes; revisa export/kv.json.');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
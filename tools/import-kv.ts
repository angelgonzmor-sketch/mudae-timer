// Importa export/kv.json en la Deno KV remota del proyecto (Deno Deploy).
//
// Antes de ejecutar, crea el token de acceso de la base de datos en la consola
// de Deno (Proyecto -> Settings -> Deno KV -> "Generate access token") y expone:
//   DENO_KV_URL=https://api.deno.com/databases/<DB_ID>/kv
//   DENO_KV_ACCESS_TOKEN=<token>
//
// Uso:
//   deno run --allow-all --unstable-kv tools/import-kv.ts
import { kvAdapter } from '../src/kvAdapter.ts';

const KV_URL = Deno.env.get('DENO_KV_URL');
const ACCESS_TOKEN = Deno.env.get('DENO_KV_ACCESS_TOKEN');
if (!KV_URL || !ACCESS_TOKEN) {
  console.error('Faltan las variables DENO_KV_URL y/o DENO_KV_ACCESS_TOKEN.');
  Deno.exit(1);
}

const raw = await Deno.readTextFile(new URL('../export/kv.json', import.meta.url));
const data = JSON.parse(raw);
const entries = Object.entries(data);
console.log('Leyendo ' + entries.length + ' claves de export/kv.json');
if (entries.length === 0) {
  console.log('Nada que importar (el KV exportado está vacío).');
  Deno.exit(0);
}

// En el runtime de Deno Deploy, Deno.openKv(url, { accessToken }) está soportado;
// el tipo solo no está publicado para el Deno local.
const kv = await (Deno as any).openKv(KV_URL, { accessToken: ACCESS_TOKEN });
const a = kvAdapter(kv);
let n = 0;
for (const [name, value] of entries) {
  await a.put(name, String(value));
  n++;
  if (n % 25 === 0) console.log('  ' + n + '/' + entries.length);
}
kv.close();
console.log('Importadas ' + n + ' claves en la Deno KV remota.');
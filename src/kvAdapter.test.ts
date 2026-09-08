// Test del adaptador KV sobre Deno KV local (sqlite temporal).
import { kvAdapter } from './kvAdapter.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('assertion failed: ' + msg);
}

Deno.test('kvAdapter: get/put/delete/list', async () => {
  const dir = await Deno.makeTempDir();
  const kv = await Deno.openKv(dir + '/db.sqlite');
  try {
    const a = kvAdapter(kv);
    await a.put('sub|d1', '{"endpoint":"x"}');
    await a.put('sch|MT-AAAA|t1|fire', '{"fireAt":1}');
    await a.put('sch|MT-AAAA|t2|warn', '{"fireAt":2}');
    await a.put('sch|MT-BBBB|t3|fire', '{"fireAt":3}');
    await a.put('state|MT-AAAA', '{"rev":1}');
    await a.put('vapid', '{"pub":"k"}');

    assert((await a.get('sub|d1')) === '{"endpoint":"x"}', 'get devuelve el valor');
    assert((await a.get('no-existe')) === null, 'get con clave ausente devuelve null');

    const sc = await a.list({ prefix: 'sch|MT-AAAA|' });
    assert(sc.keys.length === 2, 'list filtra con prefijo de cuenta');
    const names = sc.keys.map((k) => k.name).sort();
    assert(names[0] === 'sch|MT-AAAA|t1|fire' && names[1] === 'sch|MT-AAAA|t2|warn', 'nombres de clave exactos');

    const all = await a.list({ prefix: 'sch|' });
    assert(all.keys.length === 3, 'list con prefijo corto agrupa todo');

    await a.delete('sch|MT-AAAA|t1|fire');
    assert((await a.get('sch|MT-AAAA|t1|fire')) === null, 'delete elimina');
    assert((await a.list({ prefix: 'sch|MT-AAAA|' })).keys.length === 1, 'list refleja el borrado');
  } finally {
    kv.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('kvAdapter: list acepta cursor y termina', async () => {
  const dir = await Deno.makeTempDir();
  const kv = await Deno.openKv(dir + '/db.sqlite');
  try {
    const a = kvAdapter(kv);
    for (let i = 0; i < 1500; i++) await a.put('sch|MT-CCCC|t' + i + '|fire', '{"fireAt":' + i + '}');
    const first = await a.list({ prefix: 'sch|MT-CCCC|' });
    assert(first.keys.length >= 1000, 'el primer lote trae la primera pagina');
    const rest = await a.list({ prefix: 'sch|MT-CCCC|', cursor: first.cursor || undefined });
    assert(rest.keys.length > 0, 'cursor continua el recorrido');
  } finally {
    kv.close();
    await Deno.remove(dir, { recursive: true });
  }
});
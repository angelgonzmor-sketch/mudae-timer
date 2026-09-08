// Adaptador que expone la misma interfaz que Workers KV (Cloudflare)
// pero sobre Deno KV. El backend (worker/index.js) solo usa:
//   get(name), put(name, value), delete(name), list({ prefix, cursor }).
// Cada clave se guarda como un array de un solo elemento [name] para que
// list({ prefix }) filtre por coincidencia de substring, igual que CF KV.

export interface KvListResult {
  keys: { name: string }[];
  cursor: string | null;
}

export interface KvAdapter {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<KvListResult>;
}

export function kvAdapter(kv: Deno.Kv): KvAdapter {
  return {
    async get(name) {
      const entry = await kv.get<string>([name]);
      return entry?.value ?? null;
    },
    async put(name, value) {
      await kv.set([name], value);
    },
    async delete(name) {
      await kv.delete([name]);
    },
    async list(opts) {
      // CF KV filtra el nombre por prefijo de string. Deno KV mueve las claves
      // por elementos, asi que barremos el rango [prefijo, prefijo+max).
      const MAX = '\u{10FFFF}';
      const selector: Deno.KvListSelector = { start: [opts.prefix], end: [opts.prefix + MAX] };
      const iter = kv.list<string>(selector, opts.cursor ? { cursor: opts.cursor } : {});
      const keys: { name: string }[] = [];
      for await (const entry of iter) keys.push({ name: entry.key[0] as string });
      return { keys, cursor: iter.cursor || null };
    }
  };
}
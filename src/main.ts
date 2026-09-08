// Entrada para Deno Deploy.
// Sirve la PWA (public/) y la API /api/* (mismo origen, igual que Cloudflare),
// y ejecuta el cron cada minuto con el mismo backend portado (worker/index.js).
import app from '../worker/index.js';
import { kvAdapter } from './kvAdapter.ts';
import { serveStatic } from './static.ts';

const kv = await Deno.openKv();
const env = { TIMERS: kvAdapter(kv) };

const appFetch = app as {
  fetch(request: Request, env: unknown): Promise<Response>;
  scheduled(_controller: unknown, env: unknown): Promise<void>;
};

// El cron debe registrarse a nivel de modulo, antes de Deno.serve().
Deno.cron('mudae-scan', '* * * * *', () => {
  appFetch.scheduled(null, env).catch(() => {});
});

function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api')) {
    return appFetch.fetch(request, env).catch(() => new Response('Backend error', { status: 500 }));
  }
  return serveStatic(url.pathname);
}

Deno.serve(handler);
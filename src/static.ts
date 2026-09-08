// Servidor de estaticos sin dependencias.
// Los archivos viven en public/ y se sirven desde el snapshot del deploy.

const ROOT = new URL('../public/', import.meta.url);

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js:   'text/javascript; charset=utf-8',
  css:  'text/css; charset=utf-8',
  svg:  'image/svg+xml',
  webmanifest: 'application/manifest+json',
  json: 'application/json',
  txt:  'text/plain; charset=utf-8',
  ico:  'image/x-icon',
  png:  'image/png',
  jpg:  'image/jpeg',
  woff2:'font/woff2',
  woff: 'font/woff'
};

export async function serveStatic(pathname: string): Promise<Response> {
  if (pathname === '/' || pathname.trim() === '') pathname = '/index.html';
  if (pathname.includes('..')) return new Response('Forbidden', { status: 403 });
  const target = new URL(pathname.replace(/^\/+/, ''), ROOT);
  try {
    const data = await Deno.readFile(target);
    const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
    const immutable = ['js', 'css', 'svg', 'png', 'woff2'].includes(ext);
    const cacheControl = immutable ? 'public, max-age=3600' : 'no-cache';
    return new Response(data, {
      headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl }
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
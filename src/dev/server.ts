// @ts-ignore Node built-ins are provided by the CLI runtime.
import { createServer } from 'node:http';
// @ts-ignore Node built-ins are provided by the CLI runtime.
import { randomBytes } from 'node:crypto';
// @ts-ignore Node built-ins are provided by the CLI runtime.
import { readFile } from 'node:fs/promises';
import { buildBrowserBundle } from '../cli/index.ts';
import { launcherHtml } from './shell.ts';
import { launcherCss } from './styles.ts';
const MIME: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon', avif: 'image/avif', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
type Request = { method: string; url: string; headers: { host?: string } };
type Response = { setHeader(name: string, value: string): void; writeHead(status: number): Response; end(body?: string | Uint8Array): void };
export async function startLocalLauncher(directory: string, port = 4174) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local launcher port.');
  const bundle = await buildBrowserBundle(directory);
  const token: string = randomBytes(32).toString('base64url');
  const runtime = globalThis as unknown as { Buffer: { from(value: string, encoding?: string): Uint8Array & { toString(encoding?: string): string } } };
  const files = new Map(bundle.files.map(file => [file.path, runtime.Buffer.from(file.data, 'base64')]));
  const modules = new Map<string, string>();
  for (const name of ['host', 'state', 'economy', 'panel']) {
    modules.set('/__spawn/' + name + '.js', await readFile(new URL('./' + name + '.js', import.meta.url), 'utf8') as string);
  }
  let origin = '';
  const server = createServer({ maxHeaderSize: 8192 }, (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    if (!origin || request.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404).end(); return; }
    const path = request.url.split('?')[0];
    let body: string | Uint8Array | undefined, type = 'text/html; charset=utf-8';
    if (path === '/') body = launcherHtml(token);
    else if (modules.has(path)) { body = modules.get(path); type = 'text/javascript'; }
    else if (path === '/__spawn/style.css') { body = launcherCss; type = 'text/css'; }
    else if (path.startsWith('/build/' + token + '/')) {
      let name = ''; try { name = decodeURIComponent(path.slice(token.length + 8)); } catch { /* Invalid path stays unavailable. */ }
      const file = files.get(name);
      if (file) {
        type = MIME[name.split('.').at(-1)!.toLowerCase()] ?? 'application/octet-stream';
        const config = `<script>Object.defineProperty(globalThis,"__SPAWN_LAUNCH__",{value:Object.freeze({platformOrigin:${JSON.stringify(origin)}})});</script>`;
        const html = file.toString('utf8'), doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '';
        body = name.endsWith('.html') ? doctype + config + html.slice(doctype.length) : file;
      }
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Content-Security-Policy', `sandbox allow-scripts allow-pointer-lock; default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors ${origin}`);
    }
    if (body === undefined) { response.writeHead(404).end('File unavailable.'); return; }
    if (!path.startsWith('/build/')) response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Content-Type', type); response.writeHead(200).end(request.method === 'HEAD' ? undefined : body);
  });
  server.maxConnections = 32; server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return { server, origin, files: bundle.files.length };
}

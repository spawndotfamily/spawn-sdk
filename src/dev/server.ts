// @ts-ignore Node built-ins are provided by the CLI runtime.
import { createServer } from 'node:http';
// @ts-ignore Node built-ins are provided by the CLI runtime.
import { randomBytes } from 'node:crypto';
// @ts-ignore Node built-ins are provided by the CLI runtime.
import { readFile } from 'node:fs/promises';
// @ts-ignore Node built-ins are provided by the CLI runtime.
import { createReadStream } from 'node:fs';
import { inspectBrowserBuildForLocal, openValidatedBuildFile } from '../cli/upload-client.ts';
import { launcherHtml } from './shell.ts';
import { launcherCss } from './styles.ts';
const MIME: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon', avif: 'image/avif', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
type Request = { method: string; url: string; headers: { host?: string } };
type Response = { setHeader(name: string, value: string): void; writeHead(status: number): Response; end(body?: string | Uint8Array): void; on(event: string, listener: () => void): Response };
type ReadStream = { on(event: string, listener: () => void): ReadStream; pipe(destination: unknown): void; destroy(error?: unknown): void };
type ValidationCacheEntry = { snapshot?: { ino: number; dev: number; size: number; mtimeMs?: number; ctimeMs?: number }; validation?: Promise<void> };

async function readValidatedEntry(handle: { read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }> }, bytes: number): Promise<string> {
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  while (offset < bytes) {
    const result = await handle.read(buffer, offset, bytes - offset, offset);
    if (result.bytesRead <= 0) throw new Error('The inspected entry file ended while it was being served.');
    offset += result.bytesRead;
  }
  return new TextDecoder().decode(buffer);
}

export async function startLocalLauncher(directory: string, port = 4174) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local launcher port.');
  const prepared = await inspectBrowserBuildForLocal(directory);
  const token: string = randomBytes(32).toString('base64url');
  const files = new Map(prepared.preparedFiles.map(file => [file.path, file]));
  const validationCache = new Map<string, ValidationCacheEntry>();
  const modules = new Map<string, string>();
  for (const name of ['host', 'state', 'economy', 'panel']) {
    modules.set('/__spawn/' + name + '.js', await readFile(new URL('./' + name + '.js', import.meta.url), 'utf8') as string);
  }
  let origin = '';
  const handleRequest = async (request: Request, response: Response): Promise<void> => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    if (!origin || request.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404).end(); return; }
    const path = request.url.split('?')[0];
    let body: string | Uint8Array | undefined, type = 'text/html; charset=utf-8';
    if (path === '/') body = launcherHtml(token);
    else if (modules.has(path)) { body = modules.get(path); type = 'text/javascript'; }
    else if (path === '/__spawn/style.css') { body = launcherCss; type = 'text/css'; }
    else if (path.startsWith('/build/' + token + '/')) {
      let name = ''; try { name = decodeURIComponent(path.slice(token.length + 8)); } catch { /* Invalid path stays unavailable. */ }
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Content-Security-Policy', `sandbox allow-scripts allow-pointer-lock; default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors ${origin}`);
      const file = files.get(name);
      if (!file) { response.writeHead(404).end('File unavailable.'); return; }
      type = MIME[name.split('.').at(-1)!.toLowerCase()] ?? 'application/octet-stream';
      const cache = validationCache.get(name) ?? {};
      validationCache.set(name, cache);
      const handle = await openValidatedBuildFile(prepared, file, cache);
      response.setHeader('Content-Type', type);
      if (request.method === 'HEAD') { await handle.close(); response.writeHead(200).end(); return; }
      if (name === 'index.html') {
        try {
          const html = await readValidatedEntry(handle, file.bytes);
          const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '';
          const config = `<script>Object.defineProperty(globalThis,"__SPAWN_LAUNCH__",{value:Object.freeze({platformOrigin:${JSON.stringify(origin)}})});</script>`;
          await handle.close();
          response.writeHead(200).end(doctype + config + html.slice(doctype.length));
          return;
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw error;
        }
      }
      try {
        if (file.bytes === 0) { await handle.close(); response.setHeader('Content-Length', '0'); response.writeHead(200).end(); return; }
        const stream = (createReadStream as unknown as (path: null, options: { fd: number; start: number; end: number; autoClose: boolean }) => unknown)(null, { fd: handle.fd, start: 0, end: file.bytes - 1, autoClose: false }) as ReadStream;
        response.setHeader('Content-Length', String(file.bytes));
        let closed = false;
        const closeHandle = () => {
          if (closed) return;
          closed = true;
          void handle.close().catch(() => undefined);
        };
        const abortStream = () => {
          closeHandle();
          try { stream.destroy(); } catch { /* stream already closed */ }
        };
        stream.on('end', closeHandle);
        stream.on('close', closeHandle);
        response.on('close', abortStream);
        response.on('error', abortStream);
        response.writeHead(200);
        stream.on('error', () => { closeHandle(); try { response.end(); } catch { /* response already closed */ } });
        stream.pipe(response);
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
      return;
    }
    if (body === undefined && !path.startsWith('/build/')) { response.writeHead(404).end('File unavailable.'); return; }
    if (body === undefined) { response.writeHead(404).end('File unavailable.'); return; }
    if (!path.startsWith('/build/')) response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Content-Type', type); response.writeHead(200).end(request.method === 'HEAD' ? undefined : body);
  };
  const server = createServer({ maxHeaderSize: 8192 }, (request: Request, response: Response) => {
    void handleRequest(request, response).catch(() => {
      try { response.writeHead(500).end('File unavailable.'); } catch { /* response already closed */ }
    });
  });
  server.maxConnections = 32; server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return { server, origin, files: prepared.files.length };
}

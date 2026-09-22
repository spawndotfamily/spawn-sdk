import { inspectBrowserBuildForLocal, openValidatedBuildFile } from '../dist/cli/upload-client.js';

const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon', avif: 'image/avif', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };

/** Uses the publisher's inspected manifest and validated handles, never URL-to-disk paths. */
export async function prepareLocalGame(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('gameDirectory must name a built browser game directory.');
  const build = await inspectBrowserBuildForLocal(directory);
  const files = new Map(build.preparedFiles.map(file => [file.path, file]));
  const cache = new Map();
  return async (request, response, url, origin, tokens) => {
    const match = /^\/build\/([A-Za-z0-9_-]{43})\/(.*)$/.exec(url.pathname);
    if (!match || !tokens.has(match[1]) || !['GET', 'HEAD'].includes(request.method)) return false;
    let name;
    try { name = decodeURIComponent(match[2]); } catch { name = ''; }
    const file = files.get(name);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Security-Policy', `sandbox allow-scripts allow-pointer-lock; default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors ${origin}`);
    if (!file) { response.writeHead(404).end('File unavailable.'); return true; }
    const validation = cache.get(name) ?? {};
    cache.set(name, validation);
    const handle = await openValidatedBuildFile(build, file, validation);
    if (response.destroyed || response.closed || response.writableEnded) {
      await handle.close().catch(() => {});
      return true;
    }
    response.setHeader('Content-Type', MIME[name.split('.').at(-1).toLowerCase()] ?? 'application/octet-stream');
    if (request.method === 'HEAD' || file.bytes === 0) {
      await handle.close(); response.writeHead(200).end(); return true;
    }
    if (name === 'index.html') {
      try {
        const buffer = Buffer.alloc(file.bytes);
        let offset = 0;
        while (offset < file.bytes) {
          const { bytesRead } = await handle.read(buffer, offset, file.bytes - offset, offset);
          if (!bytesRead) throw new Error('Inspected game entry ended unexpectedly.');
          offset += bytesRead;
        }
        const html = buffer.toString('utf8'), doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '';
        const config = `<script>Object.defineProperty(globalThis,"__SPAWN_LAUNCH__",{value:Object.freeze({platformOrigin:${JSON.stringify(origin)}})});</script>`;
        response.writeHead(200).end(doctype + config + html.slice(doctype.length));
      } finally { await handle.close(); }
      return true;
    }
    const stream = handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: true });
    let closed = false;
    const removeResponseListeners = () => {
      response.off('close', abort);
      response.off('error', abort);
    };
    const abort = () => {
      if (closed) return;
      closed = true;
      removeResponseListeners();
      stream.destroy();
    };
    stream.once('error', () => {
      if (!closed) {
        closed = true;
        removeResponseListeners();
      }
      if (!response.destroyed) response.destroy();
    });
    stream.once('close', () => {
      closed = true;
      removeResponseListeners();
      void handle.close().catch(() => {});
    });
    response.once('close', abort);
    response.once('error', abort);
    if (response.destroyed || response.closed || response.writableEnded) {
      abort();
      return true;
    }
    response.setHeader('Content-Length', String(file.bytes));
    response.writeHead(200); stream.pipe(response);
    return true;
  };
}

/** Spawn's production ledger and approval UI, isolated behind a loopback-only test host. */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSpawnTableClient, createSpawnMatchClient, createSpawnPayoutClient, createSpawnTokenClient, createSpawnPaymentClient } from '@spawndotfamily/sdk/server';
import { createLocalTestEngine } from './platform/engine.mjs';
import { prepareLocalGame } from './local-build.mjs';

const secret = () => randomBytes(32).toString('base64url');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const loopback = (value) => {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash)
    throw new Error('The test game must use an exact loopback HTTP URL without credentials or fragment.');
  return url;
};
const csp = (gameUrl, localBuild) => `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src ${localBuild ? "'self'" : gameUrl ? new URL(gameUrl).origin : "'none'"}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64_000) throw Object.assign(new Error('Local request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

/**
 * No production credentials, environment loading, RPC, remote bind or automatic approval.
 * Player URLs/capabilities and returned server credentials are for this isolated run only.
 */
export async function startSpawnTestHost(options = {}) {
  const { players = 6, balance = '100000000000000000000', port = 0, gameUrl, gameDirectory, databasePath } = options;
  const mode = options.mode ?? (gameDirectory === undefined ? 'multiplayer' : 'game');
  if (!['game', 'multiplayer'].includes(mode) || (mode === 'game' && gameDirectory === undefined) || (gameDirectory !== undefined && (gameUrl !== undefined || mode !== 'game')))
    throw new Error('Use gameDirectory for ordinary SDK games, or gameUrl for multiplayer games, never both.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port.');
  if (Object.hasOwn(options, 'host') || Object.hasOwn(options, 'platformOrigin') || Object.hasOwn(options, 'credential'))
    throw new Error('The test host cannot accept a remote bind, platform or real credential.');
  const game = gameUrl === undefined ? undefined : loopback(gameUrl).href;
  const serveBuild = gameDirectory === undefined ? null : await prepareLocalGame(gameDirectory);
  // Load packaged resources before opening a durable database.
  const resources = new Map();
  for (const [path, file, type] of [['/browser.js', 'browser.js', 'text/javascript'], ['/browser.css', 'browser.css', 'text/css'], ['/fonts/manrope/Manrope.ttf', 'Manrope.ttf', 'font/ttf'], ['/fonts/anybody/Anybody.ttf', 'Anybody.ttf', 'font/ttf']])
    resources.set(path, { data: await readFile(new URL('./platform/' + file, import.meta.url)), type });
  const engine = createLocalTestEngine({ players, balance, ...(databasePath ? { databasePath } : {}) });
  const keys = generateKeyPairSync('ed25519');
  const kid = 'spawn-local-' + randomUUID();
  const sessions = new Map(engine.players.map((player) => [secret(), { player, documentToken: secret(), pending: null }]));
  const documentTokens = new Set([...sessions.values()].map(session => session.documentToken));
  const byId = new Map([...sessions].map(([capability, session]) => [session.player.playerId, { capability, session }]));
  const pending = new Map();
  let lostResponsePath = null;
  const audit = [];
  let origin = '', closed = false;
  const verification = () => ({ publicKeys: { [kid]: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, issuer: origin, audience: 'spawn-local-game-server', gameId: engine.projectId, environment: 'sandbox' });
  function grant(player) {
    if (!game) throw new Error('Start the test host with your loopback gameUrl to issue launch grants.');
    engine.authorizePlayer(player.playerId);
    const now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: origin, aud: 'spawn-local-game-server', sub: player.playerId, sid: player.launchId, jti: randomUUID(), gameId: engine.projectId, environment: 'sandbox', scope: ['multiplayer:join'], handle: player.displayName, displayName: player.displayName, iat: now, nbf: now, exp: now + 90 })).toString('base64url');
    const bytes = head + '.' + payload;
    return { ticket: bytes + '.' + sign(null, Buffer.from(bytes), keys.privateKey).toString('base64url'), serverOrigin: new URL(game).origin };
  }
  function complete(session, input) {
    const record = pending.get(input.requestId);
    if (!record || record.session !== session) throw Object.assign(new Error('No pending approval for this player.'), { status: 404 });
    pending.delete(input.requestId); session.pending = null; clearTimeout(record.timer);
    audit.push({ simulated: true, playerId: session.player.playerId, requestId: input.requestId, kind: record.request.kind, outcome: input.error ? 'error' : 'completed' });
    if (input.error) record.reject(new Error(String(input.error))); else record.resolve(input.result);
    return { simulated: true, completed: true };
  }
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void (async () => {
      const remote = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || !origin || req.headers.host !== new URL(origin).host)
        return json({ error: 'Loopback Host required.' }, 403);
      const url = new URL(req.url, origin);
      if (url.origin === origin && serveBuild && await serveBuild(req, res, url, origin, documentTokens)) return;
      if (req.headers.origin && req.headers.origin !== origin) return json({ error: 'Same-origin local request required.' }, 403);
      if (url.origin !== origin || url.search) return json({ error: 'Invalid local request URL.' }, 400);
      if (['GET', 'HEAD'].includes(req.method) && resources.has(url.pathname)) {
        const resource = resources.get(url.pathname);
        return new Response(req.method === 'HEAD' ? null : resource.data, { headers: { 'content-type': resource.type } });
      }
      if (req.method === 'GET' && /^\/players\/[0-9a-f-]{36}$/.test(url.pathname)) {
        return new Response('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Spawn local approval test</title><link rel="stylesheet" href="/browser.css"></head><body><div id="root"></div><script type="module" src="/browser.js"></script></body></html>', { headers: { 'content-type': 'text/html' } });
      }
      const session = sessions.get(req.headers['x-spawn-test-session']);
      if (url.pathname.startsWith('/__spawn/')) {
        if (!session) return json({ error: 'A local player capability is required.' }, 401);
        if (url.pathname === '/__spawn/player-context' && req.method === 'GET') return json({ simulated: true, mode, player: session.player, projectId: engine.projectId, asset: engine.asset, gameUrl: serveBuild ? `${origin}/build/${session.documentToken}/index.html` : game, documentToken: session.documentToken, platformOrigin: origin });
        if (url.pathname === '/__spawn/pending' && req.method === 'GET') return json(session.pending);
        if (url.pathname === '/__spawn/grant' && req.method === 'POST') return json(grant(session.player));
        if (url.pathname === '/__spawn/complete' && req.method === 'POST') return json(complete(session, JSON.parse((await body(req) ?? Buffer.from('{}')).toString())));
        return json({ error: 'Local endpoint unavailable.' }, 404);
      }
      if (!url.pathname.startsWith('/api/v1/')) return json({ error: 'Not found.' }, 404);
      // A server credential can never impersonate a browser/player. Conversely, a player
      // capability cannot call registered-game server APIs using the host's credential.
      const isServer = url.pathname.startsWith('/api/v1/registered-games/');
      if (!isServer && !session) return json({ error: 'Local player capability required.' }, 401);
      const headers = new Headers();
      for (const name of ['content-type', 'authorization', 'origin', 'cookie']) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      const data = ['GET', 'HEAD'].includes(req.method) ? undefined : await body(req);
      const request = new Request(url, { method: req.method, headers, ...(data ? { body: data } : {}) });
      const result = await engine.handle(request, isServer ? undefined : session.player.playerId);
      if (lostResponsePath === url.pathname) { lostResponsePath = null; res.destroy(); }
      return result;
    })().catch((error) => json({ error: error.message || 'Local request failed.' }, error.status ?? 500)).then(async (response) => {
      if (!response || res.destroyed) return;
      res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('content-security-policy', csp(game, serveBuild));
      for (const [name, value] of response.headers) res.setHeader(name, value);
      res.writeHead(response.status); res.end(Buffer.from(await response.arrayBuffer()));
    }).catch(() => res.destroy());
  });
  server.maxConnections = 2048; server.requestTimeout = 10000; server.headersTimeout = 10000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { engine.close(); throw error; }
  origin = 'http://127.0.0.1:' + server.address().port;
  const clientOptions = { platformOrigin: origin, projectId: engine.projectId, credential: engine.credential };
  const player = (id) => {
    const record = byId.get(id);
    if (!record) throw new Error('Unknown local player.');
    const { session, capability } = record;
    return Object.freeze({
      ...session.player,
      url: `${origin}/players/${id}#cap=${capability}`,
      balance: () => engine.balance(id),
      async fetch(path, init = {}) {
        if (!path.startsWith('/api/v1/') || path.includes('?') || path.includes('#') || path.includes('\\')) throw new Error('Use a local API path.');
        return fetch(origin + path, { ...init, redirect: 'error', headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-spawn-test-session': capability } });
      },
      requestApproval(request, { timeoutMs = 120000 } = {}) {
        if (closed || session.pending) throw new Error('A local approval is already pending or the host is closed.');
        if (!request || !['table', 'match', 'token', 'trade'].includes(request.kind)) throw new Error('Invalid approval kind.');
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid approval timeout.');
        const requestId = randomUUID(), value = { ...structuredClone(request), requestId };
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId); session.pending = null;
            reject(new Error('Local approval timed out. Inspect status before retrying; dismissal is not proof of no debit.'));
          }, timeoutMs);
          pending.set(requestId, { session, request: value, resolve, reject, timer }); session.pending = value;
        });
      },
      grant: () => grant(session.player),
    });
  };
  return Object.freeze({
    simulated: true, origin, projectId: engine.projectId, asset: engine.asset,
    credential: engine.credential, players: engine.players.map((p) => player(p.playerId)), player,
    verification: verification(), clientOptions,
    tables: createSpawnTableClient(clientOptions), matches: createSpawnMatchClient(clientOptions), payouts: createSpawnPayoutClient(clientOptions), tokens: createSpawnTokenClient(clientOptions), payments: createSpawnPaymentClient(clientOptions),
    loseNextResponse(path) {
      if (typeof path !== 'string' || !path.startsWith('/api/v1/') || path.includes('?') || path.includes('#')) throw new Error('Use an exact local API path.');
      lostResponsePath = path;
    },
    advance: (ms) => engine.advance(ms), snapshot: () => engine.snapshot(), audit: () => structuredClone(audit),
    async close() {
      if (closed) return; closed = true;
      for (const record of pending.values()) { clearTimeout(record.timer); record.reject(new Error('Local host closed; reconcile outstanding approval before retrying.')); }
      pending.clear();
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); engine.close();
    },
  });
}

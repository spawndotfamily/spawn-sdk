import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  parseServerCommand,
  runServerCommand,
} from '../src/cli/server-setup.ts';
const projectId = '11111111-1111-4111-8111-111111111111';
const config = {
  apiUrl: 'https://spawn.example',
  projectId,
  publishKey: 'sp_pub_' + 'p'.repeat(43),
  scopes: ['server:configure'],
};
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
void test('server CLI saves private keys before sending only hashes and reconciles an unknown response without rotating', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'spawn-setup-'))),
    dir = join(root, 'private');
  try {
    const command = parseServerCommand(
      [
        'server',
        'enable',
        '--server-origin',
        'https://game.example',
        '--websocket-path',
        '/game/ws',
        '--audience',
        'game-server',
        '--out-dir',
        dir,
        '--version',
        '0',
        '--creator-confirmation',
      ],
      'creator.json',
    );
    let state: Record<string, unknown> = {
      projectId,
      version: 0,
      matchesEnabled: false,
      registration: null,
      keyFingerprint: null,
      verification: null,
    };
    let writes = 0;
    const fetcher = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === 'PATCH') {
        const payload = JSON.parse(String(init.body)),
          key = (await readFile(join(dir, 'match.key'), 'utf8')).trim();
        assert.equal(payload.matchKeyHash, digest(key));
        assert.ok(!String(init.body).includes(key));
        assert.equal(init.credentials, 'omit');
        assert.equal(init.redirect, 'error');
        writes++;
        state = {
          ...state,
          version: 1,
          matchesEnabled: true,
          keyFingerprint: payload.matchKeyHash,
          registration: {
            serverOrigin: payload.serverOrigin,
            webSocketPath: payload.webSocketPath,
            audience: payload.audience,
          },
          verification: {
            issuer: config.apiUrl,
            audience: 'game-server',
            gameId: projectId,
            environment: 'sandbox',
            publicKeys: {
              fixture: generateKeyPairSync('ed25519').publicKey.export({
                type: 'spki',
                format: 'pem',
              }),
            },
          },
        };
        throw Error('Response lost after configuration');
      }
      return Response.json(state);
    };
    await assert.rejects(
      runServerCommand(config, command, fetcher),
      /Response lost/,
    );
    const key = await readFile(join(dir, 'match.key'), 'utf8');
    assert.equal((await stat(join(dir, 'match.key'))).mode & 0o777, 0o600);
    const result = await runServerCommand(config, command, fetcher);
    assert.equal(result.matchesEnabled, true);
    assert.equal(writes, 1);
    assert.equal(await readFile(join(dir, 'match.key'), 'utf8'), key);
    assert.ok(!JSON.stringify(result).includes(key.trim()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test('server configuration requires explicit confirmation and a private credential scope', async () => {
  assert.throws(
    () =>
      parseServerCommand(
        ['server', 'disable', '--version', '0'],
        'creator.json',
      ),
    /confirmation/,
  );
  assert.throws(
    () =>
      parseServerCommand(
        ['server', 'status', '--version', '0'],
        'creator.json',
      ),
    /only credentials/,
  );
  await assert.rejects(
    runServerCommand(
      { ...config, scopes: ['build:upload'] },
      parseServerCommand(['server', 'status'], 'creator.json'),
      fetch,
    ),
    /fresh creator/,
  );
});

void test('publishing transport alias preserves the canonical launch issuer', async () => {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), 'spawn-setup-alias-')),
    ),
    dir = join(root, 'private');
  try {
    const alias = { ...config, apiUrl: 'https://publish.spawnfamily.com' };
    const command = parseServerCommand(
      [
        'server',
        'enable',
        '--server-origin',
        'https://game.example',
        '--websocket-path',
        '/game/ws',
        '--audience',
        'game-server',
        '--out-dir',
        dir,
        '--version',
        '0',
        '--creator-confirmation',
      ],
      'creator.json',
    );
    const fetcher = async (url, init) => {
      assert.ok(String(url).startsWith(alias.apiUrl));
      if (init?.method === 'GET')
        return Response.json({
          projectId,
          version: 0,
          matchesEnabled: false,
          registration: null,
        });
      const payload = JSON.parse(String(init.body));
      return Response.json({
        projectId,
        version: 1,
        matchesEnabled: true,
        keyFingerprint: payload.matchKeyHash,
        verification: {
          issuer: 'https://spawn.family',
          audience: 'game-server',
          gameId: projectId,
          environment: 'sandbox',
          publicKeys: {
            fixture: generateKeyPairSync('ed25519').publicKey.export({
              type: 'spki',
              format: 'pem',
            }),
          },
        },
      });
    };
    const result = await runServerCommand(alias, command, fetcher);
    assert.equal(result.matchesEnabled, true);
    assert.equal(
      JSON.parse(await readFile(join(dir, 'verification.json'), 'utf8')).issuer,
      'https://spawn.family',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

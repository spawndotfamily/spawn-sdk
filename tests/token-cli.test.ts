import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli/index.ts';

const PROJECT = '123e4567-e89b-12d3-a456-426614174000';
const ORIGIN = 'https://creator-platform.example';
const SECRET = 'test-creator-secret';
const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ASSET_ID = 'erc20:46630:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ASSET = {
  id: ASSET_ID,
  chainId: 46630,
  address: ADDRESS,
  name: 'Rich Token',
  symbol: 'RICH',
  decimals: 6,
  image: 'https://assets.example.test/rich.png',
  source: 'spawn',
  enabled: true,
};
const SETTINGS = { projectId: PROJECT, version: 5, asset: ASSET, entryAmount: '1000001' };

type RequestRecord = {
  url: string;
  method?: string;
  credentials?: RequestCredentials;
  redirect?: RequestRedirect;
  headers?: HeadersInit;
  body: unknown;
};
type Fixture = {
  dir: string;
  credentials: string;
  calls: RequestRecord[];
  logs: string[];
  errors: string[];
  execute(args: string[]): Promise<number>;
  setReply(reply: (request: RequestRecord) => Response): void;
  writeCredentials(scopes?: string[]): Promise<void>;
};

async function fixture(run: (f: Fixture) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'token-cli-'));
  try {
    const credentials = join(dir, 'credentials.json');
    const calls: RequestRecord[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    let reply = (request: RequestRecord) => request.url.includes('/game-tokens')
      ? Response.json({ chainId: 46630, items: [ASSET] })
      : Response.json({ settings: SETTINGS });
    const writeCredentials = async (scopes?: string[]) => writeFile(credentials, JSON.stringify({
      platformOrigin: ORIGIN,
      projectId: PROJECT,
      publishKey: SECRET,
      expiresAt: Date.now() + 60_000,
      ...(scopes ? { scopes } : {}),
    }));
    await writeCredentials(['build:read', 'build:upload', 'token:configure']);
    const execute = (args: string[]) => main([...args, '--credentials', credentials], {}, async (url, init) => {
      const request = {
        url: String(url),
        method: init?.method,
        credentials: init?.credentials,
        redirect: init?.redirect,
        headers: init?.headers,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(request);
      return reply(request);
    }, { log: message => logs.push(message), error: message => errors.push(message) });
    await run({ dir, credentials, calls, logs, errors, execute, setReply: next => { reply = next; }, writeCredentials });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('token search URL-encodes the query and prints only the curated enabled-token fields', async () => fixture(async f => {
  f.setReply(() => Response.json({ chainId: 46630, items: [
    { ...ASSET, publishKey: SECRET, ownerEmail: 'private@example.test' },
    { ...ASSET, id: 'erc20:46630:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', enabled: false },
  ] }));
  assert.equal(await f.execute(['token', 'search', 'Rich & Token']), 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${ORIGIN}/api/v1/game-tokens?q=Rich%20%26%20Token`);
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].credentials, 'omit');
  assert.equal(f.calls[0].redirect, 'error');
  assert.equal(new Headers(f.calls[0].headers).get('authorization'), null);
  assert.deepEqual(JSON.parse(f.logs[0]), { chainId: 46630, items: [ASSET] });
  assert.ok(!f.logs.join('').includes(SECRET));
}));

test('token search reports a missing public catalog without implying a credential-scope problem', async () => fixture(async f => {
  f.setReply(() => Response.json({ error: 'not found' }, { status: 404 }));
  assert.equal(await f.execute(['token', 'search', 'Rich Token']), 1);
  assert.match(f.errors.join(' '), /token search is not available/i);
  assert.doesNotMatch(f.errors.join(' '), /credential file|scopes/i);
}));

test('token search rejects selectors longer than the platform search limit before requesting', async () => fixture(async f => {
  assert.equal(await f.execute(['token', 'search', 'x'.repeat(81)]), 1);
  assert.equal(f.calls.length, 0);
  assert.match(f.errors.join(' '), /80|search/i);
}));

test('token configure resolves an exact admitted contract and sends one versioned base-unit update', async () => fixture(async f => {
  f.setReply(request => request.url.endsWith('/api/v1/game-tokens?q=' + ADDRESS)
    ? Response.json({ chainId: 46630, items: [ASSET] })
    : Response.json({ settings: { ...SETTINGS, privateKey: SECRET } }));
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '1.000001', '--version', '4']), 0);
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [
    ['GET', `${ORIGIN}/api/v1/game-tokens?q=${ADDRESS}`],
    ['PATCH', `${ORIGIN}/api/v1/publish/${PROJECT}/token`],
  ]);
  assert.deepEqual(f.calls[1].body, { version: 4, assetId: ASSET_ID, entryAmount: '1000001' });
  assert.equal(new Headers(f.calls[1].headers).get('authorization'), `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(f.logs[0]), { settings: { projectId: PROJECT, version: 5, asset: ASSET, entryAmount: '1000001' } });
  assert.ok(!f.logs.join('').includes(SECRET));
}));

test('token configure converts large decimal amounts exactly without floating-point rounding', async () => fixture(async f => {
  f.setReply(request => request.url.includes('/game-tokens')
    ? Response.json({ chainId: 46630, items: [ASSET] })
    : Response.json({ settings: SETTINGS }));
  assert.equal(await f.execute(['token', 'configure', 'Rich Token', '9007199254.740993', '--version', '0']), 0);
  assert.deepEqual(f.calls[1].body, {
    version: 0,
    assetId: ASSET_ID,
    entryAmount: '9007199254740993',
  });
}));

test('token configure accepts admitted assets with up to 18 decimals', async () => fixture(async f => {
  const asset = { ...ASSET, decimals: 18 };
  f.setReply(request => request.url.includes('/game-tokens')
    ? Response.json({ chainId: 46630, items: [asset] })
    : Response.json({ settings: { ...SETTINGS, asset, entryAmount: '1000000000000000001' } }));
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '1.000000000000000001', '--version', '0']), 0);
  assert.deepEqual(f.calls[1].body, {
    version: 0,
    assetId: ASSET_ID,
    entryAmount: '1000000000000000001',
  });
}));

test('token configure rejects admitted assets with more than 18 decimals before mutation', async () => fixture(async f => {
  const asset = { ...ASSET, decimals: 19 };
  f.setReply(request => request.url.includes('/game-tokens')
    ? Response.json({ chainId: 46630, items: [asset] })
    : Response.json({ settings: SETTINGS }));
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '1', '--version', '0']), 1);
  assert.equal(f.calls.length, 1);
  assert.match(f.errors.join(' '), /decimal/i);
}));

test('token configure accepts an enabled partner-list asset', async () => fixture(async f => {
  const partner = { ...ASSET, source: 'partner' };
  f.setReply(request => request.url.includes('/game-tokens')
    ? Response.json({ chainId: 46630, items: [partner] })
    : Response.json({ settings: { ...SETTINGS, asset: partner } }));
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '2', '--version', '5']), 0);
  assert.equal(f.calls[1].body && (f.calls[1].body as { assetId: string }).assetId, ASSET_ID);
}));

test('token configure accepts an admitted asset without an image', async () => fixture(async f => {
  const noImage = { ...ASSET, image: '' };
  f.setReply(request => request.url.includes('/game-tokens')
    ? Response.json({ chainId: 46630, items: [noImage] })
    : Response.json({ settings: { ...SETTINGS, asset: noImage } }));
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '2', '--version', '5']), 0);
  assert.deepEqual(f.calls[1].body, { version: 5, assetId: ASSET_ID, entryAmount: '2000000' });
  assert.deepEqual(JSON.parse(f.logs[0]), { settings: { ...SETTINGS, asset: noImage, entryAmount: '1000001' } });
}));

test('token configure rejects an address outside the current Spawn token list without PATCHing', async () => fixture(async f => {
  const unknownAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  f.setReply(() => Response.json({ chainId: 46630, items: [ASSET] }));
  assert.equal(await f.execute(['token', 'configure', unknownAddress, '1', '--version', '0']), 1);
  assert.equal(f.calls.length, 1);
  assert.match(f.errors.join(' '), /not found|no admitted|token list/i);
}));

test('token configure requires a new explicit token:configure scope before any request', async () => fixture(async f => {
  await f.writeCredentials(['build:read', 'build:upload', 'listing:write']);
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '1', '--version', '0']), 1);
  assert.equal(f.calls.length, 0);
  assert.match(f.errors.join(' '), /token:configure|download new/i);
}));

test('token configure rejects ambiguous exact names and inactive or wrong-network assets', async () => fixture(async f => {
  const second = { ...ASSET, id: 'erc20:46630:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
  f.setReply(() => Response.json({ chainId: 46630, items: [ASSET, second] }));
  assert.equal(await f.execute(['token', 'configure', 'Rich Token', '1', '--version', '0']), 1);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.match(f.errors.at(-1) ?? '', /ambiguous|address/i);

  f.calls.length = 0;
  f.errors.length = 0;
  f.setReply(() => Response.json({ chainId: 46630, items: [{ ...ASSET, enabled: false }] }));
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '1', '--version', '0']), 1);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);

  f.calls.length = 0;
  f.errors.length = 0;
  f.setReply(() => Response.json({ chainId: 1, items: [ASSET] }));
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '1', '--version', '0']), 1);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
}));

test('token configure rejects fractional precision loss and exponent notation before mutation', async () => fixture(async f => {
  for (const amount of ['0.0000001', '1.0000001', '1e3']) {
    assert.equal(await f.execute(['token', 'configure', ADDRESS, amount, '--version', '0']), 1);
  }
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.ok(f.errors.some(error => /amount|decimal|precision|positive/i.test(error)));
}));

test('token get accepts a zero base-unit listing entry setting', async () => fixture(async f => {
  const settings = { ...SETTINGS, entryAmount: '0' };
  f.setReply(() => Response.json({ settings }));
  assert.equal(await f.execute(['token', 'get']), 0);
  assert.deepEqual(JSON.parse(f.logs[0]), { settings });
}));

test('token configure accepts zero entry amount and sends zero base units', async () => fixture(async f => {
  f.setReply(request => request.url.includes('/game-tokens')
    ? Response.json({ chainId: 46630, items: [ASSET] })
    : Response.json({ settings: { ...SETTINGS, entryAmount: '0' } }));
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '0', '--version', '5']), 0);
  assert.deepEqual(f.calls[1].body, { version: 5, assetId: ASSET_ID, entryAmount: '0' });
}));

test('token get reads the project setting with downloaded credentials and does not trust extra fields', async () => fixture(async f => {
  await f.writeCredentials();
  f.setReply(() => Response.json({ settings: SETTINGS, publishKey: SECRET, ownerEmail: 'private@example.test' }));
  assert.equal(await f.execute(['token', 'get']), 0);
  assert.equal(f.calls[0].url, `${ORIGIN}/api/v1/publish/${PROJECT}/token`);
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(new Headers(f.calls[0].headers).get('authorization'), `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(f.logs[0]), { settings: SETTINGS });
  assert.ok(!f.logs.join('').includes(SECRET));
}));

test('token get reports an unconfigured setting and the initial configure uses version zero', async () => fixture(async f => {
  f.setReply(() => Response.json({ settings: null }));
  assert.equal(await f.execute(['token', 'get']), 0);
  assert.deepEqual(JSON.parse(f.logs[0]), { settings: null });

  f.calls.length = 0;
  f.logs.length = 0;
  f.setReply(request => request.url.includes('/game-tokens')
    ? Response.json({ chainId: 46630, items: [ASSET] })
    : Response.json({ settings: { ...SETTINGS, version: 1, entryAmount: '1000000' } }));
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '1', '--version', '0']), 0);
  assert.deepEqual(f.calls[1].body, { version: 0, assetId: ASSET_ID, entryAmount: '1000000' });
}));

test('local chain 31337 is available only through a loopback token service', async () => fixture(async f => {
  const localOrigin = 'http://127.0.0.1:3003';
  const localAddress = '0xcccccccccccccccccccccccccccccccccccccccc';
  const localAsset = {
    ...ASSET,
    id: `erc20:31337:${localAddress}`,
    chainId: 31337,
    address: localAddress,
  };
  await writeFile(f.credentials, JSON.stringify({
    platformOrigin: localOrigin,
    projectId: PROJECT,
    publishKey: SECRET,
    expiresAt: Date.now() + 60_000,
    scopes: ['token:configure'],
  }));
  f.setReply(request => request.url.includes('/game-tokens')
    ? Response.json({ chainId: 31337, items: [localAsset] })
    : Response.json({ settings: { ...SETTINGS, asset: localAsset } }));
  assert.equal(await f.execute(['token', 'configure', localAddress, '1', '--version', '0']), 0);
  assert.equal(f.calls[1].url, `${localOrigin}/api/v1/publish/${PROJECT}/token`);

  await f.writeCredentials(['token:configure']);
  f.calls.length = 0;
  assert.equal(await f.execute(['token', 'configure', localAddress, '1', '--version', '0']), 1);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.match(f.errors.at(-1) ?? '', /local-test only/i);
}));

test('token configuration reports version conflicts without retrying', async () => fixture(async f => {
  f.setReply(request => request.url.includes('/game-tokens')
    ? Response.json({ chainId: 46630, items: [ASSET] })
    : Response.json({ error: 'stale version' }, { status: 409 }));
  assert.equal(await f.execute(['token', 'configure', ADDRESS, '1', '--version', '4']), 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].method, 'PATCH');
  assert.match(f.errors.join(' '), /version changed|read.*review|fresh/i);
}));

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createSpawnPayoutClient,
  SpawnPayoutRequestError,
  type SpawnPayoutReceipt,
} from '../src/payout-server.ts';

const projectId = randomUUID();
const operationId = randomUUID();
const receiptId = randomUUID();
const playerA = randomUUID();
const launchA = randomUUID();
const depositA = randomUUID();
const credential = 'a'.repeat(43);
const assetId = `erc20:46630:0x${'1'.repeat(40)}`;

function receipt(overrides: Partial<SpawnPayoutReceipt> = {}): SpawnPayoutReceipt {
  return {
    id: receiptId,
    projectId,
    playerId: playerA,
    assetId,
    amount: '10',
    depositId: null,
    status: 'paid',
    createdAt: 1_800_000_000_000,
    ...overrides,
  };
}

test('payout client pins the project, omits cookies, forbids redirects and sends the exact wire payload', async () => {
  const calls: Array<[string, RequestInit]> = [];
  const client = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId: projectId.toUpperCase(),
    credential,
    fetch: async (url, init) => {
      calls.push([String(url), init!]);
      return Response.json(receipt({ depositId: depositA }));
    },
  });

  assert.equal(Object.isFrozen(client), true);
  const created = await client.create({
    operationId: operationId.toUpperCase(),
    playerId: playerA.toUpperCase(),
    launchId: launchA.toUpperCase(),
    amount: '10',
    depositId: depositA.toUpperCase(),
    reason: 'daily reward',
  });
  assert.deepEqual(created, receipt({ depositId: depositA }));

  const readBack = await client.operation(operationId.toUpperCase());
  assert.deepEqual(readBack, receipt({ depositId: depositA }));

  assert.equal(calls[0]![0], `https://spawn.example/api/v1/registered-games/${projectId}/payouts`);
  assert.equal(calls[0]![1].method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]![1].body)), {
    operationId,
    playerId: playerA,
    launchId: launchA,
    amount: '10',
    depositId: depositA,
    reason: 'daily reward',
  });
  assert.equal(calls[0]![1].credentials, 'omit');
  assert.equal(calls[0]![1].redirect, 'error');
  assert.equal(calls[0]![1].cache, 'no-store');
  assert.equal(new Headers(calls[0]![1].headers).get('authorization'), `Bearer ${credential}`);
  assert.equal(new Headers(calls[0]![1].headers).get('content-type'), 'application/json');

  assert.equal(calls[1]![0], `https://spawn.example/api/v1/registered-games/${projectId}/payouts/${operationId}`);
  assert.equal(calls[1]![1].method, 'GET');
  assert.equal(calls[1]![1].body, undefined);
  assert.equal(new Headers(calls[1]![1].headers).get('content-type'), null);
  assert.equal(calls[1]![1].credentials, 'omit');
  assert.equal(calls[1]![1].redirect, 'error');
});

test('payout client omits absent optional fields and never sends a browser-supplied identity', async () => {
  let sent: Record<string, unknown> | undefined;
  const client = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init!.body));
      return Response.json(receipt());
    },
  });
  await client.create({ operationId, playerId: playerA, amount: '10' });
  assert.deepEqual(sent, { operationId, playerId: playerA, amount: '10' });
  assert.equal(Object.hasOwn(sent!, 'launchId'), false);
  assert.equal(Object.hasOwn(sent!, 'depositId'), false);
  assert.equal(Object.hasOwn(sent!, 'reason'), false);
});

test('payout inputs are validated before any request', async () => {
  let calls = 0;
  const client = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => {
      calls++;
      return Response.json(receipt());
    },
  });
  const guest = `guest_${'a'.repeat(64)}`;
  for (const amount of ['0', '00', '01', '+1', '-1', '1e3', '1.0', '1.', '', (2n ** 256n).toString(), '9'.repeat(79)])
    await assert.rejects(client.create({ operationId, playerId: playerA, amount }));
  await assert.rejects(client.create({ operationId: 'not-a-uuid', playerId: playerA, amount: '1' }));
  await assert.rejects(client.create({ operationId, playerId: 'not-a-uuid', amount: '1' }));
  await assert.rejects(client.create({ operationId, playerId: guest, amount: '1' }), /guests cannot receive payouts/);
  await assert.rejects(client.create({ operationId, playerId: playerA, launchId: guest, amount: '1' }));
  await assert.rejects(client.create({ operationId, playerId: playerA, launchId: 'nope', amount: '1' }));
  await assert.rejects(client.create({ operationId, playerId: playerA, depositId: 'nope', amount: '1' }));
  await assert.rejects(client.create({ operationId, playerId: playerA, amount: '1', reason: '' }));
  await assert.rejects(client.create({ operationId, playerId: playerA, amount: '1', reason: 'x'.repeat(161) }));
  await assert.rejects(client.create({ operationId, playerId: playerA, amount: '1', reason: 42 as never }));
  await assert.rejects(client.create({ operationId, playerId: playerA, amount: '1', asset: 'fake' } as never));
  await assert.rejects(client.create({ operationId, playerId: playerA } as never));
  await assert.rejects(client.create({ operationId, playerId: playerA, amount: '1', extra: true } as never));
  await assert.rejects(client.operation('not-a-uuid'));
  assert.equal(calls, 0);
});

test('a 160-character reason is accepted and a launch-bound payout carries the launch', async () => {
  const reason = 'x'.repeat(160);
  let sent: Record<string, unknown> | undefined;
  const client = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init!.body));
      return Response.json(receipt({ amount: '1', depositId: null }));
    },
  });
  await client.create({ operationId, playerId: playerA, launchId: launchA, amount: '1', reason });
  assert.deepEqual(sent, { operationId, playerId: playerA, launchId: launchA, amount: '1', reason });
});

test('the constructor rejects untrusted origins, credentials, clocks and transports', () => {
  for (const platformOrigin of ['http://spawn.example', 'https://spawn.example/path', 'https://u:p@spawn.example', 'https://spawn.example/?x=1', 'ftp://spawn.example'])
    assert.throws(() => createSpawnPayoutClient({ platformOrigin, projectId, credential }));
  for (const invalid of ['not-a-uuid', '', 42]) assert.throws(() => createSpawnPayoutClient({ platformOrigin: 'https://spawn.example', projectId: invalid as never, credential }));
  for (const invalid of ['short', `${'a'.repeat(42)}!`, 42]) assert.throws(() => createSpawnPayoutClient({ platformOrigin: 'https://spawn.example', projectId, credential: invalid as never }));
  for (const timeoutMs of [50, 40_000, 1.5, 'fast']) assert.throws(() => createSpawnPayoutClient({ platformOrigin: 'https://spawn.example', projectId, credential, timeoutMs: timeoutMs as never }));
  assert.throws(() => createSpawnPayoutClient({ platformOrigin: 'https://spawn.example', projectId, credential, fetch: 'nope' as never }));
  for (const platformOrigin of ['http://127.0.0.1:9999', 'http://localhost:9999', 'http://[::1]:9999'])
    assert.doesNotThrow(() => createSpawnPayoutClient({ platformOrigin, projectId, credential }));
});

test('a browser context can never create the payout client', () => {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {};
  try {
    assert.throws(
      () => createSpawnPayoutClient({ platformOrigin: 'https://spawn.example', projectId, credential }),
      /authoritative server/,
    );
  } finally {
    delete (globalThis as { window?: unknown }).window;
    assert.equal((globalThis as { window?: unknown }).window, original);
  }
});

test('HTTP errors map to structured codes with safe reasons and no implicit retry', async () => {
  const cases: Array<[number, string]> = [
    [400, 'HTTP_REJECTED'],
    [401, 'HTTP_UNAUTHORIZED'],
    [403, 'HTTP_FORBIDDEN'],
    [404, 'HTTP_NOT_FOUND'],
    [409, 'HTTP_CONFLICT'],
    [429, 'HTTP_RATE_LIMITED'],
    [503, 'HTTP_UNAVAILABLE'],
  ];
  for (const [status, code] of cases) {
    let calls = 0;
    const client = createSpawnPayoutClient({
      platformOrigin: 'https://spawn.example',
      projectId,
      credential,
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ error: 'rejected by the platform' }), {
          status,
          headers: status === 429 ? { 'retry-after': '7' } : {},
        });
      },
    });
    await assert.rejects(
      client.create({ operationId, playerId: playerA, amount: '1' }),
      (error: unknown) => {
        assert.ok(error instanceof SpawnPayoutRequestError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.equal(error.action, 'create');
        assert.equal(error.operationId, operationId);
        assert.equal(error.projectId, projectId);
        assert.equal(error.reason, 'rejected by the platform');
        assert.equal(error.retryAfterMs, status === 429 ? 7000 : undefined);
        assert.equal(error.outcomeUnknown, status >= 500);
        return true;
      },
    );
    assert.equal(calls, 1, 'a rejected payout is never retried implicitly');
    // A read never claims an unknown outcome, even on a 5xx.
    await assert.rejects(
      client.operation(operationId),
      (error: unknown) => {
        assert.ok(error instanceof SpawnPayoutRequestError);
        assert.equal(error.action, 'operation');
        assert.equal(error.outcomeUnknown, false);
        return true;
      },
    );
  }
});

test('auth failures use the dedicated-credential guidance and never echo the credential', async () => {
  const client = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => new Response(JSON.stringify({ error: `Bearer ${credential} rejected` }), { status: 401 }),
  });
  await assert.rejects(
    client.create({ operationId, playerId: playerA, amount: '1' }),
    (error: unknown) => {
      assert.ok(error instanceof SpawnPayoutRequestError);
      assert.equal(error.code, 'HTTP_UNAUTHORIZED');
      assert.equal(error.message, 'Dedicated match server authorization is required.');
      assert.equal(error.reason, undefined);
      assert.equal(JSON.stringify(error.toJSON()).includes(credential), false);
      return true;
    },
  );
});

test('an unknown payout outcome is reported with the same operation ID and no leaked detail', async () => {
  let calls = 0;
  const client = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => {
      calls++;
      throw new Error('private upstream detail');
    },
  });
  await assert.rejects(
    client.create({ operationId, playerId: playerA, amount: '1' }),
    (error: unknown) => {
      assert.ok(error instanceof SpawnPayoutRequestError);
      assert.equal(error.code, 'TRANSPORT_ERROR');
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.operationId, operationId);
      assert.match(error.message, /operation ID/);
      assert.equal(error.message.includes('private'), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('a payout timeout is bounded and reconcilable by the same operation ID', async () => {
  const client = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    timeoutMs: 100,
    fetch: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  await assert.rejects(
    client.create({ operationId, playerId: playerA, amount: '1' }),
    (error: unknown) => {
      assert.ok(error instanceof SpawnPayoutRequestError);
      assert.equal(error.code, 'REQUEST_TIMEOUT');
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.operationId, operationId);
      return true;
    },
  );
  await assert.rejects(
    client.operation(operationId),
    (error: unknown) => {
      assert.ok(error instanceof SpawnPayoutRequestError);
      assert.equal(error.code, 'REQUEST_TIMEOUT');
      assert.equal(error.outcomeUnknown, false);
      assert.match(error.message, /Could not read the payout operation/);
      return true;
    },
  );
});

test('a receipt must match the requested project, player, amount and deposit', async () => {
  const mutations: Array<[string, unknown]> = [
    ['projectId', receipt({ projectId: randomUUID() })],
    ['playerId', receipt({ playerId: randomUUID() })],
    ['amount', receipt({ amount: '11' })],
    ['depositId', receipt({ depositId: null })],
    ['status', { ...receipt(), status: 'pending' }],
    ['createdAt', receipt({ createdAt: -1 })],
    ['assetId', receipt({ assetId: '' })],
    ['fields', { ...receipt(), extra: true }],
    ['amount', receipt({ amount: '1.0' })],
  ];
  for (const [, body] of mutations) {
    const client = createSpawnPayoutClient({
      platformOrigin: 'https://spawn.example',
      projectId,
      credential,
      fetch: async () => Response.json(body),
    });
    await assert.rejects(
      client.create({ operationId, playerId: playerA, amount: '10', depositId: depositA }),
      (error: unknown) => {
        assert.ok(error instanceof SpawnPayoutRequestError);
        assert.equal(error.code, 'INVALID_RESPONSE');
        assert.equal(error.outcomeUnknown, true);
        return true;
      },
    );
  }
  // A payout without a deposit reference cannot come back with one attached.
  const attached = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => Response.json(receipt({ depositId: depositA })),
  });
  await assert.rejects(attached.create({ operationId, playerId: playerA, amount: '10' }), (error: unknown) =>
    error instanceof SpawnPayoutRequestError && error.code === 'INVALID_RESPONSE');
  // A referenced deposit is echoed back exactly.
  const matching = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => Response.json(receipt({ depositId: depositA })),
  });
  assert.equal((await matching.create({ operationId, playerId: playerA, amount: '10', depositId: depositA })).depositId, depositA);
});

test('malformed or oversized success bodies fail without reporting a payment', async () => {
  for (const body of ['not json', 'x'.repeat(65_537), JSON.stringify({ ...receipt(), status: 'paid', createdAt: 'now' })]) {
    const client = createSpawnPayoutClient({
      platformOrigin: 'https://spawn.example',
      projectId,
      credential,
      fetch: async () => new Response(body),
    });
    await assert.rejects(client.create({ operationId, playerId: playerA, amount: '10' }), (error: unknown) =>
      error instanceof SpawnPayoutRequestError && error.outcomeUnknown === true);
  }
});

test('operation reads return the recorded receipt or null and bind the response to the project', async () => {
  const recorded = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => Response.json(receipt()),
  });
  assert.deepEqual(await recorded.operation(operationId), receipt());

  const missing = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => new Response('null'),
  });
  assert.equal(await missing.operation(operationId), null);

  const foreign = createSpawnPayoutClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => Response.json(receipt({ projectId: randomUUID() })),
  });
  await assert.rejects(foreign.operation(operationId), (error: unknown) =>
    error instanceof SpawnPayoutRequestError && error.outcomeUnknown === false && error.code === 'INVALID_RESPONSE');
});

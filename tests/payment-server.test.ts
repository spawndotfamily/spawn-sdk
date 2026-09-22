import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createSpawnPaymentClient,
  SpawnTokenPaymentError,
  type SpawnTokenPaymentLookup,
  type SpawnTokenPaymentReceipt,
} from '../src/payment-server.ts';

const projectId = randomUUID();
const playerId = randomUUID();
const requestId = randomUUID();
const launchId = randomUUID();
const receiptId = randomUUID();
const credential = 'p'.repeat(43);
const assetId = `erc20:46630:0x${'a'.repeat(40)}`;

const options = {
  platformOrigin: 'https://spawn.example',
  projectId,
  credential,
};

function receipt(overrides: Partial<SpawnTokenPaymentReceipt> = {}): SpawnTokenPaymentReceipt {
  return {
    id: receiptId,
    assetId,
    amount: '250000000000000000',
    projectId,
    status: 'paid',
    ...overrides,
  };
}

function lookup(overrides: Partial<SpawnTokenPaymentLookup> = {}): SpawnTokenPaymentLookup {
  return {
    status: 'paid',
    playerId,
    requestId,
    launchId,
    item: 'Sword',
    receipt: receipt(),
    ...overrides,
  };
}

test('payment lookup uses the dedicated read-only POST contract and validates the paid tuple', async () => {
  const calls: Array<[string, RequestInit]> = [];
  const client = createSpawnPaymentClient({
    ...options,
    projectId: projectId.toUpperCase(),
    fetch: async (url, init) => {
      calls.push([String(url), init!]);
      return Response.json(lookup());
    },
  });

  assert.equal(Object.isFrozen(client), true);
  const result = await client.lookup({
    playerId: playerId.toUpperCase(),
    requestId: requestId.toUpperCase(),
    launchId: launchId.toUpperCase(),
  });
  assert.deepEqual(result, lookup());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], `https://spawn.example/api/v1/registered-games/${projectId}/token-payments/lookup`);
  assert.equal(calls[0]![1].method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]![1].body)), {
    playerId,
    requestId,
    launchId,
  });
  assert.equal(calls[0]![1].credentials, 'omit');
  assert.equal(calls[0]![1].redirect, 'error');
  assert.equal(calls[0]![1].cache, 'no-store');
  assert.equal(new Headers(calls[0]![1].headers).get('authorization'), `Bearer ${credential}`);
  assert.equal(new Headers(calls[0]![1].headers).get('accept'), 'application/json');
  assert.equal(new Headers(calls[0]![1].headers).get('content-type'), 'application/json');
});

test('receipt ID lookup sends only its exact union member and binds the returned receipt', async () => {
  let sent: unknown;
  const client = createSpawnPaymentClient({
    ...options,
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init!.body));
      return Response.json(lookup({ requestId: null, launchId, receipt: receipt() }));
    },
  });
  const result = await client.lookup({ playerId: playerId.toUpperCase(), receiptId: receiptId.toUpperCase() });
  assert.deepEqual(sent, { playerId, receiptId });
  assert.equal(result.receipt?.id, receiptId);
});

test('lookup inputs are strict UUID unions and are rejected before transport', async () => {
  let calls = 0;
  const client = createSpawnPaymentClient({
    ...options,
    fetch: async () => {
      calls++;
      return Response.json(lookup());
    },
  });
  const invalid: unknown[] = [
    undefined,
    null,
    {},
    { playerId },
    { playerId, receiptId, requestId, launchId },
    { playerId, requestId },
    { playerId, launchId },
    { playerId, requestId, launchId, extra: true },
    { playerId, receiptId, extra: true },
    { playerId: 'not-a-uuid', receiptId },
    { playerId: `guest_${'a'.repeat(64)}`, receiptId },
    { playerId, receiptId: 'not-a-uuid' },
    { playerId, requestId: 'not-a-uuid', launchId },
    { playerId, requestId, launchId: 'not-a-uuid' },
  ];
  for (const input of invalid)
    await assert.rejects(client.lookup(input as never), /UUID|signed-in|fields|either/i);
  assert.equal(calls, 0);
});

test('pending, cancelled, expired and missing statuses never expose a receipt', async () => {
  for (const status of ['pending', 'cancelled', 'expired'] as const) {
    const client = createSpawnPaymentClient({
      ...options,
      fetch: async () => Response.json(lookup({ status, receipt: null })),
    });
    const result = await client.lookup({ playerId, requestId, launchId });
    assert.equal(result.status, status);
    assert.equal(result.receipt, null);
  }
  const missing = createSpawnPaymentClient({
    ...options,
    fetch: async () => Response.json(lookup({ status: 'not_found', requestId: null, launchId: null, item: null, receipt: null })),
  });
  assert.deepEqual(
    await missing.lookup({ playerId, requestId, launchId }),
    { status: 'not_found', playerId, requestId: null, launchId: null, item: null, receipt: null },
  );
});

test('responses are bound to the queried player, request, launch, project and receipt', async () => {
  const cases: unknown[] = [
    lookup({ playerId: randomUUID() }),
    lookup({ requestId: randomUUID() }),
    lookup({ launchId: randomUUID() }),
    lookup({ receipt: receipt({ projectId: randomUUID() }) }),
    lookup({ receipt: receipt({ status: 'pending' as never }) }),
  ];
  for (const body of cases) {
    const client = createSpawnPaymentClient({ ...options, fetch: async () => Response.json(body) });
    await assert.rejects(
      client.lookup({ playerId, requestId, launchId }),
      (error: unknown) => error instanceof SpawnTokenPaymentError && error.code === 'INVALID_RESPONSE',
    );
  }

  const wrongReceipt = createSpawnPaymentClient({
    ...options,
    fetch: async () => Response.json(lookup({ requestId: null, launchId, receipt: receipt({ id: randomUUID() }) })),
  });
  await assert.rejects(
    wrongReceipt.lookup({ playerId, receiptId }),
    (error: unknown) => error instanceof SpawnTokenPaymentError && error.code === 'INVALID_RESPONSE',
  );
});

test('paid responses require an exact five-field receipt and valid token identity', async () => {
  const badBodies: unknown[] = [
    { ...lookup(), extra: true },
    { ...lookup(), receipt: { ...receipt(), extra: true } },
    { ...lookup(), receipt: { ...receipt(), id: 'not-a-uuid' } },
    { ...lookup(), receipt: { ...receipt(), assetId: '' } },
    { ...lookup(), receipt: { ...receipt(), assetId: `erc20:46630:0x${'A'.repeat(40)}` } },
    { ...lookup(), receipt: { ...receipt(), amount: '1.0' } },
    { ...lookup(), receipt: { ...receipt(), amount: '0' } },
    { ...lookup(), receipt: { ...receipt(), amount: (2n ** 256n).toString() } },
    { ...lookup(), item: '' },
    { ...lookup(), item: 'x'.repeat(81) },
    { ...lookup(), item: '\u0000' },
    { ...lookup(), status: 'pending', receipt: receipt() },
    { ...lookup(), status: 'paid', receipt: null },
    { ...lookup(), status: 'unknown' },
    { ...lookup({ status: 'not_found', requestId, launchId, item: null, receipt: null }) },
    { ...lookup({ status: 'not_found', requestId: null, launchId: null, item: 'Sword', receipt: null }) },
    { ...lookup({ status: 'pending', requestId: null, launchId, receipt: null }) },
    { ...lookup({ status: 'pending', requestId, launchId, item: null, receipt: null }) },
  ];
  for (const body of badBodies) {
    const client = createSpawnPaymentClient({ ...options, fetch: async () => Response.json(body) });
    await assert.rejects(
      client.lookup({ playerId, requestId, launchId }),
      (error: unknown) => error instanceof SpawnTokenPaymentError && error.code === 'INVALID_RESPONSE',
    );
  }
});

test('HTTP failures expose structured safe diagnostics and never retry or echo credentials', async () => {
  for (const [status, code] of [
    [400, 'HTTP_REJECTED'],
    [401, 'HTTP_UNAUTHORIZED'],
    [403, 'HTTP_FORBIDDEN'],
    [404, 'HTTP_NOT_FOUND'],
    [409, 'HTTP_CONFLICT'],
    [429, 'HTTP_RATE_LIMITED'],
    [503, 'HTTP_UNAVAILABLE'],
  ] as const) {
    let calls = 0;
    const client = createSpawnPaymentClient({
      ...options,
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ error: 'lookup rejected' }), {
          status,
          headers: status === 429 ? { 'retry-after': '7' } : {},
        });
      },
    });
    await assert.rejects(
      client.lookup({ playerId, requestId, launchId }),
      (error: unknown) => {
        assert.ok(error instanceof SpawnTokenPaymentError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.equal(error.reason, 'lookup rejected');
        assert.equal(error.requestId, requestId);
        assert.equal(error.retryAfterMs, status === 429 ? 7000 : undefined);
        assert.equal(JSON.stringify(error.toJSON()).includes(credential), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test('network, timeout, malformed and oversized responses become safe read errors without retry', async () => {
  let calls = 0;
  const network = createSpawnPaymentClient({
    ...options,
    fetch: async () => {
      calls++;
      throw new Error('private upstream detail');
    },
  });
  await assert.rejects(
    network.lookup({ playerId, requestId, launchId }),
    (error: unknown) => {
      assert.ok(error instanceof SpawnTokenPaymentError);
      assert.equal(error.code, 'TRANSPORT_ERROR');
      assert.equal(error.message.includes('private'), false);
      assert.match(error.message, /retain the original payment request/i);
      assert.equal(Object.hasOwn(error, 'outcomeUnknown'), false);
      return true;
    },
  );
  assert.equal(calls, 1);

  for (const response of [
    new Response('not json'),
    new Response('x'.repeat(65_537)),
    Response.json({ ...lookup(), status: 42 }),
  ]) {
    const client = createSpawnPaymentClient({ ...options, fetch: async () => response });
    await assert.rejects(
      client.lookup({ playerId, requestId, launchId }),
      (error: unknown) => error instanceof SpawnTokenPaymentError && error.code === 'INVALID_RESPONSE',
    );
  }

  const timeout = createSpawnPaymentClient({
    ...options,
    timeoutMs: 100,
    fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await assert.rejects(
    timeout.lookup({ playerId, requestId, launchId }),
    (error: unknown) => error instanceof SpawnTokenPaymentError && error.code === 'REQUEST_TIMEOUT',
  );
});

test('constructor and browser checks match the server-only credential contract', () => {
  for (const platformOrigin of [
    'http://spawn.example',
    'https://spawn.example/path',
    'https://spawn.example/',
    'https://u:p@spawn.example',
    'ftp://spawn.example',
  ]) assert.throws(() => createSpawnPaymentClient({ ...options, platformOrigin }));
  for (const project of ['not-a-uuid', '', 42]) assert.throws(() => createSpawnPaymentClient({ ...options, projectId: project as never }));
  for (const key of ['short', `${'a'.repeat(42)}!`, 42]) assert.throws(() => createSpawnPaymentClient({ ...options, credential: key as never }));
  for (const timeoutMs of [50, 40_000, 1.5, 'fast']) assert.throws(() => createSpawnPaymentClient({ ...options, timeoutMs: timeoutMs as never }));
  assert.throws(() => createSpawnPaymentClient({ ...options, fetch: 'nope' as never }));
  for (const platformOrigin of ['http://127.0.0.1:9999', 'http://localhost:9999', 'http://[::1]:9999'])
    assert.doesNotThrow(() => createSpawnPaymentClient({ ...options, platformOrigin }));

  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {};
  try {
    assert.throws(() => createSpawnPaymentClient(options), /authoritative server/);
  } finally {
    delete (globalThis as { window?: unknown }).window;
    assert.equal((globalThis as { window?: unknown }).window, original);
  }
});

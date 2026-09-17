import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createSpawnTableClient,
  SpawnTableRequestError,
  type SpawnTableStatus,
} from '../src/table-server.ts';
import {
  validateSpawnTablePlayerStatus,
  validateSpawnTableStatus,
} from '../src/table-validation.ts';

const projectId = randomUUID();
const tableId = randomUUID();
const operationId = randomUUID();
const buyInId = randomUUID();
const handId = randomUUID();
const playerA = randomUUID();
const playerB = randomUUID();
const seatA = randomUUID();
const seatB = randomUUID();
const launchA = randomUUID();
const launchB = randomUUID();
const credential = 'a'.repeat(43);
const asset = {
  id: 'erc20:46630:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  chainId: 46630,
  address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Spawn Token',
  symbol: 'SPAWN',
  decimals: 18,
  image: '',
  source: 'spawn' as const,
  enabled: true,
};

function status(overrides: Partial<SpawnTableStatus> = {}): SpawnTableStatus {
  return {
    tableId,
    projectId,
    status: 'open',
    asset,
    settingsVersion: 3,
    maxSeats: 6,
    revision: 1,
    leaseExpiresAt: 1_800_000_000_000,
    maxEndsAt: 1_800_086_400_000,
    totals: {
      buyIns: '30',
      cashOuts: '0',
      stacks: '30',
      committed: '0',
      pendingCashOuts: '0',
      backing: '30',
    },
    seats: [
      { seatId: seatA, playerId: playerA, stack: '15', pendingCashOut: '0', status: 'active', connectedUntil: 1_800_000_010_000, disconnectDeadline: null },
      { seatId: seatB, playerId: playerB, stack: '15', pendingCashOut: '0', status: 'active', connectedUntil: 1_800_000_010_000, disconnectDeadline: null },
    ],
    hand: null,
    ...overrides,
  };
}

function quote(statusValue: 'pending' | 'confirmed' | 'cancelled' | 'expired' = 'pending') {
  return {
    tableId,
    buyInId,
    playerId: playerA,
    quoteId: randomUUID(),
    status: statusValue,
    amount: '15',
    asset,
    settingsVersion: 3,
    expiresAt: 1_800_000_000_000,
  };
}

test('table server client pins the project, omits cookies, and sends exact base-unit wire payloads', async () => {
  const calls: Array<[string, RequestInit]> = [];
  const client = createSpawnTableClient({
    platformOrigin: 'https://spawn.example',
    projectId: projectId.toUpperCase(),
    credential,
    fetch: async (url, init) => {
      calls.push([String(url), init!]);
      const path = String(url).split('/tables')[1];
      if (path === '') return Response.json(status(), { status: 201 });
      if (path === `/${tableId}/buy-ins`) return Response.json(quote());
      return Response.json(status());
    },
  });

  await client.create({ tableId: tableId.toUpperCase(), operationId: operationId.toUpperCase(), maxSeats: 6 });
  await client.requestBuyIn(tableId, {
    operationId,
    buyInId,
    player: { playerId: playerA, launchId: launchA },
    amount: '15',
  });
  await client.commitHand(tableId, {
    operationId,
    handId,
    expectedRevision: 1,
    contributions: [{ playerId: playerA, amount: '5' }],
    folded: [playerB],
  });

  assert.equal(calls[0]![0], `https://spawn.example/api/v1/registered-games/${projectId}/tables`);
  assert.deepEqual(JSON.parse(String(calls[0]![1].body)), {
    tableId,
    operationId,
    maxSeats: 6,
  });
  assert.equal(calls[0]![1].credentials, 'omit');
  assert.equal(calls[0]![1].redirect, 'error');
  assert.equal(calls[0]![1].cache, 'no-store');
  assert.equal(new Headers(calls[0]![1].headers).get('authorization'), `Bearer ${credential}`);
  assert.equal(calls[0]![1].method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[2]![1].body)), {
    operationId,
    handId,
    expectedRevision: 1,
    contributions: [{ playerId: playerA, amount: '5' }],
    folded: [playerB],
  });
});

test('table mutations validate UUIDs, guest IDs, canonical uint256 units, and exact fields before transport', async () => {
  let calls = 0;
  const client = createSpawnTableClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => {
      calls++;
      return Response.json(status());
    },
  });
  const guest = `guest_${'a'.repeat(64)}`;
  for (const amount of ['00', '01', '+1', '-1', '1e3', '1.0', '', (2n ** 256n).toString(), '9'.repeat(79)]) {
    await assert.rejects(client.requestBuyIn(tableId, {
      operationId,
      buyInId,
      player: { playerId: playerA, launchId: launchA },
      amount,
    }));
  }
  await assert.rejects(client.requestBuyIn(tableId, {
    operationId,
    buyInId,
    player: { playerId: guest, launchId: launchA },
    amount: '1',
  }));
  await assert.rejects(client.create({ tableId, operationId, maxSeats: 7 }));
  await assert.rejects(client.startHand(tableId, {
    operationId,
    handId,
    players: [{ playerId: playerA, seatId: seatA }, { playerId: playerA, seatId: seatA }],
  }));
  await assert.rejects(client.settleHand(tableId, {
    operationId,
    handId,
    expectedRevision: 1,
    pots: [{ cap: '1', winners: [{ playerId: guest, amount: '1' }] }],
  }));
  await assert.rejects(client.cashOut(tableId, { operationId, playerId: 'not-a-uuid', seatId: seatA }));
  assert.equal(calls, 0);
});

test('unknown table mutations never retry and expose structured safe diagnostics', async () => {
  let calls = 0;
  const client = createSpawnTableClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => {
      calls++;
      throw new Error('private upstream detail');
    },
  });
  await assert.rejects(
    client.cashOut(tableId, { operationId, playerId: playerA, seatId: seatA }),
    (error: unknown) => error instanceof SpawnTableRequestError &&
      error.outcomeUnknown === true &&
      error.action === 'cashOut' &&
      error.tableId === tableId &&
      error.operationId === operationId &&
      error.code === 'TRANSPORT_ERROR' &&
      !error.message.includes('private'),
  );
  assert.equal(calls, 1);
});

test('malformed table success cannot be reported as a status or buy-in result', async () => {
  const badStatus = createSpawnTableClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => Response.json({ ...status(), totals: { ...status().totals, backing: '29' } }),
  });
  await assert.rejects(badStatus.status(tableId), (error: unknown) => error instanceof SpawnTableRequestError && error.outcomeUnknown === false);

  const badQuote = createSpawnTableClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => Response.json({ ...quote(), amount: '1.0' }),
  });
  await assert.rejects(badQuote.buyIn(tableId, buyInId), /unknown|invalid/i);
});

test('table responses stay bound to the requested table and buy-in intent', async () => {
  const otherTable = randomUUID();
  const otherBuyIn = randomUUID();
  const otherPlayer = randomUUID();
  const client = createSpawnTableClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async (url) => {
      const path = String(url).split('/tables')[1];
      if (path === `/${tableId}/buy-ins`) {
        return Response.json({ ...quote(), buyInId: otherBuyIn, playerId: otherPlayer });
      }
      if (path === `/${tableId}/buy-ins/${buyInId}`) return Response.json({ ...quote(), buyInId: otherBuyIn });
      return Response.json({ ...status(), tableId: otherTable });
    },
  });
  await assert.rejects(client.status(tableId), (error: unknown) => error instanceof SpawnTableRequestError && error.outcomeUnknown === false);
  await assert.rejects(client.requestBuyIn(tableId, {
    operationId,
    buyInId,
    player: { playerId: playerA, launchId: launchA },
    amount: '15',
  }), (error: unknown) => error instanceof SpawnTableRequestError && error.outcomeUnknown === true);
  await assert.rejects(client.buyIn(tableId, buyInId), (error: unknown) => error instanceof SpawnTableRequestError && error.outcomeUnknown === false);
  await assert.rejects(client.requestBuyIn(tableId, {
    operationId,
    buyInId,
    player: { playerId: playerA, launchId: launchA },
    amount: '16',
  }), (error: unknown) => error instanceof SpawnTableRequestError && error.outcomeUnknown === true);
});

test('heartbeat uncertainty directs a status read without an operation lookup', async () => {
  const client = createSpawnTableClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => { throw new Error('private upstream detail'); },
  });
  await assert.rejects(client.heartbeat(tableId), (error: unknown) => error instanceof SpawnTableRequestError &&
    error.outcomeUnknown === true &&
    error.action === 'heartbeat' &&
    error.operationId === undefined &&
    /heartbeat/i.test(error.message) &&
    /status/i.test(error.message) &&
    !/operation ID/i.test(error.message));
});

test('operation lookup uses the durable operation path and validates the same operation ID', async () => {
  let seen = '';
  const client = createSpawnTableClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async (url) => {
      seen = String(url);
      return Response.json({ operationId, action: 'cashOut', result: status() });
    },
  });
  const result = await client.operation(tableId, operationId);
  assert.equal(result.operationId, operationId);
  assert.equal(seen, `https://spawn.example/api/v1/registered-games/${projectId}/tables/${tableId}/operations/${operationId}`);
});

test('operation recovery context binds the recorded action, buy-in and player when available', async () => {
  const client = createSpawnTableClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async () => Response.json({ operationId, action: 'requestBuyIn', result: quote() }),
  });
  const result = await client.operation(tableId, operationId, {
    action: 'requestBuyIn',
    buyInId,
    playerId: playerA,
  });
  assert.equal(result.action, 'requestBuyIn');
  await assert.rejects(client.operation(tableId, operationId, { action: 'cashOut' }), (error: unknown) => error instanceof SpawnTableRequestError &&
    error.outcomeUnknown === false && error.code === 'INVALID_RESPONSE');
});

test('status validators preserve seat generations, pending cash-outs and absent-table tombstones', () => {
  const publicState = status();
  const player = validateSpawnTablePlayerStatus({
    tableId,
    projectId,
    playerId: playerA,
    seatId: seatA,
    seat: publicState.seats[0],
    stack: '15',
    pendingCashOut: '0',
    seatStatus: 'active',
    publicTableState: publicState,
  }, tableId, 'https://spawn.example');
  assert.equal(player.seatId, seatA);
  assert.equal(player.seat?.pendingCashOut, '0');

  const tombstone = validateSpawnTableStatus({
    ...publicState,
    status: 'closed',
    asset: null,
    settingsVersion: 0,
    maxSeats: 0,
    leaseExpiresAt: null,
    seats: [],
    hand: null,
    totals: { buyIns: '0', cashOuts: '0', stacks: '0', committed: '0', pendingCashOuts: '0', backing: '0' },
  }, projectId, 'https://spawn.example');
  assert.equal(tombstone.asset, null);
  assert.equal(tombstone.maxSeats, 0);
  assert.equal(tombstone.leaseExpiresAt, null);
  assert.throws(() => validateSpawnTableStatus({
    ...tombstone,
    totals: { buyIns: '1', cashOuts: '1', stacks: '0', committed: '0', pendingCashOuts: '0', backing: '0' },
  }, projectId, 'https://spawn.example'), /zero monetary totals/i);
});

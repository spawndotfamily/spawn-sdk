import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createLoopbackTableService, TABLE_POLICY } from '../testing/loopback-table-service.mjs';

async function createTable(service: ReturnType<typeof createLoopbackTableService>, maxSeats = 2) {
  const tableId = randomUUID();
  await service.client.create({ tableId, operationId: randomUUID(), maxSeats });
  return tableId;
}

async function buyIn(
  service: ReturnType<typeof createLoopbackTableService>,
  tableId: string,
  playerId: string,
  amount = '20',
) {
  const buyInId = randomUUID();
  await service.client.requestBuyIn(tableId, {
    operationId: randomUUID(),
    buyInId,
    player: { playerId, launchId: randomUUID() },
    amount,
  });
  service.confirmBuyIn(playerId);
  return buyInId;
}

test('a later invalid contribution leaves the hand and stacks unchanged', async () => {
  const service = createLoopbackTableService();
  const tableId = await createTable(service);
  const players = [randomUUID(), randomUUID()];
  await buyIn(service, tableId, players[0]);
  await buyIn(service, tableId, players[1]);
  const seats = (await service.client.status(tableId)).seats;
  const started = await service.client.startHand(tableId, {
    operationId: randomUUID(),
    handId: randomUUID(),
    players: seats.map(({ playerId, seatId }) => ({ playerId, seatId })),
  });
  const before = await service.client.status(tableId);

  await assert.rejects(
    service.client.commitHand(tableId, {
      operationId: randomUUID(),
      handId: started.hand!.handId,
      expectedRevision: started.hand!.revision,
      contributions: [
        { playerId: players[0], amount: '3' },
        { playerId: players[1], amount: '99' },
      ],
      folded: [],
    }),
    /insufficient stack/i,
  );
  assert.deepEqual(await service.client.status(tableId), before);
});

async function committedThreePlayerHand() {
  const service = createLoopbackTableService();
  const tableId = await createTable(service, 3);
  const players = [randomUUID(), randomUUID(), randomUUID()];
  for (const playerId of players) await buyIn(service, tableId, playerId);
  const seats = (await service.client.status(tableId)).seats;
  const handId = randomUUID();
  const started = await service.client.startHand(tableId, {
    operationId: randomUUID(),
    handId,
    players: seats.map(({ playerId, seatId }) => ({ playerId, seatId })),
  });
  const committed = await service.client.commitHand(tableId, {
    operationId: randomUUID(),
    handId,
    expectedRevision: started.hand!.revision,
    contributions: [
      { playerId: players[0], amount: '10' },
      { playerId: players[1], amount: '10' },
      { playerId: players[2], amount: '5' },
    ],
    folded: [],
  });
  return { service, tableId, players, handId, committed };
}

test('a valid pot followed by an invalid pot leaves settlement state unchanged', async () => {
  const { service, tableId, players, handId, committed } = await committedThreePlayerHand();
  const before = await service.client.status(tableId);
  const pots = committed.hand!.pots;
  assert.equal(pots.length, 2);
  const low = pots[0]!;
  const high = pots[1]!;

  await assert.rejects(
    service.client.settleHand(tableId, {
      operationId: randomUUID(),
      handId,
      expectedRevision: committed.hand!.revision,
      pots: [
        { cap: low.cap, winners: [{ playerId: players[0], amount: low.amount }] },
        { cap: high.cap, winners: [{ playerId: players[2], amount: high.amount }] },
      ],
    }),
    /eligible|pot/i,
  );
  assert.deepEqual(await service.client.status(tableId), before);
});

test('duplicate settlement caps are rejected without changing stacks or hand state', async () => {
  const { service, tableId, players, handId, committed } = await committedThreePlayerHand();
  const before = await service.client.status(tableId);
  const low = committed.hand!.pots[0]!;

  await assert.rejects(
    service.client.settleHand(tableId, {
      operationId: randomUUID(),
      handId,
      expectedRevision: committed.hand!.revision,
      pots: [
        { cap: low.cap, winners: [{ playerId: players[0], amount: low.amount }] },
        { cap: low.cap, winners: [{ playerId: players[0], amount: low.amount }] },
      ],
    }),
    /cap|pot/i,
  );
  assert.deepEqual(await service.client.status(tableId), before);
});

test('pending quotes and active seats together enforce the table seat cap', async () => {
  const service = createLoopbackTableService();
  const tableId = await createTable(service, 2);
  const players = [randomUUID(), randomUUID(), randomUUID()];
  for (const playerId of players.slice(0, 2)) {
    await service.client.requestBuyIn(tableId, {
      operationId: randomUUID(),
      buyInId: randomUUID(),
      player: { playerId, launchId: randomUUID() },
      amount: '1',
    });
  }
  await assert.rejects(
    service.client.requestBuyIn(tableId, {
      operationId: randomUUID(),
      buyInId: randomUUID(),
      player: { playerId: players[2], launchId: randomUUID() },
      amount: '1',
    }),
    /capacity|available seat/i,
  );

  service.confirmBuyIn(players[0]);
  service.confirmBuyIn(players[1]);
  await assert.rejects(
    service.client.requestBuyIn(tableId, {
      operationId: randomUUID(),
      buyInId: randomUUID(),
      player: { playerId: players[2], launchId: randomUUID() },
      amount: '1',
    }),
    /capacity|available seat/i,
  );
  assert.equal((await service.client.status(tableId)).seats.length, 2);
});

test('a quote cannot be approved at its exact expiry timestamp', async () => {
  let now = 1_800_000_000_000;
  const service = createLoopbackTableService({ now: () => now });
  const tableId = await createTable(service);
  const playerId = randomUUID();
  const buyInId = randomUUID();
  const quote = await service.client.requestBuyIn(tableId, {
    operationId: randomUUID(),
    buyInId,
    player: { playerId, launchId: randomUUID() },
    amount: '1',
  });
  now = quote.expiresAt;
  assert.throws(() => service.confirmBuyIn(playerId), /expired/i);
  assert.equal((await service.client.buyIn(tableId, buyInId)).status, 'expired');
});

test('heartbeat and recovery never extend a table beyond max age', async () => {
  let now = 1_800_000_000_000;
  const playerId = randomUUID();
  const service = createLoopbackTableService({ now: () => now, balances: { [playerId]: '10' } });
  const tableId = await createTable(service);
  await buyIn(service, tableId, playerId, '10');
  const created = await service.client.status(tableId);
  now = created.maxEndsAt;
  service.advance(0);
  const closed = await service.client.status(tableId);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.leaseExpiresAt, null);
  assert.equal(closed.seats.length, 0);
  assert.equal(closed.totals.cashOuts, '10');
  assert.equal(service.balance(playerId), '10');
  assert.equal(closed.maxEndsAt, created.maxEndsAt);
  assert.equal(TABLE_POLICY.maxAgeMs, created.maxEndsAt - 1_800_000_000_000);
});

test('closing an unknown table creates a replayable tombstone that fences creation', async () => {
  const service = createLoopbackTableService();
  const tableId = randomUUID();
  const operationId = randomUUID();
  const closed = await service.client.close(tableId, { operationId });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.asset, null);
  assert.equal(closed.settingsVersion, 0);
  assert.equal(closed.maxSeats, 0);
  assert.equal(closed.leaseExpiresAt, null);
  assert.deepEqual(closed.totals, {
    buyIns: '0',
    cashOuts: '0',
    stacks: '0',
    committed: '0',
    pendingCashOuts: '0',
    backing: '0',
  });
  assert.deepEqual(await service.client.close(tableId, { operationId }), closed);
  assert.deepEqual((await service.client.operation(tableId, operationId)).result, closed);
  await assert.rejects(
    service.client.create({ tableId, operationId: randomUUID(), maxSeats: 2 }),
    /closed|already exists|fenced/i,
  );
});

/**
 * Headless table-bankroll scenarios for the SDK loopback service.
 *
 * Run:  node testing/table-scenarios.mjs
 *
 * Every scenario asserts the platform invariant after each money step:
 *   buyIns = cashOuts + stacks + committed + pendingCashOuts
 * A failed assertion exits non-zero, so this can gate CI or a pre-publish check.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLoopbackTableService } from './loopback-table-service.mjs';

const results = [];
const op = () => randomUUID();
const ALICE = randomUUID();
const BOB = randomUUID();
const [hand1, hand2, hand3] = [randomUUID(), randomUUID(), randomUUID()];
const seatOf = (service, playerId) =>
  service.state().seats.find((seat) => seat.playerId === playerId).seatId;

async function scenario(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
}

function checkConservation(service) {
  const { balanced, detail } = service.conservation();
  assert.equal(balanced, true, `conservation broken: ${detail}`);
}

/** Buy in and confirm, returning the seat id. */
async function seatPlayer(service, tableId, playerId, amount) {
  const buyInId = randomUUID();
  await service.client.requestBuyIn(tableId, {
    operationId: op(),
    buyInId,
    player: { playerId, launchId: randomUUID() },
    amount,
  });
  const quote = await service.client.buyIn(tableId, buyInId);
  assert.equal(quote.status, 'pending');
  service.confirmBuyIn(playerId);
  checkConservation(service);
  return seatOf(service, playerId);
}

await scenario('unequal all-ins and side pots settle exactly', async () => {
  const service = createLoopbackTableService();
  const tableId = randomUUID();
  await service.client.create({ tableId, operationId: op(), maxSeats: 6 });
  const alice = await seatPlayer(service, tableId, ALICE, '10000');
  const bob = await seatPlayer(service, tableId, BOB, '4000');

  await service.client.startHand(tableId, {
    operationId: op(),
    handId: hand1,
    players: [
      { playerId: ALICE, seatId: alice },
      { playerId: BOB, seatId: bob },
    ],
  });
  await service.client.commitHand(tableId, {
    operationId: op(),
    handId: hand1,
    expectedRevision: 0,
    contributions: [
      { playerId: ALICE, amount: '10000' },
      { playerId: BOB, amount: '4000' },
    ],
    folded: [],
  });
  const status = await service.client.settleHand(tableId, {
    operationId: op(),
    handId: hand1,
    expectedRevision: 1,
    pots: [{ cap: '4000', winners: [{ playerId: BOB, amount: '8000' }] }],
  });
  checkConservation(service);
  const stacks = Object.fromEntries(status.seats.map((seat) => [seat.playerId, seat.stack]));
  assert.equal(stacks[BOB], '8000', 'bob wins the contested pot');
  assert.equal(stacks[ALICE], '6000', 'alice gets the uncalled 6000 back');
  assert.equal(status.totals.committed, '0', 'nothing stays committed after settlement');
});

await scenario('leaving a settled table returns each remaining stack once', async () => {
  const service = createLoopbackTableService();
  const tableId = randomUUID();
  await service.client.create({ tableId, operationId: op(), maxSeats: 2 });
  const alice = await seatPlayer(service, tableId, ALICE, '5000');
  const bob = await seatPlayer(service, tableId, BOB, '3000');
  await service.client.cashOut(tableId, { operationId: op(), playerId: ALICE, seatId: alice });
  await service.client.cashOut(tableId, { operationId: op(), playerId: BOB, seatId: bob });
  checkConservation(service);
  const { totals } = service.conservation();
  assert.equal(totals.cashOuts, '8000');
  assert.equal(totals.stacks, '0');
  assert.equal(totals.buyIns, '8000');
});

await scenario('disconnect grace resolves an absent player without double-paying', async () => {
  const service = createLoopbackTableService();
  const tableId = randomUUID();
  await service.client.create({ tableId, operationId: op(), maxSeats: 2 });
  const alice = await seatPlayer(service, tableId, ALICE, '7000');

  await service.client.disconnect(tableId, { operationId: op(), playerId: ALICE, seatId: alice });
  service.advance(5000);
  checkConservation(service);
  assert.equal(service.state().seats.length, 1, 'still inside the grace window');

  service.advance(30_000);
  checkConservation(service);
  const { totals } = service.conservation();
  assert.equal(totals.cashOuts, '7000', 'refunded exactly once after grace');
  assert.equal(service.state().seats.length, 0);
});

await scenario('a reconnect inside the grace window keeps the seat', async () => {
  const service = createLoopbackTableService();
  const tableId = randomUUID();
  await service.client.create({ tableId, operationId: op(), maxSeats: 2 });
  const alice = await seatPlayer(service, tableId, ALICE, '2000');
  await service.client.disconnect(tableId, { operationId: op(), playerId: ALICE, seatId: alice });
  service.advance(10_000);
  service.reconnect(ALICE);
  service.advance(60_000);
  checkConservation(service);
  assert.equal(service.state().seats.length, 1, 'reconnect cancels the grace deadline');
  assert.equal(service.state().seats[0].stack, '2000');
});

await scenario('a lost response retries with the same operation id, applied once', async () => {
  const service = createLoopbackTableService();
  const tableId = randomUUID();
  await service.client.create({ tableId, operationId: op(), maxSeats: 2 });
  const alice = await seatPlayer(service, tableId, ALICE, '9000');
  const bob = await seatPlayer(service, tableId, BOB, '9000');
  await service.client.startHand(tableId, {
    operationId: op(),
    handId: hand2,
    players: [
      { playerId: ALICE, seatId: alice },
      { playerId: BOB, seatId: bob },
    ],
  });

  const commit = {
    operationId: op(),
    handId: hand2,
    expectedRevision: 0,
    contributions: [
      { playerId: ALICE, amount: '1000' },
      { playerId: BOB, amount: '1000' },
    ],
    folded: [],
  };
  service.loseNextResponse('commitHand');
  // A lost response must surface as an UNKNOWN outcome, never as success or failure.
  await assert.rejects(
    () => service.client.commitHand(tableId, commit),
    /outcome is unknown/i,
  );

  await service.client.commitHand(tableId, commit);
  checkConservation(service);
  const status = await service.client.status(tableId);
  const committed = Object.fromEntries(
    status.hand.players.map((player) => [player.playerId, player.contribution]),
  );
  assert.deepEqual(committed, { [ALICE]: '1000', [BOB]: '1000' }, 'applied exactly once');
  assert.equal(status.totals.committed, '2000');
  const replayed = await service.client.operation(tableId, commit.operationId);
  assert.equal(replayed.action, 'commitHand', 'the saved operation is queryable after a loss');
});

await scenario('an expired hand deadline refunds unfinished contributions', async () => {
  const service = createLoopbackTableService();
  const tableId = randomUUID();
  await service.client.create({ tableId, operationId: op(), maxSeats: 2 });
  const alice = await seatPlayer(service, tableId, ALICE, '4000');
  const bob = await seatPlayer(service, tableId, BOB, '4000');
  await service.client.startHand(tableId, {
    operationId: op(),
    handId: hand3,
    players: [
      { playerId: ALICE, seatId: alice },
      { playerId: BOB, seatId: bob },
    ],
  });
  await service.client.commitHand(tableId, {
    operationId: op(),
    handId: hand3,
    expectedRevision: 0,
    contributions: [
      { playerId: ALICE, amount: '2500' },
      { playerId: BOB, amount: '2500' },
    ],
    folded: [],
  });
  service.advance(300_001);
  checkConservation(service);
  const state = service.state();
  assert.equal(state.hand, null, 'the abandoned hand is cleared');
  const { totals } = service.conservation();
  assert.equal(totals.committed, '0', 'nothing stays committed after an abandoned hand');
  // The refund can land back in the seats (hand-deadline path) or as a cash-out once the
  // table lease also expires; either way every buy-in must come back to its owner.
  assert.equal(
    BigInt(totals.cashOuts) + BigInt(totals.stacks),
    BigInt(totals.buyIns),
    'every player is made whole',
  );
});

const failed = results.filter((result) => !result.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} scenarios passed`);
if (failed.length > 0) {
  console.log('Failed:', failed.map((result) => result.name).join(', '));
  process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * Headless table-bankroll scenarios for the SDK loopback service.
 *
 * Run this from your own project:
 *   npx spawn-test [--json]
 *   node node_modules/@spawndotfamily/sdk/testing/table-scenarios.mjs [--json]
 * Working inside the SDK repo itself: node testing/table-scenarios.mjs [--json]
 *
 * Every scenario asserts the platform invariant after each money step:
 *   buyIns = cashOuts + stacks + committed + pendingCashOuts
 * A failed assertion exits non-zero, so this can gate CI or a pre-publish check.
 * `--json` prints `{ title, total, passed, failed, results }` for programmatic assertion.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLoopbackTableService, TABLE_POLICY } from './loopback-table-service.mjs';
import { runFleet } from './table-fleet.mjs';
import { checkConservation, executeScenario, summarize, wantsJson } from './scenario-runner.mjs';

const json = wantsJson();
const results = [];
const op = () => randomUUID();
const ALICE = randomUUID();
const BOB = randomUUID();
const [hand1, hand2, hand3] = [randomUUID(), randomUUID(), randomUUID()];
const seatOf = (service, playerId) =>
  service.state().seats.find((seat) => seat.playerId === playerId).seatId;

/** Declare-and-run in file order through the shared runner (see scenario-runner.mjs). */
async function scenario(name, run) {
  results.push(await executeScenario(name, run, { json }));
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

await scenario('six seats conserve exactly across many hands', async () => {
  const service = createLoopbackTableService();
  const tableId = randomUUID();
  await service.client.create({ tableId, operationId: op(), maxSeats: 6 });
  const players = [];
  for (let index = 0; index < 6; index += 1) {
    const playerId = randomUUID();
    players.push({ playerId, seatId: await seatPlayer(service, tableId, playerId, String((index + 1) * 1000)) });
  }
  const roster = players.map(({ playerId, seatId }) => ({ playerId, seatId }));
  for (let hand = 0; hand < 20; hand += 1) {
    const handId = randomUUID();
    const stake = String(100 + hand * 10);
    await service.client.startHand(tableId, { operationId: op(), handId, players: roster });
    await service.client.commitHand(tableId, {
      operationId: op(),
      handId,
      expectedRevision: 0,
      contributions: players.map(({ playerId }) => ({ playerId, amount: stake })),
      folded: [],
    });
    const winner = players[hand % players.length];
    await service.client.settleHand(tableId, {
      operationId: op(),
      handId,
      expectedRevision: 1,
      pots: [{ cap: stake, winners: [{ playerId: winner.playerId, amount: String(Number(stake) * players.length) }] }],
    });
    checkConservation(service);
  }
  const { totals } = service.conservation();
  assert.equal(totals.committed, '0', 'no hand is left in flight');
  assert.equal(BigInt(totals.stacks) + BigInt(totals.cashOuts), BigInt(totals.buyIns), 'every buy-in is accounted for');
});

await scenario('a seat can leave mid-session while the rest keep playing', async () => {
  const service = createLoopbackTableService();
  const tableId = randomUUID();
  await service.client.create({ tableId, operationId: op(), maxSeats: 6 });
  const players = [];
  for (let index = 0; index < 4; index += 1) {
    const playerId = randomUUID();
    players.push({ playerId, seatId: await seatPlayer(service, tableId, playerId, '2000') });
  }
  const playHand = async (stake) => {
    const handId = randomUUID();
    await service.client.startHand(tableId, {
      operationId: op(),
      handId,
      players: players.map(({ playerId, seatId }) => ({ playerId, seatId })),
    });
    await service.client.commitHand(tableId, {
      operationId: op(),
      handId,
      expectedRevision: 0,
      contributions: players.map(({ playerId }) => ({ playerId, amount: stake })),
      folded: [],
    });
    await service.client.settleHand(tableId, {
      operationId: op(),
      handId,
      expectedRevision: 1,
      pots: [{ cap: stake, winners: [{ playerId: players[0].playerId, amount: String(Number(stake) * players.length) }] }],
    });
    checkConservation(service);
  };
  await playHand('200');
  const leaver = players.shift();
  const before = BigInt(service.conservation().totals.cashOuts);
  await service.client.cashOut(tableId, { operationId: op(), playerId: leaver.playerId, seatId: leaver.seatId });
  checkConservation(service);
  assert.equal(BigInt(service.conservation().totals.cashOuts) > before, true, 'the leaver is paid exactly once');
  await playHand('300');
  await playHand('300');
  const { totals } = service.conservation();
  assert.equal(BigInt(totals.committed), 0n);
  assert.equal(BigInt(totals.stacks) + BigInt(totals.cashOuts), BigInt(totals.buyIns), 'conservation holds after churn');
});

await scenario('a stubbed method replaces one call while the rest stay real', async () => {
  const service = createLoopbackTableService();
  const tableId = randomUUID();
  const playerId = randomUUID();
  const otherId = randomUUID();
  const stubbed = [];
  const client = service.stubClient({
    settleHand: async (tableId, input) => {
      stubbed.push(input.handId);
      throw new Error('settlement deliberately stubbed');
    },
  });
  await client.create({ tableId, operationId: op(), maxSeats: 6 });
  const seatId = await seatPlayer(service, tableId, playerId, '1000');
  const otherSeatId = await seatPlayer(service, tableId, otherId, '1000');
  const handId = randomUUID();
  await client.startHand(tableId, {
    operationId: op(), handId,
    players: [{ playerId, seatId }, { playerId: otherId, seatId: otherSeatId }],
  });
  await client.commitHand(tableId, {
    operationId: op(), handId, expectedRevision: 0,
    contributions: [{ playerId, amount: '100' }, { playerId: otherId, amount: '100' }], folded: [],
  });
  await assert.rejects(
    () => client.settleHand(tableId, { operationId: op(), handId, expectedRevision: 1, pots: [] }),
    /deliberately stubbed/,
  );
  assert.deepEqual(stubbed, [handId], 'the stub saw the settlement');
  assert.equal((await client.status(tableId)).tableId, tableId, 'the real client still answers');
  checkConservation(service);
});

await scenario('an injected clock drives the service instead of freezing at construction', async () => {
  let gameClock = 1_700_000_000_000;
  const playerId = randomUUID();
  const service = createLoopbackTableService({ now: () => gameClock });
  const tableId = randomUUID();
  const buyInId = randomUUID();
  await service.client.create({ tableId, operationId: op(), maxSeats: 2 });
  await service.client.requestBuyIn(tableId, {
    operationId: op(),
    buyInId,
    player: { playerId, launchId: randomUUID() },
    amount: '100',
  });
  assert.equal((await service.client.buyIn(tableId, buyInId)).status, 'pending');
  gameClock += TABLE_POLICY.quoteMs + 1_000; // your game clock, not a harness call
  assert.throws(
    () => service.confirmBuyIn(playerId),
    /expired/i,
    'the service must follow an injected now(): otherwise game time and service time drift',
  );
  checkConservation(service);
});

await scenario('a small fleet conserves across three tables and refuses unfunded approvals', async () => {
  // Guards the fleet driver (testing/table-fleet.mjs) in CI: 3 tables x 6 players, every phase,
  // per-table and aggregate conservation, and the opt-in balance refusal counted per table.
  const report = await runFleet({ players: 18, maxSeats: 6 });
  assert.equal(report.tables, 3, '18 players at 6 seats form three tables');
  assert.equal(report.seated, 18, 'every player is seated');
  assert.equal(report.balanced, true);
  assert.equal(report.aggregate.balanced, true);
  assert.equal(report.aggregate.cashOuts, report.aggregate.buyIns, 'every buy-in is returned exactly once');
  assert.equal(report.aggregate.backing, '0', 'nothing stays in a table');
  assert.equal(report.refusals.insufficientBalance, 3, 'one under-funded approval per table is refused');
  assert.equal(report.refusals.zeroBalance, 3, 'one zero-balance approval per table is refused');
  assert.equal(report.perTable.every((table) => table.balanced), true, 'every table conserves on its own');
  assert.equal(report.wallets.balanced, true, 'the tracked test wallets gain and lose nothing');
});

const summary = summarize(results, { json });
process.exitCode = summary.failed === 0 ? 0 : 1;

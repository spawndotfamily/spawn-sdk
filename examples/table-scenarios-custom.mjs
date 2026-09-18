#!/usr/bin/env node
/**
 * Worked example: your game's own outcome rules, run through the SDK's harness runner.
 *
 *   node examples/table-scenarios-custom.mjs [--json]
 *
 * The rules here are examples, not recommendations — the point is that you can encode YOUR
 * rules (who wins, ties, splits, when a hand voids) and get the same output, conservation
 * checks and `--json` summary the SDK's own scenarios produce. Copy this file into your game
 * and replace the rules with yours.
 *
 * Imports use the package path on purpose: this file doubles as proof that the published
 * subpaths resolve.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLoopbackTableService } from '@spawndotfamily/sdk/testing/loopback-table-service.mjs';
import { checkConservation, runScenarios, wantsJson } from '@spawndotfamily/sdk/testing/scenario-runner.mjs';

const op = () => randomUUID();

/** Seat a player the way a real one is seated: request a buy-in, then approve it. */
async function seat(service, tableId, baseUnits) {
  const playerId = randomUUID();
  const buyInId = randomUUID();
  await service.client.requestBuyIn(tableId, {
    operationId: op(),
    buyInId,
    player: { playerId, launchId: randomUUID() },
    amount: baseUnits,
  });
  await service.client.buyIn(tableId, buyInId);
  service.confirmBuyIn(playerId); // acts as the player approving in the Spawn overlay
  const { seatId } = service.state().seats.find((candidate) => candidate.playerId === playerId);
  return { playerId, seatId };
}

const summary = await runScenarios([
  {
    name: 'my rule: a tie splits the pot evenly between the contributors',
    run: async () => {
      const service = createLoopbackTableService();
      const tableId = randomUUID();
      await service.client.create({ tableId, operationId: op(), maxSeats: 2 });
      const alice = await seat(service, tableId, '10000');
      const bob = await seat(service, tableId, '10000');

      const handId = randomUUID();
      await service.client.startHand(tableId, { operationId: op(), handId, players: [alice, bob] });
      await service.client.commitHand(tableId, {
        operationId: op(),
        handId,
        expectedRevision: 0,
        contributions: [
          { playerId: alice.playerId, amount: '1000' },
          { playerId: bob.playerId, amount: '1000' },
        ],
        folded: [],
      });

      // YOUR rule: the hand is a draw, so each contributor takes their own stake back from the
      // contested tier (cap 1000 ⇒ the tier holds 2000, split between its two contributors).
      await service.client.settleHand(tableId, {
        operationId: op(),
        handId,
        expectedRevision: 1,
        pots: [
          {
            cap: '1000',
            winners: [
              { playerId: alice.playerId, amount: '1000' },
              { playerId: bob.playerId, amount: '1000' },
            ],
          },
        ],
      });

      const stacks = Object.fromEntries(service.state().seats.map((s) => [s.playerId, s.stack]));
      assert.equal(stacks[alice.playerId], '10000', 'a draw returns Alice exactly her 10000');
      assert.equal(stacks[bob.playerId], '10000', 'a draw returns Bob exactly his 10000');
      checkConservation(service);
    },
  },
  {
    name: 'the contract refuses a rake: committed base units belong to the contributors',
    run: async () => {
      // This is the trap worth knowing before you design your economy: you cannot skim a fee by
      // settling short, and a non-contributing "house" seat cannot be paid out of a pot. If your
      // game needs a fee, charge it outside the table — the table conserves every committed unit.
      const service = createLoopbackTableService();
      const tableId = randomUUID();
      await service.client.create({ tableId, operationId: op(), maxSeats: 3 });
      const alice = await seat(service, tableId, '10000');
      const bob = await seat(service, tableId, '10000');
      const house = await seat(service, tableId, '1000');

      const handId = randomUUID();
      await service.client.startHand(tableId, {
        operationId: op(),
        handId,
        players: [alice, bob, house],
      });
      await service.client.commitHand(tableId, {
        operationId: op(),
        handId,
        expectedRevision: 0,
        contributions: [
          { playerId: alice.playerId, amount: '1000' },
          { playerId: bob.playerId, amount: '1000' },
          { playerId: house.playerId, amount: '0' },
        ],
        folded: [],
      });

      const settle = (winners) =>
        service.client.settleHand(tableId, {
          operationId: op(),
          handId,
          expectedRevision: 1,
          pots: [{ cap: '1000', winners }],
        });

      await assert.rejects(
        () => settle([{ playerId: alice.playerId, amount: '1900' }]),
        /do not conserve/i,
        'a pot short of what was committed must be refused',
      );
      await assert.rejects(
        () =>
          settle([
            { playerId: alice.playerId, amount: '1900' },
            { playerId: house.playerId, amount: '100' },
          ]),
        /not eligible/i,
        'a participant who contributed nothing cannot be paid from the pot',
      );
      checkConservation(service);
    },
  },
], { json: wantsJson(), title: 'my game rules' });

process.exitCode = summary.failed === 0 ? 0 : 1;

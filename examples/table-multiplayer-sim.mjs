#!/usr/bin/env node
/**
 * Worked example: test a MULTIPLAYER table money flow with no real accounts and no second person.
 *
 *   node examples/table-multiplayer-sim.mjs [--json]
 *
 * Each player's Approve click is simulated with `service.confirmBuyIn(playerId)`, so you can drive
 * a whole table — seating, hands, side pots, cash-outs — headlessly and assert the money invariant
 * after every step. What this cannot stand in for: Spawn's real overlay and a real member account's
 * server-side authorization (one real two-account preview match stays a human step).
 *
 * THE TOKEN COMES FROM YOUR LISTING, NOT FROM HERE. A launched game uses the token the creator
 * chose in the Listing section of the game workspace; nothing in the SDK or your game code picks
 * it. The `asset` below exists only so local test maths use the same symbol/decimals as that
 * listing — never hardcode a token in game code.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLoopbackTableService } from '@spawndotfamily/sdk/testing/loopback-table-service.mjs';
import { checkConservation, runScenarios, wantsJson } from '@spawndotfamily/sdk/testing/scenario-runner.mjs';

const op = () => randomUUID();

/** Mirror the listing token's shape (symbol/decimals). Replace with YOUR listing's token. */
const LISTING_ADDRESS = `0x${'2'.repeat(40)}`;
const LISTING = {
  id: `erc20:46630:${LISTING_ADDRESS}`,
  chainId: 46630,
  address: LISTING_ADDRESS,
  name: 'Penguin token',
  symbol: 'PENGU',
  decimals: 18,
  image: '',
  source: 'spawn',
  enabled: true,
};
/** Whole tokens → base units, instead of hand-writing 18 zeros. */
const base = (whole) => (BigInt(whole) * 10n ** BigInt(LISTING.decimals)).toString();

/** Request a buy-in, then simulate that player approving it in the overlay. */
async function joinAndApprove(service, tableId, playerId, amount) {
  const buyInId = randomUUID();
  await service.client.requestBuyIn(tableId, {
    operationId: op(),
    buyInId,
    player: { playerId, launchId: randomUUID() },
    amount,
  });
  service.confirmBuyIn(playerId); // ← the Approve click, for THIS player
  return service.state().seats.find((seat) => seat.playerId === playerId).seatId;
}

const summary = await runScenarios(
  [
    {
      name: 'three players approve their own buy-ins: a short all-in takes the main pot, the bigger stack the side pot',
      run: async () => {
        const service = createLoopbackTableService({ asset: LISTING });
        const tableId = randomUUID();
        await service.client.create({ tableId, operationId: op(), maxSeats: 6 });

        const alice = randomUUID();
        const bob = randomUUID();
        const carol = randomUUID();
        const aliceSeat = await joinAndApprove(service, tableId, alice, base(100));
        const bobSeat = await joinAndApprove(service, tableId, bob, base(40));
        const carolSeat = await joinAndApprove(service, tableId, carol, base(25));
        checkConservation(service);

        const handId = randomUUID();
        await service.client.startHand(tableId, {
          operationId: op(),
          handId,
          players: [
            { playerId: alice, seatId: aliceSeat },
            { playerId: bob, seatId: bobSeat },
            { playerId: carol, seatId: carolSeat },
          ],
        });
        await service.client.commitHand(tableId, {
          operationId: op(),
          handId,
          expectedRevision: 0,
          contributions: [
            { playerId: alice, amount: base(40) },
            { playerId: bob, amount: base(40) }, // all-in
            { playerId: carol, amount: base(25) }, // short all-in
          ],
          folded: [],
        });
        checkConservation(service);

        // Main pot: all three matched 25 (cap 25 → 75), won by Carol.
        // Side pot: the 15 each from Alice and Bob above 25 (cap 40 → 30), won by Alice.
        const status = await service.client.settleHand(tableId, {
          operationId: op(),
          handId,
          expectedRevision: 1,
          pots: [
            { cap: base(25), winners: [{ playerId: carol, amount: base(75) }] },
            { cap: base(40), winners: [{ playerId: alice, amount: base(30) }] },
          ],
        });
        checkConservation(service);

        const stacks = Object.fromEntries(status.seats.map((seat) => [seat.playerId, seat.stack]));
        assert.equal(stacks[alice], base(90), 'Alice 100 − 40 committed + 30 side pot');
        assert.equal(stacks[bob], '0', 'Bob was all-in for 40 and lost');
        assert.equal(stacks[carol], base(75), 'Carol wins the main pot with the short stack');

        // Standing up returns exactly the remaining stack, once.
        await service.client.cashOut(tableId, {
          operationId: op(),
          playerId: carol,
          seatId: carolSeat,
        });
        checkConservation(service);
        const { totals } = service.conservation();
        assert.equal(totals.cashOuts, base(75), 'Carol got her 75 back out');
        assert.equal(totals.stacks, base(90), 'Alice still holds her stack on the table');
      },
    },
  ],
  { json: wantsJson(), title: 'multiplayer simulation' },
);

process.exitCode = summary.failed === 0 ? 0 : 1;

# `testing/` — automated money-flow checks for table games

Table games move tokens, and the failure modes are the ones you cannot see by
clicking around: an all-in that pays twice, a disconnect that eats a stack, a
retry that debits again, a side pot that does not conserve.

Those bugs are also invisible to a screenshot. This folder exists so a creator —
or the AI agent building on their behalf — can *run* the money paths headlessly
and get a pass/fail answer before publishing.

## What is here

| File | Purpose |
| --- | --- |
| `loopback-table-service.mjs` | A test double that speaks the platform's table contract on loopback, so the **real** SDK client and its validators drive it. |
| `table-scenarios.mjs` | Eight scripted scenarios — unequal all-ins/side pots, cash-outs, disconnect grace, reconnect, lost-response retry, abandoned-hand refund, six seats across twenty hands, and mid-session seat churn — each asserting the money invariant. |

Run it:

```sh
node testing/table-scenarios.mjs      # exits non-zero if any scenario fails
```

## Why a test double instead of the real platform

The platform's table routes require signed-in member accounts and the Spawn
approval overlay, neither of which can be scripted. The client already allows an
exact loopback origin for local testing (the chain-31337 seam documented in
`docs/table-bankroll.md`), so this service speaks the same request/response
contract on `http://127.0.0.1`. Your production code path is unchanged — the same
`createSpawnTableClient`, the same validators, the same retry semantics.

It is a **rules-free** double: it enforces accounting, not poker. Your scenario
decides who wins; the service decides whether the books balance.

## The invariant it enforces

```
buyIns = cashOuts + stacks + committed + pendingCashOuts
```

Every scenario re-checks it after each money step, and the service throws the
moment it breaks. If your game can break this, your players lose tokens — that is
the whole point of running these before launch.

## Using it in your own test suite

```js
import { createLoopbackTableService } from '@spawndotfamily/sdk/testing/loopback-table-service.mjs';

const service = createLoopbackTableService();
await service.client.create({ tableId, operationId, maxSeats: 6 });

// Request a buy-in, then act as the player approving it in the Spawn overlay.
await service.client.requestBuyIn(tableId, { operationId, buyInId, player: { playerId, launchId }, amount });
service.confirmBuyIn(playerId);

service.state(playerId);      // agent-readable: quotes, seats, stacks, totals
service.conservation();       // { balanced, totals, detail }
service.loseNextResponse('commitHand');  // exercise the uncertain-outcome path
service.advance(30_000);      // move the clock to hit grace/deadline/lease paths
```

## Stubbing one SDK call

The SDK table client is frozen on purpose, so do not mutate it — wrap it:

```js
const client = service.stubClient({
  settleHand: async () => { throw new Error('settlement offline'); },
});
// every other method still runs the real client and its validators
```

The harness is importable by package path (no relative-path or `require.resolve`
tricks): `@spawndotfamily/sdk/testing/loopback-table-service.mjs`.

## What this does NOT cover (yet)

- **The player approval overlay itself.** Confirming an amount in Spawn's real
  overlay needs real member accounts; `confirmBuyIn()` simulates that step, so the
  *final* pre-publish check on a real preview is still a human action.
- **N-player concurrency.** These scenarios are single-process. A concurrent
  driver (N virtual players over the real browser bridge + multiplayer transport)
  is the next piece.
- **`spawn-dev` table state.** The single-player dev state hook does not yet
  expose tables; today `service.state()` is the agent-readable surface.

## Before you publish a table game

1. `node testing/table-scenarios.mjs` is green.
2. You have a scenario for **your** game's outcome rules, not just the defaults
   here (who wins, when the hand voids, what a tie does).
3. Every player who can be disconnected, idle or crash-recovered still gets their
   stack back exactly once.
4. You have run one real two-account preview match — the automated layer proves
   accounting, not gameplay.
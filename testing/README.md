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
| `table-scenarios.mjs` | Ten scripted scenarios — unequal all-ins/side pots, cash-outs, disconnect grace, reconnect, lost-response retry, abandoned-hand refund, six seats across twenty hands, mid-session seat churn, a stubbed client method, and an injected clock — each asserting the money invariant. Shipped as the `spawn-test` command. |

Run it (from your own project — the paths below are consumer paths):

```sh
npx spawn-test                        # exits non-zero if any scenario fails
npx spawn-test --json                 # machine-readable summary
node node_modules/@spawndotfamily/sdk/testing/table-scenarios.mjs   # same thing, no npx
```

Working inside the SDK repo itself, run `node testing/table-scenarios.mjs` instead.

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
service.conservation();       // { balanced, totals, delta, detail }
service.loseNextResponse('commitHand');  // exercise the uncertain-outcome path
service.advance(30_000);      // move the clock to hit grace/deadline/lease paths
```

Run the SDK's own scenarios against your install (your project has no `test:tables` script — this
is the consumer command):

```bash
npx spawn-test            # 10 scenarios, exits non-zero on failure
npx spawn-test --json     # { title, total, passed, failed, results } for agents
# same thing without npx: node node_modules/@spawndotfamily/sdk/testing/table-scenarios.mjs
```

### Amounts and the fake asset

Amounts are **integer base-unit strings**, never decimals: `'100'` is 100 base units, which is
`1.00` of the default fake asset (`LOCAL`, `decimals: 2`, chain 46630). A real Listing token uses
its own decimals, so `'100000000000000000000'` is 100 tokens at 18 decimals — always format and
parse through the SDK helpers rather than dividing by hand, and pass the same shape your game
uses. Override it with `createLoopbackTableService({ asset: { ... } })`.

### Clock

The service reads `now` **live on every call**, so injecting your own test clock keeps game time
and service time in sync: `createLoopbackTableService({ now: () => myGameClock })`. Only
`advance(ms)` moves the synthetic offset (then runs the recovery sweep) and it layers on top of
whatever `now` reports. Deadlines are stored once (`leaseExpiresAt`, quote `expiresAt`) —
advancing time does not move them, it makes them *expired*.

### Harness reference

| Member | What it does |
| --- | --- |
| `client` | The **real** SDK table client wired to the loopback service — call the same methods your game calls. |
| `state(playerId?)` | Snapshot: `tableId, projectId, status, asset, settingsVersion, maxSeats, revision, leaseExpiresAt, maxEndsAt, seats[], hand, totals`, plus `quotes[]` and `pendingQuote`. |
| `conservation()` | `{ balanced, totals, delta, detail }` — `detail` states the imbalance, so a failure message tells you the delta instead of just "not equal". |
| `confirmBuyIn(playerId)` | Simulates that player's Approve click in the Spawn overlay — call it per player to run a whole multiplayer flow headlessly (see "Simulating approvals for N players"). |
| `reconnect(playerId)` | Clears the disconnect deadline, as a returning player would. |
| `loseNextResponse(action)` | The next call to `action` **applies and records** the mutation, then throws. Retrying with the same `operationId` replays the recorded result instead of applying twice — that is how you prove idempotency, not just an error path. |
| `advance(ms)` | Move time forward, then run the recovery sweep (quote expiry, disconnect grace, lease expiry, hand deadline). |
| `stubClient(overrides)` | Replace one client method; the rest keep delegating to the real frozen client. Own-property lookup per call, so mutating `overrides` mid-test applies. |
| `asset`, `projectId`, `calls` | The fake asset, the project id, and every call the service received. |
| `TABLE_POLICY` | `quoteMs` 120s, `leaseMs` 90s, `disconnectGraceMs` 30s, `handDeadlineMs` 300s, `maxAgeMs` 24h. |

### Simulating approvals for N players

You do not need real accounts (or a second person) to test a multiplayer money flow. Each player's
Approve click is simulated by calling `confirmBuyIn(playerId)` for that player — do it for as many
players as your game seats, and the whole flow runs headlessly:

```js
// Three players, each approving their own buy-in, exactly as the overlay would.
for (const { playerId, amount } of [
  { playerId: alice, amount: '10000' },
  { playerId: bob, amount: '4000' },
  { playerId: carol, amount: '2500' },
]) {
  const buyInId = randomUUID();
  await service.client.requestBuyIn(tableId, {
    operationId: randomUUID(), buyInId, player: { playerId, launchId: randomUUID() }, amount,
  });
  service.confirmBuyIn(playerId);   // the Approve click
}
// then play hands, cash out, disconnect players — assert conservation after every step
```

A full worked version (unequal stacks, a side pot, a cash-out) is in
`examples/table-multiplayer-sim.mjs`, and the shipped six-seat scenario uses the same loop.

**What this still cannot simulate**, and why one real check remains: the overlay itself is Spawn's
UI, and a *real* approval is authorized server-side against a real signed-in member account. So the
simulated approvals prove your game's logic and the money accounting against the platform's real
contract; they cannot prove the platform's own overlay. That is why one two-account preview match
stays a human step before publishing a table game.

### Adding your own outcome rules

Port your game's rules (who wins, rake, blinds, ties, voids) through the shipped runner so your
output, conservation checks and `--json` summary match ours exactly:

```js
import { runScenarios, checkConservation } from '@spawndotfamily/sdk/testing/scenario-runner.mjs';

const summary = await runScenarios([
  { name: 'house takes a 5% rake', async () => { /* ... assert ... */ } },
], { json: true });
process.exitCode = summary.failed === 0 ? 0 : 1;
```

TypeScript declarations ship with the package (`testing/*.d.mts`), so editors and AI agents get
the whole surface. A complete worked example is in `examples/table-scenarios-custom.mjs`.

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

### What this does NOT cover (yet)

- **The real approval overlay and a real account's authorization.** `confirmBuyIn(playerId)`
  simulates the Approve click for any number of players, which covers your game's logic and the
  money accounting; the platform's own overlay UI and a *real* member account's server-side
  authorization are what it cannot stand in for, so one real two-account preview match remains a
  human step.
- **True concurrency.** The N-player scenarios (six seats across twenty hands, seat churn) run
  sequentially in one process. A driver running N virtual players *concurrently* over the real
  browser bridge and multiplayer transport is not shipped — it only matters if you run your own
  game server.
- **`spawn-dev` table state.** The single-player dev state hook does not yet
  expose tables; today `service.state()` is the agent-readable surface.
- **A rake or fee out of the pot.** The contract conserves every committed base unit to the
  players who contributed to that pot: settling short is refused (`Pot amounts do not conserve`)
  and a participant who contributed nothing cannot be paid (`Winner is not eligible for this
  pot`). Charge fees outside the table. `examples/table-scenarios-custom.mjs` asserts both
  refusals so you can see the exact behaviour before designing your economy.

## Before you publish a table game

1. `npx spawn-test` is green (add `--json` to assert the summary in CI).
2. You have a scenario for **your** game's outcome rules, not just the defaults
   here (who wins, when the hand voids, what a tie does).
3. Every player who can be disconnected, idle or crash-recovered still gets their
   stack back exactly once.
4. You have run one real two-account preview match — the automated layer proves
   accounting, not gameplay.
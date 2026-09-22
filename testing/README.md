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
| `table-scenarios.mjs` | Eleven scripted scenarios — unequal all-ins/side pots, cash-outs, disconnect grace, reconnect, lost-response retry, abandoned-hand refund, six seats across twenty hands, mid-session seat churn, a stubbed client method, an injected clock, and a small fleet guard — each asserting the money invariant. Shipped as the `spawn-test` command. |
| `local-host.mjs` | Actual Spawn approval UI and ledger/API bundle on loopback; synthetic player capabilities, signed multiplayer admission and durable test state. See the local approval guide. |
| `table-fleet.mjs` | A fleet driver: N simulated players across M tables (one service per table, up to six seats each), every phase run headlessly, conservation asserted per table and in aggregate, refused approvals counted. Library `runFleet()` plus a CLI. |

Run it (from your own project — the paths below are consumer paths):

```sh
npx spawn-test                        # exits non-zero if any scenario fails
npx spawn-test --json                 # machine-readable summary
node node_modules/@spawndotfamily/sdk/testing/table-scenarios.mjs   # same thing, no npx
```

Working inside the SDK repo itself, run `node testing/table-scenarios.mjs` instead.

## Why a test double instead of the real platform

Use the fast double for focused game-rule scenarios without a browser. For the actual
approval UI and production ledger routes, use [spawn-test-host](../docs/local-approval-testing.md):
its synthetic players can be driven by browser automation. Both layers connect the
public SDK clients to an exact loopback origin; neither uses real accounts or tokens.
The double implements the protocol independently, while the host bundles platform source.

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
npx spawn-test            # 11 scenarios, exits non-zero on failure
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
| `balance(playerId)` | The opt-in tracked test balance for that player, or `null` when untracked — debited on approval, credited on cash-out (see "Testing at scale (fleet driver)"). |
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

**Test the actual approval UI too.** The fast doubles below model decisions and money.
Use [the local approval host](../docs/local-approval-testing.md) to run Spawn's actual
approval components, production ledger and API handlers with synthetic accounts,
including browser automation and your real multiplayer bridge. No hosted login or
second person is required. Hosted account/credential setup, the uploaded build and
network behavior still need a private-preview check; local success is not a guarantee
of production success.

### Testing at scale (fleet driver)

One table proves the accounting; a hundred players prove the flow. `table-fleet.mjs` drives a fleet
of simulated players across as many tables as you want — each table its own
`createLoopbackTableService()`, up to six seats each — through every phase headlessly:

```
seat -> approve -> play hands -> cash out some players -> disconnect/reconnect -> settle all
```

```sh
node testing/table-fleet.mjs --players 100          # exits non-zero on any imbalance
node testing/table-fleet.mjs --players 100 --json   # machine-readable report (per-table + aggregate)
node testing/table-fleet.mjs --help                 # seats, hands, buy-in, stake, table count
# in your own project: node node_modules/@spawndotfamily/sdk/testing/table-fleet.mjs --players 100
```

```js
import { runFleet } from '@spawndotfamily/sdk/testing/table-fleet.mjs';

const report = await runFleet({ players: 100 });   // 100 players across 17 tables
report.aggregate.balanced;                          // per-table AND aggregate invariant
report.refusals;                                    // { insufficientBalance, zeroBalance, total }
```

A 100-player run is a few hundred in-process SDK calls and finishes in well under a second.

**Fake accounts need fake balances — and the refusal must be real.** A real approval fails when
the player cannot cover the quote, so the harness models it: pass per-player test balances and the
approval click refuses an unfunded player exactly there, leaving the quote pending and the wallet
untouched.

```js
const service = createLoopbackTableService({ balances: { [alice]: '1000', [bob]: '0' } });
// alice approves a 1000 buy-in (wallet lands on 0); bob's approval throws:
// "Insufficient balance for this buy-in: the player holds 0 base units, the quote needs 1000."
service.balance(alice);   // '1000' before approval, '0' after, credited again on cash-out
```

Tracked wallets are debited on approval and credited on cash-out; a player not listed in `balances`
is untracked, and without the option nothing is checked or tracked — existing scenarios behave
exactly as before. The fleet funds every seat, gives the first seat of each table exactly the
buy-in (the inclusive boundary of the check), drives one under-funded and one zero-balance approval
per table, and counts both refusals in the report.

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

### Boundaries of the fast double

- **The real approval overlay.** The fast double's `confirmBuyIn` simulates a decision.
  Use [spawn-test-host](../docs/local-approval-testing.md) and browser automation for the
  actual Spawn screen, production ledger and isolated SDK bridge. Real hosted accounts
  and deployment configuration still need a private-preview acceptance check.
- **Concurrent browser sessions.** The fast fleet runs sequentially in one process.
  The local approval host supports independent player URLs and concurrent browser
  sessions; connect your actual game server to test its transport and concurrency.
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
4. Your game passes local browser approval and multiplayer checks using `spawn-test-host`.
5. You have checked the deployed build and account/server configuration in a private
   preview, and reported those results separately from local tests.
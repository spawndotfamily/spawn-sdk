# Persistent Listing-token tables

SDK 0.9.0 adds a server client and Spawn-owned browser bridge for persistent 2–6 player tables funded with the Listing token. A table has its own durable escrow and operation journal. The game server decides game outcomes, while Spawn checks authorization, seat generations, deadlines and conservation.

This is a testnet service. The current hosted contract is Robinhood Chain Testnet, chain ID `46630`; chain ID `31337` is accepted only by an exact loopback test service. No mainnet, live-money, cash redemption or creator funded house bankroll is enabled.

## Creator setup

Use the normal creator self-service flow described in [server setup](server-setup.md). Download a fresh credential with `server:configure`, configure an admitted Listing token, and run `spawn-publish server status` followed by `spawn-publish server enable` with the creator's approved server origin, WebSocket path, audience, current version and `--creator-confirmation`. The existing dedicated `match.key` is the game-scoped server credential for both match and table APIs. Existing status and setup metadata may still say `matchesEnabled`; that field covers the table service too. There is no `tablesEnabled` field and no new VPS activation step.

Install `match.key` and the public `verification.json` only on the creator's authorized game server. The SDK does not deploy a server, grant OS or VPS access, or create a replacement credential. Final deployment requires the matching Spawn 0.9 table service; installing this package alone cannot add the platform routes or ledger.

Keep the key out of browser bundles, game saves, logs and chat. A dedicated key authorizes the game's scoped table operations; it does not approve a player's buy-in or make a browser result authoritative. Players still confirm every buy-in through Spawn.

## Server client

Import the server entry point only in the authoritative creator server:

```js
import { createSpawnTableClient } from '@spawndotfamily/sdk/server';

const tables = createSpawnTableClient({
  platformOrigin: 'https://spawn.family',
  projectId: process.env.SPAWN_PROJECT_ID,
  credential: process.env.SPAWN_MATCH_KEY,
});
```

The server methods are `create`, `status`, `operation`, `requestBuyIn`, `buyIn`, `startHand`, `commitHand`, `settleHand`, `cashOut`, `disconnect`, `heartbeat` and `close`. All table and operation IDs are UUIDs. Every amount in a server table request or response is a canonical unsigned integer string in token BASE UNITS, from `"0"` through `2^256 - 1`; never send a decimal display amount, float or JavaScript `Number`.

`requestBuyIn(tableId, input)` creates a pending quote and does not debit a wallet. The input is `{ operationId, buyInId, player: { playerId, launchId }, amount }`. Each separate buy-in uses a new `buyInId` and a new operation ID. `buyIn(tableId, buyInId)` reads the quote and its immutable non-null asset snapshot.

Build this player identity from your verified Spawn multiplayer admission: the verified grant's `playerId` is `playerId`, and its `sessionId` is the table API's `launchId`. Never take either from an unverified socket message. After the browser completes its Spawn approval, read `buyIn` and `status` on your server before seating the player; a browser-reported success is not server proof.

The hand methods use the exact server payloads below:

| Method | Payload | Result |
| --- | --- | --- |
| `create` | `{ tableId, operationId, maxSeats }` | Public table status |
| `startHand` | `{ operationId, handId, players: [{ playerId, seatId }] }` | Public table status |
| `commitHand` | `{ operationId, handId, expectedRevision, contributions: [{ playerId, amount }], folded: [playerId] }` | Public table status |
| `settleHand` | `{ operationId, handId, expectedRevision, pots: [{ cap, winners: [{ playerId, amount }] }] }` | Public table status |
| `cashOut` | `{ operationId, playerId, seatId }` | Public table status |
| `disconnect` | `{ operationId, playerId, seatId }` | Public table status |
| `close` | `{ operationId }` | Closure status |

`expectedRevision` is the running hand's `hand.revision`. Table membership, heartbeat and exit changes can advance `table.revision` independently. A `seatId` is a UUID seat generation. A re-seat gets a new generation, while a top-up between hands keeps the existing seat; delayed cash-out, disconnect and hand messages therefore cannot affect a later seat incarnation.

`commitHand` contributions are **additional** amounts for that call, not cumulative totals: committing `"2"` and then `"3"` makes that player's contribution `"5"`. Use a new journaled operation ID for a new action and the same ID/body only when reconciling that action. Contributions cannot exceed the seat's remaining stack; folding is permanent within the hand. `settleHand` names only the conserved pot payouts, not arbitrary final wallet balances. Read the returned hand revision after each mutation.

The server preserves operation results durably. Reusing an operation ID with a different body is rejected. The client never retries a mutation implicitly. A transport timeout, 408 or 5xx on a mutation raises `SpawnTableRequestError` with `outcomeUnknown: true`; query the same table and operation ID before doing anything else. A status 404 after an uncertain request is not proof that the old request cannot still arrive.

## Public status and money accounting

A public table status contains the immutable table asset/settings snapshot, `revision`, `leaseExpiresAt`, `maxEndsAt`, public seats, the current hand and:

```js
{
  buyIns,
  cashOuts,
  stacks,
  committed,
  pendingCashOuts,
  backing,
}
```

Spawn enforces `buyIns = cashOuts + stacks + committed + pendingCashOuts` and `backing = stacks + committed + pendingCashOuts`. Each seat includes `{ seatId, playerId, stack, pendingCashOut, status, connectedUntil, disconnectDeadline }`. Public results do not include account user IDs, sessions or credentials.

An absent table closed by `close` is permanently fenced and returns the tombstone shape `status: "closed"`, `asset: null`, `settingsVersion: 0`, `maxSeats: 0` and `leaseExpiresAt: null`. A funded closed table retains its original non-null asset snapshot. Never interpret a tombstone as a funded balance.

Settlements operate on the server's contribution snapshot. Side pots use cumulative BASE UNIT caps and list only eligible non-folded players; a tier with one contributor is returned as an uncalled amount. The game server supplies winners, but it cannot change the table's conserved total. A browser score or claimed winner is not payment authority.

## Player browser flow

Use `createSpawnGameClient` or `createSpawnMultiplayerClient` in the browser. The game calls:

```js
const receipt = await spawn.tables.buyIn({ tableId, buyInId });
if (receipt.status === 'confirmed') {
  const stop = spawn.tables.watch(tableId);
  // Keep `stop` and call it when the game socket disconnects.
}
```

`tables.buyIn` opens Spawn's shared approval UI. It returns only `{ tableId, buyInId, status: 'confirmed' | 'cancelled' }` after Spawn has proof from the player route. The game cannot supply an amount, token, contract, recipient or approval. The host UI shows the exact quote and the server-controlled result; there is no per-hand approval popup.

`tables.status(tableId)` and `tables.heartbeat(tableId)` return the authenticated player's view:

```js
{
  tableId, projectId, playerId, seatId, seat, seatStatus,
  stack, pendingCashOut, publicTableState,
}
```

`seatStatus` is `active`, `leaving`, `cashed_out` or `null`. After cash-out, `seat` is `null`, `stack` and `pendingCashOut` are `"0"`, and `seatId` retains the cashed-out UUID. A live seat's nested `seatId`, stack and pending amount must match the authenticated fields. Call `tables.leave({ tableId, operationId, seatId })` for the player's deliberate cash-out; the operation ID is durable and the seat ID fences delayed exits. A lost browser stops renewing its player heartbeat naturally. The game can call server `disconnect` when its socket drops, using the current player and seat UUID.

`tables.watch(tableId)` sends a heartbeat immediately and then every 20 seconds. It returns a stop function and stops its own loop after a failed heartbeat. Dispose the client on page teardown. A watch is a lifecycle heartbeat, not a retry of a prior mutation and not proof of a buy-in or game outcome.

Status and leave remain recovery operations if the original launch expires or the publication is suspended. Spawn still requires a live signed-in account/session, a known same-account launch for this game, and that account's table membership. A renewed login may use its original launch to recover its own seat. If routine launch cleanup removed that launch, its confirmed buy-in preserves the same-account proof for recovery. This exception grants no new buy-in, quote confirmation or heartbeat authority; those still require active game access. Server lease expiry also returns backed stacks without an online player.

The multiplayer bridge uses an opaque authenticated host and these exact message names:

```js
// request
{
  type: 'spawn:multiplayer-table-request', version, nonce,
  requestId, method: 'tables.buyIn' | 'tables.status' | 'tables.heartbeat' | 'tables.leave',
  payload,
}

// response
{ type: 'spawn:multiplayer-table-result', requestId, value }
// or
{ type: 'spawn:multiplayer-table-error', requestId, message }
```

The isolated game bridge uses the same `tables.*` method names through its authenticated Spawn host. The game must not forge a confirmed result or treat a bridge timeout as a cancellation.

## Durable recovery

Persist the exact monetary intent before calling a mutating method. The journal must write the table ID, operation ID, action, seat generation and exact BASE UNIT request atomically, flush the file, rename it and flush its directory, or use an equivalent SQLite transaction. An in-memory `Map` is not restart recovery. Keep resolved operation records and closed table fences; do not delete them as quota cleanup.

The packaged [table-bankroll example](../examples/table-bankroll.mjs) implements this ordering and exports wrappers for create, buy-in request, hand lifecycle, cash-out and disconnect. Run its no-network smoke path with:

```sh
node examples/table-bankroll.mjs --help
```

On restart, read the saved status and the unfinished hand's `hand.revision`, contributions and folded players. Resume with that hand snapshot and the same expected revision; do not invent a winner. For each pending intent, query `operation(tableId, operationId)` and `status(tableId)`. If operation lookup returns 404 or transport fails, retain the record as unresolved. Do not generate a new ID or blindly retry. If the creator's recovery policy permits another attempt, replay the exact saved request body with the same operation ID only after those reads; `replaySavedMutation` in the example does this without changing IDs or amounts. After an explicit creator decision, `closeSavedTable` in the example closes the original table ID with a new, journaled close operation; the resulting closed status is the proof before any replacement table is considered.

A table lease lasts 90 seconds, a disconnect grace period lasts 30 seconds and the maximum table age is 24 hours. Hand deadlines are fixed at 300 seconds and are not extended by heartbeats. On deadline or service recovery, Spawn refunds unfinished commitments and cashes out remaining stacks according to its durable policy; that policy does not invent a game result. A wallet or asset outage can leave a cash-out pending while its amount remains included in `pendingCashOuts` and `backing`; reconcile after the service recovers. Offline cash-out is a request to Spawn, not a client-side balance change.

Your server must call `tables.heartbeat(tableId)` about every 30 seconds while it operates the table; browser `watch` renews only the player's connection, not this server lease. Stop accepting new hands during uncertain recovery. New arrivals may buy in during a hand but are absent from its fixed roster and join a later hand; a participating player's top-up must wait until between hands. Leaving participants remain in the current hand and receive their resulting remaining stack after settlement, or the documented refund if that hand cannot finish.

Server fairness remains the creator's responsibility. Spawn can enforce conserved funds, roster/seat scope, consent and durable idempotency, but it cannot determine whether a poker hand, wager, random seed or claimed result was honest. Keep the game authority on the creator server and never pay a browser-reported win.

## Test before launch

Do not ship a table game on a green build alone — shipment should require that you have *run* the money paths. `testing/` in this package contains a loopback table service plus scripted scenarios (unequal all-ins and side pots, cash-outs, disconnect grace, reconnect, lost-response retry, abandoned-hand refund). They drive this package's real client and validators headlessly, and every step asserts:

```
buyIns = cashOuts + stacks + committed + pendingCashOuts
```

```sh
npx spawn-test    # 11 scenarios, exits non-zero on any failure
```

Add your own scenario for your outcome rules (who wins, when a hand voids, what a tie does) — the shipped scenarios check accounting, not your game's fairness; `@spawndotfamily/sdk/testing/scenario-runner.mjs` runs them through the same runner, and `examples/table-scenarios-custom.mjs` is a worked example. For scale, `testing/table-fleet.mjs` seats a fleet of players across many tables and asserts conservation per table and in aggregate (`node node_modules/@spawndotfamily/sdk/testing/table-fleet.mjs --players 100`); with the harness's opt-in test balances, an approval a player cannot fund is refused at the click, exactly as the real overlay refuses it. These fast doubles simulate approval decisions. To test the actual Spawn overlay, production ledger and API handlers, use [the local approval host](local-approval-testing.md) with synthetic players and browser automation. Hosted account/configuration checks still belong in a private preview.

**Economy note — no fee can come out of a pot.** Committed table funds belong to the players who contributed them: settling a pot short of what was committed is refused (`Pot amounts do not conserve`), and a non-contributing participant cannot be paid (`Winner is not eligible for this pot`). Design your economy so any creator or house fee is charged outside the table, not skimmed from settlements.

**Testing multiplayer without a second person.** Each player's Approve click is simulated with `confirmBuyIn(playerId)`, so you can seat and play with as many players as your game allows, headlessly — `examples/table-multiplayer-sim.mjs` is a worked three-player flow with a short all-in, a side pot and a cash-out. For visible approval tests, `spawn-test-host` runs the actual Spawn components locally; automation can click Approve or Cancel for each synthetic player. A hosted two-account check still verifies deployed credentials, identity and connectivity.

**The token is your Listing's — never the SDK's.** A launched table uses the token the creator selected in the **Listing** section of the game workspace. The SDK and your game code never choose, store or configure it, so do not hardcode a token or a contract address in the game; pass the listing token's symbol and decimals to the test harness only so local test maths match it exactly.

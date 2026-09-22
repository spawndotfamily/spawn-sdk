# Payouts: reward loops and deposit redemption

This SDK release adds a server-only payout route for a registered game: the creator's authoritative server pays a member out of the **game's pool balance** with the game's dedicated match credential. Two shapes of the same call:

- **Reward loops** — the pool funds a prize to any registered member of the game (a tournament win, a quest reward, a manual grant your server decides).
- **Deposit/redemption vaults** — a member's already-paid deposit can be redeemed back to that same member, capped by that deposit and never paying twice.

The recipient is resolved server-side from the member ID you send; the browser never supplies a recipient, an amount, a token or a contract. Spawn enforces authorization, the pool balance, the deposit cap and durable idempotency; **your server still decides who is paid and why**. A browser-reported win is not payment authority.

This is testnet-only settlement, like matches and tables. There is no mainnet or redeemable-money payout.

## Before you start

- The game's dedicated `match.key` and the ordinary [creator server setup](server-setup.md) — payouts use the same credential as the match and table clients. No new key, no rotation and no new activation step.
- An admitted Listing token configured for the game. With no Listing token configured, every payout is refused (409).
- A durable record of each intended payout **before** its network call, exactly as for matches and tables: the operation ID is what makes a retry safe. An in-memory `Map` is not restart recovery.

## The client

```js
import { createSpawnPayoutClient } from '@spawndotfamily/sdk/server';

const payouts = createSpawnPayoutClient({
  platformOrigin: 'https://spawn.family',
  projectId: process.env.SPAWN_PROJECT_ID,
  credential: process.env.SPAWN_MATCH_KEY, // the dedicated match server key
});

const receipt = await payouts.create({
  operationId,                                  // uuid: the single idempotency key
  playerId: member.playerId,                    // the member being paid
  amount: '250',                                // base units, as a string
  depositId: deposit.depositId,                 // optional: cap this payout at that paid deposit
  reason: 'vault redemption',                   // optional, at most 160 characters
});

const recorded = await payouts.operation(operationId); // the receipt, or null
```

| `create` field | Required | Meaning |
| --- | --- | --- |
| `operationId` | yes | UUID idempotency key for this one payout. |
| `playerId` | yes | The Spawn member who receives it; resolved to a recipient server-side. |
| `launchId` | no | A verified launch's `sessionId`; makes the payout follow that strict active-launch chain. |
| `amount` | yes | **Base-unit integer string** — `"250"`, never `"2.5"` and never a `Number`. |
| `depositId` | no | A paid deposit this payout redeems against; caps it at that deposit. |
| `reason` | no | Short human-readable label, at most 160 characters. |

`create` returns the platform's receipt — the durable proof of payment:

```js
{
  id, projectId, playerId, assetId,
  amount, depositId, status: 'paid', createdAt,
}
```

`depositId` is `null` when the payout did not reference one, and the exact reference you sent otherwise. **Amounts here are base units**, unlike match entries, which use human-readable decimal strings: `"250"` at 18 decimals means `0.00000000000000025` tokens. Format through the Listing token's `decimals` and keep every value a string or `BigInt`.

## Idempotency and uncertain results

`operationId` is the single idempotency key. An identical retry — same ID, same body — returns the **same receipt** and moves money exactly once. Reusing an operation ID with a changed payload is rejected (409), so one operation ID belongs to exactly one payout intent.

The client never retries a mutation implicitly. A transport failure, a 408 or a 5xx on `create` raises `SpawnPayoutRequestError` with `outcomeUnknown: true`: the payout may or may not have been recorded. Reconcile before anything else:

```js
try {
  receipt = await payouts.create(intent);        // intent was journaled first
} catch (error) {
  if (error.outcomeUnknown) {
    const recorded = await payouts.operation(intent.operationId);
    if (recorded) receipt = recorded;            // it happened; keep this receipt
    // recorded === null means it was not recorded: replaying the exact same body
    // with the same operation ID is then safe, and pays at most once.
  } else {
    // a known rejection (400/401/403/404/409/429): fix the cause; do not pay again
  }
}
```

Never generate a new operation ID to "retry" an uncertain payout, and never pay the same intent twice. If the reconcile read itself fails, keep the intent unresolved and retry the read; a failed read is not proof of anything. The same rule as matches and tables applies: persist the intent, keep resolved records, and reconcile the original ID.

## The two recipient modes

- **With `launchId`** — the payout must match that member's strict active-launch chain. Use the `sessionId` of a launch your server verified through `createSpawnLaunchVerifier`; a stale or foreign launch is refused (401). Use this when the payout is tied to a live session.
- **Without `launchId`** — any registered member of this game can be paid, at any time. This is the redemption-vault mode: a member can redeem later, after their launch has expired.

Never accept a player ID from a URL, browser storage or a socket message — derive it from verified admission on your server. The browser cannot call this route at all: `createSpawnPayoutClient` throws when it is constructed in a browser context, and a request that carries a browser `Origin` header is refused (403). Keep the match key on the server.

## Caps and errors

| Bound | Behavior |
| --- | --- |
| The game's pool balance | A payout above the pool is refused (409). The pool is credited by paid deposits; nothing is minted. |
| 60 payout writes per minute per game | Refused with 429; `retryAfterMs` states the wait. |
| A referenced deposit | The payout may not exceed that paid deposit summed across prior payouts against it, and the deposit must belong to the same member, game and asset (409). |

Errors throw `SpawnPayoutRequestError` (exported from `/server`) with `status`, `code`, `outcomeUnknown`, `operationId`, optional `reason`, `requestId` and `retryAfterMs`:

- `400 HTTP_REJECTED` — malformed request: a non-canonical or zero `amount`, a bad UUID, an over-long reason. Fix and resend; nothing moved.
- `401 HTTP_UNAUTHORIZED` — the credential is wrong or revoked, or the recipient is not a member (or launch chain) of this game. Check the key and the member; never substitute another identity.
- `403 HTTP_FORBIDDEN` — the request carried a browser origin. Call this route only from your authoritative server.
- `404 HTTP_NOT_FOUND` — the project or hosted route is unknown. Check server setup and the platform release; do not invent an endpoint.
- `409 HTTP_CONFLICT` — a changed payload under a used operation ID, an overdraft, a deposit that is not paid / belongs to another member / is already fully redeemed, or no Listing token configured. Reconcile the operation ID and the game's configuration.
- `429 HTTP_RATE_LIMITED` — respect `retryAfterMs`; coalesce writes.
- `503 HTTP_UNAVAILABLE` — suspended or removed game, custody outage or a frozen asset. Report it; do not retry in a loop or switch currency.

A rejected payout never moves money. Only `status: 'paid'` on a receipt is proof of payment.

## Test the loop locally

`testing/loopback-payout-service.mjs` in this package is a headless double: it speaks the platform's payout contract on loopback, so the **real** SDK client and its validators drive it, and it enforces the documented invariants (`pool + members` never changes; a deposit is never over-redeemed; one operation ID pays once). A creator's agent can prove the whole loop before launch:

```js
import { randomUUID } from 'node:crypto';
import { createLoopbackPayoutService } from '@spawndotfamily/sdk/testing/loopback-payout-service.mjs';

const member = randomUUID();
const service = createLoopbackPayoutService({ members: { [member]: '1000' } });

// 1. Simulate the member's already-paid deposit: the member is debited, the pool credited.
const deposit = service.deposit(member, '250');

// 2. The creator's claim: pay the member from the pool, against their own deposit.
const operationId = randomUUID();
const receipt = await service.client.create({
  operationId, playerId: member, amount: '250', depositId: deposit.depositId,
});

// 3. The redemption moved exactly the claimed amount, once.
service.balance(member);              // '1000' — credited exactly 250
service.pool();                       // '0'    — debited exactly 250
service.conservation();               // { balanced: true, delta: '0', detail: 'pool=0 + members=1000 = 1000 (unchanged from 1000)' }
await service.client.operation(operationId); // the recorded receipt
```

The double refuses what the platform refuses — overdrafts, non-members, a payout above its deposit, a changed payload under a used operation ID, the 60-per-minute write bound, and a suspended game (`suspend()` / `resume()`) — and `loseNextResponse('create')` makes the next call apply and record, then throw, so you can prove a lost-response retry pays once. `service.state()`, `service.balance(playerId)`, `service.pool()` and `service.conservation()` are the agent-readable surface; declarations ship in `loopback-payout-service.d.mts`.

What it cannot stand in for: the platform's real custody and Listing token, real member accounts and the real credential. Simulated deposits and members prove your integration and the money accounting against the platform's contract; run one real deposit → redemption on a private preview before launch.

## What this is not

- Not a browser API. The client refuses to construct in a browser and the route refuses browser origins; there is no browser payout method in this SDK.
- Not a way to pay a browser-reported score or win, and not an approval for a player. Your server decides the payout; the member's identity comes from verified admission.
- Not a generic transfer API. Direct player-to-player transfers are [trades](trades.md); player-funded matches are [match payments](match-payments.md).

## Local approval testing

Use [spawn-test-host](local-approval-testing.md) to exercise the actual Spawn approval components and ledger routes with synthetic players on your own computer. The public server clients connect using the exported local configuration. Browser automation can approve or cancel; no hosted account or real funds are needed. Verify authoritative receipts and balances after interrupted responses, then test the exact uploaded build and hosted setup in a private preview.

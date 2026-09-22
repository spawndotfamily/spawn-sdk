# Verified multiplayer token purchases

Use SDK 0.12.0 or newer for the server lookup client. Hosted verification also requires the matching Spawn platform route; keep item delivery blocked when that route is unavailable.

`requestTokenPayment` is a Spawn-owned confirmation flow. It is useful for a multiplayer game that wants to sell an item, but the browser result is only a hint for the game's authoritative server. The server must bind the purchase to a verified player and launch, compare it with the game's own catalog, and issue the item in its own database.

This flow verifies a paid purchase. It does not validate a score, create rewards, or provide anti-cheat protection. A player can modify browser code, so a client receipt, a Continue click, a local flag and a game-supplied player ID are never item-delivery authority.

The method is available on both `createSpawnMultiplayerClient` and `createSpawnGameClient`. Initialize multiplayer admission as described in [multiplayer](multiplayer.md), then call it only after the player chooses to buy. `amount` is a positive exact decimal string in whole tokens; `item` is a trimmed label of at most 80 characters. Spawn chooses the game's Listing token and displays its amount, network and contract before the player confirms. Guests cannot pay. No token address, recipient or approval flag belongs in the game request. For a server-backed shop, supply the saved UUID `requestId` below.

## Save the order before opening the overlay

The server creates a UUID order ID and stores the complete tuple before asking the browser to open Spawn's overlay:

```ts
type PurchaseOrder = {
  requestId: string; // server-generated durable order ID
  playerId: string;  // from createSpawnLaunchVerifier, never from the browser
  launchId: string;  // the original verified launch
  item: string;
  amount: string;    // canonical base-unit amount from the local catalog
  assetId: string;   // exact Listing asset selected by the server
};
```

Pass the saved `requestId`, catalog amount and catalog item to the multiplayer browser client:

```js
await spawn.requestTokenPayment({
  amount: catalog.amountHuman,
  item: catalog.item,
  requestId: order.requestId,
});
```

The browser resolves after the player completes Continue. It may time out or close after Spawn has recorded the payment. Keep `playerId`, `launchId` and `requestId` from the original order and use them for recovery; a new browser launch is not a replacement identity.

## Look up the original payment

The server-only entry point uses the same `platformOrigin`, `projectId`, dedicated `match.key` credential and optional timeout as the other registered-game clients:

```js
import { createSpawnPaymentClient } from '@spawndotfamily/sdk/server';

const payments = createSpawnPaymentClient({
  platformOrigin: process.env.SPAWN_PLATFORM_ORIGIN,
  projectId: process.env.SPAWN_PROJECT_ID,
  credential: process.env.SPAWN_MATCH_KEY,
});

const result = await payments.lookup({
  playerId: order.playerId,
  requestId: order.requestId,
  launchId: order.launchId,
});
```

`lookup` sends one read-only `POST` to `/api/v1/registered-games/{projectId}/token-payments/lookup`. It omits cookies, rejects redirects, caps the JSON response and never confirms, cancels, mutates or retries a payment. It accepts either `{ playerId, requestId, launchId }` for recovery or `{ playerId, receiptId }` when a durable receipt ID has already been recorded.

The response is exactly:

```ts
{
  status: 'paid' | 'pending' | 'cancelled' | 'expired' | 'not_found';
  playerId: string;
  requestId: string | null;
  launchId: string | null;
  item: string | null;
  receipt: {
    id: string;
    assetId: string;
    amount: string; // canonical integer base units
    projectId: string;
    status: 'paid';
  } | null;
}
```

The SDK validates every response field and checks the configured project, queried player, original request and launch, receipt ID, asset shape and canonical amount. Your server must still compare the returned asset ID, amount and item with the saved local catalog before issuing anything. `paid` must include a matching receipt. `pending`, `cancelled` and `expired` never include one. `not_found` contains null request, launch, item and receipt fields.

Treat `SpawnTokenPaymentError` as unavailable verification. Keep the saved order unresolved and reconcile it with the same tuple. The client does not expose an “outcome is safe to retry” flag because a failed read says nothing about whether the original debit was recorded.

The error carries a safe `code` (`HTTP_UNAUTHORIZED`, `HTTP_FORBIDDEN`, `HTTP_NOT_FOUND`, `HTTP_CONFLICT`, `HTTP_RATE_LIMITED`, `HTTP_UNAVAILABLE`, `HTTP_REJECTED`, `TRANSPORT_ERROR`, `REQUEST_TIMEOUT` or `INVALID_RESPONSE`), optional HTTP `status`, and bounded platform `reason`, `requestId` and `retryAfterMs` diagnostics. It never includes the dedicated credential or a response body.

## Deliver once in the creator database

When the lookup is `paid`, compare all of these values with the saved order before issuing anything:

- `result.playerId`, `result.requestId` and `result.launchId` match the verified order;
- `result.item` matches the local catalog item exactly;
- `receipt.projectId`, `receipt.assetId` and `receipt.amount` match the saved project, Listing asset and base-unit amount exactly;
- `receipt.status` is `paid` and its `id` is a valid, new receipt claim.

Insert a unique receipt claim and the inventory/item grant in one database transaction. On a replay, the existing claim returns the same delivery result without inserting a second item. If any catalog or identity check fails, retain the paid record for reconciliation or refund policy; do not issue a different item, substitute an amount, use JavaScript `Number`, or create a new charge.

`pending` means keep the order open and look up the same tuple later. `cancelled` and `expired` deliver nothing. `not_found` is unresolved and never authorizes a replacement order or a new debit. A missing or timed-out browser result follows the same lookup path. A rejected or timed-out browser promise is never delivery authority and is not, by itself, proof that no debit occurred. Use the original server lookup even if the overlay closed; only the returned recorded status decides recovery. A confirmed cancellation delivers no item.

The runnable synthetic SQLite journal in [`examples/verified-token-purchase.mjs`](../examples/verified-token-purchase.mjs) creates a temporary durable database, demonstrates the order, exact comparison, unique receipt claim, closes and reopens the journal, and replays the same lookup without touching a game source tree. Use the creator server's persistent database in production.

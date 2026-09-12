# Match entry presentation

`requestMatchEntry()` asks Spawn to open its own TEST match-entry confirmation for a UUID match ID. Only the player's explicit confirmation in that Spawn-owned overlay can reserve the entry. The game sends no amount, fee, player identity, account credential or payment proof. Spawn loads the match quote and balance from its authenticated platform services, displays the exact gross entry, platform fee, net reward-pool amount, game, mode, role and cancellation deadline, then applies the player's choice.

```js
import { createSpawnMultiplayerClient } from '@spawndotfamily/sdk/multiplayer';

const spawn = createSpawnMultiplayerClient({
  platformOrigin: 'https://spawn.example',
  serverOrigin: 'https://game.example',
});

await spawn.ready();
const result = await spawn.requestMatchEntry({
  matchId: '123e4567-e89b-42d3-a456-426614174000',
});
if (result.status === 'reserved') {
  // Continue showing server-owned waiting state until your server starts the match.
}
```

The method resolves to `{ matchId, status: 'reserved' | 'cancelled' }`. This is a presentation acknowledgement, not admission proof, a paid receipt, match-start confirmation, or permission to award anything. `reserved` means Spawn accepted the entry after the player's confirmation. The match may still be waiting for other players. The game server remains responsible for trusted admission, starting the match and authoritative outcomes; request and verify its launch grants through the separate multiplayer flow.

The parent and child exchange `spawn:multiplayer-payment-request` and `spawn:multiplayer-payment-result` on the already confirmed, nonce-bound `MessagePort`. Each message is bound to the exact UUID request ID and UUID match ID. A bounded error response contains no platform exception details. Legacy game documents do not receive this request. Grant renewal remains an independent request on the same channel.

Only one match-entry request can be outstanding per client. Repeating the same match ID shares that pending request; a different match ID is rejected until it settles. The request times out after 120 seconds. On timeout or client disposal, the SDK rejects the pending request because it cannot know whether Spawn completed the reservation. Disposing the local bridge does not establish that the platform cancelled or refunded the entry. Do not infer cancellation or automatically request another entry after an indeterminate result.

The Spawn-owned overlay labels the ledger as `TEST` and does not move real or redeemable tokens. It shows the server quote's exact gross amount, fee rate and amount, net pool amount, balance, game, mode, side and expiry. Confirming reserves the entry. Cancelling before the match starts declines the pre-start entry ledger for everyone in that match; once server status is `running`, the overlay offers no cancellation or refund. Neither a reserved entry nor this browser response makes a client-reported game result trustworthy.

Use this method only when the platform has enabled the registered multiplayer match-entry flow for the game. It does not add a general payment API, arbitrary purchase method, receipt lookup or server credential to the SDK.

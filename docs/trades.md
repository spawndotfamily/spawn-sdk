# Player-to-player token trades

SDK 0.6.0 adds `client.trades` to both `createSpawnGameClient` and `createSpawnMultiplayerClient`. It supports direct gifts and two-way exchanges using the admitted testnet token selected in the game's Listing. This is separate from match escrow. No contract address, publishing secret or privileged settlement key belongs in the game code.

Both participants must be authenticated Spawn members, with registered profiles and active launches of the same game. Guests, guest IDs, display names and invented recipient IDs cannot receive tokens. Guest play stays free; prompt guests to sign in before offering a trade. A name alone is never payment authority.

## Methods

| Method | Purpose |
| --- | --- |
| `trades.context()` | Returns your game-scoped `playerId`, `launchId` and `projectId`. These are routing identifiers, not credentials. |
| `trades.create({ tradeId, recipientPlayerId, recipientLaunchId, amount })` | Create a five-minute offer. Use a new UUID once and keep it for reconciliation. The other side initially offers zero. |
| `trades.get(tradeId)` | Read the current offer, approvals and settlement status. |
| `trades.offer(tradeId, version, amount)` | Change only your own offer, using the latest version. A change resets both approvals. |
| `trades.accept(tradeId, version)` | Call after the player accepts this revision in-game. Spawn shows its payment review to anyone sending tokens. A zero-token receiver accepts without a payment popup. |
| `trades.cancel(tradeId)` | Cancel a pending trade. A settled transfer cannot be cancelled. |

Input amounts are exact decimal strings in whole token units, such as `"1.25"`. Returned amounts and balances are exact ERC-20 base-unit strings; format them using `asset.decimals` without converting them to JavaScript `Number`. The asset is identified by chain plus contract address, never by its symbol.

## Integration flow

1. Exchange the two players' `trades.context()` values through your existing multiplayer connection. Your authoritative server should bind them to verified player admission. Never accept a player-supplied name as identity.
2. Create one trade and send its `tradeId` through the game connection to the other player. Share IDs only with the intended participants.
3. Each participant reads `trades.get(tradeId)` and renders the same version, both exact offers and counterpart identity. Each can change only their own offer.
4. Changing either offer resets the displayed acceptances. Call `accept` only after a fresh in-game click on the current revision. Any sender must also approve the Spawn-owned modal; do not draw a substitute payment popup.
5. Read Spawn status while the trade is open (for example every three seconds, stopping on close or a terminal result). Show **Trade complete** only for `status === "settled"`. `self.confirmed === true` means approved, not transferred.

```ts
const me = await client.trades.context();
// Share me with the intended peer through your game's verified connection.
const tradeId = crypto.randomUUID();
let trade = await client.trades.create({
  tradeId,
  recipientPlayerId: peer.playerId,
  recipientLaunchId: peer.launchId,
  amount: '10',
});
// After the user sees and accepts the current offer in your game:
trade = await client.trades.get(tradeId);
const result = await client.trades.accept(tradeId, trade.version);
if (result?.status === 'settled') showTradeComplete();
else showWaitingOrCurrentOffer();
```

`accept` returning `null` means the payment popup was dismissed, not that Spawn cancelled the trade. For a timeout, lost connection or uncertain result, call `get` with the same ID. Never create a replacement payment just because a response was lost. If the game launch has expired, account wallet activity remains the durable record; do not infer cancellation from failed status access.

## Settlement and safety

Both gross transfers execute inside one Spawn database transaction after both approvals. Each sender must already have the full offered amount available; incoming tokens cannot finance an underfunded offer. Pending withdrawals and other spending count against available balance. Approval does not reserve funds. If funds are no longer available when the other player confirms, no part of the trade moves; reload and reconcile before retrying.

The five-minute deadline never extends when offers change. Cancellation and expiry require no refund because no funds are held. Confirmations bind to immutable quotes; stale approvals fail. Replay after settlement returns the same trade state without paying again. Changing the Listing invalidates pending approval. Spawn charges zero transfer fees. No on-chain wallet transaction is required for a trade between deposited Spawn balances; deposits and withdrawals remain separate.

This feature requires the hosted platform trade service introduced with 0.6.0. It does **not** require per-game match-key activation because the game server cannot authorize player spending. Existing registered multiplayer admission still needs its normal server setup. `spawn-dev` does not emulate two-account settlement; it reports this limitation explicitly. Test two real signed-in member accounts that both have access to the same hosted game: authorized preview testers, or a published testnet game. Cover insufficient balance, changed offers, cancellation, guests and reconnection. Signing in alone does not grant private-preview access.

## Items and authority

This API settles tokens only. It does not transfer ownership of objects stored in a game's independent database, and a browser-returned receipt is not proof an authoritative server should use to award items. Do not implement a token-for-item exchange by updating game items after a token transfer and calling that atomic.

Current free customization needs no purchased ownership. Item-only interactions can use both in-game acceptances without a Spawn payment popup, but future earned or purchased items require a canonical ownership ledger and atomic ownership integration before trade settlement is offered. Match rewards use the separate [match-payments](match-payments.md) server API.

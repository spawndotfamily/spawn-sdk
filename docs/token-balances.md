# Listing-token balances (SDK 0.8.0)

Read a player's **available deposited Spawn balance** without creating a trade, payment or match. It is the current Listing token only, identified by chain and contract, not the connected on-chain wallet or all tokens the player owns. No fixed TEST fallback, contract input or currency selection belongs in game code.

Creators may read balances for verified active players in their own game and decide which players see them. To enforce selective visibility, roster reads are **server-only**. The browser can directly read only its own balance. Keep server credentials private and send each client only what your visibility policy permits; hiding a field after broadcasting it is not privacy.

## Browser: own balance

Both `createSpawnGameClient()` and `createSpawnMultiplayerClient(...)` expose the same method after the trusted connection/startup flow:

```js
const snapshot = await client.tokens.balance();
// { projectId, playerId, asset, settingsVersion, observedAt, balance }
const exactUnits = formatUnits(snapshot.balance, snapshot.asset.decimals);
showMyBalance(exactUnits, snapshot.asset.symbol);
```

There are no arguments: it cannot read another player or override the Listing token. A genuine zero balance is returned as the string `"0"`; unavailable identity or custody is an error, not zero. Guests cannot use hosted balances. For the isolated client, check `identity().isGuest`; for multiplayer, use verified admission before enabling member features.

All returned `balance` values are **integer ERC-20 base-unit strings**, not human-readable units. Keep them as strings or `BigInt` (never `Number`). For example, `"1000000000000000001"` at 18 decimals means exactly `1.000000000000000001` tokens. This helper preserves precision:

```js
function formatUnits(baseUnits, decimals) {
  if (decimals === 0) return baseUnits;
  const digits = baseUnits.padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
```

## Creator server: game roster balances

Use ordinary [creator server setup](server-setup.md) once if this game has no dedicated server credential. An already configured game reuses its current `match.key`; **do not rotate or re-enable just for this upgrade**. A downloaded publishing key or `storage.key` is not this credential. No Spawn VPS access or operator provisioning is needed. This reader never creates or settles matches.

```js
import { readFile } from 'node:fs/promises';
import { createSpawnTokenClient } from '@spawndotfamily/sdk/server';

// Creator-controlled configuration, never paths or credentials supplied by a player.
const tokens = createSpawnTokenClient({
  platformOrigin: 'https://spawn.family',
  projectId: configuredGameId,
  credential: (await readFile(configuredPrivateMatchKeyPath, 'utf8')).trim(),
});

// Maintain this roster on your server from createSpawnLaunchVerifier.consume().
// Bind each admitted identity to its authenticated game socket/session.
const players = activeVerifiedMembers.map(identity => ({
  playerId: identity.playerId,
  launchId: identity.sessionId, // Verified Spawn grant sessionId is its launch ID.
}));
if (players.length) {
  const snapshot = await tokens.balances(players.slice(0, 50));
  for (const viewer of connectedViewers) {
    const visible = snapshot.players.filter(row => maySeeBalance(viewer, row.playerId));
    sendTo(viewer, { type: 'balances', asset: snapshot.asset,
      settingsVersion: snapshot.settingsVersion, observedAt: snapshot.observedAt, players: visible });
  }
}
```

The verified grant calls its launch identifier `sessionId`; pass that as the balance API’s `launchId`. It is not the account login session or your own socket/session ID.

`activeVerifiedMembers`, `maySeeBalance` and `sendTo` are your game's roster, visibility policy and transport, not SDK methods. Do not accept a client-supplied roster, account ID or launch as proof of admission. Read [multiplayer verification](multiplayer.md). A balance read does not replace admission or extend a launch.

`balances(players)` accepts **1–50 unique** `{ playerId, launchId }` records and returns `{ projectId, asset, settingsVersion, observedAt, players: [{ playerId, balance }] }`. Every member must still have an active Spawn session and authorized launch of this game. Returned rows may be sorted differently: map by `playerId`, never array position. `observedAt` is a Unix timestamp in milliseconds. For more than 50 members, use sequential chunks; each chunk is its own snapshot. If Listing version/asset changes between chunks, discard the combined display and refresh. Empty rosters need no request.

The platform allows 60 roster reads per minute per game across server addresses, and bounds request/response sizes. Fetch on join, when showing a balance, and after confirmed token activity; coalesce requests and use a modest interval (for example 10 seconds) when live display is needed. Do not poll per player per animation frame. Cache only briefly and keep snapshots within the game's privacy policy.

## Errors and money safety

Server reads throw `SpawnTokenBalanceError`, exported from `/server`, with `code`, optional `status`, `reason`, `requestId` and `retryAfterMs`. No request is automatically retried. A read can be retried after its cause is resolved; it cannot reserve or move money.

- `HTTP_UNAUTHORIZED` (401): distinguish the safe `reason` for an invalid/revoked server key from an inactive player launch. Refresh verified admission/remove disconnected members, then rebuild the roster. Never fabricate or swap identities. An invalid member rejects the whole batch; there are no partial zero-filled results.
- `HTTP_FORBIDDEN` (403): wrong transport/authority. Keep keys on your server; don't call this route from a browser or forward cookies.
- `HTTP_NOT_FOUND` (404) / `HTTP_UNAVAILABLE` (503): verify server setup and the matching hosted platform release. A missing platform endpoint is an SDK/platform dependency, not permission to invent one. Check Listing/custody readiness; show “balance unavailable.”
- `HTTP_RATE_LIMITED` (429): coalesce calls and respect `retryAfterMs`.
- `NETWORK_ERROR`, `REQUEST_TIMEOUT`, `INVALID_RESPONSE`: discard the read, keep an explicitly stale display if useful, then refresh. Do not present it as a confirmed payment or silently replace it with zero.

A balance snapshot is **not** an allowance, hold, payment receipt or authorization to debit a player. Pending withdrawals and existing match reservations reduce available balance. Unaccepted trade offers do not reserve funds, so balances may change before confirmation. Every sender still confirms their exact tokens through Spawn. Use the existing trade/payment/match APIs for transfers; never implement transfers by editing a displayed balance. Server-decided rewards and deposit redemptions from the game's pool use the server-only [payout API](payouts.md) with the same dedicated server key — a balance read never authorizes a payout, and the browser cannot call that route at all. A creator cannot approve for a player merely because it can read their balance.

## Upgrade and verify with no private platform access

Install `@spawndotfamily/sdk@0.8.0` with `--save-exact --ignore-scripts`, rebuild browser and server, and deploy each through your existing creator workflow. Do not change match journals, recovery IDs or keys. Spawn's hosted balance endpoints must be deployed as well; SDK installation alone does not deploy platform/server code.

`spawn-dev` explicitly reports Listing balances unavailable; its old local TEST simulator is not the Listing ledger. Use authorized hosted preview members, or a published game with two consenting members, and your creator server. Verify self reads, a two-member roster, exact decimal formatting, chosen viewer policy, no new trade/match, and no balance change caused by reads. Test guests, expired admission, another game's IDs, revocation and unavailable custody in isolated fixtures. Game-specific deployment and play testing remain the game agent's job; passing SDK fixtures is not a claim that your game has been tested end-to-end.

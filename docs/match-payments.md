# Two-player matches with the Listing token

SDK 0.5.0 adds a server client for two-player matches using the testnet token selected in the game's Listing. This supports player-funded competition: both players approve an entry, Spawn reserves their tokens, and your authoritative server distributes that match's pot after validating the result. No house-funded dealer or creator reward pool is required. A 10-token entry from each player creates a 20-token pot; Spawn takes no transfer fee.

This is separate from buying permanent access to the game. The Listing chooses the **asset**; your server chooses the match **amount** as an exact decimal string. Neither browser nor server calls supply a token contract or arbitrary recipient account. TEST demo credits, Listing tokens on Robinhood Chain Testnet, and mainnet assets are different: this flow supports admitted Listing testnet assets, not mainnet or redeemable-money settlement. Do not replace a creator's selected Listing testnet token with local play points.

## Before your agent starts

1. Configure the game's token in Listing using the workspace or documented `spawn-publish token` commands. Free game access (`entryAmount: 0`) can still have separately approved paid matches.
2. Operate an authoritative game server that verifies Spawn launch grants, owns the game state and validates outcomes. A browser's claimed win or score is insufficient.
3. Have Spawn register that project's server origin, audience and a **dedicated match server credential**. Multiplayer transport registration alone does not enable settlement. Publishing and storage credentials do not grant settlement authority. This activation is an operator setup step, not a game-publication review. There is no self-service match-key issuance command in this release.
4. Use a cryptographically random 32-byte credential encoded as 43 base64url characters, provisioned through a private channel. Keep the credential in private server configuration. Never put it in browser code, the downloaded publishing file, Git, chat or logs. Keep `@spawndotfamily/sdk/server` out of browser bundles.
5. Test both players' confirmation, insufficient funds, cancellation, disconnect, expiry, draw and duplicate settlement before inviting players. `spawn-dev` does not simulate this server escrow API; use an activated private preview or an isolated integration service.

If activation is missing, tell the creator exactly which server-registration dependency is missing. You can still build and publish the game. Do not invent endpoints, silently use fake currency, or claim automatic settlement is active.

## Server lifecycle

```js
import { randomUUID } from 'node:crypto';
import { createSpawnMatchClient } from '@spawndotfamily/sdk/server';

const matches = createSpawnMatchClient({
  platformOrigin: 'https://spawn.example',
  projectId: process.env.SPAWN_PROJECT_ID,
  credential: process.env.SPAWN_MATCH_SERVER_KEY,
});

// These identities come from consumed, verified Spawn launch grants.
// sessionId on a verified grant is the launchId expected here.
const matchId = randomUUID();
await matches.create({
  matchId,
  amount: '10',
  players: [
    { playerId: playerA.playerId, launchId: playerA.sessionId },
    { playerId: playerB.playerId, launchId: playerB.sessionId },
  ],
});
// Send this matchId to those two admitted players.
// In your match coordinator, poll until both entries are reserved.
let state = await matches.status(matchId);
while (state.status === 'pending' && !state.allConfirmed) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  state = await matches.status(matchId);
}
if (state.status !== 'pending') throw new Error('Match is no longer pending');
const started = await matches.capture(matchId);
if (started.status !== 'running') throw new Error('Match did not start');
// Now run your authoritative gameplay. During it, await heartbeat periodically
// (for example every 30 seconds), stop on failure, and reconcile status.
await matches.heartbeat(matchId);

// Only after your server has independently validated the winner:
await matches.settle(matchId, {
  reason: 'victory',
  payouts: [{ playerId: verifiedWinner.playerId, amount: '20' }],
});
```

The example's `playerA`, `playerB` and `verifiedWinner` are values your authoritative server must supply; they are not SDK globals. For a draw, distribute the full pot between the two roster players. Amount strings are human-readable token units (`'0.5'` means half a token), never floating-point numbers or base units. Status and reservation quotes identify the snapshotted asset. Only exactly two distinct signed-in users from the same game can enter; guests cannot pay or receive match payouts.

| Server method | Purpose |
| --- | --- |
| `create({ matchId, amount, players })` | Register two verified launches and snapshot the Listing token; does not debit players. |
| `status(matchId)` | Read authoritative match state, including whether each player confirmed. |
| `capture(matchId)` | Start only after both players confirmed. |
| `heartbeat(matchId)` | Renew a running match's server lease. |
| `cancel(matchId, reason)` | Cancel and refund reserved entries; reasons: `technical`, `cancelled`, `expired`, `shutdown`. |
| `settle(matchId, { payouts, reason })` | Distribute the complete pot to roster members only; reasons: `victory`, `timeout`, `forfeit`, `draw`. |

Pending matches expire after 120 seconds. A running match needs a heartbeat within 90 seconds and must finish within one hour of registration (`maxEndsAt`). Heartbeats cannot extend that absolute deadline, which prevents a server from holding entries indefinitely. Expired matches are cancelled and refunded when the service reconciles them; do not promise an instantaneous refund merely because a browser closed. Listing changes invalidate pending confirmations and capture; cancel the pending match before creating a replacement. Existing matches never switch currencies underneath players. Terminal results are durable and idempotent; a different settlement for the same match is rejected. The platform enforces pot conservation and game scope, but your server remains responsible for fair results.

The client uses HTTPS (exact loopback HTTP is allowed for isolated tests), omits cookies, rejects redirects and never automatically retries mutations. `SpawnMatchRequestError.outcomeUnknown` means a mutation may have completed. Query `status(matchId)` and reconcile the **same match** before another action; never create a new match or pay twice to resolve a timeout. Keep match IDs and intended settlement records durably on your server. A 401/403 response means the dedicated server credential or request boundary was rejected; a 404 can mean the project/match or hosted route is unavailable; a 503 requires checking activation or service availability. These errors are not permission to substitute another game, currency or credential.

## Browser confirmation

```js
import { createSpawnMultiplayerClient } from '@spawndotfamily/sdk/multiplayer';
const spawn = createSpawnMultiplayerClient({
  platformOrigin: 'https://spawn.example',
  serverOrigin: 'https://game.example',
});
await spawn.ready();
// Run following the player's deliberate choice to enter a match.
const result = await spawn.requestMatchEntry({ matchId });
```

Spawn displays the exact amount, token identity, network, contract, available balance and reservation terms using its shared transaction design. The browser supplies only `matchId`. The result `{ matchId, status: 'reserved' | 'cancelled' }` is a presentation acknowledgement, not proof that gameplay started or permission to award tokens. Continue following your server's authoritative state.

Only one request can be pending. Repeating the same match ID shares that request; a different ID is rejected. The browser request times out after 120 seconds. A timeout or disposed channel does not prove cancellation or refund. Read server status instead of automatically asking the player to pay again.

The existing first-party Rob the Rich integration retains its separate duel/raid protocol. Do not copy its private endpoints, roles or integer amount conversions into another game; use the generic server client above.

# Two-player matches with the Listing token

SDK 0.5.0 adds a server client for two-player matches using the testnet token selected in the game's Listing. This supports player-funded competition: both players approve an entry, Spawn reserves their tokens, and your authoritative server distributes that match's pot after validating the result. No house-funded dealer or creator reward pool is required. A 10-token entry from each player creates a 20-token pot; Spawn takes no transfer fee.

This is separate from buying permanent access to the game. The Listing chooses the **asset**; your server chooses the match **amount** as an exact decimal string. Neither browser nor server calls supply a token contract or arbitrary recipient account. TEST demo credits, Listing tokens on Robinhood Chain Testnet, and mainnet assets are different: this flow supports admitted Listing testnet assets, not mainnet or redeemable-money settlement. Do not replace a creator's selected Listing testnet token with local play points.

## Before your agent starts

1. Configure the game's token in Listing using the workspace or documented `spawn-publish token` commands. Free game access (`entryAmount: 0`) can still have separately approved paid matches.
2. Operate an authoritative game server that verifies Spawn launch grants, owns the game state and validates outcomes. A browser's claimed win or score is insufficient.
3. Follow [creator server setup](server-setup.md) using fresh downloaded credentials with `server:configure`. Run `spawn-publish server status`, then `server enable` with the creator-approved origin/path/audience and current version. No Spawn operator provisioning or VPS access is needed.
4. The CLI generates a dedicated match key locally, saves it privately and registers only its hash. Install `match.key` and the public `verification.json` on the creator's own server. Existing storage keys are preserved. Keep all private credentials out of browser code, Git, chat and logs.
5. Test both players' confirmation, insufficient funds, cancellation, disconnect, expiry, draw and duplicate settlement before inviting players. `spawn-dev` does not simulate this server escrow API; use an activated private preview or an isolated integration service.

If activation is missing, tell the creator exactly which server-registration dependency is missing. You can still build and publish the game. Do not invent endpoints, silently use fake currency, or claim automatic settlement is active.

## Agent deployment and activation handoff

**Browser publication, authoritative-server deployment and match activation are three separate steps.** `spawn-publish` uploads browser assets only. Updating the package or publishing a new browser release does not restart your server, install its new game rules, or enable match settlement. Do not report “SDK unsupported” when the server deployment or dedicated activation is missing.

Continue the work that does not need activation: implement the authoritative game rules, integrate the server client, build and test the server artifact, and prepare its deployment instructions. Deploy only to a creator-authorized server. Never request access to Spawn's private infrastructure or silently substitute the existing Rob the Rich service.

| Checkpoint | Evidence the game agent must obtain |
| --- | --- |
| Listing ready | Read saved settings through `spawn-publish token get`; verify the intended admitted token and the separate permanent-access price. |
| Browser ready | Bundle the SDK, publish the tested browser release, and record its release ID. |
| Server deployed | Record the actual running server build/revision and verify it includes the new match coordinator. A successful browser upload is not this evidence. |
| Server admitted | Verify launch grants against the registered project, server origin and audience. Reject guests for token matches; use the verified grant's session ID as `launchId`. |
| Match activation | Run SDK server enable with a fresh creator credential; install the locally generated match key only in the creator server's private configuration. Publishing or storage credentials cannot replace it. |
| End-to-end verified | Two distinct signed-in players confirm the exact Listing-token entries, server observes both reservations, capture succeeds, and settlement or refund is confirmed by Spawn. |

When operator setup is the remaining dependency, provide this **non-secret handoff**:

- Project ID and public platform origin.
- Registered public game-server origin and audience; ask the creator/operator for missing public registration details rather than guessing.
- Current deployed server revision, or explicitly “server artifact prepared, not deployed”.
- Server configuration variable names used for project ID and dedicated match credential, plus which authorized server operator will install it. Do not include credential values or private infrastructure details.
- Test results and the exact blocked stage/status. Redact credentials and player grants from errors.

Self-service registration and match activation are available in SDK 0.7.0 through [server setup](server-setup.md). A publishing key authorizes setup only when it has the new scope; it is never accepted as a match settlement key. Installing the SDK alone does not configure or deploy the game. If another operator owns the creator's game server, provide the deployment handoff for that server; no Spawn operator action is part of normal setup.

Keep token matchmaking unavailable with a clear “Token matches are being set up” message until setup succeeds. A local test pass does not prove hosted activation. Do not create a paid match merely as a readiness probe: real match verification requires two consenting members and the normal confirmation flow. After a timeout, reconcile the same match ID before retrying any mutation.

Direct player gifts and two-way token trades use [the trade API](trades.md), not server-owned match settlement. They need player approval and authenticated member recipients, but no dedicated match key. Both flows transfer deposited Spawn platform balances; on-chain withdrawal is a separate Wallet action.

## Error handling before implementation

Read [match errors and recovery](match-recovery.md). Save the exact match definition before create and retain each structured error. A status404 after an uncertain create is not cancellation. SDK 0.7.2 provides closeCreation(matchId) and a tested recovery example: permanently fence an absent ID or refund a pending match without fresh launches, and require confirmed closure before a replacement. Do not open player approval until create succeeds.

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
// Only after create succeeds, send this matchId to those two admitted players.
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

# Creator server setup

SDK 0.7.0 and later lets a creator configure their own game's multiplayer, match and game-scoped table authority through the public creator API. No Spawn VPS, SSH, database login or private operator action is required. The creator still operates and deploys their own game server. SDK 0.9.0 tables require the matching Spawn 0.9 table service after setup.

## Before setup

Download fresh game credentials from the creator workspace. They must contain `server:configure`; editing an old file's scopes does not grant access. Keep this file outside the repository and browser output. Configure an admitted Listing token first with `spawn-publish token`; free access with price zero can still support optional paid matches.

Spawn's downloaded credential may use `https://publish.spawnfamily.com` for CLI transport. Launch verification and browser platform configuration remain `https://spawn.family`; the CLI preserves this distinction in `verification.json`. Never use the publishing alias as the browser launcher origin.

Confirm the creator's intended HTTPS game-server origin, WebSocket path and audience. Registration records their chosen destination; it is not independent verification of domain ownership. Never use a Spawn account or asset origin. The SDK registers settings only: it does not deploy code, create a hosting account or execute commands on a server.

## Enable through the SDK

Use the installed CLI and the private credential file. Replace the example paths and public server details with the creator's values. Obtain the current version from status; use zero only when status returns zero.

```sh
spawn-publish server status --credentials /private/path/creator.json
spawn-publish server enable --server-origin https://game.example --websocket-path /game/ws --audience my-game-server --out-dir /private/path/game-server-keys --version 0 --creator-confirmation --credentials /private/path/creator.json
```

Run these private-file setup commands on Linux, macOS, or WSL's Linux filesystem; native Windows ACL validation is not supported by this release. The output directory's parent must already exist. Use an absolute path without symlink components, outside the game/repository/build. The directory is private (0700) and files are private (0600). The CLI saves its files before sending only SHA-256 key hashes to Spawn. It never prints the secret values.

| File | Purpose |
| --- | --- |
| `match.key` | Dedicated raw match, game-scoped table and payout credential; read privately on the creator's server and pass to `createSpawnMatchClient`, `createSpawnTableClient`, `createSpawnPayoutClient` or the matching server adapter. Never put it in the browser. |
| `storage.key` | Separate storage credential, created only for a previously unregistered game. Existing storage credentials are preserved. Keep this file if using the documented Spawn save API. |
| `verification.json` | Public Ed25519 verification configuration for `createSpawnLaunchVerifier`: issuer, audience, game ID, environment and public keys. |
| `setup.json` | Public settings and version binding used to reconcile retries. Preserve with the private files. |

On the creator's authorized server, install the match key and public verification config, configure a durable match/table/payout journal, deploy the authoritative game code and restart that game server. Adapt these files to the game's own configuration variable names. Follow [multiplayer](multiplayer.md), [match payments](match-payments.md), [persistent tables](table-bankroll.md) and [payouts](payouts.md). Never request Spawn infrastructure access. An agent with permission to deploy the creator's server can complete this step; otherwise give that server's operator the artifact and private file locations, never secret values in chat.

The existing `match.key` authorizes the match routes, the game-scoped table routes and the pool payout route. `matchesEnabled` remains the backward-compatible setup/status metadata for this combined server authority; the platform does not return a separate `tablesEnabled` or `payoutsEnabled` field. Enabling server authority through this ordinary creator flow does not move player funds or activate a new VPS.

## Retry, rotate and revoke

If the request times out, preserve the directory and run status. Repeating the exact enable command with the same directory, settings and original version reconciles an already-completed change without generating a new key. A settings conflict requires review; do not delete private files and start over blindly.

To rotate the match key, obtain the current version and run enable using a **new** private directory. Rotation immediately invalidates the old match key after success. Existing storage credentials stay unchanged. Finish active pending/running matches and funded tables first; transport changes and rotations are rejected while they exist.

```sh
spawn-publish server disable --version 1 --creator-confirmation --credentials /private/path/creator.json
```

Use the actual current version. Disable revokes match, table and payout authority immediately, while preserving transport and storage. Existing reserved entries and table backing remain subject to Spawn's cancellation/refund and cash-out recovery rules; disabling is not instant confirmation. Deleting a local file alone does not revoke its platform registration. Rotating/revoking a publishing credential is separate from rotating/revoking a match/table credential.

## Permissions and verification

- A downloaded creator credential may configure only its owner's game, in addition to its documented publishing/listing/database scopes. It grants no SSH access, OS commands, arbitrary filesystem access, platform administration or other-game access.
- A stolen creator credential can still damage that game's settings or content. Keep it private and revoke it if exposed. A stolen match key can influence that game's approved match outcomes, scoped table operations and pool payouts; it cannot authorize arbitrary player debits. Do not claim credentials are harmless or security is guaranteed.
- Match/table setup moves no player tokens. Players must independently confirm the exact stakes in Spawn. Match settlement is restricted to the approved reserved pot and its two authenticated roster members; table buy-ins are separately approved and table backing is isolated per table. Guests cannot send or receive tokens.
- Creator-server fairness remains the creator's responsibility. Platform checks conserve the pot and enforce scope/consent; they cannot establish whether a game result was honest.
- Direct player gifts and atomic token trades use [trades](trades.md), with player approval and no match key. On-chain withdrawal is a separate wallet action.

Report setup status, browser publication, actual running server revision, table-service revision and two-member settlement verification separately. Test a complete consent → reservation → capture → payout and cancellation/refund flow with two consenting signed-in members before claiming end-to-end completion. For tables, also test a confirmed buy-in, hand recovery, side-pot conservation and cash-out after reconnect. Local fixture tests and a successful enable response do not prove a game server is deployed or its payouts work.

A 401/403 means missing/expired/revoked credentials, missing setup scope or wrong owner. Download a fresh credential when needed. A 409 means stale settings, unavailable game, active matches or missing Listing readiness; inspect the message and current status. A 503 means platform signing/custody/service readiness is unavailable. Report that platform failure; never request private VPS access or substitute fake currency.

## Roster balances

SDK 0.8.0 and later’s server-only `createSpawnTokenClient` reuses this game’s dedicated `match.key` for read-only Listing-token roster snapshots. Existing games need no key rotation. This credential can read active same-game balances as well as its documented match and table authority; protect it accordingly. Publishing/storage keys cannot read the roster. Read [token balances](token-balances.md) for visibility and verified admission.

## Verify optional purchase receipts (0.12.0)

`createSpawnPaymentClient` from `@spawndotfamily/sdk/server` reuses the existing dedicated game `match.key` for read-only payment status. No extra credential, privileged Spawn access or manual operator activation is needed. Publishing and player-storage keys cannot use this API. Keep the credential server-side and follow [token purchases](token-payments.md) for saved orders, exact receipt checks, recovery and once-only item delivery. The matching platform endpoint must be deployed; an unavailable endpoint must leave item issuance blocked.

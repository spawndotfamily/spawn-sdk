# Creator integration boundaries

Use `createSpawnGameClient` for optional saves in isolated uploaded previews. Use the separate multiplayer browser/server modules only for an explicitly enabled game with your own server. The SDK is sufficient for its documented integration steps; it does not grant hidden platform capabilities. No private infrastructure configuration is needed or supplied.

## Required warning before automatic rewards

Before implementing automatic rewards for browser-only or offline single-player results, the AI agent must tell the creator in plain language:

> Players can fake wins and scores in a browser-only game. Automatically paying those results could drain your entire reward pool. A valid entry payment proves payment, not fair play. Keep automatic payouts off; use manual review or trusted server validation.

Surface this warning before implementation, not only in a report or after the feature is built. Keep starter automatic payouts **OFF** and preserve the existing manual-review flow. Recommend manual review or a trusted server that validates results using a documented platform contract. Do not claim that obfuscation, domain locking, client-side encryption or a paid receipt makes browser results safe for real rewards. Do not enable unsupported live payouts or invent a reward API. Further work must follow the creator's authorized scope and the platform's supported verification and payment contracts.

The deprecated, reviewed first-party compatibility client sends requests to `/api/v1/game-storage/rob-the-rich/{key}`. Keys contain 1–64 letters, digits, underscores or hyphens. GET returns a save or null; PUT takes `value` and `expectedVersion`. The server scopes data to the authenticated user and game, and rejects invalid versions and quota violations.

Keep a game’s rendering, input, rules, assets and networking in focused modules. Store secrets only on a trusted server. Multiplayer authority, payouts and anti-cheat must not rely on browser claims. You may run your own game server and database; this prototype does not provision them.

Uploaded previews use an isolated origin and the sandbox bridge described below. Creators deploy their own authoritative servers and register them through [self-service server setup](server-setup.md). The documented match and table APIs use a separate game-scoped server credential; they do not expose a general browser payout API. See [multiplayer.md](multiplayer.md). Do not remove the game allowlist or change the save transport to forward session cookies to another origin as a workaround.

See [security guidance](security.md) for the selected database-only hosting boundary, manual single-player review, storage quotas and why client-side encryption cannot protect a privileged API key.

## Preparing a private browser preview

Give an integration agent the existing game directory and build instructions with this bounded prompt:

> Inspect the existing game engine, source layout and build instructions. Reuse an existing browser build when one is available. If the project is native, explain the browser-port work and ask the creator before making substantial porting changes. Build the approved browser output into a preexisting directory containing `index.html`, then run `spawn-publish publish <directory> --credentials ~/Downloads/spawn-project-<projectId>.json` or use `SPAWN_API_URL`, `SPAWN_PROJECT_ID` and `SPAWN_PUBLISH_KEY` supplied through the environment. Keep the key out of source files, browser bundles, prompts, logs and output. Bundle dependencies locally because the preview CSP disallows remote CDN assets. If the engine needs WebAssembly threads or `SharedArrayBuffer`, report that the sandbox is unsupported until isolated worker support exists. Wait for the automated check and play-test the exact preview; only when the creator explicitly requests publication may the creator or authorized agent run `spawn-publish release --release <release-id> --creator-confirmation --credentials ~/Downloads/spawn-project-<projectId>.json`. Never publish merely because upload succeeded or weaken validation and security checks.

The CLI accepts HTTPS API origins, with HTTP limited to the exact local loopback hosts `localhost`, `127.0.0.1` and `[::1]`; origin paths, queries, fragments and credentials are rejected. It streams only regular browser asset files, rejects hidden paths, `node_modules`, source secrets, symlinks and `.map` files, and enforces 1,000 files, 10,000 traversed entries, 64 directory levels, an 8,000,000,000-byte client safety ceiling total and per file, and 1,000,000 bytes for every HTML file. The platform defaults admission to 1,000,000,000 decoded bytes and may grant an owner-controlled allowance up to the client ceiling. Remote uploads use a separately authenticated worker origin and 8 MiB chunks; the returned worker origin must match the derived or explicitly configured origin. Use `spawn-publish status <release-id>` to follow the automated check, then the explicit release command after play-testing. No first-listing staff review is required. Payments require an independent Spawn-owned exact-amount confirmation, with non-redeemable sandbox payments for local testing. See [security guidance](security.md) for the boundary.

## Sandboxed game bridge

Uploaded games run without `allow-same-origin`, so they do not receive the account cookie or a creator grant. Inside the iframe, create `createSpawnGameClient({ platformOrigin })`. The client requires an embedded window whose path matches `/build/<43-character-token>/...`, sends one `spawn:connect` message with that derived document token to the explicit platform origin, and accepts one `spawn:connected` response only from the exact parent source and origin with exactly one transferred `MessagePort`. The parent can queue operations until initial load, then sends an exact `spawn:ready` UUID nonce on that same port; the client replies with `spawn:ready-ack` on the same port. Requests otherwise use the connected port for `spawn:request` and `spawn:response`; navigation does not reconnect, and `dispose()` closes the port. Identity includes a unique handle, display name, a same-origin `/api/v1/avatars/<UUID>` `avatarUrl` with an optional `?v=<16 lowercase hex>` cache version or `null`, and sandbox environment; it never includes email. The client also provides sandbox save load/save and unverified `submitScore`. On hosted Spawn, legacy `requestPayment({ productId: 'entry' })` rejects when no Listing token is configured; a configured Listing amount is the permanent game-access purchase and must not be charged again after access, with a prior receipt or clear no-purchase-needed response used instead. `requestTokenPayment({ amount, item? })` requires an explicit game-defined amount for a separate optional payment using that same listing-selected token; browser code never supplies a token address, player, recipient or fee. Requests time out after 15 seconds, except payment requests at five minutes; at most 20 can be outstanding. Payment confirmation remains in Spawn's trusted overlay.

## Account-required game startup

Follow [the startup integration](startup.md) before enabling any play mode. Use the shared `@spawndotfamily/sdk/startup` controller, wait for trusted identity (and verified server admission for multiplayer), gate practice/bots too, and pause on connection loss. A handshake or grant alone is not multiplayer readiness. No automatic anonymous fallback. Keep an explicit isolated development launcher separate.

## Versioned game details

The source candidate includes local listing/image commands, available in Spawn’s testnet beta with scoped credentials. See [publishing.md](publishing.md#game-details-and-images). They use only documented metadata fields and file-based credentials, not browser player credentials. Metadata edits never approve or publish the game.

## Multiplayer match entry

The separate registered multiplayer flow uses `requestMatchEntry({ matchId })` to open a Spawn-owned Listing-token reservation overlay. See [match-entry presentation](match-payments.md) for its nonce-bound transport, one-request bound and presentation-only result. This method does not change the isolated-preview listing entry contract.

## Persistent tables

SDK 0.9.0 supports persistent 2–6 player Listing-token tables through the creator's authoritative server. Keep the existing dedicated `match.key` on that server and use `createSpawnTableClient` from the server entry point; browser code uses `client.tables.buyIn`, `status`, `heartbeat`, `leave` and `watch`. Spawn's host owns buy-in approval and returns only a server-confirmed status. Amounts sent through server table APIs are canonical unsigned BASE UNIT strings, and the matching Spawn 0.9 table service is required. Read [the table bankroll contract](table-bankroll.md) for durable journaling, seat generations, hand revisions and recovery.

## Configured token entry

Spawn stores one active game token and a permanent access price in the project's listing settings. A zero-priced Listing is free; a positive amount is the one-time permanent game-access purchase confirmed by Spawn before access. If a creator wants token entry, ask for the token contract address (or exact name) and intended amount, then use the versioned [token listing CLI](publishing.md#listing-token-entry) to resolve only a currently enabled Spawn-admitted `spawn` or `partner` asset. Hosted games use chain ID 46630 testnet. Use [spawn-test-host](local-approval-testing.md) for actual Listing-token approval components and ledger tests with fake local balances. The legacy `spawn-dev` remains a fixed TEST simulator for save/score integration. Chain ID 31337 is reserved for loopback platform development. If `token get` returns `{ settings: null }`, use version `0` for first setup. Never accept an arbitrary ERC-20 address or add an address to browser game code.

`requestPayment('entry')` remains a legacy compatibility call: without a configured token it rejects on current hosted Spawn; with a configured Listing it returns the prior permanent access purchase receipt or a clear no-purchase-needed error instead of initiating a second default-price debit. A game can instead call `requestTokenPayment({ amount: '0.25', item: 'Entry' })` for a separately documented optional payment; `amount` is required, an exact human-readable decimal string and never a JavaScript number. The optional item label is 1–80 printable characters. Spawn resolves the listing asset, converts the explicit amount with its decimals and owns the quote and player confirmation. Both methods require a signed-in player, so guests keep free play and cannot make token payments.

For a custom token payment, the SDK supplies a UUID `requestId` when one is omitted. If a timeout or other uncertain result may have left a payment recorded, the authoritative server keeps the original request, player and launch tuple and uses the documented lookup; it does not open a replacement payment from a new launch. Choose a new UUID only for a deliberate new purchase after the original is resolved.

For a registered multiplayer game's item purchase, create and journal the order ID on the authoritative server, bind it to the verified player and original launch, and use the server-only [`createSpawnPaymentClient.lookup`](token-payments.md) call to verify the original tuple after Continue or a timeout. Compare the exact catalog item, Listing asset and base-unit amount, then claim the receipt and grant the item in one creator-database transaction. `not_found` and an unavailable lookup never authorize a replacement charge; cancellation does not deliver the item.

The isolated local simulator and historical hosts retain the receipt `{ id, intentId, amount: 10, asset: 'TEST', environment: 'sandbox', status: 'paid' }`. A configured token receipt is `{ id, assetId, amount, projectId, status: 'paid' }`, with `amount` as an integer base-unit string. Do not convert receipt amounts to floating point or treat a receipt as server authorization for rewards.

## Spawn-owned entry payment flow

The platform provides **Confirm → Processing → Paid checkmark → Continue**, with a receipt visible in the player's history and the creator's payment history. Configured listing tokens are limited to Spawn-admitted `spawn` or `partner` assets on chain ID 46630 testnet; entries remain non-redeemable test payments. Without a configured Listing token, hosted payment requests reject; there is no demo-currency fallback. Payer identity in those histories comes from the platform's authenticated account record; the game neither chooses the payer nor receives additional private account fields.

Keep the confirmation, progress, success and Continue controls in the Spawn-owned overlay outside the game. A zero-priced Listing is free; a positive Listing amount requires its one-time permanent access purchase before access. A legacy `requestPayment({ productId: 'entry' })` call may return an existing permanent access receipt or a no-purchase-needed error for a configured Listing; it must never repeat the Listing default charge after access. A deliberate optional action uses `requestTokenPayment({ amount: '0.25', item: 'Entry' })`, where the amount is explicit, or another documented amount/item. The asset always comes from listing settings. Both methods wait for a validated paid receipt through the established SDK channel, and Spawn owns when the request resolves after its paid/Continue flow. Do not advance the paid experience merely because the overlay opened, a message said success or a local flag changed. Cancellation, rejection and uncertain results do not grant paid eligibility. Guest sessions remain free play and cannot make token payments.

A returned receipt lets the normal game flow continue; it cannot stop someone modifying their own browser to unlock local content. It also cannot prove that offline gameplay, a score or a reported win is honest. Do not add a second window-message listener for payment success or treat a browser-provided boolean, receipt object or ID as trusted authorization on a server.

For any paid leaderboard or reward participation, the platform must verify the recorded paid entry against the authenticated player, game and applicable participation context, with reuse rules enforced server-side. A legitimate payment does not make a browser-submitted score authoritative. This SDK supplies the narrowly scoped registered-game purchase lookup described in [verified multiplayer token purchases](token-payments.md); it is payment verification only, not a paid-eligibility, reward or anti-cheat endpoint. Leave those broader uses unavailable until a separate documented server contract is enabled, and never put creator credentials in the game.

A timeout can occur after payment was recorded. For a registered multiplayer purchase, reconcile the original `playerId`, `launchId` and server-generated `requestId` with [`createSpawnPaymentClient.lookup`](token-payments.md); never blindly send another charge. The player and creator receipt views belong to the platform, not custom game-side payment history. Test-token receipts remain non-redeemable and must not authorize real-money entries.

Use [local testing](testing.md) for fake accounts and the same isolated SDK handshake before uploading. The default client accepts only the launcher’s public origin configuration; it does not accept a player identity or payment permission from that configuration.


Local integration tests can exercise the complete fake entry → pool → manual reward loop in the launcher-owned creator panel. Follow [local testing](testing.md). Keep the browser client unchanged when moving to a private Spawn preview, and never fall back to local identity on connection failure. This is simulation coverage, not live-token or multiplayer-server validation.

## Platform fees and creator rewards

New game payments, creator-pool top-ups, withdrawals and rewards settle one-to-one with a 0% Spawn platform fee. A payment of 10 units of the Listing token credits 10 units to the game pool and zero to Spawn. No fee is added to the player's debit or withheld from the recipient. Historical receipts and balances retain the fee fields recorded when they were paid; they are not recalculated or converted. A pending quote created under the previous fee policy is invalid and must be requested again before confirmation.

A creator may retain part of the available pool under their disclosed game rules; that is a creator fee, separate from Spawn's platform fee. Explain the access price, any optional payment, creator retention and available rewards before participation. Do not add an unapproved player charge or invent an automatic creator-fee API.

The local launcher applies this zero-fee policy to new transfers and keeps the legacy fee fields on receipts for compatibility. Generic creator-operated multiplayer settlement still requires a separately enabled contract; this paragraph does not enable a new reward endpoint. TypeScript callers using `requestPayment` must narrow its 0.4.0 union return as shown below. AI agents must only call documented, available APIs and keep automatic payouts disabled if the required server settlement contract is unavailable.


### Payment receipt shapes

Only the isolated local simulator or historical hosts return the legacy `requestPayment({ productId: 'entry' })` receipt `{ id: string, intentId: string, amount: 10, asset: 'TEST', environment: 'sandbox', status: 'paid' }`. With a configured listing token, that legacy call represents the permanent access purchase and resolves with an existing receipt or rejects with a no-purchase-needed error after access; it must not start another default-price debit. An explicit `requestTokenPayment({ amount, item? })` resolves with `{ id: string, assetId: string, amount: string, projectId: string, status: 'paid' }`, where `amount` is an integer base-unit string. Cancellation or failure rejects the request; do not unlock participation on rejection or infer success from an overlay. Neither receipt is an authorization credential for server payouts.

In SDK 0.4.0, TypeScript sees `requestPayment` as a union because the listing can select either receipt. Narrow it before reading variant fields:

```ts
const receipt = await client.requestPayment('entry');
if ('assetId' in receipt) {
  // Configured token entry: receipt.amount is an exact base-unit string.
  console.log(receipt.assetId, receipt.amount);
} else {
  // Legacy TEST fallback: receipt.amount is the number 10.
  console.log(receipt.asset, receipt.amount);
}
```

The TEST receipt remains in types for isolated local simulation and historical host compatibility, but current hosted Spawn rejects payments without a Listing token. Code that assumes the old TEST-only return type must be updated to narrow this union. Republish games with SDK 0.4.0 before selecting a Listing token; this release requires explicit amounts for separate optional token payments and marks `requestPayment` as able to validate token receipts before charging, while older SDKs can reject a configured token receipt after payment. Existing TEST hosts ignore that marker and continue the legacy fallback.

## Player data in SDK 0.2.9

See [player data and leaderboards](game-data.md) for nested JSON, listSaves/remove, getLeaderboard, creator opt-in, quotas and submission retry IDs. The platform supplies a compact top-right connection and transaction overlay; no full-width header is required in your game.

## Migrating the old package name

The public npm package is `@spawndotfamily/sdk`. For existing integrations that used `@spawn/sdk`, update imports, including subpaths, to the public name. Alternatively, install an npm alias with `npm install --save-exact --ignore-scripts @spawn/sdk@npm:@spawndotfamily/sdk` to preserve existing imports. Choose one approach, review the release notes, and ask before upgrading an existing integration. Keep the lockfile.

This package-name change does not make `createSpawnClient('rob-the-rich')` a public creator API. That deprecated first-party compatibility client keeps its original same-origin cookie restrictions; creator games use `createSpawnGameClient` and the documented startup flow.

## Standalone Listing-token balances

Both browser clients expose `client.tokens.balance()` for the signed-in player. Use `createSpawnTokenClient` from `/server` for verified game-roster balances and creator-controlled visibility. See [the complete contract](token-balances.md). No payment/trade creation is required; reads do not grant spending authority.

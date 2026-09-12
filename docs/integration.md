# Creator integration boundaries

Use `createSpawnGameClient` for optional saves in isolated uploaded previews. Use the separate multiplayer browser/server modules only for an explicitly enabled game with your own server. The SDK is sufficient for its documented integration steps; it does not grant hidden platform capabilities. No private infrastructure configuration is needed or supplied.

## Required warning before automatic rewards

Before implementing automatic rewards for browser-only or offline single-player results, the AI agent must tell the creator in plain language:

> Players can fake wins and scores in a browser-only game. Automatically paying those results could drain your entire reward pool. A valid entry payment proves payment, not fair play. Keep automatic payouts off; use manual review or trusted server validation.

Surface this warning before implementation, not only in a report or after the feature is built. Keep starter automatic payouts **OFF** and preserve the existing manual-review flow. Recommend manual review or a trusted server that validates results using a documented platform contract. Do not claim that obfuscation, domain locking, client-side encryption or a paid receipt makes browser results safe for real rewards. Do not enable unsupported live payouts or invent a reward API. Further work must follow the creator's authorized scope and the platform's supported verification and payment contracts.

The deprecated, reviewed first-party compatibility client sends requests to `/api/v1/game-storage/rob-the-rich/{key}`. Keys contain 1–64 letters, digits, underscores or hyphens. GET returns a save or null; PUT takes `value` and `expectedVersion`. The server scopes data to the authenticated user and game, and rejects invalid versions and quota violations.

Keep a game’s rendering, input, rules, assets and networking in focused modules. Store secrets only on a trusted server. Multiplayer authority, payouts and anti-cheat must not rely on browser claims. You may run your own game server and database; this prototype does not provision them.

Uploaded previews use an isolated origin and the sandbox bridge described below. Creator server provisioning, self-service multiplayer registration and reward APIs are not implemented. The separate multiplayer SDK modules require platform enablement and a creator-operated server; see [multiplayer.md](multiplayer.md). Do not remove the game allowlist or change the save transport to forward session cookies to another origin as a workaround.

See [security guidance](security.md) for the selected database-only hosting boundary, manual single-player review, storage quotas and why client-side encryption cannot protect a privileged API key.

## Preparing a private browser preview

Give an integration agent the existing game directory and build instructions with this bounded prompt:

> Inspect the existing game engine, source layout and build instructions. Reuse an existing browser build when one is available. If the project is native, explain the browser-port work and ask the creator before making substantial porting changes. Build the approved browser output into a preexisting directory containing `index.html`, then run `spawn-publish publish <directory> --credentials ~/Downloads/spawn-project-<projectId>.json` or use `SPAWN_API_URL`, `SPAWN_PROJECT_ID` and `SPAWN_PUBLISH_KEY` supplied through the environment. Keep the key out of source files, browser bundles, prompts, logs and output. Bundle dependencies locally because the preview CSP disallows remote CDN assets. If the engine needs WebAssembly threads or `SharedArrayBuffer`, report that the sandbox is unsupported until isolated worker support exists. Stop after the private preview is returned; never forge creator approval, call an approval or public-publication endpoint, or weaken validation and security checks.

The CLI accepts HTTPS API origins, with HTTP limited to the exact local loopback hosts `localhost`, `127.0.0.1` and `[::1]`; origin paths, queries, fragments and credentials are rejected. It streams only regular browser asset files, rejects hidden paths, `node_modules`, source secrets, symlinks and `.map` files, and enforces 1,000 files, 10,000 traversed entries, 64 directory levels, an 8,000,000,000-byte client safety ceiling total and per file, and 1,000,000 bytes for every HTML file. The platform defaults admission to 1,000,000,000 decoded bytes and may grant an owner-controlled allowance up to the client ceiling. Remote uploads use a separately authenticated worker origin and 8 MiB chunks; the returned worker origin must match the derived or explicitly configured origin. Use `spawn-publish status <release-id>` to check the returned release. The creator must inspect and approve that exact artifact in Spawn before publication; new listings still require Spawn review. Payments require an independent Spawn-owned exact-amount confirmation, with non-redeemable sandbox payments for local testing. See [security guidance](security.md) for the boundary.

## Sandboxed game bridge

Uploaded games run without `allow-same-origin`, so they do not receive the account cookie or a creator grant. Inside the iframe, create `createSpawnGameClient({ platformOrigin })`. The client requires an embedded window whose path matches `/build/<43-character-token>/...`, sends one `spawn:connect` message with that derived document token to the explicit platform origin, and accepts one `spawn:connected` response only from the exact parent source and origin with exactly one transferred `MessagePort`. The parent can queue operations until initial load, then sends an exact `spawn:ready` UUID nonce on that same port; the client replies with `spawn:ready-ack` on the same port. Requests otherwise use the connected port for `spawn:request` and `spawn:response`; navigation does not reconnect, and `dispose()` closes the port. Identity includes a unique handle, display name, a same-origin `/api/v1/avatars/<UUID>` `avatarUrl` with an optional `?v=<16 lowercase hex>` cache version or `null`, and sandbox environment; it never includes email. The client also provides sandbox save load/save, unverified `submitScore`, and `requestPayment({ productId: 'entry' })`, which is fixed to a 10 `TEST` payment. Requests time out after 15 seconds, except payment requests at five minutes; at most 20 can be outstanding. The client has no live payment, arbitrary amount, player, recipient or approval method.

## Account-required game startup

Follow [the startup integration](startup.md) before enabling any play mode. Use the shared `@spawndotfamily/sdk/startup` controller, wait for trusted identity (and verified server admission for multiplayer), gate practice/bots too, and pause on connection loss. A handshake or grant alone is not multiplayer readiness. No automatic anonymous fallback. Keep an explicit isolated development launcher separate.

## Versioned game details

The source candidate includes local listing/image commands, available in Spawn’s TEST beta with scoped credentials. See [publishing.md](publishing.md#game-details-and-images). They use only documented metadata fields and file-based credentials, not browser player credentials. Metadata edits never approve or publish the game.

## Spawn-owned TEST payment flow

The platform provides **Confirm → Processing → Paid checkmark → Continue**, with a receipt visible in the player's history and the creator's payment history. This remains non-redeemable TEST behavior. Payer identity in those histories comes from the platform's authenticated account record; the game neither chooses the payer nor receives additional private account fields.

Keep the confirmation, progress, success and Continue controls in the Spawn-owned overlay outside the game. The game's deliberate optional action calls the existing `requestPayment({ productId: 'entry' })` method and waits for its validated paid receipt through the established SDK channel. Spawn owns when that request resolves after its paid/Continue flow. Do not advance the paid experience merely because the overlay opened, a message said success or a local flag changed. Cancellation, rejection and uncertain results do not grant paid eligibility. Ordinary game launch remains free.

A returned receipt lets the normal game flow continue; it cannot stop someone modifying their own browser to unlock local content. It also cannot prove that offline gameplay, a score or a reported win is honest. Do not add a second window-message listener for payment success or treat a browser-provided boolean, receipt object or ID as trusted authorization on a server.

For any paid leaderboard or reward participation, the platform must verify the recorded paid entry against the authenticated player, game and applicable participation context, with reuse rules enforced server-side. A legitimate payment does not make a browser-submitted score authoritative. This SDK currently supplies no paid-eligibility or reward-verification endpoint; leave such participation unavailable until a documented server contract is enabled. Do not invent a receipt lookup API or put creator credentials in the game.

A timeout can occur after payment was recorded. Use Spawn's supported receipt/history recovery flow when available to reconcile the original request; never blindly send another charge. The player and creator receipt views belong to the platform, not custom game-side payment history. TEST receipts remain non-redeemable and must not authorize real-money entries.

Use [local testing](testing.md) for fake accounts and the same isolated SDK handshake before uploading. The default client accepts only the launcher’s public origin configuration; it does not accept a player identity or payment permission from that configuration.


Local integration tests can exercise the complete fake entry → pool → manual reward loop in the launcher-owned creator panel. Follow [local testing](testing.md). Keep the browser client unchanged when moving to a private Spawn preview, and never fall back to local identity on connection failure. This is simulation coverage, not live-token or multiplayer-server validation.

## Platform fees and creator rewards

The approved TEST fee policy is 5% on tokens entering a creator pool: a 10 TEST payment means 0.5 TEST for Spawn and 9.5 TEST for the creator pool. The rate is configurable by Spawn; use the confirmed quote rather than hard-coding a permanent rate. The fee is included in the approved total, not added afterwards. Outgoing rewards and pool withdrawals incur no additional platform fee.

A creator may retain part of the available pool under their disclosed game rules; that is a creator fee, separate from Spawn’s platform fee. Explain entry cost, platform fee, creator retention and available rewards before participation. Do not add an unapproved player charge or invent an automatic creator-fee API.

The local launcher now models this split and shows a separate Spawn fee balance. Hosted fee migration and per-match multiplayer settlement are still being integrated; this paragraph does not enable a new reward endpoint. Existing SDK receipt fields remain compatible. AI agents must only call documented, available APIs and keep automatic payouts disabled if the required server settlement contract is unavailable.


### TEST payment receipt

`requestPayment({ productId: 'entry' })` resolves after the Spawn confirmation/Continue flow with `{ id: string, intentId: string, amount: 10, asset: 'TEST', environment: 'sandbox', status: 'paid' }`. Amounts are token units. Cancellation or failure rejects the request; do not unlock participation on rejection or infer success from an overlay. The receipt is not an authorization credential for server payouts.

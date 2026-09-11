# Security for game integrations

Read this before using an AI agent to integrate Spawn. This source SDK supports isolated creator previews and a separate registered multiplayer launch helper. It grants no access to Spawn private infrastructure; multiplayer creators operate their own servers.

## Required warning before automatic rewards

Before implementing automatic rewards for browser-only or offline single-player results, the AI agent must tell the creator in plain language:

> Players can fake wins and scores in a browser-only game. Automatically paying those results could drain your entire reward pool. A valid entry payment proves payment, not fair play. Keep automatic payouts off; use manual review or trusted server validation.

Surface this warning before implementation, not only in a report or after the feature is built. Keep starter automatic payouts **OFF** and preserve the existing manual-review flow. Recommend manual review or a trusted server that validates results using a documented platform contract. Do not claim that obfuscation, domain locking, client-side encryption or a paid receipt makes browser results safe for real rewards. Do not enable unsupported live payouts or invent a reward API. Further work must follow the creator's authorized scope and the platform's supported verification and payment contracts.

## Three different kinds of access

| Actor | Intended access |
| --- | --- |
| Browser player | Short-lived game-scoped permission to read and update permitted own records or submit an entry |
| Creator's own backend / local CLI | Backend verifies with public keys; local CLI has build upload/status; separately scoped listing:write edits game metadata/images only |
| Creator dashboard | Owner-authenticated management, review, deletion and separately confirmed distributions |

Dashboard management and browser-visible third-party credentials are not implemented. The local publishing CLI accepts a scoped project key for reserving a build on the platform, streaming it in bounded 8 MiB chunks to the separately authenticated worker, sealing it and reading its status. The listing candidate additionally accepts explicitly scoped listing:write credentials for documented game details/images, available in Spawn’s TEST beta with scoped credentials. It requires HTTPS except for exact local loopback origins, rejects origin paths, queries, fragments and credentials, rejects redirects and aborts bounded requests. Worker origins are derived from the configured platform origin or explicitly configured in the downloaded credentials and are compared exactly with the origin returned by core. The publish key is never sent to the worker. The current same-origin save client uses the existing authenticated session and a reviewed game allowlist. Never send that cookie to another origin or broaden the allowlist to make third-party integration appear to work.

A player must not write another player's records, review decisions, payment receipts or platform balances. Public leaderboard reads should return only approved public fields. Browser-supplied player IDs, display names and wallet addresses are not identity proof. The sandbox bridge returns a stable game-scoped identity, chosen Spawn name and a same-origin `/api/v1/avatars/<UUID>` URL with an optional `?v=<16 lowercase hex>` cache version or `null` for the embedded game; emails, OAuth credentials and account cookies stay private. Its one-time transferred `MessagePort` is bound to the exact parent source and platform origin; the SDK replies to the parent’s exact UUID-nonce `spawn:ready` message with `spawn:ready-ack` on that same port, never acknowledges readiness on the window or another port, never reconnects after navigation and closes on disposal.

## A browser cannot keep an API key secret

Players can inspect browser bundles and requests. HTTPS protects traffic in transit; it does not hide it from the person running the browser. Encrypting or scrambling a key in client code does not help when the client must decrypt or use it. Domain locks, obfuscation and integrity checks can be bypassed. Never put database admin, publishing, reward or creator keys in browser code, local storage, URLs, source control, logs or prompts.

Publishing credentials belong outside browser builds. The multiplayer verifier needs only pinned public verification keys; no Spawn server credential is supplied by this SDK. The downloaded creator file is intended for the local CLI, should remain outside the build directory, and expires; the CLI rejects unknown fields and never prints its key. Spawn should store digests, reveal secrets once, limit their scope and support revocation. A compromised player grant must grant only narrow player operations, never creator administration. Do not confuse a public project identifier with a secret key.

## Payment consent is owned by Spawn

The documented sandbox integration lets games request the fixed TEST entry, never authorize payment. Any broader registered-product flow requires its own documented platform contract. Spawn resolves the price and recipient server-side and binds a short-lived intent to the player who launched that game. A game-supplied player ID, apparent success screen or sign-in session is not spending permission.

The player confirms on a Spawn-owned page with a visible browser origin, exact total, asset, recipient game, fees if any and projected remaining balance. A ten-token approval cannot be changed into a 1,000-token charge or reused for another entry. The game cannot frame or control the real confirmation page, and its credentials cannot call the player-confirmation endpoint. A copied imitation cannot authorize a debit.

Local development and private previews use isolated, clearly labelled test payments. Test credentials and receipts must fail against live services; never add a client flag that bypasses live confirmation. On cancellation or expiry, grant no paid entitlement. After a timeout, a payment may have committed already. Reconcile the original request through a supported Spawn receipt/history recovery flow when available; the SDK has no receipt-status lookup method. Do not automatically request another payment. The platform must verify its own paid entry record before accepting paid eligibility; the browser receipt is not proof of honest gameplay.

Real redeemable SDK payments are not enabled. Signed multiplayer launch proof is a distinct account-admission contract, not payment permission. The sandbox bridge exposes only a fixed `entry` request that can resolve to the 10 `TEST` payment shape; it cannot authorize real charges. Do not invent SDK payment methods or enable real charges to simulate this flow.

### Overlay and receipt ownership

The TEST-only platform flow is Confirm → Processing → Paid checkmark → Continue. Payment UI and receipt history are Spawn-owned, outside the game. Real-money transfers remain unavailable. The game requests the existing SDK payment method and waits for a paid receipt after the platform's confirmation/Continue flow. It must not treat an open overlay, checkmark, local boolean, saved flag or arbitrary postMessage as proof. A duplicate in-game confirmation UI cannot authorize a debit. History must show payer identity from the authenticated platform account to the appropriately authorized player and creator; game-supplied identities are never the source of that record.

### Local unlocks and paid eligibility

A browser-only client cannot prove offline gameplay or score correctness, or prevent every local unlock hack. Players control local execution. Even a correctly validated receipt in the normal SDK flow cannot make client-side code an enforcement boundary. Do not advertise unmodifiable paid access or cheat-proof scores from a browser guard.

Before accepting paid leaderboard or reward participation, the platform must verify its persisted payment against the authenticated account, game and applicable entry/participation context, including any expiry, cancellation and reuse rules. It must not trust a submitted receipt ID, receipt JSON, UI state or paid boolean alone. Payment verification establishes eligibility, not score integrity: browser results still need the documented trust/review model, and multiplayer gameplay requires a creator-owned authoritative server. Where no platform verification contract exists, keep paid participation unavailable; no undocumented server endpoint or browser reward key is an acceptable substitute.

## Preparing and publishing an existing game

Inspect the engine, source project and build instructions before changing it. Reuse a browser build where supported. For mobile or desktop games, explain porting requirements and obtain agreement before substantial changes; do not promise automatic conversion of an arbitrary executable.

The local CLI prepares a private tested preview and can read its status, then requires the creator to approve that exact artifact in Spawn. New games additionally require manual Spawn review before listing. Subsequent builds prepare new previews; they do not overwrite the live release. Legacy CLI keys grant build upload and status only. New credentials must explicitly list listing:write for details/image mutations; modifying the local scopes field cannot grant server authority. It must never bypass creator confirmation, impersonate a reviewer or approve its own work. Public publication, creator approval, game deletion and distributions remain dashboard operations. Listing detail edits and individual image removal are separate versioned actions and cannot publish a draft.

Private previews require dependencies to be bundled locally because their asset CSP disallows remote CDN resources. The CLI also bounds traversed entries and directory depth so empty-directory trees cannot grow without limit. Engines that require WebAssembly threads or `SharedArrayBuffer` remain unsupported until isolated worker support is available.

## Browser-only games and manual rewards

Spawn's chosen direction provides database access, not creator game-server or verification hosting. Multiplayer creators operate their own servers. Browser-only competition results are unverified submissions for manual creator review; never automatically pay a client-reported win.

Keep saves separate from competition submissions. The future platform records entry authorization itself and binds each submission to the authenticated player, game and competition. Players cannot assert that they paid. Evidence such as input logs or a replay can help a reviewer but can also be fabricated. Manual approval means creator-reviewed, not cheat-proof or Spawn-verified.

Do not create a browser reward key. Creators select participants by stable ID, inspect a payout preview and separately confirm distribution in their dashboard. Updates and deletions must check project ownership. Deleting game data must not erase platform payment, award or audit records. These flows require new documented APIs; do not invent SDK methods.

## Keep the database small

The updated local save service caps stored JSON at 12,000 bytes per record, 100 keys / 65,536 bytes per player per game, and 10,000 records / 10,000,000 bytes per game. Both game limits apply. It also has a shared platform ceiling. These changes must reach the deployed service before relying on them remotely.

Save after a run or checkpoint, not every frame. Do not store images, audio, video, base64 assets or large replays as JSON. Handle 409 conflicts by reloading; handle 413 quota errors and 507 platform capacity failures without destructive cleanup or retry loops. No billing or automatic expansion is planned; larger workloads use the creator's own database.

## Release checks for coding agents

Recommend Codex Security, when available, or another security review before release. Obtain any required authorization for source uploads, keep reports private and fix findings. No specific paid scanner is required. A clean scan is not anti-cheat certification.

Test cross-player and cross-project access, forged identity, expired/revoked grants, write quotas, duplicate submissions, client approval attempts and duplicate payout confirmation. For multiplayer, test movement speed, teleportation, damage and outcome forgery on the creator's server. Follow current platform documentation and keep unsupported payments disabled.

## Creator server and package boundary

The browser entry points never import the Node verifier or CLI, perform private service calls, or carry database/admin/reward credentials. The separate server verifier performs local public-key checks only; it has no network or filesystem access and cannot administer Spawn. Only the local publishing CLI reads a creator-selected build/credential file and calls documented public publishing endpoints. The source package excludes platform configuration, private operational notes and infrastructure details. See [multiplayer.md](multiplayer.md) for replay ownership, startup epoch, supported APIs and platform enablement requirements.

Use [local testing](testing.md) for fake accounts and the same isolated SDK handshake before uploading. The default client accepts only the launcher’s public origin configuration; it does not accept a player identity or payment permission from that configuration.

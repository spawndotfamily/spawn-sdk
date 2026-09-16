# Changelog

## 0.7.1 — 2026-09-17

### Added
- Structured match diagnostics: stable SDK error codes, bounded public rejection reasons, operation/match/project context, optional platform code/request ID and retry delay, plus private-journal `toJSON()`.
- Packaged, tested match-creation recovery example and `docs/match-recovery.md`, including uncertain creation followed by a 404 and exact same-ID cancellation before replacement.

### Changed
- The server match client now reads bounded API error JSON instead of discarding the useful reason. Malformed error bodies retain HTTP status; raw responses, credential reflections and transport exception text stay excluded.
- HTTP 408 mutations are uncertain. A later status 404 or same-ID create rejection never proves an earlier request cannot finish. No automatic mutation retries were added.

### Upgrade notes
- Pin `0.7.1`, rebuild and redeploy your authoritative server to use the new errors. Read AGENTS.md, docs/match-payments.md and docs/match-recovery.md; journal the original definition and each error before attempting recovery.
- Keep existing unresolved records. Use the same saved ID, wager and roster; allow replacement only after confirmed cancellation. Expired launches or service failures can still require platform investigation. No absent-ID tombstone endpoint is introduced.
- SDK-only update: no game files, platform logging or server configuration are deployed by installing it. Optional platform codes and request IDs appear only when the hosted API supplies them. Historical discarded reasons cannot be reconstructed by this release.

## 0.7.0 — 2026-09-16

### Added
- Creator self-service `spawn-publish server status`, `server enable` and `server disable` commands. Register the game's HTTPS server, audience and dedicated match authority through fresh downloaded credentials with `server:configure`; no Spawn VPS access or operator-created match key is required.
- Locally generated private key files, public launch-verification configuration, safe retry reconciliation, versioned rotation and immediate match-key revocation.
- Packaged `docs/server-setup.md` with an end-to-end agent workflow, permission boundaries, failure handling and separate server deployment/settlement verification.

### Changed
- Replaces the manual operator-activation instructions with the generic creator setup flow. Existing games preserve their storage credentials when enabling or rotating match authority.
- Server setup sends only key hashes to Spawn and grants no OS commands, SSH, arbitrary file access, other-game authority or player payment approval.

### Upgrade notes
- Pin 0.7.0 and download fresh game credentials. Old publishing keys do not gain `server:configure` by editing the local file. Read `docs/server-setup.md` before enabling matches.
- Configure the Listing token, obtain the current server settings version, then run server enable with explicit creator confirmation and a private output directory. Preserve files for retry; use a new directory for deliberate rotation.
- Deploy the authoritative game server yourself and install the generated files privately. SDK installation/browser publication alone do not deploy it. Verify two consenting members' payouts and refunds separately; setup moves no tokens.
- Requires the matching hosted creator setup API. If it is unavailable, report that platform dependency; never substitute privileged Spawn infrastructure access. Direct trades continue using player approvals without a match key.

## 0.6.1 — 2026-09-16

### Added
- Added a packaged agent deployment/activation checklist distinguishing browser publication, running authoritative server code, dedicated match-key setup and two-member settlement verification.
- Added a non-secret operator handoff template and clear setup-state messaging; publishing credentials never grant payout authority.

### Changed
- Corrected active integration guides: hosted demo TEST credits are retired. Configure an admitted Listing testnet token; missing token settings no longer imply a hosted TEST fallback. Isolated local simulation and historical receipt types remain compatible.
- Clarified that player-approved trades need no match key and move platform balances; on-chain withdrawal is a separate Wallet action.

### Upgrade notes
- Pin 0.6.1 and have your game agent reread AGENTS.md and docs/match-payments.md, especially the deployment and activation handoff. Complete the game server build/deployment separately from the browser upload.
- This documentation patch adds no new endpoint or automatic activation. Existing match and trade APIs are unchanged. Dedicated match activation remains a separate operator action; report its exact missing dependency instead of claiming matches are unsupported.

## 0.6.0 — 2026-09-16

### Added
- `client.trades` on isolated browser and registered multiplayer clients: context, create, get, offer, accept and cancel.
- Player-authorized direct gifts and atomic two-way transfers of the Listing testnet token, with exact amounts, zero transfer fees and shared Spawn sender approval.
- Packaged agent guide covering authenticated member-only recipients, versioned offers, five-minute expiry, settlement status and safe retries.

### Changed
- Clearly separates match escrow from direct player transfers and independent game item ownership. Guest accounts cannot send or receive trade tokens.

### Upgrade notes
- Pin 0.6.0, rebuild the browser bundle, and read `docs/trades.md`. Use the matching hosted trade service; no dedicated trade or match settlement key is needed for player-approved trades. Registered multiplayer admission still uses its existing setup.
- Show completion only after Spawn returns `settled`. Offer changes reset both approvals. Approval moves no funds; if either balance becomes insufficient, neither transfer completes. Query the same ID after uncertain responses.
- This release settles tokens only, not item ownership in an independent game database. Item-only interactions need no SDK payment popup; earned or purchased items require tracked ownership before secure exchange. `spawn-dev` does not emulate two-account settlement.

## 0.5.0 — 2026-09-16

### Added
- `createSpawnMatchClient` and `SpawnMatchRequestError` from `@spawndotfamily/sdk/server` for registered two-player matches: create, status, capture, heartbeat, cancel and settle.
- Exact decimal entry and payout amounts with the asset resolved from Listing; player-approved reservations, server-owned outcomes and zero Spawn transfer fees.
- An agent setup guide covering dedicated server activation, verified launch identities, the shared confirmation overlay, escrow deadlines, full-pot settlement, a one-hour absolute match limit and uncertain-outcome recovery.

### Changed
- Clarified that supported Listing tokens on Robinhood Chain Testnet can fund player-versus-player matches; they must not be silently replaced with local play points or confused with mainnet settlement.
- GitHub release bodies no longer repeat the SDK version heading already displayed as the release title.

### Upgrade notes
- Install and pin 0.5.0, rebuild the browser bundle, and read `docs/match-payments.md` plus `AGENTS.md`. Import the match client only on your authoritative server; browser code continues using `requestMatchEntry({ matchId })`.
- Requires the matching hosted registered-match service and explicit per-project server activation with a dedicated match credential. Installing the SDK, publishing a game, or registering transport alone does not grant payout authority. No self-service match-key issuance is included.
- The Listing controls the token, while `create({ amount })` controls each player's separate match entry. Permanent game access remains a distinct purchase. Match settlement can distribute only the complete reserved pot to the two admitted roster players.
- Mutations never automatically retry. On an unknown outcome, query the same match ID and reconcile before proceeding. The existing Rob the Rich duel/raid integration remains separate and compatible.

## 0.4.1 — 2026-09-16

### Added
- Explicit `spawn-publish release --release <release-id> --creator-confirmation` (also available as `spawn-publish publish --release ...`) publishes an existing, tested release through the owner-scoped platform endpoint.
- Release status output includes the automated malware-check metadata and the next action needed before publication.

### Changed
- Uploading a browser build remains preview-only; the CLI never publishes it implicitly. Publication sends exactly `{ "played": true }` after the creator explicitly confirms the tested preview.
- Credential parsing accepts the new `build:publish` scope metadata while leaving authorization to the platform, so existing active project credentials remain compatible.
- Creator guidance now describes owner-selected publication after automated checks and play-testing; no first-listing staff review is required.

### Upgrade notes
- Upload as before, poll `spawn-publish status <release-id>`, then run `spawn-publish release --release <release-id> --creator-confirmation` when the exact preview has passed its automated check and has been play-tested. A legacy platform may return `pending_review`; inspect the returned status and follow its platform workflow.
- Publication remains project-scoped and server-gated by the exact release scan, owner credential, and suspension state. Keep credentials outside browser builds and never treat the local scope list as authority.

## 0.4.0 — 2026-09-15

### Added
- Runtime validation rejects optional token payment requests without an explicit amount before contacting the game host.

### Changed
- **Breaking:** `requestTokenPayment` now requires an explicit `amount` in both the TypeScript options and runtime request. Use it only for a separately documented optional payment; the Listing `entryAmount` remains the permanent game-access purchase and is never charged again as a default.
- New game payments and creator-pool transfers in the local SDK simulator settle one-to-one with a 0% Spawn platform fee.
- Historical fee fields remain available on receipts; pending quotes created under the prior fee policy must be re-quoted.
- Creator guidance distinguishes the Listing's permanent game-access purchase price from separately requested custom payments and avoids charging the default entry price twice.

### Upgrade notes
- Update callers that used `requestTokenPayment()` or omitted `amount`; pass an exact positive human-readable decimal string, with `item` optional. The SDK rejects omitted amounts before sending a bridge request.
- Legacy `requestPayment('entry')` still returns fixed 10 TEST when no token is configured. With a configured Listing, it represents the permanent access purchase and returns the existing purchase receipt or a no-purchase-needed error after access instead of starting another default-price debit.
- This release is a breaking pre-1.0 API change; rebuild browser games with SDK 0.4.0 before selecting a Listing token.

## 0.3.0 — 2026-09-15

### Added
- Listing token commands (`spawn-publish token search`, `token get` and `token configure`) resolve enabled Spawn launches or explicitly approved partner assets and update this project's token entry settings through the scoped CLI.
- `requestTokenPayment({ amount?, item? })` requests an optional entry amount using the single token selected in the project Listing and returns the configured payment receipt shape.

### Changed
- `requestPayment('entry')` uses the Listing's selected asset and default entry amount when configured, while retaining the fixed 10 TEST fallback when no token is selected.
- Configured payment receipts are `{ id, assetId, amount, projectId, status: 'paid' }`; `amount` is an exact integer base-unit string. Browser requests contain no token address, recipient, player ID or fee, and Spawn's trusted overlay owns confirmation.
- Creator guidance now distinguishes historical TEST sandbox payments from non-redeemable testnet token entries and documents exact decimal input without floating-point conversion.

### Upgrade notes
- Configured entries require a platform deployment with the token catalogue, versioned Listing token settings and quote/confirmation routes. Hosted configuration is limited to admitted assets on chain ID 46630; chain ID 31337 is for loopback testing only. No mainnet or live-money behavior is enabled.
- Token settings writes require a newly downloaded credential with `token:configure`; existing credential files do not gain that scope. The CLI updates the Listing asset and default amount together and uses version `0` for first configuration.
- Games should keep token selection in the Listing and call `requestTokenPayment` with only an optional exact human-readable decimal amount and item label. Games without a configured token continue using the historical TEST receipt contract.
- `requestPayment` now has a TypeScript union return (`SpawnTestPayment | SpawnTokenPaymentReceipt`). Narrow with `'assetId' in receipt` before reading token fields, or use the TEST branch for `asset`, `intentId` and numeric `amount`. The historical TEST receipt remains available at runtime, but the union is not source-compatible with code that assumes the old TEST-only return type.
- Republish a game with SDK 0.3.0 before selecting a Listing token. `requestPayment` advertises token-receipt validation before charging; older SDKs can reject a configured token receipt after payment. Existing TEST hosts ignore this marker and keep the legacy fallback.
- `requestTokenPayment` accepts an optional UUID `requestId`; reuse the same ID, amount and item when retrying an uncertain result, and use a new ID for a deliberate purchase. The SDK generates a UUID when omitted.

## 0.2.14 — 2026-09-14

### Added
- Guest identities with unique game-scoped IDs and explicit free-play capabilities.
- Guest mode in the local launcher, including denied score, save and payment tests.
- Explicit server-verifier opt-in for signed free-only multiplayer guest grants.
- A concise guest integration guide for creators and their agents.

### Changed
- Human-facing README and shared startup guidance distinguish guest play from account features.
- Identity version negotiation keeps older launcher and SDK integrations compatible.

### Upgrade notes
- Hosted guest play requires the corresponding platform deployment. Older hosts continue to work with their existing member identity shape.
- Guest IDs identify a browser session, not a unique human. Guest scores and progress do not become account results after login.
- Creator servers must enforce free-only admission, exclude guest rewards/results and explicitly enable allowGuests before accepting guest grants. The default remains member-only.
- No payment, account-storage, private-preview or iframe permissions are expanded for guests.

## 0.2.13 — 2026-09-14

### Added
- Versioned listing CLI supports `devices: ["browser"]` or `["browser", "mobile"]`, including reads and validation before upload.

### Changed
- Creator guidance explains testing phone controls and using Spawn's shared mascot loading screen.

### Upgrade notes
- Device metadata requires the matching platform deployment. Old listing responses without devices remain compatible.
- Hosted loading improvements apply without rebuilding a game. No changes to identity, payment confirmation, storage permissions or iframe isolation.

## 0.2.12 — 2026-09-13

### Added
- Creator database commands before any upload: register-self, add-score, edit-score and remove-score.
- Step-by-step examples for hosted data access from a local agent, separate from the credential-free simulator.

### Changed
- README storage limits now match the current hosted quotas: 64 KiB per record, 1 MiB per player, 100 MB per game.
- Agents are told not to require publication just to inspect a game's database.

### Upgrade notes
- New commands require the matching platform deployment and credentials with data permissions. Existing read/write commands remain compatible.
- register-self uses the credential owner's real game identity; it does not create fake accounts. Creator-added scores are marked unpaid and unverified, with retry IDs. Edits do not authorize rewards.
- Browser identity, overlay, sandbox and payment confirmation are unchanged. Network failures remain separate from SDK installation.

## 0.2.11 — 2026-09-13

### Added
- Private creator database CLI: read players, scores and nested saves; version-checked save edits/removal; configure score sharing after asking the creator.
- Missing relative JavaScript module checks before streaming upload and local testing, including re-exports and literal dynamic imports.
- Packaging and connection troubleshooting for creator agents.

### Changed
- New credentials support explicit database scopes; older credentials retain their existing authority.
- Agent guidance bundles the full browser dependency graph and keeps database configuration out of game code.
- CLI includes pinned es-module-lexer 3.0.2 to inspect imports without executing game code. Browser transport and payment consent remain unchanged.

### Upgrade notes
- Database tools require the matching platform deployment and a newly downloaded creator credential. Never put that file in the game build or change its scopes manually.
- Rebuild and run check, spawn-dev and a private preview. Import checking is bounded and does not certify playability or security.
- Network/TLS resets on affected connections remain separate; this release does not resolve them.

## 0.2.10 — 2026-09-13

### Added
- Hosted-overlay acceptance checks for creator agents, including toast dismissal and removal of duplicate game-drawn banners.

### Changed
- Agent instructions define one consistent hosted overlay: a brief top-right connection toast and bottom-right Transactions button, supplied by Spawn.
- Existing-game guidance removes duplicate Spawn badges/toolbars and distinguishes local developer panels from published UI.

### Upgrade notes
- Documentation-only release; transport, identity, payment, storage and publishing APIs are unchanged.
- Spawn’s launcher fix applies to existing integrations without reinstalling. Upgrade the agent guide to 0.2.10 when editing a game, and remove any Spawn banner drawn by the game itself.
- Verify the hosted preview after updating; the package alone does not deploy the platform launcher.

## 0.2.9 — 2026-09-13

### Added
- Read your game's leaderboard inside the game, with stable game-specific player IDs and pagination.
- List and delete the connected player's save records; store nested inventories, equipment and progress as JSON.
- Optional score submission IDs prevent duplicate records when retrying the same run.
- Local testing includes creator-controlled leaderboard sharing and best/latest/all score views.
- Public release notes and a tested GitHub-to-npm release workflow without a stored npm publishing token.

### Changed
- Validate nested JSON saves and document hosted storage limits: 100 MB per game, 1 MiB per player/game and 64 KiB per record, subject to record counts and shared capacity.
- Agent instructions check for SDK updates at the start of an editing session and ask before upgrading.

### Upgrade notes
- Existing supported identity, save, payment and score calls remain available; no forced upgrade.
- New data methods require SDK 0.2.9 and the matching Spawn platform update. Enable leaderboard sharing in Players & rewards before exposing scores in your game.
- Best/latest policies filter the leaderboard view; raw runs still use storage until removed. Browser scores and saves remain untrusted and do not authorize automatic rewards.
- Install the chosen version with `npm install --save-exact --ignore-scripts @spawndotfamily/sdk@0.2.9`, test locally, then verify a private preview.

## 0.2.8 — 2026-09-13
- Add a short creator capability menu and one-prompt handoff; separate TEST currency from release status.
- Simplify creator AGENTS.md, retain detailed maintainer contracts, remove repeated payment-flow text.
- Clarify existing-game folders, browser play-test evidence and approval boundaries.
- Release the existing document-bound multiplayer match-entry presentation request for explicitly enabled games. It does not authorize admission, results or payouts.

## 0.2.7

- Prepare the first public npm package as `@spawndotfamily/sdk`; the `@spawn` npm namespace is unavailable. Existing source integrations may migrate their imports or use an npm alias.
- Include compiled modules, the publishing/local-testing CLIs, and agent integration instructions in the package. Creators can install a pinned version without a separate SDK checkout or build.
- npm installation does not change the upload API, its authentication, or fix network/TLS failures reaching Spawn.


### Earlier 0.2.7 development changes

- Keep direct private-preview upload independent of GitHub connection; source inspection remains optional after npm became the default installation path.
- Add validated local rebuild/rescan and launcher-only diagnostic state for agent verification.

- Model configurable incoming platform fees in the isolated TEST launcher, with separate creator and platform balances and fee-free outgoing rewards.
- Document platform fees separately from creator retention. Hosted per-match settlement remains pending; no new reward API is exposed.

## 0.2.6 — 2026-09-11

- Verify each upload chunk against the inspected build before transmission; stop if local files change during publishing.

- Stream browser build manifests and 8 MiB file chunks through the separate artifact worker, with incremental SHA-256 hashing and bounded retries.
- Set an 8,000,000,000-byte client safety ceiling for remote streaming; the platform defaults admission to 1,000,000,000 bytes and may grant an owner-controlled allowance up to that ceiling. Preserve the local 25 MB helper only for legacy loopback reference tests.
- Require the worker origin returned by core to match the derived or explicitly configured origin; complete releases with the platform publish credential only.

## 0.2.5 — 2026-09-11

- Add a launcher-owned fake creator wallet and game pool. Confirmed entry payments fund the pool exactly once; local operator controls fund, withdraw and reward test players.
- Show local transfer receipts and unverified score submissions. Keep all fake balances in memory and all creator controls outside the game bridge.
- Document identical local/hosted client setup, no automatic fallback and private-preview validation. Hosted accounts remain TEST-only.


## 0.2.4 — unreleased candidate

- Add a loopback-only local launcher with isolated fake accounts, saves, unverified scores and explicit TEST payment consent.
- Add credential-free browser artifact checks and optional validated launcher-origin configuration.
- Document browser export constraints, GitHub repository/Actions imports and the required private-preview approval step.
- Include a pinned manual GitHub Actions build example; no source build runs on Spawn infrastructure.

## 0.2.3 — TEST beta package

- Add scoped local listing get/update and image add/replace/remove commands, verified against the platform TEST beta.
- Preserve legacy build credentials; require explicit listing:write for versioned metadata mutations, with no automatic conflict retry.
- Share bounded, cookie-free, redirect-rejecting CLI transport; bound input files and response sizes.
- Document creator-only details/image authority separately from publication, ownership, pricing and reward operations.

## 0.2.2

- Added engine-independent account startup lifecycle with coalesced Retry, bounded timeout, cancellation, immutable state and disconnect invalidation.
- Added optional nonce-bound multiplayer connection presentation notifications; no authorization contract changed.
- Documented account-required gating for all gameplay modes and the distinction between bridge readiness and server admission.

## 0.2.1

- Separate bounded initial document loading from multiplayer handshake confirmation; keep one document, nonce and port, and unchanged grant deadlines.
- Include the complete creator integration/security/testing/publishing checklist in the package, including free launches and optional fixed TEST actions.

## 0.2.0

- Added a generic, document-bound multiplayer browser client and separate public-key verifier for creator-owned Node servers.
- Added bounded one-time grant consumption, startup epoch protection and explicit game/audience/environment configuration.
- Added self-contained multiplayer/security guidance and plain JavaScript examples; optional player save storage is the primary creator integration.
- Marked the old first-party same-origin save client deprecated without broadening its cookie access or removing compatibility.
- No private platform credentials, VPS administration, hosted creator servers, live payments, trusted browser scores or automatic bans are exposed.
- Multiplayer activation requires the matching Spawn parent protocol and explicit game/server enablement; self-service server registration is not implemented.

- Multiplayer: optional document-bound resource-path refresh for uninterrupted long-running game sessions and reconnects.

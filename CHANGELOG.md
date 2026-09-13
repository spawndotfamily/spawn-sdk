# Changelog

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

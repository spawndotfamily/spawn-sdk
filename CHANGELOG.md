# Changelog

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

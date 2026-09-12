# Spawn SDK

Integrate a browser game with Spawn without access to Spawn's private infrastructure. Creators operate their own multiplayer servers. Spawn provides an optional small, player-and-game-scoped save store; it does not provision creator servers or give creators access to its database engine, VPS or administrator services.

This is source candidate **0.2.6**, not an npm-published release. Build or install the supplied source package locally; bundle browser dependencies with your game. No UI framework or runtime SDK dependency is required.

## Choose an integration

| Entry point | Purpose | Availability |
| --- | --- | --- |
| `@spawn/sdk` → `createSpawnGameClient` | Isolated uploaded preview: public player label, own saves, unverified submissions and fixed TEST entry receipts | Implemented preview contract; requires a Spawn-launched `/build/...` document |
| `@spawn/sdk/multiplayer` → `createSpawnMultiplayerClient` | Request short-lived signed launch proof for your own game server | Requires Spawn to enable the game/server and the generic multiplayer parent protocol; SDK alone does not enable registration |
| `@spawn/sdk/server` → `createSpawnLaunchVerifier` | Verify that proof on your Node server using pinned **public** keys | Local helper, no network calls, hosting, account administration or access to Spawn storage |
| `spawn-publish` | Upload a prebuilt browser directory and check its private preview | Scoped, expiring publishing credential; listing details/images require explicit listing:write and platform availability; never publication approval |

Multiplayer self-service server registration is not available. The generic parent protocol is a coordinated platform activation dependency. Existing reviewed games may use the legacy protocol until migration; new SDK game builds must wait for generic-protocol activation. The SDK must not be used to guess undocumented endpoints. A creator needs no Spawn VPS address, login, internal URL or private signing key.

## Optional saves in an uploaded preview

```js
import {createSpawnGameClient} from '@spawn/sdk';
const spawn=createSpawnGameClient();
const prior=await spawn.load('progress');
await spawn.save('progress',{level:3},prior?.version??0);
window.addEventListener('pagehide',()=>spawn.dispose(),{once:true});
```

The launcher supplies the public platform origin; an explicit trusted origin can override it. Local preview development uses literal loopback HTTP. The client operates inside the isolated Spawn frame; it never forwards an account cookie to the game origin. Save at checkpoints, not each frame. Handle conflicts and quota errors without deleting unrelated records.

Limits: 12,000 bytes per record, 100 keys / 65,536 bytes per player per game, and 10,000 records / 10,000,000 bytes per game, subject to shared platform capacity. These are small JSON saves, not an asset/replay store or database-administration connection. Larger storage belongs on your own service. A raw SQL, creator-backend database credential or arbitrary query API is not supplied.

Player identity returned in a browser is display information. Saves and submitted scores are untrusted. No wallet, real charge, redeemable reward or guaranteed anti-cheat is provided. Existing `requestPayment('entry')` is fixed sandbox TEST behavior, not live payments.

## Multiplayer on your own server

Use the browser module to request launch proof and the separate server module to verify it. See [the complete multiplayer guide](docs/multiplayer.md) and [plain JavaScript examples](examples). Keep server code outside the uploaded browser build. Your game server controls connections, movement, health, damage, scores and sessions. Never treat a browser-supplied player ID as authority.

## Build and publish a private preview

Requires Node 22.13+ and npm. Run `npm ci`, `npm test`, `npm run check`, and `npm run build`. Build output includes JavaScript and TypeScript declarations; plain JavaScript games can copy the required compiled browser module locally. The SDK is not a CDN dependency and `@spawn/sdk/server` must never be bundled into browser assets.

```sh
npm run spawn-publish -- publish ./game-build --credentials ~/Downloads/spawn-project-<projectId>.json
npm run spawn-publish -- status <release-id> --credentials ~/Downloads/spawn-project-<projectId>.json
```

The downloaded credential is for your local publishing CLI only. Keep it outside the game build, source, logs and prompts. Remote publishing streams a manifest and bounded 8 MiB chunks through Spawn’s isolated upload worker; local reference installations without a worker retain the bounded legacy path. The creator approves that exact artifact in Spawn, and listing remains platform-controlled. See [publishing instructions](docs/publishing.md) for limits and options.

Read [security boundaries](docs/security.md) and [integration details](docs/integration.md) before shipping. `createSpawnClient('rob-the-rich')` remains a **deprecated, reviewed first-party compatibility API**; creators should use the isolated client above. Its same-origin cookie allowlist is deliberately unchanged.

Source is MIT licensed. Spawn branding and third-party game assets are not included in that license.

## Creator integration workflow

Agents integrating an existing game must follow [the complete creator checklist](docs/creator-checklist.md), starting from the downloaded credentials and verified platform SDK package. Keep ordinary launches free; optional fixed TEST interactions require a separate deliberate player action and Spawn confirmation. Multiplayer launch readiness allows up to 45 seconds for initial document loading, then 8 seconds for channel confirmation. Grant requests keep their 8-second deadline. Navigation still permanently closes that document.

## Account-required game startup

Follow [the startup integration](docs/startup.md) before enabling any play mode. Use the shared `@spawn/sdk/startup` controller, wait for trusted identity (and verified server admission for multiplayer), gate practice/bots too, and pause on connection loss. A handshake or grant alone is not multiplayer readiness. No automatic anonymous fallback. Keep an explicit isolated development launcher separate.

## Game details and images

The CLI provides `listing get/update` and `image add/replace/remove` using a downloaded credential file. These endpoints are enabled in Spawn’s TEST beta; use the package and scopes supplied by your platform. Follow [the exact commands and limits](docs/publishing.md#game-details-and-images). Old keys remain build-only; new listing edits require explicit `listing:write`. Editing metadata does not publish a draft or bypass review.

## Local testing and GitHub

Run `./node_modules/.bin/spawn-publish check ./dist`, then `./node_modules/.bin/spawn-dev ./dist` to test the unchanged game SDK with fake local accounts and a mandatory TEST confirmation overlay. The local creator panel also supports pool top-ups, withdrawals and manual rewards to fake players, with transfer receipts and unverified scores. No credentials are needed. These controls never grant the game creator authority. Follow [the testing guide](docs/testing.md), then test a private Spawn preview before approval.

The website's GitHub importer accepts a prebuilt repository folder or an Actions artifact named `spawn-browser-build`. Private repositories require a configured GitHub App and creator authorization. Build scripts run on the creator's computer or their GitHub Actions runner, never on Spawn's accounts server. See [publishing](docs/publishing.md#github-builds).

Multiplayer integrations can refresh protected game-server resource paths through the established admission channel without reloading the game. See [long-running game windows](docs/multiplayer.md#long-running-game-windows).

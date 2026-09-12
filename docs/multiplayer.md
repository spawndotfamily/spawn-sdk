# Multiplayer on your own server

Spawn does not run creator game servers or expose private platform services through the SDK. You operate your own server, transport, simulation and larger database. Spawn's optional small save store is a player-scoped API, never a database login or SQL connection.

## Before integration

Multiplayer must be explicitly enabled for your game by Spawn. Self-service server registration is not implemented. Supply your HTTPS game origin and WSS endpoint through the approved registration process. Obtain the **public** verification configuration for that game: issuer, audience, game ID, environment, key IDs and Ed25519 public PEM keys. None of this requires access to Spawn's hosting account, VPS, private service URLs or signing key.

The SDK's generic multiplayer document protocol must also be enabled on the platform. A package install alone cannot make a game eligible or change the frame's connection allowlist. Uploaded preview saves and registered multiplayer launches currently use distinct document contracts; do not assume optional save storage is exposed in a multiplayer frame unless that capability is enabled for it.

## Browser module

```js
import {createSpawnMultiplayerClient} from '@spawndotfamily/sdk/multiplayer';
const spawn=createSpawnMultiplayerClient({
  platformOrigin:'https://spawn.family',
  serverOrigin:'https://game.example'
});
await spawn.ready();
const {ticket}=await spawn.requestGrant();
```

Replace `game.example` with your registered origin. Pin both origins in trusted game configuration; do not take either from player input or a received window message. The constructor requires exact HTTPS origins; literal `localhost`, `127.0.0.1` and `[::1]` HTTP origins are supported for controlled local development. Spawn and your game server must be different origins.

`ready()` waits for the full parent/channel confirmation. `requestGrant()` returns `{ticket}` after that confirmation and coalesces concurrent requests. Keep the ticket in memory and send it as your game protocol's first authentication message over WSS, never in the URL, a log or persistent browser storage. The browser cannot verify ownership by reading this token or calling `identity()`; your server decides whether the proof is valid. A player being able to inspect their own short-lived proof does not give them signing authority.

When Spawn has enabled match entry for your game, use `requestMatchEntry({ matchId })` for the Spawn-owned TEST confirmation flow. It returns a presentation acknowledgement only; it does not authorize admission or signal that a reserved match has started. See [match-entry presentation](match-payments.md).

Call `dispose()` on teardown. Page navigation disposes automatically, rejects pending work and prevents reconnecting the old document capability. A timeout or closed launch requires a visible recovery path; do not silently use a claimed identity. Keep your game's existing offline/practice path independent.

## Server-only module

```js
import {createSpawnLaunchVerifier} from '@spawndotfamily/sdk/server';
const verifier=createSpawnLaunchVerifier(publicVerificationConfig);
if(!verifier.configured)throw new Error('Configure Spawn public verification.');
const player=verifier.consume(ticket);
```

`publicVerificationConfig` has these required fields:

| Field | Meaning |
| --- | --- |
| `issuer` | Exact configured Spawn issuer |
| `audience` | Exact recipient for your game server |
| `gameId` | Your registered game ID |
| `environment` | Exact authorized environment, such as `sandbox` |
| `publicKeys` | Object mapping up to eight pinned key IDs to public Ed25519 PEM strings |

The verifier uses Node built-ins only and performs no HTTP, filesystem or database operations. It accepts neither private signing material nor URLs for key lookup. Install key rotations through your trusted configuration process, not from a ticket header or player request. Do not export this module into the browser build.

`consume(ticket)` verifies the signature, strict header/encoding, game, audience, issuer, scope, environment, timestamps and bounded identity labels, then consumes the grant ID once in this process. It returns only `playerId`, `sessionId`, `grantId`, `handle`, `displayName`, `expiresAt` and `environment`. Bind the connection to the verified `playerId`. Handles are display labels; render them safely. Ignore player-supplied identities, roles that are not permitted, health, damage, kills and outcome claims.

`verify(ticket)` performs the same signature/claims checks **without** consuming it. Use that lower-level method only when your own trusted admission service atomically owns replay consumption. A pure verification call is not replay protection. Rob the Rich uses that method because its matchmaker already owns one-time grants and reconnection.

Optional settings:

- `maxLifetimeSeconds`: positive integer up to 120 (default 120).
- `maxConsumedGrants`: 1–32,768 (default 32,768). Full replay memory rejects admission; it does not evict valid consumed grants to make room.
- `minimumIssuedAt`: integer Unix seconds. Defaults to the next whole second at verifier creation, rejecting pre-start grants after replay memory is lost. A token issued in that startup second may need a fresh launch on the next second. Use an explicit lower value only when durable replay consumption already protects the corresponding window, or in isolated tests.
- `now`: clock injection for isolated tests; normal servers should use the system clock and maintain time synchronization.

The built-in consumption map is for **one verifier in one process**. Construct it once per game, not per connection. Multiple processes/regions need shared atomic grant consumption, consistent routing and session ownership. A process restart also ends that process's game sessions unless you have implemented safe shared recovery. Startup checks do not replace account/session revocation.

## Admission is not game authority

Before expensive verification, limit connection count, request size and request rate on your server. After admission, implement authoritative movement, collision, health, weapons, damage, scoring and bounded lag compensation yourself. A launch grant is proof of a permitted account launch, not proof that a player is honest or has paid.

Choose a bounded server-session lifetime and require fresh proof to renew it. Renewal must preserve the same verified player, game, environment and launch session; consume every new grant once. A browser requesting another ticket cannot authorize switching the active character to another account. Any platform account-revocation interface requires its own supported server contract; the SDK does not contain a private first-party policy credential or an undocumented moderation API.

No universal anti-cheat, automatic ban, authoritative score upload, live payment, reward, infrastructure-management or account-administration feature is provided by these modules. Keep suspicious-play evidence and sanctions in your own authorized systems or a separately approved public platform integration.

## Document transport contract

The generic namespace is `spawn:multiplayer-`, version 1. A Spawn-launched frame receives a random 256-bit `spawnBridge` fragment capability and creates a fresh UUID nonce. It sends `ready` to the explicit parent origin. The platform validates the exact child window, opaque origin, capability and current document lifecycle, then offers exactly one MessagePort. The child accepts it only from the pinned parent/source and matching nonce. `ack` and `confirm` complete on that port before any grant request.

All port envelopes contain `{type,version:1,nonce}`. `grant-request` includes a UUID `requestId`; `grant` includes the matching request ID, ticket and pinned server origin; `grant-error` includes the request ID and a bounded platform-owned error. The SDK does not expose raw RPC or pass arbitrary responses to privileged APIs. Handshake/grant deadlines are eight seconds; only one grant request is outstanding. No namespaces are mixed within a document/channel. Existing legacy game documents may retain their old protocol until migrated; the new SDK does not silently fall back to it.

Do not manufacture a document capability or sign your own Spawn ticket to make production launch appear to work. For local transport tests use isolated in-memory fixtures, never platform private keys. Public-game enablement, runtime origin restrictions and real launch checks remain platform acceptance steps.

### Loading and reopening

The browser client allows a bounded 45-second initial document-load phase before its 8-second confirmation deadline. A received valid offer also starts the confirmation deadline. This prevents slow nonessential resources from using up the confirmation budget. The parent must use compatible bounds while retaining document/source/origin and one-port checks. A closed or navigated document never reconnects; reopen through Spawn for a fresh launch. This does not change signed claim validation, server replay handling or the grant-request deadline.

## Account-required game startup

Follow [the startup integration](startup.md) before enabling any play mode. Use the shared `@spawndotfamily/sdk/startup` controller, wait for trusted identity (and verified server admission for multiplayer), gate practice/bots too, and pause on connection loss. A handshake or grant alone is not multiplayer readiness. No automatic anonymous fallback. Keep an explicit isolated development launcher separate.

### Long-running game windows

An open game is not a timed demo. Keep the same document and match while renewing admission through `requestGrant()`. If the platform provides protected resource mounts, `onResourcePath(path)` receives a refreshed relative path on the authenticated document channel, during a pending grant request. Apply it only to the configured game-server origin; it is routing access, not identity or payment proof. Obtain a fresh grant before reconnecting, even when resuming the same match. Never reload the iframe on resource expiry. Account revocation and server admission checks still apply.

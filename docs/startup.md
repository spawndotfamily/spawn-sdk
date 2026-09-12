# Account-required startup

Use `@spawndotfamily/sdk/startup` to keep gameplay blocked until account connection succeeds. It has no DOM, networking, engine, framework or private infrastructure dependency. It coordinates one bounded connection attempt, coalesces Retry, clears stale identity on disconnect and rejects late results after cancellation. Default timeout is 60 seconds; maximum is 120 seconds.

## Browser previews

```js
import { createSpawnGameClient } from '@spawndotfamily/sdk';
import { createSpawnStartup } from '@spawndotfamily/sdk/startup';

const client = createSpawnGameClient({ platformOrigin: 'https://platform.example' });
const startup = createSpawnStartup({ connect: () => client.identity() });
const unsubscribe = startup.subscribe(({ status, identity }) => {
  // Keep input/simulation paused and all play controls inert unless ready.
  setGameplayEnabled(status === 'ready');
  renderAccountState(status, identity);
});
retryButton.onclick = () => { void startup.connect().catch(showConnectionError); };
void startup.connect().catch(showConnectionError);
window.addEventListener('pagehide', () => {
  unsubscribe(); startup.dispose(); client.dispose();
}, { once: true });
```

The view functions above belong to your game. Ship a loading/error screen in the initial HTML so script loading or connection failure cannot expose active play controls. Gate every mode, including practice and bots. Do not auto-start a round when a delayed Retry succeeds: show the menu or an explicit resume action. Render error text safely; do not print credentials. Runtime disconnect/revocation signals must call `startup.invalidate()` and pause local input/simulation. An invalidated gate can Retry; a disposed document cannot. If its bridge is closed, reopen through Spawn instead of constructing a replacement in the same document.

`subscribe` immediately receives current state and returns an unsubscribe function. States are `blocked`, `connecting`, `ready`, and terminal `closed`; identity is null outside ready. `connect()` resolves a shallow-frozen identity, rejects on error/cancellation/timeout, and reuses the pending attempt. `dispose()` cancels and removes listeners. The callback receives an `AbortSignal`: attach it to your own pending network work and release listeners in a `finally` block. Older SDK bridge requests have their own bounded deadlines; invalidating startup ignores their eventual result, it does not silently reopen their port.

## Multiplayer

A completed parent handshake or an issued grant is not game-server admission. The `connect` callback must await your creator-owned server's signed-grant verification and canonical player response. Never return browser-entered identity, a cached profile, decoded-but-unverified token claims or a grant itself. The gate only checks that an ID is present; it cannot authenticate arbitrary callback output. Your server must continue to verify every connection, own health/movement/damage/results, and reject expired or revoked sessions. A browser gate improves normal flow, but cannot stop a modified browser from running local code.

Report the real connection lifecycle with `multiplayer.reportConnection('connecting' | 'ready' | 'disconnected')`. Use ready only after verified server admission; report disconnected as soon as that connection is lost. This optional parent notification sends no profile, ticket, account cookie or other data. It returns false before handshake confirmation, after disposal, for invalid values or duplicate states. Parent support is needed to display it; older parents may ignore it. It is presentation only and never permission to join, spend, score or receive rewards.

For local development, use an explicit isolated test launcher and its server-verified development identity. Never enable anonymous fallback automatically after real Spawn connection failure, never grant production access with a client flag, and never label an offline/test identity as a live Spawn account.

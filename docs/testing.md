# Test your game locally

Use the same browser integration before and after upload. The local launcher supplies fake players and TEST balances; it has no connection to Spawn accounts, wallets or rewards.

## Build, open, play

Install the verified SDK archive supplied by Spawn, then run your game's normal browser build. From that game folder:

```sh
./node_modules/.bin/spawn-publish check ./dist
./node_modules/.bin/spawn-dev ./dist
```

Open the loopback address printed by the launcher. Choose Alice, Bob or Empty balance. The launcher snapshots the validated build at startup; rebuild and restart it after changing your game. Use `--port 4175` if the default port is occupied. It binds only to `127.0.0.1`; it is not a public hosting server.

Inside the uploaded game:

```js
import { createSpawnGameClient } from '@spawn/sdk';
const spawn = createSpawnGameClient();
const player = await spawn.identity();
// Render player.displayName and player.avatarUrl safely.
// Enable gameplay only after startup is ready.
window.addEventListener('pagehide', () => spawn.dispose(), { once: true });
```

Both launchers supply a public `platformOrigin` configuration before game code. This value contains no account, cookie, API key or payment permission. The SDK still requires the isolated frame, document token and exact parent handshake. An explicitly supplied `platformOrigin` takes precedence; use the default for a build intended to work with both launchers. Do not make your own fallback identity or weaken production origin checks.

## Test these cases

| Action | Expected result |
| --- | --- |
| Switch Alice to Bob | The new launch receives Bob; Alice's saves are separate |
| Request optional `entry` payment, then Cancel | No debit and no paid entitlement |
| Confirm the displayed 10 TEST | Processing, Paid checkmark, then Continue returns a fake receipt |
| Request the same entry again in that launch | Same receipt; no second debit |
| Choose Empty balance | Payment fails without a negative balance |
| Disconnect, close or reopen | Game pauses on loss; a new launch reconnects through startup |
| Submit a score | Unverified local record; no automatic reward |

Use [the startup controller](startup.md) and test connection loss explicitly. A disconnected iframe does not magically stop its own game loop; the game must pause on the documented failure/lifecycle signals. The local launcher never claims to prevent modified offline clients from cheating.

The fixtures are bounded and held only in this page's memory. **Reset testing** clears them. Reloading or closing the page also clears them. Fake identities and receipts use `local_` identifiers and cannot authorize production API calls. Local storage limits are for testing, not the platform's actual quota.

## Finish in a private Spawn preview

`check` validates file format and size; it cannot prove the game is playable. Test the real isolated preview after upload, including sign-in, account labels, save limits, optional payment consent, cancellation and reopening. Local success is not certification of payment eligibility, fair play or security. Keep automatic rewards from browser-reported outcomes off.

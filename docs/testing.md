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


## Test the creator pool

All balances are fake and belong to this one local browser session:

| Account | Starting TEST |
| --- | ---: |
| Alice / Bob | 100 each |
| Empty balance | 0 |
| Creator wallet | 1,000 |
| Game pool | 0 |

1. In your game, request the optional `entry` payment. Cancel leaves balances unchanged. Confirm moves 10 TEST from the selected player into the game pool; Continue returns the receipt. Repeating the request in the same launch returns that receipt without another charge.
2. Use **Top up pool** to move the chosen amount from the fake creator wallet into the pool. **Withdraw** moves it back into the fake creator wallet. This is not an on-chain withdrawal.
3. Submit a score in the game. It appears as **unverified** and pays nothing automatically.
4. Inspect the score, then use **Reward Alice/Bob/Empty balance** in the creator test panel. This moves the amount from the pool to the selected test player. Select a different player in the header to test receiving a reward in another account.
5. Try an amount above the available balance. The transfer fails without changing balances. **Reset testing** starts again with the amounts above and clears local saves, scores and receipts.

The panel shows current balances, the latest 12 transfers and their local receipt IDs, and the latest five unverified scores. State retains at most 100 transfers and 100 scores in memory. Closing or reloading the page clears them. No fee or tax is simulated; economics are not finalized.

Creator controls are launcher tools, **not game SDK methods**. Do not copy them into the game, add a browser reward endpoint or pay directly from client-supplied wins. The game bridge still supports only identity, saves, unverified scores and the documented entry request. Receiving a simulated reward updates the launcher balance; there is no game balance/reward-event subscription API. Inspect results in the panel rather than inventing one.

## Move from local testing to Spawn

Keep `createSpawnGameClient()` unchanged. The explicit local launcher supplies its public origin and a local isolated connection. Spawn's own launcher supplies Spawn's origin and an account-bound connection for the player who pressed Play. No credentials or fake accounts are compiled into the game, and local balances never migrate into Spawn.

Opening the game directly, outside either supported launcher, must show a connection error. A failed or closed Spawn connection must never activate fake players. Do not detect trust from a hostname, referrer, query parameter or `NODE_ENV`; the SDK requires the launcher handshake. Publishing does not enable live money: Spawn's current account, payment and receipt contract is still `environment: 'sandbox'` with TEST tokens. Local mode also uses that label; it is not a switch for financial authority.

Before approval, test the **same browser build** in its private Spawn preview with a real Spawn account. That catches platform authorization, quotas and deployed integration differences that a local simulation cannot certify. Multiplayer authentication and creator-owned server behavior require their own tests; this launcher does not simulate a game server or production authentication.

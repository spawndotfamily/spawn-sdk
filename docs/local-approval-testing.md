# Test token approvals on your computer

SDK 0.11.0 includes `spawn-test-host`: Spawn's actual approval components, token ledger and API handlers in an isolated local process. You do not need a Spawn account, hosted preview, downloaded creator credential or second person to test these stages. Synthetic balances never reach the chain or your hosted wallet.

Use Node 22.13 or newer (Node 24 recommended). Install the SDK in your game project. The host is included in the npm package; no Spawn source checkout or infrastructure access is needed.

## Start an ordinary browser game locally

For a game using `createSpawnGameClient`, point the host at your **built browser output**,
with the SDK bundled and relative asset paths, just as you will upload it:

```sh
npx --no-install spawn-test-host --players 6 --game-dir ./dist --config .spawn-local.json
```

The host inspects the build using the publisher's file checks, serves each player in an
opaque sandbox at a tokenized URL, and injects the normal public launch configuration.
Your game uses the same `createSpawnGameClient()` identity, balance, optional payment,
trade and table methods. Do not put a local identity or approval bypass in game code.
Restart the host after rebuilding so changed files are inspected again.

Use `--game-dir` for this path and `--game-url` for the multiplayer path below; they are
mutually exclusive. This host focuses on Listing-token flows. It explicitly rejects
save/score operations; keep using `spawn-dev` for isolated save/score tests.
The packaged `examples/local-game-approval.mjs` is a runnable ordinary-client example.

## Start your multiplayer game locally

```sh
npx --no-install spawn-test-host --players 6 --port 4175 --game-url http://127.0.0.1:3000 --config .spawn-local.json
```

Add `.spawn-local.json` and any local test database to `.gitignore`. The config file is created privately and will not overwrite an existing file. Remove an old **local test config** deliberately before exporting a new one. It contains only this test run's synthetic player sessions and fake server credential; do not put it in a browser bundle.

Configure your authoritative game server explicitly with that file's `platformOrigin`, `projectId`, `credential` and `verification` settings. Pass `verification` to `createSpawnLaunchVerifier` and the other three fields to the standard table/match/payout/token server clients. These are the same public clients you use when hosted. Supply the loopback platform origin and your loopback game server origin to the multiplayer browser client through your server's normal public configuration. Keep local and hosted configuration separate; never add a fallback identity, skip verifier checks, or decide trust from `environment: 'sandbox'`.

Open a player's `url` from the exported file. The local host embeds your game and supplies a signed synthetic launch grant using the normal multiplayer bridge. Each URL is a different fake player. Open multiple windows or let browser automation open them. A buy-in requested by your game server appears in that player's Spawn approval screen; clicking Approve debits only the exact quoted amount. Cancel does not debit. Multiplayer optional payments use `requestTokenPayment({ amount, item })`, with the token chosen by the host's simulated Listing.

The loopback host supports 1–1,000 synthetic players per process. Tables still have 2–6 seats. Run larger fleets across tables; choose browser concurrency that fits your machine. This is a test capacity, not a claim about hosted throughput.

## Drive the approval screen in an automated test

```js
import { randomUUID } from 'node:crypto';
import { startSpawnTestHost } from '@spawndotfamily/sdk/testing/local-host.mjs';

const host = await startSpawnTestHost({ players: 6, balance: '100000000000000000000' });
try {
  const alice = host.players[0];
  // page is a Playwright page (install @playwright/test in your own dev tools).
  await page.goto(alice.url);
  const table = await host.tables.create({
    tableId: randomUUID(), operationId: randomUUID(), maxSeats: 6,
  });
  const quote = await host.tables.requestBuyIn(table.tableId, {
    operationId: randomUUID(), buyInId: randomUUID(),
    player: { playerId: alice.playerId, launchId: alice.launchId },
    amount: '10000000000000000000', // 10 tokens, 18 decimals, exact base units.
  });
  const outcome = alice.requestApproval({
    kind: 'table', tableId: table.tableId, buyInId: quote.buyInId,
  });
  // Inspect the amount/token, then use the visible approval control; then verify the ledger receipt.
  // See the packaged local-approval-playwright.mjs for executable selectors.
  await page.getByRole('button', { name: /^Approve/ }).click();
  await outcome;
  const recorded = await host.tables.buyIn(table.tableId, quote.buyInId);
  if (recorded.status !== 'confirmed') throw new Error('Buy-in was not recorded');
  if (alice.balance() !== '90000000000000000000') throw new Error('Wrong debit');
} finally {
  await host.close();
}
```

`requestApproval` is a **test-driver method** that queues the production approval component in a synthetic player's browser. It does not approve anything. Your actual game's `client.tables.buyIn` and payment methods open the same components via the real bridge. Never copy this test control into game code.

`player.fetch('/api/v1/...')` makes an authenticated request as that synthetic player for API-level tests. It cannot impersonate another player. Your server credential cannot confirm a player's buy-in. Treat a direct API test as a ledger/authorization test, not evidence that the screen was rendered.

Table amounts and starting balances are canonical integer base-unit strings. Optional `requestTokenPayment` amounts are decimal strings in whole tokens. Never convert either through JavaScript `Number`.

## Cases to include

- Approve exact amount/token; verify the recorded status and resulting balance, not just button clicks.
- Cancel, insufficient balance, expired quote, changed quote, wrong player and guests in your game.
- Duplicate confirmations, same operation ID retried, conflicting operation body, lost response followed by status lookup.
- Simultaneous arrivals/departures, unequal stacks, side pots and nonnegative balances.
- Disconnect/reconnect during a hand, remaining-stack cash-out and server outage recovery.
- Restart with `databasePath: './local-test.sqlite'`. Reuse saved table/operation IDs; restarting must not seed balances again. `host.advance(ms)` advances the local ledger clock for expiry/recovery tests. No wall-clock delay is needed.

Use your normal durable game journal too. A local ledger restart does not prove that your game server saved its own intentions correctly. A timed-out approval is unresolved; reconcile it using the original IDs rather than issuing a new debit.

The earlier `spawn-test` scenarios and `testing/table-fleet.mjs` remain fast isolated doubles for game-rule development. Use this host to exercise the actual shipped ledger and approval contract. The legacy `spawn-dev` still covers isolated save/score integrations and fixed historical TEST payments; it is not the Listing-token test path.

## What remains a hosted check

This test host deliberately substitutes authentication with synthetic identities and custody with fake balances. It does not test real sign-in, your VPS/proxy configuration, token deposits/withdrawals, network reliability, real chain confirmations, malware scanning or production capacity. After local tests, verify the same built game in a private Spawn preview and report those checks separately. No local test can guarantee 100% production success or fair game outcomes.

The package includes `testing/platform/manifest.json` with the platform source base, source digest and artifact hashes. Maintainers rebuild these artifacts from the platform's real sources for each relevant SDK release; creators do not need to build them.

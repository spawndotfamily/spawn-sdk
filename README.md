# Spawn SDK

Bring your browser game to [Spawn](https://spawn.family). Connect players to their Spawn accounts, save their progress, display leaderboards, and upload a playable preview from your game folder.

Keep your game, engine, and build tools. Use the features you need.

[Install on npm](https://www.npmjs.com/package/@spawndotfamily/sdk) · [Release notes](https://github.com/spawndotfamily/spawn-sdk/releases) · [Examples](examples)

## What you can build

| Feature | What it does |
| --- | --- |
| Guest play | Let players try your free game without signing in, with a unique guest ID. |
| Player accounts | Get a player's name, avatar, and stable ID for your game. |
| Saves and inventories | Store progress, settings, equipment, and other nested JSON data. |
| Scores and leaderboards | Submit scores and show best scores, latest scores, or every run. You choose what players can see. |
| Creator database | Read and manage your game's player data from your computer, even before the first upload. |
| Listing access and optional payments | Let players use a free Listing or confirm its one-time listing-selected testnet access purchase; separate optional payments use explicit amounts through Spawn's shared overlay. |
| Verified multiplayer purchases | Open Spawn’s exact Listing-token approval, recover paid receipts on your server, and deliver each item once. |
| Creator payouts | Send tokens from your own game pool to verified members through the server-only payout API. |
| Local testing | Test the actual approval UI and ledger with 1–1,000 synthetic players using `spawn-test-host`; use `spawn-dev` separately for saves and scores. |
| Publishing | Upload a private preview, inspect its automated checks, and explicitly publish a tested release. |

Spawn selects the token from the game’s Listing and owns the confirmation screen. Hosted payments require an admitted Robinhood Chain Testnet asset (chain 46630). The [local approval host](docs/local-approval-testing.md) runs the same approval components and ledger with isolated synthetic balances; it cannot spend hosted tokens. The older `spawn-dev` fixed TEST dialog is a separate save/score simulator. See [verified purchases](docs/token-payments.md) for server receipt recovery and [payouts](docs/payouts.md) for creator-pool transfers. Mainnet settlement is not enabled.

## Publish with your AI agent

1. **Open your game workspace on Spawn.** Under Publish, download the credentials and copy your game's agent prompt.
2. **Paste the prompt into your coding agent with your game project open.** The agent reads the SDK guides, helps connect the features you choose, builds the game, tests it locally, and uploads a private preview.
3. **Play and publish deliberately.** Wait for the automated malware check, play the exact preview, then you or an explicitly authorized agent can publish it with the release command. Uploading alone never publishes a game, and no first-listing staff review is required.

Your credentials stay on your computer, outside your source repository and uploaded build. They give the agent scoped access to this game; publication still requires an explicit release command and the platform's owner, scan, and suspension gates. They cannot change ownership or move tokens. You do not need a GitHub repository.

**For coding agents:** start with [AGENTS.md](AGENTS.md). It links to the integration checklist, feature-specific instructions, and troubleshooting steps.

## Set up by hand

You'll need Node.js 22.13 or newer and npm. In your game project, install the SDK:

```sh
npm install --save-exact --ignore-scripts @spawndotfamily/sdk
```

Follow the [browser integration guide](docs/integration.md) and [startup example](docs/startup.md) to connect your game. Bundle the SDK with your browser assets so all its dependencies are included. No particular UI framework is required.

Once you have a browser build, check it. For Listing-token flows in an ordinary isolated browser game, open the local approval host:

```sh
npx --no-install spawn-publish check ./dist
npx --no-install spawn-test-host --players 6 --game-dir ./dist --config .spawn-local.json
```

For a multiplayer game with its own server, use `--game-url` and the configuration steps in [local approval testing](docs/local-approval-testing.md). The host supports browser automation of approval, cancellation and recovery without real accounts or tokens. Use `npx --no-install spawn-dev ./dist` separately for saves, scores and Guest integration. A build check catches packaging problems; play the game and verify the exact hosted build before publication.

When you're ready, upload the same folder using the credentials you downloaded from Spawn:

```sh
npx --no-install spawn-publish publish ./dist --credentials /path/to/spawn-project.json
npx --no-install spawn-publish status <release-id> --credentials /path/to/spawn-project.json
npx --no-install spawn-publish release --release <release-id> --creator-confirmation --credentials /path/to/spawn-project.json
```

Replace the example paths with your build folder and credentials file. Upload returns a private preview link and release ID. Poll status until the automated malware check passes, open the exact preview and play-test it, then run the release command when the creator explicitly requests publication. The command prints the release status and scan result; a legacy platform may return `pending_review`.

## Which games can I upload?

Upload a finished **browser build** with `index.html` at the top level, alongside the scripts, images, sounds, and other assets it needs:

```text
my-game-build/
├── index.html
├── game.js
└── assets/
    ├── character.png
    └── music.ogg
```

The folder can be called `dist`, `web`, `build`, or anything else. The name doesn't matter. HTML, JavaScript, and WebAssembly builds are supported; having an `index.html` alone doesn't guarantee compatibility. Native desktop or mobile games need a working web export. Games with a backend still need that backend hosted separately.

The default upload allowance is **1 GB and 1,000 files**. Include the finished browser files, not credentials, `node_modules`, or native executables. Mark a game as mobile friendly after testing its touch controls and layout.

Already have a build? You can also use **Manual upload** or **GitHub import** in Spawn. GitHub imports finished files; it does not automatically publish every push. See [build formats and publishing options](docs/publishing.md).

## Data, payments, and multiplayer

Your game's database supports nested objects and arrays, with storage limits and version checks to protect against accidental overwrites. See [player data and leaderboards](docs/game-data.md) and [creator database tools](docs/creator-database.md).

Spawn handles connection notices, transaction history, and payment confirmation through one shared overlay. New game payments and creator-pool transfers settle one-to-one with a 0% Spawn platform fee; historical receipts retain the fee fields recorded when they were paid. **Browser-submitted scores and saves are unverified:** use manual review or supported trusted-server validation before awarding tokens.

For configured token entries, the Listing's `entryAmount` is the permanent game-access purchase price. Do not request that default entry payment again after access is granted. A separate optional custom payment may provide only an amount and item; Spawn still selects the Listing asset. The SDK does not accept a token address from browser code; see [entry payment integration](docs/integration.md#configured-token-entry).

Multiplayer requires your own authoritative game server and an enabled Spawn integration. Server registration is self-service, and the SDK does not provide server hosting. See the [multiplayer guide](docs/multiplayer.md).

SDK 0.9.0 adds persistent 2–6 player Listing-token tables through the same creator-operated server and dedicated `match.key`. Use the server-only `createSpawnTableClient` and the browser `client.tables` APIs; Spawn owns player buy-in approval, while the creator server owns game outcomes. Every table amount is a canonical BASE UNIT string, and every mutation needs a durable journal entry for recovery. Read the [table bankroll guide](docs/table-bankroll.md) before integrating.

## Guides and help

- [Local testing](docs/testing.md) — test accounts, saves, payments, and reconnects.
- [Troubleshooting](docs/troubleshooting.md) — missing files, connection errors, and upload failures.
- [Security and permissions](docs/security.md) — what the SDK and credentials can access.
- [Changelog](CHANGELOG.md) — additions, changes, and upgrade notes. Check these before updating an existing game.
- [Report a problem](https://github.com/spawndotfamily/spawn-sdk/issues) — include the SDK version and error message; leave credentials out.
- [Contributing and releases](docs/maintainers.md) — instructions for working on the SDK itself.

The SDK source is [MIT licensed](LICENSE). Spawn branding and third-party game assets are not included in that license.

Free games can welcome guests. Log in for cloud saves, official score submissions and transactions. See [guest play](docs/guests.md).

For two-player games, [Listing-token matches](docs/match-payments.md) combine player-approved entries with server-validated settlement. Your game server needs separate match activation; publishing credentials do not move tokens.

Player-to-player token gifts and atomic two-way trades are available through `client.trades`. See the [trade guide](docs/trades.md) for the approval flow and exact scope.

## Creator server registration

SDK 0.7.0 includes [self-service server setup](docs/server-setup.md). Fresh `server:configure` credentials authorize settings for the creator's own game; the SDK generates separate private match credentials locally and registers only hashes. The existing dedicated `match.key` covers matches and game-scoped tables; no separate table activation or Spawn VPS access is needed. Configure through the CLI, deploy the creator's own server, then verify the relevant settlement flow before claiming completion. Setup does not authorize spending for players or grant platform administration.

Match recovery: server SDK 0.7.2 adds `closeCreation(matchId)` for uncertain attempts with expired launches. Read [the recovery contract](docs/match-recovery.md); persist confirmed closure before replacement.

Standalone Listing-token balances are available through `client.tokens.balance()`. Creator servers can read their verified game roster and decide who sees balances. See the [balance guide](docs/token-balances.md).

Persistent table operations and recovery are documented in the [table bankroll guide](docs/table-bankroll.md), including seat generations, side pots, reconnects and offline cash-out recovery.

### Local approval testing

Use `npx --no-install spawn-test-host --players 6 --game-url http://127.0.0.1:3000 --config .spawn-local.json` to open your local multiplayer game as independent synthetic players and test Spawn’s real approval UI and ledger. No hosted account is needed. See [the local approval guide](docs/local-approval-testing.md) for automation, large player groups and restart recovery.

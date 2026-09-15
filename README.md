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
| Local testing | Try fake accounts, saves, scores, fixed TEST payments, and creator-pool controls before uploading. |
| Publishing | Upload your browser build and manage its listing and images. |

The local simulator and unconfigured entry fallback use fixed TEST tokens with no cash value; the local simulator does not emulate Listing-configured token purchases. A hosted configured game entry can use one Spawn-admitted asset on chain ID 46630 testnet; Spawn selects the asset from the game's listing settings and owns confirmation. Real-money deposits and redeemable payouts are not enabled.

## Publish with your AI agent

1. **Open your game workspace on Spawn.** Under Publish, download the credentials and copy your game's agent prompt.
2. **Paste the prompt into your coding agent with your game project open.** The agent reads the SDK guides, helps connect the features you choose, builds the game, tests it locally, and uploads a private preview.
3. **Play the preview and submit it for review.** Spawn reviews your first listing before the game becomes discoverable. Later updates still need your approval in Releases.

Your credentials stay on your computer, outside your source repository and uploaded build. They give the agent scoped access to this game; they cannot approve releases or move tokens. You do not need a GitHub repository.

**For coding agents:** start with [AGENTS.md](AGENTS.md). It links to the integration checklist, feature-specific instructions, and troubleshooting steps.

## Set up by hand

You'll need Node.js 22.13 or newer and npm. In your game project, install the SDK:

```sh
npm install --save-exact --ignore-scripts @spawndotfamily/sdk
```

Follow the [browser integration guide](docs/integration.md) and [startup example](docs/startup.md) to connect your game. Bundle the SDK with your browser assets so all its dependencies are included. No particular UI framework is required.

Once you have a browser build, check it and open the local test launcher:

```sh
npx --no-install spawn-publish check ./dist
npx --no-install spawn-dev ./dist
```

The launcher supplies fake players, a Guest option, and balances. It does not use your real Spawn account or hosted player data. A build check catches packaging problems; you still need to play the game.

When you're ready, upload the same folder using the credentials you downloaded from Spawn:

```sh
npx --no-install spawn-publish publish ./dist --credentials /path/to/spawn-project.json
```

Replace the example paths with your build folder and credentials file. The command returns a private preview link. Open it, test the game, then submit it from Releases.

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

Multiplayer requires your own authoritative game server and an enabled Spawn integration. Server registration is not self-service, and the SDK does not provide server hosting. See the [multiplayer guide](docs/multiplayer.md).

## Guides and help

- [Local testing](docs/testing.md) — test accounts, saves, payments, and reconnects.
- [Troubleshooting](docs/troubleshooting.md) — missing files, connection errors, and upload failures.
- [Security and permissions](docs/security.md) — what the SDK and credentials can access.
- [Changelog](CHANGELOG.md) — additions, changes, and upgrade notes. Check these before updating an existing game.
- [Report a problem](https://github.com/spawndotfamily/spawn-sdk/issues) — include the SDK version and error message; leave credentials out.
- [Contributing and releases](docs/maintainers.md) — instructions for working on the SDK itself.

The SDK source is [MIT licensed](LICENSE). Spawn branding and third-party game assets are not included in that license.

Free games can welcome guests. Log in for cloud saves, official score submissions and transactions. See [guest play](docs/guests.md).

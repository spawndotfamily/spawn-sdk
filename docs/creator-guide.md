# Bring an existing game to Spawn

One prompt can prepare, test and upload a **private preview**. After the automated malware check passes and the exact preview is play-tested, the creator can explicitly publish it or ask an authorized agent to publish it. An upload alone is not publication.

## Choose only the features your game needs

| Feature | Available now | Agent instructions |
| --- | --- | --- |
| Browser hosting | Finished HTML, JavaScript, WebAssembly and assets | Keep the engine and folder layout. Select the folder with index.html at its root. |
| Player identity | Game-scoped ID, name and avatar | Use createSpawnGameClient().identity(); never copy account cookies or expose email. |
| Player saves | Nested JSON inventories, progress and settings; version checks | Use load/save/listSaves/remove. Read [game data](game-data.md) for limits and conflict handling. |
| Leaderboards | Opt-in game-scoped reads; best/latest/every-run views | Use submitScore with a retry ID and getLeaderboard. Ask the creator for the sharing policy, then use the scoped database CLI. Scores remain unverified. |
| Creator database | Inspect players and score records; read, set and remove nested player JSON | Use [creator database CLI](creator-database.md) from the private agent workspace. Versioned changes; no token authority. |
| Listing access and optional payments | A Listing-selected asset with either free access or a one-time permanent game-access purchase; separate optional payments use explicit amounts | Decide whether Listing access is free or requires its permanent purchase. Ask for the token contract address/name and access price when needed, then search and configure an admitted asset with the scoped CLI. Do not request the default entry payment again after access is granted. Use an explicit custom amount only for a separately documented optional payment, and never start one silently on startup. |
| Creator pools | Dashboard top-ups, withdrawals and manual rewards | New game payments and pool transfers are one-to-one with a 0% Spawn platform fee. Historical receipts retain their recorded fee fields. Pool balance is not a guaranteed prize. No general browser payout API. |
| Listing and images | Name, description, supported details and image edits for this game | Use scoped CLI listing/image commands and expectedVersion. No ownership, approval, platform-fee or other-project pricing changes. |
| Local testing | Actual Spawn token approval UI and ledger with 1–1,000 synthetic players | Use [spawn-test-host](local-approval-testing.md) for Listing-token multiplayer flows; use spawn-dev for isolated saves/scores and legacy TEST. Keep all local configuration out of shipped game code. |
| Multiplayer | Registered integration with a creator-operated server | Read multiplayer/startup documentation. Use the self-service server setup CLI; server authority and settlement are separate from a browser handshake. |
| Persistent tables | Durable 2–6 player Listing-token tables through the creator-operated server | Use SDK 0.9.0 `createSpawnTableClient` and `client.tables` with the existing dedicated `match.key`. Read [table bankroll](table-bankroll.md) for BASE UNIT amounts, Spawn-owned approval, seat generations and recovery. |
| Friends and chat | Platform UI | No game SDK access to private chat, friends administration or moderation. |
| Testnet wallets | Spawn manages supported testnet deposits and withdrawals | Game payments use deposited platform balances. No game-side custody keys or on-chain transfer API. Mainnet is not supported. |

These are choices, not a checklist of features to add. Preserve existing gameplay. Ask before a substantial port, adding paid features or changing the game's business model.

## The one-prompt workflow

1. **Inspect.** Identify the engine, browser export, assets and any server dependency. A native executable alone is not a web build.
2. **Install.** Run `npm install --save-exact --ignore-scripts @spawndotfamily/sdk`. Read the installed AGENTS.md, docs/creator-checklist.md and only the relevant integration sections. No separate SDK archive, source checkout or GitHub connection is needed.
3. **Connect.** Use the existing browser client and launcher identity. Use the shared startup controller for account-dependent play. Keep secret creator credentials outside source and the browser build. The downloaded file expires after 24 hours; ask for its saved path, never its secret in chat.
4. **Test.** Build into any folder, then run `npx --no-install spawn-publish check <folder>` and `npx --no-install spawn-dev <folder>`. Play a real start → gameplay → finish/retry loop. Check input, missing assets, console errors, reconnect, saves and any cancel/confirmed payment (local simulation and hosted Listing-token checks are separate). Return evidence and clearly state anything you could not test.
5. **Upload and poll.** Run `npx --no-install spawn-publish publish <folder> --credentials <private-file-path>`, then poll with `npx --no-install spawn-publish status <release-id> --credentials <private-file-path>`. Return the actual preview link, release ID, automated check status, tests and limitations. If upload fails, preserve the build and explain the error; GitHub import or Manual upload can send the same build, but are not guaranteed to bypass network problems.
6. **Publish only after testing.** Once the automated malware check passes, play the exact preview. If the creator explicitly requests publication, run `npx --no-install spawn-publish release --release <release-id> --creator-confirmation --credentials <private-file-path>`. The platform rechecks the owner credential, release scan and suspension state. The agent must never publish merely because upload succeeded or enable rewards automatically.

On Windows, the bundled CLI can also be run as `node node_modules/@spawndotfamily/sdk/dist/cli/run.js` with the same arguments. Keep commands and file paths appropriate for the creator's system.

## Which folder?

| File location | Folder to select |
| --- | --- |
| index.html at repository root | . |
| dist/index.html | dist |
| web/index.html | web |
| build/web/index.html | build/web |

Include the scripts, images, sounds and other browser assets with their relative paths. `dist` is a convention, not a requirement. Default limits are 1 GB and 1,000 files. Exclude source secrets, credentials, node_modules and native executables. GitHub imports finished files on the selected branch or a completed `spawn-browser-build` Actions artifact; Spawn does not run untrusted build commands. A local export can be uploaded directly without GitHub. Automatic import on every push is not enabled.

## What the checks prove

The upload validator checks build structure, supported files, limits and paths. Hosted status also reports the automated malware check for the exact release; this catches detected files but does **not** prove playability, honesty or complete security. The agent should use a browser to test gameplay and record startup errors. Never invent a successful play test or call a structural check an anti-cheat review. A passed check does not publish automatically.

## Labels and money

**Private preview / Published game** describes who can access a release. **Local fake player / connected Spawn account** describes identity. **TEST** describes the historical currency. A published game uses its configured admitted testnet token for hosted payments; historical TEST services are retired; `environment: 'sandbox'` is not a publication-status flag and must never switch on fake identity in a hosted game.

Before automatic browser-score rewards, tell the creator: “Players can fake wins and scores in a browser-only game. Automatically paying those results could drain your entire pool. A payment proves payment, not fair play.” Keep automatic rewards off unless a documented trusted server validation and settlement contract is enabled. Memory scrambling, obfuscation and domain checks do not make a browser authoritative.

Spawn owns payment confirmation outside the game. A zero-priced Listing is free; a positive configured Listing amount is the one-time permanent access purchase confirmed by Spawn before access. Hosted `requestPayment('entry')` rejects when no Listing token exists; for a configured listing it represents that permanent access purchase and must return the existing purchase receipt or a clear no-purchase-needed error after access is granted, without starting another default-price debit. An explicit `requestTokenPayment({ amount, item })` requires a game-defined amount and can request a separate optional payment using that same listing-selected asset; it never accepts a contract address. Cancellation rejects the request. Do not duplicate a payment after an uncertain response or treat a local flag as payment proof. Token entry is limited to Spawn-admitted assets on chain ID 46630 testnet; it does not enable real-money deposits or redeemable payouts.

Current public accounting is at https://spawn.family/transparency. It describes testnet wallet accounting; legacy demo totals are no longer public. Matching totals are useful checks, not proof that every transaction is authorized. Read the installed security documentation; never invent missing methods or weaken the iframe, origin, credential or approval boundaries to make an integration pass.

Before each editing session, check npm for updates and ask before upgrading. See [the update policy](game-data.md#before-each-editing-session). Spawn owns the shared hosted overlay: a top-right connection toast that disappears after about 3.3 seconds and a bottom-right Transactions button. Connecting/disconnected states remain visible. Do not add duplicate connection badges, toolbars, transaction buttons or payment dialogs inside the game. Remove old integration banners when updating an existing game. The platform launcher change applies to existing compatible SDK integrations without a rebuild; game-drawn banners require editing the game.

Database tools work before the first upload. Read [creator database tools](creator-database.md) for registering your own game identity, adding scores and editing nested saves from the agent workspace.

## Browser and mobile support

All Spawn games run in a browser. Mark a game as mobile friendly only after checking touch controls and the full play loop on a phone. Read the listing version, then use `spawn-publish listing update patch.json --credentials <file>` with `{"expectedVersion":3,"devices":["browser","mobile"]}`. Replace 3 with the current version. Use `["browser"]` to remove mobile support; this changes the listing, not the game code. Older integrations may omit devices and remain browser-only.

Spawn supplies the mascot loading screen while it checks the account, profile and game session. Do not add another Spawn splash or delay gameplay to finish an animation. Game-specific asset loading can still use the game's own UI. The shared connection toast and transaction controls remain platform-owned.

## Guests

Free published play uses a unique server-issued guest identity when signed out. Account scores, saves and transactions require sign-in. Support `identity().isGuest` and test Guest in spawn-dev. Read [guest play](guests.md); never replace failed authentication with a made-up player.

## Listing-token player competition

Two-player competition using admitted Listing testnet tokens is supported through the dedicated server match API in SDK 0.5.0. This is not limited to TEST demo points. Follow [match payments](match-payments.md) for server activation, grant verification, player confirmation, exact amounts, escrow and authoritative settlement. No house-funded dealer is required. Browser-reported wins and ordinary publishing credentials never authorize payouts.

## Direct player trades

SDK 0.6.0 supports player-authorized gifts and atomic two-way transfers of the Listing testnet token through `client.trades`. Both participants must be signed-in Spawn members; guests cannot send or receive. Read [the trade guide](trades.md) before implementation. Match escrow is a different API; game item ownership is not included in token settlement.

## Multiplayer release handoff

Publishing uploads browser assets only; it does not deploy the authoritative server or activate payouts. Follow [the match deployment checklist](match-payments.md#agent-deployment-and-activation-handoff). Report browser release, running server revision, registration/activation and two-member settlement verification separately. Prepare the server artifact and non-secret handoff when another operator owns deployment; do not claim the SDK lacks matches just because setup is incomplete.

## Creator server registration

SDK 0.7.0 includes [self-service server setup](server-setup.md). Fresh `server:configure` credentials authorize settings for the creator's own game; the SDK generates separate private match credentials locally and registers only hashes. No Spawn VPS access is needed. Configure through the CLI, deploy the creator's own server, then verify two-member settlement before claiming completion. Setup does not authorize spending for players or grant platform administration.

The same dedicated `match.key` covers game-scoped tables. Table persistence and the matching Spawn 0.9 service are separate deployment concerns; publishing the browser build does not deploy them. Keep exact table mutation intents in a durable journal and reconcile the same operation and table IDs after an uncertain response.

## Display token balances

SDK 0.8.0 supports standalone self reads and creator-server roster reads of the current Listing token. The creator controls who sees other players’ balances. Read [token balances](token-balances.md); no trade or match must be created merely to read a balance.

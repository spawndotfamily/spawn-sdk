# Bring an existing game to Spawn

One prompt can prepare, test and upload a **private preview**. You approve the preview; Spawn reviews the first listing before players can discover it. An upload alone is not publication.

## Choose only the features your game needs

| Feature | Available now | Agent instructions |
| --- | --- | --- |
| Browser hosting | Finished HTML, JavaScript, WebAssembly and assets | Keep the engine and folder layout. Select the folder with index.html at its root. |
| Player identity | Game-scoped ID, name and avatar | Use createSpawnGameClient().identity(); never copy account cookies or expose email. |
| Small saves | Per-player JSON with version checks and quotas | Use load/save at checkpoints; handle conflicts and full storage. |
| Scores | Unverified score submissions; creator review | Use submitScore. A browser score is not proof of fair play. |
| Optional TEST entry | Fixed 10 TEST request with Spawn confirmation | Use requestPayment('entry'); handle cancel, failure and uncertain outcomes. Never charge on startup. |
| Creator pools | Dashboard top-ups, withdrawals and manual rewards | Current incoming platform fee is 5%; outgoing rewards have no extra platform fee. Pool balance is not a guaranteed prize. No general browser payout API. |
| Listing and images | Name, description, supported details and image edits for this game | Use scoped CLI listing/image commands and expectedVersion. No ownership, approval or price changes. |
| Local testing | Fake players, balances, pool controls and receipts | Use spawn-dev on the finished folder. Keep test accounts out of shipped game code. |
| Multiplayer | Registered integration with a creator-operated server | Read multiplayer/startup documentation. Registration is not self-service; server authority and settlement are separate from a browser handshake. |
| Friends and chat | Platform UI | No game SDK access to private chat, friends administration or moderation. |
| Real funds / on-chain reserves | Not connected | TEST tokens have no real value. Never label them real currency or enable live payouts. |

These are choices, not a checklist of features to add. Preserve existing gameplay. Ask before a substantial port, adding paid features or changing the game's business model.

## The one-prompt workflow

1. **Inspect.** Identify the engine, browser export, assets and any server dependency. A native executable alone is not a web build.
2. **Install.** Run `npm install --save-exact --ignore-scripts @spawndotfamily/sdk@0.2.7`. Read the installed AGENTS.md, docs/creator-checklist.md and only the relevant integration sections. No separate SDK archive, source checkout or GitHub connection is needed.
3. **Connect.** Use the existing browser client and launcher identity. Use the shared startup controller for account-dependent play. Keep secret creator credentials outside source and the browser build. The downloaded file expires after 24 hours; ask for its saved path, never its secret in chat.
4. **Test.** Build into any folder, then run `npx --no-install spawn-publish check <folder>` and `npx --no-install spawn-dev <folder>`. Play a real start → gameplay → finish/retry loop. Check input, missing assets, console errors, reconnect, saves and any cancel/confirmed TEST payment. Return evidence and clearly state anything you could not test.
5. **Upload.** Run `npx --no-install spawn-publish publish <folder> --credentials <private-file-path>`. Return the actual preview link and release ID. If it fails, preserve the build and explain the error; GitHub import or Manual upload can send the same build, but are not guaranteed to bypass network problems.
6. **Human approval.** The creator plays the exact preview and submits it in Releases. Spawn reviews the first listing. Agents cannot approve, list or turn on rewards with a publishing credential.

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

The upload validator checks build structure, supported files, limits and paths. This catches packaging problems; it does **not** prove playability, honesty or security. The agent should use a browser to test gameplay and record startup errors. The creator and first-listing reviewer still play the exact build. Never invent a successful play test or call a structural check an anti-cheat review.

## Labels and money

**Private preview / Published game** describes who can access a release. **Local fake player / connected Spawn account** describes identity. **TEST** describes the currency. An approved game still uses TEST services today; `environment: 'sandbox'` is not a publication-status flag and must never switch on fake identity in a hosted game.

Before automatic browser-score rewards, tell the creator: “Players can fake wins and scores in a browser-only game. Automatically paying those results could drain your entire pool. A payment proves payment, not fair play.” Keep automatic rewards off unless a documented trusted server validation and settlement contract is enabled. Memory scrambling, obfuscation and domain checks do not make a browser authoritative.

Spawn owns payment confirmation outside the game. A successful entry receipt is `{ id, intentId, amount: 10, asset: 'TEST', environment: 'sandbox', status: 'paid' }`. Cancellation rejects the request. Do not duplicate a charge after an uncertain response or treat a local flag as payment proof.

Current public accounting is at https://spawn.family/transparency. It separates aggregate TEST accounting from unavailable real reserves. Matching totals are useful checks, not proof that every transaction is authorized. Read the installed security documentation; never invent missing methods or weaken the iframe, origin, credential or approval boundaries to make an integration pass.

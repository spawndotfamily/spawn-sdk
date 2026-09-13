# Check the built game, then the connection

## A module is missing: startup never runs

The npm browser entry is a module graph, not necessarily one file. SDK 0.2.9+ `index.js` imports `./game-data.js`. Copying just index.js (even renamed) produces a 404, prevents the game module from executing and can leave a static “Connecting” or “Standalone” label on screen.

Prefer importing `@spawndotfamily/sdk` normally and letting the game's bundler include its browser dependencies. For an intentionally unbundled game, ship every required browser module with its relative paths and exact filename casing. Do not copy CLI/server code, node_modules wholesale, credentials or source secrets into the browser output. Rebuild, run `spawn-publish check <folder>`, play-test with `spawn-dev <folder>`, then check the actual private preview. Do not approve a build just because upload succeeds.

SDK 0.2.11's CLI checks relative static imports, re-exports and literal dynamic imports in JavaScript files up to 16 MiB. It rejects missing targets before a normal streaming upload and before local testing. This is a packaging check, not code execution or a security scan. Computed imports, workers, HTML/CSS asset references, external URLs, import maps and larger scripts still require browser verification. Relative import-map rewrites should be bundled before this check. The legacy local reference upload path has no module-graph check; run `check` first. A successful check still reports `playableVerified:false`.

## Read errors in context

| Error | What to check |
| --- | --- |
| JavaScript 404 plus CORS message | Confirm the file exists in the uploaded build at the exact path. A missing-file response can also lack CORS headers; fix the missing file first. If an existing successful response still fails CORS, report it to Spawn. |
| `origin null` or localStorage denied inside extension files | Uploaded games intentionally have an opaque origin. Browser wallet extensions may fail there. Confirm the source and compare in a clean browser profile; these messages alone do not prove the game SDK failed. |
| The game's own code throws on localStorage | Use Spawn saves or handle unavailable browser storage explicitly. Never add allow-same-origin or a silent fake-account fallback. |
| Cloudflare analytics beacon blocked by CSP | Analytics is not required for gameplay. Do not relax CSP or game isolation to allow a beacon. Report unwanted host injection to Spawn. |
| TLS reset / fetch failed before an HTTP response | Separate network reachability from packaging. Preserve the exact error, endpoint, time and affected network; no credentials in diagnostics. An npm install can succeed while the upload API remains unreachable. |

WARP/VPN success changes the network path and is a workaround, not proof of a particular WAF rule and not a platform-wide fix. Never disable TLS verification, send creator credentials over HTTP, guess an alternate upload host or bypass the CLI's trusted-origin check. Report affected-network failures to Spawn; only an explicitly configured and trusted endpoint may receive the credential. A working private preview must show trusted identity and the single Spawn-owned overlay, not a game-drawn imitation.

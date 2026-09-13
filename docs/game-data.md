# Player data and leaderboards

Requires SDK **0.2.9** and the matching hosted bridge. Existing identity, load/save, payment and score calls remain supported. Do not assume a method exists in an older installed SDK.

## Private player saves

Spawn automatically scopes every save to the connected player and current game. Do not send a player ID or creator credential. `identity().id` is a stable, game-specific player ID; use it for associations, never a display name. Handles are unique today, but may change. A different game receives a different player ID.

A record has a key, JSON value, version and update time. JSON supports objects/dictionaries, nested arrays, text, finite numbers, booleans and null. It is not a SQL connection: no functions, undefined, BigInt, Date, Map, cycles, arbitrary queries or executable values. Represent dates as strings and maps as objects. Nesting is capped at 64 levels. Treat loaded strings as data; render with textContent rather than HTML.

```js
const prior = await spawn.load('progress');
const saved = await spawn.save('progress', {
  schemaVersion: 1,
  level: 4,
  xp: 120,
  equipment: ['hat', null],
  inventory: { potion: { count: 3 }, bags: [[{ item: 'key', count: 1 }]] }
}, prior?.version ?? 0);
const keys = await spawn.listSaves(); // metadata only; own non-platform keys
await spawn.remove('progress', saved.version); // only on an intentional delete
```

`save` replaces one complete record, not a field merge. Version 0 creates a missing record. A conflict means reload, reconcile the user's intended change and retry; never blindly overwrite with a stale version. Keep a schemaVersion inside your data and migrate older shapes deliberately. Save at checkpoints, not every frame. Handle offline, full-storage and conflict errors visibly; do not claim unsaved progress is stored.

Current hosted quotas: **100,000,000 JSON bytes and 100,000 records per game; 1,048,576 bytes and 256 records per player/game; 65,536 bytes per record**. Scores share the game/player quota. Keys are 1–64 ASCII letters, digits, underscores or hyphens; `_spawn_` is reserved. Overall platform capacity is separately capped. These are JSON payload allowances, not physical disk guarantees. Split inventory/progress/settings into separate keys; contact Spawn for higher capacity. No billing or hosted multiplayer server allocation is enabled.

Browser-owned saves are suitable for casual progress, not trusted inventories with monetary value, trades, item minting or automatic rewards. The player can modify browser code and submit fabricated values. Game isolation and version checks prevent cross-player writes; they do not validate gameplay. Trusted shared-world state still needs a creator-operated authoritative server.

## Shared leaderboard

Ask the creator whether scores should be shared, and whether to show best per player, latest per player, or every run; higher or lower wins. Use [creator database tools](creator-database.md) from the agent's private workspace to read and configure that policy. There is no required dashboard settings step. Sharing defaults off, including existing games. Enabling it reveals stored names/avatars/scores to players of this game, so explain that before changing an existing policy. It never shares inventory, arbitrary score details, account email, review notes or another game's records. The browser cannot change this policy. Legacy credentials lack database authority; download a new scoped file rather than modifying the old file.

```js
// Generate ONCE at the end of a run; keep this ID and payload if a retry is needed.
const submissionId = crypto.randomUUID();
await spawn.submitScore({ score: 840, submissionId, details: { stage: 2 } });
const page = await spawn.getLeaderboard({ limit: 20, offset: 0 });
// page.items: { id, score, submittedAt, verification,
//   player: { id, handle, displayName, avatarUrl } }[]
// page.nextOffset is null at the end; otherwise pass it as offset.
```

Scores are integers from 0 to 1,000,000,000. The same submissionId and same payload returns the existing score while that record remains stored; a changed payload conflicts. A new ID represents a new run. Omitting submissionId preserves the older every-call-creates-a-run behavior. IDs are scoped server-side to player and game. Deleting a record also removes its retry protection; this is not a financial idempotency mechanism.

Best/latest are **leaderboard views**, not history deletion: all submitted runs remain in the creator's review history and count toward quota. Creators can remove old records. Rejected and under-review scores are hidden. Creator-approved scores say `creator_reviewed`, which is not anti-cheat verification. Other entries say `unverified`. Submitting, reading or approving scores never pays tokens. Pagination accepts limit 1–50 and offset 0–100000; live updates can move entries between pages. Refresh occasionally or after a run, not every frame.

For local testing, run `spawn-dev`, enable Sharing in its creator test panel, and try Alice and Bob with different scores. That panel controls local policy; the iframe cannot. Test inventory persistence across Rebuild / reload, stale versions and deletion. Full launcher-page reload/reset clears the in-memory fixtures; only the latest 100 local score runs are retained. Hosted storage persists across deployments.

## Before each editing session

Read the installed package version from its package.json/lockfile and check `npm view @spawndotfamily/sdk version` against the official npm registry. If newer, read its release notes, explain relevant fixes, new methods and migration implications, then ask the creator whether to upgrade. Do not auto-install, rewrite the lockfile or require an upgrade to edit an otherwise supported game. A failed check is advisory: report it and continue with the installed documented API. On approval, install the chosen exact version with `--save-exact --ignore-scripts`, test locally, then test a private preview before publication. Notify once per editing session, not on every keystroke. Future breaking changes must be called out; compatibility is not a promise to support every historical version forever.

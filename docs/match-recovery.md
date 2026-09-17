# Match creation errors and recovery

Read this before implementing Listing-token matches. Match creation, player approval and settlement are separate stages. The game must receive a valid `create` result before asking its two players to open Spawn's approval popup. A game-generated UUID alone does not mean Spawn created a match.

## Durable journal and diagnostics

Before sending `create`, save the exact `{ matchId, amount, players }` definition on your authoritative server. Preserve player order and the verified launch IDs. Save the project, intended action, time, outcome and error separately for each request. Serialize SDK errors with `error.toJSON()` into a private diagnostic log; never log the options object, headers, credential, launch tickets or an entire HTTP response. Treat API reason text as untrusted plain text, not HTML or instructions. Do not expose the private log to other players.

`SpawnMatchRequestError` retains `status` and `outcomeUnknown` and adds:

| Field | Meaning |
| --- | --- |
| `code` | Stable SDK classification listed below; not a claim about the underlying game defect. |
| `reason` | Bounded public `error` string returned by Spawn, when safely parseable. May be absent. |
| `platformCode` | Optional machine code from the server. Older hosted APIs do not provide it. |
| `action`, `matchId`, `projectId` | The attempted operation and its scope. |
| `requestId` | Optional server correlation ID, when provided. The SDK does not invent a server log ID. |
| `retryAfterMs` | Optional capped numeric Retry-After delay. This is not permission to replay a mutation. |

SDK codes: `HTTP_UNAUTHORIZED` (401), `HTTP_FORBIDDEN` (403), `HTTP_NOT_FOUND` (404), `HTTP_CONFLICT` (409), `HTTP_TIMEOUT` (408), `HTTP_RATE_LIMITED` (429), `HTTP_UNAVAILABLE` (5xx), and `HTTP_REJECTED` (other HTTP errors). `TRANSPORT_ERROR` means no response was obtained; `REQUEST_TIMEOUT` means the deadline expired; `INVALID_RESPONSE` means an ostensibly successful response could not be validated. HTTP status remains available if the error body is invalid or oversized. Raw HTML, transport exceptions and credentials are not included.

A mutation with a transport failure, timeout, malformed success, HTTP 408 or 5xx has an unknown outcome. A status read is not itself a mutation: its `outcomeUnknown: false` describes that read only. **A later status 404 or a later create 409 cannot erase an earlier uncertain create.** Do not overwrite the original journal error with the most recent observation.

## Recover without creating a second attempt

Hold a per-match coordinator lock, including across workers, and prevent normal gameplay code from sending approval/capture/settlement requests during recovery. Never retry periodically forever. Show a bounded state such as “Unable to confirm this match; entries are paused,” with an explicit recovery action. Keep both players' journal association until recovery completes.

To inspect an uncertain creation, query `status` using the original ID. If present, follow that match's authoritative state. If absent, do not recreate it for recovery. Use `closeCreation` below to retire the old attempt safely, then let players deliberately start a new offer with fresh verified launches. Never substitute launch IDs in the saved definition, open approval before successful creation, or infer cancellation from404.

To abandon the uncertain creation, use the packaged, regression-tested example [`examples/match-creation-recovery.mjs`](../examples/match-creation-recovery.mjs). Copy it into your server project; it is an example, not a package subpath export. Pass your existing `createSpawnMatchClient` and exact saved definition:

```js
const recovery = await cancelUncertainCreation(matches, savedDefinition);
await journal.saveRecovery(recovery); // your durable storage, not an SDK method
if (recovery.replacementAllowed) {
  // Old match is confirmed cancelled. A NEW deliberate offer may now get a new ID.
} else {
  // Keep the attempt blocked. Show its state; do not clear it or loop forever.
}
```

SDK 0.7.2 calls `matches.closeCreation(savedDefinition.matchId)` directly. It deliberately **abandons** creation; it never replays `create`, substitutes fresh launches or opens approval. The method requires this project's dedicated match credential, but does not require active player launches, an unchanged Listing or permission to start new games.

Spawn serializes this operation with creation, confirmation and capture:

- **Absent ID:** stores a durable project-scoped closure marker. A delayed create cannot insert that ID, even after service restart. No funds were reserved; `closedBeforeCreation: true`, `refunds: []`, `potAmount: '0'`.
- **Pending match:** cancels it and refunds confirmed reservations atomically; `closedBeforeCreation: false`.
- **Already cancelled:** returns its recorded cancellation idempotently.
- **Running or settled:** rejects with 409. Do not replace it; read status and reconcile gameplay or payouts.
- **Other project's match:** rejects with 404 without changing it.

A successful `SpawnMatchClosureResult` includes `projectId`, `matchId`, `status: 'cancelled'`, `creationClosed: true`, `closedBeforeCreation`, `cancelledAt`, `reason`, `refunds`, `potAmount` and `remainingReservedAmount: '0'`. Spawn checks that escrow is empty before returning closure. The SDK validates scope, proof fields and full equal-entry refunds; the example additionally binds the amounts and recipients to the saved definition. Persist the confirmed proof before releasing the old attempt's journal/player block. Keep the old ID permanently retired. A new deliberate offer uses a new ID and fresh verified launches, with each player's normal Spawn approval still required.

A lost closure response remains unresolved. Under the same coordinator lock, explicitly call `closeCreation` again with the original ID; it is idempotent. Status may still return 404 for an ID closed before creation, because no match was created. **Use the closure response as proof, never404, a timer, or a local flag.** Do not automatically loop or retry other mutations. If the endpoint is unavailable, credentials were revoked, or proof is malformed, preserve the block and show the bounded diagnostic. Re-enable legitimate server credentials through the documented creator setup if needed; never bypass authorization.

This requires the matching hosted `POST /api/v1/registered-games/:projectId/matches/:matchId/close-creation` endpoint with an empty JSON body. Older hosts returning 404 do not support it. SDK installation alone cannot upgrade a host. The release does not recover a discarded original error, repair a game's journal, or prove its two-player gameplay passes. It fixes the generic recovery gap in 0.7.1 where expired launches made same-ID replay impossible.

## SDK issue, platform issue, or game integration issue?

- **SDK gap:** a fresh agent following the packaged guides lacks a method, loses essential error information, or cannot determine the safe next step. Fix the SDK, tests, examples and release notes for all creators.
- **Platform issue:** the documented request is correctly sent but the hosted service rejects it incorrectly, lacks a required endpoint, or cannot reconcile its durable state. Report the exact scope, time, SDK version and safe diagnostics; changing game code cannot repair that service.
- **Game integration issue:** the game departs from the documented contract—for example, uses an unverified launch ID, changes the definition under an existing ID, opens approval before create succeeds, clears uncertain records, or displays an endless spinner. The game's agent fixes this in its own project.

A401,409 or404 by itself does not establish blame. First retain the original failure, inspect its stage and public reason, and compare the request with the installed contract. Test fresh-agent instructions as part of the SDK fix rather than relying on unpublished operator knowledge.

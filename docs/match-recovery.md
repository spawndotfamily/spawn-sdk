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

To resume an uncertain creation, query `status` using the original ID. If present, follow that match's authoritative state. If absent, an explicit `create` call with the **exact same saved definition** can reconcile it: Spawn enforces immutable, transactional match-ID idempotency. This is not a new ID, a changed wager, a fresh launch ID, or an automatic transport retry. If that call fails, uncertainty remains. Do not open player approval until a valid existing/pending match has been returned.

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

The example reads status; if it returns 404, it makes one explicit same-ID create, then cancels a pending match. It returns `replacementAllowed: true` only after confirming a cancelled result. Spawn retains the cancelled match row, so a delayed duplicate create using the original ID cannot resurrect it or reserve a new pot. Existing player reservations are refunded by the platform's cancellation operation. No balance transfer is inferred from a browser click.

If the match is running or settled, the example does not cancel it or allow replacement; reconcile gameplay or the terminal payouts instead. If a launch expired, setup changed, the network failed, or the platform cannot confirm cancellation, it returns unresolved. Neither waiting a fixed number of seconds nor a404 proves safe absence. Keep the record and seek platform diagnosis; the current API has no “close an absent match ID” endpoint. Do not invent one, rotate credentials as a workaround, or create a new ID to get around an unresolved attempt.

This release adds SDK diagnostics and a recovery example using existing endpoints. It does **not** deploy platform logging, retrospectively recover a discarded error, repair a particular game's journal, or guarantee the hosted service is healthy. A private operator investigation may still be necessary for a historical unresolved attempt.

## SDK issue, platform issue, or game integration issue?

- **SDK gap:** a fresh agent following the packaged guides lacks a method, loses essential error information, or cannot determine the safe next step. Fix the SDK, tests, examples and release notes for all creators.
- **Platform issue:** the documented request is correctly sent but the hosted service rejects it incorrectly, lacks a required endpoint, or cannot reconcile its durable state. Report the exact scope, time, SDK version and safe diagnostics; changing Hotel code cannot repair that service.
- **Game integration issue:** the game departs from the documented contract—for example, uses an unverified launch ID, changes the definition under an existing ID, opens approval before create succeeds, clears uncertain records, or displays an endless spinner. The game's agent fixes this in its own project.

A401,409 or404 by itself does not establish blame. First retain the original failure, inspect its stage and public reason, and compare the request with the installed contract. Test fresh-agent instructions as part of the SDK fix rather than relying on unpublished operator knowledge.

# Guest play

Published free games can open without an account. Private previews still require sign-in. Use the same SDK and startup controller for everyone; Spawn supplies a guest identity through the trusted bridge. A connection failure must never silently become guest mode.

```js
const player = await client.identity();
if (player.isGuest) {
  // Allow free play; keep scores and progress inside this play session.
  showFreeModes();
} else {
  showAccountModes();
}
```

`identity().isGuest` is true for guests. `identity().id` is a unique game-scoped ID, stable in that browser while the guest cookie remains valid (currently 30 days). Different browsers receive different IDs. Clearing cookies, expiration or another device creates another identity; this is not proof of a unique human and is unsuitable for reward eligibility or account bans. Guest IDs are public labels, never authentication secrets. Do not use the display name as a database key.

Guests receive `capabilities: { play: true, submitScores: false, cloudSaves: false, payments: false, rewards: false }`. These describe the session; they do not grant authority. Current guest sessions cannot read hosted scores or saves either. The server enforces these restrictions even if someone changes browser code. No guest scores, cloud saves, balances or rewards are created. Games may keep temporary progress in memory; do not promise persistence in the isolated iframe.

For paid actions, Spawn offers sign-in using its own overlay. Signing in does not charge, replay the action, or promote earlier guest scores. It reopens a new account session; warn players if this will discard an active run. After sign-in the player chooses the paid action again and confirms it normally. Do not add duplicate Spawn login or payment overlays.

## Compatibility and local testing

New SDKs request identity version 2. Older launchers may omit `isGuest` and capabilities for member sessions; do not require these fields for existing integrations. New launchers return the old identity shape to older SDKs so their strict parsers still connect, while server restrictions remain in force.

In `spawn-dev`, choose **Guest**. Test free play, unique/stable identity, denied saves/scores/payments, switching to Alice, and reconnecting. Local guest IDs last for that local launcher state. Fake local accounts and balances never reach Spawn. Repeat the free-game flow signed out on the published game.

## Multiplayer server integration

Guest launch grants have `isGuest: true`, a `guest_` ID and the distinct `multiplayer:join:free` scope. The server verifier rejects them by default. Set `allowGuests: true` only when your server explicitly excludes guests from paid queues, reward settlement and account score recording. Use the returned verified `isGuest`, not a client-supplied flag. Preserve it during renewal and resume. Keep the same signature, audience, game, expiry, replay, admission and resource limits as member connections. Mixed free matches with guests are practice sessions and must not award official account results.

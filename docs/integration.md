# Integration boundaries

The browser client sends requests to `/api/v1/game-storage/rob-the-rich/{key}`. Keys contain 1–64 letters, digits, underscores or hyphens. GET returns a save or null; PUT takes `value` and `expectedVersion`. The server scopes data to the authenticated user and game, and rejects invalid versions and quota violations.

Keep a game’s rendering, input, rules, assets and networking in focused modules. Store secrets only on a trusted server. Multiplayer authority, payouts and anti-cheat must not rely on browser claims. You may run your own game server and database; this prototype does not provision them.

Third-party games will need isolated origins and short-lived, game-scoped credentials. That protocol, GitHub deployment, matchmaking and reward APIs are not implemented. Do not remove the game allowlist or change the transport to forward session cookies to another origin as a workaround.

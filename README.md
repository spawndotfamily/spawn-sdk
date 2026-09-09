# Spawn SDK

Public source for Spawn’s first-party save client prototype. This package is not released on npm. The platform is under development; public source does not mean third-party game hosting is enabled.

## Current support

- Load and save JSON through Spawn’s authenticated API.
- Optimistic version checks to detect conflicting saves.
- Same-origin browser sessions for the reviewed `rob-the-rich` game only.

Google OAuth must be configured on the platform before real users can sign in. No wallet is created, no tokens are moved and no game reward is authorized by this SDK.

## Local development

Requires Node 22.13+ and npm. Run `npm ci`, `npm test` and `npm run build`. For workspace experiments, import `createSpawnClient` from `src/index.ts` through your TypeScript bundler; build output is in `dist/`.

```ts
import { createSpawnClient } from './path/to/spawn-sdk/src/index';
const spawn = createSpawnClient('rob-the-rich');
const prior = await spawn.load<{ level: number }>('progress');
await spawn.save('progress', { level: 3 }, prior?.version ?? 0);
```

Run the game on the same origin as the local Spawn platform (`http://localhost:3003`). A separate localhost port is a different origin and is not supported by the current transport.

Saves are limited to 12 KB each, 100 keys and 64 KB per player per game. On a conflict, reload before deciding how to merge or retry. Browser saves are untrusted player input, not authoritative competitive results or redeemable balances.

See [integration boundaries](docs/integration.md) and the [developer documentation](https://spawn-launchpad.gitbook.io/spawn-docs/developers). Source is MIT licensed; Spawn branding and third-party game assets are not included in this license.

import type { SpawnTableClient, SpawnMatchClient, SpawnPayoutClient, SpawnTokenClient, SpawnPaymentClient, SpawnLaunchVerificationOptions, SpawnTableAsset } from '@spawndotfamily/sdk/server';
export type LocalApproval =
  | { kind: 'table'; tableId: string; buyInId: string }
  | { kind: 'match'; matchId: string }
  | { kind: 'token'; amount: string; item?: string }
  | { kind: 'trade'; tradeId: string };
export interface LocalTestPlayer {
  playerId: string; launchId: string; displayName: string;
  /** Local-only capability URL. Treat it as a test-session credential. */
  url: string;
  balance(): string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Queues the production approval UI in this player's browser. Does not approve. */
  requestApproval(input: LocalApproval, options?: { timeoutMs?: number }): Promise<unknown>;
  grant(): { ticket: string; serverOrigin: string };
}
export interface SpawnTestHost {
  readonly simulated: true;
  readonly origin: string;
  readonly projectId: string;
  readonly asset: SpawnTableAsset;
  readonly credential: string;
  readonly players: LocalTestPlayer[];
  readonly verification: SpawnLaunchVerificationOptions;
  readonly clientOptions: { platformOrigin: string; projectId: string; credential: string };
  readonly tables: SpawnTableClient;
  readonly matches: SpawnMatchClient;
  readonly payouts: SpawnPayoutClient;
  readonly tokens: SpawnTokenClient;
  readonly payments: SpawnPaymentClient;
  player(playerId: string): LocalTestPlayer;
  /** Applies one request, then drops its response to test uncertain-outcome recovery. */
  loseNextResponse(path: string): void;
  advance(ms: number): unknown;
  snapshot(): unknown;
  audit(): Array<{ simulated: true; playerId: string; requestId: string; kind: string; outcome: string }>;
  close(): Promise<void>;
}
/** All balances are synthetic base-unit strings. Uses Node's built-in SQLite. */
export function startSpawnTestHost(options?: {
  players?: number;
  balance?: string;
  port?: number;
  /** Creator game served at a literal loopback HTTP URL. No production game allowed. */
  gameUrl?: string;
  /** Inspected built browser directory for createSpawnGameClient; mutually exclusive with gameUrl. */
  gameDirectory?: string;
  /** Inferred from gameDirectory. Multiplayer uses gameUrl; ordinary games use gameDirectory. */
  mode?: 'game' | 'multiplayer';
  /** New or previously created LOCAL test database only; no environment files are read. */
  databasePath?: string;
}): Promise<SpawnTestHost>;

/**
 * Types for the loopback table harness. Ships with the package so editors and AI agents get the
 * whole surface without reading the .mjs source.
 */
import type { createSpawnTableClient } from '@spawndotfamily/sdk/server';

/** Integer base-unit amount as a string. Location: `'100'` = 100 base units = `1.00` at decimals 2. */
export type BaseUnits = string;

/** The real SDK table client, wired to the loopback service. */
export type TableClient = ReturnType<typeof createSpawnTableClient>;

export interface LoopbackAsset {
  id: string;
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  image?: string;
  source?: string;
  enabled?: boolean;
}

export interface TableTotals {
  buyIns: BaseUnits;
  cashOuts: BaseUnits;
  stacks: BaseUnits;
  committed: BaseUnits;
  pendingCashOuts: BaseUnits;
  /** `stacks + committed + pendingCashOuts` — the identity is `buyIns = cashOuts + backing`. */
  backing: BaseUnits;
}

export interface TableSeat {
  playerId: string;
  seatId: string;
  stack: BaseUnits;
  pendingCashOut: BaseUnits;
  status: string;
  connectedUntil: number;
  disconnectDeadline: number | null;
}

export interface TableQuote {
  buyInId: string;
  playerId: string;
  amount: BaseUnits;
  status: string;
  expiresAt: number;
  [key: string]: unknown;
}

export interface TableSnapshot {
  tableId: string;
  projectId: string;
  status: string;
  asset: LoopbackAsset;
  settingsVersion: number;
  maxSeats: number;
  revision: number;
  leaseExpiresAt: number;
  maxEndsAt: number;
  seats: TableSeat[];
  hand: unknown | null;
  totals: TableTotals;
}

/** `state(playerId)` — a snapshot plus every quote and this player's pending one. */
export interface AgentState extends TableSnapshot {
  quotes: TableQuote[];
  pendingQuote: TableQuote | null;
}

export interface Conservation {
  balanced: boolean;
  totals: TableTotals;
  /** `buyIns - (cashOuts + backing)`; `'0'` when balanced. */
  delta: BaseUnits;
  /** Human-readable identity, naming the imbalance when there is one. */
  detail: string;
}

export interface ClientCall {
  action: string;
  input: unknown;
}

export interface LoopbackTableServiceOptions {
  /** Clock source, read LIVE on every call. Defaults to `Date.now`. */
  now?: number | (() => number);
  /** Fake asset handed to the client; defaults to `LOCAL` on chain 46630 with 2 decimals. */
  asset?: LoopbackAsset;
}

export interface LoopbackTableService {
  /** The real SDK client — call the same methods your game calls. */
  readonly client: TableClient;
  readonly projectId: string;
  readonly asset: LoopbackAsset;
  /** Every call the service received, in order. */
  readonly calls: ClientCall[];
  state(playerId?: string): AgentState;
  /** Acts as the player approving their own quote in the Spawn overlay. */
  confirmBuyIn(playerId: string): unknown;
  /** Clears the disconnect deadline, as a returning player would. */
  reconnect(playerId: string): TableSeat;
  /**
   * The next call to `action` applies and records the mutation, then throws; retrying with the
   * same `operationId` replays the recorded result instead of applying twice.
   */
  loseNextResponse(action: string): void;
  /** Move time forward by `ms`, then run the recovery sweep (expiry, grace, lease, deadline). */
  advance(ms: number): TableSnapshot | null;
  /** Wrap one client method; the rest keep delegating to the real frozen client. */
  stubClient(overrides?: Partial<TableClient>): TableClient;
  conservation(): Conservation;
}

export declare const TABLE_POLICY: {
  quoteMs: number;
  leaseMs: number;
  disconnectGraceMs: number;
  handDeadlineMs: number;
  maxAgeMs: number;
};

export function createLoopbackTableService(options?: LoopbackTableServiceOptions): LoopbackTableService;
export function stubClient(client: TableClient, overrides?: Partial<TableClient>): TableClient;

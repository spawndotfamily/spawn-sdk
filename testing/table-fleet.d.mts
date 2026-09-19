/**
 * Types for the table fleet driver. Ships with the package so a creator (or their agent) can run
 * N simulated players across M loopback tables with full signatures.
 */
import type { BaseUnits, TableTotals } from './loopback-table-service.mjs';

export interface FleetOptions {
  /** Players to seat. Default 100. */
  players?: number;
  /** Tables to spread them across. Default `ceil(players / maxSeats)`; at least 1 per player. */
  tables?: number;
  /** Seats per table, 2-6. Default 6. */
  maxSeats?: number;
  /** Hands played per table. Default 3. */
  hands?: number;
  /** Buy-in per player, canonical base units. Default `'1000'`. */
  buyIn?: BaseUnits;
  /** Per-hand stake, canonical base units. Default `'100'`. */
  stake?: BaseUnits;
  /**
   * Drive one under-funded and one zero-balance approval per table and count the refusals.
   * Default true.
   */
  refusals?: boolean;
}

export interface FleetRefusals {
  /** Players refused because their tracked balance was below the quote. */
  insufficientBalance: number;
  /** Players refused because their tracked balance was zero. */
  zeroBalance: number;
  total: number;
}

export interface FleetTableReport {
  /** 1-based table number. */
  index: number;
  tableId: string;
  seats: number;
  /** The `maxSeats` this table was created with (`min(maxSeats, seats)`, at least 2). */
  maxSeats: number;
  /** Hands actually played (a table that drops below two seats plays none). */
  hands: number;
  /** Players paid out, mid-run and at settlement. */
  cashOuts: number;
  refusals: FleetRefusals;
  balanced: boolean;
  totals: TableTotals;
  /** The opt-in test wallets: tracked players and their net change (always `'0'`). */
  wallets: { tracked: number; netChange: BaseUnits; balanced: boolean };
}

export interface FleetAggregate {
  balanced: boolean;
  buyIns: BaseUnits;
  cashOuts: BaseUnits;
  stacks: BaseUnits;
  committed: BaseUnits;
  pendingCashOuts: BaseUnits;
  backing: BaseUnits;
  /** `buyIns - (cashOuts + backing)`; `'0'` when balanced. */
  delta: BaseUnits;
  /** Human-readable identity, naming the imbalance when there is one. */
  detail: string;
}

export interface FleetReport {
  title: string;
  /** True when every table and the aggregate conserved. */
  ok: boolean;
  players: number;
  tables: number;
  maxSeats: number;
  /** Hands requested per table. */
  hands: number;
  seated: number;
  handsPlayed: number;
  cashOuts: number;
  refusals: FleetRefusals;
  aggregate: FleetAggregate;
  wallets: { tracked: number; netChange: BaseUnits; balanced: boolean };
  balanced: boolean;
  perTable: FleetTableReport[];
  durationMs: number;
}

/** Drive the fleet; throws on any imbalance, otherwise returns the report. */
export function runFleet(options?: FleetOptions): Promise<FleetReport>;

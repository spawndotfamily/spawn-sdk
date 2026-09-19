/**
 * Types for the loopback payout harness. Ships with the package so editors and AI agents get the
 * whole surface without reading the .mjs source.
 */
import type { createSpawnPayoutClient } from '@spawndotfamily/sdk/server';

/** Integer base-unit amount as a string. Location: `'100'` = 100 base units. */
export type BaseUnits = string;

/** The real SDK payout client, wired to the loopback service. */
export type PayoutClient = ReturnType<typeof createSpawnPayoutClient>;

/** The platform's recorded payout receipt for one operation ID. */
export interface PayoutReceipt {
  id: string;
  projectId: string;
  playerId: string;
  assetId: string;
  amount: BaseUnits;
  depositId: string | null;
  status: 'paid';
  createdAt: number;
}

/** A simulated paid deposit: the member was debited and the pool credited. */
export interface PayoutDeposit {
  depositId: string;
  playerId: string;
  amount: BaseUnits;
  status: 'paid';
  paidAt: number;
}

export interface MemberState {
  playerId: string;
  balance: BaseUnits;
  /** The member's active launch, or `null` when none is recorded. */
  launchId: string | null;
}

/** `state(playerId?)` — pool, members, deposits and recorded receipts in one object. */
export interface AgentState {
  projectId: string;
  /** `null` models a game with no Listing token configured; payouts are refused. */
  assetId: string | null;
  /** The 503 reason while suspended, otherwise `null`. */
  suspended: string | null;
  pool: BaseUnits;
  members: MemberState[];
  deposits: PayoutDeposit[];
  payouts: PayoutReceipt[];
  /** The most recent payout receipt for `playerId`, or `null`. */
  lastPayout: PayoutReceipt | null;
}

export interface Conservation {
  balanced: boolean;
  totals: {
    pool: BaseUnits;
    members: BaseUnits;
    /** `pool + members` — the invariant is that this never changes. */
    total: BaseUnits;
    /** `pool + members` at construction. */
    initial: BaseUnits;
    deposits: BaseUnits;
    payouts: BaseUnits;
  };
  /** `total - initial`; `'0'` when balanced. */
  delta: BaseUnits;
  /** Human-readable identity, naming the imbalance when there is one. */
  detail: string;
}

export interface ClientCall {
  action: string;
  input: unknown;
}

export interface LoopbackPayoutServiceOptions {
  /** Clock source, read LIVE on every call. Defaults to `Date.now`. */
  now?: number | (() => number);
  /** Fake Listing asset ID; defaults to a LOCAL erc20 on chain 46630. `null` = no Listing token. */
  assetId?: string | null;
  /** Registered members and their tracked starting balances, in base units. */
  members?: Record<string, string | number>;
  /** Optional active launch per registered member; a launch-bound payout must match it. */
  launches?: Record<string, string>;
  /** The game's starting pool balance, in base units. Defaults to `'0'`. */
  pool?: string | number;
  /** Fixed project ID; defaults to a fresh UUID. */
  projectId?: string;
  /** The 43-character credential the fake platform expects; defaults to `'x'.repeat(43)`. */
  credential?: string;
}

export interface LoopbackPayoutService {
  /** The real SDK payout client — call the same methods your server calls. */
  readonly client: PayoutClient;
  readonly projectId: string;
  readonly assetId: string | null;
  /** The fake platform transport; wrap it to probe contract edges the client cannot reach. */
  readonly transport: typeof globalThis.fetch;
  /** Every payout call the service received, in order. */
  readonly calls: ClientCall[];
  state(playerId?: string): AgentState;
  /** The game's current pool balance, as a base-unit string. */
  pool(): BaseUnits;
  /**
   * Tracked balance for `playerId`, or `null` when that player is not a registered member.
   * Deposits debit it; payouts credit it.
   */
  balance(playerId: string): BaseUnits | null;
  /**
   * Simulate that member's already-paid deposit: debit the member, credit the pool, record
   * the paid deposit. Returns the deposit record.
   */
  deposit(playerId: string, amount: string | number, options?: { depositId?: string }): PayoutDeposit;
  /** Drop a member's active launch; a launch-bound payout is then refused, an unbound one still pays. */
  expireLaunch(playerId: string): void;
  /** Make every payout write fail 503 until `resume()`. Returns the reason. */
  suspend(reason?: string): string;
  resume(): void;
  /**
   * The next call to `action` applies and records the payout, then throws; retrying with the
   * same `operationId` replays the recorded receipt instead of paying twice.
   */
  loseNextResponse(action: string): void;
  /** Move the harness clock forward by `ms` (the payout rate-bound window reads it). */
  advance(ms: number): AgentState;
  /** Wrap one client method; the rest keep delegating to the real frozen client. */
  stubClient(overrides?: Partial<PayoutClient>): PayoutClient;
  conservation(): Conservation;
}

export declare const PAYOUT_POLICY: {
  writesPerMinute: number;
  maxReasonLength: number;
};

export function createLoopbackPayoutService(options?: LoopbackPayoutServiceOptions): LoopbackPayoutService;
export function stubClient(client: PayoutClient, overrides?: Partial<PayoutClient>): PayoutClient;

import type { SpawnMatchAsset } from './match-server.ts';

export type SpawnTableClientOptions = {
  platformOrigin: string;
  projectId: string;
  /** Dedicated game server credential. Publishing and storage keys are rejected by the platform. */
  credential: string;
  timeoutMs?: number;
  /** Optional transport for isolated tests. It must enforce the supplied request options. */
  fetch?: typeof globalThis.fetch;
};

export type SpawnTableAsset = SpawnMatchAsset;
export type SpawnTableStatusName = 'open' | 'closing' | 'closed';
export type SpawnTableBuyInStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired';

export type SpawnTableSeat = {
  /** UUID seat generation; stale exits cannot affect a later re-seat. */
  seatId: string;
  playerId: string;
  stack: string;
  pendingCashOut: string;
  status: 'active' | 'leaving';
  connectedUntil: number | null;
  disconnectDeadline: number | null;
};

export type SpawnTableHandPlayer = {
  seatId: string;
  playerId: string;
  contribution: string;
  folded: boolean;
};

export type SpawnTablePot = {
  cap: string;
  amount: string;
  eligible: string[];
};

export type SpawnTableHand = {
  handId: string;
  revision: number;
  deadline: number;
  players: SpawnTableHandPlayer[];
  pots: SpawnTablePot[];
};

export type SpawnTableTotals = {
  buyIns: string;
  cashOuts: string;
  stacks: string;
  committed: string;
  pendingCashOuts: string;
  backing: string;
};

/** Public table state returned by the dedicated creator server route. */
export type SpawnTableStatus = {
  tableId: string;
  projectId: string;
  status: SpawnTableStatusName;
  asset: SpawnTableAsset | null;
  settingsVersion: number;
  maxSeats: number;
  revision: number;
  leaseExpiresAt: number | null;
  maxEndsAt: number;
  totals: SpawnTableTotals;
  seats: SpawnTableSeat[];
  hand: SpawnTableHand | null;
};

export type SpawnTableBuyInQuote = {
  tableId: string;
  buyInId: string;
  playerId: string;
  quoteId: string;
  status: SpawnTableBuyInStatus;
  amount: string;
  asset: SpawnTableAsset;
  settingsVersion: number;
  expiresAt: number;
};

export type SpawnTableBuyInResult = {
  tableId: string;
  buyInId: string;
  status: 'confirmed' | 'cancelled';
};

/** Player route quote, which includes only that player's available balance. */
export type SpawnTablePlayerBuyInQuote = SpawnTableBuyInQuote & {
  balance: string;
  gameName: string;
};

export type SpawnTablePlayerStatus = {
  tableId: string;
  projectId: string;
  playerId: string;
  /** The current seat generation, or the last generation after cash-out. */
  seatId: string | null;
  seat: SpawnTableSeat | null;
  stack: string;
  pendingCashOut: string;
  seatStatus: 'active' | 'leaving' | 'cashed_out' | null;
  publicTableState: SpawnTableStatus;
};

export type SpawnTableCreateInput = {
  tableId: string;
  operationId: string;
  maxSeats: number;
};

export type SpawnTableBuyInInput = {
  operationId: string;
  buyInId: string;
  player: { playerId: string; launchId: string };
  amount: string;
};

export type SpawnTableStartHandInput = {
  operationId: string;
  handId: string;
  players: { playerId: string; seatId: string }[];
};

export type SpawnTableCommitHandInput = {
  operationId: string;
  handId: string;
  expectedRevision: number;
  contributions: { playerId: string; amount: string }[];
  folded: string[];
};

export type SpawnTableSettleHandInput = {
  operationId: string;
  handId: string;
  expectedRevision: number;
  pots: { cap: string; winners: { playerId: string; amount: string }[] }[];
};

export type SpawnTableCashOutInput = { operationId: string; playerId: string; seatId: string };
export type SpawnTableDisconnectInput = { operationId: string; playerId: string; seatId: string };

export type SpawnTableOperationResult = SpawnTableStatus | SpawnTableBuyInQuote | SpawnTablePlayerBuyInQuote | SpawnTablePlayerStatus;
export type SpawnTableOperationAction =
  | 'create'
  | 'requestBuyIn'
  | 'startHand'
  | 'commitHand'
  | 'settleHand'
  | 'cashOut'
  | 'disconnect'
  | 'playerLeave'
  | 'confirmBuyIn'
  | 'cancelBuyIn'
  | 'close';
/** Optional recovery context used to bind an operation result to its saved intent. */
export type SpawnTableOperationExpectation = {
  action?: SpawnTableOperationAction;
  buyInId?: string;
  playerId?: string;
};
export type SpawnTableOperation = {
  operationId: string;
  action: SpawnTableOperationAction;
  result: SpawnTableOperationResult;
};

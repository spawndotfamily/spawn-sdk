import type {
  SpawnTableAsset,
  SpawnTableBuyInQuote,
  SpawnTableBuyInResult,
  SpawnTableBuyInStatus,
  SpawnTableHand,
  SpawnTableHandPlayer,
  SpawnTableOperation,
  SpawnTableOperationExpectation,
  SpawnTableOperationResult,
  SpawnTablePlayerStatus,
  SpawnTablePlayerBuyInQuote,
  SpawnTablePot,
  SpawnTableSeat,
  SpawnTableStatus,
  SpawnTableTotals,
} from './table-types.ts';

export const TABLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GUEST = /^guest_[a-f0-9]{64}$/i;
const BASE_UNITS = /^(?:0|[1-9][0-9]{0,77})$/;
const UINT256_MAX = (2n ** 256n) - 1n;
const TABLE_ACTIONS = new Set<SpawnTableOperation['action']>([
  'create', 'requestBuyIn', 'startHand', 'commitHand', 'settleHand', 'cashOut', 'disconnect', 'playerLeave', 'confirmBuyIn', 'cancelBuyIn', 'close',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function validateUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !TABLE_UUID.test(value))
    throw new Error(`${name} must be a UUID.`);
  return value.toLowerCase();
}

export function validateMemberUuid(value: unknown, name: string): string {
  if (typeof value === 'string' && GUEST.test(value))
    throw new Error(`${name} must be a signed-in Spawn member; guests cannot use tables.`);
  return validateUuid(value, name);
}

export function validateBaseUnits(value: unknown, name: string, positive = false): string {
  if (typeof value !== 'string' || !BASE_UNITS.test(value))
    throw new Error(`${name} must be a canonical unsigned integer in token base units.`);
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX || positive && parsed === 0n)
    throw new Error(`${name} must fit uint256 base units${positive ? ' and be greater than zero' : ''}.`);
  return value;
}

export function validateNonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${name} must be a nonnegative safe integer.`);
  return value as number;
}

function timestamp(value: unknown, name: string): number {
  return validateNonnegativeInteger(value, name);
}

function nullableTimestamp(value: unknown, name: string): number | null {
  if (value === null) return null;
  return timestamp(value, name);
}

export function validateAsset(value: unknown, allowLocal: boolean): SpawnTableAsset {
  if (!exact(value, ['id', 'chainId', 'address', 'name', 'symbol', 'decimals', 'image', 'source', 'enabled']))
    throw new Error('Invalid table token identity.');
  const chainId = validateNonnegativeInteger(value.chainId, 'asset.chainId');
  if (![46630, 31337].includes(chainId) || chainId === 31337 && !allowLocal)
    throw new Error('Invalid table token network.');
  if (typeof value.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value.address))
    throw new Error('Invalid table token address.');
  if (value.id !== `erc20:${chainId}:${value.address.toLowerCase()}`)
    throw new Error('Table token identity is not canonical.');
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 160 || /[\u0000-\u001f\u007f]/.test(value.name))
    throw new Error('Invalid table token name.');
  if (typeof value.symbol !== 'string' || value.symbol.length === 0 || value.symbol.length > 32 || /[\u0000-\u001f\u007f]/.test(value.symbol))
    throw new Error('Invalid table token symbol.');
  if (!Number.isInteger(value.decimals) || (value.decimals as number) < 0 || (value.decimals as number) > 36)
    throw new Error('Invalid table token decimals.');
  if (typeof value.image !== 'string' || value.image.length > 4096 || /[\u0000-\u001f\u007f]/.test(value.image))
    throw new Error('Invalid table token image.');
  if (value.enabled !== true || value.source !== 'spawn' && value.source !== 'partner')
    throw new Error('Invalid table token availability.');
  return value as SpawnTableAsset;
}

export function validateSeat(value: unknown, allowLocal: boolean): SpawnTableSeat {
  if (!exact(value, ['seatId', 'playerId', 'stack', 'pendingCashOut', 'status', 'connectedUntil', 'disconnectDeadline']))
    throw new Error('Invalid table seat.');
  return {
    seatId: validateUuid(value.seatId, 'seatId'),
    playerId: validateMemberUuid(value.playerId, 'seat.playerId'),
    stack: validateBaseUnits(value.stack, 'seat.stack'),
    pendingCashOut: validateBaseUnits(value.pendingCashOut, 'seat.pendingCashOut'),
    status: value.status === 'active' || value.status === 'leaving' ? value.status : (() => { throw new Error('Invalid table seat status.'); })(),
    connectedUntil: nullableTimestamp(value.connectedUntil, 'seat.connectedUntil'),
    disconnectDeadline: nullableTimestamp(value.disconnectDeadline, 'seat.disconnectDeadline'),
  };
}

function validateHand(value: unknown, seatById: Map<string, string>): SpawnTableHand | null {
  if (value === null) return null;
  if (!exact(value, ['handId', 'revision', 'deadline', 'players', 'pots']))
    throw new Error('Invalid table hand.');
  const handId = validateUuid(value.handId, 'hand.handId');
  const revision = validateNonnegativeInteger(value.revision, 'hand.revision');
  const deadline = timestamp(value.deadline, 'hand.deadline');
  if (!Array.isArray(value.players) || value.players.length < 2 || value.players.length > 6)
    throw new Error('Invalid table hand players.');
  const players: SpawnTableHandPlayer[] = [];
  const handIds = new Set<string>();
  for (const player of value.players) {
    if (!exact(player, ['seatId', 'playerId', 'contribution', 'folded']))
      throw new Error('Invalid table hand player.');
    const seatId = validateUuid(player.seatId, 'hand seatId');
    const playerId = validateMemberUuid(player.playerId, 'hand playerId');
    if (handIds.has(playerId)) throw new Error('Table hand players must be distinct funded seats.');
    if (seatById.get(seatId) !== playerId) throw new Error('Hand seat IDs must be current table seats.');
    handIds.add(playerId);
    players.push({
      seatId,
      playerId,
      contribution: validateBaseUnits(player.contribution, 'hand contribution'),
      folded: player.folded === true ? true : player.folded === false ? false : (() => { throw new Error('Invalid hand folded flag.'); })(),
    });
  }
  if (!Array.isArray(value.pots) || value.pots.length > 6)
    throw new Error('Invalid table hand pots.');
  const pots: SpawnTablePot[] = [];
  for (const pot of value.pots) {
    if (!exact(pot, ['cap', 'amount', 'eligible']) || !Array.isArray(pot.eligible) || pot.eligible.length > 6)
      throw new Error('Invalid table side pot.');
    const eligible: string[] = [];
    const eligibleIds = new Set<string>();
    for (const playerIdValue of pot.eligible) {
      const playerId = validateMemberUuid(playerIdValue, 'pot eligible playerId');
      if (eligibleIds.has(playerId) || !handIds.has(playerId))
        throw new Error('Invalid table side pot eligibility.');
      eligibleIds.add(playerId);
      eligible.push(playerId);
    }
    pots.push({
      cap: validateBaseUnits(pot.cap, 'pot cap', true),
      amount: validateBaseUnits(pot.amount, 'pot amount'),
      eligible,
    });
  }
  return { handId, revision, deadline, players, pots };
}

/** Validate and normalize the public server table status. */
export function validateSpawnTableStatus(
  value: unknown,
  expectedProjectId?: string,
  platformOrigin = 'https://spawn.example',
): SpawnTableStatus {
  if (!exact(value, [
    'tableId', 'projectId', 'status', 'asset', 'settingsVersion', 'maxSeats',
    'revision', 'leaseExpiresAt', 'maxEndsAt', 'totals', 'seats', 'hand',
  ]))
    throw new Error('Invalid table status response.');
  const tableId = validateUuid(value.tableId, 'tableId');
  const projectId = validateUuid(value.projectId, 'projectId');
  if (expectedProjectId !== undefined && projectId !== expectedProjectId.toLowerCase())
    throw new Error('Table response belongs to a different project.');
  if (value.status !== 'open' && value.status !== 'closing' && value.status !== 'closed')
    throw new Error('Invalid table status.');
  const maxSeats = validateNonnegativeInteger(value.maxSeats, 'maxSeats');
  if (maxSeats > 6) throw new Error('Table maxSeats must be between 2 and 6.');
  const settingsVersion = validateNonnegativeInteger(value.settingsVersion, 'settingsVersion');
  const allowLocal = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(platformOrigin).hostname);
  let asset: SpawnTableAsset | null;
  if (value.asset === null) asset = null;
  else asset = validateAsset(value.asset, allowLocal);
  if (value.status !== 'closed' && (asset === null || settingsVersion < 1))
    throw new Error('Open table status requires an active Listing token snapshot.');
  const tombstone = value.status === 'closed' && asset === null;
  if (tombstone && (settingsVersion !== 0 || maxSeats !== 0 || value.leaseExpiresAt !== null))
    throw new Error('A closed table tombstone must omit its token snapshot and lease.');
  if (value.status === 'closed' && value.hand !== null)
    throw new Error('A closed table cannot have a running hand.');
  if (asset === null && !tombstone)
    throw new Error('Only a closed tombstone may omit its Listing token snapshot.');
  if (asset !== null && settingsVersion < 1)
    throw new Error('A funded table must retain its Listing token snapshot.');
  if (!tombstone && (maxSeats < 2 || maxSeats > 6))
    throw new Error('Table maxSeats must be between 2 and 6.');
  const revision = validateNonnegativeInteger(value.revision, 'revision');
  const leaseExpiresAt = value.leaseExpiresAt === null ? null : timestamp(value.leaseExpiresAt, 'leaseExpiresAt');
  const maxEndsAt = timestamp(value.maxEndsAt, 'maxEndsAt');
  if (!exact(value.totals, ['buyIns', 'cashOuts', 'stacks', 'committed', 'pendingCashOuts', 'backing']))
    throw new Error('Invalid table totals.');
  const totals: SpawnTableTotals = {
    buyIns: validateBaseUnits(value.totals.buyIns, 'totals.buyIns'),
    cashOuts: validateBaseUnits(value.totals.cashOuts, 'totals.cashOuts'),
    stacks: validateBaseUnits(value.totals.stacks, 'totals.stacks'),
    committed: validateBaseUnits(value.totals.committed, 'totals.committed'),
    pendingCashOuts: validateBaseUnits(value.totals.pendingCashOuts, 'totals.pendingCashOuts'),
    backing: validateBaseUnits(value.totals.backing, 'totals.backing'),
  };
  if (
    BigInt(totals.buyIns) !== BigInt(totals.cashOuts) + BigInt(totals.stacks) + BigInt(totals.committed) + BigInt(totals.pendingCashOuts) ||
    BigInt(totals.backing) !== BigInt(totals.stacks) + BigInt(totals.committed) + BigInt(totals.pendingCashOuts)
  ) throw new Error('Table monetary totals are not conserved.');
  if (tombstone && Object.values(totals).some((amount) => amount !== '0'))
    throw new Error('A closed table tombstone must have zero monetary totals.');
  if (!Array.isArray(value.seats) || value.seats.length > maxSeats) throw new Error('Invalid table seats.');
  const seats: SpawnTableSeat[] = [];
  const playerIds = new Set<string>();
  const seatById = new Map<string, string>();
  for (const seat of value.seats) {
    const normalized = validateSeat(seat, allowLocal);
    if (playerIds.has(normalized.playerId) || seatById.has(normalized.seatId)) throw new Error('Duplicate table seat.');
    playerIds.add(normalized.playerId);
    seatById.set(normalized.seatId, normalized.playerId);
    seats.push(normalized);
  }
  const hand = validateHand(value.hand, seatById);
  return { tableId, projectId, status: value.status, asset, settingsVersion, maxSeats, revision, leaseExpiresAt, maxEndsAt, totals, seats, hand };
}

export function validateSpawnTableBuyInQuote(
  value: unknown,
  expectedTableId: string,
  platformOrigin: string,
): SpawnTableBuyInQuote {
  if (!exact(value, ['tableId', 'buyInId', 'playerId', 'quoteId', 'status', 'amount', 'asset', 'settingsVersion', 'expiresAt']))
    throw new Error('Invalid table buy-in quote response.');
  const tableId = validateUuid(value.tableId, 'tableId');
  if (tableId !== expectedTableId) throw new Error('Table buy-in quote belongs to a different table.');
  const buyInId = validateUuid(value.buyInId, 'buyInId');
  const playerId = validateMemberUuid(value.playerId, 'playerId');
  const quoteId = validateUuid(value.quoteId, 'quoteId');
  if (!['pending', 'confirmed', 'cancelled', 'expired'].includes(String(value.status)))
    throw new Error('Invalid table buy-in quote status.');
  const amount = validateBaseUnits(value.amount, 'buy-in amount', true);
  const asset = validateAsset(value.asset, ['localhost', '127.0.0.1', '[::1]'].includes(new URL(platformOrigin).hostname));
  const settingsVersion = validateNonnegativeInteger(value.settingsVersion, 'settingsVersion');
  if (settingsVersion < 1) throw new Error('Invalid buy-in Listing settings version.');
  const expiresAt = timestamp(value.expiresAt, 'expiresAt');
  return { tableId, buyInId, playerId, quoteId, status: value.status as SpawnTableBuyInStatus, amount, asset, settingsVersion, expiresAt };
}

export function validateSpawnTablePlayerBuyInQuote(
  value: unknown,
  expectedTableId: string,
  platformOrigin: string,
): SpawnTablePlayerBuyInQuote {
  if (!exact(value, ['tableId', 'buyInId', 'playerId', 'quoteId', 'status', 'amount', 'asset', 'settingsVersion', 'expiresAt', 'balance', 'gameName']))
    throw new Error('Invalid player table buy-in quote response.');
  const quote = validateSpawnTableBuyInQuote({
    tableId: value.tableId,
    buyInId: value.buyInId,
    playerId: value.playerId,
    quoteId: value.quoteId,
    status: value.status,
    amount: value.amount,
    asset: value.asset,
    settingsVersion: value.settingsVersion,
    expiresAt: value.expiresAt,
  }, expectedTableId, platformOrigin);
  const balance = validateBaseUnits(value.balance, 'balance');
  if (typeof value.gameName !== 'string' || value.gameName.length > 256 || /[\u0000-\u001f\u007f]/.test(value.gameName))
    throw new Error('Invalid game name.');
  return { ...quote, balance, gameName: value.gameName };
}

/** The browser approval bridge returns only the server-confirmed quote status. */
export function validateSpawnTableBuyInResult(
  value: unknown,
  expectedTableId: string,
  expectedBuyInId: string,
): SpawnTableBuyInResult {
  if (!exact(value, ['tableId', 'buyInId', 'status'])) throw new Error('Invalid table buy-in approval result.');
  const tableId = validateUuid(value.tableId, 'tableId');
  const buyInId = validateUuid(value.buyInId, 'buyInId');
  if (tableId !== expectedTableId || buyInId !== expectedBuyInId)
    throw new Error('Table buy-in approval belongs to a different quote.');
  if (value.status !== 'confirmed' && value.status !== 'cancelled')
    throw new Error('Invalid table buy-in approval status.');
  return { tableId, buyInId, status: value.status };
}

export function validateSpawnTablePlayerStatus(
  value: unknown,
  expectedTableId: string,
  platformOrigin: string,
): SpawnTablePlayerStatus {
  if (!isRecord(value) ||
      !exact(value, ['tableId', 'projectId', 'playerId', 'seatId', 'seat', 'stack', 'pendingCashOut', 'seatStatus', 'publicTableState']))
    throw new Error('Invalid player table status response.');
  const tableId = validateUuid(value.tableId, 'tableId');
  if (tableId !== expectedTableId) throw new Error('Player status belongs to a different table.');
  const projectId = validateUuid(value.projectId, 'projectId');
  const playerId = validateMemberUuid(value.playerId, 'playerId');
  const seatId = value.seatId === null ? null : validateUuid(value.seatId, 'seatId');
  const stack = validateBaseUnits(value.stack, 'stack');
  const pendingCashOut = validateBaseUnits(value.pendingCashOut, 'pendingCashOut');
  if (value.seatStatus !== null && value.seatStatus !== 'active' && value.seatStatus !== 'leaving' && value.seatStatus !== 'cashed_out')
    throw new Error('Invalid player seat status.');
  const publicTableState = validateSpawnTableStatus(value.publicTableState, projectId, platformOrigin);
  if (publicTableState.tableId !== tableId) throw new Error('Public table status belongs to a different table.');
  let seat: SpawnTableSeat | null = null;
  if (value.seat !== null) {
    seat = validateSeat(value.seat, ['localhost', '127.0.0.1', '[::1]'].includes(new URL(platformOrigin).hostname));
    if (seatId !== seat.seatId || seat.playerId !== playerId || seat.stack !== stack || seat.pendingCashOut !== pendingCashOut)
      throw new Error('Player seat does not match the authenticated player status.');
    if (value.seatStatus !== seat.status) throw new Error('Player seat status does not match the current seat.');
  } else {
    if (seatId !== null && value.seatStatus !== 'cashed_out') throw new Error('A player without a seat must be cashed out.');
    if (seatId === null && value.seatStatus !== null) throw new Error('A player without a seat has no active seat status.');
    if (stack !== '0' || pendingCashOut !== '0') throw new Error('A player without a seat must have no funds pending.');
  }
  if (seat === null && value.seatStatus === 'active') throw new Error('A player without a seat cannot be active.');
  return { tableId, projectId, playerId, seatId, seat, stack, pendingCashOut, seatStatus: value.seatStatus, publicTableState };
}

export function validateSpawnTableOperation(
  value: unknown,
  expectedTableId: string,
  expectedOperationId: string,
  platformOrigin: string,
  expectedProjectId?: string,
  expectedContext?: SpawnTableOperationExpectation,
): SpawnTableOperation {
  if (!exact(value, ['operationId', 'action', 'result'])) throw new Error('Invalid table operation response.');
  const operationId = validateUuid(value.operationId, 'operationId');
  if (operationId !== expectedOperationId) throw new Error('Table operation response has a different ID.');
  if (!TABLE_ACTIONS.has(value.action as SpawnTableOperation['action'])) throw new Error('Invalid table operation action.');
  const action = value.action as SpawnTableOperation['action'];
  if (expectedContext?.action !== undefined && expectedContext.action !== action)
    throw new Error('Table operation response has a different action.');
  const expectedBuyInId = expectedContext?.buyInId === undefined
    ? undefined
    : validateUuid(expectedContext.buyInId, 'expected buyInId');
  const expectedPlayerId = expectedContext?.playerId === undefined
    ? undefined
    : validateMemberUuid(expectedContext.playerId, 'expected playerId');
  let result: SpawnTableOperationResult;
  if (action === 'playerLeave') {
    result = validateSpawnTablePlayerStatus(value.result, expectedTableId, platformOrigin);
    if (expectedProjectId !== undefined && result.projectId !== expectedProjectId.toLowerCase())
      throw new Error('Player operation belongs to a different project.');
    if (expectedPlayerId !== undefined && result.playerId !== expectedPlayerId)
      throw new Error('Player operation belongs to a different player.');
    if (expectedBuyInId !== undefined)
      throw new Error('A player operation cannot be bound to a buy-in quote.');
  } else if (action === 'confirmBuyIn' || action === 'cancelBuyIn') {
    result = validateSpawnTablePlayerBuyInQuote(value.result, expectedTableId, platformOrigin);
    if (expectedBuyInId !== undefined && result.buyInId !== expectedBuyInId)
      throw new Error('Table operation belongs to a different buy-in.');
    if (expectedPlayerId !== undefined && result.playerId !== expectedPlayerId)
      throw new Error('Table operation belongs to a different player.');
  } else if (action === 'requestBuyIn') {
    result = validateSpawnTableBuyInQuote(value.result, expectedTableId, platformOrigin);
    if (expectedBuyInId !== undefined && result.buyInId !== expectedBuyInId)
      throw new Error('Table operation belongs to a different buy-in.');
    if (expectedPlayerId !== undefined && result.playerId !== expectedPlayerId)
      throw new Error('Table operation belongs to a different player.');
  } else {
    if (expectedBuyInId !== undefined || expectedPlayerId !== undefined)
      throw new Error('A table status operation cannot be bound to a player buy-in.');
    result = validateSpawnTableStatus(value.result, expectedProjectId, platformOrigin);
  }
  if (result.tableId !== expectedTableId) throw new Error('Table operation belongs to a different table.');
  return { operationId, action, result };
}

export type { SpawnTableAsset, SpawnTableBuyInQuote, SpawnTableBuyInResult, SpawnTableBuyInStatus, SpawnTableHand, SpawnTableOperation, SpawnTableOperationAction, SpawnTableOperationExpectation, SpawnTableOperationResult, SpawnTablePlayerBuyInQuote, SpawnTablePlayerStatus, SpawnTablePot, SpawnTableSeat, SpawnTableStatus, SpawnTableTotals } from './table-types.ts';

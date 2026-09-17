/**
 * Runnable creator-server lifecycle and recovery example.
 *
 * Run `node examples/table-bankroll.mjs --help` for setup. The example never
 * puts the dedicated key in browser code and never invents a game result.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';

const MAX_JOURNAL_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function frozenSnapshot(value) {
  const clone = structuredClone(value);
  const seen = new WeakSet();
  const freeze = (current) => {
    if (current === null || typeof current !== 'object' || seen.has(current)) return current;
    seen.add(current);
    for (const child of Object.values(current)) freeze(child);
    return Object.freeze(current);
  };
  return freeze(clone);
}

function safeError(error) {
  return error?.name === 'SpawnTableRequestError' && typeof error.toJSON === 'function'
    ? error.toJSON()
    : { code: 'RECOVERY_UNRESOLVED' };
}

function knownRejection(error) {
  return error?.name === 'SpawnTableRequestError' &&
    error.outcomeUnknown === false &&
    Number.isSafeInteger(error.status) && error.status >= 400 && error.status < 500;
}

async function loadTableClient() {
  try {
    return (await import('@spawndotfamily/sdk/server')).createSpawnTableClient;
  } catch (error) {
    // This fallback is for running the example from this source checkout with
    // `node --experimental-strip-types`; packaged users use the public export.
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    return (await import('../src/server.ts')).createSpawnTableClient;
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * A small crash-safe JSON journal for the example. Each intent is written,
 * flushed, atomically renamed and directory-flushed before its network call.
 * A real creator can use SQLite instead, but must preserve the same ordering.
 */
export class DurableTableJournal {
  constructor(directory) {
    this.directory = directory;
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await syncDirectory(this.directory);
  }

  path(operationId) {
    if (typeof operationId !== 'string' || !UUID.test(operationId))
      throw new Error('Table journal operation IDs must be UUIDs.');
    return join(this.directory, `${operationId}.json`);
  }

  async write(operationId, record) {
    const path = this.path(operationId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const encoded = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(encoded, 'utf8') > MAX_JOURNAL_BYTES)
      throw new Error('Table journal record is too large.');
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(encoded, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(this.directory);
  }

  /** Record the exact request before calling any mutating SDK method. */
  async intent(entry) {
    await this.write(entry.operationId, {
      ...entry,
      version: 1,
      state: 'intent',
      recordedAt: Date.now(),
    });
  }

  async resolved(entry, result) {
    await this.write(entry.operationId, {
      ...entry,
      version: 1,
      state: 'resolved',
      result,
      resolvedAt: Date.now(),
    });
  }

  async unknown(entry, error) {
    await this.write(entry.operationId, {
      ...entry,
      version: 1,
      state: 'unknown',
      error: safeError(error),
      checkedAt: Date.now(),
    });
  }

  async rejected(entry, error) {
    await this.write(entry.operationId, {
      ...entry,
      version: 1,
      state: 'rejected',
      error: safeError(error),
      rejectedAt: Date.now(),
    });
  }

  async pending() {
    const names = await readdir(this.directory, { withFileTypes: true });
    const entries = [];
    for (const name of names) {
      if (!name.isFile() || !name.name.endsWith('.json')) continue;
      const encoded = await readFile(join(this.directory, name.name), 'utf8');
      if (Buffer.byteLength(encoded, 'utf8') > MAX_JOURNAL_BYTES)
        throw new Error(`Table journal record is too large: ${name.name}`);
      const value = JSON.parse(encoded);
      if (value?.state === 'resolved' || value?.state === 'rejected') continue;
      if (value?.version !== 1 || typeof value?.tableId !== 'string' || typeof value?.operationId !== 'string')
        throw new Error(`Invalid table journal record: ${name.name}`);
      entries.push(value);
    }
    return entries;
  }
}

async function callMutation(journal, entry, operation) {
  const snapshot = frozenSnapshot(entry);
  const preserveUncertainty = snapshot.state === 'intent' || snapshot.state === 'unknown';
  if (!preserveUncertainty) await journal.intent(snapshot);
  try {
    const result = await operation(snapshot);
    await journal.resolved(snapshot, result);
    return result;
  } catch (error) {
    if (preserveUncertainty || !knownRejection(error)) await journal.unknown(snapshot, error);
    else await journal.rejected(snapshot, error);
    throw error;
  }
}

/** Create a table with a durable operation ID and exact server-side settings. */
export async function createTable(client, journal, { tableId = randomUUID(), maxSeats = 6 } = {}) {
  const entry = {
    tableId: tableId.toLowerCase(),
    operationId: randomUUID(),
    action: 'create',
    request: { tableId: tableId.toLowerCase(), maxSeats },
  };
  return callMutation(journal, entry, (saved) => client.create({
    tableId: saved.tableId,
    operationId: saved.operationId,
    maxSeats: saved.request.maxSeats,
  }));
}

/** Request a separate player approved buy-in; amount is canonical BASE UNITS. */
export async function requestBuyIn(client, journal, tableId, { playerId, launchId, amount, buyInId = randomUUID() }) {
  const entry = {
    tableId: tableId.toLowerCase(),
    operationId: randomUUID(),
    action: 'requestBuyIn',
    request: {
      tableId: tableId.toLowerCase(),
      buyInId: buyInId.toLowerCase(),
      player: { playerId: playerId.toLowerCase(), launchId: launchId.toLowerCase() },
      amount,
    },
  };
  return callMutation(journal, entry, (saved) => client.requestBuyIn(saved.tableId, {
    operationId: saved.operationId,
    buyInId: saved.request.buyInId,
    player: saved.request.player,
    amount: saved.request.amount,
  }));
}

export async function startHand(client, journal, tableId, { handId = randomUUID(), players }) {
  const entry = {
    tableId: tableId.toLowerCase(),
    operationId: randomUUID(),
    action: 'startHand',
    request: { tableId: tableId.toLowerCase(), handId: handId.toLowerCase(), players },
  };
  return callMutation(journal, entry, (saved) => client.startHand(saved.tableId, {
    operationId: saved.operationId,
    handId: saved.request.handId,
    players: saved.request.players,
  }));
}

export async function commitHand(client, journal, tableId, { handId, expectedRevision, contributions, folded }) {
  const entry = {
    tableId: tableId.toLowerCase(),
    operationId: randomUUID(),
    action: 'commitHand',
    request: { tableId: tableId.toLowerCase(), handId, expectedRevision, contributions, folded },
  };
  return callMutation(journal, entry, (saved) => client.commitHand(saved.tableId, {
    operationId: saved.operationId,
    handId: saved.request.handId,
    expectedRevision: saved.request.expectedRevision,
    contributions: saved.request.contributions,
    folded: saved.request.folded,
  }));
}

export async function settleHand(client, journal, tableId, { handId, expectedRevision, pots }) {
  const entry = {
    tableId: tableId.toLowerCase(),
    operationId: randomUUID(),
    action: 'settleHand',
    request: { tableId: tableId.toLowerCase(), handId, expectedRevision, pots },
  };
  return callMutation(journal, entry, (saved) => client.settleHand(saved.tableId, {
    operationId: saved.operationId,
    handId: saved.request.handId,
    expectedRevision: saved.request.expectedRevision,
    pots: saved.request.pots,
  }));
}

export async function cashOut(client, journal, tableId, { playerId, seatId }) {
  const entry = {
    tableId: tableId.toLowerCase(),
    operationId: randomUUID(),
    action: 'cashOut',
    request: { tableId: tableId.toLowerCase(), playerId, seatId },
  };
  return callMutation(journal, entry, (saved) => client.cashOut(saved.tableId, {
    operationId: saved.operationId,
    playerId: saved.request.playerId,
    seatId: saved.request.seatId,
  }));
}

export async function disconnect(client, journal, tableId, { playerId, seatId }) {
  const entry = {
    tableId: tableId.toLowerCase(),
    operationId: randomUUID(),
    action: 'disconnect',
    request: { tableId: tableId.toLowerCase(), playerId, seatId },
  };
  return callMutation(journal, entry, (saved) => client.disconnect(saved.tableId, {
    operationId: saved.operationId,
    playerId: saved.request.playerId,
    seatId: saved.request.seatId,
  }));
}

function operationExpectation(entry) {
  const expected = {};
  if (typeof entry.action === 'string') expected.action = entry.action;
  // Only quote results carry a player/buy-in identity. Cash-out and disconnect
  // return a table snapshot, scoped by the table, operation ID and action.
  if (entry.action === 'requestBuyIn' && entry.request && typeof entry.request === 'object') {
    if (typeof entry.request.buyInId === 'string') expected.buyInId = entry.request.buyInId;
    const playerId = entry.request.playerId ?? entry.request.player?.playerId;
    if (typeof playerId === 'string') expected.playerId = playerId;
  }
  return expected;
}

function operationMatchesEntry(entry, operation) {
  if (!operation || typeof operation !== 'object' || operation.action !== entry.action) return false;
  const result = operation.result;
  if (!result || typeof result !== 'object' || result.tableId?.toLowerCase() !== entry.tableId.toLowerCase()) return false;
  if (entry.action !== 'requestBuyIn') return true;
  const request = entry.request;
  return result.buyInId?.toLowerCase() === request.buyInId.toLowerCase() &&
    result.playerId?.toLowerCase() === request.player.playerId.toLowerCase() &&
    result.amount === request.amount;
}

/**
 * Reconcile every saved mutation after a restart. It only reads the original
 * table and operation IDs; it never resends an unreconciled mutation or creates a
 * replacement table. A missing operation remains unresolved because a 404 can
 * precede a delayed request.
 */
export async function recover(client, journal) {
  const entries = await journal.pending();
  const outcomes = [];
  for (const entry of entries) {
    let operation;
    let status;
    let operationError;
    let statusError;
    try {
      operation = await client.operation(entry.tableId, entry.operationId, operationExpectation(entry));
      if (!operationMatchesEntry(entry, operation)) {
        operationError = new Error('Saved table operation does not match its recorded action or request.');
        operation = undefined;
      }
    } catch (error) {
      operationError = error;
    }
    try {
      status = await client.status(entry.tableId);
    } catch (error) {
      statusError = error;
    }
    if (operation) await journal.resolved(entry, operation);
    outcomes.push({ entry, operation, status, operationError, statusError });
  }
  return outcomes;
}

/** Replay one exact saved request after its operation/status reads were reviewed. */
export async function replaySavedMutation(client, journal, entry) {
  if (!entry || typeof entry.tableId !== 'string' || typeof entry.operationId !== 'string' ||
      !UUID.test(entry.tableId) || !UUID.test(entry.operationId) || !entry.request || typeof entry.request !== 'object')
    throw new Error('A saved table mutation with UUIDs and its exact request is required.');
  if (entry.state === 'rejected') throw new Error('A terminally rejected table mutation cannot be replayed.');
  const saved = { tableId: entry.tableId.toLowerCase(), operationId: entry.operationId.toLowerCase(), action: entry.action, state: entry.state, request: entry.request };
  const invoke = (replayed) => {
    switch (saved.action) {
      case 'create':
        return client.create({ tableId: replayed.tableId, operationId: replayed.operationId, maxSeats: replayed.request.maxSeats });
      case 'requestBuyIn':
        return client.requestBuyIn(replayed.tableId, { operationId: replayed.operationId, buyInId: replayed.request.buyInId, player: replayed.request.player, amount: replayed.request.amount });
      case 'startHand':
        return client.startHand(replayed.tableId, { operationId: replayed.operationId, handId: replayed.request.handId, players: replayed.request.players });
      case 'commitHand':
        return client.commitHand(replayed.tableId, { operationId: replayed.operationId, handId: replayed.request.handId, expectedRevision: replayed.request.expectedRevision, contributions: replayed.request.contributions, folded: replayed.request.folded });
      case 'settleHand':
        return client.settleHand(replayed.tableId, { operationId: replayed.operationId, handId: replayed.request.handId, expectedRevision: replayed.request.expectedRevision, pots: replayed.request.pots });
      case 'cashOut':
        return client.cashOut(replayed.tableId, { operationId: replayed.operationId, playerId: replayed.request.playerId, seatId: replayed.request.seatId });
      case 'disconnect':
        return client.disconnect(replayed.tableId, { operationId: replayed.operationId, playerId: replayed.request.playerId, seatId: replayed.request.seatId });
      case 'close':
        return client.close(replayed.tableId, { operationId: replayed.operationId });
      default:
        throw new Error(`Cannot replay unsupported table action: ${String(saved.action)}`);
    }
  };
  return callMutation(journal, saved, invoke);
}

/** Explicitly close the saved table ID after recovery has been reviewed. */
export async function closeSavedTable(client, journal, tableId) {
  const entry = {
    tableId: tableId.toLowerCase(),
    operationId: randomUUID(),
    action: 'close',
    request: { tableId: tableId.toLowerCase() },
  };
  return callMutation(journal, entry, (saved) => client.close(saved.tableId, { operationId: saved.operationId }));
}

/** Restore only the server's hand snapshot; the game supplies no invented winner. */
export function restoreUnfinishedHand(status) {
  if (!status.hand) return { state: 'idle' };
  return {
    state: 'running',
    handId: status.hand.handId,
    revision: status.hand.revision,
    players: status.hand.players.map(({ playerId, seatId, contribution, folded }) => ({
      playerId,
      seatId,
      contribution,
      folded,
    })),
    pots: status.hand.pots,
    expectedRevision: status.hand.revision,
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Set SPAWN_PLATFORM_ORIGIN, SPAWN_PROJECT_ID, SPAWN_TABLE_KEY_FILE and SPAWN_TABLE_ID, then run with --recover.');
    console.log('The key file is the private match.key written by spawn-publish server enable.');
    return;
  }
  if (!process.argv.includes('--recover')) {
    console.log('No network action selected. Use --help for the recovery command.');
    return;
  }
  const origin = process.env.SPAWN_PLATFORM_ORIGIN;
  const projectId = process.env.SPAWN_PROJECT_ID;
  const keyFile = process.env.SPAWN_TABLE_KEY_FILE;
  const tableId = process.env.SPAWN_TABLE_ID;
  if (!origin || !projectId || !keyFile || !tableId)
    throw new Error('Recovery requires SPAWN_PLATFORM_ORIGIN, SPAWN_PROJECT_ID, SPAWN_TABLE_KEY_FILE and SPAWN_TABLE_ID.');
  const credential = (await readFile(keyFile, 'utf8')).trim();
  const createSpawnTableClient = await loadTableClient();
  const client = createSpawnTableClient({ platformOrigin: origin, projectId, credential });
  const journal = new DurableTableJournal(process.env.SPAWN_TABLE_JOURNAL ?? join(dirname(keyFile), 'table-journal'));
  await journal.init();
  const status = await client.status(tableId);
  console.log(JSON.stringify({ tableId: status.tableId, status: status.status, hand: restoreUnfinishedHand(status) }));
  const outcomes = await recover(client, journal);
  console.log(JSON.stringify(outcomes.map(({ entry, operation, status: current, operationError, statusError }) => ({
    operationId: entry.operationId,
    action: entry.action,
    operation: operation ?? { unresolved: operationError?.code ?? 'not-found' },
    tableStatus: current?.status ?? { unresolved: statusError?.code ?? 'unavailable' },
  }))));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

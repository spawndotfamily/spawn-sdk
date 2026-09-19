#!/usr/bin/env node
/**
 * Table fleet driver — run N simulated players across M loopback tables, headlessly.
 *
 * A creator's real question is not "does one table conserve" but "does the whole flow still hold
 * with N players". This driver answers it. Each table gets its own
 * `createLoopbackTableService()` (a service models exactly one table) and up to six seats, and
 * the scripted phases run end to end:
 *
 *   seat -> approve -> play hands -> cash out some players -> disconnect/reconnect -> settle all
 *
 * Every money step asserts `buyIns = cashOuts + stacks + committed + pendingCashOuts` for its
 * table, and the run asserts it once more per table and in aggregate at the end. Approvals the
 * opt-in test balances refuse (a player who cannot cover the quote) are counted, not thrown.
 *
 * CLI (inside the SDK repo; in a consumer project use the package path):
 *
 *   node testing/table-fleet.mjs --players 100          # exits non-zero on any imbalance
 *   node testing/table-fleet.mjs --players 100 --json   # machine-readable report
 *
 * Library:
 *
 *   import { runFleet } from '@spawndotfamily/sdk/testing/table-fleet.mjs';
 *
 *   const report = await runFleet({ players: 100 });    // throws on any imbalance
 *   report.aggregate.balanced;                          // true
 *   report.refusals;                                    // { insufficientBalance, zeroBalance, total }
 *
 * Nothing here touches the network, a browser or the real platform: a 100-player run is a few
 * hundred in-process SDK calls and finishes in well under a second.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLoopbackTableService } from './loopback-table-service.mjs';
import { checkConservation } from './scenario-runner.mjs';

const op = () => randomUUID();
const BASE_UNITS = /^(?:0|[1-9][0-9]{0,77})$/;

/** Even seats per table: every table gets at least one, none exceeds `maxSeats`. */
function layoutFor(players, tables) {
  const base = Math.floor(players / tables);
  const extra = players % tables;
  return Array.from({ length: tables }, (_, index) => base + (index < extra ? 1 : 0));
}

function assertInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer >= ${minimum}.`);
}

/** Validate the options before a single table is created, so a bad value fails fast. */
function tableCountFor({ players, tables, maxSeats, hands, buyIn, stake }) {
  assertInteger(players, 'players', 1);
  assertInteger(maxSeats, 'maxSeats', 2);
  if (maxSeats > 6) throw new Error('maxSeats must be between 2 and 6 (a table holds 2-6 seats).');
  assertInteger(hands, 'hands', 0);
  if (!BASE_UNITS.test(buyIn) || buyIn === '0')
    throw new Error('buyIn must be a canonical unsigned integer in token base units, greater than zero.');
  if (!BASE_UNITS.test(stake) || stake === '0')
    throw new Error('stake must be a canonical unsigned integer in token base units, greater than zero.');
  const tableCount = tables ?? Math.ceil(players / maxSeats);
  assertInteger(tableCount, 'tables', 1);
  if (tableCount > players)
    throw new Error(`tables (${tableCount}) must not exceed players (${players}): every table needs at least one player.`);
  if (tableCount * maxSeats < players)
    throw new Error(
      `${players} players need at least ${Math.ceil(players / maxSeats)} tables of ${maxSeats} seats, got ${tableCount}.`,
    );
  if (BigInt(stake) * BigInt(hands) > BigInt(buyIn))
    throw new Error(
      `stake x hands (${BigInt(stake) * BigInt(hands)}) must not exceed the buy-in (${buyIn}): a player losing every hand must still cover each commitment.`,
    );
  return tableCount;
}

/** Run one table through every scripted phase. Returns its report; throws on any imbalance. */
async function runFleetTable({ index, seats, maxSeats, hands, buyIn, stake, refusals }) {
  const tableId = randomUUID();
  const wallets = new Map(); // playerId -> { kind, initial, expected } — the driver's own ledger
  const balances = {};
  const seatPlayerIds = [];
  for (let seat = 0; seat < seats; seat += 1) {
    const playerId = randomUUID();
    // The first seat starts with exactly the buy-in (the inclusive boundary of the balance
    // check); the rest get a wallet that could re-buy ten times over.
    const balance = seat === 0 ? buyIn : (BigInt(buyIn) * 10n).toString();
    balances[playerId] = balance;
    wallets.set(playerId, { kind: 'seat', initial: balance, expected: balance });
    seatPlayerIds.push(playerId);
  }
  const probes = [];
  if (refusals) {
    const shortId = randomUUID();
    const emptyId = randomUUID();
    balances[shortId] = BigInt(buyIn) > 1n ? (BigInt(buyIn) - 1n).toString() : '0';
    balances[emptyId] = '0';
    wallets.set(shortId, { kind: 'insufficient', initial: balances[shortId], expected: balances[shortId] });
    wallets.set(emptyId, { kind: 'zero', initial: '0', expected: '0' });
    probes.push({ playerId: shortId, kind: 'insufficientBalance' }, { playerId: emptyId, kind: 'zeroBalance' });
  }

  const service = createLoopbackTableService({ balances });
  // A table created for its actual roster, never above the requested cap and never below 2.
  const created = { tableId, operationId: op(), maxSeats: Math.min(maxSeats, Math.max(2, seats)) };
  await service.client.create(created);
  checkConservation(service);

  const seatOf = (playerId) => service.state().seats.find((seat) => seat.playerId === playerId)?.seatId;
  const activeSeats = () => service.state().seats.map(({ playerId, seatId, stack }) => ({ playerId, seatId, stack }));
  const debit = (playerId, amount) => {
    const wallet = wallets.get(playerId);
    wallet.expected = (BigInt(wallet.expected) - BigInt(amount)).toString();
  };
  const credit = (playerId, amount) => {
    const wallet = wallets.get(playerId);
    wallet.expected = (BigInt(wallet.expected) + BigInt(amount)).toString();
  };

  // Phase 1-2: seat every player, then approve each buy-in (the overlay's Approve click).
  for (const playerId of seatPlayerIds) {
    const buyInId = randomUUID();
    await service.client.requestBuyIn(tableId, {
      operationId: op(),
      buyInId,
      player: { playerId, launchId: randomUUID() },
      amount: buyIn,
    });
    assert.equal((await service.client.buyIn(tableId, buyInId)).status, 'pending', 'a fresh quote is pending');
    service.confirmBuyIn(playerId);
    debit(playerId, buyIn);
    checkConservation(service);
  }
  assert.equal(service.state().seats.length, seats, 'every player is seated');

  // Phase 2b: refusals. A player who cannot cover the quote is refused at the approval click —
  // the same place the real overlay refuses an unfunded account — and nothing is debited.
  const refused = { insufficientBalance: 0, zeroBalance: 0, total: 0 };
  for (const probe of probes) {
    const buyInId = randomUUID();
    await service.client.requestBuyIn(tableId, {
      operationId: op(),
      buyInId,
      player: { playerId: probe.playerId, launchId: randomUUID() },
      amount: buyIn,
    });
    assert.equal(
      (await service.client.buyIn(tableId, buyInId)).status,
      'pending',
      'a refused player still holds a pending quote',
    );
    const seatsBefore = service.state().seats.length;
    assert.throws(
      () => service.confirmBuyIn(probe.playerId),
      (error) =>
        error?.code === 'INSUFFICIENT_BALANCE' && /Insufficient balance for this buy-in/.test(error.message),
      `a ${probe.kind} approval must be refused with a reason`,
    );
    assert.equal(service.state().seats.length, seatsBefore, 'a refused approval does not seat the player');
    refused[probe.kind] += 1;
    checkConservation(service);
  }
  refused.total = refused.insufficientBalance + refused.zeroBalance;

  // Phase 3: play hands with everyone seated; winners rotate so every seat wins sometimes.
  let handIndex = 0;
  const playHand = async () => {
    const active = activeSeats();
    assert.ok(active.length >= 2, 'a hand needs at least two active seats');
    const handId = randomUUID();
    await service.client.startHand(tableId, {
      operationId: op(),
      handId,
      players: active.map(({ playerId, seatId }) => ({ playerId, seatId })),
    });
    await service.client.commitHand(tableId, {
      operationId: op(),
      handId,
      expectedRevision: 0,
      contributions: active.map(({ playerId }) => ({ playerId, amount: stake })),
      folded: [],
    });
    const winner = active[handIndex % active.length];
    handIndex += 1;
    await service.client.settleHand(tableId, {
      operationId: op(),
      handId,
      expectedRevision: 1,
      pots: [
        { cap: stake, winners: [{ playerId: winner.playerId, amount: (BigInt(stake) * BigInt(active.length)).toString() }] },
      ],
    });
    checkConservation(service);
  };

  for (let played = 0; played < Math.max(0, hands - 1) && activeSeats().length >= 2; played += 1) await playHand();

  // Phase 4: cash out some players; the rest keep playing.
  let cashOuts = 0;
  const cashOutPlayer = async (playerId) => {
    const seat = service.state().seats.find((candidate) => candidate.playerId === playerId);
    assert.ok(seat, 'a seat must exist to cash out');
    const paid = (BigInt(seat.stack) + BigInt(seat.pendingCashOut)).toString();
    await service.client.cashOut(tableId, { operationId: op(), playerId, seatId: seat.seatId });
    credit(playerId, paid);
    cashOuts += 1;
    checkConservation(service);
  };
  const midLeavers = Math.min(Math.max(1, Math.floor(seats / 3)), Math.max(0, seats - 1));
  if (midLeavers > 0) {
    for (const { playerId } of activeSeats().slice(-midLeavers)) await cashOutPlayer(playerId);
  }
  if (hands > 0 && activeSeats().length >= 2) await playHand();

  // Phase 5: disconnect a player, reconnect inside the grace window, prove the seat survives.
  const target = activeSeats()[0];
  if (target) {
    await service.client.disconnect(tableId, { operationId: op(), playerId: target.playerId, seatId: target.seatId });
    service.advance(5_000);
    checkConservation(service);
    assert.ok(seatOf(target.playerId), 'the seat survives inside the disconnect grace window');
    service.reconnect(target.playerId);
    service.advance(60_000);
    checkConservation(service);
    const seat = service.state().seats.find((candidate) => candidate.playerId === target.playerId);
    assert.ok(seat, 'a reconnect cancels the grace deadline instead of cashing the player out');
    assert.equal(seat.disconnectDeadline, null, 'the reconnect clears the disconnect deadline');
  }

  // Phase 6: settle every remaining seat and close the books.
  for (const { playerId } of activeSeats()) await cashOutPlayer(playerId);

  const conservation = service.conservation();
  assert.equal(conservation.totals.stacks, '0', 'every stack was returned');
  assert.equal(conservation.totals.committed, '0', 'no hand is left in flight');
  assert.equal(conservation.totals.pendingCashOuts, '0', 'nothing is left pending');
  assert.equal(conservation.totals.cashOuts, conservation.totals.buyIns, 'every buy-in was returned exactly once');
  checkConservation(service);

  // The opt-in wallets mirror the table: debited on approval, credited on cash-out, exactly.
  let netChange = 0n;
  for (const [playerId, wallet] of wallets) {
    const balance = service.balance(playerId);
    assert.equal(
      balance,
      wallet.expected,
      `test balance for the ${wallet.kind} player: expected ${wallet.expected}, saw ${balance}`,
    );
    netChange += BigInt(balance) - BigInt(wallet.initial);
  }
  assert.equal(netChange, 0n, 'the tracked wallets gain and lose nothing across the run');

  return {
    index: index + 1,
    tableId,
    seats,
    maxSeats: created.maxSeats,
    hands: handIndex,
    cashOuts,
    refusals: refused,
    balanced: conservation.balanced,
    totals: conservation.totals,
    wallets: { tracked: wallets.size, netChange: netChange.toString(), balanced: netChange === 0n },
  };
}

/**
 * Drive a fleet of simulated players across loopback tables and assert the money invariant.
 *
 * Options (all optional): `players` (default 100), `tables` (default `ceil(players / maxSeats)`),
 * `maxSeats` (2-6, default 6), `hands` per table (default 3), `buyIn` and `stake` as canonical
 * base-unit strings, and `refusals` (default true) to drive one under-funded and one
 * zero-balance approval per table. Throws on any imbalance; otherwise returns the report.
 */
export async function runFleet(options = {}) {
  const {
    players = 100,
    tables: requestedTables,
    maxSeats = 6,
    hands = 3,
    buyIn = '1000',
    stake = '100',
    refusals = true,
  } = options;
  const started = Date.now();
  const tableCount = tableCountFor({ players, tables: requestedTables, maxSeats, hands, buyIn, stake });
  const layout = layoutFor(players, tableCount);

  const perTable = [];
  const refusalsTotal = { insufficientBalance: 0, zeroBalance: 0, total: 0 };
  const aggregate = { buyIns: '0', cashOuts: '0', stacks: '0', committed: '0', pendingCashOuts: '0', backing: '0' };
  let seated = 0;
  let handsPlayed = 0;
  let cashOuts = 0;
  let tracked = 0;
  let walletNetChange = 0n;

  for (let index = 0; index < tableCount; index += 1) {
    const table = await runFleetTable({ index, seats: layout[index], maxSeats, hands, buyIn, stake, refusals });
    perTable.push(table);
    seated += table.seats;
    handsPlayed += table.hands;
    cashOuts += table.cashOuts;
    refusalsTotal.insufficientBalance += table.refusals.insufficientBalance;
    refusalsTotal.zeroBalance += table.refusals.zeroBalance;
    refusalsTotal.total += table.refusals.total;
    tracked += table.wallets.tracked;
    walletNetChange += BigInt(table.wallets.netChange);
    for (const key of Object.keys(aggregate)) {
      aggregate[key] = (BigInt(aggregate[key]) + BigInt(table.totals[key])).toString();
    }
  }

  assert.equal(seated, players, 'every requested player is seated');
  if (refusals) assert.equal(refusalsTotal.total, tableCount * 2, 'every table drove both refusal probes');

  const delta = BigInt(aggregate.buyIns) - (BigInt(aggregate.cashOuts) + BigInt(aggregate.backing));
  const report = {
    title: 'table fleet',
    ok: delta === 0n && perTable.every((table) => table.balanced),
    players,
    tables: tableCount,
    maxSeats,
    hands,
    seated,
    handsPlayed,
    cashOuts,
    refusals: refusalsTotal,
    aggregate: {
      balanced: delta === 0n,
      ...aggregate,
      delta: delta.toString(),
      detail:
        delta === 0n
          ? `buyIns=${aggregate.buyIns} = cashOuts=${aggregate.cashOuts} + backing=${aggregate.backing}`
          : `buyIns=${aggregate.buyIns} != cashOuts=${aggregate.cashOuts} + backing=${aggregate.backing} - unbalanced by ${delta}`,
    },
    wallets: { tracked, netChange: walletNetChange.toString(), balanced: walletNetChange === 0n },
    balanced: delta === 0n && perTable.every((table) => table.balanced),
    perTable,
    durationMs: Date.now() - started,
  };

  // Per table AND in aggregate — the invariant holds or the run fails loudly.
  const unbalanced = perTable.filter((table) => !table.balanced);
  if (!report.balanced) {
    const error = new Error(
      `Fleet conservation broken: ${unbalanced.length} of ${tableCount} tables unbalanced; aggregate delta ${delta}.`,
    );
    error.report = report;
    throw error;
  }
  return report;
}

const USAGE = `Usage: node testing/table-fleet.mjs --players 100 [options]

Drives N simulated players across M loopback tables (up to --seats seats each, each table its own
service) through seat -> approve -> play hands -> cash out some players -> disconnect/reconnect ->
settle all. Asserts buyIns = cashOuts + stacks + committed + pendingCashOuts per table and in
aggregate, counts refused approvals, and exits non-zero on any imbalance.

Options:
  --players <n>     players to seat (default 100)
  --tables <n>      tables to spread them across (default ceil(players / seats))
  --seats <n>       seats per table, 2-6 (default 6)
  --hands <n>       hands played per table (default 3)
  --buy-in <units>  buy-in per player, base units (default 1000)
  --stake <units>   per-hand stake, base units (default 100)
  --json            print the report as JSON instead of prose
  --help            show this text`;

function parseCliArgs(argv) {
  const options = { json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const [flag, inline] = arg.split('=');
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    switch (flag) {
      case '--players': options.players = Number(value); break;
      case '--tables': options.tables = Number(value); break;
      case '--seats': options.maxSeats = Number(value); break;
      case '--hands': options.hands = Number(value); break;
      case '--buy-in': options.buyIn = value; break;
      case '--stake': options.stake = value; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printFleetSummary(report, log = console.log) {
  log(`table fleet - ${report.players} players, ${report.tables} tables, ${report.maxSeats} seats max`);
  log('');
  for (const table of report.perTable) {
    log(
      `PASS  table ${String(table.index).padStart(2)}  seats=${table.seats} hands=${table.hands} ` +
        `cash-outs=${table.cashOuts} refusals=${table.refusals.total}  ` +
        `${table.totals.buyIns} = ${table.totals.cashOuts} + ${table.totals.backing}`,
    );
  }
  log('');
  log(`PASS  aggregate   ${report.aggregate.detail}`);
  log(`PASS  wallets     tracked=${report.wallets.tracked} netChange=${report.wallets.netChange}`);
  log('');
  log(
    `${report.perTable.length}/${report.tables} tables balanced - ${report.seated} seated, ${report.handsPlayed} hands, ` +
      `${report.cashOuts} cash-outs, ${report.refusals.total} refusals ` +
      `(${report.refusals.insufficientBalance} insufficient balance, ${report.refusals.zeroBalance} zero balance)`,
  );
  log(`table fleet passed in ${report.durationMs} ms`);
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    console.error(`table-fleet: ${error.message}`);
    console.error('');
    console.error(USAGE);
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const { json, help: _help, ...options } = parsed;
  try {
    const report = await runFleet(options);
    if (json) console.log(JSON.stringify(report, null, 2));
    else printFleetSummary(report);
    return 0;
  } catch (error) {
    if (json) console.log(JSON.stringify({ ok: false, error: error.message, report: error.report ?? null }, null, 2));
    else {
      console.log('FAIL  table fleet');
      console.log(`      ${error.message}`);
    }
    return 1;
  }
}

function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  process.exitCode = await main();
}

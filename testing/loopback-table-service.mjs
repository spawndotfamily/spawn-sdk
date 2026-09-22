/**
 * Loopback Spawn table-bankroll service — first-party test double.
 *
 * Why this exists: a table game moves tokens, and the only way to know a
 * settlement path works is to run it. The real platform needs signed-in member
 * accounts plus the Spawn approval overlay, neither of which can be scripted
 * headlessly. This module speaks the same request/response contract as the
 * platform's registered-game table routes, so the SDK's REAL client and
 * validators can drive it on loopback — the chain-31337 local seam documented in
 * docs/table-bankroll.md.
 *
 * It enforces the documented invariants, and throws if a scenario breaks one:
 *
 *   buyIns = cashOuts + stacks + committed + pendingCashOuts
 *
 * Opt-in per-player test balances (`{ balances: { [playerId]: '1000' } }`) make the approval
 * click refuse a player who cannot cover the quote — the refusal a real unfunded account gets —
 * and debit/credit the tracked wallet on approval/cash-out. Omit the option and none of that
 * exists: no wallet is tracked, nothing is checked, nothing is debited.
 *
 * It is a test double, not a rules engine: your authoritative server still
 * decides who wins. Outcomes here are whatever your scenario supplies.
 */
import { randomUUID } from 'node:crypto';
import { createSpawnTableClient } from '@spawndotfamily/sdk/server';

/** Documented platform policy defaults (docs/table-bankroll.md). */
export const TABLE_POLICY = {
  quoteMs: 120_000,
  leaseMs: 90_000,
  disconnectGraceMs: 30_000,
  handDeadlineMs: 300_000,
  maxAgeMs: 24 * 60 * 60 * 1000,
};

const sum = (values) => values.reduce((total, value) => total + BigInt(value), 0n).toString();
const clone = (value) => structuredClone(value);
const UINT256_MAX = (2n ** 256n) - 1n;

/** Canonical base-unit string for a test balance: `'1000'` or `1000`, never a decimal. */
function canonicalBalance(value, playerId) {
  const canonical = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof canonical !== 'string' || !/^(?:0|[1-9][0-9]{0,77})$/.test(canonical) || BigInt(canonical) > UINT256_MAX)
    throw new Error(`Test balance for ${playerId} must be an unsigned integer in token base units.`);
  return canonical;
}

export function createLoopbackTableService({ now = Date.now, asset: assetOverride, balances: balanceOverrides } = {}) {
  const projectId = randomUUID();
  const address = `0x${'1'.repeat(40)}`;
  const asset = assetOverride ?? {
    id: `erc20:46630:${address}`,
    chainId: 46630,
    address,
    name: 'Loopback token',
    symbol: 'LOCAL',
    decimals: 2,
    image: '',
    source: 'spawn',
    enabled: true,
  };

  // Opt-in per-player test balances. `null` when the option is absent, and every use below is
  // guarded — so without the option the service behaves exactly as it did before it existed.
  if (balanceOverrides !== undefined && (balanceOverrides === null || typeof balanceOverrides !== 'object' || Array.isArray(balanceOverrides)))
    throw new Error('balances must be an object mapping a playerId to an unsigned integer in token base units.');
  const wallets = balanceOverrides === undefined
    ? null
    : new Map(Object.entries(balanceOverrides).map(([playerId, amount]) => [playerId, canonicalBalance(amount, playerId)]));

  // The clock is read LIVE, per call, so a caller that injects its own test clock
  // (`now: () => myGameClock`) follows that clock instead of freezing at construction;
  // `advance(ms)` adds a synthetic offset on top of whatever `now` reports.
  const baseNow = typeof now === 'function' ? now() : now;
  let offset = 0;
  const timestamp = () => (typeof now === 'function' ? now() : baseNow) + offset;
  let state = null;
  let loseAction = null;
  const quotes = new Map();
  const operations = new Map();
  const calls = [];

  const copyQuotes = () => new Map([...quotes.entries()].map(([key, value]) => [key, clone(value)]));
  const restoreQuotes = (saved) => {
    quotes.clear();
    for (const [key, value] of saved) quotes.set(key, value);
  };
  const copyWallets = () => (wallets === null ? null : new Map(wallets));
  const restoreWallets = (saved) => {
    if (wallets === null || saved === null) return;
    wallets.clear();
    for (const [key, value] of saved) wallets.set(key, value);
  };

  const fail = (message, status = 409) => Object.assign(new Error(message), { status });
  const seats = () => state.seats;
  const handPlayers = () => state.hand?.players ?? [];

  function totals() {
    const t = state.totals;
    t.stacks = sum(seats().map((seat) => seat.stack));
    t.committed = sum(handPlayers().map((player) => player.contribution));
    t.pendingCashOuts = sum(seats().map((seat) => seat.pendingCashOut));
    t.backing = (BigInt(t.stacks) + BigInt(t.committed) + BigInt(t.pendingCashOuts)).toString();
    if (BigInt(t.buyIns) !== BigInt(t.cashOuts) + BigInt(t.backing)) {
      throw new Error(
        `Loopback conservation violated: buyIns=${t.buyIns} cashOuts=${t.cashOuts} backing=${t.backing}`,
      );
    }
    return t;
  }

  /** Side-pot tiers from committed contributions: uncalled excess is its own tier. */
  function tiers() {
    let previous = 0n;
    return [...new Set(handPlayers().map((player) => player.contribution))]
      .filter((value) => BigInt(value) > 0n)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
      .map((cap) => {
        const atCap = handPlayers().filter((player) => BigInt(player.contribution) >= BigInt(cap));
        const amount = (BigInt(cap) - previous) * BigInt(atCap.length);
        previous = BigInt(cap);
        return {
          cap,
          amount: amount.toString(),
          eligible:
            atCap.length === 1
              ? atCap.map((player) => player.playerId)
              : atCap.filter((player) => !player.folded).map((player) => player.playerId),
        };
      });
  }

  function cashOutSeat(seat) {
    const paid = (BigInt(seat.stack) + BigInt(seat.pendingCashOut)).toString();
    state.totals.cashOuts = (BigInt(state.totals.cashOuts) + BigInt(paid)).toString();
    // A tracked test wallet is credited exactly what the seat is paid, once.
    if (wallets?.has(seat.playerId))
      wallets.set(seat.playerId, (BigInt(wallets.get(seat.playerId)) + BigInt(paid)).toString());
    seat.stack = '0';
    seat.pendingCashOut = '0';
    state.seats = state.seats.filter((candidate) => candidate !== seat);
  }

  /** Deadline/lease/disconnect sweep, mirroring the platform's recovery rules. */
  function sweep() {
    if (!state) return;
    const now = timestamp();
    for (const quote of quotes.values()) {
      if (quote.status === 'pending' && quote.expiresAt <= now) quote.status = 'expired';
    }
    if (state.status === 'open' && state.hand && now >= state.hand.deadline) {
      for (const player of state.hand.players) {
        const seat = seats().find((candidate) => candidate.playerId === player.playerId);
        if (seat) seat.stack = (BigInt(seat.stack) + BigInt(player.contribution)).toString();
      }
      state.hand = null;
    }
    if (state.status === 'open' &&
      (now >= state.maxEndsAt || state.leaseExpiresAt !== null && now >= state.leaseExpiresAt)) {
      for (const player of handPlayers()) {
        const seat = seats().find((candidate) => candidate.playerId === player.playerId);
        if (seat) seat.stack = (BigInt(seat.stack) + BigInt(player.contribution)).toString();
      }
      state.hand = null;
      for (const quote of quotes.values()) {
        if (quote.status === 'pending') quote.status = 'cancelled';
      }
      for (const seat of [...seats()]) cashOutSeat(seat);
      state.status = 'closed';
      state.leaseExpiresAt = null;
    }
    for (const seat of [...seats()]) {
      if (seat.disconnectDeadline !== null && now >= seat.disconnectDeadline) {
        seat.status = 'leaving';
        seat.disconnectDeadline = null;
        seat.connectedUntil = null;
      }
      if (seat.status === 'active' && seat.connectedUntil !== null && now >= seat.connectedUntil) {
        seat.status = 'leaving';
        seat.connectedUntil = null;
      }
      const inHand = state.hand?.players.some((player) => player.seatId === seat.seatId);
      if (seat.status === 'leaving' && !inHand) cashOutSeat(seat);
    }
    totals();
  }

  function snapshot(tableId) {
    sweep();
    if (!state) throw fail('Not found', 404);
    if (tableId !== undefined && state.tableId !== tableId) throw fail('Not found', 404);
    return clone(state);
  }

  /** Durable operation semantics: same id + body replays the saved result. */
  function mutate(action, input, apply) {
    if (operations.has(input.operationId)) {
      const saved = operations.get(input.operationId);
      if (saved.action !== action || JSON.stringify(saved.input) !== JSON.stringify(input))
        throw fail('Conflicting operation body.');
      return clone(saved.result);
    }
    const stateBefore = state === null ? null : clone(state);
    const quotesBefore = copyQuotes();
    const walletsBefore = copyWallets();
    let result;
    try {
      sweep();
      apply();
      if (state !== null && action !== 'close') state.revision += 1;
      totals();
      result = action === 'requestBuyIn' ? quotes.get(input.buyInId) : state;
      operations.set(input.operationId, {
        operationId: input.operationId,
        action,
        result: clone(result),
        input: clone(input),
      });
      calls.push({ action, input: clone(input) });
    } catch (error) {
      state = stateBefore;
      restoreQuotes(quotesBefore);
      restoreWallets(walletsBefore);
      throw error;
    }
    if (loseAction === action) {
      loseAction = null;
      throw new Error(`Simulated lost response for ${action}.`);
    }
    return clone(result);
  }

  const handlers = {
    async create(input) {
      return mutate('create', input, () => {
        if (state) throw fail('Table already exists or is permanently closed.');
        const now = timestamp();
        state = {
          tableId: input.tableId,
          projectId,
          status: 'open',
          asset,
          settingsVersion: 1,
          maxSeats: input.maxSeats,
          revision: 0,
          leaseExpiresAt: Math.min(now + TABLE_POLICY.leaseMs, now + TABLE_POLICY.maxAgeMs),
          maxEndsAt: now + TABLE_POLICY.maxAgeMs,
          seats: [],
          hand: null,
          totals: { buyIns: '0', cashOuts: '0', stacks: '0', committed: '0', pendingCashOuts: '0', backing: '0' },
        };
      });
    },
    async status(tableId) {
      return snapshot(tableId);
    },
    async heartbeat(tableId) {
      sweep();
      if (!state || state.tableId !== tableId) throw fail('Not found', 404);
      if (state.status === 'open')
        state.leaseExpiresAt = Math.min(timestamp() + TABLE_POLICY.leaseMs, state.maxEndsAt);
      return snapshot(tableId);
    },
    async operation(tableId, operationId) {
      if (!state || state.tableId !== tableId) throw fail('Not found', 404);
      const saved = operations.get(operationId);
      if (!saved) throw fail('Not found', 404);
      return { operationId, action: saved.action, result: clone(saved.result) };
    },
    async requestBuyIn(tableId, input) {
      return mutate('requestBuyIn', input, () => {
        if (!state || state.tableId !== tableId) throw fail('Not found', 404);
        if (state.status !== 'open') throw fail('Table is not open.');
        const existing = seats().find((seat) => seat.playerId === input.player.playerId);
        if ([...quotes.values()].some(
          (quote) => quote.tableId === tableId && quote.playerId === input.player.playerId && quote.status === 'pending',
        )) throw fail('This player already has a pending buy-in.');
        const pendingSeatless = [...quotes.values()].filter(
          (quote) => quote.tableId === tableId && quote.status === 'pending' &&
            !seats().some((seat) => seat.playerId === quote.playerId),
        ).length;
        // The fleet/refusal harness intentionally asks an already full table for quotes for
        // tracked wallets that cannot fund them, so the simulated approval can refuse at the
        // same click as the real overlay. Fundable requests still reserve active + pending
        // capacity exactly as the platform does.
        const cannotFund = wallets?.has(input.player.playerId) &&
          BigInt(wallets.get(input.player.playerId)) < BigInt(input.amount);
        if (!existing && seats().length + pendingSeatless >= state.maxSeats && !cannotFund)
          throw fail('The table has no available seat.');
        quotes.set(input.buyInId, {
          tableId,
          buyInId: input.buyInId,
          playerId: input.player.playerId,
          quoteId: randomUUID(),
          status: 'pending',
          amount: input.amount,
          asset,
          settingsVersion: 1,
          expiresAt: Math.min(timestamp() + TABLE_POLICY.quoteMs, state.maxEndsAt),
        });
      });
    },
    async buyIn(tableId, buyInId) {
      sweep();
      if (!state || state.tableId !== tableId) throw fail('Not found', 404);
      const quote = quotes.get(buyInId);
      if (!quote) throw fail('Unknown buy-in quote.', 404);
      return clone(quote);
    },
    async startHand(_tableId, input) {
      return mutate('startHand', input, () => {
        if (state.hand) throw fail('A hand is already running.');
        for (const player of input.players) {
          const seat = seats().find(
            (candidate) =>
              candidate.seatId === player.seatId &&
              candidate.playerId === player.playerId &&
              candidate.status === 'active',
          );
          if (!seat) throw fail('Seat does not match an active player.');
        }
        state.hand = {
          handId: input.handId,
          revision: 0,
          deadline: timestamp() + TABLE_POLICY.handDeadlineMs,
          players: input.players.map((player) => ({ ...player, contribution: '0', folded: false })),
          pots: [],
        };
      });
    },
    async commitHand(_tableId, input) {
      return mutate('commitHand', input, () => {
        const hand = state.hand;
        if (hand?.handId !== input.handId || hand.revision !== input.expectedRevision)
          throw fail('Hand revision is stale.');
        for (const contribution of input.contributions) {
          const player = hand.players.find((candidate) => candidate.playerId === contribution.playerId);
          const seat = seats().find((candidate) => candidate.playerId === contribution.playerId);
          if (!player || !seat || BigInt(seat.stack) < BigInt(contribution.amount))
            throw fail('Insufficient stack for contribution.');
          seat.stack = (BigInt(seat.stack) - BigInt(contribution.amount)).toString();
          player.contribution = (BigInt(player.contribution) + BigInt(contribution.amount)).toString();
        }
        for (const playerId of input.folded) {
          const player = hand.players.find((candidate) => candidate.playerId === playerId);
          if (player) player.folded = true;
        }
        hand.pots = tiers().filter((pot) => {
          const atCap = hand.players.filter(
            (player) => BigInt(player.contribution) >= BigInt(pot.cap),
          ).length;
          return atCap > 1;
        });
        hand.revision += 1;
      });
    },
    async settleHand(_tableId, input) {
      return mutate('settleHand', input, () => {
        const hand = state.hand;
        if (hand?.handId !== input.handId || hand.revision !== input.expectedRevision)
          throw fail('Hand revision is stale.');
        const allTiers = tiers();
        const refunds = allTiers.filter(
          (pot) => hand.players.filter((player) => BigInt(player.contribution) >= BigInt(pot.cap)).length === 1,
        );
        const contested = allTiers.filter((pot) => !refunds.includes(pot));
        if (input.pots.length !== contested.length) throw fail('Wrong number of pots.');
        const seenCaps = new Set();
        for (const supplied of input.pots) {
          if (seenCaps.has(supplied.cap)) throw fail('Settlement pot caps must be unique.');
          seenCaps.add(supplied.cap);
          const pot = contested.find((candidate) => candidate.cap === supplied.cap);
          const paid = supplied.winners.reduce((total, winner) => total + BigInt(winner.amount), 0n);
          if (!pot || paid !== BigInt(pot.amount)) throw fail('Pot amounts do not conserve.');
          if (supplied.winners.some((winner) => !pot.eligible.includes(winner.playerId)))
            throw fail('Winner is not eligible for this pot.');
        }
        for (const supplied of input.pots) {
          const pot = contested.find((candidate) => candidate.cap === supplied.cap);
          for (const winner of supplied.winners) {
            const seat = seats().find((candidate) => candidate.playerId === winner.playerId);
            if (seat) seat.stack = (BigInt(seat.stack) + BigInt(winner.amount)).toString();
          }
        }
        for (const pot of refunds) {
          const owner = hand.players.find((player) => BigInt(player.contribution) >= BigInt(pot.cap));
          const seat = seats().find((candidate) => candidate.playerId === owner?.playerId);
          if (seat) seat.stack = (BigInt(seat.stack) + BigInt(pot.amount)).toString();
        }
        state.hand = null;
        for (const seat of [...seats()]) if (seat.status === 'leaving') cashOutSeat(seat);
      });
    },
    async cashOut(_tableId, input) {
      return mutate('cashOut', input, () => {
        const seat = seats().find(
          (candidate) => candidate.seatId === input.seatId && candidate.playerId === input.playerId,
        );
        if (!seat) throw fail('Seat generation does not match.');
        const inHand = state.hand?.players.some((player) => player.seatId === seat.seatId);
        if (inHand) seat.status = 'leaving';
        else cashOutSeat(seat);
      });
    },
    async disconnect(_tableId, input) {
      return mutate('disconnect', input, () => {
        const seat = seats().find(
          (candidate) => candidate.seatId === input.seatId && candidate.playerId === input.playerId,
        );
        if (!seat) throw fail('Seat generation does not match.');
        seat.disconnectDeadline = timestamp() + TABLE_POLICY.disconnectGraceMs;
      });
    },
    async close(tableId, input) {
      return mutate('close', input, () => {
        if (state && state.tableId !== tableId) throw fail('Not found', 404);
        if (!state) {
          const now = timestamp();
          state = {
            tableId,
            projectId,
            status: 'closed',
            asset: null,
            settingsVersion: 0,
            maxSeats: 0,
            revision: 0,
            leaseExpiresAt: null,
            maxEndsAt: now,
            seats: [],
            hand: null,
            totals: { buyIns: '0', cashOuts: '0', stacks: '0', committed: '0', pendingCashOuts: '0', backing: '0' },
          };
          return;
        }
        if (state.status === 'closed') return;
        for (const player of handPlayers()) {
          const seat = seats().find((candidate) => candidate.playerId === player.playerId);
          if (seat) seat.stack = (BigInt(seat.stack) + BigInt(player.contribution)).toString();
        }
        state.hand = null;
        for (const quote of quotes.values()) {
          if (quote.status === 'pending') quote.status = 'cancelled';
        }
        for (const seat of [...seats()]) cashOutSeat(seat);
        state.status = 'closed';
        state.leaseExpiresAt = null;
        state.revision += 1;
      });
    },
  };

  const ROUTES = {
    'buy-ins': (tableId, path, input) =>
      path.length === 3 ? handlers.buyIn(tableId, path[2]) : handlers.requestBuyIn(tableId, input),
    hands: (tableId, path, input) => handlers[`${path[2]}Hand`](tableId, input),
    operations: (tableId, path) => handlers.operation(tableId, path[2]),
    heartbeat: (tableId) => handlers.heartbeat(tableId),
    'cash-outs': (tableId, _path, input) => handlers.cashOut(tableId, input),
    disconnect: (tableId, _path, input) => handlers.disconnect(tableId, input),
    close: (tableId, _path, input) => handlers.close(tableId, input),
  };

  const fetchImpl = async (url, options = {}) => {
    try {
      const path = new URL(url).pathname.split('/tables')[1]?.split('/').filter(Boolean) ?? [];
      const input = options.body ? JSON.parse(options.body) : undefined;
      let result;
      if (path.length === 0) result = await handlers.create(input);
      else if (path.length === 1) result = await handlers.status(path[0]);
      else {
        const route = ROUTES[path[1]];
        if (!route) throw fail('Unknown table route.', 404);
        result = await route(path[0], path, input);
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      if (!error.status) throw error;
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { 'content-type': 'application/json' },
      });
    }
  };

  const client = createSpawnTableClient({
    projectId,
    credential: 'x'.repeat(43),
    platformOrigin: 'http://127.0.0.1:9999',
    fetch: fetchImpl,
  });

  return {
    client,
    projectId,
    asset,
    calls,
    /** Agent-readable state: quotes, seats, stacks and totals in one object. */
    state: (playerId) => {
      const snapshotValue = snapshot();
      const quote = playerId
        ? [...quotes.values()].findLast(
            (candidate) => candidate.playerId === playerId && candidate.status === 'pending',
          )
        : undefined;
      return { ...snapshotValue, quotes: [...quotes.values()].map(clone), pendingQuote: quote ? clone(quote) : null };
    },
    /**
     * The tracked test balance for `playerId` — `null` when no `balances` option was supplied or
     * that player is not listed in it. Debits on approval, credits on cash-out.
     */
    balance: (playerId) => (wallets?.has(playerId) ? wallets.get(playerId) : null),
    /** Simulate the player approving their own buy-in in the Spawn overlay. */
    confirmBuyIn(playerId) {
      const stateBefore = state === null ? null : clone(state);
      const quotesBefore = copyQuotes();
      const walletsBefore = copyWallets();
      try {
        sweep();
        const quote = [...quotes.values()].findLast((candidate) => candidate.playerId === playerId);
        if (!quote) throw fail('No pending quote for that player.', 404);
        if (quote.status === 'expired' || quote.expiresAt <= timestamp()) {
          quote.status = 'expired';
          throw fail('Quote has expired.');
        }
        if (quote.status === 'cancelled') throw fail('Quote was cancelled.');
        if (quote.status === 'confirmed')
          return { tableId: state.tableId, buyInId: quote.buyInId, status: 'confirmed' };
        if (!state || state.status !== 'open') throw fail('Table is not open.');
        // With opt-in test balances, an approval the player cannot fund is refused where the real
        // overlay refuses it — at the click — and the quote stays pending. No debit happens.
        if (wallets?.has(playerId) && BigInt(wallets.get(playerId)) < BigInt(quote.amount))
          throw Object.assign(
            fail(
              `Insufficient balance for this buy-in: the player holds ${wallets.get(playerId)} base units, the quote needs ${quote.amount}.`,
            ),
            { code: 'INSUFFICIENT_BALANCE' },
          );
        const existing = seats().find((seat) => seat.playerId === playerId);
        if (existing && existing.status !== 'active') throw fail('A leaving seat cannot be re-bought.');
        if (!existing && seats().length >= state.maxSeats) throw fail('The table has no available seat.');
        if (wallets?.has(playerId))
          wallets.set(playerId, (BigInt(wallets.get(playerId)) - BigInt(quote.amount)).toString());
        quote.status = 'confirmed';
        if (existing) existing.stack = (BigInt(existing.stack) + BigInt(quote.amount)).toString();
        else
          seats().push({
            playerId,
            seatId: randomUUID(),
            stack: quote.amount,
            pendingCashOut: '0',
            status: 'active',
            connectedUntil: Math.min(timestamp() + TABLE_POLICY.leaseMs, state.maxEndsAt),
            disconnectDeadline: null,
          });
        state.totals.buyIns = (BigInt(state.totals.buyIns) + BigInt(quote.amount)).toString();
        state.revision += 1;
        totals();
        return { tableId: state.tableId, buyInId: quote.buyInId, status: 'confirmed' };
      } catch (error) {
        state = stateBefore;
        restoreQuotes(quotesBefore);
        restoreWallets(walletsBefore);
        throw error;
      }
    },
    /** Mark a player connected again (reconnect), clearing the disconnect deadline. */
    reconnect(playerId) {
      const seat = seats().find((candidate) => candidate.playerId === playerId);
      if (!seat) throw fail('No seat for that player.', 404);
      seat.disconnectDeadline = null;
      seat.connectedUntil = timestamp() + TABLE_POLICY.leaseMs;
      totals();
      return clone(seat);
    },
    /**
     * Make the NEXT call to `action` behave like a dropped response: the server applies
     * and records the mutation, then throws. Retrying with the same `operationId` replays
     * the recorded result instead of applying again — that is how you prove idempotency.
     */
    loseNextResponse(action) {
      loseAction = action;
    },
    /**
     * Move the harness clock forward by `ms`, then run the recovery sweep (quote expiry,
     * disconnect grace, lease expiry, hand deadline). Only this method moves time; if you
     * inject `now`, your own clock keeps driving reads and this offset layers on top.
     */
    advance(ms) {
      offset += ms;
      if (state) sweep();
      return state ? clone(state) : null;
    },
    /** Stub one SDK client method; everything else keeps delegating to the frozen real client. */
    stubClient(overrides = {}) {
      return stubClient(client, overrides);
    },
    /** Independent conservation check for assertions; `detail` states the imbalance. */
    conservation() {
      if (!state) throw new Error('No table created yet.');
      const t = totals();
      const delta = BigInt(t.buyIns) - (BigInt(t.cashOuts) + BigInt(t.backing));
      return {
        balanced: delta === 0n,
        totals: clone(t),
        delta: delta.toString(),
        detail: delta === 0n
          ? `buyIns=${t.buyIns} = cashOuts=${t.cashOuts} + backing=${t.backing}`
          : `buyIns=${t.buyIns} != cashOuts=${t.cashOuts} + backing=${t.backing} — unbalanced by ${delta}`,
      };
    },
  };
}

/**
 * Wrap the SDK's frozen table client so a test can replace one method.
 * The client is frozen deliberately, and an ES Proxy may not substitute a value for a
 * frozen (non-configurable, non-writable) data property — so this proxies a plain copy.
 * Every member is bound to the real client, so the real validators still run for
 * everything you did not stub.
 */
export function stubClient(client, overrides = {}) {
  const base = {};
  for (const key of Reflect.ownKeys(client)) {
    const value = Reflect.get(client, key);
    base[key] = typeof value === 'function' ? value.bind(client) : value;
  }
  return new Proxy(base, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      return Reflect.get(target, property);
    },
  });
}

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

export function createLoopbackTableService({ now = Date.now, asset: assetOverride } = {}) {
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

  let clock = typeof now === 'function' ? now() : now;
  const timestamp = () => clock;
  let state = null;
  let loseAction = null;
  const quotes = new Map();
  const operations = new Map();
  const calls = [];

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
    state.totals.cashOuts = (
      BigInt(state.totals.cashOuts) + BigInt(seat.stack) + BigInt(seat.pendingCashOut)
    ).toString();
    seat.stack = '0';
    seat.pendingCashOut = '0';
    state.seats = state.seats.filter((candidate) => candidate !== seat);
  }

  /** Deadline/lease/disconnect sweep, mirroring the platform's recovery rules. */
  function sweep() {
    if (!state) return;
    if (state.hand && timestamp() > state.hand.deadline) {
      for (const player of state.hand.players) {
        const seat = seats().find((candidate) => candidate.playerId === player.playerId);
        if (seat) seat.stack = (BigInt(seat.stack) + BigInt(player.contribution)).toString();
      }
      state.hand = null;
    }
    if (timestamp() > state.leaseExpiresAt) {
      for (const player of handPlayers()) {
        const seat = seats().find((candidate) => candidate.playerId === player.playerId);
        if (seat) seat.stack = (BigInt(seat.stack) + BigInt(player.contribution)).toString();
      }
      state.hand = null;
      for (const seat of [...seats()]) cashOutSeat(seat);
      state.status = 'closed';
    }
    for (const seat of [...seats()]) {
      if (seat.disconnectDeadline !== null && timestamp() >= seat.disconnectDeadline) {
        seat.status = 'leaving';
        seat.disconnectDeadline = null;
      }
      const inHand = state.hand?.players.some((player) => player.seatId === seat.seatId);
      if (seat.status === 'leaving' && !inHand) cashOutSeat(seat);
    }
    totals();
  }

  function snapshot() {
    sweep();
    if (!state) throw fail('Not found', 404);
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
    sweep();
    apply();
    state.revision += 1;
    totals();
    const result = action === 'requestBuyIn' ? quotes.get(input.buyInId) : state;
    operations.set(input.operationId, {
      operationId: input.operationId,
      action,
      result: clone(result),
      input: clone(input),
    });
    calls.push({ action, input: clone(input) });
    if (loseAction === action) {
      loseAction = null;
      throw new Error(`Simulated lost response for ${action}.`);
    }
    return clone(result);
  }

  const handlers = {
    async create(input) {
      return mutate('create', input, () => {
        if (state) throw fail('Table already exists.');
        state = {
          tableId: input.tableId,
          projectId,
          status: 'open',
          asset,
          settingsVersion: 1,
          maxSeats: input.maxSeats,
          revision: 0,
          leaseExpiresAt: timestamp() + TABLE_POLICY.leaseMs,
          maxEndsAt: timestamp() + TABLE_POLICY.maxAgeMs,
          seats: [],
          hand: null,
          totals: { buyIns: '0', cashOuts: '0', stacks: '0', committed: '0', pendingCashOuts: '0', backing: '0' },
        };
      });
    },
    async status() {
      return snapshot();
    },
    async heartbeat() {
      sweep();
      if (state.status === 'open') state.leaseExpiresAt = timestamp() + TABLE_POLICY.leaseMs;
      return snapshot();
    },
    async operation(_tableId, operationId) {
      const saved = operations.get(operationId);
      if (!saved) throw fail('Not found', 404);
      return { operationId, action: saved.action, result: clone(saved.result) };
    },
    async requestBuyIn(tableId, input) {
      return mutate('requestBuyIn', input, () => {
        if (state.status !== 'open') throw fail('Table is not open.');
        quotes.set(input.buyInId, {
          tableId,
          buyInId: input.buyInId,
          playerId: input.player.playerId,
          quoteId: randomUUID(),
          status: 'pending',
          amount: input.amount,
          asset,
          settingsVersion: 1,
          expiresAt: timestamp() + TABLE_POLICY.quoteMs,
        });
      });
    },
    async buyIn(_tableId, buyInId) {
      sweep();
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
        for (const supplied of input.pots) {
          const pot = contested.find((candidate) => candidate.cap === supplied.cap);
          const paid = supplied.winners.reduce((total, winner) => total + BigInt(winner.amount), 0n);
          if (!pot || paid !== BigInt(pot.amount))
            throw fail('Pot amounts do not conserve.');
          if (supplied.winners.some((winner) => !pot.eligible.includes(winner.playerId)))
            throw fail('Winner is not eligible for this pot.');
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
  };

  const ROUTES = {
    'buy-ins': (tableId, path, input) =>
      path.length === 3 ? handlers.buyIn(tableId, path[2]) : handlers.requestBuyIn(tableId, input),
    hands: (tableId, path, input) => handlers[`${path[2]}Hand`](tableId, input),
    operations: (tableId, path) => handlers.operation(tableId, path[2]),
    heartbeat: (tableId) => handlers.heartbeat(tableId),
    'cash-outs': (tableId, _path, input) => handlers.cashOut(tableId, input),
    disconnect: (tableId, _path, input) => handlers.disconnect(tableId, input),
  };

  const fetchImpl = async (url, options = {}) => {
    try {
      const path = new URL(url).pathname.split('/tables')[1]?.split('/').filter(Boolean) ?? [];
      const input = options.body ? JSON.parse(options.body) : undefined;
      let result;
      if (path.length === 0) result = await handlers.create(input);
      else if (path.length === 1) result = await handlers.status(path[0]);
      else result = await ROUTES[path[1]](path[0], path, input);
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
    /** Simulate the player approving their own buy-in in the Spawn overlay. */
    confirmBuyIn(playerId) {
      const quote = [...quotes.values()].findLast(
        (candidate) => candidate.playerId === playerId && candidate.status === 'pending',
      );
      if (!quote) throw fail('No pending quote for that player.', 404);
      if (quote.expiresAt < timestamp()) throw fail('Quote has expired.');
      if (state.status !== 'open') throw fail('Table is not open.');
      quote.status = 'confirmed';
      const existing = seats().find((seat) => seat.playerId === playerId);
      if (existing) existing.stack = (BigInt(existing.stack) + BigInt(quote.amount)).toString();
      else
        seats().push({
          playerId,
          seatId: randomUUID(),
          stack: quote.amount,
          pendingCashOut: '0',
          status: 'active',
          connectedUntil: timestamp() + TABLE_POLICY.leaseMs,
          disconnectDeadline: null,
        });
      state.totals.buyIns = (BigInt(state.totals.buyIns) + BigInt(quote.amount)).toString();
      state.revision += 1;
      totals();
      return { tableId: state.tableId, buyInId: quote.buyInId, status: 'confirmed' };
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
    /** Simulate a lost HTTP response for one action, to exercise retry paths. */
    loseNextResponse(action) {
      loseAction = action;
    },
    /** Advance the fake clock, then run the recovery sweep (deadlines, leases, grace). */
    advance(ms) {
      clock += ms;
      if (state) sweep();
      return state ? clone(state) : null;
    },
    /** Independent conservation check for assertions. */
    conservation() {
      if (!state) throw new Error('No table created yet.');
      const t = totals();
      const balanced = BigInt(t.buyIns) === BigInt(t.cashOuts) + BigInt(t.backing);
      return { balanced, totals: clone(t), detail: `buyIns=${t.buyIns} cashOuts=${t.cashOuts} backing=${t.backing}` };
    },
  };
}

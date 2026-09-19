/**
 * Loopback Spawn payout service — first-party test double.
 *
 * Why this exists: a payout moves the game's pool balance to a member, and the only
 * way to know a reward or redemption loop works is to run it. The real platform needs
 * a registered game with an admitted Listing token, signed-in member accounts and the
 * dedicated match server credential, none of which can be scripted headlessly. This
 * module speaks the same request/response contract as the platform's registered-game
 * payout routes, so the SDK's REAL payout client and validators can drive it on
 * loopback — the exact-loopback seam documented in docs/payouts.md.
 *
 * It enforces the documented invariants, and throws if a scenario breaks one:
 *
 *   pool + members = the same total the service started with
 *   a payout against a deposit never exceeds that deposit summed across prior payouts
 *   one operationId moves money exactly once
 *
 * The service models one registered game. `deposit(playerId, amount)` simulates that
 * member's already-paid deposit: it debits the member's tracked balance and credits the
 * game pool. The wired client's `create()` then pays a registered member out of the pool.
 * It is a test double, not an outcome engine: your authoritative server still decides who
 * is paid and why.
 */
import { randomUUID } from 'node:crypto';

/** Documented platform policy defaults (docs/payouts.md). */
export const PAYOUT_POLICY = {
  writesPerMinute: 60,
  maxReasonLength: 160,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE_UNITS = /^(?:0|[1-9][0-9]{0,77})$/;
const UINT256_MAX = (2n ** 256n) - 1n;
const JSON_HEADERS = { 'content-type': 'application/json' };

const sum = (values) => values.reduce((total, value) => total + BigInt(value), 0n).toString();
const clone = (value) => structuredClone(value);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Canonical base-unit string for a test amount: `'1000'` or `1000`, never a decimal. */
function canonicalBalance(value, label) {
  const canonical = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof canonical !== 'string' || !BASE_UNITS.test(canonical) || BigInt(canonical) > UINT256_MAX)
    throw new Error(`${label} must be an unsigned integer in token base units.`);
  return canonical;
}

async function loadPayoutClient() {
  try {
    const module = await import('@spawndotfamily/sdk/server');
    if (typeof module.createSpawnPayoutClient === 'function') return module.createSpawnPayoutClient;
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
  }
  // This fallback is for running from this source checkout with `node --experimental-strip-types`;
  // packaged users resolve the public export above.
  return (await import('../src/payout-server.ts')).createSpawnPayoutClient;
}

const createPayoutClient = await loadPayoutClient();

export function createLoopbackPayoutService({
  now = Date.now,
  assetId: assetOverride,
  members: memberOverrides,
  launches: launchOverrides,
  pool: poolOverride,
  projectId: projectOverride,
  credential: credentialOverride,
} = {}) {
  const projectId = projectOverride ?? randomUUID();
  if (typeof projectId !== 'string' || !UUID.test(projectId))
    throw new Error('projectId must be a UUID.');
  const assetId = assetOverride === undefined ? `erc20:46630:0x${'1'.repeat(40)}` : assetOverride;
  if (assetId !== null && (typeof assetId !== 'string' || assetId.length === 0))
    throw new Error('assetId must be a non-empty string, or null for a game with no Listing token.');
  const credential = credentialOverride ?? 'x'.repeat(43);
  if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential))
    throw new Error('credential must be a 43-character base64url match server credential.');

  if (memberOverrides !== undefined && (memberOverrides === null || typeof memberOverrides !== 'object' || Array.isArray(memberOverrides)))
    throw new Error('members must be an object mapping a playerId to an unsigned integer in token base units.');
  const balances = new Map(
    Object.entries(memberOverrides ?? {}).map(([playerId, amount]) => {
      if (!UUID.test(playerId)) throw new Error(`Member ID ${playerId} must be a UUID.`);
      return [playerId.toLowerCase(), canonicalBalance(amount, `Test balance for ${playerId}`)];
    }),
  );
  const launches = new Map();
  if (launchOverrides !== undefined && (launchOverrides === null || typeof launchOverrides !== 'object' || Array.isArray(launchOverrides)))
    throw new Error('launches must be an object mapping a registered member to an active launch ID.');
  for (const [playerId, launchId] of Object.entries(launchOverrides ?? {})) {
    if (!balances.has(playerId.toLowerCase()))
      throw new Error(`launches names ${playerId}, which is not a registered member.`);
    if (typeof launchId !== 'string' || !UUID.test(launchId))
      throw new Error(`The active launch for ${playerId} must be a UUID.`);
    launches.set(playerId.toLowerCase(), launchId.toLowerCase());
  }
  let poolBalance = canonicalBalance(poolOverride ?? '0', 'Test pool balance');
  const initial = (BigInt(poolBalance) + BigInt(sum([...balances.values()]))).toString();

  // The clock is read LIVE, per call, so a caller that injects its own test clock
  // (`now: () => myGameClock`) follows that clock instead of freezing at construction;
  // `advance(ms)` adds a synthetic offset on top of whatever `now` reports.
  const baseNow = typeof now === 'function' ? now() : now;
  let offset = 0;
  const timestamp = () => (typeof now === 'function' ? now() : baseNow) + offset;

  const deposits = [];
  const operations = new Map();
  const writes = [];
  const calls = [];
  let suspension = null;
  let loseAction = null;

  const fail = (message, status = 409, headers) => Object.assign(new Error(message), { status, headers });

  function totals() {
    const members = sum([...balances.values()]);
    const total = (BigInt(poolBalance) + BigInt(members)).toString();
    const t = {
      pool: poolBalance,
      members,
      total,
      initial,
      deposits: sum(deposits.map((deposit) => deposit.amount)),
      payouts: sum([...operations.values()].map((entry) => entry.receipt.amount)),
    };
    if (BigInt(total) !== BigInt(initial)) {
      throw new Error(
        `Loopback payout conservation violated: pool=${t.pool} members=${t.members} total=${t.total} initial=${t.initial}`,
      );
    }
    return t;
  }

  function memberState() {
    return [...balances.entries()].map(([playerId, balance]) => ({
      playerId,
      balance,
      launchId: launches.get(playerId) ?? null,
    }));
  }

  /** Agent-readable state: pool, members, deposits and recorded payout receipts in one object. */
  function state(playerId) {
    const payouts = [...operations.values()].map((entry) => clone(entry.receipt));
    const lastPayout =
      typeof playerId === 'string'
        ? payouts.filter((receipt) => receipt.playerId === playerId.toLowerCase()).at(-1) ?? null
        : null;
    return {
      projectId,
      assetId,
      suspended: suspension,
      pool: poolBalance,
      members: memberState(),
      deposits: deposits.map((deposit) => clone(deposit)),
      payouts,
      lastPayout,
    };
  }

  function uuidText(value) {
    if (typeof value !== 'string' || !UUID.test(value)) throw fail('Invalid payout request fields.', 400);
    return value.toLowerCase();
  }

  function baseUnits(value) {
    if (typeof value !== 'string' || !BASE_UNITS.test(value) || BigInt(value) === 0n || BigInt(value) > UINT256_MAX)
      throw fail('amount must be a canonical unsigned integer in token base units, greater than zero.', 400);
    return value;
  }

  /** Documented bound: 60 payout writes per minute per game, counted over the trailing window. */
  function rateLimit() {
    const current = timestamp();
    while (writes.length > 0 && writes[0] <= current - 60_000) writes.shift();
    if (writes.length >= PAYOUT_POLICY.writesPerMinute) {
      const seconds = Math.max(1, Math.ceil((writes[0] + 60_000 - current) / 1000));
      throw fail('Too many payout writes for this game; retry shortly.', 429, { 'retry-after': String(seconds) });
    }
    writes.push(current);
  }

  function handleCreate(input) {
    if (
      !isRecord(input) ||
      !['operationId', 'playerId', 'amount'].every((key) => Object.hasOwn(input, key)) ||
      Object.keys(input).some((key) => !['operationId', 'playerId', 'launchId', 'amount', 'depositId', 'reason'].includes(key))
    )
      throw fail('Invalid payout request fields.', 400);
    const operationId = uuidText(input.operationId);
    const playerId = uuidText(input.playerId);
    const launchId = input.launchId === undefined ? null : uuidText(input.launchId);
    const amount = baseUnits(input.amount);
    const depositId = input.depositId === undefined ? null : uuidText(input.depositId);
    if (
      input.reason !== undefined &&
      (typeof input.reason !== 'string' || input.reason.length === 0 || input.reason.length > PAYOUT_POLICY.maxReasonLength)
    )
      throw fail('reason must be a short non-empty string of at most 160 characters.', 400);

    // Durable idempotency: an identical retry replays the recorded receipt and never
    // depends on current balances; a changed body under the same ID is a conflict.
    const recorded = operations.get(operationId);
    if (recorded) {
      if (JSON.stringify(recorded.input) !== JSON.stringify(input))
        throw fail('Conflicting payout operation body.', 409);
      return clone(recorded.receipt);
    }

    if (!balances.has(playerId)) throw fail('The payout recipient is not a registered member of this game.', 401);
    if (launchId !== null && launches.get(playerId) !== launchId)
      throw fail('The payout launch does not match an active launch of this game.', 401);
    if (assetId === null) throw fail('No Listing token is configured for this game.', 409);
    if (depositId !== null) {
      const deposit = deposits.find((entry) => entry.depositId === depositId);
      if (!deposit) throw fail('The referenced deposit is not a paid deposit of this game.', 409);
      if (deposit.playerId !== playerId) throw fail('The referenced deposit belongs to another member.', 409);
      const redeemed = sum(
        [...operations.values()]
          .filter((entry) => entry.receipt.depositId === depositId)
          .map((entry) => entry.receipt.amount),
      );
      if (BigInt(redeemed) + BigInt(amount) > BigInt(deposit.amount))
        throw fail(
          `Payouts against this deposit are capped at ${deposit.amount} base units; ${redeemed} is already redeemed.`,
          409,
        );
    }
    if (BigInt(amount) > BigInt(poolBalance))
      throw fail(`The game pool holds ${poolBalance} base units and cannot cover a payout of ${amount}.`, 409);

    balances.set(playerId, (BigInt(balances.get(playerId)) + BigInt(amount)).toString());
    poolBalance = (BigInt(poolBalance) - BigInt(amount)).toString();
    const receipt = {
      id: randomUUID(),
      projectId,
      playerId,
      assetId,
      amount,
      depositId,
      status: 'paid',
      createdAt: timestamp(),
    };
    operations.set(operationId, { operationId, input: clone(input), receipt: clone(receipt) });
    calls.push({ action: 'create', input: clone(input) });
    totals();
    if (loseAction === 'create') {
      loseAction = null;
      throw new Error('Simulated lost response for create.');
    }
    return receipt;
  }

  const transport = async (url, options = {}) => {
    try {
      const segments = new URL(url).pathname.split('/payouts');
      const prefix = (segments[0] ?? '').split('/').filter(Boolean);
      const rest = (segments[1] ?? '').split('/').filter(Boolean);
      if (segments.length !== 2 || prefix.length !== 4 || prefix[3] !== projectId || rest.length > 1)
        throw fail('Unknown project.', 404);
      const headers = new Headers(options.headers ?? {});
      if (headers.get('origin') !== null)
        throw fail('A browser origin cannot call the payout route.', 403);
      if (headers.get('authorization') !== `Bearer ${credential}`)
        throw fail('Dedicated match server authorization is required.', 401);
      if (suspension !== null) throw fail(suspension, 503);
      const method = (options.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        if (rest.length !== 0) throw fail('Unknown payout route.', 404);
        rateLimit();
        let body;
        try {
          body = JSON.parse(options.body);
        } catch {
          throw fail('Invalid payout request fields.', 400);
        }
        return new Response(JSON.stringify(handleCreate(body)), { status: 200, headers: JSON_HEADERS });
      }
      if (method === 'GET') {
        if (rest.length !== 1) throw fail('Unknown payout route.', 404);
        const operationId = uuidText(rest[0]);
        const recorded = operations.get(operationId);
        return new Response(JSON.stringify(recorded ? clone(recorded.receipt) : null), { status: 200, headers: JSON_HEADERS });
      }
      throw fail('Unknown payout route.', 404);
    } catch (error) {
      if (!error.status) throw error;
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...JSON_HEADERS, ...(error.headers ?? {}) },
      });
    }
  };

  const client = createPayoutClient({
    projectId,
    credential,
    platformOrigin: 'http://127.0.0.1:9999',
    fetch: transport,
  });

  return {
    client,
    projectId,
    assetId,
    /** The fake platform transport; wrap it to probe contract edges the client cannot reach. */
    transport,
    calls,
    state,
    /** The game's current pool balance, as a base-unit string. */
    pool: () => poolBalance,
    /**
     * The tracked balance for `playerId`, or `null` when that player is not a registered
     * member. Deposits debit it; payouts credit it.
     */
    balance: (playerId) => {
      const id = typeof playerId === 'string' ? playerId.toLowerCase() : playerId;
      return balances.has(id) ? balances.get(id) : null;
    },
    /**
     * Simulate that member's already-paid deposit: debit the member, credit the pool and
     * record the paid deposit so payouts can reference it. Returns the deposit record.
     */
    deposit(playerId, amount, { depositId } = {}) {
      if (typeof playerId !== 'string' || !UUID.test(playerId) || !balances.has(playerId.toLowerCase()))
        throw fail('deposit needs a registered member of this game.', 404);
      const id = playerId.toLowerCase();
      const value = canonicalBalance(amount, 'Deposit amount');
      if (BigInt(value) === 0n) throw new Error('Deposit amount must be greater than zero.');
      const reference = depositId === undefined ? randomUUID() : depositId;
      if (typeof reference !== 'string' || !UUID.test(reference)) throw new Error('depositId must be a UUID.');
      if (deposits.some((entry) => entry.depositId === reference.toLowerCase()))
        throw new Error('That deposit ID was already recorded.');
      if (BigInt(balances.get(id)) < BigInt(value))
        throw new Error(`Member ${id} holds ${balances.get(id)} base units and cannot deposit ${value}.`);
      balances.set(id, (BigInt(balances.get(id)) - BigInt(value)).toString());
      poolBalance = (BigInt(poolBalance) + BigInt(value)).toString();
      const record = { depositId: reference.toLowerCase(), playerId: id, amount: value, status: 'paid', paidAt: timestamp() };
      deposits.push(record);
      totals();
      return clone(record);
    },
    /** Drop a member's active launch, as launch cleanup would; an unbound payout still works. */
    expireLaunch(playerId) {
      const id = typeof playerId === 'string' ? playerId.toLowerCase() : playerId;
      if (!launches.delete(id)) throw new Error(`No active launch is recorded for ${playerId}.`);
    },
    /** Make every payout write fail 503 until `resume()`, as a suspended game or custody outage does. */
    suspend(reason = 'The game is suspended.') {
      if (typeof reason !== 'string' || reason.length === 0 || reason.length > 512)
        throw new Error('suspend reason must be a short non-empty string.');
      suspension = reason;
      return reason;
    },
    resume() {
      suspension = null;
    },
    /**
     * Make the NEXT call to `action` behave like a dropped response: the platform applies
     * and records the payout, then throws. Retrying with the same `operationId` replays
     * the recorded receipt instead of paying again — that is how you prove idempotency.
     */
    loseNextResponse(action) {
      loseAction = action;
    },
    /** Move the harness clock forward by `ms` (only the rate-bound window reads it). */
    advance(ms) {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('advance needs a nonnegative millisecond count.');
      offset += ms;
      return state();
    },
    /** Stub one SDK client method; everything else keeps delegating to the frozen real client. */
    stubClient(overrides = {}) {
      return stubClient(client, overrides);
    },
    /** Independent conservation check for assertions; `detail` states the imbalance. */
    conservation() {
      const t = totals();
      const delta = BigInt(t.total) - BigInt(t.initial);
      return {
        balanced: delta === 0n,
        totals: clone(t),
        delta: delta.toString(),
        detail:
          delta === 0n
            ? `pool=${t.pool} + members=${t.members} = ${t.total} (unchanged from ${t.initial})`
            : `pool=${t.pool} + members=${t.members} = ${t.total} != initial ${t.initial} — unbalanced by ${delta}`,
      };
    },
  };
}

/**
 * Wrap the SDK's frozen payout client so a test can replace one method.
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

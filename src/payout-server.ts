import {
  httpCode,
  publicErrorDetails,
  type SpawnMatchErrorCode,
  type SpawnMatchErrorDetails,
} from './match-errors.ts';
import {
  exact,
  isRecord,
  validateBaseUnits,
  validateNonnegativeInteger,
  validateUuid,
} from './table-validation.ts';

/** Server-only client for the registered game's Listing-token payout route. */
export type SpawnPayoutClientOptions = {
  platformOrigin: string;
  projectId: string;
  /** The game's dedicated match server secret, never a publishing or storage key. */
  credential: string;
  timeoutMs?: number;
  /** Optional server transport, useful for isolated tests. Must enforce the supplied request options. */
  fetch?: typeof globalThis.fetch;
};
export type SpawnPayoutInput = {
  /** The single idempotency key for this payout; an identical retry returns the same receipt. */
  operationId: string;
  /** The Spawn member who receives the payout, resolved to a recipient server-side. */
  playerId: string;
  /** Optional active-launch chain; omit for a payout to any registered member of this game. */
  launchId?: string;
  /** Exact token amount in base units, a canonical unsigned integer string above zero. */
  amount: string;
  /** Optional paid deposit this payout redeems against, capping it at that deposit. */
  depositId?: string;
  /** Optional short human-readable reason, at most 160 characters. */
  reason?: string;
};
export type SpawnPayoutReceipt = {
  id: string;
  projectId: string;
  playerId: string;
  assetId: string;
  amount: string;
  depositId: string | null;
  status: 'paid';
  createdAt: number;
};
export type SpawnPayoutOperation = SpawnPayoutReceipt | null;
export type SpawnPayoutErrorDetails = SpawnMatchErrorDetails & {
  operationId?: string;
  depositId?: string;
};

/**
 * Safe diagnostics for payout requests. A mutation with an unknown outcome must be
 * reconciled by reading the same operation ID before any further payout.
 */
export class SpawnPayoutRequestError extends Error {
  readonly status: number | undefined;
  readonly outcomeUnknown: boolean;
  readonly code: SpawnMatchErrorCode;
  readonly action?: string;
  readonly operationId?: string;
  readonly depositId?: string;
  readonly projectId?: string;
  readonly reason?: string;
  readonly platformCode?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    status: number | undefined,
    outcomeUnknown: boolean,
    details: SpawnPayoutErrorDetails = {},
  ) {
    super(message);
    this.name = 'SpawnPayoutRequestError';
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
    this.code = details.code ?? (status === undefined ? 'TRANSPORT_ERROR' : httpCode(status));
    this.action = details.action;
    this.operationId = details.operationId;
    this.depositId = details.depositId;
    this.projectId = details.projectId;
    this.reason = details.reason;
    this.platformCode = details.platformCode;
    this.requestId = details.requestId;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** Suitable for a private server journal; do not forward diagnostics publicly. */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      outcomeUnknown: this.outcomeUnknown,
      action: this.action,
      operationId: this.operationId,
      depositId: this.depositId,
      projectId: this.projectId,
      reason: this.reason,
      platformCode: this.platformCode,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

function fields(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (
    !isRecord(value) ||
    Object.keys(value).length < required.length ||
    Object.keys(value).length > required.length + optional.length ||
    !required.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error('Invalid payout request fields.');
  return value;
}

function memberUuid(value: unknown, name: string): string {
  if (typeof value === 'string' && /^guest_[a-f0-9]{64}$/i.test(value))
    throw new Error(`${name} must be a signed-in Spawn member; guests cannot receive payouts.`);
  return validateUuid(value, name);
}

function origin(value: string) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Use a trusted Spawn HTTPS origin, or exact loopback for local testing.');
  return url.origin;
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 65536) throw new Error('Response too large.');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** A receipt is bound to the project, and to the player, amount and deposit it was requested for. */
function receipt(
  value: unknown,
  project: string,
  expected: { playerId?: string; amount?: string; depositId?: string | null },
): SpawnPayoutReceipt {
  if (!exact(value, ['id', 'projectId', 'playerId', 'assetId', 'amount', 'depositId', 'status', 'createdAt']))
    throw new Error('Invalid payout receipt.');
  const id = validateUuid(value.id, 'receipt id');
  const projectId = validateUuid(value.projectId, 'receipt projectId');
  if (projectId !== project) throw new Error('Payout receipt belongs to a different project.');
  const playerId = memberUuid(value.playerId, 'receipt playerId');
  if (expected.playerId !== undefined && playerId !== expected.playerId)
    throw new Error('Payout receipt belongs to a different player.');
  if (typeof value.assetId !== 'string' || value.assetId.length === 0 || value.assetId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(value.assetId))
    throw new Error('Invalid payout receipt asset.');
  const amount = validateBaseUnits(value.amount, 'receipt amount', true);
  if (expected.amount !== undefined && amount !== expected.amount)
    throw new Error('Payout receipt amount differs from the requested amount.');
  const depositId = value.depositId === null ? null : validateUuid(value.depositId, 'receipt depositId');
  if (expected.depositId !== undefined && depositId !== expected.depositId)
    throw new Error('Payout receipt deposit reference differs from the request.');
  if (value.status !== 'paid') throw new Error('Invalid payout receipt status.');
  const createdAt = validateNonnegativeInteger(value.createdAt, 'receipt createdAt');
  return { id, projectId, playerId, assetId: value.assetId, amount, depositId, status: 'paid', createdAt };
}

/**
 * Server-only payout client. `operationId` is the single idempotency key: an identical
 * retry returns the same receipt and moves money exactly once. Never retries implicitly;
 * reconcile an unknown outcome with operation(operationId).
 */
export function createSpawnPayoutClient(options: SpawnPayoutClientOptions) {
  if (typeof window !== 'undefined')
    throw new Error('Spawn payout credentials belong only on an authoritative server.');
  const platform = origin(options.platformOrigin),
    project =
      typeof options.projectId === 'string' ? options.projectId.toLowerCase() : options.projectId,
    credential = options.credential;
  if (
    typeof project !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(project) ||
    typeof credential !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(credential)
  )
    throw new Error('A project ID and dedicated match server credential are required.');
  const timeout = options.timeoutMs ?? 10000,
    transport = options.fetch ?? globalThis.fetch;
  if (
    !Number.isInteger(timeout) ||
    timeout < 100 ||
    timeout > 30000 ||
    typeof transport !== 'function'
  )
    throw new Error('Invalid payout transport configuration.');
  const base = platform + '/api/v1/registered-games/' + project + '/payouts';
  async function request<T>(
    operationId: string,
    action: 'create' | 'operation',
    payload: unknown,
    decode: (value: unknown) => T,
  ): Promise<T> {
    const id = validateUuid(operationId, 'operationId');
    const mutation = payload !== undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let responseStatus: number | undefined;
    try {
      const response = await transport(base + (action === 'create' ? '' : '/' + id), {
        method: mutation ? 'POST' : 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: 'Bearer ' + credential,
          accept: 'application/json',
          ...(mutation ? { 'content-type': 'application/json' } : {}),
        },
        ...(mutation ? { body: JSON.stringify(payload) } : {}),
      });
      responseStatus = response.status;
      if (!response.ok) {
        let errorBody: unknown;
        try { errorBody = await boundedJson(response); } catch { /* Keep the known HTTP status. */ }
        const details = publicErrorDetails(errorBody, response, credential);
        throw new SpawnPayoutRequestError(
          details.reason ?? (response.status === 401 || response.status === 403
            ? 'Dedicated match server authorization is required.'
            : 'Spawn rejected the payout request. Check the operation and the game’s payout configuration.'),
          response.status,
          mutation && (response.status >= 500 || response.status === 408),
          { ...details, code: httpCode(response.status), action, operationId: id, projectId: project },
        );
      }
      return decode(await boundedJson(response));
    } catch (error) {
      if (error instanceof SpawnPayoutRequestError) throw error;
      throw new SpawnPayoutRequestError(
        mutation
          ? 'Payout outcome is unknown. Read the payout operation with the same operation ID before paying again.'
          : 'Could not read the payout operation; the response was invalid or unavailable.',
        responseStatus,
        mutation,
        {
          code: controller.signal.aborted
            ? 'REQUEST_TIMEOUT'
            : responseStatus === undefined ? 'TRANSPORT_ERROR' : 'INVALID_RESPONSE',
          action,
          operationId: id,
          projectId: project,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  const client = {
    async create(input: SpawnPayoutInput) {
      const value = fields(input, ['operationId', 'playerId', 'amount'], ['launchId', 'depositId', 'reason']);
      const operationId = validateUuid(value.operationId, 'operationId');
      const playerId = memberUuid(value.playerId, 'playerId');
      const launchId = value.launchId === undefined ? undefined : memberUuid(value.launchId, 'launchId');
      const amount = validateBaseUnits(value.amount, 'amount', true);
      const depositId = value.depositId === undefined ? undefined : validateUuid(value.depositId, 'depositId');
      let reason: string | undefined;
      if (value.reason !== undefined) {
        if (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 160)
          throw new Error('reason must be a short non-empty string of at most 160 characters.');
        reason = value.reason;
      }
      const payload = {
        operationId,
        playerId,
        ...(launchId === undefined ? {} : { launchId }),
        amount,
        ...(depositId === undefined ? {} : { depositId }),
        ...(reason === undefined ? {} : { reason }),
      };
      return request(operationId, 'create', payload, (response) =>
        receipt(response, project, { playerId, amount, depositId: depositId ?? null }),
      );
    },
    /** The recorded receipt for an operation ID, or null. Safe to repeat; never moves money. */
    operation(operationId: string) {
      return request<SpawnPayoutOperation>(operationId, 'operation', undefined, (value) =>
        value === null ? null : receipt(value, project, {}),
      );
    },
  };
  return Object.freeze(client);
}

export type SpawnPayoutClient = ReturnType<typeof createSpawnPayoutClient>;

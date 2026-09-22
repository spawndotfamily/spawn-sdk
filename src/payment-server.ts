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
  validateMemberUuid,
  validateUuid,
} from './table-validation.ts';
import type { SpawnMatchClientOptions } from './match-server.ts';
import type { SpawnTokenPaymentReceipt } from './index.ts';

export type { SpawnTokenPaymentReceipt } from './index.ts';

/** Server-only options; this uses the same trusted-origin and dedicated-key shape as the other server clients. */
export type SpawnPaymentClientOptions = SpawnMatchClientOptions;
export type SpawnTokenPaymentClientOptions = SpawnPaymentClientOptions;

export type SpawnTokenPaymentLookupInput =
  | { playerId: string; receiptId: string }
  | { playerId: string; requestId: string; launchId: string };
export type SpawnPaymentLookupInput = SpawnTokenPaymentLookupInput;

export type SpawnTokenPaymentStatus =
  | 'paid'
  | 'pending'
  | 'cancelled'
  | 'expired'
  | 'not_found';

export type SpawnTokenPaymentLookup = {
  status: SpawnTokenPaymentStatus;
  playerId: string;
  requestId: string | null;
  launchId: string | null;
  item: string | null;
  receipt: SpawnTokenPaymentReceipt | null;
};
export type SpawnPaymentLookup = SpawnTokenPaymentLookup;

export type SpawnTokenPaymentErrorDetails = SpawnMatchErrorDetails & {
  projectId?: string;
  launchId?: string;
  receiptId?: string;
};

/** Safe, read-only diagnostics for payment recovery; this operation never moves tokens. */
export class SpawnTokenPaymentError extends Error {
  readonly status: number | undefined;
  readonly code: SpawnMatchErrorCode;
  readonly projectId?: string;
  readonly launchId?: string;
  readonly receiptId?: string;
  readonly reason?: string;
  readonly platformCode?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(
    code: SpawnMatchErrorCode,
    status?: number,
    details: SpawnTokenPaymentErrorDetails = {},
  ) {
    super(details.reason ?? 'Could not verify Spawn token payment status. Retain the original payment request and reconcile it before retrying.');
    this.name = 'SpawnTokenPaymentError';
    this.status = status;
    this.code = code;
    this.projectId = details.projectId;
    this.launchId = details.launchId;
    this.receiptId = details.receiptId;
    this.reason = details.reason;
    this.platformCode = details.platformCode;
    this.requestId = details.requestId;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** Suitable for a private recovery journal; never forward diagnostics publicly. */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      projectId: this.projectId,
      launchId: this.launchId,
      receiptId: this.receiptId,
      reason: this.reason,
      platformCode: this.platformCode,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

/** Alias for callers that name the read operation rather than the payment record. */
export { SpawnTokenPaymentError as SpawnPaymentLookupError };

const PAYMENT_STATUSES = new Set<SpawnTokenPaymentStatus>([
  'paid',
  'pending',
  'cancelled',
  'expired',
  'not_found',
]);
const ASSET = /^erc20:(?:46630|31337):0x[a-f0-9]{40}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function origin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('Use a trusted Spawn HTTPS origin, or exact loopback for local testing.');
  }
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
      if (length > 65_536) throw new Error('Response too large.');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function localOrigin(platform: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(platform).hostname);
}

function paymentInput(value: unknown): SpawnTokenPaymentLookupInput {
  if (exact(value, ['playerId', 'receiptId'])) {
    return {
      playerId: validateMemberUuid(value.playerId, 'playerId'),
      receiptId: validateUuid(value.receiptId, 'receiptId'),
    };
  }
  if (exact(value, ['playerId', 'requestId', 'launchId'])) {
    return {
      playerId: validateMemberUuid(value.playerId, 'playerId'),
      requestId: validateUuid(value.requestId, 'requestId'),
      launchId: validateUuid(value.launchId, 'launchId'),
    };
  }
  throw new Error('Use either { playerId, receiptId } or { playerId, requestId, launchId }.');
}

function nullableUuid(value: unknown, name: string): string | null {
  return value === null ? null : validateUuid(value, name);
}

function item(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 80 || CONTROL.test(value))
    throw new Error('Invalid payment item.');
  return value;
}

function receipt(
  value: unknown,
  expectedProjectId: string,
  allowLocal: boolean,
): SpawnTokenPaymentReceipt {
  if (!exact(value, ['id', 'assetId', 'amount', 'projectId', 'status']))
    throw new Error('Invalid token payment receipt.');
  const id = validateUuid(value.id, 'receipt id');
  const projectId = validateUuid(value.projectId, 'receipt projectId');
  if (projectId !== expectedProjectId) throw new Error('Token payment receipt belongs to a different project.');
  if (typeof value.assetId !== 'string' || !ASSET.test(value.assetId))
    throw new Error('Invalid token payment receipt asset.');
  if (value.assetId.startsWith('erc20:31337:') && !allowLocal)
    throw new Error('Local token payment receipts require a loopback platform origin.');
  const amount = validateBaseUnits(value.amount, 'receipt amount', true);
  if (value.status !== 'paid') throw new Error('Invalid token payment receipt status.');
  return { id, assetId: value.assetId, amount, projectId, status: 'paid' };
}

function response(
  value: unknown,
  input: SpawnTokenPaymentLookupInput,
  projectId: string,
  allowLocal: boolean,
): SpawnTokenPaymentLookup {
  if (!isRecord(value) || Object.keys(value).length !== 6 ||
      !['status', 'playerId', 'requestId', 'launchId', 'item', 'receipt'].every((key) => Object.hasOwn(value, key)))
    throw new Error('Invalid token payment lookup response.');
  if (typeof value.status !== 'string' || !PAYMENT_STATUSES.has(value.status as SpawnTokenPaymentStatus))
    throw new Error('Invalid token payment status.');
  const status = value.status as SpawnTokenPaymentStatus;
  const player = validateMemberUuid(value.playerId, 'response playerId');
  if (player !== input.playerId) throw new Error('Token payment response belongs to a different player.');
  const requestId = nullableUuid(value.requestId, 'response requestId');
  const launchId = nullableUuid(value.launchId, 'response launchId');
  const itemValue = item(value.item);
  const paymentReceipt = value.receipt === null ? null : receipt(value.receipt, projectId, allowLocal);
  if (status === 'not_found') {
    if (requestId !== null || launchId !== null || itemValue !== null || paymentReceipt !== null)
      throw new Error('A missing token payment must contain only null recovery fields.');
  } else if (launchId === null || itemValue === null) {
    throw new Error('A recorded token payment must include its launch and item.');
  }
  if (status === 'paid') {
    if (!paymentReceipt) throw new Error('A paid token payment must include a receipt.');
  } else if (paymentReceipt) {
    throw new Error('Only a paid token payment may include a receipt.');
  }
  if ('receiptId' in input) {
    if (paymentReceipt && paymentReceipt.id !== input.receiptId)
      throw new Error('Token payment receipt does not match the requested receipt.');
  } else if (status !== 'not_found' && (requestId !== input.requestId || launchId !== input.launchId)) {
    throw new Error('Token payment response does not match the requested payment.');
  }
  return {
    status,
    playerId: player,
    requestId,
    launchId,
    item: itemValue,
    receipt: paymentReceipt,
  };
}

/**
 * Server-only payment lookup. It is deliberately a single POST read: it never
 * confirms, cancels, retries or otherwise changes a payment.
 */
export function createSpawnPaymentClient(options: SpawnPaymentClientOptions) {
  if (typeof window !== 'undefined')
    throw new Error('Spawn payment credentials belong only on an authoritative server.');
  const platform = origin(options.platformOrigin);
  const project = typeof options.projectId === 'string' ? options.projectId.toLowerCase() : options.projectId;
  const credential = options.credential;
  if (!UUID.test(project) || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential))
    throw new Error('A project ID and dedicated match server credential are required.');
  const timeout = options.timeoutMs ?? 10_000;
  const transport = options.fetch ?? globalThis.fetch;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30_000 || typeof transport !== 'function')
    throw new Error('Invalid payment transport configuration.');
  const endpoint = platform + '/api/v1/registered-games/' + project + '/token-payments/lookup';
  const allowLocal = localOrigin(platform);

  async function lookup(input: SpawnTokenPaymentLookupInput): Promise<SpawnTokenPaymentLookup> {
    const checked = paymentInput(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let responseStatus: number | undefined;
    try {
      const responseValue = await transport(endpoint, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: 'Bearer ' + credential,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(checked),
      });
      responseStatus = responseValue.status;
      if (!responseValue.ok) {
        let errorBody: unknown;
        try { errorBody = await boundedJson(responseValue); } catch { /* Preserve the known status. */ }
        const details = publicErrorDetails(errorBody, responseValue, credential);
        throw new SpawnTokenPaymentError(httpCode(responseStatus), responseStatus, {
          ...details,
          requestId: 'requestId' in checked ? checked.requestId : undefined,
          receiptId: 'receiptId' in checked ? checked.receiptId : undefined,
          launchId: 'launchId' in checked ? checked.launchId : undefined,
          projectId: project,
        });
      }
      return response(
        await boundedJson(responseValue),
        checked,
        project,
        allowLocal,
      );
    } catch (error) {
      if (error instanceof SpawnTokenPaymentError) throw error;
      throw new SpawnTokenPaymentError(
        controller.signal.aborted
          ? 'REQUEST_TIMEOUT'
          : responseStatus === undefined
            ? 'TRANSPORT_ERROR'
            : 'INVALID_RESPONSE',
        responseStatus,
        {
          requestId: 'requestId' in checked ? checked.requestId : undefined,
          receiptId: 'receiptId' in checked ? checked.receiptId : undefined,
          launchId: 'launchId' in checked ? checked.launchId : undefined,
          projectId: project,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ lookup });
}

export type SpawnPaymentClient = ReturnType<typeof createSpawnPaymentClient>;
export type SpawnTokenPaymentClient = SpawnPaymentClient;

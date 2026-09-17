import {
  httpCode,
  publicErrorDetails,
  type SpawnMatchErrorCode,
  type SpawnMatchErrorDetails,
} from './match-errors.ts';
import {
  exact,
  validateBaseUnits,
  validateMemberUuid,
  validateNonnegativeInteger,
  validateSpawnTableBuyInQuote,
  validateSpawnTablePlayerBuyInQuote,
  validateSpawnTableOperation,
  validateSpawnTableStatus,
  validateUuid,
} from './table-validation.ts';
import type {
  SpawnTableBuyInInput,
  SpawnTableCashOutInput,
  SpawnTableClientOptions,
  SpawnTableCommitHandInput,
  SpawnTableCreateInput,
  SpawnTableDisconnectInput,
  SpawnTableOperationExpectation,
  SpawnTableSettleHandInput,
  SpawnTableStartHandInput,
} from './table-types.ts';

export type {
  SpawnTableAsset,
  SpawnTableBuyInInput,
  SpawnTableBuyInQuote,
  SpawnTableBuyInResult,
  SpawnTableBuyInStatus,
  SpawnTableCashOutInput,
  SpawnTableClientOptions,
  SpawnTableCommitHandInput,
  SpawnTableCreateInput,
  SpawnTableDisconnectInput,
  SpawnTableHand,
  SpawnTableHandPlayer,
  SpawnTableOperation,
  SpawnTableOperationExpectation,
  SpawnTableOperationResult,
  SpawnTablePlayerBuyInQuote,
  SpawnTablePlayerStatus,
  SpawnTablePot,
  SpawnTableSeat,
  SpawnTableSettleHandInput,
  SpawnTableStartHandInput,
  SpawnTableStatus,
  SpawnTableStatusName,
  SpawnTableTotals,
} from './table-types.ts';

function validatedTableStatus(
  value: unknown,
  tableId: string,
  projectId: string,
  platformOrigin: string,
) {
  const status = validateSpawnTableStatus(value, projectId, platformOrigin);
  if (status.tableId !== tableId) throw new Error('Table response belongs to a different table.');
  return status;
}

function validatedTableQuote(
  value: unknown,
  tableId: string,
  platformOrigin: string,
  expected: { buyInId?: string; playerId?: string; amount?: string } = {},
) {
  const quote = validateSpawnTableBuyInQuote(value, tableId, platformOrigin);
  if (expected.buyInId !== undefined && quote.buyInId !== expected.buyInId)
    throw new Error('Table buy-in quote belongs to a different buy-in.');
  if (expected.playerId !== undefined && quote.playerId !== expected.playerId)
    throw new Error('Table buy-in quote belongs to a different player.');
  if (expected.amount !== undefined && quote.amount !== expected.amount)
    throw new Error('Table buy-in quote amount differs from the requested amount.');
  return quote;
}

export type SpawnTableErrorDetails = SpawnMatchErrorDetails & {
  tableId?: string;
  operationId?: string;
};

/**
 * Safe diagnostics for table requests. A mutation with an operation ID and an
 * unknown outcome must be reconciled using its same table and operation IDs;
 * a heartbeat has no operation ID and is reconciled with a status read.
 */
export class SpawnTableRequestError extends Error {
  readonly status: number | undefined;
  readonly outcomeUnknown: boolean;
  readonly code: SpawnMatchErrorCode;
  readonly action?: string;
  readonly tableId?: string;
  readonly operationId?: string;
  readonly projectId?: string;
  readonly reason?: string;
  readonly platformCode?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    status: number | undefined,
    outcomeUnknown: boolean,
    details: SpawnTableErrorDetails = {},
  ) {
    super(message);
    this.name = 'SpawnTableRequestError';
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
    this.code = details.code ?? (status === undefined ? 'TRANSPORT_ERROR' : httpCode(status));
    this.action = details.action;
    this.tableId = details.tableId;
    this.operationId = details.operationId;
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
      tableId: this.tableId,
      operationId: this.operationId,
      projectId: this.projectId,
      reason: this.reason,
      platformCode: this.platformCode,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

function trustedOrigin(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('A trusted Spawn platform origin is required.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Use a trusted Spawn HTTPS origin, or exact loopback for local testing.');
  }
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))
  )
    throw new Error('Use a trusted Spawn HTTPS origin, or exact loopback for local testing.');
  return parsed.origin;
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

/** Server-only adapter for the registered persistent table bankroll routes. */
export function createSpawnTableClient(options: SpawnTableClientOptions) {
  if (typeof window !== 'undefined')
    throw new Error('Spawn table credentials belong only on an authoritative server.');
  const platform = trustedOrigin(options?.platformOrigin);
  const project = typeof options?.projectId === 'string' ? options.projectId.toLowerCase() : '';
  const credential = options?.credential;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(project) ||
      typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential))
    throw new Error('A project ID and dedicated table server credential are required.');
  const timeout = options?.timeoutMs ?? 10000;
  const transport = options?.fetch ?? globalThis.fetch;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000 || typeof transport !== 'function')
    throw new Error('Invalid table transport configuration.');
  const base = `${platform}/api/v1/registered-games/${project}/tables`;

  async function request<T>(
    action: string,
    path: string,
    payload: unknown | undefined,
    tableId: string | undefined,
    operationId: string | undefined,
    decode: (value: unknown) => T,
  ): Promise<T> {
    const mutation = payload !== undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let responseStatus: number | undefined;
    try {
      const response = await transport(base + path, {
        method: mutation ? 'POST' : 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${credential}`,
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
        throw new SpawnTableRequestError(
          details.reason ?? (response.status === 401 || response.status === 403
            ? 'Dedicated table server authorization is required.'
            : action === 'heartbeat'
              ? 'Spawn rejected the table heartbeat. Read the same table status before continuing.'
              : 'Spawn rejected the table request. Reconcile its status and operation journal.'),
          response.status,
          mutation && (response.status >= 500 || response.status === 408),
          { ...details, code: httpCode(response.status), action, tableId, operationId, projectId: project },
        );
      }
      return decode(await boundedJson(response));
    } catch (error) {
      if (error instanceof SpawnTableRequestError) throw error;
      throw new SpawnTableRequestError(
        mutation
          ? action === 'heartbeat'
            ? 'Table heartbeat outcome is unknown. Read the same table status before deciding whether to continue.'
            : 'Table outcome is unknown. Query the same table and operation ID before taking another action.'
          : 'Could not read table status; the response was invalid or unavailable.',
        responseStatus,
        mutation,
        {
          code: controller.signal.aborted
            ? 'REQUEST_TIMEOUT'
            : responseStatus === undefined ? 'TRANSPORT_ERROR' : 'INVALID_RESPONSE',
          action,
          tableId,
          operationId,
          projectId: project,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  function table(value: unknown): string {
    return validateUuid(value, 'tableId');
  }

  function operationInput(value: unknown, name = 'operationId'): string {
    return validateUuid(value, name);
  }

  const client = {
    async create(input: SpawnTableCreateInput) {
      if (!exact(input, ['tableId', 'operationId', 'maxSeats'])) throw new Error('Invalid table create fields.');
      const id = table(input.tableId);
      const operationId = operationInput(input.operationId);
      const maxSeats = validateNonnegativeInteger(input.maxSeats, 'maxSeats');
      if (maxSeats < 2 || maxSeats > 6) throw new Error('maxSeats must be between 2 and 6.');
      return request('create', '', { tableId: id, operationId, maxSeats }, id, operationId,
        (value) => validatedTableStatus(value, id, project, platform));
    },

    status(tableId: string) {
      const id = table(tableId);
      return request('status', `/${id}`, undefined, id, undefined,
        (value) => validatedTableStatus(value, id, project, platform));
    },

    operation(tableId: string, operationId: string, expected?: SpawnTableOperationExpectation) {
      const id = table(tableId);
      const op = operationInput(operationId);
      return request('operation', `/${id}/operations/${op}`, undefined, id, op,
        (value) => validateSpawnTableOperation(value, id, op, platform, project, expected));
    },

    async requestBuyIn(tableId: string, input: SpawnTableBuyInInput) {
      const id = table(tableId);
      if (!exact(input, ['operationId', 'buyInId', 'player', 'amount'])) throw new Error('Invalid table buy-in fields.');
      const operationId = operationInput(input.operationId);
      const buyInId = validateUuid(input.buyInId, 'buyInId');
      if (!exact(input.player, ['playerId', 'launchId'])) throw new Error('Invalid table buy-in player fields.');
      const playerId = validateMemberUuid(input.player.playerId, 'playerId');
      const launchId = validateMemberUuid(input.player.launchId, 'launchId');
      const amount = validateBaseUnits(input.amount, 'amount', true);
      return request('requestBuyIn', `/${id}/buy-ins`, {
        operationId,
        buyInId,
        player: { playerId, launchId },
        amount,
      }, id, operationId, (value) => validatedTableQuote(value, id, platform, { buyInId, playerId, amount }));
    },

    buyIn(tableId: string, buyInId: string) {
      const id = table(tableId);
      const expectedBuyInId = validateUuid(buyInId, 'buyInId');
      return request('buyIn', `/${id}/buy-ins/${expectedBuyInId}`, undefined, id, undefined,
        (value) => validatedTableQuote(value, id, platform, { buyInId: expectedBuyInId }));
    },

    async startHand(tableId: string, input: SpawnTableStartHandInput) {
      const id = table(tableId);
      if (!exact(input, ['operationId', 'handId', 'players'])) throw new Error('Invalid table hand start fields.');
      const operationId = operationInput(input.operationId);
      const handId = validateUuid(input.handId, 'handId');
      if (!Array.isArray(input.players) || input.players.length < 2 || input.players.length > 6)
        throw new Error('A hand needs between 2 and 6 players.');
      const players = input.players.map((player) => {
        if (!exact(player, ['playerId', 'seatId'])) throw new Error('Invalid hand player fields.');
        return { playerId: validateMemberUuid(player.playerId, 'playerId'), seatId: validateUuid(player.seatId, 'seatId') };
      });
      if (new Set(players.map((player) => player.playerId)).size !== players.length ||
          new Set(players.map((player) => player.seatId)).size !== players.length)
        throw new Error('Hand players and seat generations must be distinct.');
      return request('startHand', `/${id}/hands/start`, { operationId, handId, players }, id, operationId,
        (value) => validatedTableStatus(value, id, project, platform));
    },

    async commitHand(tableId: string, input: SpawnTableCommitHandInput) {
      const id = table(tableId);
      if (!exact(input, ['operationId', 'handId', 'expectedRevision', 'contributions', 'folded'])) throw new Error('Invalid table hand commit fields.');
      const operationId = operationInput(input.operationId);
      const handId = validateUuid(input.handId, 'handId');
      const expectedRevision = validateNonnegativeInteger(input.expectedRevision, 'expectedRevision');
      if (!Array.isArray(input.contributions) || input.contributions.length > 6 || !Array.isArray(input.folded) || input.folded.length > 6)
        throw new Error('Invalid table hand commit players.');
      const contributions = input.contributions.map((contribution) => {
        if (!exact(contribution, ['playerId', 'amount'])) throw new Error('Invalid hand contribution fields.');
        return { playerId: validateMemberUuid(contribution.playerId, 'playerId'), amount: validateBaseUnits(contribution.amount, 'amount') };
      });
      if (new Set(contributions.map((entry) => entry.playerId)).size !== contributions.length)
        throw new Error('Hand contributions must not repeat a player.');
      const folded = input.folded.map((playerId) => validateMemberUuid(playerId, 'playerId'));
      if (new Set(folded).size !== folded.length) throw new Error('Folded players must not repeat a player.');
      return request('commitHand', `/${id}/hands/commit`, { operationId, handId, expectedRevision, contributions, folded }, id, operationId,
        (value) => validatedTableStatus(value, id, project, platform));
    },

    async settleHand(tableId: string, input: SpawnTableSettleHandInput) {
      const id = table(tableId);
      if (!exact(input, ['operationId', 'handId', 'expectedRevision', 'pots'])) throw new Error('Invalid table hand settle fields.');
      const operationId = operationInput(input.operationId);
      const handId = validateUuid(input.handId, 'handId');
      const expectedRevision = validateNonnegativeInteger(input.expectedRevision, 'expectedRevision');
      if (!Array.isArray(input.pots) || input.pots.length > 6) throw new Error('Invalid table side pots.');
      const pots = input.pots.map((pot) => {
        if (!exact(pot, ['cap', 'winners']) || !Array.isArray(pot.winners) || pot.winners.length > 6)
          throw new Error('Invalid table side pot fields.');
        const cap = validateBaseUnits(pot.cap, 'cap', true);
        const winners = pot.winners.map((winner) => {
          if (!exact(winner, ['playerId', 'amount'])) throw new Error('Invalid side pot winner fields.');
          return { playerId: validateMemberUuid(winner.playerId, 'playerId'), amount: validateBaseUnits(winner.amount, 'amount', true) };
        });
        if (new Set(winners.map((winner) => winner.playerId)).size !== winners.length)
          throw new Error('Side pot winners must not repeat a player.');
        return { cap, winners };
      });
      return request('settleHand', `/${id}/hands/settle`, { operationId, handId, expectedRevision, pots }, id, operationId,
        (value) => validatedTableStatus(value, id, project, platform));
    },

    async cashOut(tableId: string, input: SpawnTableCashOutInput) {
      const id = table(tableId);
      if (!exact(input, ['operationId', 'playerId', 'seatId'])) throw new Error('Invalid table cash-out fields.');
      const operationId = operationInput(input.operationId);
      const playerId = validateMemberUuid(input.playerId, 'playerId');
      const seatId = validateUuid(input.seatId, 'seatId');
      return request('cashOut', `/${id}/cash-outs`, { operationId, playerId, seatId }, id, operationId,
        (value) => validatedTableStatus(value, id, project, platform));
    },

    async disconnect(tableId: string, input: SpawnTableDisconnectInput) {
      const id = table(tableId);
      if (!exact(input, ['operationId', 'playerId', 'seatId'])) throw new Error('Invalid table disconnect fields.');
      const operationId = operationInput(input.operationId);
      const playerId = validateMemberUuid(input.playerId, 'playerId');
      const seatId = validateUuid(input.seatId, 'seatId');
      return request('disconnect', `/${id}/disconnect`, { operationId, playerId, seatId }, id, operationId,
        (value) => validatedTableStatus(value, id, project, platform));
    },

    heartbeat(tableId: string) {
      const id = table(tableId);
      return request('heartbeat', `/${id}/heartbeat`, {}, id, undefined,
        (value) => validatedTableStatus(value, id, project, platform));
    },

    async close(tableId: string, input: { operationId: string }) {
      const id = table(tableId);
      if (!exact(input, ['operationId'])) throw new Error('Invalid table close fields.');
      const operationId = operationInput(input.operationId);
      return request('close', `/${id}/close`, { operationId }, id, operationId,
        (value) => validatedTableStatus(value, id, project, platform));
    },
  };
  return Object.freeze(client);
}

export type SpawnTableClient = ReturnType<typeof createSpawnTableClient>;

export {
  validateAsset as validateSpawnTableAsset,
  validateSpawnTableBuyInQuote,
  validateSpawnTablePlayerBuyInQuote,
  validateSpawnTableBuyInResult,
  validateSpawnTableOperation,
  validateSpawnTablePlayerStatus,
  validateSpawnTableStatus,
} from './table-validation.ts';

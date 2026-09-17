import { httpCode, publicErrorDetails, type SpawnMatchErrorDetails } from './match-errors.ts';
import { localBalanceOrigin, validateBalancePlayers, validateTokenBalances, type SpawnBalancePlayer, type SpawnTokenBalances } from './token-balances.ts';
import type { SpawnMatchClientOptions } from './match-server.ts';

export type SpawnTokenClientOptions = SpawnMatchClientOptions;
export class SpawnTokenBalanceError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly reason?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  constructor(code: string, status?: number, details: SpawnMatchErrorDetails = {}) {
    super(details.reason ?? 'Could not read Spawn token balances. No tokens were moved.');
    this.name = 'SpawnTokenBalanceError';
    this.code = code; this.status = status; this.reason = details.reason;
    this.requestId = details.requestId; this.retryAfterMs = details.retryAfterMs;
  }
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 65536) throw new Error('Response too large.');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await reader.cancel().catch(() => {}); }
}
/** Read-only roster snapshots. The creator's server decides which clients receive them. */
export function createSpawnTokenClient(options: SpawnTokenClientOptions) {
  if (typeof window !== 'undefined') throw new Error('Spawn server credentials must never enter a browser.');
  const url = new URL(options.platformOrigin), projectId = options.projectId?.toLowerCase(), credential = options.credential;
  if (url.origin !== options.platformOrigin || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
    throw new Error('Use a trusted Spawn HTTPS origin, or exact loopback for local testing.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(projectId) ||
      typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential))
    throw new Error('Use this game’s dedicated server credential and project ID.');
  const timeout = options.timeoutMs ?? 10000, transport = options.fetch ?? globalThis.fetch;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000 || typeof transport !== 'function')
    throw new Error('Invalid balance transport configuration.');
  return Object.freeze({
    async balances(input: readonly SpawnBalancePlayer[]): Promise<SpawnTokenBalances> {
      const players = validateBalancePlayers(input);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
      let status: number | undefined;
      try {
        const response = await transport(url.origin + '/api/v1/registered-games/' + projectId + '/token-balances', {
          method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { authorization: 'Bearer ' + credential, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ players }),
        });
        status = response.status;
        if (!response.ok) {
          let value: unknown;
          try { value = await boundedJson(response); } catch { /* Preserve the known HTTP status. */ }
          throw new SpawnTokenBalanceError(httpCode(status), status, publicErrorDetails(value, response, credential));
        }
        return validateTokenBalances(await boundedJson(response), players, projectId, localBalanceOrigin(url.origin));
      } catch (error) {
        if (error instanceof SpawnTokenBalanceError) throw error;
        throw new SpawnTokenBalanceError(controller.signal.aborted ? 'REQUEST_TIMEOUT' : status === undefined ? 'NETWORK_ERROR' : 'INVALID_RESPONSE', status);
      } finally { clearTimeout(timer); }
    },
  });
}
export type SpawnTokenClient = ReturnType<typeof createSpawnTokenClient>;

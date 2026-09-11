export const PUBLISH_REQUEST_TIMEOUT_MS = 30_000;

export type PublishConfig = {
  apiUrl: string;
  projectId: string;
  publishKey: string;
  /** Optional explicit artifact-worker origin; otherwise the SDK derives it. */
  uploadOrigin?: string;
  scopes?: readonly string[];
};

export class PublishCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishCliError';
  }
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function redact(value: string, secret?: string): string {
  if (!secret) return value;
  return value.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]').split(secret).join('[REDACTED]');
}

function originRemainder(value: string): string {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) return value;
  const authorityAndRemainder = value.slice(schemeEnd + 3);
  const remainderStart = authorityAndRemainder.search(/[/?#\\]/);
  return remainderStart < 0 ? '' : authorityAndRemainder.slice(remainderStart);
}

export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublishCliError('SPAWN_API_URL must be an absolute HTTP or HTTPS URL.');
  }
  const isLiteralLoopback = (candidate: string): boolean => {
    const schemeEnd = candidate.indexOf('://');
    if (schemeEnd < 0) return false;
    const authority = candidate.slice(schemeEnd + 3).split(/[/?#]/, 1)[0];
    if (authority.includes('@')) return false;
    if (authority.startsWith('[')) {
      const closingBracket = authority.indexOf(']');
      return closingBracket >= 0 && authority.slice(0, closingBracket + 1) === '[::1]';
    }
    const portSeparator = authority.lastIndexOf(':');
    const host = portSeparator >= 0 && /^[0-9]*$/.test(authority.slice(portSeparator + 1))
      ? authority.slice(0, portSeparator)
      : authority;
    return host.toLowerCase() === 'localhost' || host === '127.0.0.1';
  };
  const isLoopback = isLiteralLoopback(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new PublishCliError('SPAWN_API_URL must be an absolute HTTP or HTTPS origin.');
  }
  if (value !== value.trim() || originRemainder(value) !== '' && originRemainder(value) !== '/' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new PublishCliError('SPAWN_API_URL must be an origin without credentials, path, query or fragment.');
  }
  if (url.protocol === 'http:' && !isLoopback) {
    throw new PublishCliError('SPAWN_API_URL must use HTTPS except for localhost, 127.0.0.1 or [::1].');
  }
  return url.origin;
}

export const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validatePublishConfig(config: PublishConfig): PublishConfig {
  if (!isRecord(config)) throw new PublishCliError('Publishing configuration is invalid.');
  if (typeof config.apiUrl !== 'string' || config.apiUrl.trim() === '') {
    throw new PublishCliError('SPAWN_API_URL must be an absolute HTTP or HTTPS origin.');
  }
  const apiUrl = normalizeApiUrl(config.apiUrl.trim());
  const uploadOrigin = config.uploadOrigin === undefined
    ? undefined
    : normalizeApiUrl(typeof config.uploadOrigin === 'string' ? config.uploadOrigin.trim() : '');
  const projectId = typeof config.projectId === 'string' ? config.projectId.trim() : '';
  const publishKey = typeof config.publishKey === 'string' ? config.publishKey.trim() : '';
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new PublishCliError('SPAWN_PROJECT_ID must be a UUID.');
  }
  if (!publishKey) throw new PublishCliError('SPAWN_PUBLISH_KEY is required.');
  return {
    apiUrl,
    projectId,
    publishKey,
    ...(uploadOrigin ? { uploadOrigin } : {}),
    ...(config.scopes ? { scopes: [...config.scopes] } : {}),
  };
}

async function responseBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > 1_048_576) {
        await reader.cancel();
        throw new PublishCliError('Spawn response exceeds the size limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function responseError(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    if (typeof body.error === 'string') return body.error;
    if (typeof body.message === 'string') return body.message;
  }
  return fallback;
}

export async function requestJson(
  config: PublishConfig,
  url: string,
  init: RequestInit,
  fetchImplementation: FetchLike,
  listing = false,
): Promise<Record<string, unknown>> {
  if (typeof fetchImplementation !== 'function') {
    throw new PublishCliError('The publishing CLI requires a fetch implementation.');
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: { response: Response; body: unknown };
  try {
    const operation = (async () => {
      const response = await fetchImplementation(url, {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.redirected) {
        throw new PublishCliError('Spawn publish request returned an unexpected redirect.');
      }
      return { response, body: await responseBody(response) };
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PublishCliError('Spawn publish request timed out.'));
      }, PUBLISH_REQUEST_TIMEOUT_MS);
    });
    result = await Promise.race([operation, timeout]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PublishCliError('Spawn publish request timed out.');
    }
    const message = error instanceof Error ? error.message : 'Network request failed.';
    throw new PublishCliError(redact(message, config.publishKey));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const { response, body } = result;
  if (listing && !response.ok) {
    const message = response.status === 409 ? 'The listing version changed. Get the listing again and review your edit before retrying.'
      : response.status === 404 || response.status === 501 ? 'Listing editing is not available for this project or platform yet.'
      : response.status === 401 || response.status === 403 ? 'Listing access was denied. Check your downloaded credential file and its scopes.'
      : `Spawn listing request failed with HTTP ${response.status}.`;
    throw new PublishCliError(message);
  }
  if (!response.ok) {
    throw new PublishCliError(
      redact(responseError(body, `Spawn publish request failed with HTTP ${response.status}.`), config.publishKey),
    );
  }
  if (!isRecord(body)) throw new PublishCliError('Spawn publish returned an invalid release response.');
  return body;
}

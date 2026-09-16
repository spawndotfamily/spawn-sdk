/** Diagnostics contain public API fields only, never response bodies or credentials. */
export type SpawnMatchErrorCode =
  | 'HTTP_UNAUTHORIZED' | 'HTTP_FORBIDDEN' | 'HTTP_NOT_FOUND' | 'HTTP_CONFLICT'
  | 'HTTP_TIMEOUT' | 'HTTP_RATE_LIMITED' | 'HTTP_UNAVAILABLE' | 'HTTP_REJECTED'
  | 'TRANSPORT_ERROR' | 'REQUEST_TIMEOUT' | 'INVALID_RESPONSE';
export type SpawnMatchErrorDetails = {
  code?: SpawnMatchErrorCode;
  action?: string;
  matchId?: string;
  projectId?: string;
  reason?: string;
  platformCode?: string;
  requestId?: string;
  retryAfterMs?: number;
};
export class SpawnMatchRequestError extends Error {
  readonly status: number | undefined;
  readonly outcomeUnknown: boolean;
  readonly code: SpawnMatchErrorCode;
  readonly action?: string;
  readonly matchId?: string;
  readonly projectId?: string;
  readonly reason?: string;
  readonly platformCode?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number | undefined, outcomeUnknown: boolean, details: SpawnMatchErrorDetails = {}) {
    super(message);
    this.name = 'SpawnMatchRequestError';
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
    this.code = details.code ?? (status === undefined ? 'TRANSPORT_ERROR' : httpCode(status));
    this.action = details.action;
    this.matchId = details.matchId;
    this.projectId = details.projectId;
    this.reason = details.reason;
    this.platformCode = details.platformCode;
    this.requestId = details.requestId;
    this.retryAfterMs = details.retryAfterMs;
  }
  /** Suitable for a private server journal; do not forward diagnostics to public chat. */
  toJSON() {
    return { name: this.name, message: this.message, status: this.status, code: this.code,
      outcomeUnknown: this.outcomeUnknown, action: this.action, matchId: this.matchId,
      projectId: this.projectId, reason: this.reason, platformCode: this.platformCode,
      requestId: this.requestId, retryAfterMs: this.retryAfterMs };
  }
}
export function httpCode(status: number): SpawnMatchErrorCode {
  switch (status) {
    case 401: return 'HTTP_UNAUTHORIZED';
    case 403: return 'HTTP_FORBIDDEN';
    case 404: return 'HTTP_NOT_FOUND';
    case 409: return 'HTTP_CONFLICT';
    case 408: return 'HTTP_TIMEOUT';
    case 429: return 'HTTP_RATE_LIMITED';
    default: return status >= 500 ? 'HTTP_UNAVAILABLE' : 'HTTP_REJECTED';
  }
}
function safeText(value: unknown, max: number, credential: string): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/u.test(value) ||
      value.includes(credential) || /\bBearer\s/i.test(value)) return undefined;
  return value.trim();
}
export function publicErrorDetails(value: unknown, response: Response, credential: string): SpawnMatchErrorDetails {
  const data = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const reason = safeText(data.error, 512, credential);
  const candidateCode = safeText(data.code, 64, credential);
  const candidateId = safeText(data.requestId ?? response.headers.get('x-request-id'), 128, credential);
  const delay = response.headers.get('retry-after');
  return {
    reason,
    platformCode: candidateCode && /^[A-Z][A-Z0-9_]*$/.test(candidateCode) ? candidateCode : undefined,
    requestId: candidateId && /^[a-zA-Z0-9._:-]+$/.test(candidateId) ? candidateId : undefined,
    retryAfterMs: delay && /^\d{1,5}$/.test(delay) ? Math.min(Number(delay), 3600) * 1000 : undefined,
  };
}

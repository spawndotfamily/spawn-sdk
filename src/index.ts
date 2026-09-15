import { leaderboardQuery, jsonSave, type LeaderboardQuery, type LeaderboardPage, type SaveIndex } from './game-data.ts';
export type { LeaderboardQuery, LeaderboardPage, LeaderboardEntry, LeaderboardPolicy, SaveIndex } from './game-data.ts';
export type Save<T> = { value: T; version: number; updatedAt: string };
/** @deprecated Reviewed first-party same-origin prototype. Creators should use createSpawnGameClient in isolated previews. Never forward its cookies to another origin. */
export function createSpawnClient(gameId: string) {
  if (gameId !== 'rob-the-rich')
    throw new Error('Game is not enabled for this SDK prototype.');
  async function request<T>(key: string, init?: RequestInit): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key))
      throw new Error('Invalid save key.');
    const response = await fetch('/api/v1/game-storage/' + gameId + '/' + key, {
      credentials: 'same-origin',
      ...init,
    });
    const result = await response.json();
    if (!response.ok) {
      const message =
        typeof result === 'object' &&
        result !== null &&
        'error' in result &&
        typeof result.error === 'string'
          ? result.error
          : 'Spawn request failed.';
      throw new Error(message);
    }
    return result as T;
  }
  return {
    load: <T>(key: string) => request<Save<T> | null>(key),
    save: <T>(key: string, value: T, expectedVersion: number) =>
      request<Save<T>>(key, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, expectedVersion }),
      }),
  };
}

export type SpawnCapabilities = { play: boolean; submitScores: boolean; cloudSaves: boolean; payments: boolean; rewards: boolean };
export type SpawnGameIdentity = {
  /** True for a server-issued guest identity. An ID is not an authentication secret. */
  isGuest?: boolean;
  capabilities?: SpawnCapabilities;
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  environment: 'sandbox';
};

export type SpawnScoreSubmission = {
  id: string;
  verification: 'unverified';
};

export type SpawnTestPayment = {
  id: string;
  intentId: string;
  amount: 10;
  asset: 'TEST';
  environment: 'sandbox';
  status: 'paid';
};

/** Receipt for a project-configured testnet token entry, after the Spawn confirmation flow. */
export type SpawnTokenPaymentReceipt = {
  id: string;
  assetId: string;
  /** Exact ERC-20 base units. Never convert this to a JavaScript number. */
  amount: string;
  projectId: string;
  status: 'paid';
};
export type SpawnTokenPaymentOptions = {
  /** Required human-readable decimal amount in the listing's configured token. */
  amount: string;
  /** Optional 1–80 character item label; the listing still selects the token asset. */
  item?: string;
  /** Stable UUID for retrying the same payment after an uncertain result. */
  requestId?: string;
};

export type SpawnGameClient = {
  identity(): Promise<SpawnGameIdentity>;
  getLeaderboard(query?: LeaderboardQuery): Promise<LeaderboardPage>;
  listSaves(): Promise<SaveIndex>;
  remove(key: string, expectedVersion: number): Promise<{ deleted: true }>;
  load<T>(keyOrRequest: string | { key: string }): Promise<Save<T> | null>;
  save<T>(keyOrRequest: string | { key: string; value: T; expectedVersion: number }, value?: T, expectedVersion?: number): Promise<Save<T>>;
  submitScore(scoreOrRequest: number | { score: number; details?: Record<string, unknown>; submissionId?: string }, details?: Record<string, unknown>): Promise<SpawnScoreSubmission>;
  requestPayment(productOrRequest: 'entry' | { productId: 'entry' }): Promise<SpawnTestPayment | SpawnTokenPaymentReceipt>;
  requestTokenPayment(options: SpawnTokenPaymentOptions): Promise<SpawnTokenPaymentReceipt>;
  dispose(): void;
};

export const MAX_GAME_BRIDGE_OUTSTANDING = 20;
const GAME_BRIDGE_VERSION = 1;
const GAME_BRIDGE_TIMEOUT_MS = 15_000;
const GAME_BRIDGE_PAYMENT_TIMEOUT_MS = 300_000;
const TOKEN_PAYMENT_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const TOKEN_PAYMENT_ITEM_MAX_LENGTH = 80;
const TOKEN_RECEIPT_VERSION = 1;
const PUBLIC_PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_TOKEN_PATTERN = /^\/build\/([A-Za-z0-9_-]{43})\//;
const BRIDGE_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PortMessageEvent = { data: unknown };
type PortMessageListener = (event: PortMessageEvent) => void;

type MessagePortLike = {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: PortMessageListener): void;
  removeEventListener(type: string, listener: PortMessageListener): void;
  start?(): void;
  close(): void;
};

type BridgeMessageEvent = {
  source: unknown;
  origin: string;
  data: unknown;
  ports?: readonly unknown[];
};
type WindowMessageListener = (event: BridgeMessageEvent) => void;

type BridgeWindow = {
  parent: {
    postMessage(message: unknown, targetOrigin: string): void;
  };
  location?: {
    pathname?: unknown;
  };
  addEventListener(type: string, listener: WindowMessageListener): void;
  removeEventListener(type: string, listener: WindowMessageListener): void;
};

type PendingBridgeRequest = {
  message: Record<string, unknown>;
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer?: ReturnType<typeof setTimeout>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validSaveKey(key: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(key);
}

function normalizePlatformOrigin(platformOrigin: string): string {
  if (typeof platformOrigin !== 'string' || platformOrigin.trim() === '') {
    throw new Error('platformOrigin is required for the embedded Spawn game client.');
  }
  let parsed: URL;
  try {
    parsed = new URL(platformOrigin);
  } catch {
    throw new Error('platformOrigin must be an absolute HTTP or HTTPS origin.');
  }
  const schemeEnd = platformOrigin.indexOf('://');
  const authorityAndRemainder = schemeEnd < 0 ? platformOrigin : platformOrigin.slice(schemeEnd + 3);
  const remainderStart = authorityAndRemainder.search(/[/?#\\]/);
  const remainder = remainderStart < 0 ? '' : authorityAndRemainder.slice(remainderStart);
  const authority = remainderStart < 0 ? authorityAndRemainder : authorityAndRemainder.slice(0, remainderStart);
  const isLiteralLoopback = !authority.includes('@') && (
    authority.toLowerCase() === 'localhost' ||
    authority.toLowerCase().startsWith('localhost:') && /^localhost:\d+$/i.test(authority) ||
    authority === '127.0.0.1' ||
    /^127\.0\.0\.1:\d+$/.test(authority) ||
    authority === '[::1]' ||
    /^\[::1\]:\d+$/.test(authority)
  );
  if (!['http:', 'https:'].includes(parsed.protocol) || platformOrigin !== platformOrigin.trim() || (remainder !== '' && remainder !== '/') || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || platformOrigin.includes('?') || platformOrigin.includes('#') || parsed.protocol === 'http:' && !isLiteralLoopback) {
    throw new Error('platformOrigin must be an absolute HTTP or HTTPS origin without a path, credentials, query or fragment.');
  }
  return parsed.origin;
}

function embeddedWindow(): BridgeWindow {
  const currentWindow = (globalThis as unknown as { window?: BridgeWindow }).window;
  if (!currentWindow || (currentWindow.parent as unknown) === (currentWindow as unknown)) {
    throw new Error('createSpawnGameClient requires an embedded game iframe.');
  }
  return currentWindow;
}

function launchedDocumentToken(gameWindow: BridgeWindow): string {
  const pathname = gameWindow.location?.pathname;
  const match = typeof pathname === 'string' ? DOCUMENT_TOKEN_PATTERN.exec(pathname) : null;
  if (!match) {
    throw new Error('createSpawnGameClient requires a launched /build/<document-token>/ game document.');
  }
  return match[1];
}

function bridgeRequestId(): string {
  const cryptoValue = (globalThis as unknown as {
    crypto?: { randomUUID?: () => string };
  }).crypto;
  if (!cryptoValue || typeof cryptoValue.randomUUID !== 'function') {
    throw new Error('The embedded Spawn game client requires crypto.randomUUID.');
  }
  return cryptoValue.randomUUID();
}

function safePayment(value: unknown): value is SpawnTestPayment {
  return isObject(value) &&
    exactObjectKeys(value, ['id', 'intentId', 'amount', 'asset', 'environment', 'status']) &&
    typeof value.id === 'string' &&
    typeof value.intentId === 'string' &&
    value.amount === 10 &&
    value.asset === 'TEST' &&
    value.environment === 'sandbox' &&
    value.status === 'paid';
}

function safeTokenPayment(value: unknown, platformOrigin: string): value is SpawnTokenPaymentReceipt {
  if (!isObject(value) || !exactObjectKeys(value, ['id', 'assetId', 'amount', 'projectId', 'status'])) return false;
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 128 || /[\u0000-\u001f\u007f]/.test(value.id)) return false;
  if (typeof value.assetId !== 'string' || !/^erc20:(?:46630|31337):0x[a-f0-9]{40}$/.test(value.assetId)) return false;
  if (value.assetId.startsWith('erc20:31337:')) {
    const hostname = new URL(platformOrigin).hostname.toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return false;
  }
  if (typeof value.amount !== 'string' || !/^[1-9][0-9]*$/.test(value.amount) || value.amount.length > 78) return false;
  if (BigInt(value.amount) > (1n << 256n) - 1n) return false;
  return typeof value.projectId === 'string' &&
    PUBLIC_PROFILE_ID_PATTERN.test(value.projectId) &&
    value.status === 'paid';
}

function exactObjectKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function validAvatarUrl(value: unknown, targetOrigin: string): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    const avatarPathPrefix = '/api/v1/avatars/';
    const profileId = parsed.pathname.startsWith(avatarPathPrefix)
      ? parsed.pathname.slice(avatarPathPrefix.length)
      : '';
    return ['http:', 'https:'].includes(parsed.protocol) &&
      parsed.origin === targetOrigin &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      PUBLIC_PROFILE_ID_PATTERN.test(profileId) &&
      (parsed.search === '' || /^\?v=[0-9a-f]{16}$/.test(parsed.search));
  } catch {
    return false;
  }
}

function normalizeIdentity(value: unknown, targetOrigin: string): SpawnGameIdentity {
  if (!isObject(value) || !exactObjectKeys(value, ['id', 'handle', 'displayName', 'environment'], ['avatarUrl', 'isGuest', 'capabilities'])) {
    throw new Error('Spawn bridge returned an invalid identity.');
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.handle !== 'string' ||
    typeof value.displayName !== 'string' ||
    value.environment !== 'sandbox'
  ) {
    throw new Error('Spawn bridge returned an invalid identity.');
  }
  if (value.avatarUrl !== undefined && value.avatarUrl !== null && !validAvatarUrl(value.avatarUrl, targetOrigin)) {
    throw new Error('Spawn bridge returned an invalid avatar URL.');
  }
  const guestId = /^guest_[a-f0-9]{64}$/.test(value.id);
  if (value.isGuest !== undefined && (typeof value.isGuest !== 'boolean' || value.isGuest !== guestId)) throw new Error('Spawn bridge returned an invalid guest identity.');
  if (value.capabilities !== undefined) {
    const caps = value.capabilities;
    if (!isObject(caps) || !exactObjectKeys(caps, ['play', 'submitScores', 'cloudSaves', 'payments', 'rewards']) || Object.values(caps).some(v => typeof v !== 'boolean') || guestId && Object.entries(caps).some(([key, v]) => key !== 'play' && v !== false)) throw new Error('Spawn bridge returned invalid capabilities.');
  }
  return {
    ...(value.isGuest !== undefined || guestId ? { isGuest: guestId } : {}),
    ...(value.capabilities !== undefined ? { capabilities: { ...value.capabilities as SpawnCapabilities } } : guestId ? { capabilities: {play:true, submitScores:false, cloudSaves:false, payments:false, rewards:false} } : {}),
    id: value.id,
    handle: value.handle,
    displayName: value.displayName,
    avatarUrl: value.avatarUrl ?? null,
    environment: 'sandbox',
  };
}

function isMessagePort(value: unknown): value is MessagePortLike {
  return isObject(value) &&
    typeof value.postMessage === 'function' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function' &&
    typeof value.close === 'function';
}

function closeMessagePort(port: MessagePortLike | undefined): void {
  if (!port) return;
  try {
    port.close();
  } catch {
    // A disconnected MessagePort is already unusable.
  }
}

/** Published and local launchers inject only this public origin, never identity or credentials. */
export function createSpawnGameClient(options: { platformOrigin?: string } = {}): SpawnGameClient {
  const injected = (globalThis as unknown as { __SPAWN_LAUNCH__?: { platformOrigin?: unknown } }).__SPAWN_LAUNCH__;
  const platformOrigin = options.platformOrigin ?? (typeof injected?.platformOrigin === 'string' ? injected.platformOrigin : '');
  const targetOrigin = normalizePlatformOrigin(platformOrigin);
  const gameWindow = embeddedWindow();
  const documentToken = launchedDocumentToken(gameWindow);
  let disposed = false;
  let handshakeAccepted = false;
  let connectedPort: MessagePortLike | undefined;
  const pending = new Map<string, PendingBridgeRequest>();

  const removePending = (id: string): PendingBridgeRequest | undefined => {
    const request = pending.get(id);
    if (!request) return undefined;
    pending.delete(id);
    if (request.timer !== undefined) clearTimeout(request.timer);
    return request;
  };

  const onPortMessage: PortMessageListener = (event) => {
    const data = event.data;
    if (isObject(data) && data.type === 'spawn:ready') {
      if (
        connectedPort &&
        data.version === GAME_BRIDGE_VERSION &&
        exactObjectKeys(data, ['type', 'version', 'nonce']) &&
        typeof data.nonce === 'string' &&
        BRIDGE_NONCE_PATTERN.test(data.nonce)
      ) {
        try {
          connectedPort.postMessage({
            type: 'spawn:ready-ack',
            version: GAME_BRIDGE_VERSION,
            nonce: data.nonce,
          });
        } catch {
          // The parent may have invalidated this port during navigation.
        }
      }
      return;
    }
    if (!isObject(data) || data.type !== 'spawn:response' || data.version !== GAME_BRIDGE_VERSION || typeof data.id !== 'string') return;
    const request = pending.get(data.id);
    if (!request) return;
    if (data.ok !== true && data.ok !== false) return;
    if (data.ok === true) {
      if (!exactObjectKeys(data, ['type', 'version', 'id', 'ok', 'value'])) return;
    } else if (!exactObjectKeys(data, ['type', 'version', 'id', 'ok', 'error']) || typeof data.error !== 'string') {
      return;
    }
    const completed = removePending(data.id);
    if (!completed) return;
    if (data.ok === true) completed.resolve(data.value);
    else if (typeof data.error === 'string') completed.reject(new Error(data.error));
    else completed.reject(new Error('Spawn bridge returned an invalid error.'));
  };

  const sendPending = (id: string, request: PendingBridgeRequest): void => {
    if (!connectedPort || pending.get(id) !== request) return;
    try {
      connectedPort.postMessage(request.message);
    } catch (error) {
      const failed = removePending(id);
      if (failed) failed.reject(error instanceof Error ? error : new Error('Spawn bridge request failed.'));
    }
  };

  const flushQueued = (): void => {
    if (!connectedPort) return;
    for (const [id, request] of pending) sendPending(id, request);
  };

  const onWindowMessage: WindowMessageListener = (event) => {
    if (event.source !== gameWindow.parent || event.origin !== targetOrigin) return;
    const data = event.data;
    if (!isObject(data) || data.type !== 'spawn:connected' || data.version !== GAME_BRIDGE_VERSION || !exactObjectKeys(data, ['type', 'version'])) return;
    if (handshakeAccepted) {
      const candidate = event.ports?.length === 1 && isMessagePort(event.ports[0])
        ? event.ports[0]
        : undefined;
      if (candidate && candidate !== connectedPort) closeMessagePort(candidate);
      return;
    }
    if (event.ports?.length !== 1 || !isMessagePort(event.ports[0])) return;

    const port = event.ports[0];
    handshakeAccepted = true;
    connectedPort = port;
    try {
      port.addEventListener('message', onPortMessage);
      port.start?.();
    } catch (error) {
      connectedPort = undefined;
      closeMessagePort(port);
      for (const id of pending.keys()) {
        const failed = removePending(id);
        if (failed) failed.reject(error instanceof Error ? error : new Error('Spawn bridge connection failed.'));
      }
      return;
    }
    flushQueued();
  };

  gameWindow.addEventListener('message', onWindowMessage);
  try {
    gameWindow.parent.postMessage({ type: 'spawn:connect', version: GAME_BRIDGE_VERSION, documentToken }, targetOrigin);
  } catch (error) {
    gameWindow.removeEventListener('message', onWindowMessage);
    throw error instanceof Error ? error : new Error('Spawn bridge connection failed.');
  }

  function request<T>(method: string, payload: unknown, timeoutMs: number): Promise<T> {
    if (disposed) return Promise.reject(new Error('Spawn game client is disposed.'));
    if (pending.size >= MAX_GAME_BRIDGE_OUTSTANDING) {
      return Promise.reject(new Error(`Spawn game client allows at most ${MAX_GAME_BRIDGE_OUTSTANDING} outstanding requests.`));
    }

    const id = bridgeRequestId();
    const requestState: PendingBridgeRequest = {
      message: {
        type: 'spawn:request',
        version: GAME_BRIDGE_VERSION,
        id,
        method,
        payload,
      },
      resolve: () => undefined,
      reject: () => undefined,
    };
    const promise = new Promise<T>((resolve, reject) => {
      requestState.resolve = resolve;
      requestState.reject = reject;
    });
    pending.set(id, requestState);
    requestState.timer = setTimeout(() => {
      const current = pending.get(id);
      if (!current) return;
      pending.delete(id);
      if (current.timer !== undefined) clearTimeout(current.timer);
      current.reject(new Error('Spawn bridge request timed out.'));
    }, timeoutMs);

    sendPending(id, requestState);
    return promise;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    gameWindow.removeEventListener('message', onWindowMessage);
    if (connectedPort) {
      connectedPort.removeEventListener('message', onPortMessage);
      closeMessagePort(connectedPort);
      connectedPort = undefined;
    }
    for (const request of pending.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer);
      request.reject(new Error('Spawn game client is disposed.'));
    }
    pending.clear();
  }

  return {
    identity: () => request<unknown>('identity', { identityVersion: 2 }, GAME_BRIDGE_TIMEOUT_MS).then((value) => normalizeIdentity(value, targetOrigin)),
    load: <T>(keyOrRequest: string | { key: string }) => {
      const key = typeof keyOrRequest === 'string'
        ? keyOrRequest
        : isObject(keyOrRequest) && typeof keyOrRequest.key === 'string' && exactObjectKeys(keyOrRequest, ['key'])
          ? keyOrRequest.key
          : '';
      if (!validSaveKey(key)) return Promise.reject(new Error('Invalid save key.'));
      return request<Save<T> | null>('load', { key }, GAME_BRIDGE_TIMEOUT_MS);
    },
    save: <T>(keyOrRequest: string | { key: string; value: T; expectedVersion: number }, value?: T, expectedVersion?: number) => {
      const requestObject = isObject(keyOrRequest) && exactObjectKeys(keyOrRequest, ['key', 'value', 'expectedVersion'])
        ? keyOrRequest as { key: string; value: T; expectedVersion: number }
        : undefined;
      const key = typeof keyOrRequest === 'string' ? keyOrRequest : requestObject?.key ?? '';
      const actualValue = typeof keyOrRequest === 'string' ? value : requestObject?.value;
      const actualVersion = typeof keyOrRequest === 'string' ? expectedVersion : requestObject?.expectedVersion;
      if (!validSaveKey(key)) return Promise.reject(new Error('Invalid save key.'));
      if (typeof actualVersion !== 'number' || !Number.isInteger(actualVersion) || actualVersion < 0) {
        return Promise.reject(new Error('Invalid save version.'));
      }
      try {
        if (key.startsWith('_spawn_')) throw new Error('Reserved platform record.');
        return request<Save<T>>('save', { key, value: jsonSave(actualValue), expectedVersion: actualVersion }, GAME_BRIDGE_TIMEOUT_MS);
      } catch (error) { return Promise.reject(error); }
    },
    getLeaderboard: (query?: LeaderboardQuery) => {
      try { return request<LeaderboardPage>('getLeaderboard', leaderboardQuery(query), GAME_BRIDGE_TIMEOUT_MS); }
      catch (error) { return Promise.reject(error); }
    },
    listSaves: () => request<SaveIndex>('listSaves', {}, GAME_BRIDGE_TIMEOUT_MS),
    remove: (key: string, expectedVersion: number) => {
      if (!validSaveKey(key) || key.startsWith('_spawn_') || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return Promise.reject(new Error('Provide a valid save key and current version.'));
      return request<{ deleted: true }>('remove', { key, expectedVersion }, GAME_BRIDGE_TIMEOUT_MS);
    },
    submitScore: (scoreOrRequest: number | { score: number; details?: Record<string, unknown>; submissionId?: string }, details?: Record<string, unknown>) => {
      const requestObject = isObject(scoreOrRequest) && exactObjectKeys(scoreOrRequest, ['score'], ['details', 'submissionId'])
        ? scoreOrRequest as { score: number; details?: Record<string, unknown>; submissionId?: string }
        : undefined;
      const score = typeof scoreOrRequest === 'number' ? scoreOrRequest : requestObject?.score;
      const actualDetails = typeof scoreOrRequest === 'number' ? details : requestObject?.details;
      if (typeof score !== 'number' || !Number.isSafeInteger(score) || score < 0 || score > 1_000_000_000) {
        return Promise.reject(new Error('Score must be a nonnegative integer up to 1,000,000,000.'));
      }
      if (actualDetails !== undefined && (!isObject(actualDetails) || Array.isArray(actualDetails))) {
        return Promise.reject(new Error('Score details must be an object.'));
      }
      const submissionId = requestObject?.submissionId;
      if (submissionId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(submissionId)) return Promise.reject(new Error('submissionId must be a UUID.'));
      const payload = { score, ...(actualDetails === undefined ? {} : { details: actualDetails }), ...(submissionId === undefined ? {} : { submissionId }) };
      return request<SpawnScoreSubmission>('submitScore', payload, GAME_BRIDGE_TIMEOUT_MS);
    },
    requestPayment: (productOrRequest: 'entry' | { productId: 'entry' }) => {
      const productId = productOrRequest === 'entry' ||
        (isObject(productOrRequest) && productOrRequest.productId === 'entry' && exactObjectKeys(productOrRequest, ['productId']))
        ? 'entry'
        : undefined;
      if (!productId) return Promise.reject(new Error('Only the entry payment is available.'));
      return request<unknown>('requestPayment', { productId, tokenReceiptVersion: TOKEN_RECEIPT_VERSION }, GAME_BRIDGE_PAYMENT_TIMEOUT_MS).then((value) => {
        if (!safePayment(value) && !safeTokenPayment(value, targetOrigin)) throw new Error('Spawn bridge returned an invalid payment receipt.');
        return value;
      });
    },
    requestTokenPayment: (options: SpawnTokenPaymentOptions) => {
      const input = options as unknown;
      if (!isObject(input) || Array.isArray(input) || !exactObjectKeys(input, ['amount'], ['item', 'requestId'])) return Promise.reject(new Error('Token payment requires an explicit amount; only an optional item label and request ID may be supplied.'));
      let payload: { amount: string; item?: string; requestId: string };
      try {
        const amount = input.amount;
        const item = input.item;
        const requestId = input.requestId;
        if (typeof amount !== 'string' || amount.length > 512 || !TOKEN_PAYMENT_AMOUNT_PATTERN.test(amount)) throw new Error('Token payment amount must be a decimal string without a sign or exponent.');
        const [whole, fraction = ''] = amount.split('.');
        if (BigInt(whole) === 0n && !/[1-9]/.test(fraction)) throw new Error('Token payment amount must be greater than zero.');
        if (item !== undefined && (typeof item !== 'string' || item.trim() === '' || item.length > TOKEN_PAYMENT_ITEM_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(item))) throw new Error(`Token payment item label must contain 1–${TOKEN_PAYMENT_ITEM_MAX_LENGTH} printable characters.`);
        if (requestId !== undefined && (typeof requestId !== 'string' || !BRIDGE_NONCE_PATTERN.test(requestId))) throw new Error('Token payment requestId must be a UUID.');
        payload = {
          amount,
          ...(item === undefined ? {} : { item: item as string }),
          requestId: requestId === undefined ? bridgeRequestId() : requestId,
        };
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('Invalid token payment request.'));
      }
      return request<unknown>('requestTokenPayment', payload, GAME_BRIDGE_PAYMENT_TIMEOUT_MS).then((value) => {
        if (!safeTokenPayment(value, targetOrigin)) throw new Error('Spawn bridge returned an invalid token payment receipt.');
        return value;
      });
    },
    dispose,
  };
}

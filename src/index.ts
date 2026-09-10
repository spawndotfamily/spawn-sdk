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

export type SpawnGameIdentity = {
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

export type SpawnGameClient = {
  identity(): Promise<SpawnGameIdentity>;
  load<T>(keyOrRequest: string | { key: string }): Promise<Save<T> | null>;
  save<T>(keyOrRequest: string | { key: string; value: T; expectedVersion: number }, value?: T, expectedVersion?: number): Promise<Save<T>>;
  submitScore(scoreOrRequest: number | { score: number; details?: Record<string, unknown> }, details?: Record<string, unknown>): Promise<SpawnScoreSubmission>;
  requestPayment(productOrRequest: 'entry' | { productId: 'entry' }): Promise<SpawnTestPayment>;
  dispose(): void;
};

export const MAX_GAME_BRIDGE_OUTSTANDING = 20;
const GAME_BRIDGE_VERSION = 1;
const GAME_BRIDGE_TIMEOUT_MS = 15_000;
const GAME_BRIDGE_PAYMENT_TIMEOUT_MS = 300_000;
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
  if (!isObject(value) || !exactObjectKeys(value, ['id', 'handle', 'displayName', 'environment'], ['avatarUrl'])) {
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
  return {
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
    identity: () => request<unknown>('identity', {}, GAME_BRIDGE_TIMEOUT_MS).then((value) => normalizeIdentity(value, targetOrigin)),
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
      return request<Save<T>>('save', { key, value: actualValue, expectedVersion: actualVersion }, GAME_BRIDGE_TIMEOUT_MS);
    },
    submitScore: (scoreOrRequest: number | { score: number; details?: Record<string, unknown> }, details?: Record<string, unknown>) => {
      const requestObject = isObject(scoreOrRequest) && exactObjectKeys(scoreOrRequest, ['score'], ['details'])
        ? scoreOrRequest as { score: number; details?: Record<string, unknown> }
        : undefined;
      const score = typeof scoreOrRequest === 'number' ? scoreOrRequest : requestObject?.score;
      const actualDetails = typeof scoreOrRequest === 'number' ? details : requestObject?.details;
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        return Promise.reject(new Error('Score must be a finite number.'));
      }
      if (actualDetails !== undefined && (!isObject(actualDetails) || Array.isArray(actualDetails))) {
        return Promise.reject(new Error('Score details must be an object.'));
      }
      const payload = actualDetails === undefined ? { score } : { score, details: actualDetails };
      return request<SpawnScoreSubmission>('submitScore', payload, GAME_BRIDGE_TIMEOUT_MS);
    },
    requestPayment: (productOrRequest: 'entry' | { productId: 'entry' }) => {
      const productId = productOrRequest === 'entry' ||
        (isObject(productOrRequest) && productOrRequest.productId === 'entry' && exactObjectKeys(productOrRequest, ['productId']))
        ? 'entry'
        : undefined;
      if (!productId) return Promise.reject(new Error('Only the entry test product is available.'));
      return request<unknown>('requestPayment', { productId }, GAME_BRIDGE_PAYMENT_TIMEOUT_MS).then((value) => {
        if (!safePayment(value)) throw new Error('Spawn bridge returned an invalid test payment.');
        return value;
      });
    },
    dispose,
  };
}

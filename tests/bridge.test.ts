import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../src/index.ts';

const PLATFORM_ORIGIN = 'https://spawn.example.test';
const DOCUMENT_TOKEN = 'a'.repeat(43);

type MessageEventLike = {
  source: unknown;
  origin: string;
  data: unknown;
  ports?: FakePort[];
};

type MessageListener = (event: MessageEventLike) => void;

type PortMessageListener = (event: { data: unknown }) => void;

type FakePort = {
  calls: Record<string, unknown>[];
  closed: boolean;
  postMessage(message: Record<string, unknown>): void;
  addEventListener(type: string, listener: PortMessageListener): void;
  removeEventListener(type: string, listener: PortMessageListener): void;
  start(): void;
  close(): void;
  listenerCount(): number;
  emit(data: unknown): void;
};

function makePort(): FakePort {
  const listeners = new Set<PortMessageListener>();
  const calls: Record<string, unknown>[] = [];
  let closed = false;
  return {
    calls,
    get closed() {
      return closed;
    },
    postMessage(message) {
      if (closed) throw new Error('port is closed');
      calls.push(message);
    },
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener);
    },
    start() {},
    close() {
      closed = true;
    },
    listenerCount: () => listeners.size,
    emit(data) {
      for (const listener of listeners) listener({ data });
    },
  };
}

function installEmbeddedWindow(pathname = `/build/${DOCUMENT_TOKEN}/index.html`, includeLocation = true) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const listeners = new Set<MessageListener>();
  const calls: Array<{ message: Record<string, unknown>; targetOrigin: string }> = [];
  const parent = {
    postMessage(message: Record<string, unknown>, targetOrigin: string) {
      calls.push({ message, targetOrigin });
    },
  };
  const embeddedWindow = {
    parent,
    ...(includeLocation ? { location: { pathname } } : {}),
    addEventListener(type: string, listener: MessageListener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type: string, listener: MessageListener) {
      if (type === 'message') listeners.delete(listener);
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: embeddedWindow,
  });
  return {
    calls,
    parent,
    listenerCount: () => listeners.size,
    emit(event: MessageEventLike) {
      for (const listener of listeners) listener(event);
    },
    restore() {
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
      else delete (globalThis as { window?: unknown }).window;
    },
  };
}

function responseFor(request: Record<string, unknown>, value: unknown) {
  return {
    type: 'spawn:response',
    version: 1,
    id: request.id,
    ok: true,
    value,
  };
}

test('requires an embedded window and never falls back to a fake standalone client', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    delete (globalThis as { window?: unknown }).window;
    assert.throws(
      () => sdk.createSpawnGameClient({ platformOrigin: PLATFORM_ORIGIN }),
      /embedded|iframe|standalone/i,
    );
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
  }
});

test('requires the launched document path to contain a 43-character asset token', () => {
  const invalidDocuments: Array<[string | undefined, boolean]> = [
    ['/play/project?release=release-1', true],
    [`/build/${'a'.repeat(42)}/index.html`, true],
    [undefined, false],
  ];
  for (const [pathname, includeLocation] of invalidDocuments) {
    const surface = installEmbeddedWindow(pathname, includeLocation);
    try {
      assert.throws(
        () => sdk.createSpawnGameClient({ platformOrigin: PLATFORM_ORIGIN }),
        /build|document|token/i,
      );
      assert.equal(surface.listenerCount(), 0);
    } finally {
      surface.restore();
    }
  }
});

test('requires a root platform origin for the bridge', () => {
  for (const platformOrigin of [
    'https://spawn.example.test/path',
    'http://spawn.example.test',
    'https://spawn.example.test/?preview=1',
    'https://spawn.example.test?',
    'https://spawn.example.test/#preview',
    'https://spawn.example.test#',
    'https://spawn.example.test/%2e',
    'https://creator:secret@spawn.example.test',
  ]) {
    assert.throws(() => sdk.createSpawnGameClient({ platformOrigin }), /origin|path|credential/i);
  }
});

test('accepts only a matching parent source, platform origin, response type and request id', async () => {
  const surface = installEmbeddedWindow();
  try {
    const client = sdk.createSpawnGameClient({ platformOrigin: `${PLATFORM_ORIGIN}/` });
    const pending = client.identity();
    assert.equal(surface.calls.length, 1);
    assert.deepEqual(surface.calls[0], {
      message: { type: 'spawn:connect', version: 1, documentToken: DOCUMENT_TOKEN },
      targetOrigin: PLATFORM_ORIGIN,
    });
    const port = makePort();
    assert.equal(port.calls.length, 0);
    surface.emit({ source: {}, origin: PLATFORM_ORIGIN, data: { type: 'spawn:connected', version: 1 }, ports: [port] });
    surface.emit({ source: surface.parent, origin: 'https://evil.example.test', data: { type: 'spawn:connected', version: 1 }, ports: [port] });
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:connected', version: 1 }, ports: [] });
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:connected', version: 1 }, ports: [port, makePort()] });
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:response', version: 1, id: 'unknown', ok: true, value: { forged: true } } });

    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:connected', version: 1 }, ports: [port] });
    assert.equal(port.calls.length, 1);
    const request = port.calls[0];
    assert.equal(request.type, 'spawn:request');
    assert.equal(request.version, 1);
    assert.equal(request.method, 'identity');
    assert.equal('payload' in request, true);
    assert.equal(surface.calls[0].targetOrigin, PLATFORM_ORIGIN);

    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: responseFor(request, { forged: true }) });
    port.emit({ ...responseFor(request, { forged: true }), extra: 'ignored' });
    port.emit({ ...responseFor(request, { forged: true }), type: 'spawn:request' });
    port.emit(responseFor({ ...request, id: 'other-id' }, { forged: true }));

    const identity = { id: 'player-1', handle: 'pilot', displayName: 'Pilot', avatarUrl: null, environment: 'sandbox' };
    port.emit(responseFor(request, identity));
    assert.deepEqual(await pending, identity);
    client.dispose();
    assert.equal(surface.listenerCount(), 0);
    assert.equal(port.listenerCount(), 0);
  } finally {
    surface.restore();
  }
});

test('does not replace a connected channel and closes it on dispose', async () => {
  const surface = installEmbeddedWindow();
  try {
    const client = sdk.createSpawnGameClient({ platformOrigin: PLATFORM_ORIGIN });
    const firstPort = makePort();
    const secondPort = makePort();
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:connected', version: 1 }, ports: [firstPort] });
    const pending = client.identity();
    assert.equal(firstPort.calls.length, 1);
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:connected', version: 1 }, ports: [secondPort] });
    assert.equal(secondPort.calls.length, 0);
    assert.equal(secondPort.closed, true);
    firstPort.emit(responseFor(firstPort.calls[0], { id: 'player-1', handle: 'pilot', displayName: 'Pilot', avatarUrl: null, environment: 'sandbox' }));
    await pending;
    client.dispose();
    assert.equal(firstPort.closed, true);
    assert.equal(firstPort.listenerCount(), 0);
    assert.equal(surface.listenerCount(), 0);
  } finally {
    surface.restore();
  }
});

test('acknowledges only an exact bounded readiness nonce on the connected port', () => {
  const surface = installEmbeddedWindow();
  try {
    const client = sdk.createSpawnGameClient({ platformOrigin: PLATFORM_ORIGIN });
    const firstPort = makePort();
    const alternatePort = makePort();
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:connected', version: 1 }, ports: [firstPort] });

    const nonce = '123e4567-e89b-12d3-a456-426614174000';
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:ready', version: 1, nonce } });
    firstPort.emit({ type: 'spawn:ready', version: 1 });
    firstPort.emit({ type: 'spawn:ready', version: 1, nonce: 'too-long-' + 'a'.repeat(80) });
    firstPort.emit({ type: 'spawn:ready', version: 1, nonce, extra: 'ignored' });
    firstPort.emit({ type: 'spawn:ready', version: 2, nonce });
    assert.equal(firstPort.calls.length, 0);

    firstPort.emit({ type: 'spawn:ready', version: 1, nonce });
    assert.deepEqual(firstPort.calls, [{ type: 'spawn:ready-ack', version: 1, nonce }]);

    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:connected', version: 1 }, ports: [alternatePort] });
    alternatePort.emit({ type: 'spawn:ready', version: 1, nonce });
    assert.equal(alternatePort.calls.length, 0);
    assert.equal(alternatePort.closed, true);

    client.dispose();
    firstPort.emit({ type: 'spawn:ready', version: 1, nonce: '123e4567-e89b-12d3-a456-426614174001' });
    assert.equal(firstPort.calls.length, 1);
  } finally {
    surface.restore();
  }
});

test('uses method-specific timeouts and clears pending requests on timeout and dispose', async () => {
  const surface = installEmbeddedWindow();
  const oldSetTimeout = globalThis.setTimeout;
  const oldClearTimeout = globalThis.clearTimeout;
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  try {
    (globalThis as unknown as { setTimeout: (...args: unknown[]) => unknown }).setTimeout = (callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    };
    (globalThis as unknown as { clearTimeout: (timer: unknown) => void }).clearTimeout = (timer: unknown) => {
      const found = timers.find((entry) => entry === timer);
      if (found) found.cleared = true;
    };

    const client = sdk.createSpawnGameClient({ platformOrigin: PLATFORM_ORIGIN });
    const identity = client.identity();
    assert.equal(timers[0].delay, 15_000);
    timers[0].callback();
    await assert.rejects(identity, /timed out/i);
    assert.equal(timers[0].cleared, true);

    const payment = client.requestPayment('entry');
    assert.equal(timers[1].delay, 300_000);
    client.dispose();
    await assert.rejects(payment, /disposed/i);
    assert.equal(timers[1].cleared, true);
    assert.equal(surface.listenerCount(), 0);
  } finally {
    globalThis.setTimeout = oldSetTimeout;
    globalThis.clearTimeout = oldClearTimeout;
    surface.restore();
  }
});

test('normalizes optional avatars and rejects external or email identity fields', async () => {
  const surface = installEmbeddedWindow();
  try {
    const avatarPlatformOrigin = 'http://localhost:3003';
    const client = sdk.createSpawnGameClient({ platformOrigin: avatarPlatformOrigin });
    const port = makePort();
    surface.emit({ source: surface.parent, origin: avatarPlatformOrigin, data: { type: 'spawn:connected', version: 1 }, ports: [port] });

    const missingAvatar = client.identity();
    const missingAvatarRequest = port.calls.at(-1)!;
    port.emit(responseFor(missingAvatarRequest, {
      id: 'player-1',
      handle: 'pilot',
      displayName: 'Pilot',
      environment: 'sandbox',
    }));
    assert.deepEqual(await missingAvatar, {
      id: 'player-1',
      handle: 'pilot',
      displayName: 'Pilot',
      avatarUrl: null,
      environment: 'sandbox',
    });

    const sameOriginAvatar = client.identity();
    const sameOriginAvatarRequest = port.calls.at(-1)!;
    const publicProfileId = '123e4567-e89b-12d3-a456-426614174000';
    const actualAvatarUrl = `${avatarPlatformOrigin}/api/v1/avatars/${publicProfileId}?v=0123456789abcdef`;
    port.emit(responseFor(sameOriginAvatarRequest, {
      id: 'player-1',
      handle: 'pilot',
      displayName: 'Pilot',
      avatarUrl: actualAvatarUrl,
      environment: 'sandbox',
    }));
    assert.equal((await sameOriginAvatar).avatarUrl, actualAvatarUrl);

    const noVersionAvatar = client.identity();
    const noVersionAvatarRequest = port.calls.at(-1)!;
    const noVersionAvatarUrl = `${avatarPlatformOrigin}/api/v1/avatars/${publicProfileId}`;
    port.emit(responseFor(noVersionAvatarRequest, {
      id: 'player-1',
      handle: 'pilot',
      displayName: 'Pilot',
      avatarUrl: noVersionAvatarUrl,
      environment: 'sandbox',
    }));
    assert.equal((await noVersionAvatar).avatarUrl, noVersionAvatarUrl);

    const invalidAvatarQuery = client.identity();
    const invalidAvatarQueryRequest = port.calls.at(-1)!;
    port.emit(responseFor(invalidAvatarQueryRequest, {
      id: 'player-1',
      handle: 'pilot',
      displayName: 'Pilot',
      avatarUrl: `${actualAvatarUrl}&extra=1`,
      environment: 'sandbox',
    }));
    await assert.rejects(invalidAvatarQuery, /avatar|invalid/i);

    const externalAvatar = client.identity();
    const externalAvatarRequest = port.calls.at(-1)!;
    port.emit(responseFor(externalAvatarRequest, {
      id: 'player-1',
      handle: 'pilot',
      displayName: 'Pilot',
      avatarUrl: 'https://cdn.example.test/avatar.png',
      environment: 'sandbox',
    }));
    await assert.rejects(externalAvatar, /avatar|origin/i);

    const emailIdentity = client.identity();
    const emailIdentityRequest = port.calls.at(-1)!;
    port.emit(responseFor(emailIdentityRequest, {
      id: 'player-1',
      handle: 'pilot',
      displayName: 'Pilot',
      avatarUrl: null,
      environment: 'sandbox',
      email: 'pilot@example.test',
    }));
    await assert.rejects(emailIdentity, /identity|email|invalid/i);
    client.dispose();
  } finally {
    surface.restore();
  }
});

test('bounds outstanding requests and exposes only the sandbox payment payload', async () => {
  const surface = installEmbeddedWindow();
  try {
    const client = sdk.createSpawnGameClient({ platformOrigin: PLATFORM_ORIGIN });
    const port = makePort();
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:connected', version: 1 }, ports: [port] });
    const pending = Array.from({ length: 20 }, () => client.identity());
    await assert.rejects(client.identity(), /20|outstanding|pending/i);
    assert.equal(surface.calls.length, 1);
    assert.equal(port.calls.length, 20);
    client.dispose();
    await Promise.all(pending.map((promise) => assert.rejects(promise, /disposed/i)));
    await assert.rejects(client.requestPayment('other' as 'entry'), /entry|product/i);
  } finally {
    surface.restore();
  }
});

test('shapes bridge methods without accepting arbitrary payment or score authority', async () => {
  const surface = installEmbeddedWindow();
  try {
    const client = sdk.createSpawnGameClient({ platformOrigin: PLATFORM_ORIGIN });
    const port = makePort();
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:connected', version: 1 }, ports: [port] });
    await assert.rejects(client.load('../private'), /invalid save key/i);
    await assert.rejects(client.submitScore(Number.NaN), /score/i);

    const save = client.save('progress', { level: 2 }, 1);
    const saveRequest = port.calls.at(-1)!;
    assert.deepEqual(saveRequest, {
      type: 'spawn:request',
      version: 1,
      id: saveRequest.id,
      method: 'save',
      payload: { key: 'progress', value: { level: 2 }, expectedVersion: 1 },
    });
    port.emit(responseFor(saveRequest, { value: { level: 2 }, version: 2, updatedAt: 'now' }));
    assert.equal((await save).version, 2);

    const payment = client.requestPayment('entry');
    const paymentRequest = port.calls.at(-1)!;
    assert.deepEqual(paymentRequest, {
      type: 'spawn:request',
      version: 1,
      id: paymentRequest.id,
      method: 'requestPayment',
      payload: { productId: 'entry' },
    });
    port.emit(responseFor(paymentRequest, {
        id: 'payment-1',
        intentId: 'intent-1',
        amount: 10,
        asset: 'TEST',
        environment: 'sandbox',
        status: 'paid',
      }));
    assert.equal((await payment).amount, 10);

    const objectPayment = client.requestPayment({ productId: 'entry' });
    const objectPaymentRequest = port.calls.at(-1)!;
    assert.deepEqual(objectPaymentRequest.payload, { productId: 'entry' });
    port.emit(responseFor(objectPaymentRequest, {
        id: 'payment-2',
        intentId: 'intent-2',
        amount: 10,
        asset: 'TEST',
        environment: 'sandbox',
        status: 'paid',
      }));
    await objectPayment;

    const cancelled = client.requestPayment('entry');
    const cancelledRequest = port.calls.at(-1)!;
    port.emit({
      type: 'spawn:response',
      version: 1,
      id: cancelledRequest.id,
      ok: false,
      error: 'cancelled',
    });
    await assert.rejects(cancelled, /cancelled/i);
    client.dispose();
  } finally {
    surface.restore();
  }
});

await test('injected public origin supports identical local and published startup without identity fallback', () => {
  const environment = installEmbeddedWindow();
  const old = Object.getOwnPropertyDescriptor(globalThis, '__SPAWN_LAUNCH__');
  try {
    Object.defineProperty(globalThis, '__SPAWN_LAUNCH__', { configurable: true, value: { platformOrigin: PLATFORM_ORIGIN } });
    const client = sdk.createSpawnGameClient();
    assert.equal(environment.calls[0].targetOrigin, PLATFORM_ORIGIN);
    client.dispose();
    Object.defineProperty(globalThis, '__SPAWN_LAUNCH__', { configurable: true, value: { platformOrigin: 'https://bad.example/path' } });
    assert.throws(() => sdk.createSpawnGameClient(), /origin/i);
    delete (globalThis as { __SPAWN_LAUNCH__?: unknown }).__SPAWN_LAUNCH__;
    assert.throws(() => sdk.createSpawnGameClient(), /required/i);
  } finally {
    if (old) Object.defineProperty(globalThis, '__SPAWN_LAUNCH__', old);
    else delete (globalThis as { __SPAWN_LAUNCH__?: unknown }).__SPAWN_LAUNCH__;
    environment.restore();
  }
});

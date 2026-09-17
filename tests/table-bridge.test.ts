import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpawnMultiplayerClient } from '../src/multiplayer.ts';

const PLATFORM_ORIGIN = 'https://spawn.example.test';
const SERVER_ORIGIN = 'https://game.example.test';
const DOCUMENT_TOKEN = 'a'.repeat(43);
const TABLE_ID = '123e4567-e89b-42d3-a456-426614174000';
const BUY_IN_ID = '223e4567-e89b-42d3-a456-426614174000';
const PROJECT_ID = '323e4567-e89b-42d3-a456-426614174000';
const PLAYER_ID = '423e4567-e89b-42d3-a456-426614174000';
const SEAT_ID = '523e4567-e89b-42d3-a456-426614174000';

type Listener = (event: any) => void;

function makePort() {
  const listeners = new Set<Listener>();
  const calls: Record<string, unknown>[] = [];
  let closed = false;
  let onmessage: Listener | null = null;
  return {
    calls,
    get closed() { return closed; },
    postMessage(message: Record<string, unknown>) {
      if (closed) throw new Error('closed');
      calls.push(message);
    },
    get onmessage() { return onmessage; },
    set onmessage(value: Listener | null) { onmessage = value; },
    addEventListener(type: string, listener: Listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type: string, listener: Listener) { if (type === 'message') listeners.delete(listener); },
    start() {},
    close() { closed = true; },
    emit(data: unknown) { onmessage?.({ data }); for (const listener of listeners) listener({ data }); },
  };
}

function installWindow() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const listeners = new Set<Listener>();
  const parentCalls: Record<string, unknown>[] = [];
  const parent = { postMessage(message: Record<string, unknown>) { parentCalls.push(message); } };
  const win = {
    parent,
    location: { hash: `#spawnBridge=${DOCUMENT_TOKEN}` },
    addEventListener(type: string, listener: Listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type: string, listener: Listener) { if (type === 'message') listeners.delete(listener); },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  return {
    parent,
    parentCalls,
    emit(event: unknown) { for (const listener of listeners) listener(event); },
    restore() {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else delete (globalThis as { window?: unknown }).window;
    },
  };
}

test('multiplayer table buy-in uses the exact Spawn-owned approval wire and accepts only confirmed status', async () => {
  const surface = installWindow();
  try {
    const client = createSpawnMultiplayerClient({ platformOrigin: PLATFORM_ORIGIN, serverOrigin: SERVER_ORIGIN });
    const port = makePort();
    const nonce = surface.parentCalls[0]?.nonce as string;
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:multiplayer-offer', version: 1, nonce }, ports: [port] });
    const ready = port.calls[0];
    assert.equal(ready?.type, 'spawn:multiplayer-ack');
    port.emit({ type: 'spawn:multiplayer-confirm', version: 1, nonce });
    await client.ready();

    const pending = client.tables.buyIn({ tableId: TABLE_ID.toUpperCase(), buyInId: BUY_IN_ID.toUpperCase() });
    await Promise.resolve();
    const request = port.calls.find((entry) => entry.type === 'spawn:multiplayer-table-request')!;
    assert.deepEqual({
      type: request.type,
      version: request.version,
      nonce: request.nonce,
      requestId: request.requestId,
      method: request.method,
      payload: request.payload,
    }, {
      type: 'spawn:multiplayer-table-request',
      version: 1,
      nonce,
      requestId: request.requestId,
      method: 'tables.buyIn',
      payload: { tableId: TABLE_ID, buyInId: BUY_IN_ID },
    });
    port.emit({ type: 'spawn:multiplayer-table-result', version: 1, nonce, requestId: request.requestId, value: { tableId: TABLE_ID, buyInId: BUY_IN_ID, status: 'confirmed' } });
    assert.deepEqual(await pending, { tableId: TABLE_ID, buyInId: BUY_IN_ID, status: 'confirmed' });
    assert.equal(port.calls.filter((entry) => entry.method === 'tables.heartbeat').length, 0);
    const stop = client.tables.watch(TABLE_ID);
    await Promise.resolve();
    const heartbeat = port.calls.find((entry) => entry.method === 'tables.heartbeat');
    assert.ok(heartbeat, 'an explicit watch starts the player heartbeat');
    assert.deepEqual(heartbeat.payload, { tableId: TABLE_ID });
    stop();
    client.dispose();
  } finally {
    surface.restore();
  }
});

test('multiplayer table leave carries the seat generation and validates player status', async () => {
  const surface = installWindow();
  try {
    const client = createSpawnMultiplayerClient({ platformOrigin: PLATFORM_ORIGIN, serverOrigin: SERVER_ORIGIN });
    const port = makePort();
    const nonce = surface.parentCalls[0]?.nonce as string;
    surface.emit({ source: surface.parent, origin: PLATFORM_ORIGIN, data: { type: 'spawn:multiplayer-offer', version: 1, nonce }, ports: [port] });
    port.emit({ type: 'spawn:multiplayer-confirm', version: 1, nonce });
    await client.ready();

    const pending = client.tables.leave({ tableId: TABLE_ID, operationId: BUY_IN_ID, seatId: SEAT_ID });
    await Promise.resolve();
    const request = port.calls.find((entry) => entry.type === 'spawn:multiplayer-table-request')!;
    assert.equal(request.method, 'tables.leave');
    assert.deepEqual(request.payload, { tableId: TABLE_ID, operationId: BUY_IN_ID, seatId: SEAT_ID });
    port.emit({
      type: 'spawn:multiplayer-table-result', version: 1, nonce, requestId: request.requestId,
      value: {
        tableId: TABLE_ID,
        projectId: PROJECT_ID,
        playerId: PLAYER_ID,
        seatId: SEAT_ID,
        seat: {
          seatId: SEAT_ID,
          playerId: PLAYER_ID,
          stack: '0',
          pendingCashOut: '15',
          status: 'leaving',
          connectedUntil: null,
          disconnectDeadline: null,
        },
        stack: '0',
        pendingCashOut: '15',
        seatStatus: 'leaving',
        publicTableState: {
          tableId: TABLE_ID,
          projectId: PROJECT_ID,
          status: 'open',
          asset: {
            id: 'erc20:46630:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            chainId: 46630,
            address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            name: 'Spawn Token',
            symbol: 'SPAWN',
            decimals: 18,
            image: '',
            source: 'spawn',
            enabled: true,
          },
          settingsVersion: 1,
          maxSeats: 2,
          revision: 2,
          leaseExpiresAt: 1800000000000,
          maxEndsAt: 1800086400000,
          totals: { buyIns: '15', cashOuts: '0', stacks: '0', committed: '0', pendingCashOuts: '15', backing: '15' },
          seats: [{
            seatId: SEAT_ID,
            playerId: PLAYER_ID,
            stack: '0',
            pendingCashOut: '15',
            status: 'leaving',
            connectedUntil: null,
            disconnectDeadline: null,
          }],
          hand: null,
        },
      },
    });
    const result = await pending;
    assert.equal(result.seatId, SEAT_ID);
    assert.equal(result.pendingCashOut, '15');
    client.dispose();
  } finally {
    surface.restore();
  }
});

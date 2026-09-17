import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpawnTableClient } from '../src/table-server.ts';
import {
  DurableTableJournal,
  createTable,
  recover,
  replaySavedMutation,
  startHand,
} from '../examples/table-bankroll.mjs';

async function temporaryJournal() {
  const directory = await mkdtemp(join(tmpdir(), 'spawn-table-sdk-'));
  const journal = new DurableTableJournal(directory);
  await journal.init();
  return { directory, journal };
}

test('table example writes intent before network and reopens the durable journal', async () => {
  const { directory, journal } = await temporaryJournal();
  try {
    const tableId = randomUUID();
    let networkSawIntent = false;
    const client = {
      async create(input: { tableId: string; operationId: string; maxSeats: number }) {
        const files = await readdir(directory);
        assert.equal(files.length, 1);
        const saved = JSON.parse(await readFile(join(directory, files[0]!), 'utf8'));
        networkSawIntent = saved.state === 'intent' && saved.request.maxSeats === 6 && saved.operationId === input.operationId;
        return { tableId: input.tableId, status: 'open' };
      },
    };
    const result = await createTable(client, journal, { tableId });
    assert.equal(result.status, 'open');
    assert.equal(networkSawIntent, true);

    const reopened = new DurableTableJournal(directory);
    await reopened.init();
    assert.deepEqual(await reopened.pending(), []);
    const files = await readdir(directory);
    const saved = JSON.parse(await readFile(join(directory, files[0]!), 'utf8'));
    assert.equal(saved.state, 'resolved');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('replay uses the saved UUID/body and recovery never invents a mutation', async () => {
  const { directory, journal } = await temporaryJournal();
  try {
    const entry = {
      tableId: randomUUID(),
      operationId: randomUUID(),
      action: 'create',
      request: { tableId: '', maxSeats: 4 },
    };
    entry.request.tableId = entry.tableId;
    await journal.intent(entry);
    const calls: unknown[] = [];
    const client = {
      async create(input: unknown) {
        calls.push(input);
        return { tableId: entry.tableId, status: 'open' };
      },
      async operation() {
        const error = Object.assign(new Error('not found yet'), { status: 404, outcomeUnknown: false });
        throw error;
      },
      async status() {
        return { tableId: entry.tableId, status: 'open' };
      },
    };
    const outcomes = await recover(client, journal);
    assert.equal(outcomes.length, 1);
    assert.equal(calls.length, 0);
    assert.equal((await journal.pending()).length, 1);

    await replaySavedMutation(client, journal, entry);
    assert.deepEqual(calls, [{ tableId: entry.tableId, operationId: entry.operationId, maxSeats: 4 }]);
    assert.deepEqual(await journal.pending(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('journal and network receive one frozen snapshot when request arrays are mutated by the caller', async () => {
  const { directory, journal } = await temporaryJournal();
  try {
    const tableId = randomUUID();
    const players = [{ playerId: randomUUID(), seatId: randomUUID() }, { playerId: randomUUID(), seatId: randomUUID() }];
    const originalPlayers = structuredClone(players);
    let networkPlayers;
    const client = {
      async startHand(_tableId: string, input: unknown) {
        networkPlayers = input.players;
        assert.equal(Object.isFrozen(input.players), true);
        assert.equal(Object.isFrozen(input.players[0]), true);
        return { tableId, status: 'open' };
      },
    };
    const pending = startHand(client, journal, tableId, { players });
    players[0].playerId = randomUUID();
    players.push({ playerId: randomUUID(), seatId: randomUUID() });
    await pending;
    assert.deepEqual(networkPlayers, originalPlayers, 'the test input mutation should not be observed by the frozen snapshot');
    const files = await readdir(directory);
    const saved = JSON.parse(await readFile(join(directory, files[0]!), 'utf8'));
    assert.equal(saved.state, 'resolved');
    assert.equal(saved.request.players.length, 2);
    assert.notEqual(saved.request.players[0].playerId, players[0].playerId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('known deterministic 4xx rejections are terminal and excluded from recovery', async () => {
  const { directory, journal } = await temporaryJournal();
  try {
    const tableId = randomUUID();
    const rejection = Object.assign(new Error('known conflict'), {
      name: 'SpawnTableRequestError',
      status: 409,
      outcomeUnknown: false,
      toJSON: () => ({ code: 'HTTP_CONFLICT', outcomeUnknown: false }),
    });
    const client = { async create() { throw rejection; } };
    await assert.rejects(createTable(client, journal, { tableId }), /known conflict/);
    const files = await readdir(directory);
    const saved = JSON.parse(await readFile(join(directory, files[0]!), 'utf8'));
    assert.equal(saved.state, 'rejected');
    assert.deepEqual(await journal.pending(), []);

    let reads = 0;
    const outcomes = await recover({
      async operation() { reads++; },
      async status() { reads++; },
    }, journal);
    assert.deepEqual(outcomes, []);
    assert.equal(reads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('replaying a prior uncertain intent preserves uncertainty after a deterministic 4xx', async () => {
  const { directory, journal } = await temporaryJournal();
  try {
    const entry = {
      tableId: randomUUID(),
      operationId: randomUUID(),
      action: 'create',
      state: 'unknown',
      request: { tableId: '', maxSeats: 4 },
    };
    entry.request.tableId = entry.tableId;
    await journal.unknown(entry, new Error('timeout'));
    const rejection = Object.assign(new Error('unauthorized on retry'), {
      name: 'SpawnTableRequestError',
      status: 401,
      outcomeUnknown: false,
      toJSON: () => ({ code: 'HTTP_UNAUTHORIZED', outcomeUnknown: false }),
    });
    await assert.rejects(replaySavedMutation({ async create() { throw rejection; } }, journal, entry), /unauthorized/);
    const saved = JSON.parse(await readFile(journal.path(entry.operationId), 'utf8'));
    assert.equal(saved.state, 'unknown');
    assert.equal(saved.error.code, 'HTTP_UNAUTHORIZED');
    assert.deepEqual((await journal.pending()).map((item) => item.operationId), [entry.operationId]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('journal path rejects a non-UUID before touching the filesystem', async () => {
  const { directory, journal } = await temporaryJournal();
  try {
    assert.throws(() => journal.path('../table'), /UUID/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('real SDK recovers durable cash-out and disconnect records that return table status', async () => {
  for (const action of ['cashOut', 'disconnect']) {
    const { directory, journal } = await temporaryJournal();
    try {
      const tableId = randomUUID(), projectId = randomUUID(), operationId = randomUUID();
      await journal.unknown({
        tableId, operationId, action,
        request: { tableId, playerId: randomUUID(), seatId: randomUUID() },
      }, new Error('response lost'));
      const status = {
        tableId, projectId, status: 'closed', asset: null,
        settingsVersion: 0, maxSeats: 0, revision: 0,
        leaseExpiresAt: null, maxEndsAt: Date.now(),
        totals: { buyIns: '0', cashOuts: '0', stacks: '0', committed: '0', pendingCashOuts: '0', backing: '0' },
        seats: [], hand: null,
      };
      const client = createSpawnTableClient({
        projectId, platformOrigin: 'https://spawn.example.test', credential: 'a'.repeat(43),
        fetch: async (input) => Response.json(String(input).includes('/operations/')
          ? { operationId, action, result: status } : status),
      });
      const outcomes = await recover(client, journal);
      assert.equal(outcomes[0]?.operationError, undefined);
      assert.equal(outcomes[0]?.operation?.action, action);
      assert.deepEqual(await journal.pending(), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

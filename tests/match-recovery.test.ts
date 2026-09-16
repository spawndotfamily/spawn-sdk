import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSpawnMatchClient } from '../src/match-server.ts';
const { cancelUncertainCreation } = await import('../examples/match-creation-recovery.mjs');
const projectId = randomUUID(), matchId = randomUUID();
const definition = { matchId, amount: '10', players: [
  { playerId: randomUUID(), launchId: randomUUID() },
  { playerId: randomUUID(), launchId: randomUUID() },
] };
const pending = { projectId, matchId, status: 'pending', allConfirmed: false,
  players: definition.players.map(p => ({ playerId: p.playerId, confirmed: false })) };
const cancelled = { matchId, status: 'cancelled', reason: 'technical', cancelledAt: 1, refunds: [], potAmount: '20' };
const make = (fetch: typeof globalThis.fetch) => createSpawnMatchClient({ platformOrigin: 'https://spawn.example', projectId, credential: 'a'.repeat(43), fetch });

test('absence converges on original definition, then cancels; delayed duplicate stays cancelled', async () => {
  let state: any = null;
  const sent: any[] = [];
  const client = make(async (url, options) => {
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    sent.push({ url: String(url), body });
    if (options?.method === 'GET') return state ? Response.json(state) : Response.json({ error: 'Match not found.' }, { status: 404 });
    if (String(url).endsWith('/cancel')) {
      state = { ...pending, status: 'cancelled', result: cancelled };
      return Response.json(cancelled);
    }
    assert.deepEqual(body, definition);
    state ??= pending;
    return Response.json(state, { status: 201 });
  });
  const result = await cancelUncertainCreation(client, definition);
  assert.equal(result.replacementAllowed, true);
  assert.equal(result.matchId, matchId);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[1].body, definition);
  // A delayed original has the same immutable identity and cannot create a new pot.
  assert.equal((await client.create(definition)).status, 'cancelled');
});

test('a failed same-ID create never turns earlier uncertainty into a definite rejection', async () => {
  let count = 0;
  const client = make(async () => { count++; return Response.json({ error: count === 1 ? 'Match not found.' : 'Player launch expired.' }, { status: count === 1 ? 404 : 409 }); });
  const result = await cancelUncertainCreation(client, definition);
  assert.equal(result.replacementAllowed, false);
  assert.equal(result.resolution, 'unresolved');
  assert.equal(result.error.status, 409);
  assert.equal(result.error.reason, 'Player launch expired.');
  assert.equal(count, 2);
});

test('cancellation timeout stays unresolved; later terminal status completes recovery', async () => {
  let count = 0;
  const client = make(async () => { count++; if (count === 1) return Response.json(pending); if (count === 2) throw new Error('lost response'); return Response.json({ ...pending, status: 'cancelled', result: cancelled }); });
  assert.equal((await cancelUncertainCreation(client, definition)).replacementAllowed, false);
  assert.equal((await cancelUncertainCreation(client, definition)).replacementAllowed, true);
  assert.equal(count, 3);
});

test('running/settled matches and malformed cancellation proof cannot authorize replacement', async () => {
  for (const state of [ { ...pending, status: 'running' }, { ...pending, status: 'settled' }, { ...pending, status: 'cancelled', result: null } ]) {
    let calls = 0;
    const result = await cancelUncertainCreation(make(async () => { calls++; return Response.json(state); }), definition);
    assert.equal(result.replacementAllowed, false);
    assert.equal(calls, 1);
  }
});

test('non-404 status failures do not start a mutation', async () => {
  let calls = 0;
  const result = await cancelUncertainCreation(make(async () => { calls++; return Response.json({ error: 'unavailable' }, { status: 503 }); }), definition);
  assert.equal(result.replacementAllowed, false);
  assert.equal(calls, 1);
});

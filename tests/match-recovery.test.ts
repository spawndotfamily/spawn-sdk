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
const proof = { projectId, matchId, status: 'cancelled', reason: 'technical', cancelledAt: 1,
  refunds: [], potAmount: '0', creationClosed: true, closedBeforeCreation: true };
const make = (fetch: typeof globalThis.fetch) => createSpawnMatchClient({ platformOrigin: 'https://spawn.example', projectId, credential: 'a'.repeat(43), fetch });

test('absent creation closes directly without replaying expired player launches', async () => {
  let calls = 0;
  const result = await cancelUncertainCreation(make(async (url, init) => {
    calls++;
    assert.equal(String(url), `https://spawn.example/api/v1/registered-games/${projectId}/matches/${matchId}/close-creation`);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {});
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    return Response.json(proof);
  }), definition);
  assert.equal(result.replacementAllowed, true);
  assert.deepEqual(result.result, proof);
  assert.equal(calls, 1);
});

test('lost closure response blocks replacement until an explicit same-ID closure retry succeeds', async () => {
  let calls = 0;
  const client = make(async () => { if (++calls === 1) throw new Error('lost'); return Response.json(proof); });
  assert.equal((await cancelUncertainCreation(client, definition)).replacementAllowed, false);
  assert.equal(calls, 1);
  assert.equal((await cancelUncertainCreation(client, definition)).replacementAllowed, true);
});

test('rejections including absent endpoint and running conflict never authorize replacement', async () => {
  for (const status of [401,403,404,409,429,503]) {
    let calls = 0;
    const result = await cancelUncertainCreation(make(async () => { calls++; return Response.json({error:'blocked'}, {status}); }), definition);
    assert.equal(result.replacementAllowed, false);
    assert.equal(result.error.status, status);
    assert.equal(calls, 1);
  }
});

test('closure requires bound, internally consistent proof; legacy cancellation is insufficient', async () => {
  for (const patch of [
    {closedBeforeCreation:false, potAmount:'20', refunds:[{playerId:definition.players[0].playerId,amount:'21'}]},
    {creationClosed: false}, {projectId: randomUUID()}, {matchId: randomUUID()}, {status:'running'},
    {closedBeforeCreation:undefined}, {cancelledAt:-1}, {reason:''}, {potAmount:'1e8'},
    {potAmount:'2'}, {refunds:[{playerId:definition.players[0].playerId,amount:'1'}]},
    {closedBeforeCreation:false, refunds:[{playerId:'fake',amount:'1'}]},
    {closedBeforeCreation:false, refunds:[{playerId:definition.players[0].playerId,amount:'-1'}]},
    {closedBeforeCreation:false, potAmount:'20', refunds:[{playerId:definition.players[0].playerId,amount:'10'},{playerId:definition.players[0].playerId,amount:'10'}]},
  ]) {
    const result = await cancelUncertainCreation(make(async () => Response.json({...proof,...patch})), definition);
    assert.equal(result.replacementAllowed, false, JSON.stringify(patch));
  }
});

test('confirmed pending cancellation refunds only the saved players', async () => {
  const refund = {...proof, closedBeforeCreation:false, potAmount:'20', refunds:[{playerId:definition.players[0].playerId,amount:'10'}]};
  assert.equal((await cancelUncertainCreation(make(async () => Response.json(refund)), definition)).replacementAllowed, true);
  assert.equal((await cancelUncertainCreation(make(async () => Response.json({...refund, refunds:[{playerId:randomUUID(),amount:'10'}]})), definition)).replacementAllowed, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSpawnMatchClient, SpawnMatchRequestError } from '../src/match-server.ts';
const projectId = randomUUID(), matchId = randomUUID(), credential = 'a'.repeat(43);
const make = (fetch: typeof globalThis.fetch) => createSpawnMatchClient({ platformOrigin: 'https://spawn.example', projectId, credential, fetch });

test('retains bounded public rejection reason and request context', async () => {
  const client = make(async () => Response.json({ error: 'A player is already reserved in another match.', code: 'MATCH_PLAYER_BUSY', requestId: 'request-123' }, { status: 409 }));
  await assert.rejects(client.capture(matchId), (e: any) => {
    assert.ok(e instanceof SpawnMatchRequestError);
    assert.equal(e.code, 'HTTP_CONFLICT');
    assert.equal(e.platformCode, 'MATCH_PLAYER_BUSY');
    assert.equal(e.reason, 'A player is already reserved in another match.');
    assert.equal(e.matchId, matchId);
    assert.equal(e.projectId, projectId);
    assert.equal(e.action, 'capture');
    assert.equal(e.requestId, 'request-123');
    assert.equal(e.outcomeUnknown, false);
    assert.match(e.message, /already reserved/);
    assert.equal(e.toJSON().reason, e.reason);
    return true;
  });
});

test('malformed error bodies retain HTTP status without leaking raw bodies', async () => {
  for (const body of ['<html>private upstream text</html>', JSON.stringify({ error: 'x'.repeat(70000) })]) {
    const client = make(async () => new Response(body, { status: 503 }));
    await assert.rejects(client.capture(matchId), (e: any) => e.status === 503 && e.code === 'HTTP_UNAVAILABLE' && e.outcomeUnknown && !e.message.includes('private upstream') && e.reason === undefined);
  }
});

test('credential reflection and log control characters are excluded', async () => {
  const client = make(async () => Response.json({ error: `oops\nBearer ${credential}`, requestId: credential, code: credential }, { status: 400 }));
  await assert.rejects(client.capture(matchId), (e: any) => {
    assert.equal(e.reason, undefined);
    assert.equal(e.platformCode, undefined);
    assert.equal(e.requestId, undefined);
    assert.ok(!JSON.stringify(e.toJSON()).includes(credential));
    return true;
  });
});

test('timeout and subsequent absence are distinct observations, never automatic retries', async () => {
  let calls = 0;
  const client = make(async () => { calls++; if (calls === 1) throw new Error('network credential detail'); return Response.json({ error: 'Match not found.' }, { status: 404 }); });
  await assert.rejects(client.capture(matchId), (e: any) => e.code === 'TRANSPORT_ERROR' && e.outcomeUnknown && e.matchId === matchId);
  await assert.rejects(client.status(matchId), (e: any) => e.code === 'HTTP_NOT_FOUND' && !e.outcomeUnknown && e.reason === 'Match not found.');
  assert.equal(calls, 2);
});

test('HTTP 408 remains uncertain for a mutation and rate limits expose bounded delay', async () => {
  const timeout = make(async () => Response.json({ error: 'Timed out.' }, { status: 408 }));
  await assert.rejects(timeout.capture(matchId), (e: any) => e.status === 408 && e.outcomeUnknown && e.code === 'HTTP_TIMEOUT');
  const limited = make(async () => Response.json({ error: 'Try later.' }, { status: 429, headers: { 'retry-after': '3' } }));
  await assert.rejects(limited.status(matchId), (e: any) => e.code === 'HTTP_RATE_LIMITED' && e.retryAfterMs === 3000);
});

test('aborted requests and invalid successful responses keep operation context', async () => {
  const timed = createSpawnMatchClient({ platformOrigin: 'https://spawn.example', projectId, credential, timeoutMs: 100,
    fetch: async (_, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('private transport text')))) });
  await assert.rejects(timed.capture(matchId), (e: any) => e.code === 'REQUEST_TIMEOUT' && e.outcomeUnknown && e.action === 'capture' && !e.message.includes('private transport'));
  const invalid = make(async () => Response.json({ matchId, status: 'running' }));
  await assert.rejects(invalid.capture(matchId), (e: any) => e.code === 'INVALID_RESPONSE' && e.status === 200 && e.outcomeUnknown);
});

test('legacy string error survives without invented platform code or request ID', async () => {
  const legacy = make(async () => Response.json({ error: 'Match not found.', debug: 'private' }, { status: 404 }));
  await assert.rejects(legacy.status(matchId), (e: any) => e.reason === 'Match not found.' && e.platformCode === undefined && e.requestId === undefined && !JSON.stringify(e.toJSON()).includes('private'));
});

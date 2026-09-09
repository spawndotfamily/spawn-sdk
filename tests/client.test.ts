import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpawnClient } from '../src/index.ts';

test('rejects unsupported games before issuing any request', () => {
  assert.throws(() => createSpawnClient('another-game'), /not enabled/);
});
test('validates keys, preserves versions and propagates conflicts', async (t) => {
  const requests: Array<{ url: unknown; init?: RequestInit }> = [];
  const responses = [new Response('null'), new Response(JSON.stringify({ value: { level: 3 }, version: 1 })),
    new Response(JSON.stringify({ error: 'Save conflict.' }), { status: 409 })];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    requests.push({url, init}); return responses.shift()!;
  });
  const client = createSpawnClient('rob-the-rich');
  await assert.rejects(client.load('../private'), /Invalid save key/);
  assert.equal(requests.length, 0);
  assert.equal(await client.load('progress'), null);
  assert.equal((await client.save('progress', {level: 3}, 0)).version, 1);
  assert.equal(requests[0].url, '/api/v1/game-storage/rob-the-rich/progress');
  assert.equal(requests[0].init?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {value: {level: 3}, expectedVersion: 0});
  await assert.rejects(client.save('progress', {level: 4}, 0), /Save conflict/);
});

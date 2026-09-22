import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore Shipped JavaScript artifact and declarations are checked separately.
import { startSpawnTestHost } from '../testing/local-host.mjs';

const createTable = (host: any, maxSeats = 6) => host.tables.create({ tableId: randomUUID(), operationId: randomUUID(), maxSeats });
const quote = (host: any, tableId: string, player: any, amount = '10') => host.tables.requestBuyIn(tableId, { operationId: randomUUID(), buyInId: randomUUID(), player: { playerId: player.playerId, launchId: player.launchId }, amount });
const path = (player: any, q: any) => `/api/v1/games/launches/${player.launchId}/tables/${q.tableId}/buy-ins/${q.buyInId}`;
const confirm = (player: any, q: any) => player.fetch(path(player, q) + '/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: q.quoteId }) });

test('ordinary game builds use an inspected tokenized sandbox without exposing player authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spawn-local-game-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><body><script src="./game.js"></script></body></html>');
  await writeFile(join(directory, 'game.js'), 'globalThis.testLoaded = true;');
  let host: any;
  try {
    await assert.rejects(startSpawnTestHost({ gameDirectory: directory, gameUrl: 'http://127.0.0.1:3000' }), /never both/);
    await assert.rejects(startSpawnTestHost({ mode: 'game' }), /gameDirectory/);
    host = await startSpawnTestHost({ players: 2, gameDirectory: directory });
    const capability = new URL(host.players[0].url).hash.slice(5);
    const context = await (await fetch(host.origin + '/__spawn/player-context', { headers: { 'x-spawn-test-session': capability } })).json();
    assert.equal(context.mode, 'game');
    assert.equal(new URL(context.gameUrl).pathname, `/build/${context.documentToken}/index.html`);
    const html = await fetch(context.gameUrl);
    assert.match(html.headers.get('content-security-policy')!, /sandbox allow-scripts/);
    assert.doesNotMatch(html.headers.get('content-security-policy')!, /allow-same-origin/);
    const content = await html.text();
    assert.match(content, /__SPAWN_LAUNCH__/);
    assert.equal(content.includes(capability), false);
    assert.equal(content.includes(host.credential), false);
    const asset = new URL('./game.js', context.gameUrl).href;
    assert.equal((await fetch(asset + '?v=1', { headers: { origin: 'null' } })).status, 200);
    assert.equal((await fetch(new URL('./.env', context.gameUrl))).status, 404);
    assert.equal((await fetch(host.origin + '/build/' + 'x'.repeat(43) + '/index.html')).status, 404);
    assert.equal((await fetch(host.origin + '/__spawn/player-context', { headers: { origin: 'null' } })).status, 403);
    await writeFile(join(directory, 'game.js'), 'globalThis.testLoaded = false;');
    assert.equal((await fetch(asset)).status, 500, 'changed builds require a fresh inspection');
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('local host uses exact production approvals, member isolation, cancellation and insufficient funds', async () => {
  const host = await startSpawnTestHost({ players: 3, balance: '10' });
  try {
    const [alice, bob, carol] = host.players;
    const table = await createTable(host);
    const q = await quote(host, table.tableId, alice);
    assert.equal(alice.balance(), '10', 'requesting cannot debit');
    const wrong = await bob.fetch(path(alice, q) + '/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: q.quoteId }) });
    assert.notEqual(wrong.status, 200);
    assert.equal(alice.balance(), '10');
    for (let i = 0; i < 2; i++) assert.equal((await confirm(alice, q)).status, 200);
    assert.equal(alice.balance(), '0');
    assert.equal((await host.tables.status(table.tableId)).totals.buyIns, '10');
    const poor = await quote(host, table.tableId, alice, '1');
    assert.notEqual((await confirm(alice, poor)).status, 200);
    const cancelled = await quote(host, table.tableId, carol, '2');
    const response = await carol.fetch(path(carol, cancelled) + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    assert.notEqual((await confirm(carol, cancelled)).status, 200);
    assert.equal(carol.balance(), '10');
  } finally { await host.close(); }
});

test('100 players share the production ledger across six-seat tables and concurrent cash-outs conserve balances', async () => {
  const host = await startSpawnTestHost({ players: 100, balance: '100' });
  try {
    for (let start = 0; start < host.players.length; start += 6) {
      const players = host.players.slice(start, start + 6), table = await createTable(host);
      await Promise.all(players.map(async (p: any) => { const q = await quote(host, table.tableId, p, '7'); assert.equal((await confirm(p, q)).status, 200); }));
      const status = await host.tables.status(table.tableId);
      assert.equal(status.totals.buyIns, String(players.length * 7));
      await Promise.all(status.seats.map((seat: any) => host.tables.cashOut(table.tableId, { operationId: randomUUID(), playerId: seat.playerId, seatId: seat.seatId })));
      const after = await host.tables.status(table.tableId);
      assert.equal(after.totals.backing, '0');
      assert.equal(after.totals.buyIns, after.totals.cashOuts);
      for (const p of players) assert.equal(p.balance(), '100');
    }
  } finally { await host.close(); }
});

test('local host refuses remote origins, binds, missing capabilities and forged browser identity', async () => {
  await assert.rejects(startSpawnTestHost({ gameUrl: 'https://spawn.family/play/anything' }), /loopback/);
  await assert.rejects(startSpawnTestHost({ host: '0.0.0.0' }), /remote/);
  const host = await startSpawnTestHost({ players: 2 });
  try {
    assert.equal((await fetch(host.origin + '/__spawn/player-context')).status, 401);
    const cap = new URL(host.players[0].url).hash.slice(5);
    assert.equal((await fetch(host.origin + '/__spawn/player-context', { headers: { 'x-spawn-test-session': cap, origin: 'https://attacker.invalid' } })).status, 403);
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(host.origin + '/__spawn/player-context', { headers: { host: 'evil.invalid', 'x-spawn-test-session': cap } }, response => { response.resume(); resolve(response.statusCode!); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(host.origin + '/api/v1/admin/users', { headers: { 'x-spawn-test-session': cap } })).status, 404);
    assert.equal((await fetch(host.origin + '/api/v1/registered-games/' + host.projectId + '/tables', { method: 'POST', headers: { 'content-type': 'application/json', 'x-spawn-test-session': cap }, body: '{}' })).status, 401);
  } finally { await host.close(); }
});

test('local host restarts retain identities, backing and exact operation replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spawn-sdk-local-test-'));
  const databasePath = join(directory, 'test.sqlite');
  let host = await startSpawnTestHost({ players: 2, balance: '100', databasePath });
  try {
    const playerId = host.players[0].playerId, table = await createTable(host), q = await quote(host, table.tableId, host.players[0], '20');
    assert.equal((await confirm(host.players[0], q)).status, 200);
    const funded = await host.tables.status(table.tableId);
    const input = { operationId: randomUUID(), playerId, seatId: funded.seats[0].seatId };
    host.loseNextResponse(`/api/v1/registered-games/${host.projectId}/tables/${table.tableId}/cash-outs`);
    await assert.rejects(host.tables.cashOut(table.tableId, input), (error: any) => error.outcomeUnknown === true);
    await host.close();
    host = await startSpawnTestHost({ players: 2, balance: '100', databasePath });
    assert.equal(host.players[0].playerId, playerId);
    assert.equal(host.players[0].balance(), '100', 'restart must not re-fund players');
    await host.tables.cashOut(table.tableId, input);
    assert.equal(host.players[0].balance(), '100', 'retry must not pay twice');
    assert.equal((await host.tables.status(table.tableId)).totals.cashOuts, '20');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('local launch grants reject expired membership rather than signing a fresh admission', async () => {
  const host = await startSpawnTestHost({ players: 1, gameUrl: 'http://127.0.0.1:31999' });
  try {
    const player = host.players[0];
    assert.equal(player.grant().ticket.split('.').length, 3);
    host.advance(24 * 60 * 60 * 1000 + 1);
    assert.throws(() => player.grant(), /expired|unavailable/);
    const capability = new URL(player.url).hash.slice(5);
    const response = await fetch(host.origin + '/__spawn/grant', { method: 'POST', headers: { 'x-spawn-test-session': capability } });
    assert.equal(response.status, 401);
  } finally { await host.close(); }
});

test('a lost optional payment or payout response is reconciled by the same recorded operation', async () => {
  const host = await startSpawnTestHost({ players: 1 });
  try {
    const player = host.players[0];
    const base = `/api/v1/game-sessions/${player.launchId}/token-payment-quotes`;
    const input = { amount: '1', requestId: randomUUID() };
    const q = await (await player.fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).json();
    const confirmation = `/api/v1/token-payment-quotes/${q.id}/confirm`;
    host.loseNextResponse(confirmation);
    await assert.rejects(player.fetch(confirmation, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: q.version }) }));
    const replay = await (await player.fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).json();
    assert.equal(replay.status, 'paid');
    assert.equal(replay.receipt.id, q.id);
    assert.equal(player.balance(), '99000000000000000000');
    const operation = { operationId: randomUUID(), playerId: player.playerId, amount: '1000000000000000000', depositId: q.id, reason: 'test redemption' };
    host.loseNextResponse(`/api/v1/registered-games/${host.projectId}/payouts`);
    await assert.rejects(host.payouts.create(operation), (error: any) => error.outcomeUnknown === true);
    const recorded = await host.payouts.operation(operation.operationId);
    const retried = await host.payouts.create(operation);
    assert.deepEqual(retried, recorded);
    assert.equal(player.balance(), '100000000000000000000');
  } finally { await host.close(); }
});

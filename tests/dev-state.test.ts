import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTestState } from '../src/dev/state.ts';

test('local fixtures isolate player saves and require versioned updates', () => {
  const state = new LocalTestState();
  assert.equal(state.identity('alice').displayName, 'Alice (local test)');
  assert.equal(state.save('alice', 'progress', { level: 2 }, 0).version, 1);
  assert.equal(state.load('bob', 'progress'), null);
  assert.throws(() => state.save('alice', 'progress', {}, 0), /changed/);
  assert.throws(() => state.save('alice', '../private', {}, 0), /key/);
});
test('a quote does not debit; cancellation spends nothing; confirmation is exact and idempotent', () => {
  const state = new LocalTestState();
  const quote = state.quote('alice', 'launch1', 'entry');
  assert.equal(state.balance('alice'), 100);
  state.cancel(quote.id);
  assert.equal(state.balance('alice'), 100);
  assert.throws(() => state.confirm(quote.id), /cancelled/);
  const second = state.quote('alice', 'launch1', 'entry');
  const receipt = state.confirm(second.id);
  assert.equal(receipt.amount, 10);
  assert.equal(state.balance('alice'), 90);
  assert.equal(state.confirm(second.id).id, receipt.id);
  assert.equal(state.quote('alice', 'launch1', 'entry').receipt?.id, receipt.id);
  assert.equal(state.balance('bob'), 100);
  assert.throws(() => state.quote('empty', 'launch2', 'entry'), /balance/);
  assert.throws(() => state.quote('alice', 'launch2', 'arbitrary'), /entry/);
  assert.equal(state.economy.history.length, 1);
});
test('scores never pay rewards and local records have explicit non-production IDs', () => {
  const state = new LocalTestState();
  const result = state.score('alice', 42, {});
  assert.equal(result.verification, 'unverified');
  assert.match(result.id, /^local_/);
  assert.equal(state.balance('alice'), 100);
});

test('local nested saves follow hosted limits and support metadata listing and versioned removal', () => {
  const state = new LocalTestState();
  const value = { inventory: { slots: [[{ id: 'sword', count: 2 }]] }, equipment: [null, 'hat'], xp: 12.5, active: true };
  state.save('alice', 'inventory', value, 0);
  assert.deepEqual(state.load('alice', 'inventory')?.value, value);
  assert.deepEqual(state.listSaves('bob').items, []);
  assert.equal(state.listSaves('alice').items[0].key, 'inventory');
  assert.throws(() => state.save('alice', '_spawn_score_fake', {}, 0), /key/);
  assert.throws(() => state.save('alice', 'large', 'x'.repeat(65536), 0), /limit/);
  assert.throws(() => state.remove('alice', 'inventory', 2), /changed/);
  state.remove('alice', 'inventory', 1);
  assert.equal(state.load('alice', 'inventory'), null);
});

test('local leaderboards require operator opt-in, apply one-player policy and retry IDs', () => {
  const state = new LocalTestState();
  assert.throws(() => state.getLeaderboard(), /enabled/);
  state.leaderboard = { enabled: true, mode: 'best', direction: 'higher' };
  const id = crypto.randomUUID();
  const a = state.score('alice', 20, { secret: 'do not share' }, id);
  assert.deepEqual(state.score('alice', 20, { secret: 'do not share' }, id), a);
  assert.throws(() => state.score('alice', 21, {}, id), /already/);
  state.score('alice', 10, {});
  state.score('bob', 15, {});
  assert.deepEqual(state.getLeaderboard().items.map(row => row.score), [20, 15]);
  assert.equal(JSON.stringify(state.getLeaderboard()).includes('secret'), false);
  state.leaderboard.mode = 'latest';
  assert.deepEqual(state.getLeaderboard().items.map(row => row.score), [15, 10]);
  state.leaderboard.mode = 'all';
  assert.equal(state.getLeaderboard({ limit: 1 }).nextOffset, 1);
  assert.throws(() => state.getLeaderboard({ limit: 51 }), /limit/);
});

test('guest fixtures have stable unique IDs and cannot use account records or tokens',()=>{
 const state=new LocalTestState(),guest=state.identity('guest');
 assert.equal(guest.isGuest,true);assert.equal(state.identity('guest').id,guest.id);
 assert.notEqual(new LocalTestState().identity('guest').id,guest.id);
 assert.equal(guest.capabilities?.payments,false);
 for(const action of [()=>state.score('guest',10,{}),()=>state.save('guest','x',{},0),()=>state.load('guest','x'),()=>state.quote('guest','launch','entry')])assert.throws(action,/sign in/i);
 assert.equal(state.scores.length,0);assert.equal(state.economy.history.length,0);
});

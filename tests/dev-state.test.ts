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
  assert.equal(state.history.length, 1);
});
test('scores never pay rewards and local records have explicit non-production IDs', () => {
  const state = new LocalTestState();
  const result = state.score('alice', 42, {});
  assert.equal(result.verification, 'unverified');
  assert.match(result.id, /^local_/);
  assert.equal(state.balance('alice'), 100);
});

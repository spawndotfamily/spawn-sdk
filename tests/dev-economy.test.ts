import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTestState } from '../src/dev/state.ts';

const balances = (state: LocalTestState) => ['alice', 'bob', 'empty', 'creator', 'pool', 'platform'].map(account => state.economy.balance(account));

test('confirmed entry credits the creator pool once, including retries', () => {
  const state = new LocalTestState();
  assert.ok(state.economy, 'local testing needs a creator pool');
  const cancelled = state.quote('alice', 'cancelled', 'entry');
  state.cancel(cancelled.id);
  assert.deepEqual(balances(state), [100, 100, 0, 1000, 0, 0]);
  const quote = state.quote('alice', 'launch', 'entry');
  const receipt = state.confirm(quote.id);
  assert.equal(state.confirm(quote.id).id, receipt.id);
  assert.deepEqual(balances(state), [90, 100, 0, 1000, 9.5, .5]);
  assert.equal(state.economy.history.length, 1);
  assert.equal(state.economy.history[0].id, receipt.id);
});

test('local creator funding, manual rewards and withdrawals conserve TEST balances', () => {
  const state = new LocalTestState();
  assert.ok(state.economy, 'local testing needs creator controls');
  state.economy.fund(50);
  state.economy.reward('bob', 20);
  state.economy.withdraw(27.5);
  assert.deepEqual(balances(state), [100, 120, 0, 977.5, 0, 2.5]);
  assert.equal(balances(state).reduce((sum, value) => sum + value, 0), 1200);
  assert.deepEqual(state.economy.history.map(item => item.kind), ['withdrawal', 'reward', 'funding']);
  assert.deepEqual(balances(new LocalTestState()), [100, 100, 0, 1000, 0, 0]);
});

test('invalid or unfunded local transfers leave every balance and receipt unchanged', () => {
  const state = new LocalTestState();
  assert.ok(state.economy, 'local testing needs validated transfers');
  state.economy.fund(20);
  const before = balances(state), history = state.economy.history;
  for (const amount of [0, -1, 0.001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => state.economy.fund(amount));
    assert.throws(() => state.economy.reward('alice', amount));
    assert.throws(() => state.economy.withdraw(amount));
  }
  assert.throws(() => state.economy.fund(981), /balance/);
  assert.throws(() => state.economy.reward('alice', 21), /balance/);
  assert.throws(() => state.economy.withdraw(21), /balance/);
  assert.throws(() => state.economy.reward('creator', 10), /player/);
  assert.deepEqual(balances(state), before);
  assert.deepEqual(state.economy.history, history);
});

test('scores stay unverified for manual inspection without transferring rewards', () => {
  const state = new LocalTestState();
  assert.ok(state.economy, 'local testing needs a reward pool');
  state.economy.fund(50);
  const result = state.score('empty', 42, { stage: 1 });
  assert.deepEqual(state.scores[0], { ...result, player: 'empty', score: 42, details: { stage: 1 } });
  assert.deepEqual(balances(state), [100, 100, 0, 950, 47.5, 2.5]);
  state.economy.reward('empty', 10);
  assert.equal(state.balance('empty'), 10);
  assert.equal(state.confirm(state.quote('empty', 'funded-player', 'entry').id).amount, 10);
  assert.equal(state.economy.balance('pool'), 47);
  const scores = state.scores; scores[0].details = { edited: true };
  assert.deepEqual(state.scores[0].details, { stage: 1 });
});

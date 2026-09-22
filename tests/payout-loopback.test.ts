// The loopback payout double is the creator-facing proof that a deposit -> claim ->
// redemption loop moves exactly the claimed amount, once. These tests run the double's
// own rules through the REAL SDK client (the service wires it to a fake platform), so a
// regression in either half fails here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSpawnPayoutClient } from '../src/payout-server.ts';
import { createLoopbackPayoutService, stubClient, PAYOUT_POLICY } from '../testing/loopback-payout-service.mjs';

/** Errors cross the dist/src boundary depending on how the client resolved; match by shape. */
function refused(error: unknown, status: number, pattern?: RegExp): boolean {
  const candidate = error as { name?: string; status?: number; outcomeUnknown?: boolean; reason?: string; message?: string };
  return (
    candidate?.name === 'SpawnPayoutRequestError' &&
    candidate.status === status &&
    candidate.outcomeUnknown === false &&
    (pattern === undefined || pattern.test(candidate.reason ?? candidate.message ?? ''))
  );
}

test('a paid deposit, claim and redemption move exactly the claimed amount and conserve the total', async () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '1000' } });
  assert.deepEqual(service.conservation().totals, {
    pool: '0',
    members: '1000',
    total: '1000',
    initial: '1000',
    deposits: '0',
    payouts: '0',
  });

  // The deposit a creator would see already paid: the member is debited, the pool credited.
  const deposit = service.deposit(member, '250');
  assert.equal(deposit.status, 'paid');
  assert.equal(deposit.playerId, member);
  assert.equal(service.pool(), '250');
  assert.equal(service.balance(member), '750');

  // The creator's claim: pay the member from the pool, against their own deposit.
  const operationId = randomUUID();
  const receipt = await service.client.create({
    operationId,
    playerId: member,
    amount: '250',
    depositId: deposit.depositId,
    reason: 'vault redemption',
  });
  assert.equal(receipt.status, 'paid');
  assert.equal(receipt.projectId, service.projectId);
  assert.equal(receipt.playerId, member);
  assert.equal(receipt.amount, '250');
  assert.equal(receipt.depositId, deposit.depositId);
  assert.equal(receipt.assetId, service.assetId);

  // Credited exactly the claimed amount; pool debited exactly that.
  assert.equal(service.balance(member), '1000');
  assert.equal(service.pool(), '0');
  assert.equal(service.state(member).lastPayout?.id, receipt.id);
  assert.deepEqual(service.state(member).deposits, [deposit]);

  // The operation read is the reconciliation path and returns the recorded receipt.
  assert.deepEqual(await service.client.operation(operationId), receipt);
  assert.equal(await service.client.operation(randomUUID()), null);

  const conservation = service.conservation();
  assert.equal(conservation.balanced, true);
  assert.equal(conservation.delta, '0');
  assert.equal(conservation.totals.total, '1000');
  assert.equal(conservation.totals.deposits, '250');
  assert.equal(conservation.totals.payouts, '250');
});

test('an identical retry returns the same receipt and pays exactly once, even after a lost response', async () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '0' }, pool: '100' });
  const input = { operationId: randomUUID(), playerId: member, amount: '40', reason: 'daily reward' };
  const first = await service.client.create(input);
  const replay = await service.client.create(input);
  assert.deepEqual(replay, first);
  assert.equal(service.balance(member), '40');
  assert.equal(service.pool(), '60');

  // A dropped response: the platform recorded the payout, the caller saw an unknown outcome.
  const retryId = randomUUID();
  service.loseNextResponse('create');
  await assert.rejects(service.client.create({ operationId: retryId, playerId: member, amount: '10' }), (error: unknown) => {
    const candidate = error as { outcomeUnknown?: boolean; operationId?: string };
    return candidate?.outcomeUnknown === true && candidate.operationId === retryId;
  });
  assert.equal(service.balance(member), '50');
  const recovered = await service.client.create({ operationId: retryId, playerId: member, amount: '10' });
  assert.deepEqual(await service.client.create({ operationId: retryId, playerId: member, amount: '10' }), recovered);
  assert.equal(service.balance(member), '50', 'the lost response moved money exactly once');
  assert.equal(service.pool(), '50');
});

test('the replay guard is load-bearing: the same body under a fresh operation ID pays again', async () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '0' }, pool: '100' });
  const input = { operationId: randomUUID(), playerId: member, amount: '30', reason: 'reward' };
  const first = await service.client.create(input);
  assert.deepEqual(await service.client.create(input), first);
  assert.equal(service.balance(member), '30');

  // The mutant: a caller that loses its operation ID and reissues a fresh one. Nothing
  // else in the platform dedupes, so this pays a second time — which is why the guard
  // (and the durable operation ID on the creator server) is what makes a retry safe.
  const mutant = createSpawnPayoutClient({
    platformOrigin: 'http://127.0.0.1:9999',
    projectId: service.projectId,
    credential: 'x'.repeat(43),
    fetch: (url, init) =>
      service.transport(url, {
        ...init,
        body: JSON.stringify({ ...JSON.parse(String(init?.body)), operationId: randomUUID() }),
      }),
  });
  const second = await mutant.create(input);
  assert.notEqual(second.id, first.id);
  assert.equal(service.balance(member), '60');
  assert.equal(service.conservation().balanced, true);
});

test('reusing an operation ID with a changed payload is a conflict and moves nothing', async () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '0' }, pool: '100' });
  const operationId = randomUUID();
  await service.client.create({ operationId, playerId: member, amount: '10', reason: 'reward' });
  await assert.rejects(
    service.client.create({ operationId, playerId: member, amount: '11', reason: 'reward' }),
    (error: unknown) => refused(error, 409, /Conflicting payout operation body/),
  );
  await assert.rejects(
    service.client.create({ operationId, playerId: member, amount: '10', reason: 'changed' }),
    (error: unknown) => refused(error, 409),
  );
  assert.equal(service.balance(member), '10');
  assert.equal(service.pool(), '90');
});

test('an overdraft is refused and moves nothing; exactly the pool is payable', async () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '0' }, pool: '25' });
  await assert.rejects(
    service.client.create({ operationId: randomUUID(), playerId: member, amount: '26' }),
    (error: unknown) => refused(error, 409, /cannot cover a payout/),
  );
  assert.equal(service.pool(), '25');
  assert.equal(service.balance(member), '0');
  await service.client.create({ operationId: randomUUID(), playerId: member, amount: '25' });
  assert.equal(service.pool(), '0');
  assert.equal(service.balance(member), '25');
  assert.equal(service.conservation().balanced, true);
});

test('a recipient who is not a registered member of the game is refused', async () => {
  const service = createLoopbackPayoutService({ members: { [randomUUID()]: '0' }, pool: '100' });
  const stranger = randomUUID();
  await assert.rejects(
    service.client.create({ operationId: randomUUID(), playerId: stranger, amount: '1' }),
    (error: unknown) => refused(error, 401, /not a registered member/),
  );
  assert.equal(service.pool(), '100');
  assert.equal(service.balance(stranger), null);
});

test('a deposit-referenced payout never exceeds that deposit summed across prior payouts', async () => {
  const member = randomUUID();
  const other = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '300', [other]: '0' }, pool: '0' });
  const deposit = service.deposit(member, '200');
  await service.client.create({ operationId: randomUUID(), playerId: member, amount: '120', depositId: deposit.depositId });
  await assert.rejects(
    service.client.create({ operationId: randomUUID(), playerId: member, amount: '81', depositId: deposit.depositId }),
    (error: unknown) => refused(error, 409, /capped at 200 base units; 120 is already redeemed/),
  );
  await service.client.create({ operationId: randomUUID(), playerId: member, amount: '80', depositId: deposit.depositId });
  assert.equal(service.balance(member), '300');
  assert.equal(service.pool(), '0');
  // The deposit belongs to the member who made it: another member cannot redeem it.
  await assert.rejects(
    service.client.create({ operationId: randomUUID(), playerId: other, amount: '1', depositId: deposit.depositId }),
    (error: unknown) => refused(error, 409, /belongs to another member/),
  );
  // An unknown reference is not a paid deposit.
  await assert.rejects(
    service.client.create({ operationId: randomUUID(), playerId: member, amount: '1', depositId: randomUUID() }),
    (error: unknown) => refused(error, 409, /not a paid deposit/),
  );
});

test('a payout without a deposit reference rewards any member and still conserves', async () => {
  const depositor = randomUUID();
  const winner = randomUUID();
  const service = createLoopbackPayoutService({ members: { [depositor]: '500', [winner]: '0' }, pool: '0' });
  service.deposit(depositor, '500');
  const receipt = await service.client.create({ operationId: randomUUID(), playerId: winner, amount: '200', reason: 'tournament prize' });
  assert.equal(receipt.depositId, null);
  assert.equal(service.balance(winner), '200');
  assert.equal(service.balance(depositor), '0');
  assert.equal(service.pool(), '300');
  assert.equal(service.conservation().balanced, true);
  assert.equal(service.conservation().totals.total, '500');
});

test('a launch-bound payout follows the active-launch chain; an unbound payout works at any time', async () => {
  const member = randomUUID();
  const launchId = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '0' }, launches: { [member]: launchId }, pool: '50' });
  await service.client.create({ operationId: randomUUID(), playerId: member, amount: '10', launchId });
  service.expireLaunch(member);
  await assert.rejects(
    service.client.create({ operationId: randomUUID(), playerId: member, amount: '10', launchId }),
    (error: unknown) => refused(error, 401, /active launch/),
  );
  // Redemption does not need a live launch: any registered member can be paid.
  await service.client.create({ operationId: randomUUID(), playerId: member, amount: '10' });
  assert.equal(service.balance(member), '20');
  assert.equal(service.pool(), '30');
});

test('the write rate bound is 60 per minute per game and recovers with the clock', async () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '0' }, pool: '100' });
  for (let index = 0; index < PAYOUT_POLICY.writesPerMinute; index += 1)
    await service.client.create({ operationId: randomUUID(), playerId: member, amount: '1' });
  await assert.rejects(
    service.client.create({ operationId: randomUUID(), playerId: member, amount: '1' }),
    (error: unknown) => {
      const candidate = error as { name?: string; status?: number; code?: string; retryAfterMs?: number };
      return candidate?.status === 429 && candidate.code === 'HTTP_RATE_LIMITED' &&
        Number.isInteger(candidate.retryAfterMs) && (candidate.retryAfterMs as number) <= 60_000;
    },
  );
  assert.equal(service.balance(member), '60');
  service.advance(60_000);
  await service.client.create({ operationId: randomUUID(), playerId: member, amount: '1' });
  assert.equal(service.balance(member), '61');
});

test('a suspended game or custody outage fails payouts with 503 and recovers on resume', async () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '0' }, pool: '10' });
  assert.equal(service.suspend('Custody is unavailable.'), 'Custody is unavailable.');
  await assert.rejects(
    service.client.create({ operationId: randomUUID(), playerId: member, amount: '1' }),
    (error: unknown) => {
      const candidate = error as { name?: string; status?: number; code?: string; outcomeUnknown?: boolean; reason?: string };
      return candidate?.status === 503 && candidate.code === 'HTTP_UNAVAILABLE' && candidate.outcomeUnknown === true &&
        candidate.reason === 'Custody is unavailable.';
    },
  );
  assert.equal(service.balance(member), '0');
  service.resume();
  await service.client.create({ operationId: randomUUID(), playerId: member, amount: '1' });
  assert.equal(service.balance(member), '1');
});

test('suspension leaves operation reads available for recovering an unknown payout outcome', async () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '0' }, pool: '10' });
  const operationId = randomUUID();
  service.loseNextResponse('create');
  await assert.rejects(
    service.client.create({ operationId, playerId: member, amount: '1' }),
    (error: unknown) => {
      const candidate = error as { outcomeUnknown?: boolean; operationId?: string };
      return candidate?.outcomeUnknown === true && candidate.operationId === operationId;
    },
  );
  service.suspend('Custody is unavailable.');
  const recorded = await service.client.operation(operationId);
  assert.equal(recorded?.amount, '1');
  assert.equal(service.balance(member), '1');
  assert.throws(() => service.loseNextResponse('operation'), /only supports.*create/i);
});

test('a game with no Listing token refuses payouts and cannot be forced to pay', async () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ assetId: null, members: { [member]: '0' }, pool: '10' });
  await assert.rejects(
    service.client.create({ operationId: randomUUID(), playerId: member, amount: '1' }),
    (error: unknown) => refused(error, 409, /No Listing token is configured/),
  );
  assert.equal(service.pool(), '10');
  assert.equal(service.balance(member), '0');
});

test('stubClient replaces one method and keeps the real client for the rest', async () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '0' }, pool: '10' });
  const client = stubClient(service.client, {
    create: async () => {
      throw new Error('payout route offline');
    },
  });
  await assert.rejects(client.create({ operationId: randomUUID(), playerId: member, amount: '1' }), /payout route offline/);
  assert.equal(await client.operation(randomUUID()), null);
  assert.equal(service.balance(member), '0');
  assert.equal(service.pool(), '10');
});

test('deposits require a funded registered member and a canonical amount', () => {
  const member = randomUUID();
  const service = createLoopbackPayoutService({ members: { [member]: '100' } });
  assert.throws(() => service.deposit(member, '0'), /greater than zero/);
  assert.throws(() => service.deposit(member, '1.5'), /base units/);
  assert.throws(() => service.deposit(member, '101'), /cannot deposit/);
  assert.throws(() => service.deposit(randomUUID(), '1'), /registered member/);
  assert.equal(service.deposit(member, 100).amount, '100');
  assert.equal(service.pool(), '100');
  assert.equal(service.balance(member), '0');
  assert.equal(service.conservation().balanced, true);
});

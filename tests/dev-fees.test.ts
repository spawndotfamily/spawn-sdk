import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTestEconomy } from '../src/dev/economy.ts';
test('new local transfers are one-to-one and retain zeroed legacy fee fields',()=>{
 const ledger=new LocalTestEconomy();const entry=ledger.entry('alice','entry-1');
 assert.equal(ledger.balance('pool'),10);assert.equal(ledger.balance('platform'),0);
 assert.equal(entry.platformFee,0);assert.equal(entry.netAmount,10);assert.equal(entry.feeBps,0);
 const funding=ledger.fund(1.01);
 assert.equal(funding.platformFee,0);assert.equal(funding.netAmount,1.01);assert.equal(funding.feeBps,0);
 ledger.reward('bob',10);assert.equal(ledger.balance('bob'),110);assert.equal(ledger.balance('pool'),1.01);assert.equal(ledger.balance('platform'),0);
});
test('nonzero local fee configuration cannot be used for future transfers',()=>{
 assert.throws(()=>new LocalTestEconomy(250),/disabled/);
 assert.throws(()=>new LocalTestEconomy(-1),/disabled/);
});

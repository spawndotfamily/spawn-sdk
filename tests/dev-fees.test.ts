import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTestEconomy } from '../src/dev/economy.ts';
test('local entry exposes platform fee and does not charge rewards',()=>{
 const ledger=new LocalTestEconomy();const entry=ledger.entry('alice','entry-1');
 assert.equal(ledger.balance('pool'),9.5);assert.equal(ledger.balance('platform'),.5);
 assert.equal(entry.platformFee,.5);assert.equal(entry.netAmount,9.5);
 ledger.reward('bob',9.5);assert.equal(ledger.balance('bob'),109.5);assert.equal(ledger.balance('pool'),0);assert.equal(ledger.balance('platform'),.5);
});
test('local platform fee is configurable and recipient receipts stay fixed',()=>{
 const ledger=new LocalTestEconomy(250);const entry=ledger.entry('alice','entry-1');
 assert.equal(entry.platformFee,.25);assert.equal(ledger.balance('pool'),9.75);
 assert.throws(()=>new LocalTestEconomy(-1));
});

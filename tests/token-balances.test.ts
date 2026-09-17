import assert from 'node:assert/strict';
import test from 'node:test';
import {createTokenMethods, validateBalancePlayers, validateTokenBalances} from '../src/token-balances.ts';
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const roster=[{playerId:id(2),launchId:id(12)},{playerId:id(3),launchId:id(13)}];
const asset={id:'erc20:46630:0x'+'1'.repeat(40),chainId:46630,address:'0x'+'1'.repeat(40),name:'Coin',symbol:'COIN',decimals:18,image:'',source:'spawn',enabled:true};
const response={projectId:id(1),asset,settingsVersion:1,observedAt:1800000000000,players:roster.map(p=>({playerId:p.playerId,balance:'1000000000000000001'}))};
test('standalone self and roster balances preserve exact units without trade creation',async()=>{
 const calls:unknown[]=[];
 const tokens=createTokenMethods(async payload=>{calls.push(payload);return {...response,players:Object.keys(payload).length?response.players:[response.players[0]]};});
 assert.equal((await tokens.balance()).balance,'1000000000000000001');
 assert.deepEqual(calls,[{}]);
 assert.equal('balances' in tokens,false);
 assert.equal(validateTokenBalances(response,roster).players.length,2);
});
test('balance adapter rejects malformed requests and mismatched or numeric responses',async()=>{
 let calls=0;
 const tokens=createTokenMethods(async()=>{calls++;return response;});
 assert.throws(()=>validateBalancePlayers([]));
 assert.throws(()=>validateBalancePlayers([roster[0],roster[0]]));
 assert.throws(()=>validateBalancePlayers([{playerId:'guest_bad',launchId:id(12)}]));
 assert.equal(calls,0);
 for(const bad of [{...response,players:[response.players[0]]},{...response,players:[...response.players].reverse().map(p=>({...p,balance:10}))},{...response,asset:{...asset,address:'0x'+'2'.repeat(40)}}]){
  assert.throws(()=>validateTokenBalances(bad,roster));
 }
});

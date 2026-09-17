import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createSpawnTokenClient} from '../src/token-server.ts';

test('the shipped creator example maps verified sessionId to the roster launchId and filters before sending',async()=>{
 const guide=readFileSync(new URL('../docs/token-balances.md',import.meta.url),'utf8');
 const snippet=[...guide.matchAll(/```js\n([\s\S]*?)```/g)].map(m=>m[1]).find(s=>s.includes('createSpawnTokenClient'))!;
 const code=snippet.replace(/^import .*;\n/gm,'');
 const project='10000000-1111-4111-8111-111111111111',playerId='20000000-1111-4111-8111-111111111111',sessionId='30000000-1111-4111-8111-111111111111';
 const sent:unknown[]=[];let calls=0;
 const asset={id:'erc20:46630:0x'+'1'.repeat(40),chainId:46630,address:'0x'+'1'.repeat(40),name:'Coin',symbol:'COIN',decimals:18,image:'',source:'spawn',enabled:true};
 const makeClient=(options:Parameters<typeof createSpawnTokenClient>[0])=>createSpawnTokenClient({...options,fetch:async(_url,init)=>{
  calls++;assert.deepEqual(JSON.parse(String(init?.body)),{players:[{playerId,launchId:sessionId}]});
  return Response.json({projectId:project,asset,settingsVersion:1,observedAt:1800000000000,players:[{playerId,balance:'123'}]});
 }});
 const execute=new Function('readFile','createSpawnTokenClient','configuredGameId','configuredPrivateMatchKeyPath','activeVerifiedMembers','connectedViewers','maySeeBalance','sendTo','return (async()=>{'+code+'})()');
 await execute(async()=> 'k'.repeat(43),makeClient,project,'fixture.key',[{playerId,sessionId}],['allowed','hidden'],(viewer:string)=>viewer==='allowed',(viewer:string,value:unknown)=>sent.push({viewer,value}));
 assert.equal(calls,1);assert.deepEqual((sent[0] as any).value.players,[{playerId,balance:'123'}]);assert.deepEqual((sent[1] as any).value.players,[]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {createSpawnTokenClient, SpawnTokenBalanceError} from '../src/token-server.ts';
const project='10000000-1111-4111-8111-111111111111';
const player={playerId:'20000000-1111-4111-8111-111111111111',launchId:'30000000-1111-4111-8111-111111111111'};
const credential='k'.repeat(43);
const asset={id:'erc20:46630:0x'+'1'.repeat(40),chainId:46630,address:'0x'+'1'.repeat(40),name:'Coin',symbol:'COIN',decimals:18,image:'',source:'spawn',enabled:true};
const snapshot={projectId:project,asset,settingsVersion:1,observedAt:1800000000000,players:[{playerId:player.playerId,balance:'1000000000000000001'}]};
const options={platformOrigin:'https://spawn.example',projectId:project,credential};
test('server roster reads use dedicated authorization, exact origin, no cookies or redirects',async()=>{
 let calls=0;
 const client=createSpawnTokenClient({...options,fetch:async(url,init)=>{
  calls++;assert.equal(url,options.platformOrigin+'/api/v1/registered-games/'+project+'/token-balances');
  assert.equal(init?.method,'POST');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+credential);
  assert.deepEqual(JSON.parse(String(init?.body)),{players:[player]});
  return Response.json(snapshot);
 }});
 assert.deepEqual(await client.balances([player]),snapshot);assert.equal(calls,1);
});
test('server balance reader rejects bad scope, guest roster, oversized responses and no implicit retry',async()=>{
 for(const platformOrigin of ['http://spawn.example','https://spawn.example/path','https://spawn.example/','https://u:p@spawn.example'])
  assert.throws(()=>createSpawnTokenClient({...options,platformOrigin}));
 let calls=0;
 const client=createSpawnTokenClient({...options,fetch:async()=>{calls++;throw new Error(credential);}});
 await assert.rejects(client.balances([{...player,playerId:'guest_fake'}]));assert.equal(calls,0);
 await assert.rejects(client.balances([player]),e=>e instanceof SpawnTokenBalanceError && e.code==='NETWORK_ERROR' && !e.message.includes(credential));assert.equal(calls,1);
 for(const response of [Response.json({...snapshot,projectId:player.playerId}),new Response(' '.repeat(65537))])
  await assert.rejects(createSpawnTokenClient({...options,fetch:async()=>response}).balances([player]),e=>e instanceof SpawnTokenBalanceError && e.code==='INVALID_RESPONSE');
});
test('server balance errors retain status, safe reason, and retry-after without credentials',async()=>{
 await assert.rejects(createSpawnTokenClient({...options,fetch:async()=>Response.json({error:'Each player needs an active published or authorized game launch.'},{status:401})}).balances([player]),e=>e instanceof SpawnTokenBalanceError && e.status===401 && e.reason?.includes('active')===true);
 await assert.rejects(createSpawnTokenClient({...options,fetch:async()=>Response.json({error:credential},{status:429,headers:{'retry-after':'60'}})}).balances([player]),e=>e instanceof SpawnTokenBalanceError && e.status===429 && e.retryAfterMs===60000 && !JSON.stringify(e).includes(credential));
});

test('remote balance reads reject local-chain identities and amounts beyond uint256',async()=>{
 const localAsset={...asset,chainId:31337,id:'erc20:31337:'+asset.address};
 for(const bad of [{...snapshot,asset:localAsset},{...snapshot,players:[{playerId:player.playerId,balance:(2n**256n).toString()}]}])
  await assert.rejects(createSpawnTokenClient({...options,fetch:async()=>Response.json(bad)}).balances([player]),e=>e instanceof SpawnTokenBalanceError && e.code==='INVALID_RESPONSE');
 const local=createSpawnTokenClient({...options,platformOrigin:'http://127.0.0.1:3002',fetch:async()=>Response.json({...snapshot,asset:localAsset})});
 assert.equal((await local.balances([player])).asset.chainId,31337);
});

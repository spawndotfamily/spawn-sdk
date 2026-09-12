import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpawnMultiplayerClient} from '../src/multiplayer.ts';
const platformOrigin='https://spawn.example',serverOrigin='https://game.example';
function fixture(){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),listeners=new Map<string,Set<(e:any)=>void>>(),sent:any[]=[];
 const parent={postMessage:(value:any,target:string)=>sent.push({value,target})};
 const win={parent,location:{hash:'#spawnBridge='+'a'.repeat(43)},addEventListener(type:string,fn:(e:any)=>void){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(fn);},removeEventListener(type:string,fn:(e:any)=>void){listeners.get(type)?.delete(fn);}};
 Object.defineProperty(globalThis,'window',{configurable:true,value:win});
 const emit=(type:string,e:any)=>{for(const fn of listeners.get(type)||[])fn(e);};
 return {parent,win,sent,emit,restore(){if(previous)Object.defineProperty(globalThis,'window',previous);else delete (globalThis as any).window;}};
}
function port(){return {sent:[] as any[],onmessage:null as null|((event:any)=>void),onmessageerror:null as null|(()=>void),closed:false,start(){},close(){this.closed=true;},postMessage(value:any){this.sent.push(value);},emit(value:any){this.onmessage?.({data:value});}};}
function connect(f:ReturnType<typeof fixture>,p:ReturnType<typeof port>,type='spawn:multiplayer-offer'){
 const nonce=f.sent[0].value.nonce;f.emit('message',{source:f.parent,origin:platformOrigin,data:{type,version:1,nonce},ports:[p]});return nonce;
}
test('multiplayer grant waits for exact parent confirmation and coalesces pending requests',async()=>{
 const f=fixture(),p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 try{
  const one=client.requestGrant(),two=client.requestGrant();const nonce=connect(f,p);assert.equal(p.sent[0].type,'spawn:multiplayer-ack');assert.equal(p.sent.length,1);
  p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();await Promise.resolve();assert.equal(p.sent.length,2);
  p.emit({type:'spawn:multiplayer-grant',version:1,nonce,requestId:p.sent[1].requestId,ticket:'fixture.signed.proof',serverOrigin});
  assert.deepEqual(await one,{ticket:'fixture.signed.proof'});assert.deepEqual(await two,{ticket:'fixture.signed.proof'});assert.equal(f.sent[0].target,platformOrigin);
 }finally{client.dispose();f.restore();}
});
test('wrong parent, legacy namespace and mismatched endpoint never establish account proof',async()=>{
 const f=fixture(),p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 try{
  const nonce=f.sent[0].value.nonce;f.emit('message',{source:{},origin:platformOrigin,data:{type:'spawn:multiplayer-offer',version:1,nonce},ports:[p]});assert.equal(p.sent.length,0);
  connect(f,p,'rtr:bridge-offer');assert.equal(p.sent.length,0);connect(f,p);p.emit({type:'rtr:bridge-confirm',version:1,nonce});assert.equal(p.sent.length,1);
  p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();const pending=client.requestGrant();await Promise.resolve();
  p.emit({type:'spawn:multiplayer-grant',version:1,nonce,requestId:p.sent.at(-1).requestId,ticket:'fixture.signed.proof',serverOrigin:'https://other.example'});await assert.rejects(pending,/invalid/i);
 }finally{client.dispose();f.restore();}
});
test('navigation closes the channel and rejects pending work without reconnecting',async()=>{
 const f=fixture(),p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 try{const nonce=connect(f,p);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();const pending=client.requestGrant();await Promise.resolve();f.emit('pagehide',{});await assert.rejects(pending,/closed/i);assert.equal(p.closed,true);assert.throws(()=>createSpawnMultiplayerClient({platformOrigin,serverOrigin}),/closed/i);}finally{client.dispose();f.restore();}
});
test('exact secure origins and one document capability are required',()=>{
 for(const options of [{platformOrigin:'http://spawn.example',serverOrigin},{platformOrigin,serverOrigin:'https://game.example/path'},{platformOrigin,serverOrigin:platformOrigin}]){const f=fixture();try{assert.throws(()=>createSpawnMultiplayerClient(options));}finally{f.restore();}}
 const f=fixture();try{f.win.location.hash+='&spawnBridge='+'b'.repeat(43);assert.throws(()=>createSpawnMultiplayerClient({platformOrigin,serverOrigin}),/document/i);}finally{f.restore();}
});
test('handshake and grant deadlines close or reject without returning unverified identity',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const f=fixture(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 try{const rejected=assert.rejects(client.ready(),/closed/i);t.mock.timers.tick(8000);await rejected;assert.throws(()=>createSpawnMultiplayerClient({platformOrigin,serverOrigin}),/closed/i);}finally{client.dispose();f.restore();}
 const next=fixture(),p=port(),connected=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 try{const nonce=connect(next,p);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await connected.ready();const pending=connected.requestGrant();await Promise.resolve();const rejected=assert.rejects(pending,/did not respond/i);t.mock.timers.tick(8000);await rejected;}finally{connected.dispose();next.restore();}
});
test('channel failure rejects pending grants and permanently closes the document',async()=>{
 const f=fixture(),p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 try{const nonce=connect(f,p);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();const pending=client.requestGrant();await Promise.resolve();p.onmessageerror?.();await assert.rejects(pending,/closed/i);assert.equal(p.closed,true);assert.throws(()=>createSpawnMultiplayerClient({platformOrigin,serverOrigin}),/closed/i);}finally{client.dispose();f.restore();}
});
test('responses require the exact envelope, active nonce, current request and bounded proof',async()=>{
 const f=fixture(),p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 try{
  const nonce=connect(f,p);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();
  const pending=client.requestGrant();await Promise.resolve();const requestId=p.sent.at(-1).requestId;
  const reply={type:'spawn:multiplayer-grant',version:1,nonce,requestId,ticket:'fixture.signed.proof',serverOrigin};
  let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
  for(const override of [{type:'rtr:grant'},{nonce:'old'},{requestId:'old'},{extra:true}])p.emit({...reply,...override});
  await Promise.resolve();assert.equal(settled,false);p.emit({...reply,ticket:'x'.repeat(4097)});await assert.rejects(pending,/invalid/i);
  const failure=client.requestGrant();await Promise.resolve();p.emit({type:'spawn:multiplayer-grant-error',version:1,nonce,requestId:p.sent.at(-1).requestId,message:'untrusted external text'});
  await assert.rejects(failure,error=>error instanceof Error&&!error.message.includes('untrusted external text'));
 }finally{client.dispose();f.restore();}
});


test('slow initial document loading has its own bounded phase before confirmation',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const f=fixture();(f.win as any).document={readyState:'loading'};
 const p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 try{
  let failed=false;void client.ready().catch(()=>{failed=true;});
  t.mock.timers.tick(9500);await Promise.resolve();assert.equal(failed,false);
  f.emit('load',{});const nonce=connect(f,p);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();
  assert.equal(p.closed,false);t.mock.timers.tick(45000);assert.equal(p.closed,false);
 }finally{client.dispose();f.restore();}
});
test('a document that never finishes loading is closed without an unbounded handshake',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const f=fixture();(f.win as any).document={readyState:'loading'};
 const client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 try{const rejected=assert.rejects(client.ready(),/closed/i);t.mock.timers.tick(45000);await rejected;assert.throws(()=>createSpawnMultiplayerClient({platformOrigin,serverOrigin}),/closed/i);}finally{client.dispose();f.restore();}
});


test('connection presentation uses only confirmed port and exact bounded state',async()=>{
 const f=fixture(),p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 try{
  assert.equal(client.reportConnection('ready'),false);const nonce=connect(f,p);
  assert.equal(client.reportConnection('ready'),false);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();
  assert.equal(client.reportConnection('ready'),true);
  assert.deepEqual(p.sent.at(-1),{type:'spawn:multiplayer-connection-state',state:'ready',version:1,nonce});
  const count=p.sent.length;assert.equal(client.reportConnection('ready'),false);assert.equal(client.reportConnection('bogus' as any),false);assert.equal(p.sent.length,count);
  assert.equal(client.reportConnection('disconnected'),true);client.dispose();assert.equal(client.reportConnection('ready'),false);
 }finally{client.dispose();f.restore();}
});

test('resource refresh arrives on the established grant request without replacing the client', async () => {
 const f=fixture(), p=port(), paths:string[]=[];
 const client=createSpawnMultiplayerClient({platformOrigin,serverOrigin,onResourcePath:path=>paths.push(path)});
 try {
  const nonce=connect(f,p);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();
  for(const path of ['/preview/first/','/preview/renewed/']){
   const request=client.requestGrant();await Promise.resolve();const requestId=p.sent.at(-1).requestId;
   p.emit({type:'spawn:multiplayer-resource',version:1,nonce,requestId,path});
   p.emit({type:'spawn:multiplayer-grant',version:1,nonce,requestId,ticket:'fixture.proof',serverOrigin});
   assert.deepEqual(await request,{ticket:'fixture.proof'});
  }
  assert.deepEqual(paths,['/preview/first/','/preview/renewed/']);assert.equal(f.sent.length,1);
 }finally{client.dispose();f.restore();}
});

test('match entry presentation request shares the confirmed port without blocking grant renewal',async()=>{
 const f=fixture(),p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 const matchId='123e4567-e89b-42d3-a456-426614174000';
 try{
  const nonce=connect(f,p);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();
  const entry=client.requestMatchEntry({matchId}),grant=client.requestGrant();await Promise.resolve();
  const request=p.sent.find(message=>message.type==='spawn:multiplayer-payment-request');
  assert.equal(request.type,'spawn:multiplayer-payment-request');assert.match(request.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  assert.equal(request.matchId,matchId);assert.equal(request.version,1);assert.equal(request.nonce,nonce);
  assert.equal(p.sent.some(message=>message.type==='spawn:multiplayer-grant-request'),true);
  p.emit({type:'spawn:multiplayer-payment-result',version:1,nonce,requestId:request.requestId,matchId,status:'reserved'});
  assert.deepEqual(await entry,{matchId,status:'reserved'});
  const grantRequest=p.sent.find(message=>message.type==='spawn:multiplayer-grant-request');
  p.emit({type:'spawn:multiplayer-grant',version:1,nonce,requestId:grantRequest.requestId,ticket:'fixture.signed.proof',serverOrigin});
  assert.deepEqual(await grant,{ticket:'fixture.signed.proof'});
 }finally{client.dispose();f.restore();}
});

test('match entry accepts only its exact response and sanitizes platform errors',async()=>{
 const f=fixture(),p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 const matchId='123e4567-e89b-42d3-a456-426614174000';
 try{
  const nonce=connect(f,p);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();
  const invalid=client.requestMatchEntry({matchId:'not-a-match'});
  await assert.rejects(invalid,/match/i);assert.equal(p.sent.length,1);
  const entry=client.requestMatchEntry({matchId});await Promise.resolve();
  const request=p.sent.find(message=>message.type==='spawn:multiplayer-payment-request');
  let settled=false;void entry.then(()=>{settled=true;},()=>{settled=true;});
  for(const override of [{requestId:'00000000-0000-4000-8000-000000000000'},{matchId:'223e4567-e89b-42d3-a456-426614174000'},{status:'started'},{extra:true}])
   p.emit({type:'spawn:multiplayer-payment-result',version:1,nonce,requestId:request.requestId,matchId,status:'reserved',...override});
  await Promise.resolve();assert.equal(settled,false);
  p.emit({type:'spawn:multiplayer-payment-error',version:1,nonce,requestId:request.requestId,matchId,message:'private server response'});
  await assert.rejects(entry,error=>error instanceof Error&&!error.message.includes('private server response'));
 }finally{client.dispose();f.restore();}
});

test('one match entry can be pending, same-match requests coalesce, and disposal leaves its outcome indeterminate',async()=>{
 const f=fixture(),p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 const matchId='123e4567-e89b-42d3-a456-426614174000';
 try{
  const nonce=connect(f,p);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();
  const first=client.requestMatchEntry({matchId}),same=client.requestMatchEntry({matchId});
  await assert.rejects(client.requestMatchEntry({matchId:'223e4567-e89b-42d3-a456-426614174000'}),/pending/i);
  await Promise.resolve();assert.equal(p.sent.filter(message=>message.type==='spawn:multiplayer-payment-request').length,1);
  client.dispose();
  await assert.rejects(first,/status is unknown/i);
  await assert.rejects(same,/status is unknown/i);
  assert.equal(p.closed,true);
 }finally{client.dispose();f.restore();}
});

test('match entry request expires after its bounded two-minute presentation window',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const f=fixture(),p=port(),client=createSpawnMultiplayerClient({platformOrigin,serverOrigin});
 const matchId='123e4567-e89b-42d3-a456-426614174000';
 try{
  const nonce=connect(f,p);p.emit({type:'spawn:multiplayer-confirm',version:1,nonce});await client.ready();
  const entry=client.requestMatchEntry({matchId});await Promise.resolve();
  const rejected=assert.rejects(entry,/status is unknown/i);t.mock.timers.tick(120000);await rejected;
  assert.equal(p.closed,false);
 }finally{client.dispose();f.restore();}
});

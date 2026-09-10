import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpawnStartup} from '../src/startup.ts';
const user={id:'player-1',displayName:'Player'};
const deferred=()=>{let resolve!:(v:typeof user)=>void;const promise=new Promise<typeof user>(r=>resolve=r);return {promise,resolve};};
test('no play before verified connection; simultaneous retries share one attempt',async()=>{
 const d=deferred();let calls=0;const gate=createSpawnStartup({connect:()=>{calls++;return d.promise;}});
 assert.equal(gate.state.status,'blocked');const a=gate.connect(),b=gate.connect();assert.equal(a,b);assert.equal(gate.state.status,'connecting');
 d.resolve(user);await a;assert.equal(calls,1);assert.equal(gate.state.status,'ready');assert.equal(gate.state.identity?.id,user.id);gate.dispose();
});
test('failed identity never starts; retry obtains fresh identity',async()=>{
 let calls=0;const gate=createSpawnStartup({connect:async()=>{if(++calls===1)throw new Error('Connection unavailable');return user;}});
 await assert.rejects(gate.connect());assert.equal(gate.state.status,'blocked');assert.equal(gate.state.identity,null);await gate.connect();assert.equal(gate.state.status,'ready');gate.dispose();
});
test('disconnect clears identity and stale response cannot unlock a newer attempt',async()=>{
 const a=deferred(),b=deferred();let calls=0,signal:AbortSignal|undefined;
 const gate=createSpawnStartup({connect:s=>{signal=s;return ++calls===1?a.promise:b.promise;}});
 const first=gate.connect();gate.invalidate();assert.equal(signal?.aborted,true);await assert.rejects(first);
 const second=gate.connect();a.resolve(user);await Promise.resolve();assert.equal(gate.state.status,'connecting');b.resolve({...user,id:'player-2'});await second;
 assert.equal(gate.state.identity?.id,'player-2');gate.invalidate();assert.equal(gate.state.identity,null);gate.dispose();
});
test('timeout is bounded and disposal cancels outstanding work',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal:AbortSignal|undefined;
 const gate=createSpawnStartup({connect:s=>{signal=s;return new Promise(()=>{});},timeoutMs:100});
 const attempt=gate.connect();t.mock.timers.tick(100);await assert.rejects(attempt,/timed out/i);assert.equal(signal?.aborted,true);assert.equal(gate.state.status,'blocked');
 const next=gate.connect();gate.dispose();await assert.rejects(next);await assert.rejects(gate.connect(),/closed/i);assert.equal(gate.state.status,'closed');
});
test('missing identity stays blocked and subscribers stop after unsubscribe',async()=>{
 const gate=createSpawnStartup({connect:async()=>null as unknown as typeof user});let changes=0;const stop=gate.subscribe(()=>changes++);stop();await assert.rejects(gate.connect(),/identity/i);assert.equal(changes,1);assert.equal(gate.state.identity,null);gate.dispose();
});

test('subscriber revocation during readiness cannot resolve a successful startup',async()=>{
 const gate=createSpawnStartup({connect:async()=>user});gate.subscribe(state=>{if(state.status==='ready')gate.invalidate();});
 await assert.rejects(gate.connect());assert.equal(gate.state.status,'blocked');gate.dispose();
});

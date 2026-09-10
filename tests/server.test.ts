import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {createSpawnLaunchVerifier} from '../src/server.ts';
const {publicKey,privateKey}=generateKeyPairSync('ed25519'),now=1700000000000;
const options={issuer:'https://spawn.example',audience:'creator-game-server',gameId:'creator-game',environment:'sandbox',publicKeys:{v1:publicKey.export({type:'spki',format:'pem'}).toString()},minimumIssuedAt:0,now:()=>now};
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
function grant(extra:Record<string,unknown>={}){const body={iss:options.issuer,aud:options.audience,gameId:options.gameId,environment:'sandbox',sub:randomUUID(),sid:randomUUID(),jti:randomUUID(),iat:now/1000-1,nbf:now/1000-1,exp:now/1000+60,scope:['multiplayer:join'],handle:'PlayerOne',displayName:'Player One',...extra},input=encode({alg:'EdDSA',typ:'JWT',kid:'v1'})+'.'+encode(body);return input+'.'+sign(null,Buffer.from(input),privateKey).toString('base64url');}
test('creator-owned server verifies explicit game, audience, environment and bounded claims',()=>{
 const verifier=createSpawnLaunchVerifier(options);assert.equal(verifier.configured,true);assert.equal(verifier.verify(grant()).handle,'PlayerOne');
 for(const extra of [{aud:'other-game-server'},{gameId:'other-game'},{environment:'live'},{exp:now/1000-1},{iat:now/1000+1},{exp:now/1000+121},{scope:['admin']},{displayName:'x'.repeat(65)}])assert.throws(()=>verifier.verify(grant(extra)),/invalid/i);
});
test('one-time consumption is bounded and expired replay entries make room',()=>{
 let clock=now;const verifier=createSpawnLaunchVerifier({...options,now:()=>clock,maxConsumedGrants:1}),first=grant();assert.ok(verifier.consume(first).playerId);assert.throws(()=>verifier.consume(first),/used/i);assert.throws(()=>verifier.consume(grant()),/capacity/i);
 clock+=61000;assert.ok(verifier.consume(grant({iat:clock/1000,nbf:clock/1000,exp:clock/1000+60})).playerId);
});
test('default startup epoch rejects grants from before this process and private keys are never accepted',()=>{
 const startup=createSpawnLaunchVerifier({...options,minimumIssuedAt:undefined});assert.throws(()=>startup.verify(grant()),/invalid/i);
 const privateVerifier=createSpawnLaunchVerifier({...options,publicKeys:{v1:privateKey.export({type:'pkcs8',format:'pem'}).toString()}});assert.equal(privateVerifier.configured,false);assert.throws(()=>privateVerifier.verify(grant()),/configured/i);
 assert.equal(createSpawnLaunchVerifier({...options,gameId:''}).configured,false);
});
test('verification pins an immutable copy of public configuration and exposes no private claims',()=>{
 const settings={...options,publicKeys:{...options.publicKeys}},verifier=createSpawnLaunchVerifier(settings);
 settings.audience='changed';settings.publicKeys.v1='changed';
 const result=verifier.verify(grant({email:'private-fixture@example.test',extra:{ignored:true}}));
 assert.deepEqual(Object.keys(result).sort(),['playerId','sessionId','grantId','handle','displayName','expiresAt','environment'].sort());assert.equal(Object.isFrozen(verifier),true);
});
test('every configured trust boundary is explicit and malformed proof fails with one bounded error',()=>{
 for(const field of ['issuer','audience','gameId','environment','publicKeys']){const config={...options};delete (config as any)[field];assert.equal(createSpawnLaunchVerifier(config).configured,false);}
 for(const maxConsumedGrants of [0,32769,NaN])assert.equal(createSpawnLaunchVerifier({...options,maxConsumedGrants}).configured,false);
 const verifier=createSpawnLaunchVerifier(options),ticket=grant();
 for(const invalid of ['',ticket+'=',ticket.replace(/.$/,'!'),'x'.repeat(4097),ticket.split('.').slice(0,2).join('.')])assert.throws(()=>verifier.verify(invalid),/^Error: Invalid Spawn launch grant\.$/);
});
test('pinned signature, exact headers, scope and labels reject altered or unsupported grants',()=>{
 const verifier=createSpawnLaunchVerifier(options),ticket=grant(),[header,payload,signature]=ticket.split('.');
 const claims=JSON.parse(Buffer.from(payload,'base64url').toString());
 const signed=(h:unknown,c:unknown)=>{const input=encode(h)+'.'+encode(c);return input+'.'+sign(null,Buffer.from(input),privateKey).toString('base64url');};
 const supported={alg:'EdDSA',typ:'JWT',kid:'v1'};
 assert.throws(()=>verifier.verify(header+'.'+encode({...claims,sub:'different-player'})+'.'+signature),/invalid/i);
 for(const changed of [{alg:'none'},{alg:'HS256'},{kid:'unknown'},{jku:'https://other.example/keys'},{typ:'other'}])assert.throws(()=>verifier.verify(signed({...supported,...changed},claims)),/invalid/i);
 for(const changed of [{scope:['multiplayer:join','admin']},{clientId:'other-player'},{client_id:'other-player'},{displayName:'unsafe\nlabel'},{sub:'x'.repeat(129)},{nbf:now/1000+6}])assert.throws(()=>verifier.verify(signed(supported,{...claims,...changed})),/invalid/i);
 assert.throws(()=>verifier.verify(signed(supported,[])),/invalid/i);
});

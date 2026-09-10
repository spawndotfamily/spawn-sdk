// Runs only on YOUR Node server. This module does not create or host a server.
import {readFile} from 'node:fs/promises';
import {createSpawnLaunchVerifier} from '@spawn/sdk/server';
// Obtain public verification configuration when Spawn enables your game.
// It contains issuer, audience, gameId, environment, publicKeys; no signing secrets.
const publicConfig=JSON.parse(await readFile('./spawn-public-config.json','utf8'));
const verifier=createSpawnLaunchVerifier(publicConfig);
if(!verifier.configured)throw new Error('Configure the public verification keys for this game.');
export function admitPlayer(ticket){
 // Rate-limit and size-limit your connection before calling this function.
 // Consume once, bind the returned playerId to the connection, and ignore claimed IDs.
 const identity=verifier.consume(ticket);
 return {playerId:identity.playerId,sessionId:identity.sessionId,handle:identity.handle,proofExpiresAt:identity.expiresAt};
}
// Implement your own transport, movement/combat authority, session expiry and storage.
// Admission proof is not an anti-cheat verdict, a payment receipt or a server credential.

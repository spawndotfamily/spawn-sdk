/** Standalone creator-side sample: real browser SDK + local authoritative server + Spawn approval. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createSpawnLaunchVerifier } from '@spawndotfamily/sdk/server';
import { startSpawnTestHost } from '@spawndotfamily/sdk/testing/local-host.mjs';

const sessions = new Map();
let host, verifier, tableId;
const game = createServer((request, response) => {
  // Opaque Spawn frames have Origin:null. Only this synthetic loopback example
  // serves them with CORS; every game action still requires a verified launch.
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  void (async () => {
    const path = new URL(request.url, gameOrigin).pathname;
    if (request.headers.host !== new URL(gameOrigin).host) throw new Error('Wrong Host');
    if (request.method === 'GET' && path === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><html><head><style>body{margin:24px;background:white;color:#202020;font:16px system-ui}button{padding:12px;margin:6px}</style></head><body><h1>Local multiplayer approval example</h1><p id="status">Connecting to Spawn…</p><button id="buy" disabled>Sit with 10 LOCAL</button><button id="shop" disabled>Buy item for 0.25 LOCAL</button><script type="module">
        import { createSpawnMultiplayerClient } from '/sdk/multiplayer.js';
        const sdk = createSpawnMultiplayerClient({ platformOrigin: ${JSON.stringify(host.origin)}, serverOrigin: ${JSON.stringify(gameOrigin)} });
        const status = document.querySelector('#status');
        let session;
        async function post(path, data) {
          const r = await fetch(path,{method:'POST',headers:{'content-type':'application/json',...(session?{authorization:'Bearer '+session}:{})},body:JSON.stringify(data)});
          const v = await r.json(); if(!r.ok) throw new Error(v.error); return v;
        }
        try {
          await sdk.ready(); const grant = await sdk.requestGrant();
          const identity = await post('/join',{ticket:grant.ticket}); session=identity.session;
          status.textContent='Joined as '+identity.displayName;
          document.querySelector('#buy').disabled=false; document.querySelector('#shop').disabled=false;
          sdk.reportConnection('ready');
        } catch(e) { status.textContent=e.message; }
        document.querySelector('#buy').onclick=async()=>{
          try { const q=await post('/buy-in',{}); const result=await sdk.tables.buyIn({tableId:q.tableId,buyInId:q.buyInId}); status.textContent='Buy-in '+result.status; }
          catch(e){status.textContent=e.message;}
        };
        document.querySelector('#shop').onclick=async()=>{
          try { const result=await sdk.requestTokenPayment({amount:'0.25',item:'Example item'}); status.textContent='Payment '+result.status; }
          catch(e){status.textContent=e.message;}
        };
      </script></body></html>`);
      return;
    }
    if (request.method === 'GET' && /^\/sdk\/[a-z-]+\.js$/.test(path)) {
      const file = new URL(path.slice('/sdk/'.length), import.meta.resolve('@spawndotfamily/sdk/multiplayer'));
      response.setHeader('content-type', 'text/javascript');
      response.end(await readFile(file)); return;
    }
    if (request.method !== 'POST' || !['/join', '/buy-in'].includes(path)) { response.writeHead(404).end(); return; }
    let text = '';
    for await (const chunk of request) { text += chunk; if(text.length>8192) throw new Error('Request too large'); }
    const input = JSON.parse(text);
    response.setHeader('content-type', 'application/json');
    if (path === '/join') {
      const identity = verifier.consume(input.ticket), session = randomUUID();
      sessions.set(session, identity);
      response.end(JSON.stringify({ session, displayName: identity.displayName })); return;
    }
    const identity = sessions.get(request.headers.authorization?.slice(7));
    if (!identity) throw new Error('Join through Spawn first');
    const quote = await host.tables.requestBuyIn(tableId,{operationId:randomUUID(),buyInId:randomUUID(),player:{playerId:identity.playerId,launchId:identity.sessionId},amount:'10000000000000000000'});
    response.end(JSON.stringify(quote));
  })().catch(error=>{response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:error.message}));});
});
let gameOrigin = '';
await new Promise(resolve=>game.listen(0,'127.0.0.1',resolve));
gameOrigin='http://127.0.0.1:'+game.address().port;
host=await startSpawnTestHost({players:6,gameUrl:gameOrigin});
verifier=createSpawnLaunchVerifier({...host.verification, minimumIssuedAt:Math.floor(Date.now()/1000)});
const table=await host.tables.create({tableId:randomUUID(),operationId:randomUUID(),maxSeats:6});tableId=table.tableId;
const heartbeat = setInterval(() => { void host.tables.heartbeat(tableId).catch(error => console.error(error.message)); }, 30000);
console.log('SIMULATION ONLY — open any of these independent players:');
for(const player of host.players) console.log(player.url);
const stop=async()=>{clearInterval(heartbeat);game.closeAllConnections();await new Promise(resolve=>game.close(resolve));await host.close();process.exit(0);};
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());

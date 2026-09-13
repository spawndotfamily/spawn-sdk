import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startLocalLauncher} from '../dist/dev/server.js';
test('rebuild validates new files, rotates document and rejects foreign rescan',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spawn-rescan-'));
 await writeFile(join(dir,'index.html'),'<!doctype html><html><body><p>old build</p></body></html>');
 const {server,origin}=await startLocalLauncher(dir,0);
 try {
  const html=await (await fetch(origin)).text();
  for (const path of ['/__spawn/host.js','/__spawn/state.js','/__spawn/panel.js','/__spawn/economy.js','/game-data.js']) {
   const module=await fetch(origin+path); assert.equal(module.status,200,path); assert.match(module.headers.get('content-type'),/javascript/);
  }
  const old=html.match(/data-document-token="([^"]+)"/)[1];
  assert.equal((await fetch(`${origin}/build/${old}/index.html`)).status,200);
  await writeFile(join(dir,'index.html'),'<!doctype html><html><body><p>new build content</p></body></html>');
  assert.equal((await fetch(`${origin}/build/${old}/index.html`)).status,409);
  assert.equal((await fetch(origin+'/__spawn/rescan',{method:'POST',headers:{origin:'https://example.com'}})).status,403);
  const response=await fetch(origin+'/__spawn/rescan',{method:'POST',headers:{origin}});
  assert.equal(response.status,200);
  const {documentToken}=await response.json(); assert.notEqual(documentToken,old);
  assert.equal((await fetch(`${origin}/build/${old}/index.html`)).status,404);
  assert.match(await (await fetch(`${origin}/build/${documentToken}/index.html`)).text(),/new build content/);
 } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

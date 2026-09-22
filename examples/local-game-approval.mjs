/** Run from the installed SDK: ordinary browser SDK + real local approval UI. */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { init, parse } from 'es-module-lexer/minimal';
import { startSpawnTestHost } from '@spawndotfamily/sdk/testing/local-host.mjs';

const directory = await mkdtemp(join(tmpdir(), 'spawn-approval-example-'));
let host;
try {
  // Copy the real package's browser module graph, preserving relative imports.
  // A normal game uses its own bundler instead; never copy only index.js.
  await init();
  const visited = new Map();
  async function copyModule(path) {
    if (visited.has(path)) return visited.get(path);
    // Neutral output names avoid the publisher's deliberate exclusion of files named token/key.
    const output = 'module-' + visited.size + '.js';
    visited.set(path, output);
    let source = await readFile(new URL('../dist/' + path, import.meta.url), 'utf8');
    const replacements = [];
    for (const item of parse(source)[0]) {
      if (!item.n?.startsWith('./')) continue;
      if (item.d !== -1) throw new Error('This example expects static browser imports.');
      replacements.push({ start: item.s, end: item.e, name: './' + await copyModule(join(dirname(path), item.n)) });
    }
    for (const replacement of replacements.reverse()) source = source.slice(0, replacement.start) + replacement.name + source.slice(replacement.end);
    await writeFile(join(directory, output), source);
    return output;
  }
  const entry = await copyModule('index.js');
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;background:white;color:#222;padding:24px}button{padding:16px;margin:8px}</style></head><body>
<h1>Ordinary game approval test</h1><p id="identity">Connecting…</p>
<button id="buy" disabled>Buy item for 0.25 LOCAL</button><p id="result"></p>
<script type="module">
import { createSpawnGameClient } from './${entry}';
const client = createSpawnGameClient();
const identity = await client.identity();
document.getElementById('identity').textContent = identity.displayName;
document.getElementById('buy').disabled = false;
document.getElementById('buy').onclick = async () => {
  const result = document.getElementById('result');
  try { const receipt = await client.requestTokenPayment({amount:'0.25',item:'Example item'}); result.textContent = 'Payment ' + receipt.status; }
  catch (error) { result.textContent = error.message; }
};
</script></body></html>`);
  host = await startSpawnTestHost({ players: 6, gameDirectory: directory });
  console.log('Spawn ordinary SDK approval example — simulated balances only.');
  for (const player of host.players) console.log(player.displayName + ': ' + player.url);
  const stop = () => { void host.close().then(() => rm(directory, { recursive: true, force: true })).then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) {
  await host?.close(); await rm(directory, { recursive: true, force: true });
  throw error;
}

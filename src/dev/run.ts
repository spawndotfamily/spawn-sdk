#!/usr/bin/env node
import { startLocalLauncher } from './server.ts';
const runtime = (globalThis as unknown as { process: { argv: string[]; exitCode?: number } }).process;
const args = runtime.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: spawn-dev <prebuilt-browser-directory> [--port 4174]\nLocal fake accounts only. No credentials or platform connection required.');
} else {
  try {
    if (args.length !== 1 && !(args.length === 3 && args[1] === '--port' && /^\d+$/.test(args[2]))) throw new Error('Use spawn-dev <directory> [--port <number>].');
    const { origin } = await startLocalLauncher(args[0], args[2] ? Number(args[2]) : 4174);
    console.log(`Spawn LOCAL TESTING: ${origin}\nFake accounts and TEST balances. No platform data is accessed. Stop with Ctrl+C.`);
  } catch (error) { console.error(error instanceof Error ? error.message : 'Local launcher failed.'); runtime.exitCode = 1; }
}

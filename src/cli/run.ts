#!/usr/bin/env node

// The local npm script executes the TypeScript source directly; the packaged
// bin executes the JavaScript emitted by tsc.
const entry = import.meta.url.endsWith('/run.ts') ? './index.ts' : './index.js';
const { main } = await import(entry);

const processValue = (globalThis as unknown as { process?: { exitCode?: number } }).process;
if (!processValue) throw new Error('The publishing CLI requires Node.js.');
processValue.exitCode = await main();

#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { startSpawnTestHost } from './local-host.mjs';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('spawn-test-host [--players 6] [--balance 100000000000000000000] [--port 4175] [--game-dir ./dist OR --game-url http://127.0.0.1:3000] [--database ./local-test.sqlite] [--config ./.spawn-local.json]\nUse --game-dir for createSpawnGameClient, --game-url for multiplayer. Fake local balances only. Config contains local test credentials: ignore it in Git.');
  process.exit(0);
}
const options = {}, names = { '--players': 'players', '--balance': 'balance', '--port': 'port', '--game-url': 'gameUrl', '--game-dir': 'gameDirectory', '--database': 'databasePath', '--config': 'config' };
try {
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]], value = args[i + 1];
    if (!name || !value || value.startsWith('--') || name in options) throw new Error('Unknown, duplicated or incomplete option: ' + args[i]);
    options[name] = ['players', 'port'].includes(name) ? Number(value) : value;
  }
  const { config, ...hostOptions } = options;
  const host = await startSpawnTestHost(hostOptions);
  if (config) {
    try { await writeFile(config, JSON.stringify({ simulated: true, ...host.clientOptions, verification: host.verification, players: host.players.map(({ playerId, launchId, displayName, url }) => ({ playerId, launchId, displayName, url })) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { await host.close(); throw error; }
  }
  console.log('Spawn local approval host — simulated balances, no tokens move.');
  console.log('Player 1: ' + host.players[0].url);
  console.log(host.players.length + ' synthetic players ready. ' + (config ? 'Local server configuration saved to ' + config + '.' : 'Use --config <new-file> to export local server configuration.'));
  const stop = () => { void host.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) { console.error(error.message); process.exitCode = 1; }

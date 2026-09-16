import { readFileSync } from 'node:fs';

const version = process.argv[2];
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || version !== pkg.version) {
  throw new Error('Release version must match the committed stable package version.');
}
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const sections = changelog.split(/^## /m).slice(1);
const matches = sections.filter(section => section.split('\n')[0].split(/\s/)[0] === version);
if (matches.length !== 1) throw new Error('Provide exactly one changelog section for this version.');
const body = matches[0].slice(matches[0].indexOf('\n') + 1).trim();
for (const heading of ['Added', 'Changed', 'Upgrade notes']) {
  if (!body.includes(`### ${heading}\n`)) throw new Error(`Missing release notes: ${heading}`);
}
console.log(`${body}\n\n[Install from npm](https://www.npmjs.com/package/@spawndotfamily/sdk/v/${version}) · [Release checks](https://github.com/spawndotfamily/spawn-sdk/actions/workflows/release.yml)`);

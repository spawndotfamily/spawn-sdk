import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version as string;

test('generates release notes without duplicating the GitHub release title', () => {
  const output = execFileSync(
    process.execPath,
    ['scripts/release-notes.mjs', packageVersion],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

  assert.match(output, /^### Added\n/m);
  assert.doesNotMatch(output, /^# SDK \d+\.\d+\.\d+\n/m);
});

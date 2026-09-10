import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoundedFile } from '../src/cli/files.ts';
test('build descriptor reads reject a file replaced after inspection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spawn-file-check-'));
  try {
    const file = join(dir, 'game.js'); await writeFile(file, 'original');
    const expected = await lstat(file); await writeFile(join(dir, 'new.js'), 'replacement');
    await rename(join(dir, 'new.js'), file);
    await assert.rejects(readBoundedFile(file, 100, expected), /changed/);
    assert.equal(new TextDecoder().decode(await readBoundedFile(file, 100)), 'replacement');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

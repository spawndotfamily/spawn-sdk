import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('bundled local approval host is traceable, intact and contains no deployment credentials', () => {
  const root = new URL('../testing/platform/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.simulated, true);
  assert.match(manifest.baseCommit, /^[0-9a-f]{40}$/);
  assert.match(manifest.sourceSha256, /^[0-9a-f]{64}$/);
  for (const name of Object.keys(manifest.files)) {
    const bytes = readFileSync(new URL(name, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[name]);
    const source = bytes.toString();
    assert.doesNotMatch(source, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\/Users\/lucas|194\.195\.90\.88|spawnvps|\/var\/lib\/spawn/);
  }
  assert.ok(manifest.inputs.some((path: string) => path.endsWith('table-buyin-confirmation.tsx')));
  assert.ok(manifest.inputs.some((path: string) => path.endsWith('table-bankroll/ledger.ts')));
});

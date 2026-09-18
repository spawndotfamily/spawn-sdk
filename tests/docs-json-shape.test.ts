// The docs state the `--json` payload (`{ title, total, passed, failed, results }`). A documented
// shape is a contract an agent asserts on, so assert the runner actually prints it — and that the
// docs and the runner cannot drift apart silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../testing/scenario-runner.mjs';

void test('the documented --json payload matches what the runner prints', () => {
  const printed: string[] = [];
  const summary = summarize([{ name: 'a scenario', ok: true }, { name: 'another', ok: false, error: 'nope' }], {
    json: true,
    log: (line: string) => printed.push(line),
  });
  const payload = JSON.parse(printed.join('\n'));
  assert.deepEqual(Object.keys(payload).sort(), ['failed', 'passed', 'results', 'title', 'total']);
  assert.deepEqual(Object.keys(summary).sort(), Object.keys(payload).sort());
  assert.deepEqual(
    Object.keys(payload.results[0]).sort(),
    ['name', 'ok'],
    'a passing result is { name, ok }',
  );
  assert.deepEqual(
    Object.keys(payload.results[1]).sort(),
    ['error', 'name', 'ok'],
    'a failing result adds error',
  );
});

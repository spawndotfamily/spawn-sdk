// The harness is documented as importable by package subpath, so the export map
// must resolve it: a missing entry raises ERR_PACKAGE_PATH_NOT_EXPORTED for a
// consumer exactly as it does here. Self-reference resolution uses the map, so
// this fails on the same input a real `import` would.
import { test } from 'node:test';
import assert from 'node:assert/strict';

void test('the packaged testing harness resolves through the package export map', () => {
  assert.match(
    import.meta.resolve('@spawndotfamily/sdk/testing/loopback-table-service.mjs'),
    /testing\/loopback-table-service\.mjs$/,
  );
  assert.match(
    import.meta.resolve('@spawndotfamily/sdk/testing/table-scenarios.mjs'),
    /testing\/table-scenarios\.mjs$/,
  );
});

void test('tooling resolves the published manifest through the same map', () => {
  assert.match(import.meta.resolve('@spawndotfamily/sdk/package.json'), /package\.json$/);
});

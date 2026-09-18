// Every SDK reference in the documentation we ship must actually work. A doc that
// tells a creator to do something impossible is worse than no doc: it burns their
// agent's context and their trust. This class shipped once (testing/* was in `files`
// but missing from `exports`, so the documented subpath import threw
// ERR_PACKAGE_PATH_NOT_EXPORTED), so the invariant is enforced mechanically now.
//
// Primary assertion is export-map coverage, which needs no build: it fails on the
// exact defect (a documented subpath with no export entry). Existence of the mapped
// file is checked too, but only where it does not require a built dist/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const exportsMap = packageJson.exports ?? {};

function shippedDocs(): string[] {
  const inDir = (dir: string, extensions: string[]) =>
    readdirSync(dir)
      .filter((name) => extensions.some((extension) => name.endsWith(extension)))
      .map((name) => `${dir}/${name}`);
  return [
    'README.md',
    'AGENTS.md',
    ...inDir('docs', ['.md']),
    ...inDir('testing', ['.md']),
    ...inDir('examples', ['.md', '.mjs', '.js']),
  ];
}

// The documents a creator actually receives, scanned once.
const references = (() => {
  const specifiers = new Set<string>();
  const filePaths = new Set<string>();
  for (const file of shippedDocs()) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/node_modules\/(@spawndotfamily\/sdk\/[A-Za-z0-9._/-]+)/g)) {
      filePaths.add(match[1]);
    }
    // A specifier is not preceded by a path separator or word character, so the
    // `node_modules/@spawndotfamily/...` form above is not double-counted.
    for (const match of text.matchAll(/(?<![\w./-])(@spawndotfamily\/sdk(?:\/[A-Za-z0-9._/*-]+)?)/g)) {
      specifiers.add(match[1]);
    }
  }
  return { specifiers: [...specifiers].sort(), filePaths: [...filePaths].sort() };
})();

/** The exports entry matching a subpath, or undefined. Mirrors Node's pattern rules. */
function exportTargetFor(subpath: string): string | undefined {
  const exact = exportsMap[subpath];
  if (typeof exact === 'string') return exact;
  if (exact && typeof exact === 'object') return exact.import ?? exact.default ?? exact.types;
  let best: { key: string; target: string } | undefined;
  for (const [key, value] of Object.entries(exportsMap)) {
    const star = key.indexOf('*');
    if (star === -1 || !subpath.startsWith(key.slice(0, star))) continue;
    const target = typeof value === 'string' ? value : (value as Record<string, string> | undefined)?.import;
    if (typeof target !== 'string') continue;
    if (!best || key.length > best.key.length) best = { key, target };
  }
  if (!best) return undefined;
  const star = best.key.indexOf('*');
  return best.target.replace('*', subpath.slice(star));
}

void test('the scan found the documented references it is meant to guard', () => {
  // A vacuous scan is a false green: assert we are actually looking at real content.
  assert.ok(references.specifiers.length >= 3, `expected documented specifiers, saw ${references.specifiers.length}`);
  assert.ok(references.filePaths.length >= 1, 'expected documented node_modules paths');
});

void test('every documented SDK specifier is reachable through the export map', () => {
  const unreachable = references.specifiers.filter((specifier) => {
    const subpath = specifier === '@spawndotfamily/sdk' ? '.' : `.${specifier.slice('@spawndotfamily/sdk'.length)}`;
    return exportTargetFor(subpath) === undefined;
  });
  assert.deepEqual(
    unreachable,
    [],
    `documented specifiers with no export entry (consumers get ERR_PACKAGE_PATH_NOT_EXPORTED):\n${unreachable.join('\n')}`,
  );
});

void test('every documented package path exists in a directory we publish', () => {
  const published = new Set<string>(packageJson.files ?? []);
  const problems = references.filePaths.flatMap((relative) => {
    const withPrefix = `node_modules/${relative}`;
    const insidePackage = relative.split('/').slice(2).join('/');
    if (!existsSync(insidePackage)) return [`${withPrefix} — not present in the repo`];
    const topLevel = insidePackage.split('/')[0];
    return published.has(topLevel) ? [] : [`${withPrefix} — top level '${topLevel}' is not in package.json files`];
  });
  assert.deepEqual(problems, [], `documented paths that consumers could not use:\n${problems.join('\n')}`);
});

void test('every mapped export target that must ship exists on disk', () => {
  // dist/* targets need a build; check the rest unconditionally so this test is useful
  // on a fresh checkout. A missing non-dist target means the export points at nothing.
  const missing = Object.entries(exportsMap).flatMap(([key, value]) => {
    const target = typeof value === 'string' ? value : (value as Record<string, string>)?.import;
    if (typeof target !== 'string' || target.includes('*')) return [];
    if (target.startsWith('./dist/') && !existsSync('dist')) return [];
    return existsSync(target) ? [] : [`exports['${key}'] → ${target}`];
  });
  assert.deepEqual(missing, [], `export entries pointing at files that do not exist:\n${missing.join('\n')}`);
});

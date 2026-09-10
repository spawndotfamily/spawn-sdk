import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  buildBrowserBundle,
  formatReleaseSummary,
  getReleaseStatus,
  main,
  readConfig,
  readCredentialsFile,
  uploadRelease,
} from '../src/cli/index.ts';

const PROJECT_ID = '123e4567-e89b-12d3-a456-426614174000';
const API_URL = 'http://localhost:3003';
const PUBLISH_KEY = 'publish-test-secret';

async function withTempDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'spawn-sdk-publish-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('packages the creator publishing executable and local script', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.bin?.['spawn-publish'], 'dist/cli/run.js');
  for (const requiredPackageFile of ['dist', 'README.md', 'LICENSE', 'AGENTS.md', 'docs/security.md', 'docs/integration.md', 'docs/publishing.md']) {
    assert.ok(packageJson.files?.includes(requiredPackageFile), `package files should include ${requiredPackageFile}`);
  }
  assert.equal(
    packageJson.scripts?.['spawn-publish'],
    'node --experimental-strip-types src/cli/run.ts',
  );
  assert.match(packageJson.scripts?.postbuild ?? '', /chmodSync/);
});

test('builds a browser bundle with relative POSIX paths and browser assets', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<canvas></canvas>');
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'assets', 'main.js'), 'console.log(1);');
    await writeFile(join(directory, 'assets', 'sheet.atlas'), 'atlas');
    await writeFile(join(directory, 'assets', 'mesh.bin'), 'mesh');
    await writeFile(join(directory, 'assets', 'texture.ktx2'), 'texture');
    await writeFile(join(directory, 'assets', 'model.glb'), 'model');
    await writeFile(join(directory, 'assets', 'model.gltf'), '{}');
    const bundle = await buildBrowserBundle(directory);
    assert.deepEqual(bundle.files.map((file) => file.path), [
      'assets/main.js',
      'assets/mesh.bin',
      'assets/model.glb',
      'assets/model.gltf',
      'assets/sheet.atlas',
      'assets/texture.ktx2',
      'index.html',
    ]);
  });
});

test('rejects hidden or secret source files before they enter a bundle', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    await writeFile(join(directory, 'client-secret.json'), '{}');
    await assert.rejects(buildBrowserBundle(directory), /secret|hidden|source/i);
  });

  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    await writeFile(join(directory, 'settings.json'), '{"publishKey":"sp_pub_embedded_secret"}');
    await assert.rejects(buildBrowserBundle(directory), /secret|key|source/i);
  });

  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    await mkdir(join(directory, 'node_modules'));
    await writeFile(join(directory, 'node_modules', 'dependency.js'), 'module.exports = 1;');
    await assert.rejects(buildBrowserBundle(directory), /node_modules|source/i);
  });
});

test('does not echo an absolute build path when the directory cannot be inspected', async () => {
  await withTempDirectory(async (directory) => {
    const missingDirectory = join(directory, 'private-build');
    await assert.rejects(buildBrowserBundle(missingDirectory), (error: unknown) => {
      assert.equal(String(error).includes(missingDirectory), false);
      return /directory|inspect|build/i.test(String(error));
    });
  });
});

test('rejects symlinks and never leaks the source directory into payload paths', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    await symlink(join(directory, 'index.html'), join(directory, 'linked.html'));
    await assert.rejects(buildBrowserBundle(directory), /symlink/i);
  });

  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    const assetsDirectory = join(directory, 'assets');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(assetsDirectory));
    await writeFile(join(assetsDirectory, 'main.js'), 'export default 1;');
    const bundle = await buildBrowserBundle(directory);
    assert.deepEqual(
      bundle.files.map((file) => file.path),
      ['assets/main.js', 'index.html'],
    );
    for (const file of bundle.files) {
      assert.match(file.path, /^(?!\/)(?!.*\.\.)[^\\]+$/);
      assert.equal(isAbsolute(file.path), false);
      assert.equal(file.path.includes(directory), false);
    }
  });
});

test('rejects a file over the per-file and decoded total byte limits', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    await writeFile(join(directory, 'large.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));
    await assert.rejects(buildBrowserBundle(directory), /25,?000,?000|size|large/i);
  });

  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), 'x');
    await writeFile(join(directory, 'a.bin'), Buffer.alloc(Math.floor(MAX_TOTAL_BYTES / 2)));
    await writeFile(join(directory, 'b.bin'), Buffer.alloc(Math.ceil(MAX_TOTAL_BYTES / 2)));
    await assert.rejects(buildBrowserBundle(directory), /25,?000,?000|size|total/i);
  });
});

test('rejects builds without root index.html and unsupported or sourcemap files', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'game.js'), 'console.log(1);');
    await assert.rejects(buildBrowserBundle(directory), /index\.html|browser/i);
  });

  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), 'this is not a browser entry');
    await assert.rejects(buildBrowserBundle(directory), /browser page|browser build/i);
  });

  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    await writeFile(join(directory, 'game.exe'), 'not a browser build');
    await assert.rejects(buildBrowserBundle(directory), /unsupported|asset|browser/i);
  });

  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    await writeFile(join(directory, 'game.js.map'), '{}');
    await assert.rejects(buildBrowserBundle(directory), /map|sourcemap|unsupported/i);
  });
});

test('rejects bundles over the file-count limit', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    await Promise.all(
      Array.from({ length: MAX_FILES - 1 }, (_, index) =>
        writeFile(join(directory, `asset-${String(index).padStart(4, '0')}.txt`), 'x'),
      ),
    );
    assert.equal((await buildBrowserBundle(directory)).files.length, MAX_FILES);
    await writeFile(join(directory, 'asset-over-limit.txt'), 'x');
    await assert.rejects(buildBrowserBundle(directory), /1,?000|file count|files/i);
  });
});

test('uploads and checks releases with bearer auth and prints only the safe summary', async () => {
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
  const fetchMock = async (input: string | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(
      JSON.stringify({
        id: 'release-1',
        status: 'preview',
        previewUrl: 'http://localhost:3003/preview/release-1',
        checks: { browser: true },
        privateKey: PUBLISH_KEY,
      }),
      { status: calls.length === 1 ? 201 : 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const config = { apiUrl: API_URL, projectId: PROJECT_ID, publishKey: PUBLISH_KEY };
  const payload = {
    entry: 'index.html',
    files: [{ path: 'index.html', data: 'PGh0bWw+PC9odG1sPg==' }],
    sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };

  const created = await uploadRelease(config, payload, fetchMock);
  const status = await getReleaseStatus(config, 'release-1', fetchMock);

  assert.equal(created.id, 'release-1');
  assert.equal(status.status, 'preview');
  assert.equal(calls[0].input, `${API_URL}/api/v1/publish/${PROJECT_ID}/releases`);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.headers && new Headers(calls[0].init.headers).get('authorization'), `Bearer ${PUBLISH_KEY}`);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), payload);
  assert.equal(calls[1].input, `${API_URL}/api/v1/publish/${PROJECT_ID}/releases/release-1`);
  assert.equal(calls[1].init?.method, 'GET');
  assert.equal(formatReleaseSummary(created, PUBLISH_KEY).includes(PUBLISH_KEY), false);
  assert.match(formatReleaseSummary(created, PUBLISH_KEY), /release-1/);
});

test('never prints a publishing key from an HTTP error response', async () => {
  const output: string[] = [];
  const exitCode = await main(
    ['status', 'release-1'],
    {
      SPAWN_API_URL: API_URL,
      SPAWN_PROJECT_ID: PROJECT_ID,
      SPAWN_PUBLISH_KEY: PUBLISH_KEY,
    },
    async () => new Response(JSON.stringify({ error: `request failed for ${PUBLISH_KEY}` }), { status: 401 }),
    { log: (message) => output.push(message), error: (message) => output.push(message) },
  );
  assert.equal(exitCode, 1);
  assert.equal(output.length, 1);
  assert.equal(output[0].includes(PUBLISH_KEY), false);
});

test('loads the downloaded credentials file without printing its key and resolves a relative preview URL', async () => {
  await withTempDirectory(async (directory) => {
    const buildDirectory = join(directory, 'build');
    await mkdir(buildDirectory);
    await writeFile(join(buildDirectory, 'index.html'), '<html></html>');
    const credentialsPath = join(directory, 'spawn-project-credentials.json');
    await writeFile(credentialsPath, JSON.stringify({
      platformOrigin: API_URL,
      projectId: PROJECT_ID,
      publishKey: 'file-only-secret',
      expiresAt: Date.now() + 60_000,
    }));
    let request: { init?: RequestInit } | undefined;
    const output: string[] = [];
    const exitCode = await main(
      ['publish', buildDirectory, '--credentials', credentialsPath],
      {},
      async (_input, init) => {
        request = { init };
        return new Response(JSON.stringify({
          id: 'release-2',
          status: 'preview',
          previewUrl: `/play/${PROJECT_ID}?release=release-2`,
          checks: { browser: true },
        }), { status: 201 });
      },
      { log: (message) => output.push(message), error: (message) => output.push(`error:${message}`) },
    );
    assert.equal(exitCode, 0);
    assert.equal(new Headers(request?.init?.headers).get('authorization'), 'Bearer file-only-secret');
    assert.equal(output.length, 1);
    assert.equal(output[0].includes('file-only-secret'), false);
    assert.match(output[0], new RegExp(`http://localhost:3003/play/${PROJECT_ID}\\?release=release-2`));
  });
});

test('rejects unknown credential fields and expired credential files before making a request', async () => {
  await withTempDirectory(async (directory) => {
    const unknownFieldsPath = join(directory, 'unknown.json');
    await writeFile(unknownFieldsPath, JSON.stringify({
      platformOrigin: API_URL,
      projectId: PROJECT_ID,
      publishKey: PUBLISH_KEY,
      expiresAt: Date.now() + 60_000,
      extra: 'must not be accepted',
    }));
    const errors: string[] = [];
    let calls = 0;
    const output = { log: () => undefined, error: (message: string) => errors.push(message) };
    assert.equal(
      await main(['status', 'release-1', '--credentials', unknownFieldsPath], {}, async () => {
        calls += 1;
        return new Response('{}');
      }, output),
      1,
    );
    assert.equal(calls, 0);
    assert.match(errors[0], /unknown|credential/i);

    const expiredPath = join(directory, 'expired.json');
    await writeFile(expiredPath, JSON.stringify({
      platformOrigin: API_URL,
      projectId: PROJECT_ID,
      publishKey: PUBLISH_KEY,
      expiresAt: Date.now() - 60_000,
    }));
    errors.length = 0;
    assert.equal(
      await main(['status', 'release-1', '--credentials', expiredPath], {}, async () => {
        calls += 1;
        return new Response('{}');
      }, output),
      1,
    );
    assert.equal(calls, 0);
    assert.match(errors[0], /expired|credential/i);
  });
});

test('requires HTTPS for remote API origins while allowing exact local loopback origins', () => {
  const baseEnv = {
    SPAWN_PROJECT_ID: PROJECT_ID,
    SPAWN_PUBLISH_KEY: PUBLISH_KEY,
  };
  for (const apiUrl of ['http://localhost:3003', 'http://localhost:3003/', 'http://127.0.0.1:3003', 'http://[::1]:3003', 'https://spawn.example.test']) {
    assert.doesNotThrow(() => readConfig({ ...baseEnv, SPAWN_API_URL: apiUrl }));
  }
  for (const apiUrl of ['http://spawn.example.test', 'http://localhost.example.test', 'http://127.0.0.1.example.test', 'http://0x7f000001:3003', 'http://2130706433:3003']) {
    assert.throws(() => readConfig({ ...baseEnv, SPAWN_API_URL: apiUrl }), /HTTPS|secure|origin/i);
  }
});

test('rejects credentials, paths, queries and fragments in configured platform origins', () => {
  const baseEnv = {
    SPAWN_PROJECT_ID: PROJECT_ID,
    SPAWN_PUBLISH_KEY: PUBLISH_KEY,
  };
  for (const apiUrl of [
    'https://spawn.example.test/path',
    'https://spawn.example.test/%2e',
    'https://spawn.example.test/..',
    'https://spawn.example.test/?preview=1',
    'https://spawn.example.test?',
    'https://spawn.example.test/#preview',
    'https://spawn.example.test#',
    'https://creator:secret@spawn.example.test',
    'http://localhost:3003/path',
  ]) {
    assert.throws(() => readConfig({ ...baseEnv, SPAWN_API_URL: apiUrl }), /origin|path|URL|credential/i);
  }
});

test('applies the same origin policy to downloaded credentials', async () => {
  await withTempDirectory(async (directory) => {
    const credentialsPath = join(directory, 'invalid-origin.json');
    await writeFile(credentialsPath, JSON.stringify({
      platformOrigin: 'http://remote.example.test/path',
      projectId: PROJECT_ID,
      publishKey: PUBLISH_KEY,
      expiresAt: Date.now() + 60_000,
    }));
    await assert.rejects(readCredentialsFile(credentialsPath), /HTTPS|secure|origin|path/i);
  });
});

test('bounds empty-directory traversal depth and total entries', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    let current = directory;
    for (let index = 0; index < 66; index += 1) {
      current = join(current, `level-${index}`);
      await mkdir(current);
    }
    await assert.rejects(buildBrowserBundle(directory), /depth|nested|directory/i);
  });

  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    await Promise.all(
      Array.from({ length: 10_001 }, (_, index) => mkdir(join(directory, `empty-${String(index).padStart(5, '0')}`))),
    );
    await assert.rejects(buildBrowserBundle(directory), /entries|travers|directory/i);
  });
});

test('validates config again for exported upload and status helpers', async () => {
  let calls = 0;
  const fetchMock = async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  };
  const invalidConfig = {
    apiUrl: 'http://spawn.example.test',
    projectId: PROJECT_ID,
    publishKey: PUBLISH_KEY,
  };
  const missingUrlConfig = {
    apiUrl: undefined as unknown as string,
    projectId: PROJECT_ID,
    publishKey: PUBLISH_KEY,
  };
  const payload = {
    entry: 'index.html' as const,
    files: [{ path: 'index.html', data: 'PGh0bWw+PC9odG1sPg==' }],
  };
  await assert.rejects(uploadRelease(invalidConfig, payload, fetchMock), /HTTPS|secure|origin/i);
  await assert.rejects(getReleaseStatus(invalidConfig, 'release-1', fetchMock), /HTTPS|secure|origin/i);
  await assert.rejects(uploadRelease(missingUrlConfig, payload, fetchMock), /HTTPS|secure|origin/i);
  assert.equal(calls, 0);
});

test('uses redirect rejection and an abortable bounded request timeout', async () => {
  const config = { apiUrl: 'https://spawn.example.test', projectId: PROJECT_ID, publishKey: PUBLISH_KEY };
  const payload = {
    entry: 'index.html' as const,
    files: [{ path: 'index.html', data: 'PGh0bWw+PC9odG1sPg==' }],
  };
  let observedInit: RequestInit | undefined;
  await uploadRelease(config, payload, async (_input, init) => {
    observedInit = init;
    return new Response(JSON.stringify({ id: 'release-1' }), { status: 201 });
  });
  assert.equal(observedInit?.redirect, 'error');
  assert.equal(observedInit?.credentials, 'omit');
  assert.ok(observedInit?.signal instanceof AbortSignal);
  await assert.rejects(
    uploadRelease(config, payload, async () => ({
      ok: true,
      redirected: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'redirected' }),
    } as unknown as Response)),
    /redirect/i,
  );

  const oldSetTimeout = globalThis.setTimeout;
  const oldClearTimeout = globalThis.clearTimeout;
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  try {
    (globalThis as unknown as { setTimeout: (...args: unknown[]) => unknown }).setTimeout = (callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    };
    (globalThis as unknown as { clearTimeout: (timer: unknown) => void }).clearTimeout = (timer: unknown) => {
      const found = timers.find((entry) => entry === timer);
      if (found) found.cleared = true;
    };
    const pending = uploadRelease(config, payload, async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    assert.equal(timers.length, 1);
    assert.ok(timers[0].delay > 0 && timers[0].delay <= 60_000);
    timers[0].callback();
    await assert.rejects(pending, /timed out|timeout|abort/i);
    assert.equal(timers[0].cleared, true);
  } finally {
    globalThis.setTimeout = oldSetTimeout;
    globalThis.clearTimeout = oldClearTimeout;
  }
});

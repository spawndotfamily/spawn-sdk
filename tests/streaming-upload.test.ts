import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHUNK_BYTES,
  deriveUploadOrigin,
  inspectBrowserBuild,
  inspectBrowserBuildForLocal,
  openValidatedBuildFile,
  publishBrowserDirectory,
  STREAM_MAX_HTML_BYTES,
  STREAM_MAX_TOTAL_BYTES,
} from '../src/cli/upload-client.ts';
import { readConfig, readCredentialsFile } from '../src/cli/index.ts';

async function withTempDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'spawn-sdk-streaming-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('inspects a build larger than the legacy base64 limit without returning file data', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html><body></body></html>');
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'assets', 'large.bin'), Buffer.alloc(26_000_000, 7));

    const build = await inspectBrowserBuild(directory);

    assert.equal(build.bytes, 26_000_026);
    assert.equal(build.files.find((file) => file.path === 'assets/large.bin')?.data, undefined);
    assert.equal(build.files.find((file) => file.path === 'assets/large.bin')?.bytes, 26_000_000);
    assert.deepEqual(build.files.map((file) => file.path), ['assets/large.bin', 'index.html']);
  });
});

test('streams a sparse file above the default 1 GB admission ceiling within the client safety ceiling', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html><body></body></html>');
    const asset = join(directory, 'assets.bin');
    await writeFile(asset, Buffer.alloc(0));
    await truncate(asset, 2_000_000_001);

    const build = await inspectBrowserBuild(directory);

    assert.equal(build.bytes, 2_000_000_001 + '<html><body></body></html>'.length);
    assert.equal(build.files.find((file) => file.path === 'assets.bin')?.bytes, 2_000_000_001);
    assert.equal('data' in (build.files.find((file) => file.path === 'assets.bin') ?? {}), false);
  });
});

test('rejects aggregate size from the next file before hashing it', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'a.bin'), Buffer.from('a'));
    await writeFile(join(directory, 'index.html'), '<html><body>ok</body></html>');
    const next = join(directory, 'z.bin');
    await writeFile(next, Buffer.alloc(0));
    await truncate(next, STREAM_MAX_TOTAL_BYTES);
    await assert.rejects(inspectBrowserBuild(directory), /decoded size limit/i);
  });
});

test('enforces the HTML byte limit for every HTML asset', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html><body>ok</body></html>');
    await writeFile(join(directory, 'help.html'), Buffer.alloc(STREAM_MAX_HTML_BYTES + 1, 65));
    await assert.rejects(inspectBrowserBuild(directory), /HTML|size|limit/i);
  });
});

test('derives the local artifact worker origin on port 3401', () => {
  assert.equal(deriveUploadOrigin('http://localhost:3003'), 'http://127.0.0.1:3401');
});

test('local serving descriptors reject a build file changed after inspection', async () => {
  await withTempDirectory(async (directory) => {
    const index = join(directory, 'index.html');
    await writeFile(index, '<html><body>before</body></html>');
    const prepared = await inspectBrowserBuildForLocal(directory);
    const descriptor = prepared.preparedFiles.find((file) => file.path === 'index.html');
    assert.ok(descriptor);
    await writeFile(index, '<html><body>after</body></html>');
    await assert.rejects(
      openValidatedBuildFile(prepared, descriptor),
      /Build file changed after inspection|Build directory changed after inspection/,
    );
  });
});

test('coalesces concurrent local descriptor validation per file', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html><body>cache</body></html>');
    const asset = join(directory, 'asset.bin');
    await writeFile(asset, Buffer.alloc(26_000_000, 7));
    const prepared = await inspectBrowserBuildForLocal(directory);
    const descriptor = prepared.preparedFiles.find((file) => file.path === 'asset.bin');
    assert.ok(descriptor);
    const cache: { snapshot?: { ino: number; dev: number; size: number; mtimeMs?: number; ctimeMs?: number }; validation?: Promise<void> } = {};
    const first = openValidatedBuildFile(prepared, descriptor, cache);
    for (let attempt = 0; attempt < 1_000 && !cache.validation; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(cache.validation, 'first validation should be visible to concurrent callers');
    const inFlight = cache.validation;
    const second = openValidatedBuildFile(prepared, descriptor, cache);
    assert.equal(cache.validation, inFlight);
    const [firstHandle, secondHandle] = await Promise.all([first, second]);
    await firstHandle.close();
    await secondHandle.close();
    assert.ok(cache.snapshot);
  });
});

test('publishes a directory through the core reservation, worker chunks, seal and core completion', async () => {
  await withTempDirectory(async (directory) => {
    const index = Buffer.from('<html><body>streamed</body></html>');
    const large = Buffer.alloc(CHUNK_BYTES + 17, 23);
    await writeFile(join(directory, 'index.html'), index);
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'assets', 'large.bin'), large);
    const calls: Array<{ url: string; init?: RequestInit; body?: Uint8Array }> = [];
    const config = {
      apiUrl: 'https://spawn.example.test',
      projectId: '123e4567-e89b-12d3-a456-426614174000',
      publishKey: 'publish-key',
    };
    const fetcher = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      let body: Uint8Array | undefined;
      if (init?.body && url.includes('/chunks/')) {
        body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      }
      calls.push({ url, init, body });
      if (url.endsWith('/uploads')) {
        return new Response(JSON.stringify({
          uploadId: 'upload-1',
          uploadOrigin: 'https://uploads.spawn.example.test',
          token: 'upload-ticket',
          chunkBytes: CHUNK_BYTES,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }), { status: 201 });
      }
      if (url.includes('/v1/uploads/upload-1') && url.endsWith('/seal')) {
        return new Response(JSON.stringify({ uploadId: 'upload-1', sealed: true, bytes: index.length + large.length }), { status: 200 });
      }
      if (url.includes('/v1/uploads/upload-1')) {
        return new Response(JSON.stringify({ uploadId: 'upload-1', bytes: 1 }), { status: 200 });
      }
      if (url.endsWith('/complete')) {
        return new Response(JSON.stringify({ id: 'release-1', status: 'preview' }), { status: 201 });
      }
      throw new Error('unexpected URL ' + url);
    };

    const result = await publishBrowserDirectory(config, directory, undefined, fetcher, { sleep: async () => undefined });

    assert.equal(result.id, 'release-1');
    assert.deepEqual(calls.map((call) => call.url), [
      'https://spawn.example.test/api/v1/publish/123e4567-e89b-12d3-a456-426614174000/uploads',
      'https://uploads.spawn.example.test/v1/uploads/upload-1',
      'https://uploads.spawn.example.test/v1/uploads/upload-1/files/0/chunks/0',
      'https://uploads.spawn.example.test/v1/uploads/upload-1/files/0/chunks/1',
      'https://uploads.spawn.example.test/v1/uploads/upload-1/files/1/chunks/0',
      'https://uploads.spawn.example.test/v1/uploads/upload-1/seal',
      'https://spawn.example.test/api/v1/publish/123e4567-e89b-12d3-a456-426614174000/uploads/upload-1/complete',
    ]);
    const manifest = JSON.parse(String(calls[0].init?.body)) as { files: Array<{ path: string; bytes: number; sha256: string }> };
    assert.deepEqual(manifest.files.map((file) => file.path), ['assets/large.bin', 'index.html']);
    assert.equal(manifest.files[0].bytes, large.length);
    assert.equal(manifest.files[0].sha256, createHash('sha256').update(large).digest('hex'));
    assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer publish-key');
    assert.equal(new Headers(calls[1].init?.headers).get('authorization'), 'Bearer upload-ticket');
    assert.equal(new Headers(calls[1].init?.headers).get('authorization')?.includes('publish-key'), false);
    assert.deepEqual(calls.slice(2, 5).map((call) => call.body?.byteLength), [CHUNK_BYTES, 17, index.length]);
  });
});

test('rejects a changed later chunk before sending it to the worker', async () => {
  await withTempDirectory(async (directory) => {
    const asset = join(directory, 'asset.bin');
    await writeFile(join(directory, 'index.html'), '<html><body>stable</body></html>');
    await writeFile(asset, Buffer.alloc(CHUNK_BYTES + 17, 23));
    const calls: string[] = [];
    const fetcher = async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/uploads')) {
        return new Response(JSON.stringify({
          uploadId: 'upload-1',
          uploadOrigin: 'https://uploads.spawn.example.test',
          token: 'upload-ticket',
          chunkBytes: CHUNK_BYTES,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }), { status: 201 });
      }
      if (url.endsWith('/chunks/0')) {
        await writeFile(asset, Buffer.alloc(CHUNK_BYTES + 17, 31));
        return new Response(JSON.stringify({ uploadId: 'upload-1', bytes: CHUNK_BYTES }), { status: 200 });
      }
      if (url.includes('/v1/uploads/upload-1')) return new Response(JSON.stringify({ uploadId: 'upload-1', bytes: 1 }), { status: 200 });
      return new Response(JSON.stringify({ id: 'release-1' }), { status: 201 });
    };
    await assert.rejects(
      publishBrowserDirectory(
        { apiUrl: 'https://spawn.example.test', projectId: '123e4567-e89b-12d3-a456-426614174000', publishKey: 'publish-key' },
        directory,
        undefined,
        fetcher,
        { sleep: async () => undefined },
      ),
      /changed while it was being uploaded/i,
    );
    assert.equal(calls.some((url) => url.endsWith('/chunks/1')), false);
    assert.equal(calls.some((url) => url.endsWith('/seal')), false);
    assert.equal(calls.some((url) => url.endsWith('/complete')), false);
  });
});

test('rejects the active publish key in a streamed build before any remote request', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html><body>safe</body></html>');
    await mkdir(join(directory, 'assets'));
    const keyPrefix = Buffer.alloc(1_048_576 - 5, 65);
    await writeFile(join(directory, 'assets', 'main.js'), Buffer.concat([keyPrefix, Buffer.from('publi'), Buffer.from('sh-key')]));
    let calls = 0;
    await assert.rejects(
      publishBrowserDirectory(
        { apiUrl: 'https://spawn.example.test', projectId: '123e4567-e89b-12d3-a456-426614174000', publishKey: 'publish-key' },
        directory,
        undefined,
        async () => { calls += 1; return new Response('{}', { status: 500 }); },
      ),
      /credential|private|secret|source/i,
    );
    assert.equal(calls, 0);
  });
});

test('rejects the active publish key in a build path before any remote request', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html><body>safe</body></html>');
    await writeFile(join(directory, 'publish-key.js'), 'console.log(1);');
    let calls = 0;
    await assert.rejects(
      publishBrowserDirectory(
        { apiUrl: 'https://spawn.example.test', projectId: '123e4567-e89b-12d3-a456-426614174000', publishKey: 'publish-key' },
        directory,
        undefined,
        async () => { calls += 1; return new Response('{}', { status: 500 }); },
      ),
      /credential|path|private|secret|source/i,
    );
    assert.equal(calls, 0);
  });
});

test('requires a sealed worker acknowledgement before core completion', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html><body>seal</body></html>');
    const calls: string[] = [];
    const fetcher = async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/uploads')) return new Response(JSON.stringify({ uploadId: 'upload-1', uploadOrigin: 'https://uploads.spawn.example.test', token: 'ticket', chunkBytes: CHUNK_BYTES, expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
      if (url.endsWith('/seal')) return new Response(JSON.stringify({ uploadId: 'upload-1' }), { status: 200 });
      if (url.includes('/v1/uploads/upload-1')) return new Response(JSON.stringify({ uploadId: 'upload-1', bytes: 1 }), { status: 200 });
      return new Response(JSON.stringify({ id: 'release-1' }), { status: 201 });
    };
    await assert.rejects(
      publishBrowserDirectory(
        { apiUrl: 'https://spawn.example.test', projectId: '123e4567-e89b-12d3-a456-426614174000', publishKey: 'publish-key' },
        directory,
        undefined,
        fetcher,
        { sleep: async () => undefined },
      ),
      /seal/i,
    );
    assert.equal(calls.some((url) => url.endsWith('/complete')), false);
  });
});

test('fails closed when the core forges an upload origin', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'index.html'), '<html></html>');
    let calls = 0;
    await assert.rejects(
      publishBrowserDirectory(
        { apiUrl: 'https://spawn.example.test', projectId: '123e4567-e89b-12d3-a456-426614174000', publishKey: 'publish-key' },
        directory,
        undefined,
        async () => {
          calls += 1;
          return new Response(JSON.stringify({ uploadId: 'upload-1', uploadOrigin: 'https://evil.example.test', token: 'ticket', chunkBytes: CHUNK_BYTES, expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
        },
      ),
      /upload origin|trusted|unexpected/i,
    );
    assert.equal(calls, 1);
  });
});

test('retries a failed chunk with the same bounded bytes and ticket', async () => {
  await withTempDirectory(async (directory) => {
    const data = Buffer.from('<html><body>retry</body></html>');
    await writeFile(join(directory, 'index.html'), data);
    let chunkAttempts = 0;
    const chunkBodies: Uint8Array[] = [];
    const fetcher = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/uploads')) return new Response(JSON.stringify({ uploadId: 'upload-1', uploadOrigin: 'https://uploads.spawn.example.test', token: 'ticket', chunkBytes: CHUNK_BYTES, expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
      if (url.includes('/chunks/')) {
        chunkAttempts += 1;
        chunkBodies.push(new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
        if (chunkAttempts === 1) return new Response(JSON.stringify({ error: 'temporary' }), { status: 503 });
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      if (url.endsWith('/seal')) return new Response(JSON.stringify({ sealed: true }), { status: 200 });
      if (url.endsWith('/complete')) return new Response(JSON.stringify({ id: 'release-1' }), { status: 201 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await publishBrowserDirectory(
      { apiUrl: 'https://spawn.example.test', projectId: '123e4567-e89b-12d3-a456-426614174000', publishKey: 'publish-key' },
      directory,
      undefined,
      fetcher,
      { sleep: async () => undefined },
    );
    assert.equal(chunkAttempts, 2);
    assert.deepEqual(chunkBodies[0], chunkBodies[1]);
  });
});

test('accepts an explicit trusted upload origin in environment and downloaded credentials', async () => {
  const projectId = '123e4567-e89b-12d3-a456-426614174000';
  const config = readConfig({
    SPAWN_API_URL: 'https://spawn.example.test',
    SPAWN_UPLOAD_ORIGIN: 'https://uploads.spawn.example.test',
    SPAWN_PROJECT_ID: projectId,
    SPAWN_PUBLISH_KEY: 'publish-key',
  });
  assert.equal(config.uploadOrigin, 'https://uploads.spawn.example.test');
  await withTempDirectory(async (directory) => {
    const path = join(directory, 'credentials.json');
    await writeFile(path, JSON.stringify({
      platformOrigin: 'https://spawn.example.test',
      uploadOrigin: 'https://uploads.spawn.example.test',
      projectId,
      publishKey: 'publish-key',
      expiresAt: Date.now() + 60_000,
    }));
    assert.equal((await readCredentialsFile(path)).uploadOrigin, 'https://uploads.spawn.example.test');
  });
});

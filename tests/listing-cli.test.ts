import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli/index.ts';
const PROJECT = '123e4567-e89b-12d3-a456-426614174000', IMAGE = '123e4567-e89b-12d3-a456-426614174001';
const SECRET = 'test-creator-secret', ORIGIN = 'https://creator-platform.example';
const listing = { version: 3, name: 'Bow Town', description: 'Aim for targets.', genre: 'Action', modes: ['Solo'], controls: 'Mouse', instructions: 'Hit a target.', coverImageId: IMAGE, images: [{ id: IMAGE, url: '/media/game.png', alt: 'Game cover' }] };
type RequestRecord = {
    url: string;
    method?: string;
    credentials?: RequestCredentials;
    redirect?: RequestRedirect;
    headers?: HeadersInit;
    body: unknown;
};
type Fixture = {
    dir: string;
    credentials: string;
    calls: RequestRecord[];
    logs: string[];
    errors: string[];
    execute(args: string[]): Promise<number>;
    setReply(reply: () => Response): void;
};
async function fixture(run: (f: Fixture) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), 'listing-cli-')); try {
    const credentials = join(dir, 'credentials.json');
    await writeFile(credentials, JSON.stringify({ platformOrigin: ORIGIN, projectId: PROJECT, publishKey: SECRET, expiresAt: Date.now() + 60000, scopes: ['build:read', 'build:upload', 'listing:write'] }));
    let calls: RequestRecord[] = [];
    let logs: string[] = [], errors: string[] = [];
    let reply = () => Response.json(listing);
    const execute = (args: string[]) => main([...args, '--credentials', credentials], {}, async (url, init) => { calls.push({ url: String(url), ...init, body: init?.body ? JSON.parse(String(init.body)) : null }); return reply(); }, { log: m => logs.push(m), error: m => errors.push(m) });
    await run({ dir, credentials, calls, logs, errors, execute, setReply: (r: () => Response) => { reply = r; } });
}
finally {
    await rm(dir, { recursive: true, force: true });
} }
test('listing get uses the project endpoint and prints only public listing fields', async () => fixture(async (f) => { f.setReply(() => Response.json({ ...listing, publishKey: SECRET, ownerEmail: 'private@example.test' })); assert.equal(await f.execute(['listing', 'get']), 0); assert.equal(f.calls[0].url, `${ORIGIN}/api/v1/publish/${PROJECT}/listing`); assert.equal(f.calls[0].method, 'GET'); assert.deepEqual(JSON.parse(f.logs[0]), listing); assert.equal(f.calls[0].credentials, 'omit'); assert.equal(f.calls[0].redirect, 'error'); assert.equal(new Headers(f.calls[0].headers).get('Authorization'), `Bearer ${SECRET}`); }));
test('listing update sends explicit version and only the selected fields', async () => fixture(async (f) => { const path = join(f.dir, 'patch.json'); await writeFile(path, JSON.stringify({ expectedVersion: 3, name: 'New name', coverImageId: null })); assert.equal(await f.execute(['listing', 'update', path]), 0); assert.equal(f.calls[0].method, 'PATCH'); assert.deepEqual(f.calls[0].body, { expectedVersion: 3, name: 'New name', coverImageId: null }); }));
test('listing update rejects management fields, missing versions and malformed patches before requests', async () => fixture(async (f) => { const path = join(f.dir, 'patch.json'); for (const patch of [{ expectedVersion: 3, owner: PROJECT }, { expectedVersion: 3, price: 9 }, { expectedVersion: 3, featured: true }, { name: 'Oops' }, { expectedVersion: -1, name: 'Oops' }, { expectedVersion: 3, modes: 'Solo' }, { expectedVersion: 3, coverImageId: '../other' }, { expectedVersion: 3 }]) {
    await writeFile(path, JSON.stringify(patch));
    assert.equal(await f.execute(['listing', 'update', path]), 1);
} assert.equal(f.calls.length, 0); }));
test('image commands send versioned add, replace and remove requests', async () => fixture(async (f) => { const path = join(f.dir, 'cover.png'); const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrWQAAAAASUVORK5CYII=', 'base64'); await writeFile(path, bytes); assert.equal(await f.execute(['image', 'add', path, '--expected-version', '3', '--alt', 'Game cover']), 0); assert.equal(await f.execute(['image', 'replace', IMAGE, path, '--expected-version', '3', '--alt', 'New cover']), 0); assert.equal(await f.execute(['image', 'remove', IMAGE, '--expected-version', '3']), 0); assert.deepEqual(f.calls.map(c => [c.method, c.url]), [['POST', `${ORIGIN}/api/v1/publish/${PROJECT}/media`], ['PUT', `${ORIGIN}/api/v1/publish/${PROJECT}/media/${IMAGE}`], ['DELETE', `${ORIGIN}/api/v1/publish/${PROJECT}/media/${IMAGE}`]]); assert.deepEqual(f.calls[0].body, { expectedVersion: 3, data: bytes.toString('base64'), alt: 'Game cover' }); assert.deepEqual(f.calls[2].body, { expectedVersion: 3 }); }));
test('image input rejects oversized, unsupported, symlink and invalid identifier inputs locally', async () => fixture(async (f) => { const path = join(f.dir, 'cover.png'); await writeFile(path, 'not an image'); assert.equal(await f.execute(['image', 'add', path, '--expected-version', '3', '--alt', 'Cover']), 1); await writeFile(path, Buffer.alloc(1048577)); assert.equal(await f.execute(['image', 'add', path, '--expected-version', '3', '--alt', 'Cover']), 1); const linked = join(f.dir, 'linked.png'); await symlink(path, linked); assert.equal(await f.execute(['image', 'add', linked, '--expected-version', '3', '--alt', 'Cover']), 1); assert.equal(await f.execute(['image', 'remove', '../../other', '--expected-version', '3']), 1); assert.equal(f.calls.length, 0); }));
test('listing mutations require the file to explicitly grant listing permission', async () => fixture(async (f) => { await writeFile(f.credentials, JSON.stringify({ platformOrigin: ORIGIN, projectId: PROJECT, publishKey: SECRET, expiresAt: Date.now() + 60000 })); const path = join(f.dir, 'patch.json'); await writeFile(path, JSON.stringify({ expectedVersion: 3, name: 'New' })); assert.equal(await f.execute(['listing', 'update', path]), 1); assert.equal(f.calls.length, 0); assert.match(f.errors.join(' '), /listing:write/); }));
test('stale versions are surfaced with no automatic retry or overwrite', async () => fixture(async (f) => { f.setReply(() => Response.json({ error: 'stale' }, { status: 409 })); assert.equal(await f.execute(['image', 'remove', IMAGE, '--expected-version', '3']), 1); assert.equal(f.calls.length, 1); assert.match(f.errors[0], /changed|version|reload/i); }));
test('unavailable endpoints report availability and responses cannot leak credentials', async () => fixture(async (f) => { f.setReply(() => Response.json({ error: SECRET }, { status: 404 })); assert.equal(await f.execute(['listing', 'get']), 1); assert.match(f.errors[0], /unavailable|not available/i); assert.ok(!f.errors[0].includes(SECRET)); f.setReply(() => Response.json({ ...listing, name: SECRET })); assert.equal(await f.execute(['listing', 'get']), 0); assert.ok(!f.logs.join('').includes(SECRET)); }));
test('bounds downloaded credentials and listing responses', async () => fixture(async (f) => { f.setReply(() => new Response(' '.repeat(1048577))); assert.equal(await f.execute(['listing', 'get']), 1); assert.match(f.errors[0], /large|limit/i); await writeFile(f.credentials, ' '.repeat(65537)); assert.equal(await f.execute(['listing', 'get']), 1); assert.equal(f.calls.length, 1); }));
test('legacy credentials still read listings; environment keys cannot edit listings', async () => fixture(async (f) => { await writeFile(f.credentials, JSON.stringify({ platformOrigin: ORIGIN, projectId: PROJECT, publishKey: SECRET, expiresAt: Date.now() + 60000 })); assert.equal(await f.execute(['listing', 'get']), 0); const errors: string[] = []; assert.equal(await main(['listing', 'get'], { SPAWN_API_URL: ORIGIN, SPAWN_PROJECT_ID: PROJECT, SPAWN_PUBLISH_KEY: SECRET }, async () => { throw Error('must not fetch'); }, { log: () => { }, error: m => errors.push(m) }), 1); assert.match(errors[0], /credentials/); }));
test('text limits, empty clears and exact image byte limit follow the contract', async () => fixture(async (f) => { const path = join(f.dir, 'patch.json'); await writeFile(path, JSON.stringify({ expectedVersion: 0, name: 'a'.repeat(60), description: '', genre: '', modes: [], controls: '', instructions: '' })); assert.equal(await f.execute(['listing', 'update', path]), 0); for (const patch of [{ name: 'a'.repeat(61) }, { description: 'a'.repeat(501) }, { genre: 'a'.repeat(33) }, { controls: 'a'.repeat(121) }, { instructions: 'a'.repeat(1501) }, { modes: Array(9).fill('solo') }, { modes: ['a'.repeat(41)] }]) {
    await writeFile(path, JSON.stringify({ expectedVersion: 0, ...patch }));
    assert.equal(await f.execute(['listing', 'update', path]), 1);
} assert.equal(f.calls.length, 1); const image = join(f.dir, 'large.png'); const data = Buffer.alloc(1048576); data.set([137, 80, 78, 71, 13, 10, 26, 10]); await writeFile(image, data); assert.equal(await f.execute(['image', 'add', image, '--expected-version', '0', '--alt', '']), 0); }));

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { init, parse } from 'es-module-lexer/minimal';
import { startSpawnTestHost } from '../testing/local-host.mjs';

async function createGameBuild() {
  const directory = await mkdtemp(join(tmpdir(), 'spawn-approval-lifecycle-'));
  await init();
  const copied = new Map();

  async function copyModule(path) {
    const existing = copied.get(path);
    if (existing) return existing;
    const output = `module-${copied.size}.js`;
    copied.set(path, output);
    let source = await readFile(new URL(`../dist/${path}`, import.meta.url), 'utf8');
    const replacements = [];
    for (const item of parse(source)[0]) {
      if (!item.n?.startsWith('./')) continue;
      if (item.d !== -1)
        throw new Error('The lifecycle browser game expects static imports.');
      replacements.push({
        start: item.s,
        end: item.e,
        name: './' + await copyModule(join(dirname(path), item.n)),
      });
    }
    for (const replacement of replacements.reverse())
      source = source.slice(0, replacement.start) + replacement.name + source.slice(replacement.end);
    await writeFile(join(directory, output), source);
    return output;
  }

  const entry = await copyModule('index.js');
  await writeFile(
    join(directory, 'index.html'),
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;background:white;color:#222;padding:24px}button{padding:16px;margin:8px}</style></head><body>
<h1>Lifecycle browser game</h1><p id="identity">Connecting…</p>
<button id="buy" disabled>Buy item for 0.25 LOCAL</button><p id="result"></p>
<script type="module">
import { createSpawnGameClient } from './${entry}';
const client = createSpawnGameClient();
const identity = await client.identity();
document.getElementById('identity').textContent = identity.displayName;
document.getElementById('buy').disabled = false;
document.getElementById('buy').onclick = async () => {
  const result = document.getElementById('result');
  try { const receipt = await client.requestTokenPayment({amount:'0.25',item:'Game payment'}); result.textContent = 'Payment ' + receipt.status; }
  catch (error) { result.textContent = error.message; }
};
</script></body></html>`,
  );
  return directory;
}

async function openPlayer(browser, player) {
  const page = await browser.newPage();
  await page.goto(player.url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: player.displayName, exact: true }).waitFor();
  return page;
}

function settle(promise) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

let gameDirectory;
test.before(async () => {
  gameDirectory = await createGameBuild();
});
test.after(async () => {
  await rm(gameDirectory, { recursive: true, force: true });
});

test('queued harness token approval resumes after an active game payment closes', { timeout: 120_000 }, async () => {
  let host;
  let browser;
  let page;
  try {
    host = await startSpawnTestHost({ players: 1, gameDirectory });
    browser = await chromium.launch();
    const player = host.players[0];
    page = await openPlayer(browser, player);
    let frame = page.frameLocator('iframe');

    // The game request proves the ordinary document bridge finished its fast handshake.
    await frame.getByRole('button', { name: 'Buy item for 0.25 LOCAL' }).waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    frame = page.frameLocator('iframe');
    await frame.getByRole('button', { name: 'Buy item for 0.25 LOCAL' }).click();
    await page.getByRole('button', { name: 'Confirm · spend 0.25 LOCAL', exact: true }).waitFor();

    const queued = settle(player.requestApproval({ kind: 'token', amount: '0.5', item: 'Queued harness payment' }, { timeoutMs: 15_000 }));
    // Let the host poll deliver the same pending object while the game payment owns the mutex.
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Confirm · spend 0.5 LOCAL', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Confirm · spend 0.5 LOCAL', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const queuedResult = await queued;
    assert.equal(queuedResult.error, undefined);
    const receipt = queuedResult.value;
    assert.equal(receipt.status, 'paid');
  } finally {
    await page?.close().catch(() => {});
    await browser?.close();
    await host?.close();
  }
});

test('host timeout releases a harness token approval mutex before the next request', { timeout: 120_000 }, async () => {
  let host;
  let browser;
  let page;
  try {
    host = await startSpawnTestHost({ players: 1, gameDirectory });
    browser = await chromium.launch();
    const player = host.players[0];
    page = await openPlayer(browser, player);

    const abandoned = settle(player.requestApproval({ kind: 'token', amount: '0.5', item: 'Timed out harness payment' }, { timeoutMs: 3_000 }));
    await page.getByRole('button', { name: 'Confirm · spend 0.5 LOCAL', exact: true }).waitFor();
    const abandonedResult = await abandoned;
    assert.match(abandonedResult.error?.message ?? '', /timed out/i);
    await page.getByRole('button', { name: 'Confirm · spend 0.5 LOCAL', exact: true }).waitFor({ state: 'detached' });

    const second = settle(player.requestApproval({ kind: 'token', amount: '0.25', item: 'Replacement harness payment' }, { timeoutMs: 15_000 }));
    await page.getByRole('button', { name: 'Confirm · spend 0.25 LOCAL', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Confirm · spend 0.25 LOCAL', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const secondResult = await second;
    assert.equal(secondResult.error, undefined);
    assert.equal(secondResult.value.status, 'paid');
  } finally {
    await page?.close().catch(() => {});
    await browser?.close();
    await host?.close();
  }
});

test('delayed harness match completion does not reopen the approval', { timeout: 120_000 }, async () => {
  let host;
  let browser;
  let page;
  try {
    host = await startSpawnTestHost({ players: 2, gameDirectory });
    browser = await chromium.launch();
    const [alice, bob] = host.players;
    page = await openPlayer(browser, alice);
    const matchId = randomUUID();
    await host.matches.create({
      matchId,
      amount: '10',
      players: [
        { playerId: alice.playerId, launchId: alice.launchId },
        { playerId: bob.playerId, launchId: bob.launchId },
      ],
    });

    await page.route('**/__spawn/complete', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    const approval = settle(alice.requestApproval({ kind: 'match', matchId }, { timeoutMs: 15_000 }));
    await page.getByRole('heading', { name: 'Confirm match entry', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reserve · 10 LOCAL', exact: true }).click();

    // The completion request is still delayed. A released harness mutex would reopen this same request.
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole('heading', { name: 'Confirm match entry', exact: true }).count(), 0);
    const result = await approval;
    assert.equal(result.error, undefined);
    assert.equal(result.value, 'reserved');
  } finally {
    await page?.close().catch(() => {});
    await browser?.close();
    await host?.close();
  }
});

test('failed or lost harness completion stays closed and releases the next approval', { timeout: 120_000 }, async () => {
  let host;
  let browser;
  let page;
  try {
    host = await startSpawnTestHost({ players: 2, gameDirectory });
    browser = await chromium.launch();
    const [alice, bob] = host.players;
    page = await openPlayer(browser, alice);
    const createMatch = async () => {
      const matchId = randomUUID();
      await host.matches.create({
        matchId,
        amount: '10',
        players: [
          { playerId: alice.playerId, launchId: alice.launchId },
          { playerId: bob.playerId, launchId: bob.launchId },
        ],
      });
      return matchId;
    };

    let completionMode = 'abort-before-consume';
    let lostRequestId = null;
    let staleMatchId = null;
    let stalePendingPolls = 0;
    await page.route('**/__spawn/complete', async (route) => {
      if (completionMode === 'abort-before-consume') {
        completionMode = 'normal';
        await route.abort('connectionreset');
        return;
      }
      if (completionMode === 'lose-after-consume') {
        const body = JSON.parse(route.request().postData() ?? '{}');
        lostRequestId = body.requestId;
        stalePendingPolls = 4;
        const response = await route.fetch();
        await route.fulfill({
          response,
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'The completion response was lost.' }),
        });
        completionMode = 'normal';
        return;
      }
      await route.continue();
    });
    await page.route('**/__spawn/pending', async (route) => {
      if (stalePendingPolls > 0 && lostRequestId) {
        stalePendingPolls -= 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            requestId: lostRequestId,
            kind: 'match',
            matchId: staleMatchId,
          }),
        });
        return;
      }
      await route.continue();
    });

    const firstMatch = await createMatch();
    // The first completion fails before reaching the host. The host still has
    // the request, so the browser must reconcile it without reopening the UI.
    const first = settle(alice.requestApproval({ kind: 'match', matchId: firstMatch }, { timeoutMs: 15_000 }));
    await page.getByRole('heading', { name: 'Confirm match entry', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reserve · 10 LOCAL', exact: true }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole('heading', { name: 'Confirm match entry', exact: true }).count(), 0);
    const firstResult = await first;
    assert.equal(firstResult.error, undefined);
    assert.equal(firstResult.value, 'reserved');
    await host.matches.cancel(firstMatch, 'cancelled');

    // The next completion is consumed by the host, but its browser response is
    // replaced with a failure. Replayed stale pending responses model the race
    // that used to reopen the same approval before the host poll caught up.
    completionMode = 'lose-after-consume';
    const secondMatch = await createMatch();
    staleMatchId = secondMatch;
    const second = settle(alice.requestApproval({ kind: 'match', matchId: secondMatch }, { timeoutMs: 15_000 }));
    await page.getByRole('heading', { name: 'Confirm match entry', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reserve · 10 LOCAL', exact: true }).click();
    await page.waitForTimeout(700);
    assert.equal(await page.getByRole('heading', { name: 'Confirm match entry', exact: true }).count(), 0);
    const secondResult = await second;
    assert.equal(secondResult.error, undefined);
    assert.equal(secondResult.value, 'reserved');
    await host.matches.cancel(secondMatch, 'cancelled');

    // Once the consumed request is reconciled, a fresh host request can open.
    stalePendingPolls = 0;
    const thirdMatch = await createMatch();
    const third = settle(alice.requestApproval({ kind: 'match', matchId: thirdMatch }, { timeoutMs: 15_000 }));
    await page.getByRole('heading', { name: 'Confirm match entry', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reserve · 10 LOCAL', exact: true }).click();
    const thirdResult = await third;
    assert.equal(thirdResult.error, undefined);
    assert.equal(thirdResult.value, 'reserved');
  } finally {
    await page?.close().catch(() => {});
    await browser?.close();
    await host?.close();
  }
});

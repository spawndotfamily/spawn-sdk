import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { startSpawnTestHost } from '../testing/local-host.mjs';

const TOKEN = 10n ** 18n;
const baseBalance = (tokens) => (BigInt(tokens) * TOKEN).toString();

async function jsonResponse(response) {
  const body = await response.text();
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    value = body;
  }
  assert.equal(response.ok, true, `${response.status} ${JSON.stringify(value)}`);
  return value;
}

async function playerPost(player, path, value) {
  return jsonResponse(
    await player.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    }),
  );
}

async function playerGet(player, path) {
  return jsonResponse(await player.fetch(path));
}

async function openPlayer(browser, player) {
  const page = await browser.newPage();
  await page.goto(player.url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: player.displayName, exact: true }).waitFor();
  return page;
}

function captureLocalHttpErrors(page) {
  const errors = [];
  page.on('response', (response) => {
    if (response.status() >= 400 && (response.url().includes('/api/v1/') || response.url().includes('/__spawn/')))
      errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

test('browser match approval reserves and refunds exact ledger balances', { timeout: 120_000 }, async () => {
  let host;
  let browser;
  const pages = [];
  try {
    host = await startSpawnTestHost({ players: 2, balance: baseBalance(100) });
    browser = await chromium.launch();
    const [alice, bob] = host.players;
    const alicePage = await openPlayer(browser, alice);
    const bobPage = await openPlayer(browser, bob);
    pages.push(alicePage, bobPage);
    const aliceHttpErrors = captureLocalHttpErrors(alicePage);
    const bobHttpErrors = captureLocalHttpErrors(bobPage);

    const matchId = randomUUID();
    await host.matches.create({
      matchId,
      amount: '10',
      players: [
        { playerId: alice.playerId, launchId: alice.launchId },
        { playerId: bob.playerId, launchId: bob.launchId },
      ],
    });

    const aliceApproval = alice.requestApproval({ kind: 'match', matchId });
    const bobApproval = bob.requestApproval({ kind: 'match', matchId });
    await Promise.all([
      alicePage.getByRole('heading', { name: 'Confirm match entry', exact: true }).waitFor(),
      bobPage.getByRole('heading', { name: 'Confirm match entry', exact: true }).waitFor(),
    ]);
    await Promise.all([
      alicePage.getByRole('button', { name: 'Reserve · 10 LOCAL', exact: true }).click(),
      bobPage.getByRole('button', { name: 'Reserve · 10 LOCAL', exact: true }).click(),
    ]);
    const [aliceResult, bobResult] = await Promise.all([aliceApproval, bobApproval]);
    assert.equal(aliceResult, 'reserved');
    assert.equal(bobResult, 'reserved');
    await Promise.all([alicePage.waitForTimeout(500), bobPage.waitForTimeout(500)]);
    assert.deepEqual([...aliceHttpErrors, ...bobHttpErrors], []);

    const reserved = await host.matches.status(matchId);
    assert.equal(reserved.status, 'pending');
    assert.equal(reserved.allConfirmed, true);
    assert.equal(reserved.confirmedPlayers, 2);
    assert.equal(alice.balance(), baseBalance(90));
    assert.equal(bob.balance(), baseBalance(90));

    const refund = await host.matches.cancel(matchId, 'cancelled');
    assert.equal(refund.status, 'cancelled');
    assert.equal((await host.matches.status(matchId)).status, 'cancelled');
    assert.equal(alice.balance(), baseBalance(100));
    assert.equal(bob.balance(), baseBalance(100));

    const cancelledMatchId = randomUUID();
    await host.matches.create({
      matchId: cancelledMatchId,
      amount: '4',
      players: [{ playerId: alice.playerId, launchId: alice.launchId }, { playerId: bob.playerId, launchId: bob.launchId }],
    });
    const cancelledApproval = alice.requestApproval({ kind: 'match', matchId: cancelledMatchId });
    await alicePage.getByRole('heading', { name: 'Confirm match entry', exact: true }).waitFor();
    await alicePage.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await cancelledApproval, 'cancelled');
    assert.equal((await host.matches.status(cancelledMatchId)).status, 'cancelled');
    assert.equal(alice.balance(), baseBalance(100));
    assert.equal(bob.balance(), baseBalance(100));
  } finally {
    await Promise.all(pages.map((page) => page.close().catch(() => {})));
    await browser?.close();
    await host?.close();
  }
});

test('browser trade approval settles and dismissal leaves the exact ledger unchanged', { timeout: 120_000 }, async () => {
  let host;
  let browser;
  const pages = [];
  try {
    host = await startSpawnTestHost({ players: 2, balance: baseBalance(100) });
    browser = await chromium.launch();
    const [alice, bob] = host.players;
    const alicePage = await openPlayer(browser, alice);
    const bobPage = await openPlayer(browser, bob);
    pages.push(alicePage, bobPage);
    const tradePath = `/api/v1/games/launches/${alice.launchId}/trades`;

    const tradeId = randomUUID();
    const created = await playerPost(alice, tradePath, {
      tradeId,
      recipientPlayerId: bob.playerId,
      recipientLaunchId: bob.launchId,
      amount: '10',
    });
    assert.equal(created.status, 'pending');
    assert.equal(created.self.amount, baseBalance(10));

    const bobApproval = bob.requestApproval({ kind: 'trade', tradeId });
    const bobResult = await bobApproval;
    assert.equal(bobResult.status, 'pending');
    assert.equal(bobResult.self.confirmed, true);

    const aliceApproval = alice.requestApproval({ kind: 'trade', tradeId });
    await alicePage.getByRole('button', { name: 'Approve · send 10 LOCAL', exact: true }).click();
    const aliceResult = await aliceApproval;
    assert.equal(aliceResult.status, 'settled');
    assert.equal((await playerGet(alice, `${tradePath}/${tradeId}`)).status, 'settled');
    assert.equal((await playerGet(bob, `/api/v1/games/launches/${bob.launchId}/trades/${tradeId}`)).status, 'settled');
    assert.equal(alice.balance(), baseBalance(90));
    assert.equal(bob.balance(), baseBalance(110));

    const dismissedTradeId = randomUUID();
    await playerPost(alice, tradePath, {
      tradeId: dismissedTradeId,
      recipientPlayerId: bob.playerId,
      recipientLaunchId: bob.launchId,
      amount: '5',
    });
    const dismissedApproval = alice.requestApproval({ kind: 'trade', tradeId: dismissedTradeId });
    await alicePage.getByRole('button', { name: 'Approve · send 5 LOCAL', exact: true }).waitFor();
    await alicePage.getByRole('button', { name: 'Back to game', exact: true }).click();
    assert.equal(await dismissedApproval, null);
    assert.equal((await playerGet(alice, `${tradePath}/${dismissedTradeId}`)).status, 'pending');
    assert.equal(alice.balance(), baseBalance(90));
    assert.equal(bob.balance(), baseBalance(110));

    const cancelled = await playerPost(alice, `${tradePath}/${dismissedTradeId}/cancel`, {});
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await playerGet(alice, `${tradePath}/${dismissedTradeId}`)).status, 'cancelled');
    assert.equal(alice.balance(), baseBalance(90));
    assert.equal(bob.balance(), baseBalance(110));
  } finally {
    await Promise.all(pages.map((page) => page.close().catch(() => {})));
    await browser?.close();
    await host?.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { createSpawnLaunchVerifier, createSpawnPaymentClient } from '../dist/server.js';
import { startSpawnTestHost } from '../testing/local-host.mjs';

const PAYMENT_AMOUNT = '0.25';
const PAYMENT_BASE_UNITS = '250000000000000000';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function waitFor(locator, expected, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await locator.textContent()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await locator.textContent(), expected);
}

function parseReceipt(text) {
  assert.match(text, /^\{.*\}$/);
  const value = JSON.parse(text);
  assert.deepEqual(Object.keys(value).sort(), ['amount', 'assetId', 'id', 'projectId', 'status']);
  assert.equal(typeof value.id, 'string');
  assert.equal(value.amount, PAYMENT_BASE_UNITS);
  assert.equal(value.status, 'paid');
  return value;
}

test('local multiplayer purchase receipts verify server-side and grant gold once across reconnects', { timeout: 90000 }, async () => {
  const paidRequestId = randomUUID();
  const cancelledRequestId = randomUUID();
  const lostRequestId = randomUUID();
  const browserModules = new Map();
  for (const name of ['multiplayer', 'token-balances', 'trades', 'table-validation'])
    browserModules.set(`/sdk/${name}.js`, await readFile(new URL(`../dist/${name}.js`, import.meta.url)));
  let hostOrigin = '';
  let gameOrigin = '';
  let verifier;
  let host;
  const game = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type, authorization');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    void (async () => {
      const path = new URL(request.url, gameOrigin).pathname;
      if (request.method === 'GET' && path === '/') {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><html><body>
          <p id="status">Connecting to Spawn…</p>
          <pre id="receipt"></pre>
          <button id="pay" disabled>Buy gold for 0.25 LOCAL</button>
          <button id="retry" disabled>Retry paid purchase</button>
          <button id="cancel" disabled>Cancel gold purchase</button>
          <button id="lost" disabled>Buy gold with lost response</button>
          <script type="module">
            import { createSpawnMultiplayerClient } from '/sdk/multiplayer.js';
            const sdk = createSpawnMultiplayerClient({
              platformOrigin: ${JSON.stringify(hostOrigin)},
              serverOrigin: ${JSON.stringify(gameOrigin)},
            });
            const status = document.querySelector('#status');
            const receipt = document.querySelector('#receipt');
            const buttons = [...document.querySelectorAll('button')];
            const ids = ${JSON.stringify({ paidRequestId, cancelledRequestId, lostRequestId })};
            function setStatus(value) { status.textContent = value; }
            async function join() {
              try {
                await sdk.ready();
                const grant = await sdk.requestGrant();
                const response = await fetch('/join', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ ticket: grant.ticket }),
                });
                const identity = await response.json();
                if (!response.ok) throw new Error(identity.error || 'Join failed.');
                window.__spawnIdentity = identity;
                setStatus('ready');
                buttons.forEach((button) => { button.disabled = false; });
                sdk.reportConnection('ready');
              } catch (error) {
                setStatus('join-error:' + (error instanceof Error ? error.message : String(error)));
              }
            }
            async function pay(requestId, label) {
              receipt.textContent = '';
              try {
                const value = await sdk.requestTokenPayment({
                  amount: ${JSON.stringify(PAYMENT_AMOUNT)},
                  item: label,
                  requestId,
                });
                receipt.textContent = JSON.stringify(value);
                setStatus(label === 'Gold pack' ? 'paid' : label === 'Cancelled gold' ? 'cancelled-paid' : label === 'Lost response gold' ? 'lost-paid' : 'retry-paid');
              } catch (error) {
                setStatus(label === 'Cancelled gold' ? 'cancelled' : 'lost-error:' + (error instanceof Error ? error.message : String(error)));
              }
            }
            document.querySelector('#pay').onclick = () => void pay(ids.paidRequestId, 'Gold pack');
            document.querySelector('#retry').onclick = () => void pay(ids.paidRequestId, 'Gold pack');
            document.querySelector('#cancel').onclick = () => void pay(ids.cancelledRequestId, 'Cancelled gold');
            document.querySelector('#lost').onclick = () => void pay(ids.lostRequestId, 'Lost response gold');
            void join();
          </script>
        </body></html>`);
        return;
      }
      if (request.method === 'GET' && browserModules.has(path)) {
        response.setHeader('content-type', 'application/javascript; charset=utf-8');
        response.end(browserModules.get(path));
        return;
      }
      if (request.method !== 'POST' || path !== '/join') {
        response.writeHead(404).end();
        return;
      }
      let text = '';
      for await (const chunk of request) text += chunk;
      const input = JSON.parse(text);
      const identity = verifier.consume(input.ticket);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        playerId: identity.playerId,
        launchId: identity.sessionId,
        displayName: identity.displayName,
      }));
    })().catch((error) => {
      response.writeHead(error.status ?? 400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  const journalDirectory = await mkdtemp(join(tmpdir(), 'spawn-purchase-verification-'));
  const journalPath = join(journalDirectory, 'gold.sqlite');
  let journal;
  let browser;
  try {
    gameOrigin = await listen(game);
    host = await startSpawnTestHost({ players: 1, gameUrl: gameOrigin });
    hostOrigin = host.origin;
    verifier = createSpawnLaunchVerifier({
      ...host.verification,
      minimumIssuedAt: Math.floor(Date.now() / 1000) - 1,
    });
    const payments = host.payments ?? createSpawnPaymentClient(host.clientOptions);
    const player = host.players[0];
    const paymentClient = payments;
    const lookupUntilPaid = async (input, timeout = 10000) => {
      const end = Date.now() + timeout;
      let result;
      do {
        result = await paymentClient.lookup(input);
        if (result.status === 'paid') return result;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < end);
      return result;
    };

    journal = new DatabaseSync(journalPath);
    journal.exec(`CREATE TABLE purchase_orders(
      request_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      launch_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      item TEXT NOT NULL,
      amount TEXT NOT NULL,
      asset_id TEXT NOT NULL
    );
    CREATE TABLE receipt_claims(
      receipt_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      player_id TEXT NOT NULL
    );
    CREATE TABLE gold_inventory(
      receipt_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      item TEXT NOT NULL,
      gold INTEGER NOT NULL
    )`);
    const insertOrder = journal.prepare(`INSERT INTO purchase_orders
      (request_id, player_id, launch_id, project_id, item, amount, asset_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insertOrder.run(paidRequestId, player.playerId, player.launchId, host.projectId, 'Gold pack', PAYMENT_BASE_UNITS, host.asset.id);
    insertOrder.run(cancelledRequestId, player.playerId, player.launchId, host.projectId, 'Cancelled gold', PAYMENT_BASE_UNITS, host.asset.id);
    insertOrder.run(lostRequestId, player.playerId, player.launchId, host.projectId, 'Lost response gold', PAYMENT_BASE_UNITS, host.asset.id);
    const issueGold = (lookup) => {
      assert.equal(lookup.status, 'paid');
      assert.ok(lookup.receipt);
      const order = journal.prepare('SELECT * FROM purchase_orders WHERE request_id=?').get(lookup.requestId);
      assert.ok(order, 'server keeps a durable order before granting an item');
      assert.equal(lookup.playerId, order.player_id);
      assert.equal(lookup.launchId, order.launch_id);
      assert.equal(lookup.item, order.item);
      assert.equal(lookup.receipt.projectId, order.project_id);
      assert.equal(lookup.receipt.assetId, order.asset_id);
      assert.equal(lookup.receipt.amount, order.amount);
      assert.equal(lookup.receipt.status, 'paid');
      journal.exec('BEGIN IMMEDIATE');
      try {
        const prior = journal.prepare('SELECT request_id FROM receipt_claims WHERE receipt_id=?').get(lookup.receipt.id);
        if (prior) {
          assert.equal(prior.request_id, order.request_id, 'a receipt cannot be claimed by another order');
          journal.exec('COMMIT');
          return 0;
        }
        journal.prepare('INSERT INTO receipt_claims (receipt_id, request_id, player_id) VALUES (?, ?, ?)')
          .run(lookup.receipt.id, order.request_id, order.player_id);
        journal.prepare('INSERT INTO gold_inventory (receipt_id, player_id, item, gold) VALUES (?, ?, ?, ?)')
          .run(lookup.receipt.id, order.player_id, order.item, 250);
        journal.exec('COMMIT');
        return 1;
      } catch (error) {
        journal.exec('ROLLBACK');
        throw error;
      }
    };
    const countGold = () => {
      const row = journal.prepare('SELECT count(*) AS count, coalesce(sum(gold), 0) AS total FROM gold_inventory').get();
      return { count: Number(row.count), total: Number(row.total) };
    };

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 420, height: 820 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(player.url);
    let frame = page.frameLocator('iframe');
    const status = () => frame.locator('#status');
    await waitFor(status(), 'ready');

    await frame.getByRole('button', { name: 'Buy gold for 0.25 LOCAL' }).click();
    await page.getByText('Gold pack', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Confirm · spend 0.25 LOCAL', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await waitFor(status(), 'paid');
    const browserReceipt = parseReceipt(await frame.locator('#receipt').textContent());
    assert.equal(browserReceipt.assetId, host.asset.id);
    assert.equal(browserReceipt.projectId, host.projectId);
    const paidLookup = await paymentClient.lookup({
      playerId: player.playerId,
      requestId: paidRequestId,
      launchId: player.launchId,
    });
    assert.deepEqual(paidLookup, {
      status: 'paid',
      playerId: player.playerId,
      requestId: paidRequestId,
      launchId: player.launchId,
      item: 'Gold pack',
      receipt: browserReceipt,
    });
    assert.deepEqual(
      await paymentClient.lookup({ playerId: player.playerId, receiptId: browserReceipt.id }),
      paidLookup,
      'the same paid record is recoverable by its receipt ID',
    );
    assert.equal(issueGold(paidLookup), 1);

    journal.close();
    journal = undefined;
    await page.reload();
    frame = page.frameLocator('iframe');
    await waitFor(frame.locator('#status'), 'ready');
    await frame.getByRole('button', { name: 'Retry paid purchase' }).click();
    await waitFor(frame.locator('#status'), 'paid');
    const retryLookup = await paymentClient.lookup({
      playerId: player.playerId,
      requestId: paidRequestId,
      launchId: player.launchId,
    });
    journal = new DatabaseSync(journalPath);
    assert.equal(issueGold(retryLookup), 0, 'reloading and retrying the same receipt must not grant twice');
    assert.deepEqual(countGold(), { count: 1, total: 250 });

    await frame.getByRole('button', { name: 'Cancel gold purchase' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await waitFor(frame.locator('#status'), 'cancelled');
    const cancelledLookup = await paymentClient.lookup({
      playerId: player.playerId,
      requestId: cancelledRequestId,
      launchId: player.launchId,
    });
    assert.equal(cancelledLookup.status, 'cancelled');
    assert.equal(cancelledLookup.receipt, null);
    assert.deepEqual(countGold(), { count: 1, total: 250 }, 'cancelled payment must issue no item');

    let lostConfirmSeen;
    const lostConfirm = new Promise((resolve) => { lostConfirmSeen = resolve; });
    const onRequest = (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && /\/api\/v1\/token-payment-quotes\/[0-9a-f-]{36}\/confirm$/i.test(url.pathname)) {
        host.loseNextResponse(url.pathname);
        lostConfirmSeen();
      }
    };
    page.on('request', onRequest);
    await frame.getByRole('button', { name: 'Buy gold with lost response' }).click();
    await page.getByRole('button', { name: 'Confirm · spend 0.25 LOCAL', exact: true }).click();
    await lostConfirm;
    await page.waitForTimeout(250);
    await page.reload();
    frame = page.frameLocator('iframe');
    await waitFor(frame.locator('#status'), 'ready');
    page.off('request', onRequest);
    const lostLookup = await lookupUntilPaid({
      playerId: player.playerId,
      requestId: lostRequestId,
      launchId: player.launchId,
    });
    assert.equal(lostLookup.status, 'paid');
    assert.equal(lostLookup.requestId, lostRequestId);
    assert.equal(lostLookup.launchId, player.launchId);
    assert.equal(lostLookup.item, 'Lost response gold');
    assert.ok(lostLookup.receipt);
    assert.equal(lostLookup.receipt.assetId, host.asset.id);
    assert.equal(issueGold(lostLookup), 1);
    assert.equal(issueGold(await paymentClient.lookup({
      playerId: player.playerId,
      requestId: lostRequestId,
      launchId: player.launchId,
    })), 0);
    assert.deepEqual(countGold(), { count: 2, total: 500 });
    assert.deepEqual(pageErrors, []);
  } finally {
    journal?.close();
    await browser?.close();
    await host?.close();
    await closeServer(game);
    await rm(journalDirectory, { recursive: true, force: true });
  }
});

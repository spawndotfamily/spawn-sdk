/** Run from your game project after installing @playwright/test as a dev dependency. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { startSpawnTestHost } from '@spawndotfamily/sdk/testing/local-host.mjs';

const host = await startSpawnTestHost({ players: 4, balance: '100000000000000000000' });
const browser = await chromium.launch();
try {
  const table = await host.tables.create({ tableId: randomUUID(), operationId: randomUUID(), maxSeats: 6 });
  for (const [index, player] of host.players.entries()) {
    const page = await browser.newPage();
    await page.goto(player.url);
    const quote = await host.tables.requestBuyIn(table.tableId, {
      operationId: randomUUID(), buyInId: randomUUID(),
      player: { playerId: player.playerId, launchId: player.launchId },
      amount: index === 3 ? '101000000000000000000' : '10000000000000000000',
    });
    const approval = player.requestApproval({ kind: 'table', tableId: table.tableId, buyInId: quote.buyInId });
    await page.locator('.table-buyin-confirmation').getByText(host.asset.address, { exact: false }).first().waitFor();
    if (index >= 2) {
      if (index === 3) assert.equal(await page.getByRole('button', { name: /^Approve/ }).isDisabled(), true);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await approval;
      assert.equal((await host.tables.buyIn(table.tableId, quote.buyInId)).status, 'cancelled');
      assert.equal(player.balance(), '100000000000000000000');
    } else {
      await page.getByRole('button', { name: /^Approve/ }).click();
      await approval;
      assert.equal((await host.tables.buyIn(table.tableId, quote.buyInId)).status, 'confirmed');
      assert.equal(player.balance(), '90000000000000000000');
    }
    await page.close();
  }
  const funded = await host.tables.status(table.tableId);
  await Promise.all(funded.seats.map(seat => host.tables.cashOut(table.tableId, { operationId: randomUUID(), playerId: seat.playerId, seatId: seat.seatId })));
  const done = await host.tables.status(table.tableId);
  assert.equal(done.totals.backing, '0');
  assert.equal(done.totals.buyIns, done.totals.cashOuts);
  console.log('PASS: real approval UI, two approvals, cancellation, insufficient balance, exact balances and concurrent cash-outs. Simulated funds only.');
} finally { await browser.close(); await host.close(); }

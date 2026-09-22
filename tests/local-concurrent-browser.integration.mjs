import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { startSpawnTestHost } from '../testing/local-host.mjs';

test('six independent browsers approve concurrently without crossing player authority', { timeout: 60000 }, async () => {
  const host = await startSpawnTestHost({ players: 6, balance: '100000000000000000000' });
  let browser;
  try {
    browser = await chromium.launch();
    const table = await host.tables.create({ tableId: randomUUID(), operationId: randomUUID(), maxSeats: 6 });
    await Promise.all(host.players.map(async (player, index) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(player.url);
        const amount = String(BigInt(index + 1) * 10n ** 18n);
        const quote = await host.tables.requestBuyIn(table.tableId, {
          operationId: randomUUID(), buyInId: randomUUID(), amount,
          player: { playerId: player.playerId, launchId: player.launchId },
        });
        const approval = player.requestApproval({ kind: 'table', tableId: table.tableId, buyInId: quote.buyInId });
        await page.locator('.table-buyin-confirmation').getByText(host.asset.address, { exact: false }).first().waitFor();
        await page.getByRole('button', { name: /^Approve/ }).click();
        await approval;
        assert.equal((await host.tables.buyIn(table.tableId, quote.buyInId)).status, 'confirmed');
        assert.equal(player.balance(), String(100n * 10n ** 18n - BigInt(amount)));
      } finally { await context.close(); }
    }));
    const status = await host.tables.status(table.tableId);
    assert.equal(status.seats.length, 6);
    assert.equal(status.totals.buyIns, '21000000000000000000');
    await Promise.all(status.seats.map(seat => host.tables.cashOut(table.tableId, { operationId: randomUUID(), playerId: seat.playerId, seatId: seat.seatId })));
    assert.equal((await host.tables.status(table.tableId)).totals.backing, '0');
    for (const player of host.players) assert.equal(player.balance(), '100000000000000000000');
  } finally { await browser?.close(); await host.close(); }
});

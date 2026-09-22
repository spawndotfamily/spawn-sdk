import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createSpawnPaymentClient } from '@spawndotfamily/sdk/server';

// This is a complete synthetic server flow. The fetch fixture has the platform's
// response shape but is not hosted proof; replace it with the real platform
// transport and keep the same transaction in the creator server's own database.
const projectId = '10000000-1111-4111-8111-111111111111';
const playerId = '20000000-2222-4222-8222-222222222222';
const launchId = '30000000-3333-4333-8333-333333333333';
const requestId = randomUUID(); // Generated and journaled by the server before Continue.
const receiptId = randomUUID();
const item = 'starter sword';
const amount = '1250000000000000000';
const assetId = `erc20:46630:0x${'a'.repeat(40)}`;
const credential = 'p'.repeat(43);

const journalDirectory = await mkdtemp(join(tmpdir(), 'spawn-verified-token-purchase-'));
const journalPath = join(journalDirectory, 'purchases.sqlite');
let db;
function openJournal() {
  const journal = new DatabaseSync(journalPath);
  journal.exec(`
    CREATE TABLE IF NOT EXISTS purchase_orders(
      request_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      launch_id TEXT NOT NULL,
      item TEXT NOT NULL,
      amount TEXT NOT NULL,
      asset_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receipt_claims(
      receipt_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      player_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory(
      receipt_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      item TEXT NOT NULL
    );
  `);
  return journal;
}

try {
  db = openJournal();

  // The authoritative server derives playerId and launchId from its verified
  // launch grant. The browser only receives the same durable requestId and the
  // catalog amount/item; it never supplies proof to this transaction.
  db.prepare('INSERT INTO purchase_orders VALUES (?, ?, ?, ?, ?, ?)').run(
    requestId,
    playerId,
    launchId,
    item,
    amount,
    assetId,
  );

const paidLookup = {
  status: 'paid',
  playerId,
  requestId,
  launchId,
  item,
  receipt: { id: receiptId, assetId, amount, projectId, status: 'paid' },
};

  const payments = createSpawnPaymentClient({
    platformOrigin: 'https://spawn.example',
    projectId,
    credential,
    fetch: async (url, init) => {
      if (url !== `https://spawn.example/api/v1/registered-games/${projectId}/token-payments/lookup` ||
          init?.method !== 'POST')
        throw new Error('unexpected lookup request');
      return Response.json(paidLookup);
    },
  });

  function issuePaidItem(result) {
    const order = db.prepare('SELECT * FROM purchase_orders WHERE request_id=?').get(requestId);
    if (!order || result.status !== 'paid' || !result.receipt ||
        result.playerId !== order.player_id || result.requestId !== order.request_id ||
        result.launchId !== order.launch_id || result.item !== order.item ||
        result.receipt.projectId !== projectId || result.receipt.assetId !== order.asset_id ||
        result.receipt.amount !== order.amount || result.receipt.status !== 'paid')
      throw new Error('The paid lookup does not match the saved purchase order.');

    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT request_id FROM receipt_claims WHERE receipt_id=?').get(result.receipt.id);
      if (prior) {
        if (prior.request_id !== order.request_id) throw new Error('Receipt already belongs to another order.');
        db.exec('COMMIT');
        return { delivered: false, replay: true };
      }
      db.prepare('INSERT INTO receipt_claims VALUES (?, ?, ?)').run(
        result.receipt.id,
        order.request_id,
        order.player_id,
      );
      db.prepare('INSERT INTO inventory VALUES (?, ?, ?)').run(
        result.receipt.id,
        order.player_id,
        order.item,
      );
      db.exec('COMMIT');
      return { delivered: true, replay: false };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // A normal browser success and a timeout recovery both use this same lookup
  // tuple. A missing result is unresolved: it is never permission to create a
  // replacement order or debit the player again. Cancellation also delivers no item.
  const verified = await payments.lookup({ playerId, requestId, launchId });
  const first = issuePaidItem(verified);

  // Simulate a process restart: reopen the durable journal before reconciling the
  // same paid receipt. The unique claim makes this replay a no-op.
  db.close();
  db = openJournal();
  const replay = issuePaidItem(verified);
  console.log(JSON.stringify({ status: verified.status, first, replay, inventory: db.prepare('SELECT * FROM inventory').all() }, null, 2));
} finally {
  db?.close();
  await rm(journalDirectory, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import test from "node:test";
import { createTradeMethods, validateTrade } from "../src/trades.ts";
const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const asset = {
  id: "erc20:46630:0x" + "1".repeat(40),
  chainId: 46630,
  address: "0x" + "1".repeat(40),
  name: "Coin",
  symbol: "COIN",
  decimals: 18,
  image: "",
  source: "spawn",
  enabled: true,
};
const view = {
  tradeId: id(1),
  projectId: id(2),
  version: 1,
  quoteId: id(3),
  status: "pending",
  asset,
  self: { playerId: id(4), handle: "Alice", amount: "1000000000000000000", confirmed: false },
  other: { playerId: id(5), handle: "Bob", amount: "0", confirmed: false },
  balance: "2000000000000000000",
  expiresAt: 1800000000000,
  settledAt: null,
  platformFee: "0",
};
void test("trade adapter sends exact amounts and versions, without contracts or credentials", async () => {
  const calls: unknown[] = [];
  const client = createTradeMethods(async (action, payload) => {
    calls.push({ action, payload });
    return view;
  });
  await client.create({
    tradeId: id(1),
    recipientPlayerId: id(5),
    recipientLaunchId: id(6),
    amount: "1.000000000000000001",
  });
  await client.offer(id(1), 1, "0");
  await client.accept(id(1), 1);
  await client.get(id(1));
  await client.cancel(id(1));
  assert.deepEqual(calls[0], {
    action: "create",
    payload: {
      tradeId: id(1),
      recipientPlayerId: id(5),
      recipientLaunchId: id(6),
      amount: "1.000000000000000001",
    },
  });
  assert.deepEqual(calls[2], { action: "accept", payload: { tradeId: id(1), version: 1 } });
  await assert.rejects(client.offer(id(1), 1, "1e18"), /decimal/);
  await assert.rejects(client.offer(id(1), 0, "1"), /version/);
  assert.equal(calls.length, 5);
});
void test("a dismissed popup is not cancellation or settlement, and malformed receipts cannot report success", async () => {
  const client = createTradeMethods(async () => null);
  assert.equal(await client.accept(id(1), 1), null);
  await assert.rejects(client.get(id(1)), /Invalid/);
  assert.throws(() => validateTrade({ ...view, status: "settled" }, id(1)), /settlement/);
  assert.throws(
    () => validateTrade({ ...view, asset: { ...asset, address: "0x" + "2".repeat(40) } }, id(1)),
    /asset/,
  );
  assert.throws(
    () => validateTrade({ ...view, self: { ...view.self, amount: 10 } }, id(1)),
    /participant/,
  );
  assert.throws(() => validateTrade(view, id(7)), /Invalid/);
});
void test("context provides scoped identifiers, never account credentials; transport failures are not retried", async () => {
  let calls = 0;
  const client = createTradeMethods(async () => {
    calls++;
    throw new Error("offline");
  });
  await assert.rejects(client.accept(id(1), 1), /offline/);
  assert.equal(calls, 1);
  const context = createTradeMethods(async () => ({
    playerId: id(4),
    launchId: id(6),
    projectId: id(2),
  }));
  assert.deepEqual(await context.context(), { playerId: id(4), launchId: id(6), projectId: id(2) });
});

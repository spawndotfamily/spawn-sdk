import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSpawnMatchClient, SpawnMatchRequestError } from "../src/match-server.ts";
const projectId = randomUUID(),
  matchId = randomUUID(),
  credential = "a".repeat(43);
const players = [
  { playerId: randomUUID(), launchId: randomUUID() },
  { playerId: randomUUID(), launchId: randomUUID() },
];
const response = () =>
  Response.json({
    matchId,
    projectId,
    status: "pending",
    allConfirmed: false,
    players: [
      { playerId: players[0].playerId, confirmed: false },
      { playerId: players[1].playerId, confirmed: false },
    ],
  });
test("server match client pins project, strips cookies and forbids redirects", async () => {
  const calls: [string, RequestInit][] = [];
  const client = createSpawnMatchClient({
    platformOrigin: "https://spawn.example",
    projectId,
    credential,
    fetch: async (url, init) => {
      calls.push([String(url), init!]);
      return response();
    },
  });
  await client.create({ matchId, amount: "0.000000000000000001", players });
  await client.status(matchId);
  assert.equal(calls[0][0], `https://spawn.example/api/v1/registered-games/${projectId}/matches`);
  assert.deepEqual(JSON.parse(calls[0][1].body as string), {
    matchId,
    amount: "0.000000000000000001",
    players,
  });
  assert.equal(calls[0][1].credentials, "omit");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(new Headers(calls[0][1].headers).get("authorization"), "Bearer " + credential);
  assert.equal(calls[1][1].method, "GET");
});
test("server match client rejects ambiguous inputs before any request", async () => {
  let calls = 0;
  const client = createSpawnMatchClient({
    platformOrigin: "https://spawn.example",
    projectId,
    credential,
    fetch: async () => {
      calls++;
      return response();
    },
  });
  for (const amount of [
    "1e3",
    "-1",
    "0",
    "01",
    "1.",
    " 1",
    "1.0000000000000000000000000000000000001",
  ])
    await assert.rejects(client.create({ matchId, amount, players }));
  await assert.rejects(client.create({ matchId, amount: "1", players: [players[0], players[0]] }));
  await assert.rejects(client.create({ matchId, amount: "1", players, asset: "fake" } as any));
  await assert.rejects(
    client.settle(matchId, {
      reason: "victory",
      payouts: [{ playerId: players[0].playerId, amount: "1e3" }],
    }),
  );
  assert.equal(calls, 0);
  for (const platformOrigin of [
    "http://spawn.example",
    "https://spawn.example/path",
    "https://u:p@spawn.example",
    "https://spawn.example/?x=1",
  ])
    assert.throws(() => createSpawnMatchClient({ platformOrigin, projectId, credential }));
});
test("unknown mutation outcomes never retry or expose server error bodies", async () => {
  let calls = 0;
  const client = createSpawnMatchClient({
    platformOrigin: "https://spawn.example",
    projectId,
    credential,
    fetch: async () => {
      calls++;
      throw new Error("secret upstream detail");
    },
  });
  await assert.rejects(
    client.capture(matchId),
    (e: any) =>
      e instanceof SpawnMatchRequestError &&
      e.outcomeUnknown === true &&
      !e.message.includes("secret"),
  );
  assert.equal(calls, 1);
  const denied = createSpawnMatchClient({
    platformOrigin: "https://spawn.example",
    projectId,
    credential,
    fetch: async () => new Response("secret", { status: 401 }),
  });
  await assert.rejects(
    denied.status(matchId),
    (e: any) => e.status === 401 && e.outcomeUnknown === false && !e.message.includes("secret"),
  );
});
test("mismatched or oversized responses fail without reporting success", async () => {
  const bad = createSpawnMatchClient({
    platformOrigin: "https://spawn.example",
    projectId,
    credential,
    fetch: async () => Response.json({ matchId: randomUUID(), status: "settled" }),
  });
  await assert.rejects(
    bad.settle(matchId, {
      reason: "victory",
      payouts: [{ playerId: players[0].playerId, amount: "2" }],
    }),
    (e: any) => e.outcomeUnknown === true,
  );
  const big = createSpawnMatchClient({
    platformOrigin: "https://spawn.example",
    projectId,
    credential,
    fetch: async () => new Response("x".repeat(65537)),
  });
  await assert.rejects(big.status(matchId));
});

test("UUID spelling is canonicalized consistently across requests and responses", async () => {
  let sent: any;
  const client = createSpawnMatchClient({
    platformOrigin: "https://spawn.example",
    projectId: projectId.toUpperCase(),
    credential,
    fetch: async (_, init) => {
      sent = JSON.parse(String(init?.body));
      return response();
    },
  });
  await client.create({
    matchId: matchId.toUpperCase(),
    amount: "10",
    players: players.map((p) => ({
      playerId: p.playerId.toUpperCase(),
      launchId: p.launchId.toUpperCase(),
    })),
  });
  assert.equal(sent.matchId, matchId);
  assert.deepEqual(sent.players, players);
});

test("a capture response cannot falsely report a pending match as started", async () => {
  const client = createSpawnMatchClient({
    platformOrigin: "https://spawn.example",
    projectId,
    credential,
    fetch: async () => response(),
  });
  await assert.rejects(client.capture(matchId), (e: any) => e.outcomeUnknown === true);
});

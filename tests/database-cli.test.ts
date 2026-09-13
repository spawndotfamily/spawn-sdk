import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli/index.ts";
test("agent database commands require explicit scoped credentials and preserve versioned JSON writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spawn-db-cli-"));
  try {
    const credentials = join(dir, "credentials.json"),
      patch = join(dir, "patch.json");
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const config = {
      platformOrigin: "https://spawn.family",
      projectId: id,
      publishKey: "local-test",
      expiresAt: Date.now() + 60000,
      scopes: ["data:read", "data:write", "data:configure"],
    };
    await writeFile(credentials, JSON.stringify(config));
    await writeFile(
      patch,
      JSON.stringify({ expectedVersion: 4, value: { inventory: [[{ item: "bow", count: 2 }]] } }),
    );
    const calls: { url: string; init?: RequestInit }[] = [],
      errors: string[] = [];
    const run = (args: string[]) =>
      main(
        [...args, "--credentials", credentials],
        {},
        async (url, init) => {
          calls.push({ url: String(url), init });
          return Response.json({ version: 5 });
        },
        {
          log() {},
          error(m) {
            errors.push(m);
          },
        },
      );
    assert.equal(await run(["database", "set", id, "inventory", patch]), 0);
    assert.equal(
      calls[0].url,
      `https://spawn.family/api/v1/publish/${id}/database/players/${id}/data/inventory`,
    );
    assert.equal(calls[0].init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      expectedVersion: 4,
      value: { inventory: [[{ item: "bow", count: 2 }]] },
    });
    assert.equal(calls[0].init?.redirect, "error");
    await writeFile(credentials, JSON.stringify({ ...config, scopes: ["build:upload"] }));
    assert.equal(await run(["database", "players"]), 1);
    assert.equal(calls.length, 1);
    assert.match(errors.at(-1)!, /data:read|credential/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

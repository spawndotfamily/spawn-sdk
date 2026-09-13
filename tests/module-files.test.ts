import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBrowserBuild, publishBrowserDirectory } from "../src/cli/upload-client.ts";

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "spawn-modules-"));
  try {
    await mkdir(join(dir, "client"));
    await writeFile(
      join(dir, "index.html"),
      '<script type="module" src="./client/main.js"></script>',
    );
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("rejects an omitted vendored SDK dependency before any upload request", async () => {
  await fixture(async (dir) => {
    await writeFile(join(dir, "client/main.js"), 'import { jsonSave } from "./game-data.js";');
    await assert.rejects(inspectBrowserBuild(dir), /client\/main\.js.*client\/game-data\.js/);
    let requests = 0;
    await assert.rejects(
      publishBrowserDirectory(
        {
          apiUrl: "https://spawn.family",
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          publishKey: "test-only",
        },
        dir,
        undefined,
        async () => {
          requests++;
          throw new Error("No request expected");
        },
      ),
      /game-data\.js/,
    );
    assert.equal(requests, 0);
    await writeFile(join(dir, "client/game-data.js"), "export const jsonSave = () => {};");
    assert.equal((await inspectBrowserBuild(dir)).files.length, 3);
  });
});

test("checks literal dynamic imports and re-exports with case-sensitive URL resolution", async () => {
  await fixture(async (dir) => {
    await writeFile(
      join(dir, "client/main.js"),
      'export * from "./Game.js?version=1#start"; import("./lazy.js");',
    );
    await writeFile(join(dir, "client/game.js"), "export const value = 1;");
    await writeFile(join(dir, "client/lazy.js"), "export default 1;");
    await assert.rejects(inspectBrowserBuild(dir), /Game\.js/);
    await rm(join(dir, "client/game.js"));
    await writeFile(join(dir, "client/Game.js"), "export const value = 1;");
    assert.equal((await inspectBrowserBuild(dir)).files.length, 4);
    await rm(join(dir, "client/lazy.js"));
    await assert.rejects(inspectBrowserBuild(dir), /lazy\.js/);
  });
});

test("ignores import-looking comments, strings and regular expressions without executing game code", async () => {
  await fixture(async (dir) => {
    await writeFile(
      join(dir, "client/main.js"),
      `// import './absent.js';\nconst text = "import('./missing.js')"; const rx = /import\\('ghost'\\)/; throw new Error('Do not execute this game');`,
    );
    assert.equal((await inspectBrowserBuild(dir)).files.length, 2);
  });
});

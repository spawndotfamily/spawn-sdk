import { readBoundedFile } from "./files.ts";
import { PublishCliError, PROJECT_ID_PATTERN, isRecord, requestJson } from "./api.ts";
import type { PublishConfig, FetchLike } from "./api.ts";
export const DATABASE_USAGE = `  spawn-publish database settings|players|scores [offset] --credentials <file>
  spawn-publish database configure <settings.json> --credentials <file>
  spawn-publish database records <player-id> --credentials <file>
  spawn-publish database set|remove <player-id> <key> <record.json> --credentials <file>
Database tools use private creator credentials, never browser code. Changes do not move tokens.`;
export type DatabaseCommand = {
  kind: "database";
  credentialsPath: string;
  path: string;
  method: "GET" | "PUT" | "DELETE";
  scope: string;
  file?: string;
};
function fail(message: string): never {
  throw new PublishCliError(message);
}
export function parseDatabaseCommand(argv: string[], credentialsPath?: string): DatabaseCommand {
  if (!credentialsPath) fail("Database commands require a downloaded --credentials file.");
  const [, action, ...args] = argv;
  const command = (
    path: string,
    method: DatabaseCommand["method"],
    scope: string,
    file?: string,
  ): DatabaseCommand => ({ kind: "database", credentialsPath, path, method, scope, file });
  if (action === "settings" && !args.length) return command("settings", "GET", "data:read");
  if (["players", "scores"].includes(action) && args.length <= 1) {
    const offset = args.length ? Number(args[0]) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      fail("Use a page offset from 0 to 100000.");
    return command(
      (action === "scores" ? "submissions" : action) + "?offset=" + offset,
      "GET",
      "data:read",
    );
  }
  if (action === "configure" && args.length === 1)
    return command("settings", "PUT", "data:configure", args[0]);
  if (!PROJECT_ID_PATTERN.test(args[0] ?? ""))
    fail("Provide the stable game player ID from database players.");
  if (action === "records" && args.length === 1)
    return command(`players/${args[0]}/data`, "GET", "data:read");
  if (
    !["set", "remove"].includes(action) ||
    args.length !== 3 ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(args[1]) ||
    args[1].startsWith("_spawn_")
  )
    fail(
      "Use database set|remove <player-id> <key> <record.json>; reserved score records use score controls.",
    );
  return command(
    `players/${args[0]}/data/${args[1]}`,
    action === "set" ? "PUT" : "DELETE",
    "data:write",
    args[2],
  );
}
export async function runDatabaseCommand(
  config: PublishConfig,
  command: DatabaseCommand,
  fetchImplementation: FetchLike,
) {
  if (!config.scopes?.includes(command.scope))
    fail(
      `This operation requires ${command.scope}. Download a new creator credential from Spawn; never add scopes by editing the file.`,
    );
  let input: Record<string, unknown> | undefined;
  if (command.file) {
    try {
      input = JSON.parse(new TextDecoder().decode(await readBoundedFile(command.file, 80000)));
    } catch (error) {
      if (error instanceof PublishCliError) throw error;
      fail("Provide a valid database JSON file.");
    }
    if (!isRecord(input) || Array.isArray(input)) fail("Database changes must be a JSON object.");
    const fields =
      command.path === "settings"
        ? ["enabled", "mode", "direction", "expectedVersion"]
        : command.method === "DELETE"
          ? ["expectedVersion"]
          : ["value", "expectedVersion"];
    if (
      Object.keys(input).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(input!, key))
    )
      fail("Database JSON must contain exactly the documented fields.");
    if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0)
      fail("Read the current record/settings and provide its expectedVersion.");
  }
  return requestJson(
    config,
    `${config.apiUrl}/api/v1/publish/${config.projectId}/database/${command.path}`,
    {
      method: command.method,
      headers: { authorization: `Bearer ${config.publishKey}`, "content-type": "application/json" },
      ...(input ? { body: JSON.stringify(input) } : {}),
    },
    fetchImplementation,
  );
}

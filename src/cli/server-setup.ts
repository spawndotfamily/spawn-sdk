// @ts-ignore Node-only CLI module.
import { mkdir, open, lstat, readFile, realpath } from 'node:fs/promises';
// @ts-ignore Node-only CLI module.
import { resolve, isAbsolute, join } from 'node:path';
// @ts-ignore Node-only CLI module.
import { randomBytes, createHash } from 'node:crypto';
import {
  PublishCliError,
  validatePublishConfig,
  requestJson,
  isRecord,
} from './api.ts';
import type { PublishConfig, FetchLike } from './api.ts';

export const SERVER_USAGE = `  spawn-publish server status --credentials <file>
  spawn-publish server enable --server-origin <https-origin> --websocket-path <path> --audience <audience> --out-dir <absolute-private-directory> --version <version> --creator-confirmation --credentials <file>
  spawn-publish server disable --version <version> --creator-confirmation --credentials <file>
Server setup requires a freshly downloaded server:configure credential. Use a new private directory to rotate keys; preserve it for retry.`;
export type ServerCommand = {
  kind: 'server';
  action: 'status' | 'enable' | 'disable';
  credentialsPath: string;
  version?: number;
  serverOrigin?: string;
  webSocketPath?: string;
  audience?: string;
  outDir?: string;
};
function fail(s: string): never {
  throw new PublishCliError(s);
}
export function parseServerCommand(
  argv: string[],
  credentialsPath?: string,
): ServerCommand {
  if (!credentialsPath) fail('Server commands require --credentials.');
  const action = argv[1];
  if (!['status', 'enable', 'disable'].includes(action)) fail(SERVER_USAGE);
  const values = new Map<string, string>();
  let confirmed = false;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--creator-confirmation') {
      if (confirmed) fail('Duplicate confirmation.');
      confirmed = true;
      continue;
    }
    if (
      ![
        '--version',
        '--server-origin',
        '--websocket-path',
        '--audience',
        '--out-dir',
      ].includes(flag) ||
      values.has(flag) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith('--')
    )
      fail('Invalid or duplicate server option.');
    values.set(flag, argv[++i]);
  }
  if (action === 'status') {
    if (values.size || confirmed) fail('status accepts only credentials.');
    return { kind: 'server', action, credentialsPath };
  }
  const versionText = values.get('--version');
  if (
    !versionText ||
    !/^(0|[1-9][0-9]*)$/.test(versionText) ||
    !Number.isSafeInteger(Number(versionText)) ||
    !confirmed
  )
    fail('Use --version from server status and --creator-confirmation.');
  if (action === 'disable') {
    if (values.size !== 1)
      fail('disable accepts version and confirmation only.');
    return {
      kind: 'server',
      action,
      credentialsPath,
      version: Number(versionText),
    };
  }
  if (values.size !== 5) fail(SERVER_USAGE);
  const raw = values.get('--server-origin')!;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('Use an exact HTTPS server origin.');
  }
  if (
    url!.protocol !== 'https:' ||
    url!.username ||
    url!.password ||
    url!.pathname !== '/' ||
    url!.search ||
    url!.hash
  )
    fail('Use an exact HTTPS server origin.');
  const path = values.get('--websocket-path')!,
    audience = values.get('--audience')!,
    outDir = values.get('--out-dir')!;
  if (
    !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(audience) ||
    !isAbsolute(outDir)
  )
    fail(
      'Use a valid server path, audience and absolute private output directory.',
    );
  return {
    kind: 'server',
    action: 'enable',
    credentialsPath,
    version: Number(versionText),
    serverOrigin: url!.origin,
    webSocketPath: path,
    audience,
    outDir: resolve(outDir),
  };
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
async function privateFile(
  path: string,
  initial: () => string,
): Promise<string> {
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      const text = initial();
      await file.writeFile(text);
      await file.sync();
      return text;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 16384
  )
    fail('Existing setup files must be private regular files.');
  return readFile(path, 'utf8');
}
function state(value: Record<string, unknown>, config: PublishConfig) {
  if (
    value.projectId !== config.projectId ||
    !Number.isSafeInteger(value.version) ||
    typeof value.matchesEnabled !== 'boolean'
  )
    fail('Invalid server setup response.');
  return value;
}
export async function runServerCommand(
  input: PublishConfig,
  command: ServerCommand,
  fetcher: FetchLike,
) {
  const config = validatePublishConfig(input);
  if (!config.scopes?.includes('server:configure'))
    fail('Download fresh creator credentials with server:configure.');
  const url = `${config.apiUrl}/api/v1/publish/${config.projectId}/server`,
    headers = { Authorization: `Bearer ${config.publishKey}` };
  const before = state(
    await requestJson(config, url, { method: 'GET', headers }, fetcher),
    config,
  );
  if (command.action === 'status') return before;
  let payload: Record<string, unknown> = {
    action: command.action,
    version: command.version,
    creatorConfirmation: true,
  };
  let outDir: string | undefined;
  if (command.action === 'enable') {
    outDir = command.outDir!;
    try {
      await mkdir(outDir, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
    // A separate, new directory is required for first setup/rotation. Retries use existing files below.
  }
  return mutate();
  async function mutate() {
    if (command.action === 'enable') {
      const dir = outDir!,
        stat = await lstat(dir);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        (await realpath(dir)) !== dir
      )
        fail('Use a private directory without symlink components.');
      const expected = JSON.stringify({
        projectId: config.projectId,
        platformOrigin: config.apiUrl,
        serverOrigin: command.serverOrigin,
        webSocketPath: command.webSocketPath,
        audience: command.audience,
        version: command.version,
      });
      const metadata = await privateFile(
        join(dir, 'setup.json'),
        () => expected,
      );
      if (metadata !== expected)
        fail(
          'This directory belongs to different settings. Preserve it; use a new directory for a deliberate rotation.',
        );
      const match = (
        await privateFile(
          join(dir, 'match.key'),
          () => randomBytes(32).toString('base64url') + '\n',
        )
      ).trim();
      const storage = before.registration
        ? null
        : (
            await privateFile(
              join(dir, 'storage.key'),
              () => randomBytes(32).toString('base64url') + '\n',
            )
          ).trim();
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(match) ||
        (storage !== null &&
          (!/^[A-Za-z0-9_-]{43}$/.test(storage) || match === storage))
      )
        fail('Invalid private server key files.');
      payload = {
        ...payload,
        serverOrigin: command.serverOrigin,
        webSocketPath: command.webSocketPath,
        audience: command.audience,
        matchKeyHash: digest(match),
        storageKeyHash: storage === null ? null : digest(storage),
      };
      if (
        before.matchesEnabled &&
        before.keyFingerprint === payload.matchKeyHash &&
        isRecord(before.registration) &&
        before.registration.serverOrigin === command.serverOrigin &&
        before.registration.webSocketPath === command.webSocketPath &&
        before.registration.audience === command.audience
      )
        return finish(before, dir);
    }
    if (before.version !== command.version)
      fail(
        'Server settings changed. Run server status and review before retrying. Your private files are preserved.',
      );
    const result = state(
      await requestJson(
        config,
        url,
        {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        fetcher,
      ),
      config,
    );
    return command.action === 'enable' ? finish(result, outDir!) : result;
  }
  async function finish(result: Record<string, unknown>, dir: string) {
    if (
      !result.matchesEnabled ||
      result.keyFingerprint !== payload.matchKeyHash ||
      !isRecord(result.verification)
    )
      fail(
        'Setup result is incomplete. Preserve private files and check server status.',
      );
    const proof = result.verification;
    if (
      proof.issuer !==
        (config.apiUrl === 'https://publish.spawnfamily.com'
          ? 'https://spawn.family'
          : config.apiUrl) ||
      proof.gameId !== config.projectId ||
      proof.audience !== command.audience ||
      proof.environment !== 'sandbox' ||
      !isRecord(proof.publicKeys) ||
      !Object.keys(proof.publicKeys).length ||
      Object.values(proof.publicKeys).some(
        (key) =>
          typeof key !== 'string' ||
          !key.startsWith('-----BEGIN PUBLIC KEY-----'),
      )
    )
      fail(
        'Verification settings do not match this game. Preserve private files and check server status.',
      );
    const verification = JSON.stringify(result.verification, null, 2) + '\n';
    const stored = await privateFile(
      join(dir, 'verification.json'),
      () => verification,
    );
    if (stored !== verification)
      fail(
        'Verification material changed; review server status before replacing it.',
      );
    return {
      projectId: config.projectId,
      version: result.version,
      matchesEnabled: true,
      privateDirectory: dir,
      verificationFile: join(dir, 'verification.json'),
      next: 'Install match.key and verification.json privately on your own server. The existing match.key covers game-scoped tables as well as matches. Keep storage.key only if using Spawn game storage. Configure a durable match/table journal, restart your server, then test with two consenting signed-in players. No player tokens were moved by setup.',
    };
  }
}

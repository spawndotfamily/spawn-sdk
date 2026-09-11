import { readBoundedFile } from './files.ts';
import { PublishCliError, PROJECT_ID_PATTERN, normalizeApiUrl, validatePublishConfig, isRecord, redact, requestJson } from './api.ts';
import type { PublishConfig, FetchLike } from './api.ts';
export { PublishCliError, PUBLISH_REQUEST_TIMEOUT_MS } from './api.ts';
export type { PublishConfig } from './api.ts';
import { parseListingCommand, runListingCommand, LISTING_USAGE } from './listing.ts';
import type { ListingCommand } from './listing.ts';
import { inspectBrowserBuild, publishBrowserDirectory } from './upload-client.ts';
// @ts-ignore Node's runtime modules are available to the CLI without adding a runtime dependency.
import { lstat, opendir, realpath } from 'node:fs/promises';
// @ts-ignore Node's runtime modules are available to the CLI without adding a runtime dependency.
import { basename, join, relative, resolve, sep } from 'node:path';

export const MAX_TOTAL_BYTES = 25_000_000;
export const MAX_FILE_BYTES = 25_000_000;
export const MAX_FILES = 1_000;
export const MAX_TRAVERSED_ENTRIES = 10_000;
export const MAX_DIRECTORY_DEPTH = 64;

const BROWSER_ASSET_EXTENSIONS = new Set([
  'html',
  'js',
  'mjs',
  'css',
  'json',
  'wasm',
  'data',
  'pck',
  'unityweb',
  'bundle',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'svg',
  'ico',
  'avif',
  'mp3',
  'ogg',
  'wav',
  'mp4',
  'webm',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'txt',
  'atlas',
  'bin',
  'glb',
  'gltf',
  'ktx2',
]);

const SECRET_NAME = /(^|[._-])(secret|secrets|credential|credentials|private[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|token)([._-]|$)/i;
const SECRET_SUFFIX = /\.(pem|key|p12|pfx|jks|keystore|crt)$/i;
const PRIVATE_KEY_MARKER = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/;
const SOURCE_SECRET_MARKER = /(?:["']?(?:publish[_-]?key|private[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?token)["']?\s*[:=]|sp_pub_[A-Za-z0-9_-]{20,})/i;

export type BrowserBundleFile = {
  path: string;
  data: string;
};

export type BrowserBundle = {
  entry: 'index.html';
  files: BrowserBundleFile[];
  sourceCommit?: string;
};

export type ReleaseResponse = {
  id?: unknown;
  status?: unknown;
  previewUrl?: unknown;
  checks?: unknown;
  [key: string]: unknown;
};

type NodeDirent = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type NodeDirectoryHandle = {
  [Symbol.asyncIterator](): AsyncIterator<NodeDirent>;
  close(): Promise<void>;
};

type NodeStat = {
  ino: number; dev: number;
  size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type NodeBuffer = {
  toString(encoding: 'base64'): string;
};

type NodeBufferConstructor = {
  from(data: Uint8Array): NodeBuffer;
};

type RuntimeProcess = {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
};

type Command =
  | ListingCommand
  | { kind: 'help' }
  | { kind: 'check'; directory: string }
  | { kind: 'publish'; directory: string; sourceCommit?: string; credentialsPath?: string }
  | { kind: 'status'; releaseId: string; credentialsPath?: string };

export const CLI_USAGE = `Usage:
  spawn-publish check <browser-build-directory>
  spawn-publish publish <browser-build-directory> [--credentials <file>] [--source-commit <40-hex-commit>]
  spawn-publish status <release-id> [--credentials <file>]
${LISTING_USAGE}
`;

function runtimeProcess(): RuntimeProcess {
  const processValue = (globalThis as unknown as { process?: RuntimeProcess }).process;
  if (!processValue) throw new PublishCliError('The publishing CLI requires Node.js.');
  return processValue;
}

function nodeBuffer(): NodeBufferConstructor {
  const bufferValue = (globalThis as unknown as { Buffer?: NodeBufferConstructor }).Buffer;
  if (!bufferValue) throw new PublishCliError('The publishing CLI requires Node.js.');
  return bufferValue;
}

function formatLimit(value: number): string {
  return value.toLocaleString('en-US');
}

function validateSegment(segment: string): void {
  if (!segment || segment === '.' || segment === '..') {
    throw new PublishCliError('Build paths cannot contain dot segments.');
  }
  if (segment.startsWith('.')) {
    throw new PublishCliError('Hidden files and directories are not allowed in browser builds.');
  }
  if (segment.toLowerCase() === 'node_modules') {
    throw new PublishCliError('node_modules cannot be uploaded in a browser build.');
  }
  if (SECRET_NAME.test(segment) || SECRET_SUFFIX.test(segment)) {
    throw new PublishCliError('Source secret files are not allowed in browser builds.');
  }
}

function extensionOf(filePath: string): string {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

function validateBrowserAsset(filePath: string): void {
  const extension = extensionOf(filePath);
  if (extension === 'map') {
    throw new PublishCliError('Source maps (.map) are not accepted in browser builds.');
  }
  if (!BROWSER_ASSET_EXTENSIONS.has(extension)) {
    throw new PublishCliError(`Unsupported browser asset extension for ${extension || 'file'}.`);
  }
}

function assertRelativePayloadPath(filePath: string): void {
  if (filePath.startsWith('/') || filePath.includes('\\')) {
    throw new PublishCliError('Browser bundle paths must be relative POSIX paths.');
  }
  const segments = filePath.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || segment === '')) {
    throw new PublishCliError('Browser bundle paths cannot contain dot segments.');
  }
}

async function readRegularFile(filePath: string, stat: NodeStat): Promise<Uint8Array> {
  if (stat.size > MAX_FILE_BYTES) {
    throw new PublishCliError(
      `A browser asset exceeds the ${formatLimit(MAX_FILE_BYTES)} byte file limit.`,
    );
  }
  let contents: Uint8Array;
  try {
    contents = await readBoundedFile(filePath, MAX_FILE_BYTES, stat);
  } catch {
    throw new PublishCliError('Unable to read a browser build file.');
  }
  if (contents.byteLength > MAX_FILE_BYTES) {
    throw new PublishCliError(
      `A browser asset exceeds the ${formatLimit(MAX_FILE_BYTES)} byte file limit.`,
    );
  }
  const text = new TextDecoder().decode(contents);
  if (PRIVATE_KEY_MARKER.test(text) || SOURCE_SECRET_MARKER.test(text)) {
    throw new PublishCliError('Private key material is not allowed in browser builds.');
  }
  return contents;
}

export async function buildBrowserBundle(directory: string): Promise<BrowserBundle> {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new PublishCliError('A prebuilt browser directory is required.');
  }

  let root = resolve(directory);
  let rootStat: NodeStat;
  try {
    rootStat = await lstat(root) as NodeStat;
  } catch {
    throw new PublishCliError('Unable to inspect the browser build directory.');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new PublishCliError('The browser build path must be an existing directory.');
  }

  root = await realpath(root) as string;
  const rootNow = await lstat(root) as NodeStat;
  if (rootNow.ino !== rootStat.ino || rootNow.dev !== rootStat.dev) throw new PublishCliError('Build directory changed; stop the build watcher and try again.');
  const files: BrowserBundleFile[] = [];
  let totalBytes = 0;
  let entryText: string | undefined;
  let traversedEntries = 0;

  async function visit(currentDirectory: string, depth: number): Promise<void> {
    if (depth > MAX_DIRECTORY_DEPTH) {
      throw new PublishCliError(
        `Browser build directory nesting exceeds the ${formatLimit(MAX_DIRECTORY_DEPTH)} level limit.`,
      );
    }
    let directoryHandle: NodeDirectoryHandle;
    try {
      directoryHandle = await opendir(currentDirectory) as unknown as NodeDirectoryHandle;
    } catch {
      throw new PublishCliError('Unable to inspect the browser build directory.');
    }

    const entries: NodeDirent[] = [];
    try {
      for await (const entry of directoryHandle) {
        traversedEntries += 1;
        if (traversedEntries > MAX_TRAVERSED_ENTRIES) {
          throw new PublishCliError(
            `Browser builds may contain at most ${formatLimit(MAX_TRAVERSED_ENTRIES)} traversed entries.`,
          );
        }
        entries.push(entry);
      }
    } catch (error) {
      if (error instanceof PublishCliError) throw error;
      throw new PublishCliError('Unable to inspect the browser build directory.');
    } finally {
      try {
        await directoryHandle.close();
      } catch {
        // The directory is already closed when iteration finishes.
      }
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      validateSegment(entry.name);
      const absolutePath = join(currentDirectory, entry.name);
      let stat: NodeStat;
      try {
        stat = await lstat(absolutePath) as NodeStat;
      } catch {
        throw new PublishCliError('Unable to inspect the browser build directory.');
      }

      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new PublishCliError('Symlinks are not allowed in browser builds.');
      }
      if (stat.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        throw new PublishCliError('Browser builds may contain only regular files.');
      }

      if (files.length >= MAX_FILES) {
        throw new PublishCliError(`Browser builds may contain at most ${formatLimit(MAX_FILES)} files.`);
      }

      const relativePath = relative(root, absolutePath).split(sep).join('/');
      assertRelativePayloadPath(relativePath);
      validateBrowserAsset(relativePath);
      if (await realpath(absolutePath) !== absolutePath) throw new PublishCliError('Symlinked build directories are not accepted.');
      const contents = await readRegularFile(absolutePath, stat);
      if (await realpath(absolutePath) !== absolutePath) throw new PublishCliError('Build directory changed; stop the build watcher and try again.');
      totalBytes += contents.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new PublishCliError(
          `The browser build exceeds the ${formatLimit(MAX_TOTAL_BYTES)} byte decoded size limit.`,
        );
      }
      files.push({ path: relativePath, data: nodeBuffer().from(contents).toString('base64') });
      if (relativePath === 'index.html') entryText = new TextDecoder().decode(contents);
    }
  }

  await visit(root, 0);
  if (!files.some((file) => file.path === 'index.html')) {
    throw new PublishCliError('Browser builds must contain a root index.html entry file.');
  }
  if (!entryText || !/<(?:html|body|canvas|script|div|button)\b/i.test(entryText)) {
    throw new PublishCliError('The index.html entry must contain a browser page.');
  }

  return { entry: 'index.html', files };
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new PublishCliError(`Missing required environment variable ${name}.`);
  return value;
}

export function readConfig(env: Record<string, string | undefined> = runtimeProcess().env): PublishConfig {
  const apiUrl = normalizeApiUrl(requiredEnv(env, 'SPAWN_API_URL'));
  const projectId = requiredEnv(env, 'SPAWN_PROJECT_ID');
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new PublishCliError('SPAWN_PROJECT_ID must be a UUID.');
  }
  const publishKey = requiredEnv(env, 'SPAWN_PUBLISH_KEY');
  const uploadOrigin = env.SPAWN_UPLOAD_ORIGIN?.trim();
  return validatePublishConfig({ apiUrl, projectId, publishKey, ...(uploadOrigin ? { uploadOrigin } : {}) });
}

export type PublishCredentials = {
  platformOrigin: string;
  uploadOrigin?: string;
  projectId: string;
  publishKey: string;
  expiresAt: string | number;
  scopes?: readonly string[];
};

export async function readCredentialsFile(credentialsPath: string, now = Date.now()): Promise<PublishConfig> {
  if (typeof credentialsPath !== 'string' || credentialsPath.trim() === '') {
    throw new PublishCliError('A credentials file path is required.');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedFile(credentialsPath, 65_536));
  } catch {
    throw new PublishCliError('Unable to read the credentials file.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new PublishCliError('The credentials file must contain valid JSON.');
  }
  if (!isRecord(parsed)) throw new PublishCliError('The credentials file must contain one JSON object.');
  const required = ['platformOrigin', 'projectId', 'publishKey', 'expiresAt'];
  const allowed = new Set([...required, 'uploadOrigin', 'scopes']);
  const keys = Object.keys(parsed);
  if (keys.some((key) => !allowed.has(key))) {
    throw new PublishCliError('The credentials file contains unknown fields.');
  }
  if (required.some(key => !keys.includes(key))) {
    throw new PublishCliError('The credentials file is missing required fields.');
  }
  if (
    typeof parsed.platformOrigin !== 'string' ||
    (parsed.uploadOrigin !== undefined && typeof parsed.uploadOrigin !== 'string') ||
    typeof parsed.projectId !== 'string' ||
    typeof parsed.publishKey !== 'string' ||
    (typeof parsed.expiresAt !== 'string' && typeof parsed.expiresAt !== 'number')
  ) {
    throw new PublishCliError('The credentials file has invalid fields.');
  }
  const expiresAt = typeof parsed.expiresAt === 'number'
    ? (Number.isSafeInteger(parsed.expiresAt) ? parsed.expiresAt : NaN)
    : Date.parse(parsed.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new PublishCliError('The credentials file has an invalid expiry.');
  if (expiresAt <= now) throw new PublishCliError('The credentials file has expired.');

  if (parsed.scopes !== undefined && (!Array.isArray(parsed.scopes) || parsed.scopes.length > 3 || parsed.scopes.some(scope => typeof scope !== 'string' || !['build:read', 'build:upload', 'listing:write'].includes(scope)) || new Set(parsed.scopes).size !== parsed.scopes.length)) {
    throw new PublishCliError('The credentials file has invalid scopes.');
  }
  const config = {
    ...(parsed.scopes === undefined ? {} : { scopes: parsed.scopes as string[] }),
    apiUrl: normalizeApiUrl(parsed.platformOrigin.trim()),
    ...(parsed.uploadOrigin === undefined ? {} : { uploadOrigin: normalizeApiUrl(parsed.uploadOrigin.trim()) }),
    projectId: parsed.projectId.trim(),
    publishKey: parsed.publishKey.trim(),
  };
  if (!config.projectId || !PROJECT_ID_PATTERN.test(config.projectId)) {
    throw new PublishCliError('The credentials file has an invalid project ID.');
  }
  if (!config.publishKey) throw new PublishCliError('The credentials file has an invalid publish key.');
  return config;
}

function validateSourceCommit(value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new PublishCliError('sourceCommit must contain exactly 40 hexadecimal characters.');
  }
  return value;
}

export function parseCommand(argv: string[]): Command {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { kind: 'help' };

  if (argv[0] === 'check') {
    if (argv.length !== 2 || argv[1].startsWith('-')) throw new PublishCliError('check requires one browser-build directory.');
    return { kind: 'check', directory: argv[1] };
  }

  let credentialsPath: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--credentials') {
      const value = argv[index + 1];
      if (credentialsPath) throw new PublishCliError('Duplicate credentials option.');
      if (!value) throw new PublishCliError('--credentials requires a file path.');
      credentialsPath = value;
      index += 1;
    } else if (argument.startsWith('--credentials=')) {
      if (credentialsPath) throw new PublishCliError('Duplicate credentials option.');
      const value = argument.slice('--credentials='.length);
      if (!value) throw new PublishCliError('--credentials requires a file path.');
      credentialsPath = value;
    } else {
      positional.push(argument);
    }
  }

  if (positional[0] === 'listing' || positional[0] === 'image') {
    return parseListingCommand(positional, credentialsPath);
  }

  if (positional[0] === 'status') {
    if (positional.length !== 2 || !/^[A-Za-z0-9_-]{1,128}$/.test(positional[1])) {
      throw new PublishCliError('status requires one safe release ID.');
    }
    return { kind: 'status', releaseId: positional[1], credentialsPath };
  }

  let directory: string | undefined;
  let sourceCommit: string | undefined;
  const args = positional[0] === 'publish' ? positional.slice(1) : positional;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--source-commit') {
      const value = args[index + 1];
      if (!value) throw new PublishCliError('--source-commit requires a 40-character commit.');
      sourceCommit = validateSourceCommit(value);
      index += 1;
    } else if (argument.startsWith('--source-commit=')) {
      sourceCommit = validateSourceCommit(argument.slice('--source-commit='.length));
    } else if (argument.startsWith('-')) {
      throw new PublishCliError('Unknown CLI option.');
    } else if (!directory) {
      directory = argument;
    } else {
      throw new PublishCliError('publish accepts one browser-build directory.');
    }
  }
  if (!directory) throw new PublishCliError(CLI_USAGE.trim());
  return { kind: 'publish', directory, sourceCommit, credentialsPath };
}

function releaseCollectionUrl(config: PublishConfig): string {
  return `${config.apiUrl.replace(/\/+$/, '')}/api/v1/publish/${encodeURIComponent(config.projectId)}/releases`;
}

function releaseStatusUrl(config: PublishConfig, releaseId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(releaseId)) {
    throw new PublishCliError('releaseId must be a safe release identifier.');
  }
  return `${releaseCollectionUrl(config)}/${encodeURIComponent(releaseId)}`;
}

export async function uploadRelease(
  config: PublishConfig,
  payload: BrowserBundle,
  fetchImplementation: FetchLike = globalThis.fetch,
): Promise<ReleaseResponse> {
  const validatedConfig = validatePublishConfig(config);
  const body: BrowserBundle = {
    entry: 'index.html',
    files: payload.files,
  };
  if (payload.sourceCommit !== undefined) body.sourceCommit = validateSourceCommit(payload.sourceCommit);
  return requestJson(validatedConfig, releaseCollectionUrl(validatedConfig), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${validatedConfig.publishKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, fetchImplementation);
}

export async function getReleaseStatus(
  config: PublishConfig,
  releaseId: string,
  fetchImplementation: FetchLike = globalThis.fetch,
): Promise<ReleaseResponse> {
  const validatedConfig = validatePublishConfig(config);
  return requestJson(validatedConfig, releaseStatusUrl(validatedConfig, releaseId), {
    method: 'GET',
    headers: { Authorization: `Bearer ${validatedConfig.publishKey}` },
  }, fetchImplementation);
}

function displayPreviewUrl(value: unknown, baseUrl?: string): unknown {
  if (typeof value !== 'string' || !baseUrl) return value;
  try {
    const resolved = new URL(value, `${baseUrl}/`);
    if (!['http:', 'https:'].includes(resolved.protocol)) return value;
    return resolved.toString();
  } catch {
    return value;
  }
}

function isExactLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

function useExplicitLocalLegacyPublisher(config: PublishConfig): boolean {
  // The old 25 MB simulator is retained only for local reference installations.
  // Every remote origin, and every local origin with an explicit worker, uses the
  // negotiated streaming protocol and never falls back after a request fails.
  return isExactLoopbackOrigin(config.apiUrl) && config.uploadOrigin === undefined;
}

export function formatReleaseSummary(response: unknown, secret?: string, baseUrl?: string): string {
  const value = isRecord(response) ? response : {};
  const summary = {
    id: value.id,
    status: value.status,
    previewUrl: displayPreviewUrl(value.previewUrl, baseUrl),
    checks: value.checks,
  };
  return redact(JSON.stringify(summary), secret);
}

export type CliOutput = {
  log(message: string): void;
  error(message: string): void;
};

export async function main(
  argv: string[] = runtimeProcess().argv.slice(2),
  env: Record<string, string | undefined> = runtimeProcess().env,
  fetchImplementation: FetchLike = globalThis.fetch,
  output: CliOutput = { log: (message) => console.log(message), error: (message) => console.error(message) },
): Promise<number> {
  let publishKey: string | undefined;
  try {
    const command = parseCommand(argv);
    if (command.kind === 'help') {
      output.log(CLI_USAGE.trimEnd());
      return 0;
    }

    if (command.kind === 'check') {
      const bundle = await inspectBrowserBuild(command.directory);
      output.log(JSON.stringify({ format: 'spawn-browser-v1', entry: bundle.entry, files: bundle.files.length, bytes: bundle.bytes, playableVerified: false, next: 'Run spawn-dev on this directory, then upload a private preview with spawn-publish publish.' }));
      return 0;
    }
    const config = command.credentialsPath
      ? await readCredentialsFile(command.credentialsPath)
      : readConfig(env);
    publishKey = config.publishKey;
    if (command.kind === 'status') {
      const response = await getReleaseStatus(config, command.releaseId, fetchImplementation);
      output.log(formatReleaseSummary(response, publishKey, config.apiUrl));
      return 0;
    }

    if (command.kind === 'listing') {
      const response = await runListingCommand(config, command, fetchImplementation);
      output.log(redact(JSON.stringify(response), publishKey));
      return 0;
    }

    const sourceCommit = command.sourceCommit ?? env.SPAWN_SOURCE_COMMIT?.trim();
    const response = useExplicitLocalLegacyPublisher(config)
      ? await uploadRelease(
        config,
        Object.assign(await buildBrowserBundle(command.directory), sourceCommit ? { sourceCommit: validateSourceCommit(sourceCommit) } : {}),
        fetchImplementation,
      )
      : await publishBrowserDirectory(config, command.directory, sourceCommit, fetchImplementation);
    output.log(formatReleaseSummary(response, publishKey, config.apiUrl));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Spawn publish failed.';
    output.error(redact(message, publishKey ?? env.SPAWN_PUBLISH_KEY));
    return 1;
  }
}

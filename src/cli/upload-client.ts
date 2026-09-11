import {
  PublishCliError,
  isRecord,
  requestJson,
  validatePublishConfig,
} from './api.ts';
import type { FetchLike, PublishConfig } from './api.ts';
// @ts-ignore Node's runtime modules are available to the CLI without adding a runtime dependency.
import { createHash } from 'node:crypto';
// @ts-ignore Node's runtime modules are available to the CLI without adding a runtime dependency.
import { constants } from 'node:fs';
// @ts-ignore Node's runtime modules are available to the CLI without adding a runtime dependency.
import { lstat, open, opendir, realpath } from 'node:fs/promises';
// @ts-ignore Node's runtime modules are available to the CLI without adding a runtime dependency.
import { basename, join, relative, resolve, sep } from 'node:path';

/** The worker contract fixes every upload chunk at eight mebibytes. */
export const CHUNK_BYTES = 8_388_608;
/** Safety ceiling for client-side inspection; the platform's default admission is 1 GB. */
export const STREAM_MAX_TOTAL_BYTES = 8_000_000_000;
export const STREAM_MAX_FILE_BYTES = 8_000_000_000;
export const STREAM_MAX_HTML_BYTES = 1_000_000;
export const STREAM_MAX_FILES = 1_000;
export const STREAM_MAX_TRAVERSED_ENTRIES = 10_000;
export const STREAM_MAX_DIRECTORY_DEPTH = 64;
export const STREAM_MAX_RETRIES = 3;

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

type NodeStat = {
  ino: number;
  dev: number;
  size: number;
  mtimeMs?: number;
  ctimeMs?: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
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

type NodeFileHandle = {
  fd: number;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<NodeStat>;
  close(): Promise<void>;
};

type Hash = {
  update(data: Uint8Array | string): Hash;
  digest(encoding: 'hex'): string;
};

type HashFactory = (algorithm: string) => Hash;

export type StreamingBuildFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type StreamingBuildManifest = {
  entry: 'index.html';
  files: StreamingBuildFile[];
  sourceCommit?: string;
};

export type StreamingBuild = StreamingBuildManifest & {
  bytes: number;
};

export type UploadProgress = Record<string, unknown>;

export type StreamingPublishOptions = {
  sourceCommit?: string;
  onProgress?: (progress: UploadProgress) => void;
  retries?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type FileSnapshot = {
  ino: number;
  dev: number;
  size: number;
  mtimeMs?: number;
  ctimeMs?: number;
};

type PreparedBuildFile = StreamingBuildFile & {
  absolutePath: string;
  snapshot: FileSnapshot;
  chunkSha256: string[];
};

type PreparedBuild = StreamingBuild & {
  root: string;
  rootSnapshot: FileSnapshot;
  preparedFiles: PreparedBuildFile[];
};

type UploadSession = {
  uploadId: string;
  uploadOrigin: string;
  token: string;
  chunkBytes: number;
  expiresAt: string | number;
};

function fail(message: string): never {
  throw new PublishCliError(message);
}

function formatLimit(value: number): string {
  return value.toLocaleString('en-US');
}

function hashFactory(): HashFactory {
  return createHash as unknown as HashFactory;
}

function validateSourceCommit(value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new PublishCliError('sourceCommit must contain exactly 40 hexadecimal characters.');
  }
  return value;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function snapshot(stat: NodeStat): FileSnapshot {
  return {
    ino: stat.ino,
    dev: stat.dev,
    size: stat.size,
    ...(typeof stat.mtimeMs === 'number' ? { mtimeMs: stat.mtimeMs } : {}),
    ...(typeof stat.ctimeMs === 'number' ? { ctimeMs: stat.ctimeMs } : {}),
  };
}

function sameSnapshot(left: NodeStat | FileSnapshot, right: NodeStat | FileSnapshot): boolean {
  return left.ino === right.ino &&
    left.dev === right.dev &&
    left.size === right.size &&
    (left.mtimeMs === undefined || right.mtimeMs === undefined || left.mtimeMs === right.mtimeMs) &&
    (left.ctimeMs === undefined || right.ctimeMs === undefined || left.ctimeMs === right.ctimeMs);
}

function validateSegment(segment: string): void {
  if (!segment || segment === '.' || segment === '..' || segment.startsWith('.')) {
    throw new PublishCliError('Hidden files and dot segments are not allowed in browser builds.');
  }
  if (['node_modules', '__MACOSX'].includes(segment.toLowerCase())) {
    throw new PublishCliError('node_modules and __MACOSX are not allowed in browser builds.');
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
  if (extensionOf(filePath) === 'map') {
    throw new PublishCliError('Source maps (.map) are not accepted in browser builds.');
  }
  if (!BROWSER_ASSET_EXTENSIONS.has(extensionOf(filePath))) {
    throw new PublishCliError(`Unsupported browser asset extension for ${extensionOf(filePath) || 'file'}.`);
  }
}

function assertRelativePayloadPath(filePath: string): void {
  if (
    filePath.length < 1 ||
    filePath.length > 240 ||
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    !/^[A-Za-z0-9_][A-Za-z0-9_./ -]*$/.test(filePath)
  ) {
    throw new PublishCliError('Browser bundle paths must be safe relative POSIX paths.');
  }
  const segments = filePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new PublishCliError('Browser bundle paths cannot contain dot segments.');
  }
}

function inspectTextChunk(
  bytes: Uint8Array,
  decoder: TextDecoder,
  carry: { value: string },
  entry: { value: string },
  captureEntry: boolean,
  forbiddenSecret?: string,
): void {
  const decoded = decoder.decode(bytes, { stream: true });
  const text = carry.value + decoded;
  if (PRIVATE_KEY_MARKER.test(text) || SOURCE_SECRET_MARKER.test(text)) {
    throw new PublishCliError('Private key material is not allowed in browser builds.');
  }
  if (forbiddenSecret && text.includes(forbiddenSecret)) {
    throw new PublishCliError('Publishing credentials must not appear in browser build files.');
  }
  carry.value = text.slice(-Math.max(512, forbiddenSecret ? forbiddenSecret.length - 1 : 0));
  if (captureEntry && entry.value.length <= STREAM_MAX_HTML_BYTES) entry.value += decoded;
}

async function inspectFile(
  absolutePath: string,
  stat: NodeStat,
  isEntry: boolean,
  isHtml: boolean,
  forbiddenSecret?: string,
): Promise<{ sha256: string; bytes: number; entryText: string; chunkSha256: string[] }> {
  if (stat.size > STREAM_MAX_FILE_BYTES) {
    throw new PublishCliError(`A browser asset exceeds the ${formatLimit(STREAM_MAX_FILE_BYTES)} byte file limit.`);
  }
  if (isHtml && stat.size > STREAM_MAX_HTML_BYTES) {
    throw new PublishCliError(`An HTML file exceeds the ${formatLimit(STREAM_MAX_HTML_BYTES)} byte limit.`);
  }
  let handle: NodeFileHandle | undefined;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    ) as unknown as NodeFileHandle;
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || !sameSnapshot(opened, stat)) {
      fail('Build file changed while it was being inspected.');
    }
    const hash = hashFactory()('sha256');
    const chunkSha256: string[] = [];
    let chunkHash = hashFactory()('sha256');
    let chunkOffset = 0;
    const buffer = new Uint8Array(Math.min(1_048_576, STREAM_MAX_FILE_BYTES));
    const decoder = new TextDecoder();
    const carry = { value: '' };
    const entry = { value: '' };
    let bytes = 0;
    while (bytes < stat.size) {
      const want = Math.min(buffer.byteLength, stat.size - bytes);
      const { bytesRead } = await handle.read(buffer, 0, want, bytes);
      if (bytesRead <= 0) fail('Build file ended while it was being inspected.');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let chunkCursor = 0;
      while (chunkCursor < chunk.byteLength) {
        const chunkLength = Math.min(chunk.byteLength - chunkCursor, CHUNK_BYTES - chunkOffset);
        chunkHash.update(chunk.subarray(chunkCursor, chunkCursor + chunkLength));
        chunkCursor += chunkLength;
        chunkOffset += chunkLength;
        if (chunkOffset === CHUNK_BYTES) {
          chunkSha256.push(chunkHash.digest('hex'));
          chunkHash = hashFactory()('sha256');
          chunkOffset = 0;
        }
      }
      inspectTextChunk(chunk, decoder, carry, entry, isEntry, forbiddenSecret);
      bytes += bytesRead;
    }
    const finalText = decoder.decode();
    const finalScan = carry.value + finalText;
    if (PRIVATE_KEY_MARKER.test(finalScan) || SOURCE_SECRET_MARKER.test(finalScan)) {
      throw new PublishCliError('Private key material is not allowed in browser builds.');
    }
    if (forbiddenSecret && finalScan.includes(forbiddenSecret)) {
      throw new PublishCliError('Publishing credentials must not appear in browser build files.');
    }
    if (isEntry && finalText && entry.value.length <= STREAM_MAX_HTML_BYTES) entry.value += finalText;
    const after = await handle.stat();
    if (!sameSnapshot(after, stat)) fail('Build file changed while it was being inspected.');
    if (chunkOffset > 0) chunkSha256.push(chunkHash.digest('hex'));
    return { sha256: hash.digest('hex'), bytes, entryText: entry.value, chunkSha256 };
  } catch (error) {
    if (error instanceof PublishCliError) throw error;
    throw new PublishCliError('Unable to read a regular browser build file.');
  } finally {
    await handle?.close();
  }
}

async function prepareBrowserBuild(directory: string, sourceCommit?: string, forbiddenSecret?: string): Promise<PreparedBuild> {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new PublishCliError('A prebuilt browser directory is required.');
  }
  const requestedRoot = resolve(directory);
  let rootStat: NodeStat;
  try {
    rootStat = await lstat(requestedRoot) as NodeStat;
  } catch {
    throw new PublishCliError('Unable to inspect the browser build directory.');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new PublishCliError('The browser build path must be an existing directory.');
  }
  let root: string;
  try {
    root = await realpath(requestedRoot) as string;
    const rootNow = await lstat(root) as NodeStat;
    if (!sameSnapshot(rootNow, rootStat)) fail('Build directory changed; stop the build watcher and try again.');
  } catch (error) {
    if (error instanceof PublishCliError) throw error;
    throw new PublishCliError('Unable to inspect the browser build directory.');
  }

  const files: PreparedBuildFile[] = [];
  let totalBytes = 0;
  let traversedEntries = 0;
  let entryText = '';

  async function visit(currentDirectory: string, depth: number): Promise<void> {
    if (depth > STREAM_MAX_DIRECTORY_DEPTH) {
      throw new PublishCliError(`Browser build directory nesting exceeds the ${formatLimit(STREAM_MAX_DIRECTORY_DEPTH)} level limit.`);
    }
    let directoryHandle: NodeDirectoryHandle | undefined;
    try {
      directoryHandle = await opendir(currentDirectory) as unknown as NodeDirectoryHandle;
      const entries: NodeDirent[] = [];
      for await (const entry of directoryHandle) {
        traversedEntries += 1;
        if (traversedEntries > STREAM_MAX_TRAVERSED_ENTRIES) {
          throw new PublishCliError(`Browser builds may contain at most ${formatLimit(STREAM_MAX_TRAVERSED_ENTRIES)} traversed entries.`);
        }
        entries.push(entry);
      }
      entries.sort((left, right) => compareCodePoints(left.name, right.name));
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
        if (!stat.isFile()) throw new PublishCliError('Browser builds may contain only regular files.');
        if (files.length >= STREAM_MAX_FILES) {
          throw new PublishCliError(`Browser builds may contain at most ${formatLimit(STREAM_MAX_FILES)} files.`);
        }
        let resolvedPath: string;
        try {
          resolvedPath = await realpath(absolutePath) as string;
        } catch {
          throw new PublishCliError('Unable to inspect the browser build file.');
        }
        if (resolvedPath !== absolutePath) throw new PublishCliError('Symlinked build paths are not accepted.');
        const relativePath = relative(root, absolutePath).split(sep).join('/');
        assertRelativePayloadPath(relativePath);
        validateBrowserAsset(relativePath);
        if (forbiddenSecret && relativePath.includes(forbiddenSecret)) {
          throw new PublishCliError('Publishing credentials must not appear in browser build paths.');
        }
        if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > STREAM_MAX_TOTAL_BYTES - totalBytes) {
          throw new PublishCliError(`The browser build exceeds the ${formatLimit(STREAM_MAX_TOTAL_BYTES)} byte decoded size limit.`);
        }
        const inspected = await inspectFile(
          absolutePath,
          stat,
          relativePath === 'index.html',
          extensionOf(relativePath) === 'html',
          forbiddenSecret,
        );
        totalBytes += inspected.bytes;
        if (totalBytes > STREAM_MAX_TOTAL_BYTES) {
          throw new PublishCliError(`The browser build exceeds the ${formatLimit(STREAM_MAX_TOTAL_BYTES)} byte decoded size limit.`);
        }
        const item: PreparedBuildFile = {
          path: relativePath,
          bytes: inspected.bytes,
          sha256: inspected.sha256,
          absolutePath,
          snapshot: snapshot(stat),
          chunkSha256: inspected.chunkSha256,
        };
        files.push(item);
        if (relativePath === 'index.html') entryText = inspected.entryText;
      }
    } catch (error) {
      if (error instanceof PublishCliError) throw error;
      throw new PublishCliError('Unable to inspect the browser build directory.');
    } finally {
      try {
        await directoryHandle?.close();
      } catch {
        // The directory is already closed after iteration.
      }
    }
  }

  await visit(root, 0);
  files.sort((left, right) => compareCodePoints(left.path, right.path));
  if (!files.some((file) => file.path === 'index.html')) {
    throw new PublishCliError('Browser builds must contain a root index.html entry file.');
  }
  if (!entryText || !/<(?:html|body|canvas|script|div|button)\b/i.test(entryText)) {
    throw new PublishCliError('The index.html entry must contain a browser page.');
  }
  const manifestFiles = files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const manifest: StreamingBuildManifest = {
    entry: 'index.html',
    files: manifestFiles,
    ...(sourceCommit === undefined ? {} : { sourceCommit: validateSourceCommit(sourceCommit) }),
  };
  return { ...manifest, bytes: totalBytes, root, rootSnapshot: snapshot(rootStat), preparedFiles: files };
}

export async function inspectBrowserBuild(directory: string, sourceCommit?: string): Promise<StreamingBuild> {
  const prepared = await prepareBrowserBuild(directory, sourceCommit);
  return {
    entry: prepared.entry,
    files: prepared.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    bytes: prepared.bytes,
    ...(prepared.sourceCommit === undefined ? {} : { sourceCommit: prepared.sourceCommit }),
  };
}

/**
 * Prepare a local build once for the development launcher. The returned
 * descriptors retain the canonical root and inspection snapshots so serving
 * can reopen and verify the same files without rebuilding paths from the
 * caller's input directory.
 */
export async function inspectBrowserBuildForLocal(
  directory: string,
  sourceCommit?: string,
): Promise<PreparedBuild> {
  return prepareBrowserBuild(directory, sourceCommit);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname.toLowerCase() === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Derive the only worker origin accepted when credentials omit an explicit one. */
export function deriveUploadOrigin(platformOrigin: string): string {
  const platform = new URL(platformOrigin);
  if (isLoopbackHost(platform.hostname)) {
    const hostname = platform.hostname === 'localhost' ? '127.0.0.1' : platform.hostname;
    const port = platform.port === '3003' ? '3401' : platform.port;
    const authority = hostname === '[::1]' ? `[${hostname.slice(1, -1)}]` : hostname;
    return `${platform.protocol}//${authority}${port ? `:${port}` : ''}`;
  }
  return `${platform.protocol}//uploads.${platform.hostname}`;
}

function trustedUploadOrigin(config: PublishConfig): string {
  const expected = config.uploadOrigin ?? deriveUploadOrigin(config.apiUrl);
  let normalized: URL;
  try {
    normalized = new URL(expected);
  } catch {
    throw new PublishCliError('The upload origin configuration is invalid.');
  }
  if (!['http:', 'https:'].includes(normalized.protocol) || normalized.username || normalized.password || normalized.pathname !== '/' || normalized.search || normalized.hash) {
    throw new PublishCliError('The upload origin configuration must be an origin.');
  }
  const platform = new URL(config.apiUrl);
  if (normalized.origin === platform.origin) {
    throw new PublishCliError('The upload origin must be a separate origin.');
  }
  if (normalized.protocol !== platform.protocol || (!isLoopbackHost(normalized.hostname) && normalized.protocol !== 'https:')) {
    throw new PublishCliError('The upload origin must use the platform transport security.');
  }
  if (isLoopbackHost(platform.hostname)) {
    if (!isLoopbackHost(normalized.hostname)) throw new PublishCliError('Local uploads must stay on a loopback origin.');
  } else if (normalized.port || normalized.hostname === platform.hostname) {
    throw new PublishCliError('The upload origin is not an allowed separate host.');
  }
  return normalized.origin;
}

function safeUploadId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new PublishCliError('Spawn returned an invalid upload identifier.');
  }
  return value;
}

function safeTicket(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PublishCliError('Spawn returned an invalid upload ticket.');
  }
  return value;
}

function safeExpiry(value: unknown): string | number {
  const parsed = typeof value === 'number'
    ? Number.isSafeInteger(value) ? value : NaN
    : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= Date.now()) {
    throw new PublishCliError('Spawn returned an invalid or expired upload session.');
  }
  return value as string | number;
}

function validateUploadSession(value: unknown, config: PublishConfig): UploadSession {
  if (!isRecord(value)) throw new PublishCliError('Spawn returned an invalid upload session.');
  const uploadOrigin = typeof value.uploadOrigin === 'string' ? value.uploadOrigin : '';
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(uploadOrigin);
  } catch {
    throw new PublishCliError('Spawn returned an invalid upload origin.');
  }
  if (
    !['http:', 'https:'].includes(parsedOrigin.protocol) ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    parsedOrigin.pathname !== '/' ||
    parsedOrigin.search ||
    parsedOrigin.hash
  ) {
    throw new PublishCliError('Spawn returned an invalid upload origin.');
  }
  const normalized = parsedOrigin.origin;
  if (normalized !== trustedUploadOrigin(config)) {
    throw new PublishCliError('Spawn returned an unexpected upload origin.');
  }
  const chunkBytes = value.chunkBytes;
  if (chunkBytes !== CHUNK_BYTES) {
    throw new PublishCliError('Spawn returned an unsupported upload chunk size.');
  }
  return {
    uploadId: safeUploadId(value.uploadId),
    uploadOrigin: normalized,
    token: safeTicket(value.token),
    chunkBytes,
    expiresAt: safeExpiry(value.expiresAt),
  };
}

function uploadPath(session: UploadSession, suffix: string): string {
  return `${session.uploadOrigin}/v1/uploads/${encodeURIComponent(session.uploadId)}${suffix}`;
}

function retryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /HTTP (?:408|425|429|5\d\d)|network|timed out|timeout|fetch|aborted|temporar/i.test(error.message);
}

async function retryJson(
  operation: () => Promise<UploadProgress>,
  options: StreamingPublishOptions,
): Promise<UploadProgress> {
  const attempts = Math.max(1, Math.min(options.retries ?? STREAM_MAX_RETRIES, STREAM_MAX_RETRIES));
  const delay = Math.max(0, Math.min(options.retryDelayMs ?? 100, 2_000));
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || !retryable(error)) throw error;
      await sleep(delay * (2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new PublishCliError('Spawn upload failed.');
}

function validateProgress(value: unknown, uploadId: string, totalBytes: number): UploadProgress {
  if (!isRecord(value)) throw new PublishCliError('Spawn returned an invalid upload progress response.');
  if (value.uploadId !== undefined && value.uploadId !== uploadId) {
    throw new PublishCliError('Spawn returned progress for a different upload.');
  }
  for (const key of ['bytes', 'receivedBytes', 'uploadedBytes']) {
    const bytes = value[key];
    if (bytes !== undefined && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > totalBytes)) {
      throw new PublishCliError('Spawn returned invalid upload progress.');
    }
  }
  return value;
}

function progressFile(value: UploadProgress, fileIndex: number): Record<string, unknown> | undefined {
  if (!Array.isArray(value.files)) return undefined;
  const item = value.files[fileIndex];
  return isRecord(item) ? item : undefined;
}

function receivedChunks(value: UploadProgress, fileIndex: number, fileBytes: number): Set<number> {
  const file = progressFile(value, fileIndex);
  if (!file) return new Set();
  const result = new Set<number>();
  if (file.complete === true || (typeof file.receivedBytes === 'number' && file.receivedBytes >= fileBytes)) {
    for (let index = 0, offset = 0; offset < fileBytes; index += 1, offset += CHUNK_BYTES) result.add(index);
  }
  for (const key of ['receivedChunks', 'uploadedChunks', 'completeChunks', 'chunks']) {
    const chunks = file[key];
    if (!Array.isArray(chunks)) continue;
    for (const item of chunks) {
      const index = typeof item === 'number'
        ? item
        : isRecord(item) && typeof item.index === 'number'
          ? item.index
          : isRecord(item) && typeof item.chunkIndex === 'number'
            ? item.chunkIndex
            : NaN;
      if (Number.isSafeInteger(index) && index >= 0 && index < Math.ceil(fileBytes / CHUNK_BYTES)) result.add(index);
    }
  }
  return result;
}

async function openForUpload(file: PreparedBuildFile): Promise<NodeFileHandle> {
  let resolved: string;
  try {
    resolved = await realpath(file.absolutePath) as string;
  } catch {
    throw new PublishCliError('Unable to reopen a browser build file.');
  }
  if (resolved !== file.absolutePath) throw new PublishCliError('Build file changed to a symlink.');
  let handle: NodeFileHandle | undefined;
  try {
    handle = await open(file.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) as unknown as NodeFileHandle;
    const current = await handle.stat();
    if (!current.isFile() || current.isSymbolicLink() || !sameSnapshot(current, file.snapshot)) {
      throw new PublishCliError('Build file changed after inspection.');
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof PublishCliError) throw error;
    throw new PublishCliError('Unable to reopen a browser build file.');
  }
}

/** Reopen a prepared local file and verify its retained root, metadata, and digest before serving it. */
export async function openValidatedBuildFile(
  build: PreparedBuild,
  file: PreparedBuildFile,
  cache?: { snapshot?: FileSnapshot; validation?: Promise<void> },
): Promise<NodeFileHandle> {
  let rootHandle: NodeFileHandle | undefined;
  try {
    rootHandle = await open(
      build.root,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_DIRECTORY ?? 0),
    ) as unknown as NodeFileHandle;
    const currentRoot = await rootHandle.stat();
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || !sameSnapshot(currentRoot, build.rootSnapshot)) {
      throw new PublishCliError('Build directory changed after inspection.');
    }
  } catch (error) {
    if (error instanceof PublishCliError) throw error;
    throw new PublishCliError('Unable to reopen the inspected browser build.');
  } finally {
    await rootHandle?.close().catch(() => undefined);
  }

  let handle: NodeFileHandle | undefined;
  try {
    handle = await open(
      file.absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    ) as unknown as NodeFileHandle;
    const current = await handle.stat();
    if (!current.isFile() || current.isSymbolicLink() || !sameSnapshot(current, file.snapshot)) {
      throw new PublishCliError('Build file changed after inspection.');
    }
    const cachedSnapshot = cache?.snapshot;
    if (cachedSnapshot && sameSnapshot(current, cachedSnapshot)) return handle;
    let validation = cache?.validation;
    if (!validation) {
      validation = (async () => {
        const hash = hashFactory()('sha256');
        const buffer = new Uint8Array(Math.min(1_048_576, file.bytes));
        let bytes = 0;
        while (bytes < file.bytes) {
          const want = Math.min(buffer.byteLength, file.bytes - bytes);
          const { bytesRead } = await handle!.read(buffer, 0, want, bytes);
          if (bytesRead <= 0) throw new PublishCliError('Build file ended while it was being served.');
          hash.update(buffer.subarray(0, bytesRead));
          bytes += bytesRead;
        }
        const after = await handle!.stat();
        if (!sameSnapshot(after, file.snapshot) || bytes !== file.bytes || hash.digest('hex') !== file.sha256) {
          throw new PublishCliError('Build file changed after inspection.');
        }
        if (cache) cache.snapshot = snapshot(after);
      })();
      if (cache) cache.validation = validation;
    }
    try {
      await validation;
    } catch (error) {
      if (cache?.validation === validation) {
        cache.validation = undefined;
        cache.snapshot = undefined;
      }
      throw error;
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof PublishCliError) throw error;
    throw new PublishCliError('Unable to reopen the inspected browser build file.');
  }
}

async function uploadFile(
  session: UploadSession,
  file: PreparedBuildFile,
  fileIndex: number,
  prior: UploadProgress,
  totalBytes: number,
  workerConfig: PublishConfig,
  fetchImplementation: FetchLike,
  options: StreamingPublishOptions,
): Promise<UploadProgress> {
  const handle = await openForUpload(file);
  const skipped = receivedChunks(prior, fileIndex, file.bytes);
  const buffer = new Uint8Array(session.chunkBytes);
  let offset = 0;
  let chunkIndex = 0;
  let progress = prior;
  try {
    while (offset < file.bytes) {
      const length = Math.min(session.chunkBytes, file.bytes - offset);
      let read = 0;
      while (read < length) {
        const result = await handle.read(buffer, read, length - read, offset + read);
        if (result.bytesRead <= 0) throw new PublishCliError('Build file ended while it was being uploaded.');
        read += result.bytesRead;
      }
      const actualChunkSha256 = hashFactory()('sha256').update(buffer.subarray(0, length)).digest('hex');
      if (actualChunkSha256 !== file.chunkSha256[chunkIndex]) {
        throw new PublishCliError('Build file changed while it was being uploaded.');
      }
      if (!skipped.has(chunkIndex)) {
        const payload = buffer.subarray(0, length);
        const next = await retryJson(
          async () => validateProgress(
            await requestJson(
              workerConfig,
              uploadPath(session, `/files/${fileIndex}/chunks/${chunkIndex}`),
              {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${session.token}`,
                  'Content-Type': 'application/octet-stream',
                  'Content-Length': String(length),
                },
                body: payload as unknown as BodyInit,
              },
              fetchImplementation,
            ),
            session.uploadId,
            totalBytes,
          ),
          options,
        );
        progress = next;
        options.onProgress?.(progress);
      }
      offset += length;
      chunkIndex += 1;
    }
    const after = await handle.stat();
    if (!sameSnapshot(after, file.snapshot)) throw new PublishCliError('Build file changed while it was uploaded.');
    return progress;
  } finally {
    await handle.close();
  }
}

export async function publishBrowserDirectory(
  config: PublishConfig,
  directory: string,
  sourceCommit?: string,
  fetchImplementation: FetchLike = globalThis.fetch,
  options: StreamingPublishOptions = {},
): Promise<Record<string, unknown>> {
  const validatedConfig = validatePublishConfig(config);
  const prepared = await prepareBrowserBuild(directory, sourceCommit ?? options.sourceCommit, validatedConfig.publishKey);
  const manifest: StreamingBuildManifest = {
    entry: prepared.entry,
    files: prepared.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    ...(prepared.sourceCommit === undefined ? {} : { sourceCommit: prepared.sourceCommit }),
  };
  const coreBase = validatedConfig.apiUrl.replace(/\/+$/, '');
  const coreUploadUrl = `${coreBase}/api/v1/publish/${encodeURIComponent(validatedConfig.projectId)}/uploads`;
  const sessionResponse = await requestJson(
    validatedConfig,
    coreUploadUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validatedConfig.publishKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(manifest),
    },
    fetchImplementation,
  );
  const session = validateUploadSession(sessionResponse, validatedConfig);
  const workerConfig: PublishConfig = {
    ...validatedConfig,
    apiUrl: session.uploadOrigin,
    publishKey: session.token,
  };
  let progress = await retryJson(
    async () => validateProgress(
      await requestJson(
        workerConfig,
        uploadPath(session, ''),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(manifest),
        },
        fetchImplementation,
      ),
      session.uploadId,
      prepared.bytes,
    ),
    options,
  );
  options.onProgress?.(progress);
  for (const [fileIndex, file] of prepared.preparedFiles.entries()) {
    progress = await uploadFile(session, file, fileIndex, progress, prepared.bytes, workerConfig, fetchImplementation, options);
  }
  const sealed = await retryJson(
    async () => validateProgress(
      await requestJson(
        workerConfig,
        uploadPath(session, '/seal'),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.token}` },
        },
        fetchImplementation,
      ),
      session.uploadId,
      prepared.bytes,
    ),
    options,
  );
  if (sealed.sealed !== true) {
    throw new PublishCliError('Spawn did not seal the browser build.');
  }
  options.onProgress?.(sealed);
  return requestJson(
    validatedConfig,
    `${coreBase}/api/v1/publish/${encodeURIComponent(validatedConfig.projectId)}/uploads/${encodeURIComponent(session.uploadId)}/complete`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${validatedConfig.publishKey}` },
    },
    fetchImplementation,
  );
}

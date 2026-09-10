// @ts-ignore Node built-ins are supplied by the local CLI runtime.
import { open, lstat } from 'node:fs/promises';
// @ts-ignore Node built-ins are supplied by the local CLI runtime.
import { constants } from 'node:fs';
import { PublishCliError } from './api.ts';
function fail(message: string): never { throw new PublishCliError(message); }

// Read from one regular-file descriptor, bounded even if the file grows during the read.
export async function readBoundedFile(path: string, limit: number, expected?: { ino: number; dev: number }): Promise<Uint8Array> {
  let handle;
  try {
    const before = await lstat(path);
    if (expected && (before.ino !== expected.ino || before.dev !== expected.dev)) fail('Input changed while the build was being read. Stop the build watcher and try again.');
    if (before.isSymbolicLink() || !before.isFile()) fail('Input must be a regular file; symlinks are not accepted.');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > limit) fail(`Input must be a regular file no larger than ${limit} bytes.`);
    const bytes = new Uint8Array(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > limit) fail(`Input exceeds ${limit} bytes.`);
    return bytes.slice(0, count);
  } catch (error) {
    if (error instanceof PublishCliError) throw error;
    return fail('Unable to read a regular input file; symlinks are not accepted.');
  } finally { await handle?.close(); }
}


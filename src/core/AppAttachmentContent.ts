import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { isSha256Hex, MAX_FILE_BYTES } from './appMediaTypes.js';

const READ_BYTES = 256 * 1024;

function sameFile(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.isFile();
}

export interface VerifiedAppAttachmentDescriptor {
  handle: FileHandle;
  isCurrent(): Promise<boolean>;
}

/** Verify local immutable bytes. A returned descriptor belongs to the caller. */
export async function openVerifiedAppAttachment(
  filename: string,
  privateRoot: string,
  sha256: string,
  size: number,
  signal: AbortSignal,
): Promise<VerifiedAppAttachmentDescriptor | null> {
  if (!isSha256Hex(sha256) || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) return null;
  signal.throwIfAborted();
  const root = await fs.promises.realpath(privateRoot);
  signal.throwIfAborted();
  const expectedRelative = path.relative(privateRoot, filename);
  const resolved = await fs.promises.realpath(filename);
  signal.throwIfAborted();
  if (resolved !== path.join(root, expectedRelative) || ![
    path.join('blobs', sha256.slice(0, 2), sha256),
    path.join('deleted', sha256.slice(0, 2), sha256),
  ].includes(expectedRelative)) return null;

  const listed = await fs.promises.lstat(resolved, { bigint: true });
  signal.throwIfAborted();
  if (!listed.isFile() || listed.size !== BigInt(size)) return null;
  const handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  let transfer = false;
  try {
    signal.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    signal.throwIfAborted();
    if (!sameFile(listed, before)) return null;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(size, READ_BYTES));
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      signal.throwIfAborted();
      if (bytesRead === 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    signal.throwIfAborted();
    if (!sameFile(before, after) || hash.digest('hex') !== sha256) return null;
    transfer = true;
    return {
      handle,
      isCurrent: async () => sameFile(after, await handle.stat({ bigint: true })),
    };
  } finally {
    if (!transfer) await handle.close();
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVerifiedAppAttachment } from '../../src/core/AppAttachmentContent.js';
import { MAX_FILE_BYTES } from '../../src/core/appMediaTypes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    SafeFsExecutor.safeRmSync(root, { force: true, recursive: true, operation: 'tests/unit/app-attachment-content.test.ts' });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-app-attachment-'));
  roots.push(root);
  const bytes = Buffer.from('verified local data');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const file = path.join(root, 'blobs', sha.slice(0, 2), sha);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { root, bytes, sha, file };
}

describe('openVerifiedAppAttachment', () => {
  it('returns the same verified descriptor and detects same-sized in-place changes', async () => {
    const { root, bytes, sha, file } = fixture();
    const verified = await openVerifiedAppAttachment(file, root, sha, bytes.length, new AbortController().signal);
    if (!verified) throw new Error('test descriptor could not be verified');
    try {
      const output = Buffer.alloc(bytes.length);
      await verified.handle.read(output, 0, output.length, 0);
      expect(output).toEqual(bytes);
      expect(await verified.isCurrent()).toBe(true);
      fs.writeFileSync(file, Buffer.alloc(bytes.length, 'X'));
      expect(await verified.isCurrent()).toBe(false);
    } finally {
      await verified.handle.close();
    }
  });

  it('rejects out-of-policy size, incorrect hash and links outside the immutable location', async () => {
    const { root, bytes, sha, file } = fixture();
    const signal = new AbortController().signal;
    expect(await openVerifiedAppAttachment(file, root, sha, MAX_FILE_BYTES + 1, signal)).toBeNull();
    fs.writeFileSync(file, Buffer.alloc(bytes.length, 'X'));
    expect(await openVerifiedAppAttachment(file, root, sha, bytes.length, signal)).toBeNull();
    const displaced = path.join(root, 'outside-blob-tree');
    fs.renameSync(file, displaced);
    fs.writeFileSync(displaced, bytes);
    fs.symlinkSync(displaced, file);
    expect(await openVerifiedAppAttachment(file, root, sha, bytes.length, signal)).toBeNull();
  });

  it('holds an aborted open through its single late descriptor close', async () => {
    const { root, bytes, sha, file } = fixture();
    const controller = new AbortController();
    const original = fs.promises.open.bind(fs.promises);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    let closes = 0;
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      entered();
      await wait;
      const opened = await original(...args);
      const close = opened.close.bind(opened);
      vi.spyOn(opened, 'close').mockImplementation(async () => { await close(); closes++; });
      return opened;
    });
    const opening = openVerifiedAppAttachment(file, root, sha, bytes.length, controller.signal);
    await started;
    controller.abort();
    expect(closes).toBe(0);
    release();
    await expect(opening).rejects.toHaveProperty('name', 'AbortError');
    expect(closes).toBe(1);
  });
});

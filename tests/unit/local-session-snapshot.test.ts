import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CLAUDE_CODE_FRAMEWORK } from '../../src/core/frameworkFacts.js';
import {
  snapshotLocalSession, verifyLocalSessionSnapshot, streamLocalSessionBytes, localSessionByteChunks, LocalSessionSnapshotRefused, MAX_LOCAL_SESSION_BYTES,
  type LocalSessionSelection, type LocalSessionSnapshotReceipt,
} from '../../src/import/localSessionSnapshot.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'local-session-snapshot synthetic fixture cleanup' }); });
const stamp = '2026-01-02T03:04:05.000Z';
function fixture(text = 'hello', extra: object[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-session-snapshot-')); directories.push(dir);
  const filePath = path.join(dir, 'session.jsonl');
  const rows = [
    { type: 'session_meta', timestamp: stamp, payload: { id: 'session-1', cwd: '/projects/garden' } },
    ...extra,
    { type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text }] } },
  ];
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  const selection: LocalSessionSelection = { filePath, source: 'codex', expectedSessionId: 'session-1', expectedProjectPath: '/projects/garden' };
  return { dir, filePath, selection, bytes };
}
const admitted = { authorized: () => true };
async function reason(promise: Promise<unknown>, expected: string) {
  await expect(promise).rejects.toMatchObject({ name: 'Error', reason: expected });
}

describe('explicit local session snapshot', () => {
  it('rechecks live authority after producer enqueue before yielding queued bytes', async () => {
    const f = fixture('synthetic queued text');
    let readCompleted = false; let armRevocation = false; let scheduled = false; let authorized = true;
    const open = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (open as any)(...args);
      const read = handle.read.bind(handle); const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...args: any[]) => {
        const result = await read(...args); if (result.bytesRead > 0) readCompleted = true; return result;
      });
      vi.spyOn(handle, 'stat').mockImplementation(async (...args: any[]) => {
        const result = await stat(...args); if (readCompleted) armRevocation = true; return result;
      });
      return handle;
    });
    const iterator = localSessionByteChunks(f.selection, { authorized: () => {
      // Revoke in the real read/stat -> producer enqueue -> consumer microtask gap.
      if (armRevocation && !scheduled) { scheduled = true; queueMicrotask(() => { authorized = false; }); }
      return authorized;
    } }, new AbortController().signal);
    try { await reason(iterator.next(), 'not-authorized'); expect(scheduled).toBe(true); }
    finally { await iterator.return(undefined); spy.mockRestore(); }
  });

  it('streams bounded borrowed UTF-8 blocks under real descriptor checks and clears them after completion', async () => {
    const f = fixture('日'.repeat(80_000)); const blocks: Buffer[] = []; let borrowed: Buffer | undefined;
    const receipt = await streamLocalSessionBytes(f.selection, admitted, async bytes => {
      borrowed = bytes; expect(bytes.length).toBeLessThanOrEqual(64 * 1024);
      await Promise.resolve(); blocks.push(Buffer.from(bytes));
    });
    expect(Buffer.concat(blocks)).toEqual(f.bytes);
    expect(receipt.sha256).toBe(crypto.createHash('sha256').update(f.bytes).digest('hex'));
    expect(borrowed!.every(byte => byte === 0)).toBe(true);
  });
  it('rechecks authorization after an asynchronous byte consumer and refuses changed files', async () => {
    const f = fixture('x'.repeat(140_000)); let authorized = true; let calls = 0;
    await reason(streamLocalSessionBytes(f.selection, { authorized: () => authorized }, async () => {
      calls++; await Promise.resolve(); authorized = false;
    }), 'not-authorized');
    expect(calls).toBe(1);
    await reason(streamLocalSessionBytes(f.selection, admitted, async () => { fs.appendFileSync(f.filePath, 'changed'); }), 'source-changed');
  });
  it('refuses invalid UTF-8 before delivering it and hides consumer diagnostics', async () => {
    const f = fixture(); fs.writeFileSync(f.filePath, Buffer.from([0xff])); let delivered = false;
    await reason(streamLocalSessionBytes(f.selection, admitted, async () => { delivered = true; }), 'invalid-utf8');
    expect(delivered).toBe(false);
    fs.writeFileSync(f.filePath, f.bytes);
    const error = await streamLocalSessionBytes(f.selection, admitted, async () => { throw new Error('/private/synthetic/path'); }).catch(error => error);
    expect(error.reason).toBe('read-failed'); expect(String(error)).not.toContain('/private');
  });
  it('bridges one borrowed block at a time and aborts a producer without needing another read', async () => {
    const f = fixture('x'.repeat(140_000)); const abort = new AbortController();
    const iterator = localSessionByteChunks(f.selection, admitted, abort.signal);
    const first = await iterator.next(); expect(first.done).toBe(false);
    const saved = Buffer.from(first.value!); expect(saved).toEqual(f.bytes.subarray(0, saved.length));
    abort.abort();
    try {
      await vi.waitFor(() => expect(first.value!.every(byte => byte === 0)).toBe(true), { timeout: 5000, interval: 10 });
    } finally { await iterator.return(undefined); }
    const complete: Buffer[] = [];
    for await (const bytes of localSessionByteChunks(f.selection, admitted, new AbortController().signal)) complete.push(Buffer.from(bytes));
    expect(Buffer.concat(complete)).toEqual(f.bytes);
  });

  it('returns a scrubbed proposal and JSON-serializable immutable receipt without source or state writes', async () => {
    const f = fixture('hello');
    const before = fs.statSync(f.filePath);
    const snapshot = await snapshotLocalSession(f.selection, admitted);
    expect(snapshot.proposal.conversation.messages).toMatchObject([{ text: 'hello' }]);
    expect(snapshot.receipt).toMatchObject({ version: 1, source: 'codex', representation: 'canonical', bytes: f.bytes.length, sha256: crypto.createHash('sha256').update(f.bytes).digest('hex') });
    expect(JSON.stringify(snapshot.receipt)).not.toContain(f.filePath);
    expect(JSON.parse(JSON.stringify(snapshot.receipt))).toEqual(snapshot.receipt);
    expect(fs.readdirSync(f.dir)).toEqual(['session.jsonl']);
    expect(fs.readFileSync(f.filePath)).toEqual(f.bytes);
    expect(fs.statSync(f.filePath).mtimeMs).toBe(before.mtimeMs);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => { snapshot.proposal = { ...snapshot.proposal }; }).toThrow(TypeError);
    expect(() => { snapshot.receipt = { ...snapshot.receipt }; }).toThrow(TypeError);
    expect(Object.isFrozen(snapshot.receipt)).toBe(true);
    expect(Object.isFrozen(snapshot.receipt.fileIdentity)).toBe(true);
    expect(Object.isFrozen(snapshot.proposal.conversation.messages[0])).toBe(true);
    await expect(verifyLocalSessionSnapshot(f.selection, snapshot.receipt, admitted)).resolves.toBeUndefined();
  });

  it('decodes multi-byte UTF-8 across descriptor chunk boundaries and an unterminated final line', async () => {
    const text = 'a'.repeat(65_150) + '日本語🙂'.repeat(300);
    const f = fixture(text);
    fs.writeFileSync(f.filePath, f.bytes.subarray(0, -1));
    const snapshot = await snapshotLocalSession(f.selection, admitted);
    expect(snapshot.proposal.conversation.messages.map(m => m.text).join('')).toBe(text);
  });

  it('accepts the other supported local transcript source with expected identity', async () => {
    const f = fixture();
    fs.writeFileSync(f.filePath, JSON.stringify({ type: 'user', sessionId: 'session-1', cwd: '/projects/garden', uuid: 'u1', timestamp: stamp, message: { role: 'user', content: 'hello' } }));
    const result = await snapshotLocalSession({ ...f.selection, source: CLAUDE_CODE_FRAMEWORK, expectedRepresentation: 'claude-records' }, admitted);
    expect(result.proposal.representation).toBe('claude-records');
    expect(result.proposal.conversation.messages[0]?.text).toBe('hello');
  });

  it.each([false, undefined, {}, Promise.resolve(true)])('requires literal true current authorization before any file read', async value => {
    const f = fixture();
    await reason(snapshotLocalSession(f.selection, { authorized: (() => value) as () => boolean }), 'not-authorized');
  });

  it('converts authorization exceptions to finite errors without leaking private details', async () => {
    const f = fixture();
    const promise = snapshotLocalSession(f.selection, { authorized: () => { throw new Error('PRIVATE CREDENTIAL'); } });
    await reason(promise, 'not-authorized');
    await expect(promise).rejects.not.toThrow('PRIVATE');
  });

  it('checks authority during descriptor chunks and refuses revocation before returning data', async () => {
    const f = fixture('a'.repeat(200_000));
    let checks = 0;
    await reason(snapshotLocalSession(f.selection, { authorized: () => ++checks < 12 }), 'not-authorized');
    expect(checks).toBe(12);
  });

  it('checks authority again during verification', async () => {
    const f = fixture();
    const snapshot = await snapshotLocalSession(f.selection, admitted);
    await reason(verifyLocalSessionSnapshot(f.selection, snapshot.receipt, { authorized: () => false }), 'not-authorized');
  });

  it('owns and freezes the selection before the callback can mutate the caller object', async () => {
    const f = fixture();
    const originalPath = f.filePath;
    let seen: Readonly<LocalSessionSelection> | undefined;
    const snapshot = await snapshotLocalSession(f.selection, { authorized: selection => {
      seen = selection;
      f.selection.filePath = path.join(f.dir, 'not-selected');
      f.selection.expectedSessionId = 'different';
      return true;
    } });
    expect(Object.isFrozen(seen)).toBe(true);
    expect(seen?.filePath).toBe(originalPath);
    expect(snapshot.proposal.conversation.originalId).toBe('session-1');
  });

  it('enforces both the existing importer ceiling and a caller-requested lower byte budget', async () => {
    const f = fixture();
    await reason(snapshotLocalSession(f.selection, { ...admitted, maxBytes: f.bytes.length - 1 }), 'too-large');
    await reason(snapshotLocalSession(f.selection, { ...admitted, maxBytes: MAX_LOCAL_SESSION_BYTES + 1 }), 'invalid-budget');
    fs.truncateSync(f.filePath, MAX_LOCAL_SESSION_BYTES + 1);
    await reason(snapshotLocalSession(f.selection, admitted), 'too-large');
  });

  it('rejects invalid selections and turns raw filesystem errors into finite refusals', async () => {
    const f = fixture();
    await reason(snapshotLocalSession({ ...f.selection, filePath: 'relative.jsonl' }, admitted), 'invalid-selection');
    const promise = snapshotLocalSession({ ...f.selection, filePath: path.join(f.dir, 'PRIVATE missing') }, admitted);
    await reason(promise, 'read-failed');
    await expect(promise).rejects.not.toThrow('PRIVATE');
    await expect(promise).rejects.toBeInstanceOf(LocalSessionSnapshotRefused);
  });

  it('rejects final-component symlinks and nonregular sources without opening a pipe', async () => {
    const f = fixture();
    const link = path.join(f.dir, 'link.jsonl');
    fs.symlinkSync(f.filePath, link);
    await reason(snapshotLocalSession({ ...f.selection, filePath: link }, admitted), 'not-regular');
    await reason(snapshotLocalSession({ ...f.selection, filePath: f.dir }, admitted), 'not-regular');
    if (process.platform !== 'win32') {
      const fifo = path.join(f.dir, 'pipe.jsonl');
      execFileSync('mkfifo', [fifo]);
      await reason(snapshotLocalSession({ ...f.selection, filePath: fifo }, admitted), 'not-regular');
    }
  });

  it('refuses a symlink substituted between lstat and descriptor open', async () => {
    const f = fixture();
    let checks = 0;
    await reason(snapshotLocalSession(f.selection, { authorized: () => {
      if (++checks === 4) {
        const old = path.join(f.dir, 'old.jsonl');
        fs.renameSync(f.filePath, old);
        fs.symlinkSync(old, f.filePath);
      }
      return true;
    } }), 'source-changed');
  });

  it('refuses mutation and substitution during read even when authorization remains current', async () => {
    for (const substitute of [false, true]) {
      const f = fixture('a'.repeat(200_000));
      let checks = 0;
      await reason(snapshotLocalSession(f.selection, { authorized: () => {
        checks++;
        if (checks === 11) {
          if (substitute) {
            fs.renameSync(f.filePath, path.join(f.dir, 'old.jsonl'));
            fs.writeFileSync(f.filePath, f.bytes);
          } else fs.appendFileSync(f.filePath, '\n');
        }
        return true;
      } }), 'source-changed');
    }
  });

  it('rejects invalid UTF-8 and parser identity mismatches with finite reasons', async () => {
    const f = fixture();
    fs.writeFileSync(f.filePath, Buffer.from([0xff]));
    await reason(snapshotLocalSession(f.selection, admitted), 'invalid-utf8');
    fs.writeFileSync(f.filePath, f.bytes);
    await reason(snapshotLocalSession({ ...f.selection, expectedSessionId: 'different' }, admitted), 'parser-refused');
  });

  it('checks the byte digest even when size, timestamp and current file identity are supplied', async () => {
    const f = fixture('hello');
    const snapshot = await snapshotLocalSession(f.selection, admitted);
    const previous = fs.statSync(f.filePath);
    const changed = Buffer.from(f.bytes.toString().replace('hello', 'jello'));
    expect(changed.length).toBe(f.bytes.length);
    fs.writeFileSync(f.filePath, changed);
    fs.utimesSync(f.filePath, previous.atime, previous.mtime);
    // Give the verifier current metadata to isolate the digest check itself.
    const stat = fs.statSync(f.filePath, { bigint: true });
    const copied: LocalSessionSnapshotReceipt = { ...snapshot.receipt, fileIdentity: { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString() } };
    await reason(verifyLocalSessionSnapshot(f.selection, copied, admitted), 'source-changed');
  });

  it('owns the expected receipt before authorization callbacks can mutate its digest', async () => {
    const f = fixture();
    const snapshot = await snapshotLocalSession(f.selection, admitted);
    const mutable = JSON.parse(JSON.stringify(snapshot.receipt)) as LocalSessionSnapshotReceipt;
    await expect(verifyLocalSessionSnapshot(f.selection, mutable, { authorized: () => {
      mutable.sha256 = '0'.repeat(64);
      mutable.fileIdentity.ino = '0';
      return true;
    } })).resolves.toBeUndefined();
  });

  it('binds receipt verification to the same source, session, project and selected path', async () => {
    const f = fixture();
    const snapshot = await snapshotLocalSession(f.selection, admitted);
    await reason(verifyLocalSessionSnapshot({ ...f.selection, expectedProjectPath: '/projects/other' }, snapshot.receipt, admitted), 'receipt-mismatch');
    await reason(verifyLocalSessionSnapshot(f.selection, {} as LocalSessionSnapshotReceipt, admitted), 'invalid-receipt');
  });
});

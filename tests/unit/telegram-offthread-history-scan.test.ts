/**
 * The conversation list's off-main-thread history scan (fb-52447f16-7d3,
 * docs/specs/conversation-list-offthread-scan.md). warmTopicTails must fill the existing tail cache
 * with exactly the rows the old synchronous read (getTopicHistory on a fresh adapter) caches, without
 * a synchronous read of the log; share one scan among concurrent callers; and save NOTHING when the
 * read fails, the file is replaced, or the file is rewritten (even at the same length) during the
 * scan, so the unchanged old read answers instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/telegram-offthread-history-scan.test.ts';
const TOPICS = [1001, 1002, 1003, 1004, 1005];
const BIG = 1001; // more than the 500-row cache window
const at = (i: number) => new Date(1_700_000_000_000 + i * 1000).toISOString();
const make = (d: string) => new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, d);
type Inner = { topicTailCache: Map<number, unknown[]>; tailWarmScans: number };
const inner = (a: TelegramAdapter) => a as unknown as Inner;

describe('off-main-thread history scan for the conversation list', () => {
  let dir: string; let logPath: string; let adapter: TelegramAdapter; const extra: TelegramAdapter[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-offturn-'));
    logPath = path.join(dir, 'telegram-messages.jsonl');
    const lines: string[] = []; let id = 1;
    // ~5 blocks of 64 KiB, multi-byte text so characters straddle block edges.
    for (let round = 0; round < 600; round++) for (const t of TOPICS) {
      if (t !== BIG && round > 120) continue;
      lines.push(JSON.stringify({ messageId: id, topicId: t, text: `r${round} t${t} 🙂 émoji ✓ ${'x'.repeat(200 + (round % 37))}`, fromUser: round % 2 === 0, timestamp: at(id), sessionName: null })); id++;
      if (round % 50 === 7) lines.push('{not json');
      if (round % 60 === 3) lines.push(JSON.stringify({ messageId: id++, channelId: t, text: 'shared logger row', fromUser: false, timestamp: at(id), sessionName: null }));
      if (round % 70 === 5) lines.push(JSON.stringify({ messageId: id++, channelId: String(t), text: 'string channel id: never this topic', fromUser: false, timestamp: at(id), sessionName: null }));
    }
    // The last line has no newline: the old read parses it, so must this.
    fs.writeFileSync(logPath, lines.join('\n') + '\n' + JSON.stringify({ messageId: id, topicId: 1002, text: 'unterminated last', fromUser: true, timestamp: at(id), sessionName: null }));
    expect(fs.statSync(logPath).size).toBeGreaterThan(4 * 64 * 1024);
    adapter = make(dir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await adapter.stop();
    for (const a of extra.splice(0)) await a.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  /** What the old synchronous read caches for a topic, on a fresh adapter reading the file as it is now. */
  const oldRead = (topicId: number, limit = 500) => { const fresh = make(dir); extra.push(fresh); return fresh.getTopicHistory(topicId, limit); };
  const all = [...TOPICS, 424242];

  /** Run `hook` just before the Nth read of the log through a FileHandle (1-based). */
  const onRead = (n: number, hook: () => void | Promise<void>) => {
    const realOpen = fs.promises.open.bind(fs.promises);
    return vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const fh = await realOpen(...args);
      const realRead = fh.read.bind(fh) as (...a: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>;
      let count = 0;
      (fh as unknown as { read: (...a: unknown[]) => Promise<unknown> }).read = async (...a: unknown[]) => {
        count++;
        if (count === n) await hook();
        return realRead(...a);
      };
      return fh;
    });
  };
  const blocksIn = () => Math.ceil(fs.statSync(logPath).size / (64 * 1024));

  it('fills the cache with exactly the rows the old read gives, without a synchronous read of the log', async () => {
    const expected = all.map((t) => oldRead(t));
    const expectedShort = all.map((t) => oldRead(t, 3));
    expect(expected[0].length).toBe(500); // the big topic is cut to the cache window, newest kept
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(await adapter.warmTopicTails(all)).toBe(true);
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(0);
    all.forEach((t, i) => expect(adapter.getTopicHistory(t, 500)).toEqual(expected[i]));
    all.forEach((t, i) => expect(adapter.getTopicHistory(t, 3)).toEqual(expectedShort[i]));
    expect(adapter.getTopicHistory(1002, 1)[0]).toMatchObject({ text: 'unterminated last' });
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(0);
  });

  it('concurrent callers share one scan', async () => {
    const opens = vi.spyOn(fs.promises, 'open');
    const results = await Promise.all([adapter.warmTopicTails(all), adapter.warmTopicTails(all), adapter.warmTopicTails(TOPICS.slice(0, 2))]);
    expect(results).toEqual([true, true, true]);
    expect(inner(adapter).tailWarmScans).toBe(1);
    expect(opens.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(1);
    // Already cached: no further scan.
    expect(await adapter.warmTopicTails(all)).toBe(true);
    expect(inner(adapter).tailWarmScans).toBe(1);
  });

  it('a topic listed while a scan runs gets one more scan, not a synchronous read', async () => {
    const first = adapter.warmTopicTails([1001]);
    const second = adapter.warmTopicTails([1001, 1003]);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(inner(adapter).tailWarmScans).toBe(2);
    expect(adapter.getTopicHistory(1003, 500)).toEqual(oldRead(1003));
  });

  it('a read error mid-scan saves nothing; the old read then answers', async () => {
    onRead(2, () => { throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await adapter.warmTopicTails(all)).toBe(false);
    expect(inner(adapter).topicTailCache.size).toBe(0);
    vi.restoreAllMocks();
    expect(adapter.getTopicHistory(1003, 500)).toEqual(oldRead(1003));
  });

  it('a file replaced mid-scan (a rotation renames a new file into place) saves nothing', async () => {
    onRead(2, () => {
      const tmp = `${logPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ messageId: 1, topicId: 1001, text: 'after rotation', fromUser: true, timestamp: at(1), sessionName: null }) + '\n');
      fs.renameSync(tmp, logPath);
    });
    expect(await adapter.warmTopicTails(all)).toBe(false);
    expect(inner(adapter).topicTailCache.size).toBe(0);
    vi.restoreAllMocks();
    expect(adapter.getTopicHistory(1001, 500).map((r) => r.text)).toEqual(['after rotation']);
  });

  it('a same-size file renamed into place mid-scan saves nothing (the identity check, not the size)', async () => {
    const original = fs.readFileSync(logPath, 'utf8');
    const lastRow = adapter.getTopicHistory(1002, 1)[0]; // read before the mocks; fills only 1002
    inner(adapter).topicTailCache.clear();
    const replacement = original.replace('unterminated last', 'unterminated LAST');
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    onRead(2, () => { fs.writeFileSync(`${logPath}.tmp`, replacement); fs.renameSync(`${logPath}.tmp`, logPath); });
    expect(await adapter.warmTopicTails(all)).toBe(false);
    expect(inner(adapter).topicTailCache.size).toBe(0);
    vi.restoreAllMocks();
    expect(lastRow).toMatchObject({ text: 'unterminated last' });
    expect(adapter.getTopicHistory(1002, 1)[0]).toMatchObject({ text: 'unterminated LAST' });
  });

  /** Rewrite the first line in place with a same-length line that names a different message. */
  const rewriteFirstLineSameLength = () => {
    const fd = fs.openSync(logPath, 'r+');
    try {
      const head = Buffer.alloc(256); fs.readSync(fd, head, 0, 256, 0);
      const line = head.toString('utf8').split('\n')[0];
      const changed = line.replace('"r0 t1001', '"R0 t1001');
      expect(changed).not.toBe(line);
      expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(line));
      fs.writeSync(fd, changed, 0, 'utf8');
    } finally { fs.closeSync(fd); }
  };

  it('a same-length rewrite of bytes already read saves nothing', async () => {
    const sizeBefore = fs.statSync(logPath).size;
    onRead(3, rewriteFirstLineSameLength);
    expect(await adapter.warmTopicTails(all)).toBe(false);
    expect(fs.statSync(logPath).size).toBe(sizeBefore);
    expect(inner(adapter).topicTailCache.size).toBe(0);
    vi.restoreAllMocks();
    expect(adapter.getTopicHistory(1001, 500)).toEqual(oldRead(1001));
  });

  it('a same-length rewrite during the final check (after its bytes were re-read) saves nothing', async () => {
    const n = blocksIn();
    // Reads: n data blocks + 1 empty read at the end, then n re-reads; hook before the LAST re-read,
    // when block 0 has already been re-read and matched, so only the change-time check can catch it.
    onRead(n + 1 + n, rewriteFirstLineSameLength);
    expect(await adapter.warmTopicTails(all)).toBe(false);
    expect(inner(adapter).topicTailCache.size).toBe(0);
  });

  it('an append during the scan is included, exactly as the old read would include it', async () => {
    onRead(2, () => { fs.appendFileSync(logPath, '\n' + JSON.stringify({ messageId: 999_999, topicId: 1004, text: 'appended mid-scan', fromUser: true, timestamp: at(999_999), sessionName: null }) + '\n'); });
    expect(await adapter.warmTopicTails(all)).toBe(true);
    vi.restoreAllMocks();
    expect(adapter.getTopicHistory(1004, 1)[0]).toMatchObject({ text: 'appended mid-scan' });
    all.forEach((t) => expect(adapter.getTopicHistory(t, 500)).toEqual(oldRead(t)));
  });

  it('a topic the synchronous code cached during the scan is not overwritten', async () => {
    let cachedBySync: unknown[] | undefined;
    onRead(2, () => { adapter.getTopicHistory(1005, 5); cachedBySync = inner(adapter).topicTailCache.get(1005); });
    expect(await adapter.warmTopicTails(all)).toBe(true);
    expect(cachedBySync).toBeDefined();
    expect(inner(adapter).topicTailCache.get(1005)).toBe(cachedBySync);
  });

  it('no log file: every topic caches empty, as the old read does', async () => {
    SafeFsExecutor.safeUnlinkSync(logPath, { operation: OP });
    expect(await adapter.warmTopicTails(all)).toBe(true);
    all.forEach((t) => expect(adapter.getTopicHistory(t, 500)).toEqual([]));
  });

  it('a log that keeps changing through every round saves nothing', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    let k = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const fh = await realOpen(...args);
      const realRead = fh.read.bind(fh) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (fh as unknown as { read: (...a: unknown[]) => Promise<unknown> }).read = async (...a: unknown[]) => {
        const r = await realRead(...a);
        if (r.bytesRead === 0) fs.appendFileSync(logPath, JSON.stringify({ messageId: 500_000 + k++, topicId: 1003, text: 'busy', fromUser: true, timestamp: at(1), sessionName: null }) + '\n');
        return r;
      };
      return fh;
    });
    expect(await adapter.warmTopicTails(all)).toBe(false);
    expect(inner(adapter).topicTailCache.size).toBe(0);
  });
});

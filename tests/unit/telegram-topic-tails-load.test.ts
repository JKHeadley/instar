/**
 * The conversation list must never read the Telegram log per topic on the main thread
 * (fb-52447f16-7d3, docs/specs/main-loop-freeze-conversation-list.md). One streamed load fills every
 * topic's tail; after it, tail reads are memory only and equal what the old per-topic scan returned.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const N = 60;
const OP = 'tests/unit/telegram-topic-tails-load.test.ts';
const at = (i: number) => new Date(1_700_000_000_000 + i * 1000).toISOString();
const make = (d: string) => new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, d);

describe('all-topic tail load', () => {
  let dir: string; let logPath: string; let adapter: TelegramAdapter; const extra: TelegramAdapter[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tails-'));
    logPath = path.join(dir, 'telegram-messages.jsonl');
    const lines: string[] = []; let id = 1;
    for (let round = 0; round < 3; round++) for (let t = 1; t <= N; t++) {
      lines.push(JSON.stringify({ messageId: id, topicId: 1000 + t, text: `r${round} t${t}`, fromUser: round % 2 === 0, timestamp: at(id), sessionName: null })); id++;
    }
    lines.push(JSON.stringify({ messageId: id, channelId: 1001, text: 'shared logger row', fromUser: false, timestamp: at(id), sessionName: null }));
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    adapter = make(dir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await adapter.stop();
    for (const a of extra.splice(0)) await a.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  it('after one load, N topics read zero times from the log and equal the old per-topic scan', async () => {
    const old = make(dir); extra.push(old);
    const expected = Array.from({ length: N }, (_, i) => old.getTopicHistory(1001 + i, 500));
    expect(await adapter.ensureAllTopicTailsLoaded()).toBe(true);
    const reads = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < N; i++) {
      expect(adapter.getTopicTailRows(1001 + i, 500).map((r) => [r.messageId, r.text, r.timestamp])).toEqual(expected[i].map((r) => [r.messageId, r.text, r.timestamp]));
      expect(adapter.getTopicHistory(1001 + i, 1)[0]?.messageId).toBe(expected[i].at(-1)?.messageId);
    }
    expect(adapter.getTopicTailRows(424242, 1)).toEqual([]);
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(0);
  });

  it('a closed topic keeps its tail, so the next list does not rescan', async () => {
    await adapter.ensureAllTopicTailsLoaded();
    adapter.registerTopicSession(1001, 's-1', 'Planning notes');
    adapter.unregisterTopic(1001);
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(adapter.getTopicTailRows(1001, 1)[0]?.text).toBe('shared logger row');
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(0);
  });

  it('a message logged during the load appears once, and a new topic after it gets a tail', async () => {
    const loading = adapter.ensureAllTopicTailsLoaded();
    adapter.logInboundMessage({ messageId: 9_000, topicId: 1002, text: 'during', timestamp: at(9_000) });
    await loading;
    expect(adapter.getTopicTailRows(1002, 500).filter((r) => r.messageId === 9_000)).toHaveLength(1);
    expect(adapter.getTopicTailRows(1002, 1)[0].text).toBe('during');
    adapter.logInboundMessage({ messageId: 9_001, topicId: 7777, text: 'brand new topic', timestamp: at(9_001) });
    expect(adapter.getTopicTailRows(7777, 1)[0].text).toBe('brand new topic');
  });

  it('the in-memory row replaces its persisted copy, keeping sender fields the file omits', async () => {
    const entry = { messageId: 9_100, topicId: 1003, text: 'team phone', fromUser: true, timestamp: at(9_100), sessionName: null };
    const inner = adapter as unknown as { allTailsAppends: unknown[] | null };
    const loading = adapter.ensureAllTopicTailsLoaded();
    fs.appendFileSync(logPath, JSON.stringify({ ...entry, topicId: undefined, channelId: 1003 }) + '\n');
    inner.allTailsAppends!.push({ ...entry, senderRole: 'team' });
    await loading;
    const rows = adapter.getTopicTailRows(1003, 500).filter((r) => r.messageId === 9_100) as Array<{ senderRole?: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].senderRole).toBe('team');
  });

  it('the first history seed never duplicates a tail already held', () => {
    adapter.registerTopicSession(1001, 's-1', 'Planning notes');
    adapter.registerTopicSession(1002, 's-2', 'Other notes');
    (adapter as unknown as { topicTailCache: Map<number, unknown[]> }).topicTailCache.set(1001, [{ messageId: 1, text: 'held', fromUser: true, timestamp: at(1), sessionName: null, topicId: 1001 }]);
    adapter.getTopicHistory(1002, 5);
    expect(adapter.getTopicHistory(1001, 500)).toHaveLength(1);
  });

  it('a read failing part-way is discarded, braked, and a retry succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = fs.createReadStream.bind(fs);
    const first = fs.readFileSync(logPath, 'utf-8').split('\n')[0];
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((() => Readable.from((async function* () { yield first + '\n'; throw new Error('read failed'); })(), { objectMode: true })) as unknown as typeof fs.createReadStream);
    expect(await adapter.ensureAllTopicTailsLoaded()).toBe(false);
    expect(adapter.topicTailsLoadState()).toBe('failed');
    expect((adapter as unknown as { topicTailCache: Map<number, unknown> }).topicTailCache.size).toBe(0);
    spy.mockClear();
    expect(await adapter.ensureAllTopicTailsLoaded()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockImplementation(real as typeof fs.createReadStream);
    (adapter as unknown as { allTailsRetryAt: number }).allTailsRetryAt = 0;
    expect(await adapter.ensureAllTopicTailsLoaded()).toBe(true);
    expect(adapter.getTopicTailRows(1001, 1)[0].text).toBe('shared logger row');
  });

  it('is single flight, and a missing log is simply empty', async () => {
    const spy = vi.spyOn(fs, 'createReadStream');
    await Promise.all([adapter.ensureAllTopicTailsLoaded(), adapter.ensureAllTopicTailsLoaded()]);
    expect(spy).toHaveBeenCalledTimes(1);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tails-empty-'));
    const a = make(empty); extra.push(a);
    expect(await a.ensureAllTopicTailsLoaded()).toBe(true);
    expect(a.getTopicTailRows(1, 5)).toEqual([]);
    SafeFsExecutor.safeRmSync(empty, { recursive: true, force: true, operation: OP });
  });
});

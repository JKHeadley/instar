/**
 * The in-memory view of the Telegram log stands in for the synchronous per-topic file scan
 * (fb-52447f16-7d3, docs/specs/main-loop-freeze-conversation-list.md). Everything above it is the
 * existing tail cache, so the bar is: the same answers as a real file read, with no file read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const N = 60;
const OP = 'tests/unit/telegram-log-view.test.ts';
const at = (i: number) => new Date(1_700_000_000_000 + i * 1000).toISOString();
const make = (d: string) => new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, d);
type Inner = { logView: Map<number, unknown[]> | null; topicTailCache: Map<number, unknown[]>; noteLogRotated(): void; logViewRetry: unknown; loggedMessageKeys: Set<string> };

describe('Telegram log view', () => {
  let dir: string; let logPath: string; let adapter: TelegramAdapter; const extra: TelegramAdapter[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-view-'));
    logPath = path.join(dir, 'telegram-messages.jsonl');
    const lines: string[] = []; let id = 1;
    for (let round = 0; round < 3; round++) for (let t = 1; t <= N; t++) {
      lines.push(JSON.stringify({ messageId: id, topicId: 1000 + t, text: `r${round} t${t}`, fromUser: round % 2 === 0, timestamp: at(id), sessionName: null })); id++;
    }
    lines.push(JSON.stringify({ messageId: id++, channelId: 1001, text: 'shared logger row', fromUser: false, timestamp: at(id), sessionName: null }));
    lines.push(JSON.stringify({ messageId: id++, channelId: '1002', text: 'string channel id: never this topic', fromUser: false, timestamp: at(id), sessionName: null }));
    lines.push('{not json');
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    adapter = make(dir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await adapter.stop();
    for (const a of extra.splice(0)) await a.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  it('answers every topic exactly as the file scan does, with no file read', async () => {
    const old = make(dir); extra.push(old);
    const expected = Array.from({ length: N }, (_, i) => old.getTopicHistory(1001 + i, 500));
    expect(await adapter.loadHistory()).toBe(true);
    const reads = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < N; i++) {
      expect(adapter.getTopicHistory(1001 + i, 500)).toEqual(expected[i]);
      expect(adapter.getTopicTailRows(1001 + i, 1)[0]?.messageId).toBe(expected[i].at(-1)?.messageId);
    }
    expect(adapter.getTopicHistory(424242, 5)).toEqual([]);
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(0);
  });

  it('closing a topic evicts its tail as before, and the next read needs no file read', async () => {
    await adapter.loadHistory();
    adapter.registerTopicSession(1001, 's-1', 'Planning notes');
    adapter.getTopicHistory(1001, 1);
    adapter.unregisterTopic(1001);
    expect((adapter as unknown as Inner).topicTailCache.has(1001)).toBe(false);
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(adapter.getTopicTailRows(1001, 1)[0]?.text).toBe('shared logger row');
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(0);
  });

  it('a row logged during or after the load appears once, in the shape a file read gives', async () => {
    const loading = adapter.loadHistory();
    adapter.logInboundMessage({ messageId: 9_000, topicId: 1002, text: 'during', timestamp: at(9_000) });
    await loading;
    adapter.logInboundMessage({ messageId: 9_001, topicId: 7777, text: 'after', timestamp: at(9_001) });
    const fresh = make(dir); extra.push(fresh);
    (adapter as unknown as Inner).topicTailCache.clear();
    for (const id of [1002, 7777]) expect(adapter.getTopicHistory(id, 500)).toEqual(fresh.getTopicHistory(id, 500));
    expect(adapter.getTopicHistory(1002, 500).filter((r) => r.messageId === 9_000)).toHaveLength(1);
  });

  it('after a rotation the view holds what the file now holds', async () => {
    await adapter.loadHistory();
    const kept = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).filter((l) => !l.includes('"topicId":1060'));
    fs.writeFileSync(logPath, kept.join('\n') + '\n');
    (adapter as unknown as Inner).noteLogRotated();
    await adapter.loadHistory();
    expect(adapter.getTopicTailRows(1060, 5)).toEqual([]);
  });

  it('during a rotation rebuild a cold read cannot seed a row the file no longer has', async () => {
    await adapter.loadHistory();
    const kept = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).filter((l) => !l.includes('"topicId":1060'));
    fs.writeFileSync(logPath, kept.join('\n') + '\n');
    (adapter as unknown as Inner).noteLogRotated();
    expect(adapter.isHistoryLoaded()).toBe(false);
    expect(adapter.getTopicTailRows(1060, 5)).toEqual([]);
  });

  it('an append onto a torn last line is unreadable in the view, as it is in the file', async () => {
    fs.appendFileSync(logPath, '{"messageId":8000,"topicId":1005,"text":"torn');
    await adapter.loadHistory();
    adapter.logInboundMessage({ messageId: 8001, topicId: 1005, text: 'joined the torn line', timestamp: at(8001) });
    const fresh = make(dir); extra.push(fresh);
    (adapter as unknown as Inner).topicTailCache.clear();
    expect(adapter.getTopicHistory(1005, 500)).toEqual(fresh.getTopicHistory(1005, 500));
    expect(adapter.getTopicHistory(1005, 500).some((r) => r.messageId === 8001)).toBe(false);
  });

  it('a row with a malformed id cannot stop the view from loading', async () => {
    fs.appendFileSync(logPath, JSON.stringify({ messageId: { toString: null }, topicId: 1006, text: 'odd', fromUser: false, timestamp: at(8100) }) + '\n');
    expect(await adapter.loadHistory()).toBe(true);
    expect(adapter.getTopicTailRows(1006, 1)[0].text).toBe('odd');
  });

  it('the load also seeds append dedupe, so the first send needs no full-file read', async () => {
    await adapter.loadHistory();
    const reads = vi.spyOn(fs, 'readFileSync');
    adapter.logInboundMessage({ messageId: 8200, topicId: 1007, text: 'first send', timestamp: at(8200) });
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(0);
    expect((adapter as unknown as Inner).loggedMessageKeys.has('in:1007:8200')).toBe(true);
  });

  it('a read failing part-way is discarded, braked, retried by itself, and waiters are told', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation((async (...a: Parameters<typeof fs.promises.open>) => {
      const fh = await real(...a); let reads = 0; const read = fh.read.bind(fh);
      (fh as unknown as { read: unknown }).read = (...r: unknown[]) => { if (reads++ > 0) throw new Error('read failed'); return (read as (...x: unknown[]) => unknown)(...r); };
      return fh;
    }) as typeof fs.promises.open);
    try {
      expect(await adapter.loadHistory()).toBe(false);
      expect((adapter as unknown as Inner).logView).toBeNull();
      spy.mockClear();
      expect(await adapter.loadHistory()).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      spy.mockImplementation(real as typeof fs.promises.open);
      const waiting = adapter.waitForHistory(60_000);
      await vi.advanceTimersByTimeAsync(5_000);
      vi.useRealTimers();
      expect(await waiting).toBe(true);
      expect(adapter.isHistoryLoaded()).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('a wait is bounded, the load is single flight, and a missing log is simply empty', async () => {
    const spy = vi.spyOn(fs.promises, 'open');
    await Promise.all([adapter.loadHistory(), adapter.loadHistory()]);
    expect(spy.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(1);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-view-empty-'));
    const a = make(empty); extra.push(a);
    expect(await a.waitForHistory(1_000)).toBe(true);
    expect(a.getTopicHistory(1, 5)).toEqual([]);
    SafeFsExecutor.safeRmSync(empty, { recursive: true, force: true, operation: OP });
    const stuck = make(dir); extra.push(stuck);
    vi.spyOn(stuck, 'loadHistory').mockReturnValue(new Promise(() => undefined));
    expect(await stuck.waitForHistory(20)).toBe(false);
  });

  it('scroll-back reads the same page without a synchronous read', async () => {
    const before = Date.parse(at(150));
    const expected = adapter.getTopicHistoryBefore(1001, before, 5);
    const syncReads = vi.spyOn(fs, 'readSync');
    expect(await adapter.getTopicHistoryBeforeAsync(1001, before, 5)).toEqual(expected);
    expect(syncReads).not.toHaveBeenCalled();
  });
});

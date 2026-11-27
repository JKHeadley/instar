import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// A cold topic (not live at seed time) used to cost a whole-file readFileSync of a log
// that can exceed 100 MB, on the event loop (2026-11-27 Laptop stall profile). The scan
// now reads backwards in 1 MB chunks and stops once it has enough entries.
describe('cold topic history reads the log backwards in bounded chunks', () => {
  let dir: string; let adapter: TelegramAdapter;
  afterEach(async () => { vi.restoreAllMocks(); await adapter?.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'cold-topic-history test cleanup' }); });

  function setup(lines: Array<Record<string, unknown>>): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cold-hist-'));
    adapter = new TelegramAdapter({ token: 't', chatId: '-100123', pollIntervalMs: 100 }, dir);
    const logPath = (adapter as unknown as { messageLogPath: string }).messageLogPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const at = (m: number) => new Date(Date.UTC(2026, 10, 27, 0, m)).toISOString();
  const filler = 'é'.repeat(300_000); // ~600 KB per line, so the log spans several 1 MB chunks

  it('returns the same entries as before, oldest first, across chunk boundaries and channelId rows', () => {
    setup([
      { topicId: 5, text: `first ${filler}`, timestamp: at(1), fromUser: true },
      { topicId: 9, text: filler, timestamp: at(2), fromUser: true },
      { channelId: 5, text: `second ${filler}`, timestamp: at(3), fromUser: false },
      { topicId: 9, text: filler, timestamp: at(4), fromUser: true },
      { topicId: 5, text: 'third ✓', timestamp: at(5), fromUser: true },
    ]);
    const rows = adapter.getTopicHistory(5, 20);
    expect(rows.map((e) => e.text.slice(0, 6))).toEqual(['first ', 'second', 'third ']);
    expect(rows[0]!.text.endsWith('é')).toBe(true);
    expect(adapter.getTopicHistory(9, 20)).toHaveLength(2);
    expect(adapter.getTopicHistory(404, 20)).toEqual([]);
  });

  it('stops reading once the requested entries are found and never reads the whole file at once', () => {
    const lines: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6; i++) lines.push({ topicId: 9, text: filler, timestamp: at(i), fromUser: true });
    for (let i = 0; i < 3; i++) lines.push({ topicId: 5, text: `recent ${i}`, timestamp: at(10 + i), fromUser: true });
    setup(lines);
    const whole = vi.spyOn(fs, 'readFileSync');
    const chunks = vi.spyOn(fs, 'readSync');
    // A request for the topic's last 3 entries, all in the final chunk: one chunk read.
    const scan = (adapter as unknown as { scanLogForTopic(t: number, l: number): Array<{ text: string }> }).scanLogForTopic.bind(adapter);
    expect(scan(5, 3).map((e) => e.text)).toEqual(['recent 0', 'recent 1', 'recent 2']);
    expect(chunks).toHaveBeenCalledTimes(1);
    const logPath = (adapter as unknown as { messageLogPath: string }).messageLogPath;
    expect(whole.mock.calls.some(([p]) => p === logPath)).toBe(false);
  });

  it('a missing log reads as empty', () => {
    setup([]);
    const logPath = (adapter as unknown as { messageLogPath: string }).messageLogPath;
    SafeFsExecutor.safeRmSync(logPath, { force: true, operation: 'cold-topic-history missing-log case' });
    expect(adapter.getTopicHistory(5, 20)).toEqual([]);
  });

  it('serves a 1,000-entry request from the cache after the first read, without touching the file', () => {
    const lines: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 1_200; i++) lines.push({ topicId: 5, text: `m${i}`, timestamp: at(i), fromUser: true });
    setup(lines);
    const first = adapter.getTopicHistory(5, 1_000);
    expect(first).toHaveLength(1_000);
    expect(first[0]!.text).toBe('m200');
    const whole = vi.spyOn(fs, 'readFileSync');
    const chunks = vi.spyOn(fs, 'readSync');
    const again = adapter.getTopicHistory(5, 1_000);
    expect(again.map((e) => e.text)).toEqual(first.map((e) => e.text));
    expect(whole).not.toHaveBeenCalled();
    expect(chunks).not.toHaveBeenCalled();
  });

  it('throws on an open failure other than a missing log, so no empty history is cached', () => {
    setup([{ topicId: 5, text: 'kept', timestamp: at(1), fromUser: true }]);
    const scan = (adapter as unknown as { scanLogForTopic(t: number, l: number): unknown[] }).scanLogForTopic.bind(adapter);
    const open = vi.spyOn(fs, 'openSync').mockImplementationOnce(() => { throw Object.assign(new Error('too many open files'), { code: 'EMFILE' }); });
    expect(() => scan(5, 10)).toThrow('too many open files');
    open.mockRestore();
    expect(scan(5, 10)).toHaveLength(1);
  });

  it('keeps a churned topic cached across unregister, but only for the 64 most recently unregistered', () => {
    const lines: Array<Record<string, unknown>> = [];
    for (let t = 100; t < 166; t++) lines.push({ topicId: t, text: `t${t}`, timestamp: at(t), fromUser: true });
    setup(lines);
    for (let t = 100; t < 166; t++) { adapter.registerTopicSession(t, `s${t}`); adapter.getTopicHistory(t, 10); }
    const cache = (adapter as unknown as { topicTailCache: Map<number, unknown> }).topicTailCache;
    adapter.unregisterTopic(100);
    adapter.registerTopicSession(100, 's100');
    const chunks = vi.spyOn(fs, 'readSync');
    expect(adapter.getTopicHistory(100, 10).map((e) => e.text)).toEqual(['t100']);
    expect(chunks).not.toHaveBeenCalled();
    for (let t = 101; t < 166; t++) adapter.unregisterTopic(t); // 65 unregistered topics
    expect(cache.has(101)).toBe(false); // the oldest beyond 64 is dropped
    expect(cache.has(165)).toBe(true);
    expect(cache.has(100)).toBe(true); // registered again, so never dropped
  });
});

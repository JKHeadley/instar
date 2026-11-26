import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('topic history before a time (History scroll-back past the current session)', () => {
  let dir: string; let adapter: TelegramAdapter;
  afterEach(async () => { await adapter?.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'topic-history-before test cleanup' }); });

  function setup(lines: Array<Record<string, unknown>>): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hist-before-'));
    adapter = new TelegramAdapter({ token: 't', chatId: '-100123', pollIntervalMs: 100 }, dir);
    const logPath = (adapter as unknown as { messageLogPath: string }).messageLogPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const at = (d: number) => new Date(Date.UTC(2026, 9, d, 12)).toISOString();

  it('returns only this topic, strictly before the time, oldest first, up to the limit', () => {
    setup([
      { topicId: 5, text: 'a', timestamp: at(20), fromUser: true },
      { topicId: 9, text: 'other topic', timestamp: at(21), fromUser: true },
      { topicId: 5, text: 'b', timestamp: at(22), fromUser: false },
      { topicId: 5, text: 'c', timestamp: at(25), fromUser: true },
      { topicId: 5, text: 'after', timestamp: at(31), fromUser: true },
    ]);
    const r = adapter.getTopicHistoryBefore(5, Date.parse(at(31)), 10);
    expect(r.map((e) => e.text)).toEqual(['a', 'b', 'c']);
    expect(adapter.getTopicHistoryBefore(5, Date.parse(at(31)), 2).map((e) => e.text)).toEqual(['b', 'c']);
    expect(adapter.getTopicHistoryBefore(5, Date.parse(at(20)), 10)).toEqual([]);
  });

  it('reads across chunk boundaries without losing or garbling a line (multi-byte text)', () => {
    const filler = 'é'.repeat(300_000); // ~600 KB per line: several 1 MB chunks
    setup([
      { topicId: 5, text: `first ${filler}`, timestamp: at(20), fromUser: true },
      { topicId: 9, text: filler, timestamp: at(21), fromUser: true },
      { topicId: 5, text: `second ${filler}`, timestamp: at(22), fromUser: true },
      { topicId: 9, text: filler, timestamp: at(23), fromUser: true },
      { topicId: 5, text: 'third ✓', timestamp: at(24), fromUser: true },
    ]);
    const r = adapter.getTopicHistoryBefore(5, Date.parse(at(30)), 10);
    expect(r.map((e) => e.text.slice(0, 6))).toEqual(['first ', 'second', 'third ']);
    expect(r[0].text).toBe(`first ${filler}`);
    expect(r[2].text).toBe('third ✓');
  });
  it('a message-id tie breaker reaches every recorded message at one timestamp', () => {
    const timestamp = at(25);
    setup(Array.from({ length: 120 }, (_, n) => ({ topicId: 5, messageId: n + 1, text: String(n + 1), timestamp, fromUser: true })));
    const newest = adapter.getTopicHistoryBefore(5, Date.parse(timestamp), 50, 121);
    const middle = adapter.getTopicHistoryBefore(5, Date.parse(timestamp), 50, newest[0].messageId);
    const oldest = adapter.getTopicHistoryBefore(5, Date.parse(timestamp), 50, middle[0].messageId);
    expect([...oldest, ...middle, ...newest].map((m) => m.messageId)).toEqual(Array.from({ length: 120 }, (_, n) => n + 1));
    expect(adapter.getTopicHistoryBefore(5, Date.parse(timestamp), 50)).toEqual([]); // legacy strict-before semantics
  });
});

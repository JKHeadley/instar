import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// The conversation list asked getTopicHistory(topic, 1) for every topic mapping; a topic outside
// the tail cache cost a full synchronous read of the log, so a Laptop with 508 named-only topics
// and a 30 MB log stalled for tens of seconds (2026-11-27). Previews now come from a per-topic
// newest-entry index built in the background, never from the log on the request path.
describe('latest topic entries for list previews', () => {
  let dir: string; let adapter: TelegramAdapter; let logPath: string;
  afterEach(async () => { vi.restoreAllMocks(); await adapter?.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'latest-topic-entries test cleanup' }); });

  function setup(write: (fd: number) => void): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-latest-'));
    adapter = new TelegramAdapter({ token: 't', chatId: '-100123', pollIntervalMs: 100 }, dir);
    logPath = (adapter as unknown as { messageLogPath: string }).messageLogPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, 'w');
    try { write(fd); } finally { fs.closeSync(fd); }
  }
  const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
  const ts = (m: number) => new Date(Date.UTC(2026, 10, 27, 0, 0, m)).toISOString();

  it('answers unknown before the build and the newest entry per topic after it, without reading the log on the request', async () => {
    setup((fd) => {
      fs.writeSync(fd, line({ topicId: 1, messageId: 1, text: 'old one', timestamp: ts(1), fromUser: true }));
      fs.writeSync(fd, line({ channelId: 2, messageId: 2, text: 'shared-writer two', timestamp: ts(2), fromUser: false }));
      fs.writeSync(fd, line({ topicId: 1, messageId: 3, text: 'new one', timestamp: ts(3), fromUser: true }));
      fs.writeSync(fd, 'not json\n');
    });
    const whole = vi.spyOn(fs, 'readFileSync');
    const sync = vi.spyOn(fs, 'readSync');
    const first = adapter.latestTopicEntries([1, 2, 3]);
    expect([...first.values()]).toEqual([undefined, undefined, undefined]);
    expect(whole.mock.calls.some(([p]) => p === logPath)).toBe(false);
    expect(sync).not.toHaveBeenCalled();
    await adapter.buildLatestEntryIndex();
    const after = adapter.latestTopicEntries([1, 2, 3]);
    expect(after.get(1)?.text).toBe('new one');
    expect(after.get(2)?.text).toBe('shared-writer two');
    expect(after.get(3)).toBeNull();
    expect(whole.mock.calls.some(([p]) => p === logPath)).toBe(false);
  });

  it('keeps an entry logged while the build runs over the older one in the file', async () => {
    setup((fd) => { fs.writeSync(fd, line({ topicId: 7, messageId: 1, text: 'from the file', timestamp: ts(1), fromUser: true })); });
    const build = adapter.buildLatestEntryIndex();
    const remember = (adapter as unknown as { rememberLoggedEntry(e: unknown, k: string): void }).rememberLoggedEntry.bind(adapter);
    remember({ topicId: 7, messageId: 99, text: 'logged during the build', timestamp: ts(9), fromUser: true }, 'in:7:99');
    await build;
    expect(adapter.latestTopicEntries([7]).get(7)?.text).toBe('logged during the build');
    remember({ topicId: 7, messageId: 100, text: 'logged after', timestamp: ts(10), fromUser: true }, 'in:7:100');
    expect(adapter.latestTopicEntries([7]).get(7)?.text).toBe('logged after');
  });

  it('builds an empty index when there is no log', async () => {
    setup(() => {});
    SafeFsExecutor.safeRmSync(logPath, { force: true, operation: 'latest-topic-entries missing-log case' });
    await adapter.buildLatestEntryIndex();
    expect(adapter.latestTopicEntries([1]).get(1)).toBeNull();
  });

  it('heartbeat: building the index over a 30 MB log never blocks the event loop for long', async () => {
    const pad = 'x'.repeat(500);
    setup((fd) => {
      let chunk = '';
      for (let i = 0; i < 55_000; i++) { // about 30 MB across 600 topics
        chunk += line({ topicId: i % 600, messageId: i, text: pad, timestamp: ts(i % 60), fromUser: i % 2 === 0 });
        if (chunk.length > 1_000_000) { fs.writeSync(fd, chunk); chunk = ''; }
      }
      if (chunk) fs.writeSync(fd, chunk);
    });
    expect(fs.statSync(logPath).size).toBeGreaterThan(29 * 1024 * 1024);
    let last = performance.now(); let maxGap = 0;
    const beat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
    try {
      const started = performance.now();
      await adapter.buildLatestEntryIndex();
      const took = performance.now() - started;
      console.log(`[heartbeat] 30 MB index build took ${took.toFixed(0)} ms; largest event-loop gap ${maxGap.toFixed(1)} ms`);
    } finally { clearInterval(beat); }
    // One 1 MB chunk is parsed per turn of the loop; a whole-file synchronous read and parse of
    // 30 MB took about a second. Generous bound so slow CI hosts pass while a regression fails.
    expect(maxGap).toBeLessThan(250);
    const entries = adapter.latestTopicEntries(Array.from({ length: 600 }, (_, i) => i));
    expect([...entries.values()].every((e) => e && typeof e.timestamp === 'string')).toBe(true);
  });
});

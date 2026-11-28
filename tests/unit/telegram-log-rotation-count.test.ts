import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// The rotation check used to readFileSync + split the whole message log on every append once it
// passed 20 MB, while rotating only above 100,000 lines: a 30 MB log paid a full read per logged
// message (2026-11-27 stall). It now counts lines once and then only the appended bytes.
describe('message log rotation check counts lines without rereading the log', () => {
  let dir: string; let adapter: TelegramAdapter; let logPath: string;
  afterEach(async () => { vi.restoreAllMocks(); await adapter?.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'rotation-count test cleanup' }); });

  function setup(lineCount: number, lineBytes: number): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rot-count-'));
    adapter = new TelegramAdapter({ token: 't', chatId: '-100123', pollIntervalMs: 100 }, dir);
    logPath = (adapter as unknown as { messageLogPath: string }).messageLogPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const pad = 'x'.repeat(Math.max(0, lineBytes - 80));
    const fd = fs.openSync(logPath, 'w');
    try {
      for (let i = 0; i < lineCount; i++) fs.writeSync(fd, JSON.stringify({ topicId: 5, messageId: i, text: pad, fromUser: true, timestamp: 't' }) + '\n');
    } finally { fs.closeSync(fd); }
  }
  const rotate = () => (adapter as unknown as { maybeRotateLog(): void }).maybeRotateLog();
  const append = (n: number) => fs.appendFileSync(logPath, Array.from({ length: n }, (_, i) => JSON.stringify({ topicId: 5, messageId: 1e6 + i, text: 'new', fromUser: true, timestamp: 't' })).join('\n') + '\n');
  const lines = () => fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).length;

  it('a large log under the line limit is never read whole, however many appends follow', () => {
    setup(20_000, 1_100); // about 22 MB, 20,000 lines
    const whole = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < 5; i++) { append(1); rotate(); }
    expect(whole.mock.calls.some(([p]) => p === logPath)).toBe(false);
    whole.mockRestore();
    expect(lines()).toBe(20_005);
  });

  it('still rotates a log over 100,000 lines down to 75,000, then counts only what is appended', () => {
    setup(100_500, 300); // about 30 MB, over the line limit; the kept 75,000 lines stay above 20 MB
    rotate();
    expect(lines()).toBe(75_000);
    append(3);
    const whole = vi.spyOn(fs, 'readFileSync');
    const chunks = vi.spyOn(fs, 'readSync');
    rotate();
    expect(whole.mock.calls.some(([p]) => p === logPath)).toBe(false);
    // Only the three appended lines' bytes are read, which fit in one chunk.
    expect(chunks).toHaveBeenCalledTimes(1);
  });
});

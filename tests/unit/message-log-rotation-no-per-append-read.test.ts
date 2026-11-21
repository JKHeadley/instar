/**
 * Above the 20 MB size threshold, the message-log rotation check used to read and split the
 * WHOLE log on every append (it only rotates past 100 000 lines). Echo's live log was 30.8 MB /
 * 36 000 lines on 2026-11-21, so every logged message did a ~31 MB synchronous read on the main
 * thread (docs/specs/main-loop-freeze-conversation-list.md). Now the line count is learned once
 * by a byte-level newline count and advanced per append; the file is read only to rotate.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageLogger, RotationLineCount, countNewlines } from '../../src/messaging/shared/MessageLogger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/message-log-rotation-no-per-append-read.test.ts' });
});

function logger(maxLines: number, keepLines: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msglog-rot-'));
  dirs.push(dir);
  const logPath = path.join(dir, 'log.jsonl');
  // A threshold of 1 byte puts every append above it, the state Echo's 30 MB log is in.
  return { logPath, log: new MessageLogger({ logPath, maxLines, keepLines, rotationSizeThreshold: 1 }) };
}

const entry = (i: number) => ({ messageId: i, channelId: '1', text: `m${i}`, fromUser: true, timestamp: new Date(1_700_000_000_000 + i).toISOString(), sessionName: null, platform: 'telegram' as const });

describe('message-log rotation does not read the log per append', () => {
  it('counts newlines without decoding', () => {
    expect(countNewlines(Buffer.from('a\nb\n\nc'))).toBe(3);
    expect(countNewlines(Buffer.alloc(0))).toBe(0);
  });

  it('above the size threshold, 200 appends read the file once (the seed), not 200 times', () => {
    const { logPath, log } = logger(10_000, 5_000);
    const reads = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < 200; i++) expect(log.append(entry(i) as never)).toBe(true);
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(1);
    expect(fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)).toHaveLength(200);
  });

  it('still rotates at the cap, keeping the newest lines, and keeps counting after', () => {
    const { logPath, log } = logger(50, 20);
    for (let i = 0; i < 51; i++) log.append(entry(i) as never);
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(20);
    expect(JSON.parse(lines[19]).messageId).toBe(50);
    for (let i = 51; i < 82; i++) log.append(entry(i) as never);
    expect(fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)).toHaveLength(20);
  });

  it('a failing rotation is braked: no full read on every following append, and it recovers', () => {
    const { logPath, log } = logger(50, 20);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('simulated rename failure'); });
    for (let i = 0; i < 51; i++) log.append(entry(i) as never); // the 51st append tries to rotate and fails
    const reads = vi.spyOn(fs, 'readFileSync');
    for (let i = 51; i < 151; i++) log.append(entry(i) as never);
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(0); // braked for 1 000 appends
    rename.mockRestore();
    for (let i = 151; i < 1_100; i++) log.append(entry(i) as never); // past the brake: the rotation runs and succeeds
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(50);
    expect(JSON.parse(lines.at(-1)!).messageId).toBe(1_099);
  });

  it('injected: a rotation that fails, then succeeds late, keeps every line an on-time rotation would have kept', () => {
    const { logPath, log } = logger(50, 20);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('simulated rename failure'); });
    for (let i = 0; i < 51; i++) log.append(entry(i) as never); // the on-time attempt at 51 lines fails
    rename.mockRestore();
    for (let i = 51; i < 80; i++) log.append(entry(i) as never); // braked: still over the cap
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    log.append(entry(80) as never); // the late rotation
    const ids = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l).messageId);
    // On time, rotation at 51 lines keeps messages 31..50; then 51..80 follow: 31..80.
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => 31 + i));
  });

  it('forget() makes the next check recount the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msglog-rot-'));
    dirs.push(dir);
    const p = path.join(dir, 'x.jsonl');
    fs.writeFileSync(p, 'a\nb\n');
    const c = new RotationLineCount();
    expect(c.mayExceed(p, 2)).toBe(false); // 2 lines
    expect(c.mayExceed(p, 2)).toBe(true);  // advanced to 3
    c.forget();
    expect(c.mayExceed(p, 2)).toBe(false); // recounted: 2
  });

  it('a failed attempt is braked, a failed first count too, and forget() clears the brake', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msglog-rot-'));
    dirs.push(dir);
    const p = path.join(dir, 'x.jsonl');
    fs.writeFileSync(p, 'a\nb\nc\n');
    const c = new RotationLineCount();
    expect(c.mayExceed(p, 2)).toBe(true);
    c.failed();
    expect(c.mayExceed(p, 2)).toBe(false); // braked
    c.forget();
    expect(c.mayExceed(p, 2)).toBe(true); // a replaced file does not inherit the brake
    const missing = new RotationLineCount();
    expect(() => missing.mayExceed(path.join(dir, 'gone'), 2)).toThrow();
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(missing.mayExceed(path.join(dir, 'gone'), 2)).toBe(false);
    expect(reads).not.toHaveBeenCalled();
  });

  it('after a failed attempt, the next append past one minute retries even with little traffic', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msglog-rot-'));
    dirs.push(dir);
    const p = path.join(dir, 'x.jsonl');
    fs.writeFileSync(p, 'a\nb\nc\n');
    const c = new RotationLineCount();
    expect(c.mayExceed(p, 2)).toBe(true);
    c.failed();
    expect(c.mayExceed(p, 2)).toBe(false);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect(c.mayExceed(p, 2)).toBe(true);
  });
});

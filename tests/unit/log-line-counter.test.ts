import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogLineCounter } from '../../src/messaging/shared/LogLineCounter.js';
import { MessageLogger } from '../../src/messaging/shared/MessageLogger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Follow-up tests asked for by the PR 3985 review: both sides of the line limit, a shrunken
// file, a replaced file, no trailing newline, the exact count after a full read, and errors.
// The shared MessageLogger takes small limits, so the rotation rule is exercised exactly.
let dir: string;
afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'log-line-counter test cleanup' }); });
const mk = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-line-count-')); return path.join(dir, 'log.jsonl'); };
const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => JSON.stringify({ messageId: from + i, channelId: 1, text: 'x', fromUser: true, timestamp: 't' })).join('\n');
const lines = (p: string) => fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length;
const entry = (i: number) => ({ messageId: i, channelId: '1', text: 'x', fromUser: true, timestamp: 't', sessionName: null, platform: 'slack' }) as never;

describe('LogLineCounter', () => {
  it('counts once, then reads only appended bytes', () => {
    const p = mk(); fs.writeFileSync(p, rows(5) + '\n');
    const c = new LogLineCounter(p);
    expect(c.newlines(fs.statSync(p))).toBe(5);
    fs.appendFileSync(p, rows(2, 5) + '\n');
    const reads = vi.spyOn(fs, 'readSync');
    expect(c.newlines(fs.statSync(p))).toBe(7);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('counts a final line without its newline once that newline arrives, and never double counts', () => {
    const p = mk(); fs.writeFileSync(p, rows(3)); // last line has no newline
    const c = new LogLineCounter(p);
    expect(c.newlines(fs.statSync(p))).toBe(2);
    fs.appendFileSync(p, '\n' + rows(1, 3) + '\n');
    expect(c.newlines(fs.statSync(p))).toBe(4);
  });

  it('recounts a file that shrank or was replaced by a different file of larger size', () => {
    const p = mk(); fs.writeFileSync(p, rows(10) + '\n');
    const c = new LogLineCounter(p);
    expect(c.newlines(fs.statSync(p))).toBe(10);
    fs.writeFileSync(p, rows(4) + '\n'); // truncated in place
    expect(c.newlines(fs.statSync(p))).toBe(4);
    const tmp = p + '.new'; fs.writeFileSync(tmp, rows(12) + '\n'); fs.renameSync(tmp, p); // new inode, larger
    expect(c.newlines(fs.statSync(p))).toBe(12);
  });

  it('adopts an exact count after a full read and continues from it', () => {
    const p = mk(); fs.writeFileSync(p, rows(3) + '\n\n\n'); // blank lines overstate
    const c = new LogLineCounter(p);
    const stat = fs.statSync(p);
    expect(c.newlines(stat)).toBe(5);
    c.adopt(3, stat.size, stat.ino);
    fs.appendFileSync(p, rows(1, 3) + '\n');
    expect(c.newlines(fs.statSync(p))).toBe(4);
  });

  it('throws when the file is gone, and recounts after reset', () => {
    const p = mk(); fs.writeFileSync(p, rows(2) + '\n');
    const c = new LogLineCounter(p);
    const stat = fs.statSync(p);
    c.reset();
    SafeFsExecutor.safeRmSync(p, { force: true, operation: 'log-line-counter missing-file case' });
    expect(() => c.newlines(stat)).toThrow();
  });
});

describe('MessageLogger rotation with the incremental count', () => {
  it('does not rotate at exactly the line limit and rotates one line above it', () => {
    const p = mk();
    const logger = new MessageLogger({ logPath: p, maxLines: 100, keepLines: 60, rotationSizeThreshold: 1 });
    fs.writeFileSync(p, rows(99) + '\n');
    logger.append(entry(1000)); // 100 lines
    expect(lines(p)).toBe(100);
    logger.append(entry(1001)); // 101 lines -> rotate
    expect(lines(p)).toBe(60);
  });

  it('never reads the whole log while the count stays under the limit', () => {
    const p = mk();
    const logger = new MessageLogger({ logPath: p, maxLines: 100, keepLines: 60, rotationSizeThreshold: 1 });
    fs.writeFileSync(p, rows(50) + '\n');
    const whole = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < 5; i++) logger.append(entry(2000 + i));
    expect(whole.mock.calls.some(([f]) => f === p)).toBe(false);
  });

  it('rotates exactly when blank lines inflate the newline count', () => {
    const p = mk();
    const logger = new MessageLogger({ logPath: p, maxLines: 100, keepLines: 60, rotationSizeThreshold: 1 });
    fs.writeFileSync(p, rows(90) + '\n' + '\n'.repeat(20)); // 110 newlines, 90 lines
    logger.append(entry(3000));
    expect(lines(p)).toBe(91); // not rotated: the full read found only 91 lines
    for (let i = 0; i < 10; i++) logger.append(entry(3001 + i)); // 101 lines
    expect(lines(p)).toBe(60);
  });
});

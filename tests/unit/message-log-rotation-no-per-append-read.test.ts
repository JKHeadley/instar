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

  /**
   * The old code (2e3e9a868): after each append, above the size threshold, read the file; if it has
   * more than maxLines non-empty lines, keep the newest keepLines. A failed read or rename leaves the
   * file as it is and the next append tries again. This oracle replays that on the same appends.
   */
  function oldCode(appends: string[], maxLines: number, keepLines: number, failOnAppend: Set<number>): string[] {
    let file: string[] = [];
    appends.forEach((line, i) => {
      file.push(line);
      if (failOnAppend.has(i)) return;
      if (file.length > maxLines) file = file.slice(-keepLines);
    });
    return file;
  }
  const lineOf = (i: number) => JSON.stringify(entry(i));

  for (const [name, failure] of [
    ['the rename', 'rename'],
    ['the rotation read', 'read'],
  ] as const) {
    it(`injected: when ${name} fails, every line the old code keeps survives, in the same order`, () => {
      const { logPath, log } = logger(50, 20);
      const fail = new Set([50, 51, 52, 75]); // the on-time attempt, the next two retries, and a later rotation's
      const appends: string[] = [];
      for (let i = 0; i < 120; i++) {
        appends.push(lineOf(i));
        const restore: Array<() => void> = [];
        if (fail.has(i)) {
          if (failure === 'rename') { const r = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('simulated rename failure'); }); restore.push(() => r.mockRestore()); }
          else {
            const real = fs.readFileSync.bind(fs);
            const r = vi.spyOn(fs, 'readFileSync').mockImplementation(((f: fs.PathOrFileDescriptor, o?: unknown) => {
              if (String(f) === logPath && o === 'utf-8') throw new Error('simulated read failure');
              return (real as (...x: unknown[]) => unknown)(f, o);
            }) as typeof fs.readFileSync);
            restore.push(() => r.mockRestore());
          }
        }
        log.append(entry(i) as never);
        for (const r of restore) r();
      }
      const actual = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
      const expected = oldCode(appends, 50, 20, fail);
      expect(actual.map((l) => JSON.parse(l).messageId)).toEqual(expected.map((l) => JSON.parse(l).messageId));
    });
  }

  it('injected: blank lines and an unterminated last line never make rotation later than the old code', () => {
    const { logPath, log } = logger(50, 20);
    const seed = Array.from({ length: 45 }, (_, i) => lineOf(1000 + i));
    fs.writeFileSync(logPath, seed.join('\n\n') + '\n' + lineOf(2000)); // blank lines between, no final newline
    const appends = [...seed, lineOf(2000)];
    for (let i = 0; i < 30; i++) { log.append(entry(i) as never); appends.push(lineOf(i)); }
    const actual = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    // The first append joins the unterminated line, so the old code sees one line fewer there.
    const lines = actual.map((l) => { try { return JSON.parse(l).messageId; } catch { return 'joined'; } });
    const oldLines = (() => {
      let file = [...seed, lineOf(2000) + lineOf(0)];
      for (let i = 1; i < 30; i++) { file.push(lineOf(i)); if (file.length > 50) file = file.slice(-20); }
      return file.map((l) => { try { return JSON.parse(l).messageId; } catch { return 'joined'; } });
    })();
    expect(lines).toEqual(oldLines);
  });

  it('injected: an append that fails part-way makes the count recount, so rotation is not late', () => {
    const { logPath, log } = logger(50, 20);
    for (let i = 0; i < 49; i++) log.append(entry(i) as never);
    const realAppend = fs.appendFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(((f: fs.PathOrFileDescriptor, d: string | Uint8Array) => { realAppend(f, d); throw new Error('close failed after the write'); }) as typeof fs.appendFileSync);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(log.append(entry(49) as never)).toBe(false); // the line did reach the disk
    spy.mockRestore();
    log.append(entry(50) as never); // 51 real lines: the old code rotates here
    const ids = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l).messageId);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => 31 + i));
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

});

/**
 * Rotation (trimming) of the message log is the old code, unchanged
 * (docs/specs/conversation-list-log-view.md). These tests are the guard: under injected read,
 * rename and append failures, the file must end up holding exactly the lines the old algorithm keeps,
 * in the same order, and a rotation must tell the Telegram log view to follow the file.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageLogger } from '../../src/messaging/shared/MessageLogger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/message-log-rotation-matches-old-code.test.ts' });
});

function logger(maxLines: number, keepLines: number, onRotated?: () => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msglog-rot-'));
  dirs.push(dir);
  const logPath = path.join(dir, 'log.jsonl');
  // A threshold of 1 byte puts every append above it, the state Echo's 30 MB log is in.
  return { logPath, log: new MessageLogger({ logPath, maxLines, keepLines, rotationSizeThreshold: 1, onRotated }) };
}

const entry = (i: number) => ({ messageId: i, channelId: '1', text: `m${i}`, fromUser: true, timestamp: new Date(1_700_000_000_000 + i).toISOString(), sessionName: null, platform: 'telegram' as const });

describe('message-log rotation is the old code', () => {
  it('rotates at the cap, keeping the newest lines, and tells the view each time', () => {
    let rotations = 0;
    const { logPath, log } = logger(50, 20, () => { rotations += 1; });
    for (let i = 0; i < 51; i++) log.append(entry(i) as never);
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(20);
    expect(JSON.parse(lines[19]).messageId).toBe(50);
    for (let i = 51; i < 82; i++) log.append(entry(i) as never);
    expect(fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)).toHaveLength(20);
    expect(rotations).toBe(2);
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

  it('injected: blank lines and an unterminated last line keep exactly what the old code keeps', () => {
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

  it('injected: an append that fails part-way makes no difference: the next append rotates when the old code does', () => {
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
});

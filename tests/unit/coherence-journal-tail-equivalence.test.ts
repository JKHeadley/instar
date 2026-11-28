/**
 * readTailTolerant equivalence (2026-11-27). The reader now walks its window backwards in chunks and
 * stops at `limit`, instead of reading and splitting the whole window synchronously (11.6 s of server
 * thread under OwnershipApplier.tick on a loaded Laptop). Results must be identical to the previous
 * body, kept verbatim below as the reference, across many generated journal files.
 */
import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTailTolerant, TAIL_READ_CHUNK_BYTES, type JournalFs, type TolerantReadResult, type JournalEntry } from '../../src/core/CoherenceJournal.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// The previous implementation, verbatim except for its name.
function referenceReadTailTolerant(
  io: JournalFs,
  filePath: string,
  limit: number,
  byteCeiling: number,
): TolerantReadResult {
  const result: TolerantReadResult = { entries: [], skippedCorrupt: 0, truncated: false };
  if (!io.existsSync(filePath)) return result;

  let size: number;
  try {
    size = io.statSync(filePath).size;
  } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
    return result;
  }
  if (size === 0) return result;

  const readBytes = Math.min(size, byteCeiling);
  if (readBytes < size) result.truncated = true;
  const start = size - readBytes;

  let buf: Buffer;
  let fd: number | null = null;
  try {
    fd = io.openSync(filePath, 'r');
    buf = Buffer.alloc(readBytes);
    io.readSync(fd, buf, 0, readBytes, start);
  } catch {
    return result;
  } finally {
    if (fd !== null) {
      try {
        io.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }

  let text = buf.toString('utf-8');
  // If we started mid-file, the first (partial) line is not a whole record.
  if (start > 0) {
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1);
    result.truncated = true;
  }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && result.entries.length < limit; i--) {
    const ln = lines[i];
    if (!ln) continue;
    try {
      const obj = JSON.parse(ln) as JournalEntry;
      if (typeof obj.seq === 'number' && typeof obj.kind === 'string') {
        result.entries.push(obj);
      } else {
        result.skippedCorrupt++;
      }
    } catch {
      result.skippedCorrupt++;
    }
  }
  return result;
}


const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/coherence-journal-tail-equivalence.test.ts' }); });
const io = fs as unknown as JournalFs;

let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
function line(i: number): string {
  const r = rand();
  if (r < 0.06) return '{"not":"an entry"}';
  if (r < 0.1) return 'garbled {' + 'x'.repeat(Math.floor(rand() * 40));
  if (r < 0.12) return '';
  const pad = 'é漢'.repeat(Math.floor(rand() * 3)) + 'p'.repeat(Math.floor(rand() * (rand() < 0.1 ? 90_000 : 400)));
  return JSON.stringify({ seq: i, kind: 'topic-placement', ts: 1_000 + i, data: { pad } });
}
function file(lines: number, trailingNewline: boolean, crlf = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-tail-')); dirs.push(dir);
  const p = path.join(dir, 'stream.jsonl');
  const eol = crlf ? '\r\n' : '\n';
  const body = Buffer.from(Array.from({ length: lines }, (_, i) => line(i)).join(eol) + (trailingNewline ? eol : ''), 'utf-8');
  // Splice a few invalid UTF-8 bytes into the middle of the file, as a damaged journal might hold.
  const bad = body.length > 40 ? Buffer.concat([body.subarray(0, 20), Buffer.from([0xe6, 0xbc, 0xff]), body.subarray(20)]) : body;
  fs.writeFileSync(p, bad);
  return p;
}

describe('readTailTolerant equivalence with the previous whole-window reader', () => {
  it('returns identical entries, corrupt count and truncation over generated files and bounds', () => {
    let cases = 0;
    for (const lines of [0, 1, 2, 7, 60, 400, 1500]) {
      for (const [trailing, crlf] of [[true, false], [false, false], [true, true]] as const) {
        const p = file(lines, trailing, crlf);
        const size = fs.statSync(p).size;
        for (const limit of [0, 1, 3, 50, 500]) {
          for (const ceiling of [size, Math.floor(size / 2), 10, 333, TAIL_READ_CHUNK_BYTES - 1, TAIL_READ_CHUNK_BYTES, TAIL_READ_CHUNK_BYTES + 7, 2 * TAIL_READ_CHUNK_BYTES, 2 * TAIL_READ_CHUNK_BYTES + 1, 4 * 1024 * 1024]) {
            const a: TolerantReadResult = referenceReadTailTolerant(io, p, limit, Math.max(1, ceiling));
            const b: TolerantReadResult = readTailTolerant(io, p, limit, Math.max(1, ceiling));
            expect(b, `lines=${lines} trailing=${trailing} crlf=${crlf} limit=${limit} ceiling=${ceiling}`).toEqual(a);
            cases++;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(1000);
  });

  it('a read error part-way through returns no entries, as the whole-window read did', () => {
    const p = file(3000, true);
    let calls = 0;
    const failing = { ...fs, readSync: (fd: number, buf: Buffer, off: number, len: number, pos: number) => {
      if (++calls === 2) throw new Error('EIO');
      return fs.readSync(fd, buf, off, len, pos);
    } } as unknown as JournalFs;
    const size = fs.statSync(p).size;
    expect(calls).toBe(0);
    expect(readTailTolerant(failing, p, 2000, 4 * 1024 * 1024)).toEqual({ entries: [], skippedCorrupt: 0, truncated: size > 4 * 1024 * 1024 });
    expect(calls).toBe(2);
  });

  it('a line longer than many chunks is read in one pass and parsed whole', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-tail-')); dirs.push(dir);
    const p = path.join(dir, 'long.jsonl');
    fs.writeFileSync(p, JSON.stringify({ seq: 1, kind: 'topic-placement', data: { pad: 'q'.repeat(300_000) } }) + '\n');
    let bytesRead = 0;
    const counting = { ...fs, readSync: (fd: number, buf: Buffer, off: number, len: number, pos: number) => { bytesRead += len; return fs.readSync(fd, buf, off, len, pos); } } as unknown as JournalFs;
    const r = readTailTolerant(counting, p, 10, 4 * 1024 * 1024);
    expect(r.entries.map((e: JournalEntry) => e.seq)).toEqual([1]);
    expect(bytesRead).toBe(fs.statSync(p).size);
    expect(r).toEqual(referenceReadTailTolerant(fs as unknown as JournalFs, p, 10, 4 * 1024 * 1024));
  });

  it('a missing or empty file still returns nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-tail-')); dirs.push(dir);
    expect(readTailTolerant(io, path.join(dir, 'absent.jsonl'), 10, 1000)).toEqual({ entries: [], skippedCorrupt: 0, truncated: false });
    const empty = path.join(dir, 'empty.jsonl'); fs.writeFileSync(empty, '');
    expect(readTailTolerant(io, empty, 10, 1000)).toEqual({ entries: [], skippedCorrupt: 0, truncated: false });
  });

  it('reads only what the limit needs from a large file, not the whole window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-tail-')); dirs.push(dir);
    const p = path.join(dir, 'big.jsonl');
    fs.writeFileSync(p, Array.from({ length: 20_000 }, (_, i) => JSON.stringify({ seq: i, kind: 'topic-placement', data: { pad: 'p'.repeat(180) } })).join('\n') + '\n');
    let bytesRead = 0;
    const counting = { ...fs, readSync: (fd: number, buf: Buffer, off: number, len: number, pos: number) => { bytesRead += len; return fs.readSync(fd, buf, off, len, pos); } } as unknown as JournalFs;
    const r = readTailTolerant(counting, p, 50, 4 * 1024 * 1024);
    expect(r.entries.map((e: JournalEntry) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 19_999 - i));
    expect(bytesRead).toBeLessThanOrEqual(TAIL_READ_CHUNK_BYTES);
    expect(fs.statSync(p).size).toBeGreaterThan(3 * 1024 * 1024);
  });
});

import fs from 'node:fs';

/**
 * Incremental newline count for an append-only log, so a rotation check never rereads the whole
 * file per append (2026-11-27 stall: a 30 MB log was read and split on every logged message).
 *
 * The count is built once from raw bytes (no decode, no split), then advanced by reading only the
 * bytes appended since the last call. A file smaller than at the last count, or with a different
 * inode (replaced by another writer), is counted again from the start. The count is of newline
 * bytes: N newlines can mean N + 1 non-empty lines (a final line without its newline), and blank
 * lines make it larger than the non-empty count, so callers use it only to decide whether an
 * exact full read is worth doing, then hand the exact result back with `adopt`.
 */
export class LogLineCounter {
  private count: number | null = null;
  private bytes = 0;
  private ino: number | bigint | null = null;

  constructor(private readonly logPath: string) {}

  /** Newline bytes in the log as of `stat`, reading only what was appended since the last call. */
  newlines(stat: fs.Stats): number {
    if (this.count === null || stat.size < this.bytes || stat.ino !== this.ino) {
      this.count = 0;
      this.bytes = 0;
      this.ino = stat.ino;
    }
    if (stat.size > this.bytes) {
      this.count += countNewlines(this.logPath, this.bytes, stat.size);
      this.bytes = stat.size;
    }
    return this.count;
  }

  /** Take an exact count from a full read: `lines` non-empty lines in `bytes` raw bytes at `ino`. */
  adopt(lines: number, bytes: number, ino: number | bigint): void {
    this.count = lines;
    this.bytes = bytes;
    this.ino = ino;
  }

  /** Forget the count; the next call counts the file again. */
  reset(): void {
    this.count = null;
  }
}

/** Newline bytes in `logPath` between two offsets, read in 1 MB chunks. */
export function countNewlines(logPath: string, from: number, to: number): number {
  const CHUNK = 1024 * 1024;
  const fd = fs.openSync(logPath, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let count = 0;
    for (let pos = from; pos < to; pos += CHUNK) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, to - pos), pos);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) if (buf[i] === 0x0a) count++;
    }
    return count;
  } finally {
    try { fs.closeSync(fd); } catch { /* @silent-fallback-ok: closing a read-only handle */ }
  }
}

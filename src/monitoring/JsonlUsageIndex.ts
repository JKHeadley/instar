/**
 * JsonlUsageIndex — incremental, non-blocking token totals over Claude Code
 * transcript JSONL files.
 *
 * Why this exists (incident 2026-09-22): QuotaCollector's JSONL fallback used
 * to `readFileSync` + `JSON.parse` EVERY line of EVERY transcript modified in
 * the last 7 days, synchronously, on every poll that followed an OAuth failure.
 * With the OAuth usage endpoint rate-limited (429), that ran every 1-3 minutes
 * over ~34k files / tens of GB and froze the server's event loop for 30-80s at
 * a time — peers saw the machine as down.
 *
 * This index replaces that full rescan:
 *  - INCREMENTAL: each file's consumed byte offset is remembered, so a pass
 *    only reads bytes appended since the previous pass.
 *  - NON-BLOCKING: all file I/O is async, and the scan yields to the event loop
 *    between files and every `yieldEveryLines` lines.
 *  - BOUNDED: at most `maxBytesPerPass` bytes are read per pass. A pass that
 *    hits the budget reports `complete: false`; the caller must not treat a
 *    partial total as an estimate (it would undercount). The next pass resumes.
 *  - PRE-FILTERED: a line is only JSON.parsed if it contains `"usage"`.
 *  - DEDUPED: Claude Code repeats the same request's usage on each content-block
 *    line; like the TokenLedger (request_id PRIMARY KEY), each `requestId` is
 *    counted once. (The pre-2026-09-22 parser counted every line — ~2x high.)
 *
 * Totals are kept in hourly buckets so a sliding window can be summed without
 * re-reading anything. A file that shrinks or is replaced (different inode)
 * cannot have its old contribution subtracted, so the whole index is reset and
 * rebuilt — Claude Code transcripts are append-only, so this is rare.
 *
 * Production prefers the TokenLedger (an already-incremental SQLite index over
 * the same files) via QuotaCollector.setUsageTotalsSource(); this index is the
 * self-contained path for when no ledger is wired.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { JsonlTokenCounts } from './QuotaCollector.js';

export interface JsonlUsageIndexOptions {
  /** Directory holding `-Users-*` project subdirectories of `*.jsonl` files. */
  claudeProjectsDir: string;
  /** Max bytes read per pass (default 256 MiB). */
  maxBytesPerPass?: number;
  /** Yield to the event loop every N lines (default 2000). */
  yieldEveryLines?: number;
  /** Read chunk size in bytes (default 1 MiB). */
  chunkBytes?: number;
  /** Test seam for the event-loop yield. */
  yieldFn?: () => Promise<void>;
}

export interface JsonlUsagePassResult {
  /**
   * True when every in-window file has been read to its end (an unterminated
   * line still being written does not count against completeness).
   */
  complete: boolean;
  /** Token totals for entries at or after `sinceMs` (only meaningful when complete). */
  totals: JsonlTokenCounts;
  /** Bytes read during this pass. */
  bytesRead: number;
  /** Files considered (modified within the window). */
  filesConsidered: number;
}

interface FileCursor {
  offset: number;
  ino: number;
}

const HOUR_MS = 60 * 60 * 1000;

function emptyCounts(): JsonlTokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalBilled: 0 };
}

const defaultYield = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export class JsonlUsageIndex {
  private readonly dir: string;
  private readonly maxBytesPerPass: number;
  private readonly yieldEveryLines: number;
  private readonly chunkBytes: number;
  private readonly yieldFn: () => Promise<void>;

  private cursors = new Map<string, FileCursor>();
  private buckets = new Map<number, JsonlTokenCounts>();
  /** requestId → hour bucket it was counted in (pruned with the buckets). */
  private seenRequests = new Map<string, number>();
  private inFlight: Promise<JsonlUsagePassResult> | null = null;

  constructor(opts: JsonlUsageIndexOptions) {
    this.dir = opts.claudeProjectsDir;
    this.maxBytesPerPass = opts.maxBytesPerPass ?? 256 * 1024 * 1024;
    this.yieldEveryLines = opts.yieldEveryLines ?? 2000;
    this.chunkBytes = opts.chunkBytes ?? 1024 * 1024;
    this.yieldFn = opts.yieldFn ?? defaultYield;
  }

  /**
   * Run one incremental pass and return totals since `sinceMs`. Concurrent
   * callers share the in-flight pass instead of starting a second scan.
   */
  update(sinceMs: number): Promise<JsonlUsagePassResult> {
    if (!this.inFlight) {
      this.inFlight = this.runPass(sinceMs).finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  /** Number of files currently tracked (observability/tests). */
  trackedFileCount(): number {
    return this.cursors.size;
  }

  private async runPass(sinceMs: number): Promise<JsonlUsagePassResult> {
    // Track files one hour past the window edge: a file's cursor must outlive
    // its boundary-hour buckets, or a later append would re-read it from zero
    // and double-count entries still inside the window.
    const files = await this.listFiles(sinceMs - HOUR_MS);
    const inWindow = new Set(files.map(f => f.path));

    // Forget files that dropped out of the window — their buckets age out below.
    for (const p of this.cursors.keys()) {
      if (!inWindow.has(p)) this.cursors.delete(p);
    }

    // A shrunk or replaced file can't have its old contribution subtracted:
    // reset everything and rebuild from zero.
    for (const f of files) {
      const cur = this.cursors.get(f.path);
      if (cur && (f.size < cur.offset || f.ino !== cur.ino)) {
        this.cursors.clear();
        this.buckets.clear();
        this.seenRequests.clear();
        break;
      }
    }

    let bytesRead = 0;
    let complete = true;
    for (const f of files) {
      const cur = this.cursors.get(f.path) ?? { offset: 0, ino: f.ino };
      if (cur.offset >= f.size) {
        this.cursors.set(f.path, cur);
        continue;
      }
      const budget = this.maxBytesPerPass - bytesRead;
      if (budget <= 0) {
        complete = false;
        break;
      }
      const { consumed, read, reachedEnd } = await this.consumeFile(f.path, cur.offset, f.size, budget, f.mtimeMs);
      bytesRead += read;
      this.cursors.set(f.path, { offset: cur.offset + consumed, ino: f.ino });
      if (!reachedEnd) complete = false;
      await this.yieldFn();
    }

    this.pruneBuckets(sinceMs);
    return { complete, totals: this.sumSince(sinceMs), bytesRead, filesConsidered: files.length };
  }

  private async listFiles(sinceMs: number): Promise<Array<{ path: string; size: number; ino: number; mtimeMs: number }>> {
    const out: Array<{ path: string; size: number; ino: number; mtimeMs: number }> = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.dir, { withFileTypes: true });
    } catch {
      // @silent-fallback-ok — projects directory may not exist; an empty list yields no estimate
      return out;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('-Users-') || !entry.isDirectory()) continue;
      const projectDir = path.join(this.dir, entry.name);
      let names: string[];
      try {
        names = await fs.promises.readdir(projectDir);
      } catch {
        // @silent-fallback-ok — a single unreadable project dir must not sink the whole pass
        continue;
      }
      const jsonl = names.filter(n => n.endsWith('.jsonl'));
      // Stat in small parallel batches: async (threadpool), never one sync call per file.
      for (let i = 0; i < jsonl.length; i += 64) {
        const batch = jsonl.slice(i, i + 64).map(async (name) => {
          const p = path.join(projectDir, name);
          try {
            const st = await fs.promises.stat(p);
            if (st.mtimeMs >= sinceMs) out.push({ path: p, size: st.size, ino: st.ino, mtimeMs: st.mtimeMs });
          } catch {
            // @silent-fallback-ok — file may vanish between readdir and stat
          }
        });
        await Promise.all(batch);
      }
      await this.yieldFn();
    }
    return out;
  }

  /**
   * Read from `start` toward `size`, counting complete lines. Returns the bytes
   * consumed (always ends on a line boundary, so a line being written is
   * re-read next pass) and whether the file was consumed to its end.
   */
  private async consumeFile(
    filePath: string,
    start: number,
    size: number,
    budget: number,
    mtimeMs: number,
  ): Promise<{ consumed: number; read: number; reachedEnd: boolean }> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(filePath, 'r');
    } catch {
      // @silent-fallback-ok — unreadable file is skipped this pass (treated as consumed to avoid a stuck pass)
      return { consumed: 0, read: 0, reachedEnd: true };
    }
    let pos = start;
    let consumed = 0;
    let read = 0;
    let pending: Buffer = Buffer.alloc(0);
    let linesSinceYield = 0;
    try {
      while (pos < size && read < budget) {
        const len = Math.min(this.chunkBytes, size - pos, budget - read);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await handle.read(buf, 0, len, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        read += bytesRead;
        const data = pending.length ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl === -1) {
          pending = data;
          continue;
        }
        const text = data.subarray(0, lastNl).toString('utf-8');
        for (const line of text.split('\n')) {
          this.ingestLine(line, mtimeMs);
          if (++linesSinceYield >= this.yieldEveryLines) {
            linesSinceYield = 0;
            await this.yieldFn();
          }
        }
        consumed += lastNl + 1;
        pending = data.subarray(lastNl + 1);
      }
      const reachedEnd = pos >= size;
      // A final line with no trailing newline counts only if it is complete JSON
      // (a line still being written almost never parses).
      if (reachedEnd && pending.length > 0) {
        const tail = pending.toString('utf-8');
        if (this.ingestLine(tail, mtimeMs, true)) consumed += pending.length;
      }
      // An unparsable unterminated tail is a line still being written: the file
      // is still "caught up" for this pass (that line is counted once it lands).
      return { consumed, read, reachedEnd };
    } finally {
      await handle.close().catch(() => { /* @silent-fallback-ok — close failure is harmless for a read-only handle */ });
    }
  }

  /** Returns true when the line was well-formed JSON (used for the unterminated tail). */
  private ingestLine(line: string, fallbackTsMs: number, requireJson = false): boolean {
    if (!requireJson && !line.includes('"usage"')) return false;
    let entry: {
      type?: string;
      requestId?: string;
      timestamp?: string;
      message?: { role?: string; usage?: Record<string, number> };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      // @silent-fallback-ok — individual JSONL line may be malformed or partially written
      return false;
    }
    if (entry?.type !== 'assistant') return true;
    const message = entry.message;
    if (!message || message.role !== 'assistant' || !message.usage) return true;
    const parsedTs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    const ts = Number.isFinite(parsedTs) ? parsedTs : fallbackTsMs;
    const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
    if (typeof entry.requestId === 'string' && entry.requestId) {
      if (this.seenRequests.has(entry.requestId)) return true;
      this.seenRequests.set(entry.requestId, hour);
    }
    let b = this.buckets.get(hour);
    if (!b) {
      b = emptyCounts();
      this.buckets.set(hour, b);
    }
    const u = message.usage;
    const input = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    const cacheCreate = u.cache_creation_input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    b.inputTokens += input;
    b.outputTokens += output;
    b.cacheCreationTokens += cacheCreate;
    b.cacheReadTokens += cacheRead;
    b.totalBilled += input + output + cacheCreate + cacheRead;
    return true;
  }

  private pruneBuckets(sinceMs: number): void {
    const cutoffHour = Math.floor(sinceMs / HOUR_MS) * HOUR_MS;
    for (const hour of this.buckets.keys()) {
      if (hour < cutoffHour) this.buckets.delete(hour);
    }
    for (const [id, hour] of this.seenRequests) {
      if (hour < cutoffHour) this.seenRequests.delete(id);
    }
  }

  private sumSince(sinceMs: number): JsonlTokenCounts {
    const total = emptyCounts();
    for (const [hour, b] of this.buckets) {
      // The boundary hour is included whole: an hour-granular estimate is
      // within the tolerance of an already-estimated figure.
      if (hour + HOUR_MS <= sinceMs) continue;
      total.inputTokens += b.inputTokens;
      total.outputTokens += b.outputTokens;
      total.cacheCreationTokens += b.cacheCreationTokens;
      total.cacheReadTokens += b.cacheReadTokens;
      total.totalBilled += b.totalBilled;
    }
    return total;
  }
}

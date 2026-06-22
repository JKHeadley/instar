/**
 * Bounded JSONL tail reader — read only the LAST window of an append-only log,
 * never the whole file.
 *
 * Born from the 2026-06-22 event-loop-freeze batch: several timers and event
 * handlers (CommitmentSentinel, CoherenceMonitor, PresenceProxy's
 * checkLogForAgentResponse, TelegramAdapter.getMessageLog) each called
 * `fs.readFileSync(messageLogPath, 'utf-8')` on the 12MB telegram-messages.jsonl
 * just to look at the last ~50–200 lines. A 12MB synchronous read+split on a
 * 5-minute timer froze the event loop for up to 20s per pass. These callers do
 * not need the whole file — only its tail.
 *
 * Design (mirrors CoherenceJournal.readTailTolerant, generalized off the
 * journal's typed entry shape):
 *   - statSync the file (O(1)) — read at most `maxBytes` from the END.
 *   - openSync + readSync the trailing window into a fixed buffer; never load
 *     the whole file. O(maxBytes), not O(file).
 *   - Discard the first (partial) line when the window started mid-file so a
 *     truncated record is never mis-parsed.
 *   - Return the raw trailing lines (newest LAST, file order preserved) — the
 *     caller parses + filters exactly as it did over the full split before.
 *
 * Never throws — a read failure returns an empty result, matching the
 * @silent-fallback-ok behavior of every former full-file caller. Observability
 * / housekeeping reads must never endanger the observed operation.
 */

import fs from 'node:fs';

/** Default trailing window: 512KB. At ~200 bytes/line that is ~2,600 recent
 *  lines — far more than any caller's last-50/last-200 need, with headroom for
 *  long messages, while staying a small bounded read regardless of file size. */
export const DEFAULT_TAIL_BYTES = 512 * 1024;

export interface TailReadResult {
  /** Trailing lines in FILE order (oldest of the window first, newest last).
   *  Non-empty lines only — blank lines are dropped. */
  lines: string[];
  /** True when the file was larger than the window (the head was not read). */
  truncated: boolean;
}

/**
 * Read the last `maxBytes` of `filePath` and return its non-empty lines in file
 * order. Reads at most `maxBytes` from disk regardless of total file size.
 */
export function readJsonlTailLines(
  filePath: string,
  maxBytes: number = DEFAULT_TAIL_BYTES,
): TailReadResult {
  const empty: TailReadResult = { lines: [], truncated: false };
  try {
    if (!fs.existsSync(filePath)) return empty;
  } catch {
    return empty;
  }

  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return empty;
  }
  if (size === 0) return empty;

  const readBytes = Math.min(size, maxBytes);
  const truncated = readBytes < size;
  const start = size - readBytes;

  let buf: Buffer;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, start);
  } catch {
    return empty;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }

  let text = buf.toString('utf-8');
  // If the window started mid-file, the first line is a partial record — drop it.
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }

  const lines = text.split('\n').filter((l) => l.length > 0);
  return { lines, truncated };
}

/**
 * Convenience: read the tail and return at most the last `limit` non-empty
 * lines (file order). Equivalent to the common
 * `readFileSync(...).split('\n').filter(Boolean).slice(-limit)` pattern, but
 * bounded to a trailing `maxBytes` window instead of the whole file.
 */
export function readJsonlTailLastLines(
  filePath: string,
  limit: number,
  maxBytes: number = DEFAULT_TAIL_BYTES,
): string[] {
  const { lines } = readJsonlTailLines(filePath, maxBytes);
  return limit >= lines.length ? lines : lines.slice(-limit);
}

/**
 * JsonlStore — the registered accessor for append-only JSONL persistence
 * (Bounded Accumulation standard §3a/§3b).
 *
 * Every persistent JSONL store routes through this class so that:
 *   1. The retention policy (maxBytes / keepSegments / archive) is declared and
 *      ENFORCED at the one place data is written — not hoped for at each callsite.
 *   2. The lint surface is a single funnel: raw `fs.appendFileSync` to a `.instar/`
 *      path in `src/` is itself a Lint-1 failure; an author must use this accessor,
 *      which makes the retention declaration unskippable.
 *   3. Rotation is the event-loop-SAFE segment cut (rename, not read-filter-rewrite),
 *      gated behind a cached byte-counter so the size check is amortized — even the
 *      O(1) `statSync` is not paid on every append.
 *
 * This is the storage twin of the funnels SafeFsExecutor / SafeGitExecutor already
 * establish for destructive fs/git ops: one chokepoint that a lint can enforce.
 */

import fs from 'node:fs';
import path from 'node:path';
import { maybeRotateJsonlSegment } from '../../utils/jsonl-rotation.js';

export interface JsonlStoreOptions {
  /** Maximum active-file size in bytes before a segment is cut. Default: 32MB. */
  maxBytes?: number;
  /** Rotated segments to retain (oldest beyond this are unlinked, unless archive). Default: 4. */
  keepSegments?: number;
  /**
   * Compliance-hold: rotated segments are NEVER unlinked. For audit/forensic trails
   * that must never lose their oldest entries. Default: false.
   */
  archive?: boolean;
  /**
   * Amortize the rotation size-check: only check (and possibly rotate) after this many
   * bytes have been appended since the last check. Keeps the hot append path a pure
   * `appendFileSync` + counter bump. Default: 64KB.
   */
  checkEveryBytes?: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024; // 32MB
const DEFAULT_KEEP_SEGMENTS = 4;
const DEFAULT_CHECK_EVERY_BYTES = 64 * 1024; // 64KB

export class JsonlStore {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly keepSegments: number;
  private readonly archive: boolean;
  private readonly checkEveryBytes: number;
  /** Bytes appended since the last rotation size-check (the cached counter). */
  private bytesSinceCheck = 0;

  constructor(filePath: string, options: JsonlStoreOptions = {}) {
    this.filePath = filePath;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keepSegments = Math.max(1, options.keepSegments ?? DEFAULT_KEEP_SEGMENTS);
    this.archive = options.archive ?? false;
    this.checkEveryBytes = Math.max(1, options.checkEveryBytes ?? DEFAULT_CHECK_EVERY_BYTES);
  }

  /** Append one raw line (a trailing newline is added if absent). */
  append(line: string): void {
    const data = line.endsWith('\n') ? line : line + '\n';
    this.ensureDir();
    fs.appendFileSync(this.filePath, data);
    this.bytesSinceCheck += Buffer.byteLength(data);
    if (this.bytesSinceCheck >= this.checkEveryBytes) {
      this.bytesSinceCheck = 0;
      // O(1) segment cut when over maxBytes; never throws.
      maybeRotateJsonlSegment(this.filePath, {
        maxBytes: this.maxBytes,
        keepSegments: this.keepSegments,
        archive: this.archive,
      });
    }
  }

  /** Append one JSON-serialized object as a line. */
  appendObject(obj: unknown): void {
    this.append(JSON.stringify(obj));
  }

  /** Force a rotation size-check now (e.g. on a periodic sweep), bypassing the counter. */
  checkRotationNow(): boolean {
    this.bytesSinceCheck = 0;
    return maybeRotateJsonlSegment(this.filePath, {
      maxBytes: this.maxBytes,
      keepSegments: this.keepSegments,
      archive: this.archive,
    });
  }

  /** The active file path this store writes to. */
  get path(): string {
    return this.filePath;
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch {
      // directory likely exists; append will surface a real error if not
    }
  }
}

/**
 * BoundedJsonlAudit — a tiny size-bounded JSONL audit appender with rotation
 * (ownership-gated-spawn-and-judgment-within-floors spec §3.8: "Both audit
 * logs carry rotation + size bounds via SafeFsExecutor").
 *
 * Contract: scrubbed, metadata-only rows (the CALLER guarantees content —
 * this class only bounds size). Append is async + fire-and-forget from the
 * caller's perspective; a write failure is swallowed to the logger because an
 * audit trail must never affect the decision it audits.
 *
 * Rotation: when the active file exceeds maxFileBytes it is renamed to
 * `<file>.1` (shifting `.1`→`.2`, …); archives beyond keepArchives are deleted
 * through SafeFsExecutor (audited destructive fs).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface BoundedJsonlAuditOptions {
  /** Absolute path of the active JSONL file (e.g. <home>/logs/owner-dark-ladder.jsonl). */
  file: string;
  /** Rotate when the active file exceeds this. Default 5 MB. */
  maxFileBytes?: number;
  /** Rotated archives kept (`.1`..`.N`). Default 2. */
  keepArchives?: number;
  log?: (msg: string) => void;
}

export class BoundedJsonlAudit {
  private readonly file: string;
  private readonly maxFileBytes: number;
  private readonly keepArchives: number;
  private readonly log: (msg: string) => void;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: BoundedJsonlAuditOptions) {
    this.file = opts.file;
    this.maxFileBytes = opts.maxFileBytes && opts.maxFileBytes > 0 ? opts.maxFileBytes : 5 * 1024 * 1024;
    this.keepArchives = opts.keepArchives && opts.keepArchives >= 0 ? opts.keepArchives : 2;
    this.log = opts.log ?? (() => {});
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      /* @silent-fallback-ok: append will surface the failure to the logger. */
    }
  }

  /** Append one row (serialized appends; failures logged, never thrown). */
  append(row: Record<string, unknown>): void {
    this.chain = this.chain.then(async () => {
      try {
        await this.rotateIfNeeded();
        await fsp.appendFile(this.file, JSON.stringify(row) + '\n');
      } catch (err) {
        this.log(`[BoundedJsonlAudit] append failed (${path.basename(this.file)}): ${(err as Error).message}`);
      }
    });
  }

  /** Await all pending appends (tests / shutdown). */
  flush(): Promise<void> {
    return this.chain;
  }

  private async rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      size = (await fsp.stat(this.file)).size;
    } catch {
      return; // no file yet
    }
    if (size <= this.maxFileBytes) return;
    try {
      // Delete the oldest archive if it would overflow keepArchives.
      const oldest = `${this.file}.${this.keepArchives}`;
      if (this.keepArchives > 0 && fs.existsSync(oldest)) {
        await SafeFsExecutor.safeUnlink(oldest, { operation: `bounded-jsonl-audit rotation (${path.basename(this.file)})` });
      }
      // Shift .N-1 → .N, …, .1 → .2.
      for (let i = this.keepArchives - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) await fsp.rename(from, `${this.file}.${i + 1}`);
      }
      if (this.keepArchives > 0) {
        await fsp.rename(this.file, `${this.file}.1`);
      } else {
        await SafeFsExecutor.safeUnlink(this.file, { operation: `bounded-jsonl-audit rotation (${path.basename(this.file)})` });
      }
    } catch (err) {
      this.log(`[BoundedJsonlAudit] rotation failed (${path.basename(this.file)}): ${(err as Error).message}`);
    }
  }
}

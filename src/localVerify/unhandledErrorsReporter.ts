/**
 * A vitest reporter the verifier adds to every lane and isolation re-run (trusted side: it
 * is loaded from the installed server's own dist by absolute path, never from the PR).
 *
 * vitest's JSON reporter does not include unhandled errors, and vitest exits 1 for both a
 * failed test and an unhandled error, so the exit code alone cannot say which happened.
 * This reporter writes the unhandled-error count (and the first few messages, bounded) to
 * the file named by LOCAL_VERIFY_UNHANDLED_ERRORS_FILE, so the orchestrator never lets an
 * isolation re-run hide an unhandled error (spec Throughput budget, flaky files).
 */

import fs from 'node:fs';

export interface UnhandledErrorsFile {
  v: 1;
  unhandledErrors: number;
  messages: string[];
}

/**
 * In-flight progress (deadline forensics, throughput brainstorm 2026-11-12 E2): when a lane
 * hits its deadline the JSON report is never written, so nobody could say which test files
 * were still running at the kill (13 of 15 deadline errors in 24 h, all unexplained). The
 * reporter keeps a small, throttled snapshot of the files that started and have not finished
 * in LOCAL_VERIFY_PROGRESS_FILE. Metadata only: it never feeds a verdict.
 */
export interface ProgressFile {
  v: 1;
  writtenAt: number;
  finishedFiles: number;
  /** Oldest first, at most PROGRESS_MAX_FILES. */
  running: Array<{ file: string; startedAt: number }>;
}

export const PROGRESS_MAX_FILES = 10;
const PROGRESS_EVERY_MS = 5_000;

interface TaskLike { type?: string; filepath?: string; file?: { filepath?: string }; result?: { state?: string } }

export default class LocalVerifyUnhandledErrorsReporter {
  private ctx: { state?: { idMap?: Map<string, TaskLike> } } | null = null;
  private readonly started = new Map<string, number>();
  private readonly finished = new Set<string>();
  private lastWrite = 0;

  onInit(ctx: unknown): void {
    this.ctx = (ctx ?? null) as typeof this.ctx;
  }

  onTaskUpdate(packs: unknown[] = []): void {
    const out = process.env.LOCAL_VERIFY_PROGRESS_FILE;
    if (!out) return;
    const idMap = this.ctx?.state?.idMap;
    const now = Date.now();
    for (const pack of packs) {
      const [id, result] = (Array.isArray(pack) ? pack : []) as [unknown, { state?: string } | undefined];
      const task = typeof id === 'string' ? idMap?.get(id) : undefined;
      const file = task?.filepath ?? task?.file?.filepath;
      if (!file || this.finished.has(file)) continue;
      if (!this.started.has(file)) this.started.set(file, now);
      // The file task itself reaching a terminal state ends the file.
      const isFileTask = typeof task?.filepath === 'string';
      const state = result?.state ?? task?.result?.state;
      if (isFileTask && (state === 'pass' || state === 'fail' || state === 'skip' || state === 'todo')) {
        this.finished.add(file);
        this.started.delete(file);
      }
    }
    if (now - this.lastWrite >= PROGRESS_EVERY_MS) this.writeProgress(out, now);
  }

  private writeProgress(out: string, now: number): void {
    this.lastWrite = now;
    const body: ProgressFile = {
      v: 1,
      writtenAt: now,
      finishedFiles: this.finished.size,
      running: [...this.started.entries()].sort((a, b) => a[1] - b[1]).slice(0, PROGRESS_MAX_FILES)
        .map(([file, startedAt]) => ({ file, startedAt })),
    };
    try {
      fs.writeFileSync(`${out}.tmp`, JSON.stringify(body));
      fs.renameSync(`${out}.tmp`, out);
    } catch { /* @silent-fallback-ok: forensics only; a missed snapshot never affects a verdict */ }
  }

  onFinished(_files?: unknown, errors: unknown[] = []): void {
    const out = process.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE;
    if (!out) return;
    const body: UnhandledErrorsFile = {
      v: 1,
      unhandledErrors: errors.length,
      messages: errors.slice(0, 5).map((e) => String((e as { message?: unknown })?.message ?? e).slice(0, 400)),
    };
    fs.writeFileSync(out, JSON.stringify(body));
  }
}

/** Parse the file the reporter wrote; null when absent or unreadable (unknown ⇒ never re-run). */
export function readUnhandledErrors(text: string | null): number | null {
  if (text === null) return null;
  try {
    const o = JSON.parse(text) as Partial<UnhandledErrorsFile>;
    return o.v === 1 && Number.isInteger(o.unhandledErrors) && (o.unhandledErrors as number) >= 0 ? (o.unhandledErrors as number) : null;
  } catch {
    return null;
  }
}

/** Parse a progress snapshot; null when absent or malformed. File paths are made relative to `root`. */
export function readProgress(text: string | null, root: string, now: number): { finishedFiles: number; running: Array<{ file: string; seconds: number }> } | null {
  if (text === null) return null;
  try {
    const o = JSON.parse(text) as Partial<ProgressFile>;
    if (o.v !== 1 || !Array.isArray(o.running) || !Number.isInteger(o.finishedFiles)) return null;
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return {
      finishedFiles: o.finishedFiles as number,
      running: o.running.slice(0, PROGRESS_MAX_FILES)
        .filter((r): r is { file: string; startedAt: number } => typeof r?.file === 'string' && typeof r?.startedAt === 'number')
        .map((r) => ({ file: (r.file.startsWith(prefix) ? r.file.slice(prefix.length) : r.file).slice(0, 200), seconds: Math.max(0, Math.round((now - r.startedAt) / 1000)) })),
    };
  } catch {
    return null;
  }
}

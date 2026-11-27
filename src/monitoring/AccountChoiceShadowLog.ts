/**
 * AccountChoiceShadowLog — quota pacing step 2 (docs/specs/quota-pacing-account-choice.md §5).
 *
 * One row per EXECUTED spawn placement while window-aware account choice is on:
 * the account the new rule picked, what the old rule would have picked, why
 * they differ, and each account's window states at decision time. Throttle and
 * monitor evaluations are not logged — the graduation review reads placement
 * outcomes only (joined to the existing wall and swap logs by `sessionName`).
 *
 * Bounded and observational: each placement requests an asynchronous flush,
 * with an unref'd maintenance timer. Spawn limits bound the row rate, and the
 * log keeps the last 30 days. Rows still in the buffer at an unclean stop may
 * be lost. The next process's
 * first flush records `lostOnRestart: 'unknown'` so the loss is never silent.
 * A failure here never changes a placement.
 *
 * Telemetry, not memory: account ids are pool ids, never emails or tokens.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type { ChoiceReason, WindowState } from '../core/windowAwareChoice.js';

export const ACCOUNT_CHOICE_SHADOW_FILE = 'placement-shadow.jsonl';
export const ACCOUNT_CHOICE_SHADOW_SCHEMA = 'account-choice-shadow/1';
const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_FLUSH_MS = 5_000;
const MAX_LINE_BYTES = 8 * 1024;
const MODEL_RE = /^[\w.-]{1,64}$/;

export type ModelSource = 'explicit' | 'config-default' | 'unknown';

export interface ShadowAccountRow {
  id: string;
  fiveHour: number | null;
  sevenDay: number | null;
  fable: number | null;
  states: { fiveHour: WindowState; sevenDay: WindowState; fable: WindowState };
}

export interface PlacementShadowInput {
  sessionName: string | null;
  caller: string;
  framework: string;
  model: string | null;
  modelSource: ModelSource;
  executed: string | null;
  oldPick: string | null;
  newPick: string | null;
  reasons: ChoiceReason[];
  accounts: ShadowAccountRow[];
  /** Accounts whose out-of-cycle read breaker is open at decision time. */
  rereadBreakerOpen?: string[];
}

export interface PlacementShadowRow extends PlacementShadowInput {
  kind: 'placement';
  ts: string;
  decisionId: string;
  machineId: string;
  differs: boolean;
  lostOnRestart?: 'unknown';
}

/** Clamp the caller-supplied model text to a safe token. */
export function sanitizeModel(model: string | null | undefined): string | null {
  if (model === null || model === undefined || model === '') return null;
  return MODEL_RE.test(model) ? model : 'other';
}

export function shadowLogPath(stateDir: string): string {
  return path.join(stateDir, '..', 'logs', ACCOUNT_CHOICE_SHADOW_FILE);
}

export class AccountChoiceShadowLog {
  private readonly file: string;
  private readonly cleanMarker: string;
  private readonly machineId: string;
  private readonly now: () => number;
  private buffer: PlacementShadowRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTrimDay: number | null = null;
  private pendingLossMark: boolean;
  private readonly markerReset: Promise<void>;
  private flushing: Promise<void> | null = null;
  private stopped = false;
  /** Writes that failed (counted, never thrown into a placement). */
  writeFailures = 0;

  constructor(opts: { file: string; machineId: string; now?: () => number; flushMs?: number }) {
    this.file = opts.file;
    this.cleanMarker = `${opts.file}.clean`;
    this.machineId = opts.machineId;
    this.now = opts.now ?? (() => Date.now());
    // A log from an earlier process with no clean-stop marker may have lost buffered rows.
    let hadLog = false;
    let clean = false;
    try { hadLog = fs.existsSync(this.file); clean = fs.existsSync(this.cleanMarker); } catch { /* @silent-fallback-ok: unknown → mark below */ }
    this.pendingLossMark = hadLog && !clean;
    this.markerReset = clean
      ? SafeFsExecutor.safeUnlink(this.cleanMarker, { operation: 'AccountChoiceShadowLog:clear-clean-marker' })
        .catch(() => { this.writeFailures++; })
      : Promise.resolve();
    const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
    if (flushMs > 0) {
      this.timer = setInterval(() => { void this.flush(); }, flushMs);
      this.timer.unref?.();
    }
  }

  /** Buffer one executed placement and request an asynchronous flush. Never throws. */
  record(input: PlacementShadowInput): void {
    if (this.stopped) return;
    try {
      const row: PlacementShadowRow = {
        kind: 'placement',
        ts: new Date(this.now()).toISOString(),
        decisionId: crypto.randomUUID(),
        machineId: this.machineId,
        ...input,
        model: sanitizeModel(input.model),
        differs: input.oldPick !== input.newPick,
      };
      if (this.pendingLossMark) {
        row.lostOnRestart = 'unknown';
        this.pendingLossMark = false;
      }
      this.buffer.push(row);
      void this.flush();
    } catch {
      this.writeFailures++; // @silent-fallback-ok: counted; a shadow failure never changes a placement
    }
  }

  /** Append buffered rows; trim to the last 30 days at each day roll. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushPending().finally(() => {
      this.flushing = null;
      if (this.buffer.length > 0) void this.flush();
    });
    return this.flushing;
  }

  private async flushPending(): Promise<void> {
    await this.markerReset;
    try {
      do {
        const rows = this.buffer;
        this.buffer = [];
        if (rows.length > 0) {
          await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
          const text = rows.map((r) => JSON.stringify(r)).filter((l) => Buffer.byteLength(l) <= MAX_LINE_BYTES).join('\n') + '\n';
          await fs.promises.appendFile(this.file, text);
        }
        const day = Math.floor(this.now() / DAY_MS);
        if (this.lastTrimDay !== day) {
          this.lastTrimDay = day;
          await this.trim();
        }
      } while (this.buffer.length > 0);
    } catch {
      this.writeFailures++; // @silent-fallback-ok: counted and reported by the route
    }
  }

  /** Keep rows from the last 30 days (atomic rewrite). */
  private async trim(): Promise<void> {
    if (!fs.existsSync(this.file)) return;
    const cutoff = this.now() - KEEP_DAYS * DAY_MS;
    const lines = (await fs.promises.readFile(this.file, 'utf-8')).split('\n').filter(Boolean);
    const kept = lines.filter((l) => {
      try { return Date.parse((JSON.parse(l) as { ts?: string }).ts ?? '') >= cutoff; } catch { return false; }
    });
    if (kept.length === lines.length) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(tmp, kept.length ? kept.join('\n') + '\n' : '');
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      try { if (fs.existsSync(tmp)) await SafeFsExecutor.safeUnlink(tmp, { operation: 'AccountChoiceShadowLog.trim:cleanup-temp' }); } catch { /* @silent-fallback-ok: a stray temp file is replaced next day */ }
      throw err;
    }
  }

  /** Flush and mark a clean stop (the next process then records no possible loss). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    while (this.buffer.length > 0) await this.flush();
    if (this.writeFailures > 0) return;
    try { await fs.promises.writeFile(this.cleanMarker, ''); } catch { /* @silent-fallback-ok: next start marks possible loss */ }
  }
}

/** Read and parse every row in a shadow log (malformed lines skipped and counted). */
export async function readShadowRows(file: string): Promise<{ rows: PlacementShadowRow[]; malformed: number }> {
  let text = '';
  try { text = await fs.promises.readFile(file, 'utf-8'); } catch { return { rows: [], malformed: 0 }; }
  const rows: PlacementShadowRow[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as PlacementShadowRow;
      if (r && r.kind === 'placement' && typeof r.ts === 'string') rows.push(r);
      else malformed++;
    } catch { malformed++; }
  }
  return { rows, malformed };
}

export interface ShadowPage {
  rows: PlacementShadowRow[];
  next: string | null;
}

/** One page of raw rows in file order, filtered by time. `cursor` is opaque. Limit at most 500. */
export function pageShadowRows(
  rows: PlacementShadowRow[],
  q: { sinceMs?: number; untilMs?: number; limit?: number; cursor?: string | null },
): ShadowPage {
  const limit = Math.max(1, Math.min(500, Math.floor(q.limit ?? 100)));
  const filtered = rows.filter((r) => {
    const t = Date.parse(r.ts);
    return (q.sinceMs === undefined || t >= q.sinceMs) && (q.untilMs === undefined || t < q.untilMs);
  });
  let start = 0;
  if (q.cursor) {
    const n = Number(Buffer.from(q.cursor, 'base64url').toString('utf-8'));
    if (Number.isInteger(n) && n >= 0) start = n;
  }
  const page = filtered.slice(start, start + limit);
  const end = start + page.length;
  return { rows: page, next: end < filtered.length ? Buffer.from(String(end)).toString('base64url') : null };
}

export interface ShadowDaySummary {
  date: string;
  placements: number;
  differing: number;
  byCaller: Record<string, number>;
  byReason: Record<string, number>;
  byTierOfPick: Record<string, number>;
  executedByAccount: Record<string, number>;
  breakerOpenings: number;
  lostOnRestart: number;
}

/** Per-day summaries (UTC days), small enough to cross the pool fan-out's per-peer byte limit. */
export function summarizeShadowRows(rows: PlacementShadowRow[]): ShadowDaySummary[] {
  const days = new Map<string, ShadowDaySummary>();
  for (const r of rows) {
    const date = r.ts.slice(0, 10);
    let d = days.get(date);
    if (!d) {
      d = { date, placements: 0, differing: 0, byCaller: {}, byReason: {}, byTierOfPick: {}, executedByAccount: {}, breakerOpenings: 0, lostOnRestart: 0 };
      days.set(date, d);
    }
    d.placements++;
    if (r.differs) d.differing++;
    d.byCaller[r.caller] = (d.byCaller[r.caller] ?? 0) + 1;
    for (const reason of r.reasons ?? []) d.byReason[reason] = (d.byReason[reason] ?? 0) + 1;
    const picked = (r.accounts ?? []).find((a) => a.id === r.newPick);
    const tier = picked
      ? (Object.values(picked.states).every((s) => s === 'measured' || s === 'idle' || s === 'not-offered') ? 'measured' : 'unmeasured')
      : 'none';
    d.byTierOfPick[tier] = (d.byTierOfPick[tier] ?? 0) + 1;
    if (r.executed) d.executedByAccount[r.executed] = (d.executedByAccount[r.executed] ?? 0) + 1;
    d.breakerOpenings += r.rereadBreakerOpen?.length ?? 0;
    if (r.lostOnRestart) d.lostOnRestart++;
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

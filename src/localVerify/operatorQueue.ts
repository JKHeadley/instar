/**
 * The operator's choices for the Local Verify queue (spec
 * docs/specs/local-verify-queue-controls.md): which changes are HELD (not tested until
 * released) and which are FRONTED (the next change to start).
 *
 * Choices are kept per pull-request number, never on a queue entry: an entry is rebuilt on
 * every push, re-request and restart, so a choice stored on it would be lost. One small file,
 * `state/local-verify/operator-queue.json`, written atomically (a temporary file, then a
 * rename). After every successful write the previous good copy is kept beside it
 * (`operator-queue.json.prev`); a file that cannot be read falls back to that copy, and when
 * neither can be read the store starts empty and says so (`loadReport`), so the service can
 * report at once that holds were lost.
 *
 * At most OPERATOR_QUEUE_LIMITS.maxRecords changes are remembered. The store never decides
 * what a hold or a front MEANS: the LocalVerifyService reads it at the moment it admits,
 * orders, starts or hands off work. Machine-local, single writer (the service of the machine
 * holding the coordinator lease).
 */

import fs from 'node:fs';
import path from 'node:path';
import { isValidBaseRef, isValidPr, isValidSha } from './record.js';

const HOUR = 60 * 60_000;

export const OPERATOR_QUEUE_LIMITS = Object.freeze({
  /** Changes remembered at once (holds can be set before queueing, so the queue's size does not bound them). */
  maxRecords: 200,
  /** `reason`, shown in full in the queue view. */
  reasonChars: 500,
  /** `by`: a label for the record, not a proof of identity. */
  byChars: 100,
  /** Changes fronted at once. */
  maxFronted: 3,
  /** Places over the queue cap shared by front and release admissions, counted while those entries are queued. */
  overflow: 5,
  /** A hold with no `until` is reminded once after this long. */
  reminderAfterMs: 24 * HOUR,
  /** How often the coordinator looks for due holds and closed changes. */
  checkEveryMs: HOUR,
  /** Records (beyond the due holds) checked for a closed change per pass. */
  closedChecksPerPass: 25,
  /** A release, front admission or switch-off re-admission that cannot read the change is retried this many ticks, then given up (audited). */
  pendingRetries: 20,
});

/** The queue entry a hold took out, kept whole so a release puts back exactly what the hold removed. */
export interface SavedQueueEntry {
  headSha: string;
  baseSha: string;
  baseRefName: string;
  firstQueuedAt: number;
  firstObservedAt?: number;
  firstRefusedAt?: number;
  attempts: number;
  errorRetries: number;
  starvedRaised: boolean;
  pausedMs?: number;
  baseResolvedAt?: number;
  interruptions?: number;
  resumeFirst?: true;
  priority?: number;
  remoteAttempts?: number;
  preflightBypassRetry?: true;
  preflightRediscoverable?: true;
}

/** The waiting-list place a hold took out. */
export interface SavedWaiter {
  firstRefusedAt: number;
  lastOfferedAt: number;
  refusals: number;
}

export interface OperatorHold {
  by: string;
  reason: string;
  at: number;
  /** The date the operator expects to release by (ms); absent = none. */
  until?: number;
  /** When the saved entry or waiter left the queue or the waiting list (held time is not ageing time). */
  takenAt?: number;
  entry?: SavedQueueEntry;
  waiter?: SavedWaiter;
  /** The change was requested or fronted while held: a release admits it. `watcher` = only the watcher asked. */
  wanted?: 'explicit' | 'watcher';
  /** The one reminder for this hold was raised. */
  reminded?: true;
  /** A release is in progress: written before the change is placed, cleared once it is durably placed. */
  releasing?: { by: string; at: number; tries?: number };
}

export interface OperatorFront {
  /** A rising number: the highest goes first. */
  order: number;
  by: string;
  reason: string;
  at: number;
  /** "front, admitting": written before a change that is not queued is admitted. */
  admitting?: true;
  tries?: number;
}

export interface OperatorRecord {
  pr: number;
  hold?: OperatorHold;
  front?: OperatorFront;
}

interface OperatorFile {
  v: 1;
  savedAt: number;
  nextOrder: number;
  /** Changes admitted over the cap by a front or a release (counted only while they are queued). */
  overCap: number[];
  /** When this machine told the operating session that it no longer holds the lease; absent = not told. */
  leaseNoticeAt?: number;
  records: OperatorRecord[];
}

/** What the last load found. `ok` and `absent` need no report. */
export type OperatorLoadReport =
  | { status: 'absent' | 'ok' }
  | { status: 'restored-from-previous'; holds: Array<{ pr: number; reason: string }>; fronted: number[] }
  | { status: 'lost' };

// ── pure helpers ───────────────────────────────────────────────────────

/** One line, trimmed. Null when empty or longer than `max` (a too-long value is refused, never cut). */
export function cleanLabel(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\r\n\t]+/g, ' ').trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

/** The largest time a JavaScript Date can hold (plus or minus this many milliseconds from 1970). */
export const MAX_TIME_MS = 8.64e15;

/** A millisecond time a Date can hold: a finite number after 1970 and inside the Date range. */
export function isValidTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_TIME_MS;
}

/** A time as ISO text, or null when it is not a time a Date can hold. Never throws. */
export function safeIso(ms: unknown): string | null {
  return isValidTime(ms) ? new Date(ms).toISOString() : null;
}

/**
 * `until`: an ISO date or a millisecond time. Undefined when absent, null when present but not
 * a date a Date can hold (a number such as 1e300 is refused: it cannot be shown or audited).
 */
export function parseUntil(v: unknown): number | undefined | null {
  if (v === undefined || v === null) return undefined;
  const ms = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Date.parse(v) : Number.NaN;
  return isValidTime(ms) ? ms : null;
}

/**
 * The reason as the merge-side hold stores it (`POST /green-pr-automerge/hold` and a queue
 * hold with `blockMerge` clean it the same way): no `]` or line break (they would end the
 * `[HOLD: …]` marker), at most 200 characters.
 */
export function cleanMergeHoldReason(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\]\n\r]/g, ' ').slice(0, 200) : '';
}

/** When a hold's one reminder is due: at `until`, or 24 hours after it was set when there is none. */
export function holdDueAt(h: Pick<OperatorHold, 'at' | 'until'>, limits: { reminderAfterMs: number } = OPERATOR_QUEUE_LIMITS): number {
  return h.until !== undefined ? h.until : h.at + limits.reminderAfterMs;
}

/** A hold that has passed its due time and was not reminded yet. */
export function holdReminderDue(h: Pick<OperatorHold, 'at' | 'until' | 'reminded'>, now: number): boolean {
  return h.reminded !== true && now >= holdDueAt(h);
}

/**
 * Why this process started, for the `boot` audit row: the reason of the restart request that
 * was consumed just before it, or `unknown`. A request already named by an earlier `boot` row
 * (`lastBootRestartAt`) is not this start's reason (the server died and came back by itself),
 * and neither is one consumed long ago. When a request explains the start, the row also says
 * whether it was a planned restart and whether it bypassed the holds, as the request wrote them
 * (left out when the request wrote neither, or was recorded before those fields existed).
 */
export function bootReason(
  last: { at: string; reason: string | null; requestedBy: string | null; plannedRestart?: boolean | null; bypassHolds?: boolean | null } | null,
  lastBootRestartAt: string | null,
  now: number,
  maxAgeMs: number = 15 * 60_000,
): { reason: string; requestedBy?: string; restartAt?: string; plannedRestart?: boolean; bypassHolds?: boolean } {
  if (!last || typeof last.at !== 'string') return { reason: 'unknown' };
  const at = Date.parse(last.at);
  if (!Number.isFinite(at) || at > now + 5_000 || now - at > maxAgeMs || last.at === lastBootRestartAt) return { reason: 'unknown' };
  return {
    reason: last.reason && last.reason.trim() ? last.reason.trim().slice(0, 200) : 'unknown',
    ...(last.requestedBy ? { requestedBy: last.requestedBy.slice(0, 200) } : {}),
    restartAt: last.at,
    ...(typeof last.plannedRestart === 'boolean' ? { plannedRestart: last.plannedRestart } : {}),
    ...(typeof last.bypassHolds === 'boolean' ? { bypassHolds: last.bypassHolds } : {}),
  };
}

const count = (v: unknown, max = 1_000_000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const optional = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || ok(v);

/**
 * A saved queue entry from disk, checked field by field (type and range) and rebuilt from the
 * known fields only. Null when any field is wrong: the entry goes back into a live queue, so a
 * bad one is never repaired. The hold that carried it stays in force without it.
 */
export function parseSavedEntry(e: unknown): SavedQueueEntry | null {
  const x = e as Record<string, unknown> | null;
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const ok = isValidSha(x.headSha as string) && isValidSha(x.baseSha as string)
    // The check the record validator applies to `baseRefName`: any branch a queued entry can carry round-trips.
    && isValidBaseRef(x.baseRefName)
    && isValidTime(x.firstQueuedAt) && count(x.attempts, 10_000) && count(x.errorRetries, 10_000) && typeof x.starvedRaised === 'boolean'
    && optional(x.firstRefusedAt, isValidTime)
    && optional(x.pausedMs, (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIME_MS)
    && optional(x.baseResolvedAt, isValidTime)
    && optional(x.interruptions, (v) => count(v, 10_000))
    && optional(x.resumeFirst, (v) => v === true)
    && optional(x.priority, (v) => v === 0 || v === 10)
    && optional(x.remoteAttempts, (v) => count(v, 10_000))
    && optional(x.preflightBypassRetry, (v) => v === true)
    && optional(x.preflightRediscoverable, (v) => v === true);
  if (!ok) return null;
  return {
    headSha: x.headSha as string, baseSha: x.baseSha as string, baseRefName: x.baseRefName as string,
    ...(isValidTime(x.firstObservedAt) ? { firstObservedAt: x.firstObservedAt as number } : {}),
    firstQueuedAt: x.firstQueuedAt as number, attempts: x.attempts as number, errorRetries: x.errorRetries as number, starvedRaised: x.starvedRaised as boolean,
    ...(x.firstRefusedAt !== undefined ? { firstRefusedAt: x.firstRefusedAt as number } : {}),
    ...(x.pausedMs !== undefined ? { pausedMs: x.pausedMs as number } : {}),
    ...(x.baseResolvedAt !== undefined ? { baseResolvedAt: x.baseResolvedAt as number } : {}),
    ...(x.interruptions !== undefined ? { interruptions: x.interruptions as number } : {}),
    ...(x.resumeFirst === true ? { resumeFirst: true as const } : {}),
    ...(x.priority !== undefined ? { priority: x.priority as number } : {}),
    ...(x.remoteAttempts !== undefined ? { remoteAttempts: x.remoteAttempts as number } : {}),
    ...(x.preflightBypassRetry === true ? { preflightBypassRetry: true as const } : {}),
    ...(x.preflightRediscoverable === true ? { preflightRediscoverable: true as const } : {}),
  };
}

function parseWaiter(w: unknown): SavedWaiter | null {
  const x = w as Record<string, unknown> | null;
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  if (!isValidTime(x.firstRefusedAt) || !isValidTime(x.lastOfferedAt) || !count(x.refusals) || (x.refusals as number) < 1) return null;
  return { firstRefusedAt: x.firstRefusedAt, lastOfferedAt: x.lastOfferedAt, refusals: x.refusals as number };
}

/** What re-validation left out of a stored record: a whole hold or front mark, or only what a hold had saved. */
export interface OperatorRecordIssue {
  pr: number | null;
  what: 'record-dropped' | 'hold-dropped' | 'front-dropped' | 'saved-entry-dropped' | 'saved-waiter-dropped';
}

/**
 * One stored record, re-validated field by field (the file is data on disk), with what was
 * left out. A hold whose who, why or times are wrong is dropped whole. A hold whose saved
 * queue entry or waiting-list place is malformed is KEPT without it: the change stays held,
 * and a release then goes by the `wanted` mark or requests nothing. A front mark with a wrong
 * field is dropped.
 */
export function inspectOperatorRecord(v: unknown): { record: OperatorRecord | null; issues: OperatorRecordIssue[] } {
  const x = v as { pr?: unknown; hold?: Record<string, unknown>; front?: Record<string, unknown> } | null;
  if (!x || typeof x !== 'object' || !isValidPr(x.pr as number)) return { record: null, issues: [{ pr: null, what: 'record-dropped' }] };
  const pr = x.pr as number;
  const issues: OperatorRecordIssue[] = [];
  const out: OperatorRecord = { pr };
  const h = x.hold;
  if (h !== undefined && h !== null) {
    const isObj = typeof h === 'object' && !Array.isArray(h);
    const by = isObj ? cleanLabel(h.by, OPERATOR_QUEUE_LIMITS.byChars) : null;
    const reason = isObj ? cleanLabel(h.reason, OPERATOR_QUEUE_LIMITS.reasonChars) : null;
    const rel = isObj ? h.releasing as { by?: unknown; at?: unknown; tries?: unknown } | undefined : undefined;
    const valid = isObj && !!by && !!reason && isValidTime(h.at)
      && optional(h.until, isValidTime) && optional(h.takenAt, isValidTime)
      && optional(h.wanted, (w) => w === 'explicit' || w === 'watcher')
      && optional(h.reminded, (r) => r === true)
      && (rel === undefined || (!!rel && typeof rel === 'object' && isValidTime(rel.at) && optional(rel.tries, (t) => count(t, 10_000))));
    if (valid && by && reason) {
      const entry = h.entry === undefined ? undefined : parseSavedEntry(h.entry);
      const waiter = h.waiter === undefined ? undefined : parseWaiter(h.waiter);
      if (entry === null) issues.push({ pr, what: 'saved-entry-dropped' });
      if (waiter === null) issues.push({ pr, what: 'saved-waiter-dropped' });
      out.hold = {
        by, reason, at: h.at as number,
        ...(h.until !== undefined ? { until: h.until as number } : {}),
        ...(h.takenAt !== undefined ? { takenAt: h.takenAt as number } : {}),
        ...(entry ? { entry } : {}),
        ...(waiter ? { waiter } : {}),
        ...(h.wanted === 'explicit' || h.wanted === 'watcher' ? { wanted: h.wanted } : {}),
        ...(h.reminded === true ? { reminded: true as const } : {}),
        ...(rel ? { releasing: { by: cleanLabel(rel.by, OPERATOR_QUEUE_LIMITS.byChars) ?? 'unknown', at: rel.at as number, ...(rel.tries !== undefined ? { tries: rel.tries as number } : {}) } } : {}),
      };
    } else issues.push({ pr, what: 'hold-dropped' });
  }
  const f = x.front;
  if (f !== undefined && f !== null) {
    const isObj = typeof f === 'object' && !Array.isArray(f);
    const by = isObj ? cleanLabel(f.by, OPERATOR_QUEUE_LIMITS.byChars) : null;
    const reason = isObj ? cleanLabel(f.reason, OPERATOR_QUEUE_LIMITS.reasonChars) : null;
    if (isObj && by && reason && Number.isSafeInteger(f.order) && (f.order as number) > 0 && isValidTime(f.at)
      && optional(f.admitting, (a) => a === true) && optional(f.tries, (t) => count(t, 10_000))) {
      out.front = {
        order: f.order as number, by, reason, at: f.at as number,
        ...(f.admitting === true ? { admitting: true as const } : {}),
        ...(f.tries !== undefined ? { tries: f.tries as number } : {}),
      };
    } else issues.push({ pr, what: 'front-dropped' });
  }
  return { record: out.hold || out.front ? out : null, issues };
}

/** The usable part of one stored record; null when nothing valid remains. See `inspectOperatorRecord`. */
export function parseOperatorRecord(v: unknown): OperatorRecord | null {
  return inspectOperatorRecord(v).record;
}

function parseFile(text: string): (OperatorFile & { issues: OperatorRecordIssue[] }) | null {
  let o: Partial<OperatorFile> | null = null;
  try { o = JSON.parse(text) as Partial<OperatorFile>; } catch { return null; } // @silent-fallback-ok: the caller falls back to the previous copy and reports it
  if (!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.records)) return null;
  const records: OperatorRecord[] = [];
  const seen = new Set<number>();
  const issues: OperatorRecordIssue[] = [];
  for (const raw of o.records) {
    const { record: r, issues: found } = inspectOperatorRecord(raw);
    issues.push(...found);
    if (!r || seen.has(r.pr)) continue;
    seen.add(r.pr);
    records.push(r);
  }
  const maxOrder = records.reduce((m, r) => Math.max(m, r.front?.order ?? 0), 0);
  return {
    v: 1,
    savedAt: Number.isFinite(o.savedAt) ? (o.savedAt as number) : 0,
    nextOrder: Math.max(Number.isSafeInteger(o.nextOrder) ? (o.nextOrder as number) : 1, maxOrder + 1),
    overCap: Array.isArray(o.overCap) ? o.overCap.filter((p): p is number => isValidPr(p)).slice(0, 50) : [],
    ...(isValidTime(o.leaseNoticeAt) ? { leaseNoticeAt: o.leaseNoticeAt } : {}),
    records: records.slice(0, OPERATOR_QUEUE_LIMITS.maxRecords),
    issues: issues.slice(0, 2 * OPERATOR_QUEUE_LIMITS.maxRecords),
  };
}

// ── the store ──────────────────────────────────────────────────────────

export class OperatorQueueStore {
  private readonly byPr = new Map<number, OperatorRecord>();
  private nextOrder = 1;
  private readonly overCap = new Set<number>();
  private leaseNoticeAt: number | null = null;
  private loaded = false;
  private lastJson: string | null = null;
  private report: OperatorLoadReport = { status: 'absent' };
  private issues: OperatorRecordIssue[] = [];

  constructor(
    private readonly file: string,
    private readonly now: () => number,
    private readonly audit: (e: Record<string, unknown>) => void,
  ) {}

  get path(): string { return this.file; }
  get previousPath(): string { return `${this.file}.prev`; }

  /**
   * Read the file once (idempotent). An unreadable file falls back to the previous good copy;
   * the unreadable one is moved aside so the evidence survives and the next write starts clean.
   */
  load(): OperatorLoadReport {
    if (this.loaded) return this.report;
    this.loaded = true;
    const read = (p: string): string | null => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } }; // @silent-fallback-ok: absent reads as absent; the caller decides between "never written" and "lost"
    const text = read(this.file);
    const prevText = read(this.previousPath);
    if (text === null && prevText === null) { this.report = { status: 'absent' }; return this.report; }
    const main = text === null ? null : parseFile(text);
    if (main) {
      this.adopt(main);
      // Records that failed re-validation were left out: the file is rewritten without them, so they are reported once.
      if (main.issues.length) this.persist(); else this.lastJson = JSON.stringify(this.body(0));
      this.report = { status: 'ok' };
      return this.report;
    }
    if (text !== null) {
      const aside = `${this.file}.corrupt-${this.now()}`;
      try { fs.renameSync(this.file, aside); } catch { /* @silent-fallback-ok: reported below either way */ }
    }
    const prev = prevText === null ? null : parseFile(prevText);
    if (prev) {
      this.adopt(prev);
      this.report = {
        status: 'restored-from-previous',
        holds: this.held().map((r) => ({ pr: r.pr, reason: r.hold!.reason })),
        fronted: this.fronted().map((r) => r.pr),
      };
      this.persist(); // the restored copy becomes the file again
      return this.report;
    }
    // Neither copy can be read. The unreadable previous copy is moved aside too and the empty
    // state is written once, so the loss is reported by this start only, not by every later one.
    if (prevText !== null) {
      try { fs.renameSync(this.previousPath, `${this.previousPath}.corrupt-${this.now()}`); } catch { /* @silent-fallback-ok: reported as lost either way */ }
    }
    this.report = { status: 'lost' };
    this.persist();
    return this.report;
  }

  private adopt(f: OperatorFile & { issues?: OperatorRecordIssue[] }): void {
    // What failed re-validation is left out, written down per pull request, and kept for the service to report.
    this.issues = f.issues ?? [];
    for (const i of this.issues) this.audit({ event: 'operator-file-invalid-record', pr: i.pr, what: i.what });
    this.byPr.clear();
    for (const r of f.records) this.byPr.set(r.pr, r);
    this.nextOrder = f.nextOrder;
    this.overCap.clear();
    for (const p of f.overCap) this.overCap.add(p);
    this.leaseNoticeAt = f.leaseNoticeAt ?? null;
  }

  /** What the load left out of the file it read (a lost hold, or a hold that lost what it had saved). */
  loadIssues(): OperatorRecordIssue[] { this.load(); return [...this.issues]; }

  /** What the load found; the service reports it once the controls are on. */
  loadReport(): OperatorLoadReport { this.load(); return this.report; }

  // ---- reads ----

  get(pr: number): OperatorRecord | null { this.load(); return this.byPr.get(pr) ?? null; }
  size(): number { this.load(); return this.byPr.size; }
  records(): OperatorRecord[] { this.load(); return [...this.byPr.values()]; }

  /** Held now: a hold that is not being released. */
  isHeld(pr: number): boolean {
    const h = this.get(pr)?.hold;
    return !!h && !h.releasing;
  }

  /** Every record with a hold (a release in progress included), oldest hold first. */
  held(): OperatorRecord[] {
    return this.records().filter((r) => !!r.hold).sort((a, b) => (a.hold!.at - b.hold!.at) || (a.pr - b.pr));
  }

  /** The fronted changes, most recently fronted first. */
  fronted(): OperatorRecord[] {
    return this.records().filter((r) => !!r.front).sort((a, b) => b.front!.order - a.front!.order);
  }

  /** The front mark's number for a change, or 0. */
  frontOrder(pr: number): number { return this.get(pr)?.front?.order ?? 0; }

  anyFront(): boolean { this.load(); for (const r of this.byPr.values()) if (r.front) return true; return false; }
  anyHold(): boolean { this.load(); for (const r of this.byPr.values()) if (r.hold) return true; return false; }

  hasRoomFor(pr: number): boolean { this.load(); return this.byPr.has(pr) || this.byPr.size < OPERATOR_QUEUE_LIMITS.maxRecords; }

  // ---- writes (in memory; `persist()` makes them durable) ----

  /** The record for a change, created when absent. */
  ensure(pr: number): OperatorRecord {
    this.load();
    let r = this.byPr.get(pr);
    if (!r) { r = { pr }; this.byPr.set(pr, r); }
    return r;
  }

  /** The next front number (rising; never reused). */
  takeOrder(): number { this.load(); return this.nextOrder++; }

  /** Remove the hold; the record goes when nothing else is on it. */
  clearHold(pr: number): void {
    const r = this.get(pr);
    if (!r) return;
    delete r.hold;
    if (!r.front) this.byPr.delete(pr);
  }

  clearFront(pr: number): void {
    const r = this.get(pr);
    if (!r) return;
    delete r.front;
    if (!r.hold) this.byPr.delete(pr);
  }

  /** Forget a change (closed or merged). True when there was a record. */
  drop(pr: number): boolean {
    this.load();
    this.overCap.delete(pr);
    return this.byPr.delete(pr);
  }

  /** Put back a record exactly as it was (the revert of a write that could not be made durable). */
  restore(pr: number, before: OperatorRecord | null): void {
    this.load();
    if (before) this.byPr.set(pr, before); else this.byPr.delete(pr);
  }

  /** A deep copy of a record, for `restore()`. */
  copyOf(pr: number): OperatorRecord | null {
    const r = this.get(pr);
    return r ? JSON.parse(JSON.stringify(r)) as OperatorRecord : null;
  }

  // ---- the operator overflow ----

  markOverCap(pr: number): void { this.load(); this.overCap.add(pr); }
  unmarkOverCap(pr: number): void { this.load(); this.overCap.delete(pr); }
  /** How many places of the overflow are in use: entries admitted over the cap that are still queued. */
  overflowUsed(queued: ReadonlySet<number>): number {
    this.load();
    for (const p of [...this.overCap]) if (!queued.has(p)) this.overCap.delete(p);
    return this.overCap.size;
  }
  /** Entries admitted over the cap as last written (boot reads this before the queue is restored). */
  overCapCount(): number { this.load(); return this.overCap.size; }

  // ---- the lease notice ----

  leaseNoticeSentAt(): number | null { this.load(); return this.leaseNoticeAt; }
  setLeaseNotice(at: number | null): void { this.load(); this.leaseNoticeAt = at; }

  private body(savedAt: number): OperatorFile {
    return {
      v: 1, savedAt, nextOrder: this.nextOrder,
      overCap: [...this.overCap].sort((a, b) => a - b),
      ...(this.leaseNoticeAt !== null ? { leaseNoticeAt: this.leaseNoticeAt } : {}),
      records: [...this.byPr.values()].sort((a, b) => a.pr - b.pr),
    };
  }

  /**
   * Atomic write: a temporary file, then a rename. Before the rename the current file is
   * copied beside it as the previous good copy. False when the write failed (audited).
   */
  persist(): boolean {
    this.load();
    // Compared without the write time, so an unchanged store is not rewritten.
    const json = JSON.stringify(this.body(this.now()));
    const comparable = JSON.stringify(this.body(0));
    if (comparable === this.lastJson) return true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, json, { mode: 0o600 }); /* state-registry: local-verify-operator-queue */
      if (fs.existsSync(this.file)) {
        const prevTmp = `${this.previousPath}.tmp`;
        fs.copyFileSync(this.file, prevTmp); /* state-registry: local-verify-operator-queue */
        fs.renameSync(prevTmp, this.previousPath);
      }
      fs.renameSync(tmp, this.file);
      this.lastJson = comparable;
      return true;
    } catch (e) {
      this.audit({ event: 'operator-file-write-failed', detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }
}

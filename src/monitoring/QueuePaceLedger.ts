/**
 * QueuePaceLedger — the hourly measurement service (docs/specs/queue-pace.md §1, §2, notices).
 *
 * Each hour, for every registered queue adapter, it reads the owner's events since a durable
 * cursor plus the open id set under one read boundary, reconciles them id-by-id against the
 * previous id set, and appends ONE row for the fixed hour `[from, to)` to logs/queue-pace.jsonl.
 * Crash-safe commit: the row (carrying `cursorAfter` + `idsDigest`, identified by
 * (machineId, queue, from)) is appended and fsynced FIRST; only then is
 * state/queue-pace/<queue>.json atomically replaced. On boot a row newer than the state file
 * restores the cursor from the row; a digest mismatch forces the next row to be a baseline.
 *
 * After writing, it evaluates each queue's verdict (with hysteresis), its bottleneck, and the
 * notice state. It never writes to an owner store, never calls an LLM, and never acts — the
 * only acting part is the tuner (QueuePaceTuner.ts), which reads this ledger's evaluations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import {
  COMPACT_AFTER_MS, DAY_MS, FEEDBACK_QUEUES, HOUR_MS, INITIAL_HYSTERESIS, INITIAL_NOTICE, MAX_IDS, QUEUE_LABELS,
  QUEUE_PACE_SCHEMA, RETAIN_DAILY_MS, WINDOW_MS,
  applyHysteresis, classifyVerdict, coverageSufficient, daysToClear, decideNotice, evaluateBottleneck, floorHour,
  hourlyWindow, idsDigest, maturationSteps, perDay, projectDailyCalls, reconcileInterval, rowIdentity, steppedWindow,
  type Bottleneck, type ExecutorFacts, type HysteresisState, type IntervalRow, type NoticeAction, type NoticeState,
  type PaceEvent, type QueueId, type ReviewSnapshot, type TickRow, type Verdict, type VerdictResult, type WindowSummary,
} from './QueuePace.js';

// ── Config ───────────────────────────────────────────────────────────────────

export interface QueuePaceConfig {
  enabled?: boolean;
  tuner?: { enabled?: boolean; dryRun?: boolean; minGapMinutes?: number; maxExtraRunsPerDay?: number };
  notices?: { dryRun?: boolean };
}

export function queuePaceConfig(config: unknown): QueuePaceConfig {
  return ((config as { queuePace?: QueuePaceConfig } | null)?.queuePace) ?? {};
}

/** The measure-only dev gate (DEV_GATED_FEATURES: queuePace), resolved on every tick. */
export function isQueuePaceEnabled(config: unknown): boolean {
  return resolveDevAgentGate(queuePaceConfig(config).enabled, config as { developmentAgent?: boolean });
}

// ── Adapters ─────────────────────────────────────────────────────────────────

export type AdapterRead =
  | {
    ok: true; mode: 'hourly';
    events: PaceEvent[]; openIds: string[];
    /** Opaque cursor stored with the row and restored on the next read. */
    cursorAfter: unknown;
    snapshotDerivedArrivals?: boolean; snapshotDerivedExits?: boolean;
    context?: Record<string, number>;
  }
  | { ok: true; mode: 'stepped'; reviews: ReviewSnapshot[] }
  | { ok: false; reason: string; /** A confirmed absence (e.g. no reviews on this machine): no row, no queue. */ absent?: boolean };

export interface QueueAdapter {
  queue: QueueId;
  /** Stepped per review (maturation.fix) instead of hourly. */
  stepped?: boolean;
  /** Read events since `cursor` and the open id set under ONE read boundary. */
  read(cursor: unknown, now: number): AdapterRead | Promise<AdapterRead>;
  /** Feedback queues: the same predicate the server uses to start feedback ticks. */
  ownerServing?(): boolean;
}

/**
 * Generic read boundary for owners without a transaction: take a watermark, read, take it
 * again; a moved watermark means an event landed mid-read → retry once, else `read-race`.
 */
export async function readUnderBoundary<T>(watermark: () => unknown | Promise<unknown>, read: () => T | Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: 'read-race' }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = JSON.stringify(await watermark());
    const value = await read();
    const after = JSON.stringify(await watermark());
    if (before === after) return { ok: true, value };
  }
  return { ok: false, reason: 'read-race' };
}

// ── Files ────────────────────────────────────────────────────────────────────

function appendDurable(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function readJsonl<T>(file: string): T[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; } // @silent-fallback-ok: a missing log is an empty history; the ledger re-baselines
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* @silent-fallback-ok: a torn last line from a crash is skipped; the row identity rule makes a rewrite safe */ }
  }
  return out;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } // @silent-fallback-ok: missing/corrupt state → caller fails toward baseline (ledger) or closed (tuner)
}

// ── Tick log (server-written tick/refusal/admission rows) ───────────────────

/**
 * logs/queue-pace-ticks.jsonl. Written only in-process by the triage service and the executor,
 * only while queuePace resolves enabled. A cooperative boundary, not a security one: the worst a
 * forged row can do is trigger extra ticks, each of which still passes every service gate.
 */
export class QueuePaceTickLog {
  private rows: TickRow[] = [];
  private lastCompactDay = -1;

  constructor(private readonly file: string, private readonly enabled: () => boolean, private readonly clock: () => number = Date.now) {
    this.rows = readJsonl<TickRow & { kind: string }>(file).filter((r) => r && typeof r.at === 'number');
  }

  append(row: Omit<TickRow, 'at'> & { at?: number }): void {
    if (!this.enabled()) return;
    const full = { ...row, at: row.at ?? this.clock() } as TickRow;
    try {
      appendDurable(this.file, JSON.stringify(full) + '\n');
      this.rows.push(full);
    } catch (error) { // @silent-fallback-ok: a tick row is evidence only; a lost row makes the bottleneck read unknown, which only stops the tuner
      console.warn('[queue-pace] tick row append failed:', error instanceof Error ? error.message : error);
    }
  }

  /** Rows (tick/refused/admission) at or after `since`. */
  since(since: number): TickRow[] { return this.rows.filter((r) => r.at >= since && r.kind !== ('daily' as TickRow['kind'])); }

  byRunId(runId: string): TickRow | null {
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i].runId === runId && this.rows[i].kind === 'tick') return this.rows[i];
    return null;
  }

  /** Compact rows older than 14 d to daily counts; drop daily rows older than 90 d. */
  compact(now = this.clock()): void {
    const day = Math.floor(now / DAY_MS);
    if (day === this.lastCompactDay) return;
    this.lastCompactDay = day;
    const cut = now - COMPACT_AFTER_MS;
    if (!this.rows.some((r) => r.at < cut)) return;
    const keep: Array<TickRow | Record<string, unknown>> = [];
    const daily = new Map<string, { at: number; source: string; kind: 'daily'; ticks: number; refusals: Record<string, number> }>();
    for (const r of this.rows as Array<TickRow & { refusals?: Record<string, number>; ticks?: number }>) {
      if ((r.kind as string) === 'daily') { if (r.at >= now - RETAIN_DAILY_MS) keep.push(r); continue; }
      if (r.at >= cut) { keep.push(r); continue; }
      const d = Math.floor(r.at / DAY_MS) * DAY_MS;
      if (d < now - RETAIN_DAILY_MS) continue;
      const key = `${d}|${r.source}`;
      const cur = daily.get(key) ?? { at: d, source: r.source, kind: 'daily' as const, ticks: 0, refusals: {} };
      if (r.kind === 'tick') cur.ticks++;
      const reason = r.kind === 'tick' ? r.stopReason : r.kind === 'admission' ? r.admission : r.reason;
      if (reason) cur.refusals[reason] = (cur.refusals[reason] ?? 0) + 1;
      daily.set(key, cur);
    }
    const all = [...daily.values(), ...keep].sort((a, b) => Number((a as { at: number }).at) - Number((b as { at: number }).at));
    try {
      writeAtomic(this.file, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''));
      this.rows = all as TickRow[];
    } catch (error) { // @silent-fallback-ok: compaction retries the next day; the file only grows meanwhile
      console.warn('[queue-pace] tick log compaction failed:', error instanceof Error ? error.message : error);
    }
  }
}

// ── Ledger ───────────────────────────────────────────────────────────────────

interface QueueState { cursor: unknown; ids: string[] | null; lastFrom: number | null; idsDigest: string | null }

export interface QueueEvaluation {
  queue: QueueId;
  at: number;
  hysteresis: HysteresisState;
  raw: VerdictResult;
  bottleneck: Bottleneck | null;
  /** Consecutive evaluations reading falling-behind with a worker bottleneck (tuner step-up). */
  workerEvaluations: number;
  notice: NoticeState;
  /** Shadow notice state used while notices are in dry-run, so a dry-run "would raise" never marks
   *  the live state open (the first live raise after the flip still fires). */
  noticeDry?: NoticeState;
}

export interface TunerView { state: string; extraRunsToday: number; cooldownUntil: number | null; enabled: boolean; dryRun: boolean; atMax: boolean }

export interface AttentionPort {
  raise(item: { id: string; conditionKey: string; title: string; summary: string; description: string; category: string; priority: 'NORMAL' | 'LOW'; sourceContext: string }): Promise<void>;
  clear(conditionKey: string, resolution: string): void;
}

export interface QueuePaceLedgerOptions {
  stateDir: string;
  machineId: string;
  config: () => unknown;
  adapters: QueueAdapter[];
  ticks: QueuePaceTickLog | null;
  /** Executor facts for the person/cap detail (feedback.fix), read at evaluation time. */
  executorFacts?: () => ExecutorFacts | null;
  /** Triage call accounting for the projected-cap check (feedback.triage). */
  triageCalls?: () => { callsUsedToday: number | null; maxCallsPerDay: number | null } | null;
  /** Extra ticks the tuner may still add today (projection input). */
  extraTicksAllowed?: () => number;
  tunerView?: () => TunerView | null;
  attention?: AttentionPort | null;
  /** Context only: reports/day reaching the canonical store. */
  feedbackReportsPerDay?: () => number | null;
  clock?: () => number;
}

export class QueuePaceLedger {
  private readonly file: string;
  private readonly stateDir: string;
  private readonly evalFile: string;
  private readonly noticeLog: string;
  private rows: IntervalRow[] = [];
  private readonly identities = new Set<string>();
  private evaluations = new Map<QueueId, QueueEvaluation>();
  private absent = new Set<QueueId>();
  private lastContext: { feedbackReportsPerDay: number | null } = { feedbackReportsPerDay: null };
  private running = false;
  private lastCompactDay = -1;
  private readonly now: () => number;

  constructor(private readonly opts: QueuePaceLedgerOptions) {
    this.now = opts.clock ?? Date.now;
    this.file = path.join(opts.stateDir, 'logs', 'queue-pace.jsonl');
    this.noticeLog = path.join(opts.stateDir, 'logs', 'queue-pace-notices.jsonl');
    this.stateDir = path.join(opts.stateDir, 'state', 'queue-pace');
    this.evalFile = path.join(this.stateDir, 'evaluations.json');
    for (const r of readJsonl<IntervalRow>(this.file)) {
      if (!r || r.schema !== QUEUE_PACE_SCHEMA) continue;
      const id = rowIdentity(r);
      if (this.identities.has(id)) continue;
      this.identities.add(id);
      this.rows.push(r);
    }
    const saved = readJson<Record<string, QueueEvaluation>>(this.evalFile);
    if (saved) for (const [q, e] of Object.entries(saved)) if (e && e.hysteresis) this.evaluations.set(q as QueueId, e);
  }

  get adapters(): QueueAdapter[] { return this.opts.adapters; }
  get machineId(): string { return this.opts.machineId; }

  enabled(): boolean { return isQueuePaceEnabled(this.opts.config()); }

  rowsFor(queue: QueueId, since = 0): IntervalRow[] {
    return this.rows.filter((r) => r.queue === queue && r.machineId === this.opts.machineId && r.to > since);
  }

  evaluation(queue: QueueId): QueueEvaluation | null { return this.evaluations.get(queue) ?? null; }

  private statePath(queue: QueueId): string { return path.join(this.stateDir, `${queue}.json`); }

  /** The persisted state, reconciled with the ledger file (crash between row and state). */
  private loadState(queue: QueueId): QueueState | null {
    const state = readJson<QueueState>(this.statePath(queue));
    // Only rows that advanced the state (a successful read: ok, baseline, count-drift) are a
    // recovery point; a failed read leaves the cursor where it was and its hour stays a gap.
    const last = this.rowsFor(queue).filter((r) => r.kind === 'interval' && (r.ok || r.reason === 'baseline' || r.reason === 'count-drift'))
      .sort((a, b) => b.from - a.from)[0];
    if (!last) return state;
    if (!state || state.lastFrom === null || last.from > state.lastFrom) {
      const digestOk = state?.ids ? idsDigest(state.ids) === last.idsDigest : false;
      return { cursor: last.cursorAfter ?? null, ids: digestOk ? state!.ids : null, lastFrom: last.from, idsDigest: last.idsDigest ?? null };
    }
    return state;
  }

  private appendRow(row: IntervalRow): boolean {
    const id = rowIdentity(row);
    if (this.identities.has(id)) return false; // a repeated append of the same identity is ignored
    appendDurable(this.file, JSON.stringify(row) + '\n');
    this.identities.add(id);
    this.rows.push(row);
    return true;
  }

  /** One hourly pass: write rows, then evaluate. Returns the number of rows written. */
  async tick(): Promise<number> {
    if (this.running || !this.enabled()) return 0;
    this.running = true;
    let written = 0;
    try {
      const now = this.now();
      for (const adapter of this.opts.adapters) {
        try { written += await this.measure(adapter, now); } catch (error) { // @silent-fallback-ok: logged; the hour stays uncovered and the next row is a baseline
          console.warn(`[queue-pace] ${adapter.queue} measurement failed:`, error instanceof Error ? error.message : error);
        }
      }
      // Evaluations are hourly (hysteresis and the tuner's step-up count evaluations): only when a
      // new row landed, or when nothing was ever evaluated (a restart reuses the persisted
      // evaluation so it never adds an extra hysteresis step).
      if (written > 0 || this.evaluations.size === 0) {
        try { this.lastContext = { feedbackReportsPerDay: this.opts.feedbackReportsPerDay?.() ?? null }; } catch { this.lastContext = { feedbackReportsPerDay: null }; } // @silent-fallback-ok: context number only
        await this.evaluate(now);
      }
      this.compact(now);
      this.opts.ticks?.compact(now);
    } finally {
      this.running = false;
    }
    return written;
  }

  private async measure(adapter: QueueAdapter, now: number): Promise<number> {
    const queue = adapter.queue;
    const slotTo = floorHour(now);
    const slotFrom = slotTo - HOUR_MS;
    const state = this.loadState(queue);
    if (!adapter.stepped && state && state.lastFrom === slotFrom) return 0; // this hour is already written
    const read = await adapter.read(state?.cursor ?? null, now);
    if (!read.ok && read.absent) { this.absent.add(queue); return 0; }
    this.absent.delete(queue);
    const base = { schema: QUEUE_PACE_SCHEMA, machineId: this.opts.machineId, queue } as const;

    if (read.ok && read.mode === 'stepped') {
      const steps = maturationSteps(read.reviews);
      let n = 0;
      for (const s of steps) {
        if (s.to <= now - RETAIN_DAILY_MS) continue; // past retention: never re-appended after compaction
        const row: IntervalRow = { ...base, kind: 'interval', from: s.from, to: s.to, ok: true, openStart: s.openStart, open: s.open,
          entered: s.entered, reentered: 0, completed: s.completed, exitedOther: s.exitedOther, turnover: 'complete', idsDigest: idsDigest(s.ids) };
        if (this.appendRow(row)) n++;
      }
      return n;
    }
    if (!read.ok) {
      // A failed read: no numbers, never zeros; the cursor does not move (it advances only with a written row).
      const row: IntervalRow = { ...base, kind: 'interval', from: slotFrom, to: slotTo, ok: false, reason: read.reason, cursorAfter: state?.cursor ?? null, idsDigest: state?.idsDigest ?? null };
      return this.appendRow(row) ? 1 : 0;
    }
    if (read.openIds.length > MAX_IDS) {
      const row: IntervalRow = { ...base, kind: 'interval', from: slotFrom, to: slotTo, ok: false, reason: 'too-large', cursorAfter: state?.cursor ?? null, idsDigest: state?.idsDigest ?? null };
      return this.appendRow(row) ? 1 : 0;
    }
    const snapshot = new Set(read.openIds);
    const digest = idsDigest(snapshot);
    const contiguous = state !== null && state.ids !== null && state.lastFrom === slotFrom - HOUR_MS && idsDigest(state.ids) === state.idsDigest;
    let row: IntervalRow;
    if (!contiguous) {
      // Baseline: after a gap, lost state or a fresh owner. Counts toward nothing; gap events are context only.
      const gap = state ? {
        from: (state.lastFrom ?? slotFrom) + HOUR_MS, to: slotTo,
        entered: read.events.filter((e) => e.kind === 'entered' || e.kind === 'reentered').length,
        completed: read.events.filter((e) => e.kind === 'completed').length,
        exitedOther: read.events.filter((e) => e.kind === 'exitedOther').length,
      } : undefined;
      row = { ...base, kind: 'interval', from: slotFrom, to: slotTo, ok: false, reason: 'baseline', open: snapshot.size,
        ...(gap ? { gapRecovered: gap } : {}), ...(read.context ? { context: read.context } : {}), cursorAfter: read.cursorAfter, idsDigest: digest };
    } else {
      const r = reconcileInterval({ prevIds: new Set(state!.ids!), events: read.events, snapshot,
        snapshotDerivedArrivals: read.snapshotDerivedArrivals, snapshotDerivedExits: read.snapshotDerivedExits });
      row = r.ok
        ? { ...base, kind: 'interval', from: slotFrom, to: slotTo, ok: true, openStart: r.openStart, open: r.open, entered: r.entered,
          reentered: r.reentered, completed: r.completed, exitedOther: r.exitedOther, turnover: r.turnover,
          ...(r.drift ? { drift: r.drift } : {}), ...(read.context ? { context: read.context } : {}), cursorAfter: read.cursorAfter, idsDigest: digest }
        : { ...base, kind: 'interval', from: slotFrom, to: slotTo, ok: false, reason: 'count-drift', drift: r.drift + r.unexplainedExits,
          ...(read.context ? { context: read.context } : {}), cursorAfter: read.cursorAfter, idsDigest: digest };
    }
    // Order matters: row first (fsync), then the state file. A crash in between replays from the row.
    // A row for this hour already exists (an earlier failed read): keep the cursor where it was.
    if (!this.appendRow(row)) return 0;
    writeAtomic(this.statePath(queue), JSON.stringify({ cursor: read.cursorAfter, ids: [...snapshot], lastFrom: slotFrom, idsDigest: digest } satisfies QueueState));
    return 1;
  }

  window(queue: QueueId, now = this.now()): WindowSummary {
    const rows = this.rowsFor(queue, now - WINDOW_MS - DAY_MS);
    return queue === 'maturation.fix' ? steppedWindow(this.rowsFor(queue)) : hourlyWindow(rows, now);
  }

  private ownerServing(adapter: QueueAdapter): boolean | undefined {
    if (!FEEDBACK_QUEUES.has(adapter.queue) || !adapter.ownerServing) return undefined;
    try { return adapter.ownerServing(); } catch { return false; } // @silent-fallback-ok: an unreadable ownership predicate is "not serving" (no falling-behind is inferred)
  }

  async evaluate(now = this.now()): Promise<void> {
    const ticks = this.opts.ticks?.since(now - WINDOW_MS) ?? [];
    let executor: ExecutorFacts | null = null;
    try { executor = this.opts.executorFacts?.() ?? null; } catch { executor = { ok: false, awaitingOwnerPrs: [], approverLatched: false, openPrs: 0, failedReviewPrs: 0 }; } // @silent-fallback-ok: a failed executor read → person is unknown, never assumed
    const tuner = this.opts.tunerView?.() ?? null;
    for (const adapter of this.opts.adapters) {
      const queue = adapter.queue;
      if (this.absent.has(queue)) continue;
      const w = this.window(queue, now);
      const raw = classifyVerdict(w, { ownerServing: this.ownerServing(adapter) });
      const prev = this.evaluations.get(queue);
      const hysteresis = applyHysteresis(prev?.hysteresis ?? INITIAL_HYSTERESIS, raw, now);
      let bottleneck: Bottleneck | null = null;
      if (raw.verdict === 'falling-behind' || hysteresis.shown === 'falling-behind') {
        let projection = null;
        if (queue === 'feedback.triage') {
          const calls = this.opts.triageCalls?.() ?? null;
          projection = projectDailyCalls({ callsUsedToday: calls?.callsUsedToday ?? null, maxCallsPerDay: calls?.maxCallsPerDay ?? null, ticks, now, extraTicksAllowed: this.opts.extraTicksAllowed?.() ?? 0 });
        }
        bottleneck = evaluateBottleneck({ queue, now, ticks, executor: queue === 'feedback.fix' ? executor : null, projection });
      }
      const workerNow = raw.verdict === 'falling-behind' && bottleneck?.kind === 'worker';
      const workerEvaluations = workerNow ? (prev?.workerEvaluations ?? 0) + 1 : 0;
      const owns = this.ownerServing(adapter) !== false;
      const noticesDry = queuePaceConfig(this.opts.config()).notices?.dryRun !== false || !this.opts.attention;
      const { next, action } = decideNotice({
        state: (noticesDry ? prev?.noticeDry : prev?.notice) ?? INITIAL_NOTICE, now, verdict: hysteresis.shown, bottleneck: bottleneck?.kind ?? null,
        coverageFull: coverageSufficient(w), tunerLive: Boolean(tuner?.enabled && !tuner.dryRun && queue === 'feedback.triage'),
        tunerAtMax: Boolean(tuner?.atMax), ownsQueue: owns,
      });
      this.evaluations.set(queue, {
        queue, at: now, hysteresis, raw, bottleneck, workerEvaluations,
        notice: noticesDry ? (prev?.notice ?? INITIAL_NOTICE) : next,
        noticeDry: noticesDry ? next : INITIAL_NOTICE,
      });
      await this.applyNotice(queue, action, w, bottleneck);
    }
    try { writeAtomic(this.evalFile, JSON.stringify(Object.fromEntries(this.evaluations))); } catch (error) { // @silent-fallback-ok: hysteresis restarts from unknown on the next boot
      console.warn('[queue-pace] evaluation state write failed:', error instanceof Error ? error.message : error);
    }
  }

  private async applyNotice(queue: QueueId, action: NoticeAction, w: WindowSummary, b: Bottleneck | null): Promise<void> {
    if (action.action === 'none') return;
    const key = `queue-pace:${this.opts.machineId}:${queue}`;
    const dryRun = queuePaceConfig(this.opts.config()).notices?.dryRun !== false;
    const label = QUEUE_LABELS[queue];
    const inflow = perDay(w.inflow, w), outflow = perDay(w.outflow, w);
    const audit = (extra: Record<string, unknown>) => {
      try { appendDurable(this.noticeLog, JSON.stringify({ at: this.now(), queue, conditionKey: key, action: action.action, dryRun, ...extra }) + '\n'); } catch { /* @silent-fallback-ok: notice audit only */ }
    };
    if (dryRun || !this.opts.attention) { audit({ wouldAct: true, bottleneck: b?.kind ?? null }); return; }
    try {
      if (action.action === 'raise' || action.action === 'hold-open' || action.action === 'mark-unavailable') {
        // Fixed templates only: queue label and counts, never owner-store free text.
        const why = action.action === 'raise' && action.why === 'heal-exhausted'
          ? 'Extra sorting rounds have run at their daily limit for a day and the pile is still growing.'
          : 'Sorting rounds keep running out of time and the pile has grown for a day; extra rounds are switched off, so nothing could speed it up.';
        const recurring = action.action === 'hold-open' ? ' It is back to normal for now, but this keeps recurring, so it stays open.' : '';
        const unavailable = action.action === 'mark-unavailable' ? ' Measurement is unavailable right now.' : '';
        await this.opts.attention.raise({
          id: key, conditionKey: key, title: `${label} is falling behind`,
          summary: `${label}: about ${inflow ?? '?'} a day come in and ${outflow ?? '?'} get done. ${why}${recurring}${unavailable}`,
          description: `Measured over ${w.label}. Open now: ${w.open ?? '?'}. Details: GET /queue-pace.`,
          category: 'monitoring', priority: 'NORMAL', sourceContext: 'queue-pace',
        });
        audit({ raised: true });
      } else if (action.action === 'clear') {
        this.opts.attention.clear(key, action.resolution);
        audit({ cleared: true, resolution: action.resolution });
      }
    } catch (error) { // @silent-fallback-ok: logged; the notice state is retried on the next evaluation only by its own transitions
      console.warn('[queue-pace] notice failed:', error instanceof Error ? error.message : error);
      audit({ error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    }
  }

  /** Rows older than 14 d → daily rows (ok hours only); daily rows older than 90 d dropped. */
  compact(now = this.now()): void {
    const day = Math.floor(now / DAY_MS);
    if (day === this.lastCompactDay) return;
    this.lastCompactDay = day;
    const cut = now - COMPACT_AFTER_MS;
    const hourlyOld = this.rows.filter((r) => r.kind === 'interval' && r.queue !== 'maturation.fix' && r.to <= cut);
    const dailyOld = this.rows.filter((r) => r.kind === 'daily' && r.to <= now - RETAIN_DAILY_MS);
    const steppedOld = this.rows.filter((r) => r.queue === 'maturation.fix' && r.to <= now - RETAIN_DAILY_MS);
    if (hourlyOld.length === 0 && dailyOld.length === 0 && steppedOld.length === 0) return;
    const drop = new Set([...hourlyOld, ...dailyOld, ...steppedOld]);
    const daily = new Map<string, IntervalRow>();
    for (const r of hourlyOld) {
      const from = Math.floor(r.from / DAY_MS) * DAY_MS;
      if (from + DAY_MS <= now - RETAIN_DAILY_MS) continue;
      const k = `${r.machineId}|${r.queue}|${from}`;
      const d = daily.get(k) ?? { schema: QUEUE_PACE_SCHEMA, kind: 'daily', machineId: r.machineId, queue: r.queue, from, to: from + DAY_MS, ok: true,
        entered: 0, reentered: 0, completed: 0, exitedOther: 0, okHours: 0 } as IntervalRow;
      if (r.ok) {
        d.entered! += r.entered ?? 0; d.reentered! += r.reentered ?? 0; d.completed! += r.completed ?? 0; d.exitedOther! += r.exitedOther ?? 0;
        d.okHours! += 1;
        if (d.openStart === undefined) d.openStart = r.openStart;
        d.open = r.open;
      }
      daily.set(k, d);
    }
    const kept = this.rows.filter((r) => !drop.has(r));
    // Merge into an existing daily row for the same day (a day compacted in two passes).
    for (const d of daily.values()) {
      const existing = kept.find((r) => r.kind === 'daily' && rowIdentity(r) === rowIdentity(d));
      if (existing) {
        existing.entered! += d.entered!; existing.reentered! += d.reentered!; existing.completed! += d.completed!; existing.exitedOther! += d.exitedOther!;
        existing.okHours = (existing.okHours ?? 0) + (d.okHours ?? 0); existing.open = d.open ?? existing.open;
      } else kept.push(d);
    }
    kept.sort((a, b) => a.from - b.from);
    try {
      writeAtomic(this.file, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
      this.rows = kept;
      this.identities.clear();
      for (const r of kept) this.identities.add(rowIdentity(r));
    } catch (error) { // @silent-fallback-ok: compaction retries the next day
      console.warn('[queue-pace] ledger compaction failed:', error instanceof Error ? error.message : error);
    }
  }

  /** The GET /queue-pace body for this machine. */
  view(now = this.now()): QueuePaceView {
    const tuner = this.opts.tunerView?.() ?? null;
    const queues: QueuePaceQueueView[] = [];
    for (const adapter of this.opts.adapters) {
      const queue = adapter.queue;
      if (this.absent.has(queue)) continue;
      // A stepped queue (maturation.fix) never measured here may simply not live on this machine.
      if (adapter.stepped && this.rowsFor(queue).length === 0) continue;
      const w = this.window(queue, now);
      const ev = this.evaluations.get(queue) ?? null;
      const verdict: Verdict = ev?.hysteresis.shown ?? 'unknown';
      const bottleneck = ev?.bottleneck && (verdict === 'falling-behind' || ev.raw.verdict === 'falling-behind') ? ev.bottleneck : null;
      const last = this.rowsFor(queue).filter((r) => r.kind === 'interval').sort((a, b) => b.from - a.from)[0] ?? null;
      const lastOk = this.rowsFor(queue).filter((r) => r.kind === 'interval' && (r.ok || r.reason === 'baseline') && r.open !== undefined).sort((a, b) => b.from - a.from)[0] ?? null;
      queues.push({
        id: queue, label: QUEUE_LABELS[queue], machineId: this.opts.machineId,
        verdict, rawVerdict: ev?.raw.verdict ?? 'unknown', verdictReason: ev?.raw.reason ?? null,
        inflowPerDay: perDay(w.inflow, w), outflowPerDay: perDay(w.outflow, w), exitedPerDay: perDay(w.exited, w),
        open: lastOk?.open ?? null,
        daysToClear: daysToClear(verdict, w, bottleneck?.kind ?? null),
        bottleneck: bottleneck ? { kind: bottleneck.kind, matched: bottleneck.matched, detail: bottleneck.detail, count: bottleneck.count, history: bottleneck.history,
          ...(bottleneck.prs ? { prs: bottleneck.prs } : {}), ...(bottleneck.approverLatched !== undefined ? { approverLatched: bottleneck.approverLatched } : {}),
          ...(bottleneck.repo ? { repo: bottleneck.repo } : {}) } : null,
        coverage: { ratio: Math.round(w.coverage * 1000) / 1000, okSlots: w.okSlots, slots: w.slots, last3Ok: w.last3Ok, window: w.label, full: w.full, incompleteSlots: w.incompleteSlots },
        tuner: queue === 'feedback.triage' && tuner ? { state: tuner.state, extraRunsToday: tuner.extraRunsToday, cooldownUntil: tuner.cooldownUntil } : null,
        owner: FEEDBACK_QUEUES.has(queue) ? (this.ownerServing(adapter) ? 'serving' : 'not-serving') : 'this-machine',
        lastIntervalTo: last?.to ?? null,
        ok: last?.ok ?? false,
        lastReason: last && !last.ok ? last.reason ?? null : null,
        context: lastOk?.context ?? null,
        gapRecovered: last?.reason === 'baseline' ? last.gapRecovered ?? null : null,
      });
    }
    return { schema: QUEUE_PACE_SCHEMA, machineId: this.opts.machineId, generatedAt: now, queues, context: { feedbackReportsPerDay: this.lastContext.feedbackReportsPerDay } };
  }
}

export interface QueuePaceQueueView {
  id: QueueId;
  label: string;
  machineId: string;
  verdict: Verdict;
  rawVerdict: Verdict;
  verdictReason: string | null;
  inflowPerDay: number | null;
  outflowPerDay: number | null;
  exitedPerDay: number | null;
  open: number | null;
  daysToClear: number | null;
  bottleneck: { kind: string; matched: string[]; detail: string; count: number | null; history: Record<string, number>; prs?: number[]; approverLatched?: boolean; repo?: string } | null;
  coverage: { ratio: number; okSlots: number; slots: number; last3Ok: boolean; window: string; full: boolean; incompleteSlots: number };
  tuner: { state: string; extraRunsToday: number; cooldownUntil: number | null } | null;
  owner: 'serving' | 'not-serving' | 'this-machine';
  lastIntervalTo: number | null;
  ok: boolean;
  lastReason: string | null;
  context: Record<string, number> | null;
  gapRecovered: IntervalRow['gapRecovered'] | null;
}

export interface QueuePaceView {
  schema: typeof QUEUE_PACE_SCHEMA;
  machineId: string;
  generatedAt: number;
  queues: QueuePaceQueueView[];
  context: { feedbackReportsPerDay: number | null };
}

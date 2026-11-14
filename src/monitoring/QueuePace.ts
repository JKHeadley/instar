/**
 * Queue pace — pure arithmetic (docs/specs/queue-pace.md).
 *
 * Everything here is a pure function over plain data: interval reconciliation (events applied
 * to the previous id set and compared id-by-id with the snapshot), elapsed-time coverage, the
 * disjoint verdicts with tolerance and hysteresis, days-to-clear, the bottleneck evaluation and
 * the worker-evidence / projected-call-cap checks. The ledger service (QueuePaceLedger.ts) and
 * the tuner (QueuePaceTuner.ts) do all I/O and call into this module.
 *
 * Nothing here grants authority: a verdict or a bottleneck is a measurement. The only acting
 * part (the tuner) re-checks its own gates before every extra tick.
 */
import { createHash } from 'node:crypto';

export const QUEUE_PACE_SCHEMA = 'queue-pace/1';
export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
/** Verdict window (spec: 7 days; the shorter available window is labelled). */
export const WINDOW_MS = 7 * DAY_MS;
/** Coverage needed for any verdict other than unknown. */
export const COVERAGE_MIN = 0.8;
/** |Δopen| tolerance as a share of the window's starting open (min 1 item). */
export const TOLERANCE = 0.05;
/** A new verdict must hold for this many consecutive evaluations before it is shown. */
export const HYSTERESIS_EVALUATIONS = 2;
/** Event/snapshot disagreement tolerated before an interval is count-drift (share of transitions). */
export const DRIFT_TOLERANCE = 0.1;
/** Actionable bottleneck evidence window, and the newest-evidence freshness bound. */
export const ACTIONABLE_WINDOW_MS = 3 * HOUR_MS;
export const EVIDENCE_FRESH_MS = 90 * 60_000;
/** Maximum ids kept per queue for reconciliation. */
export const MAX_IDS = 20_000;
/** Rows older than this are compacted to daily rows; daily rows are kept RETAIN_DAILY_MS. */
export const COMPACT_AFTER_MS = 14 * DAY_MS;
export const RETAIN_DAILY_MS = 90 * DAY_MS;

export const QUEUE_IDS = ['feedback.triage', 'feedback.fix', 'maturation.fix', 'commitments', 'evolution'] as const;
export type QueueId = typeof QUEUE_IDS[number];

/** Plain labels for a non-technical reader (frozen wording, spec §Surfaces). */
export const QUEUE_LABELS: Record<QueueId, string> = {
  'feedback.triage': 'Feedback sorting',
  'feedback.fix': 'Feedback fixes',
  'maturation.fix': 'Maturation fixes',
  commitments: 'Promises',
  evolution: 'Self-improvement items',
};

/** Queues whose owner is the operated feedback host (owner-not-serving applies). */
export const FEEDBACK_QUEUES: ReadonlySet<QueueId> = new Set(['feedback.triage', 'feedback.fix']);

// ── Events and interval rows ─────────────────────────────────────────────────

export type EventKind = 'entered' | 'reentered' | 'completed' | 'exitedOther';

export interface PaceEvent {
  itemId: string;
  kind: EventKind;
  at: number;
  /** For exitedOther: withdrawn, expired, cancelled, held, ignored, deleted, pruned, … */
  exitKind?: string;
}

export interface GapRecovered { from: number; to: number; entered: number; completed: number; exitedOther: number }

export type RowReason = 'baseline' | 'count-drift' | 'read-race' | 'too-large' | 'read-failed' | 'owner-unavailable' | string;

export interface IntervalRow {
  schema: typeof QUEUE_PACE_SCHEMA;
  /** 'interval' = one hour (or one review step for maturation.fix); 'daily' = a compacted day. */
  kind: 'interval' | 'daily';
  machineId: string;
  queue: QueueId;
  from: number;
  to: number;
  ok: boolean;
  reason?: RowReason;
  openStart?: number;
  open?: number;
  entered?: number;
  reentered?: number;
  completed?: number;
  exitedOther?: number;
  /** 'incomplete' when a transition was inferred from the id-set diff, not from an owner event. */
  turnover?: 'complete' | 'incomplete';
  /** Event/snapshot disagreement inside tolerance (counts are applied events only). */
  drift?: number;
  gapRecovered?: GapRecovered;
  /** Context numbers (never paced), e.g. spec-path designs drafted. */
  context?: Record<string, number>;
  cursorAfter?: unknown;
  idsDigest?: string | null;
  /** Daily rows: hours that were ok inside the day. */
  okHours?: number;
}

export function idsDigest(ids: Iterable<string>): string {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 32);
}

export function rowIdentity(r: Pick<IntervalRow, 'machineId' | 'queue' | 'from' | 'kind'>): string {
  return `${r.kind}|${r.machineId}|${r.queue}|${r.from}`;
}

/** Dedupe by (itemId, kind, at); stable sort by time, arrivals before exits at the same instant. */
export function dedupeEvents(events: readonly PaceEvent[]): PaceEvent[] {
  const seen = new Set<string>();
  const out: PaceEvent[] = [];
  for (const e of events) {
    if (!e || typeof e.itemId !== 'string' || !Number.isFinite(e.at)) continue;
    const key = `${e.itemId}|${e.kind}|${e.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  const order: Record<EventKind, number> = { entered: 0, reentered: 1, completed: 2, exitedOther: 3 };
  return out.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);
}

export interface ReconcileInput {
  prevIds: ReadonlySet<string>;
  events: readonly PaceEvent[];
  snapshot: ReadonlySet<string>;
  /** The owner keeps no timestamp for some returns (e.g. triage hold→queued): an unexplained arrival is a snapshot-derived re-entry. */
  snapshotDerivedArrivals?: boolean;
  /** The owner keeps no timestamp for some exits (e.g. pruning, cancel): an unexplained exit is a snapshot-derived exitedOther. */
  snapshotDerivedExits?: boolean;
}

export interface ReconcileResult {
  ok: boolean;
  reason?: 'count-drift';
  openStart: number;
  open: number;
  entered: number;
  reentered: number;
  completed: number;
  exitedOther: number;
  turnover: 'complete' | 'incomplete';
  drift: number;
  unexplainedExits: number;
}

/**
 * Apply each event to the previous id set and compare the result with the snapshot id-by-id.
 * Counts are the APPLIED events (plus declared snapshot-derived transitions), so every ok row
 * conserves `open = openStart + entered + reentered − completed − exitedOther` up to `drift`.
 */
export function reconcileInterval(input: ReconcileInput): ReconcileResult {
  const set = new Set(input.prevIds);
  let entered = 0, reentered = 0, completed = 0, exitedOther = 0, mismatch = 0;
  for (const e of dedupeEvents(input.events)) {
    if (e.kind === 'entered' || e.kind === 'reentered') {
      if (set.has(e.itemId)) { mismatch++; continue; }
      set.add(e.itemId);
      if (e.kind === 'entered') entered++; else reentered++;
    } else {
      if (!set.has(e.itemId)) { mismatch++; continue; }
      set.delete(e.itemId);
      if (e.kind === 'completed') completed++; else exitedOther++;
    }
  }
  let arrivals = 0, exits = 0;
  for (const id of input.snapshot) if (!set.has(id)) arrivals++;
  for (const id of set) if (!input.snapshot.has(id)) exits++;
  let incomplete = false;
  if (arrivals > 0) {
    if (input.snapshotDerivedArrivals) { reentered += arrivals; incomplete = true; } else mismatch += arrivals;
  }
  let unexplainedExits = 0;
  if (exits > 0) {
    if (input.snapshotDerivedExits) { exitedOther += exits; incomplete = true; } else unexplainedExits = exits;
  }
  const transitions = entered + reentered + completed + exitedOther;
  const base = {
    openStart: input.prevIds.size, open: input.snapshot.size, entered, reentered, completed, exitedOther,
    turnover: (incomplete ? 'incomplete' : 'complete') as 'complete' | 'incomplete', drift: mismatch, unexplainedExits,
  };
  if (unexplainedExits > 0 || mismatch > DRIFT_TOLERANCE * transitions) return { ok: false, reason: 'count-drift', ...base };
  return { ok: true, ...base };
}

// ── Coverage and window ──────────────────────────────────────────────────────

export function floorHour(t: number): number { return Math.floor(t / HOUR_MS) * HOUR_MS; }

export interface WindowSummary {
  windowFrom: number;
  windowTo: number;
  /** Elapsed hours (or steps) in the window. */
  slots: number;
  okSlots: number;
  coverage: number;
  last3Ok: boolean;
  /** 'Nd' label; `full` when the whole 7-day window is available. */
  label: string;
  full: boolean;
  inflow: number;
  outflow: number;
  exited: number;
  deltaOpen: number;
  startOpen: number | null;
  open: number | null;
  incompleteSlots: number;
  lastIntervalTo: number | null;
  days: number;
}

/**
 * Hourly coverage by elapsed time. A missed hour is uncovered forever; an ok:false row is
 * uncovered. Inflow, outflow and Δopen are summed over the SAME covered hours.
 */
export function hourlyWindow(rows: readonly IntervalRow[], now: number, windowMs = WINDOW_MS): WindowSummary {
  const hourly = rows.filter((r) => r.kind === 'interval' && r.to - r.from === HOUR_MS);
  const bySlot = new Map<number, IntervalRow>();
  for (const r of hourly) bySlot.set(r.from, r);
  const latestTo = hourly.reduce<number | null>((m, r) => (m === null || r.to > m ? r.to : m), null);
  // The tick that writes the newest hour runs just after the boundary: one hour of grace.
  const boundary = floorHour(now);
  const end = latestTo !== null && latestTo >= boundary - HOUR_MS && latestTo <= boundary ? latestTo : boundary;
  const firstFrom = hourly.reduce<number | null>((m, r) => (m === null || r.from < m ? r.from : m), null);
  const start = Math.max(end - windowMs, firstFrom ?? end);
  const slots = Math.max(0, Math.round((end - start) / HOUR_MS));
  let okSlots = 0, inflow = 0, outflow = 0, exited = 0, delta = 0, incomplete = 0;
  let startOpen: number | null = null;
  let open: number | null = null;
  for (let t = start; t < end; t += HOUR_MS) {
    const r = bySlot.get(t);
    if (!r || !r.ok) continue;
    okSlots++;
    inflow += (r.entered ?? 0) + (r.reentered ?? 0);
    outflow += r.completed ?? 0;
    exited += r.exitedOther ?? 0;
    delta += (r.open ?? 0) - (r.openStart ?? 0);
    if (startOpen === null) startOpen = r.openStart ?? null;
    open = r.open ?? open;
    if (r.turnover === 'incomplete') incomplete++;
  }
  const last3Ok = [1, 2, 3].every((k) => bySlot.get(end - k * HOUR_MS)?.ok === true);
  const days = slots / 24;
  return {
    windowFrom: start, windowTo: end, slots, okSlots, coverage: slots > 0 ? okSlots / slots : 0, last3Ok,
    label: `${Math.max(0, Math.round(days * 10) / 10)}d`, full: end - start >= windowMs,
    inflow, outflow, exited, deltaOpen: delta, startOpen, open, incompleteSlots: incomplete,
    lastIntervalTo: latestTo, days,
  };
}

/** Stepped window (maturation.fix): the last `steps` review steps, each must be ok. */
export function steppedWindow(rows: readonly IntervalRow[], steps = 3): WindowSummary {
  const sorted = rows.filter((r) => r.kind === 'interval').sort((a, b) => a.from - b.from);
  const last = sorted.slice(-steps);
  const okRows = last.filter((r) => r.ok);
  let inflow = 0, outflow = 0, exited = 0, delta = 0, incomplete = 0;
  for (const r of okRows) {
    inflow += (r.entered ?? 0) + (r.reentered ?? 0);
    outflow += r.completed ?? 0;
    exited += r.exitedOther ?? 0;
    delta += (r.open ?? 0) - (r.openStart ?? 0);
    if (r.turnover === 'incomplete') incomplete++;
  }
  const first = last[0];
  const end = last.length ? last[last.length - 1].to : 0;
  const start = first ? first.from : 0;
  const days = (end - start) / DAY_MS;
  return {
    windowFrom: start, windowTo: end, slots: last.length, okSlots: okRows.length,
    coverage: last.length ? okRows.length / steps : 0,
    last3Ok: last.length >= steps && okRows.length === last.length,
    label: `${last.length} reviews`, full: last.length >= steps,
    inflow, outflow, exited, deltaOpen: delta, startOpen: okRows[0]?.openStart ?? null, open: okRows[okRows.length - 1]?.open ?? null,
    incompleteSlots: incomplete, lastIntervalTo: last.length ? end : null, days: Math.max(days, 0),
  };
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export type Verdict = 'falling-behind' | 'catching-up' | 'holding' | 'shrinking-by-exits' | 'unknown' | 'owner-not-serving';

export interface VerdictResult { verdict: Verdict; reason?: 'coverage' | 'mixed-signal' | 'owner-not-serving' }

export function coverageSufficient(w: WindowSummary): boolean {
  return w.coverage >= COVERAGE_MIN && w.last3Ok;
}

/** The disjoint verdict over a window (owner-not-serving is checked by the caller first, via `ownerServing`). */
export function classifyVerdict(w: WindowSummary, opts: { ownerServing?: boolean } = {}): VerdictResult {
  if (opts.ownerServing === false) return { verdict: 'owner-not-serving', reason: 'owner-not-serving' };
  if (!coverageSufficient(w)) return { verdict: 'unknown', reason: 'coverage' };
  const tol = Math.max(1, TOLERANCE * (w.startOpen ?? 0));
  const d = w.deltaOpen;
  if (d > tol && w.inflow > w.outflow) return { verdict: 'falling-behind' };
  if (d < -tol && w.outflow > w.inflow) return { verdict: 'catching-up' };
  if (Math.abs(d) <= tol) return { verdict: 'holding' };
  if (d < -tol && w.outflow <= w.inflow) return { verdict: 'shrinking-by-exits' };
  return { verdict: 'unknown', reason: 'mixed-signal' };
}

export interface HysteresisState { shown: Verdict; candidate: Verdict | null; count: number; shownSince: number | null }

export const INITIAL_HYSTERESIS: HysteresisState = { shown: 'unknown', candidate: null, count: 0, shownSince: null };

/**
 * A new verdict replaces the shown one only after HYSTERESIS_EVALUATIONS consecutive
 * evaluations. Two exceptions move at once, both toward "say less": lost coverage (unknown)
 * and owner-not-serving — a stale "falling behind" must never outlive the measurement.
 */
export function applyHysteresis(prev: HysteresisState, raw: VerdictResult, now: number): HysteresisState {
  if (raw.verdict === prev.shown) return { ...prev, candidate: null, count: 0 };
  if (raw.verdict === 'owner-not-serving' || (raw.verdict === 'unknown' && raw.reason === 'coverage')) {
    return { shown: raw.verdict, candidate: null, count: 0, shownSince: now };
  }
  const count = prev.candidate === raw.verdict ? prev.count + 1 : 1;
  if (count >= HYSTERESIS_EVALUATIONS) return { shown: raw.verdict, candidate: null, count: 0, shownSince: now };
  return { ...prev, candidate: raw.verdict, count };
}

/** Days to clear: only when catching up at a strictly positive net rate, never for a person bottleneck. */
export function daysToClear(verdict: Verdict, w: WindowSummary, bottleneck: BottleneckKind | null): number | null {
  if (verdict !== 'catching-up' || bottleneck === 'person') return null;
  if (w.days <= 0 || w.open === null) return null;
  const rate = (w.outflow - w.inflow) / w.days;
  if (!(rate > 0)) return null;
  return Math.round((w.open / rate) * 10) / 10;
}

export function perDay(n: number, w: WindowSummary): number | null {
  if (w.days <= 0 || w.okSlots === 0) return null;
  // Rates over covered time only: covered slots × slot length.
  const coveredDays = w.label.endsWith('reviews') ? w.days : w.okSlots / 24;
  return coveredDays > 0 ? Math.round((n / coveredDays) * 10) / 10 : null;
}

// ── Tick rows and bottleneck ─────────────────────────────────────────────────

export type TickSource = 'triage' | 'executor';

/** Server-written rows in logs/queue-pace-ticks.jsonl (never written by an HTTP caller). */
export interface TickRow {
  at: number;
  source: TickSource;
  kind: 'tick' | 'refused' | 'admission';
  runId?: string;
  decided?: number;
  calls?: number;
  stopReason?: string | null;
  queueDepthAfter?: number | null;
  reason?: string;
  admission?: string | null;
}

export type BottleneckKind = 'person' | 'quota' | 'cap' | 'worker' | 'unknown';
export const PRECEDENCE: readonly BottleneckKind[] = ['person', 'quota', 'cap', 'worker'];

export const TIME_EXHAUSTED = 'triage-time-exhausted-rest-due';
export const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const CAP_STOPS = new Set(['call-cap-reached']);
const QUOTA_STOPS = new Set(['quota-pause', 'quota-unreadable-pause', 'quota-margin-lost']);
const CAP_ADMISSIONS = new Set(['max-open-prs', 'max-starts-per-day', 'max-concurrent']);
const QUOTA_ADMISSIONS = new Set(['quota-shedding']);

/** What a tick row says: a refusal of a kind, a normal run (clears earlier refusals), or nothing. */
export function classifyTickRow(r: TickRow): { refusal: 'cap' | 'quota' | null; normal: boolean; reason: string | null } {
  if (r.kind === 'tick') {
    const s = r.stopReason ?? null;
    if (s && CAP_STOPS.has(s)) return { refusal: 'cap', normal: false, reason: s };
    if (s && QUOTA_STOPS.has(s)) return { refusal: 'quota', normal: false, reason: s };
    return { refusal: null, normal: true, reason: s };
  }
  if (r.kind === 'admission') {
    const a = r.admission ?? null;
    if (a && CAP_ADMISSIONS.has(a)) return { refusal: 'cap', normal: false, reason: a };
    if (a && QUOTA_ADMISSIONS.has(a)) return { refusal: 'quota', normal: false, reason: a };
    return { refusal: null, normal: a === null, reason: a };
  }
  // 'refused' (rate-limited / tick-in-flight / not-canonical-owner) is admission noise, not a limit.
  return { refusal: null, normal: false, reason: r.reason ?? null };
}

/** Positive worker evidence: ≥3 of the last 4 ticks ended on their own time budget with work still queued and decisions made. */
export function workerEvidence(ticks: readonly TickRow[], now: number): { matched: boolean; considered: number; exhausted: number; newestAt: number | null } {
  const recent = ticks
    .filter((t) => t.source === 'triage' && t.kind === 'tick' && t.at >= now - ACTIONABLE_WINDOW_MS && t.at <= now)
    .sort((a, b) => b.at - a.at)
    .slice(0, 4);
  const exhausted = recent.filter((t) => t.stopReason === TIME_EXHAUSTED && (t.queueDepthAfter ?? 0) > 0 && (t.decided ?? 0) > 0).length;
  return { matched: recent.length >= 3 && exhausted >= 3, considered: recent.length, exhausted, newestAt: recent[0]?.at ?? null };
}

/** Cron minutes of the scheduled triage job (`*\/15`). */
export const TRIAGE_SCHEDULE_MINUTES = [0, 15, 30, 45] as const;

/** Scheduled ticks still to come before the next UTC midnight (the call cap's day). */
export function remainingScheduledTicks(now: number, minutes: readonly number[] = TRIAGE_SCHEDULE_MINUTES): number {
  const midnight = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  let n = 0;
  for (let h = floorHour(now); h < midnight; h += HOUR_MS) for (const m of minutes) { const t = h + m * 60_000; if (t > now && t < midnight) n++; }
  return n;
}

/** Trailing 24 h average calls per budget-exhausted tick; null with no such tick. */
export function avgCallsPerExhaustedTick(ticks: readonly TickRow[], now: number): number | null {
  const rows = ticks.filter((t) => t.source === 'triage' && t.kind === 'tick' && t.stopReason === TIME_EXHAUSTED && t.at >= now - DAY_MS && t.at <= now);
  if (rows.length === 0) return null;
  return rows.reduce((s, t) => s + (t.calls ?? 0), 0) / rows.length;
}

export interface CallProjection { ok: boolean; projected: number | null; maxCallsPerDay: number | null; reachesCap: boolean }

/**
 * The ONE projected-cap implementation (used by the worker definition and by tuner step-up):
 * callsUsedToday + (remaining scheduled ticks + extra ticks allowed) × trailing average calls
 * per budget-exhausted tick must stay below maxCallsPerDay.
 */
export function projectDailyCalls(input: { callsUsedToday: number | null; maxCallsPerDay: number | null; ticks: readonly TickRow[]; now: number; extraTicksAllowed: number }): CallProjection {
  const { callsUsedToday, maxCallsPerDay } = input;
  const avg = avgCallsPerExhaustedTick(input.ticks, input.now);
  if (callsUsedToday === null || maxCallsPerDay === null || avg === null) return { ok: false, projected: null, maxCallsPerDay, reachesCap: false };
  const projected = callsUsedToday + (remainingScheduledTicks(input.now) + Math.max(0, input.extraTicksAllowed)) * avg;
  return { ok: true, projected: Math.round(projected), maxCallsPerDay, reachesCap: projected >= maxCallsPerDay };
}

export interface ExecutorFacts {
  ok: boolean;
  /** Open fix PRs waiting on a CODEOWNERS owner review. */
  awaitingOwnerPrs: number[];
  approverLatched: boolean;
  openPrs: number;
  failedReviewPrs: number;
  /** owner/name of the source repository, for PR links built only from numbers. */
  repo?: string | null;
}

export interface Bottleneck {
  kind: BottleneckKind;
  matched: BottleneckKind[];
  detail: string;
  count: number | null;
  /** Refusals over the 7-day window, for display only. */
  history: Record<string, number>;
  prs?: number[];
  approverLatched?: boolean;
  repo?: string | null;
}

export interface BottleneckInput {
  queue: QueueId;
  now: number;
  ticks: readonly TickRow[];
  executor?: ExecutorFacts | null;
  projection?: CallProjection | null;
}

function capDetail(reason: string | null, ex: ExecutorFacts | null | undefined, projected: boolean): string {
  if (projected) return 'the daily sorting call limit would be reached';
  if (reason === 'call-cap-reached') return 'the daily sorting call limit was reached';
  if (reason === 'max-open-prs') {
    if (ex?.ok && ex.failedReviewPrs > 0) return `${ex.openPrs} fix slots held, ${ex.failedReviewPrs} of them by fixes that failed review`;
    return ex?.ok ? `${ex.openPrs} fix slots held by open fixes` : 'all fix slots are held by open fixes';
  }
  if (reason === 'max-starts-per-day') return 'the daily limit on new fix attempts was reached';
  if (reason === 'max-concurrent') return 'the limit on fixes running at once was reached';
  return 'a fixed limit stopped the work';
}

/**
 * Why a falling-behind queue is behind. The winner is the newest refusal or stop row inside the
 * actionable window that no later normal run cleared; only without one does the fixed precedence
 * (person > quota > cap > worker) pick among the matched kinds. Doubt → unknown.
 */
export function evaluateBottleneck(input: BottleneckInput): Bottleneck {
  const { now, queue } = input;
  const source: TickSource | null = queue === 'feedback.triage' ? 'triage' : queue === 'feedback.fix' ? 'executor' : null;
  const history: Record<string, number> = {};
  const mine = source ? input.ticks.filter((t) => t.source === source && t.at <= now) : [];
  for (const t of mine) {
    if (t.at < now - WINDOW_MS) continue;
    const c = classifyTickRow(t);
    if (c.refusal && c.reason) history[c.reason] = (history[c.reason] ?? 0) + 1;
  }
  const actionable = mine.filter((t) => t.at >= now - ACTIONABLE_WINDOW_MS).sort((a, b) => b.at - a.at);
  const matched = new Set<BottleneckKind>();
  const ex = input.executor ?? null;

  // person — read live from the executor store (feedback.fix only).
  const personMatched = queue === 'feedback.fix' && ex?.ok === true && (ex.awaitingOwnerPrs.length > 0 || ex.approverLatched);
  if (personMatched) matched.add('person');

  // refusals not cleared by a later normal run
  let winner: { kind: 'cap' | 'quota'; reason: string | null } | null = null;
  for (const t of actionable) {
    const c = classifyTickRow(t);
    if (c.normal) break;
    if (c.refusal) {
      matched.add(c.refusal);
      if (!winner) winner = { kind: c.refusal, reason: c.reason };
    }
  }

  // projected cap and worker evidence (feedback.triage only)
  let projectedCap = false;
  if (queue === 'feedback.triage') {
    const w = workerEvidence(mine, now);
    const p = input.projection ?? null;
    if (p?.ok && p.reachesCap) { projectedCap = true; matched.add('cap'); }
    if (!winner && w.matched && p?.ok && !p.reachesCap) matched.add('worker');
  }

  const newest = actionable[0]?.at ?? null;
  const stale = newest === null || now - newest > EVIDENCE_FRESH_MS;
  const base = { matched: [...matched].sort((a, b) => PRECEDENCE.indexOf(a) - PRECEDENCE.indexOf(b)), history };

  if (winner && !stale) {
    return { kind: winner.kind, ...base, detail: winner.kind === 'cap' ? capDetail(winner.reason, ex, false) : 'the account usage limit paused the work', count: winner.kind === 'cap' && winner.reason === 'max-open-prs' && ex?.ok ? ex.openPrs : null };
  }
  for (const k of PRECEDENCE) {
    if (!matched.has(k)) continue;
    if (k === 'person') {
      const prs = ex!.awaitingOwnerPrs.slice(0, 50);
      const repo = typeof ex!.repo === 'string' && REPO_RE.test(ex!.repo) ? ex!.repo : null;
      return { kind: 'person', ...base, prs, approverLatched: ex!.approverLatched, repo, count: prs.length,
        detail: ex!.approverLatched && prs.length === 0 ? 'the fix builder is waiting for your one-time acceptance on the dashboard' : `${prs.length} fixes are ready for your review` };
    }
    // Row-based kinds need fresh evidence; the projected cap is computed now and is always fresh.
    if (k === 'cap' && projectedCap) return { kind: 'cap', ...base, detail: capDetail(null, ex, true), count: null };
    if (stale) continue;
    if (k === 'worker') return { kind: 'worker', ...base, detail: 'the sorting rounds keep running out of time with work still waiting', count: null };
  }
  return { kind: 'unknown', ...base, detail: stale && source ? 'no recent evidence of why' : 'the reason could not be shown', count: null };
}

// ── Maturation steps ─────────────────────────────────────────────────────────

export const MATURATION_ATTENTION_VERDICTS: ReadonlySet<string> = new Set(['blind', 'stalled', 'regressed']);
const RETIRED_VERDICTS = new Set(['retire-pending']);

export interface ReviewSnapshot { date: string; at: number; rows: Array<{ id: string; verdict: string }> }

export interface MaturationStep {
  from: number;
  to: number;
  openStart: number;
  open: number;
  entered: number;
  completed: number;
  exitedOther: number;
  ids: string[];
}

/** One step per consecutive review pair: membership = stalled/regressed/blind in that review. */
export function maturationSteps(reviews: readonly ReviewSnapshot[]): MaturationStep[] {
  const sorted = [...reviews].sort((a, b) => a.at - b.at);
  const out: MaturationStep[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    const prevSet = new Set(prev.rows.filter((r) => MATURATION_ATTENTION_VERDICTS.has(r.verdict)).map((r) => r.id));
    const curById = new Map(cur.rows.map((r) => [r.id, r.verdict]));
    const curSet = new Set(cur.rows.filter((r) => MATURATION_ATTENTION_VERDICTS.has(r.verdict)).map((r) => r.id));
    let entered = 0, completed = 0, exitedOther = 0;
    for (const id of curSet) if (!prevSet.has(id)) entered++;
    for (const id of prevSet) {
      if (curSet.has(id)) continue;
      const v = curById.get(id);
      if (v === undefined || RETIRED_VERDICTS.has(v)) exitedOther++; else completed++;
    }
    out.push({ from: prev.at, to: cur.at, openStart: prevSet.size, open: curSet.size, entered, completed, exitedOther, ids: [...curSet].sort() });
  }
  return out;
}

// ── Notices ──────────────────────────────────────────────────────────────────

export const NOTICE_ESCALATE_AFTER_MS = 24 * HOUR_MS;
export const NOTICE_BREAKER_REOPENS = 3;
export const NOTICE_BREAKER_WINDOW_MS = 7 * DAY_MS;

export interface NoticeState {
  open: boolean;
  /** When the queue first read falling-behind with a worker bottleneck in this run of evaluations. */
  workerBehindSince: number | null;
  /** When the tuner was first seen at its daily maximum while the queue was still behind. */
  atMaxSince: number | null;
  /** Raise times inside the breaker window. */
  reopenedAt: number[];
  /** The breaker tripped: the item is held open (not cleared, not re-raised), marked "keeps recurring". */
  held: boolean;
  measurementUnavailable: boolean;
}

export const INITIAL_NOTICE: NoticeState = { open: false, workerBehindSince: null, atMaxSince: null, reopenedAt: [], held: false, measurementUnavailable: false };

export type NoticeAction =
  | { action: 'none' }
  | { action: 'raise'; why: 'heal-exhausted' | 'heal-unavailable' }
  | { action: 'hold-open' }
  | { action: 'mark-unavailable' }
  | { action: 'clear'; resolution: string };

/**
 * Escalate only after self-heal is exhausted (tuner at its daily maximum for 24 h, still behind)
 * or unavailable (tuner off / dry-run, worker-bound and behind for 24 h). Clear only on an
 * affirmative holding/catching-up verdict with full coverage; unknown leaves the item open and
 * marks it "measurement unavailable". An item raised NOTICE_BREAKER_REOPENS times in 7 days is
 * held open instead of cleared, so it cannot flap.
 */
export function decideNotice(input: {
  state: NoticeState; now: number; verdict: Verdict; bottleneck: BottleneckKind | null; coverageFull: boolean;
  tunerLive: boolean; tunerAtMax: boolean; ownsQueue: boolean;
}): { next: NoticeState; action: NoticeAction } {
  const s: NoticeState = { ...INITIAL_NOTICE, ...input.state, reopenedAt: (input.state.reopenedAt ?? []).filter((t) => t > input.now - NOTICE_BREAKER_WINDOW_MS) };
  if (!input.ownsQueue) {
    if (s.open) return { next: { ...INITIAL_NOTICE, reopenedAt: s.reopenedAt }, action: { action: 'clear', resolution: 'ownership moved' } };
    return { next: { ...s, workerBehindSince: null, atMaxSince: null }, action: { action: 'none' } };
  }
  const behindWorker = input.verdict === 'falling-behind' && input.bottleneck === 'worker';
  if (input.verdict === 'falling-behind') {
    s.measurementUnavailable = false;
    s.workerBehindSince = behindWorker ? s.workerBehindSince ?? input.now : null;
    s.atMaxSince = behindWorker && input.tunerLive && input.tunerAtMax ? s.atMaxSince ?? input.now : null;
    if (s.open) return { next: s, action: { action: 'none' } };
    const exhausted = input.tunerLive && s.atMaxSince !== null && input.now - s.atMaxSince >= NOTICE_ESCALATE_AFTER_MS;
    const unavailable = !input.tunerLive && s.workerBehindSince !== null && input.now - s.workerBehindSince >= NOTICE_ESCALATE_AFTER_MS;
    if (!exhausted && !unavailable) return { next: s, action: { action: 'none' } };
    s.open = true;
    s.reopenedAt = [...s.reopenedAt, input.now];
    return { next: s, action: { action: 'raise', why: exhausted ? 'heal-exhausted' : 'heal-unavailable' } };
  }
  if ((input.verdict === 'holding' || input.verdict === 'catching-up') && input.coverageFull) {
    if (!s.open) return { next: { ...s, workerBehindSince: null, atMaxSince: null, measurementUnavailable: false }, action: { action: 'none' } };
    if (s.reopenedAt.length >= NOTICE_BREAKER_REOPENS) {
      if (s.held) return { next: s, action: { action: 'none' } };
      return { next: { ...s, held: true, workerBehindSince: null, atMaxSince: null, measurementUnavailable: false }, action: { action: 'hold-open' } };
    }
    return { next: { ...INITIAL_NOTICE, reopenedAt: s.reopenedAt }, action: { action: 'clear', resolution: input.verdict === 'holding' ? 'the queue is holding steady again' : 'the queue is catching up again' } };
  }
  if (input.verdict === 'unknown' && s.open && !s.measurementUnavailable) {
    return { next: { ...s, measurementUnavailable: true }, action: { action: 'mark-unavailable' } };
  }
  return { next: s, action: { action: 'none' } };
}

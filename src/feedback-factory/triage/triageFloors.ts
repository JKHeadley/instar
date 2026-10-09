/**
 * Pure, deterministic parts of feedback triage (docs/specs/feedback-triage-and-execution.md §1–§2).
 *
 * Everything here is code authority within which the model judges: the closed schema, the
 * floors applied after the model answers (in the spec's order), the rank key, the
 * rule-default comparison baseline, the ignore-rate brake and the review schedule. No I/O.
 */

export type TriageDisposition = 'work' | 'hold' | 'ignore';
export type TriageSeverity = 'critical' | 'high' | 'medium' | 'low';
export type TriageReason = 'duplicate' | 'already-fixed' | 'not-a-defect' | 'out-of-scope' | 'low-value' | 'needs-evidence' | 'actionable';
export type TriageEffort = 's' | 'm' | 'l' | 'xl';

/** Hold reasons code may assign (the model's own reasons stay as-is on work/ignore). */
export type HoldReason =
  | 'needs-evidence' | 'needs-review' | 'evidence-truncated' | 'possibly-fixed'
  | 'ignore-shadow' | 'ignore-rate-brake' | 'duplicate-unverified';

export const DISPOSITIONS: ReadonlySet<string> = new Set(['work', 'hold', 'ignore']);
export const REASONS: ReadonlySet<string> = new Set(['duplicate', 'already-fixed', 'not-a-defect', 'out-of-scope', 'low-value', 'needs-evidence', 'actionable']);
export const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low']);
export const EFFORTS: ReadonlySet<string> = new Set(['s', 'm', 'l', 'xl']);

export const CONFIDENCE_FLOOR = 0.7;
export const KEYWORD_FLOOR = /security|vulnerab|data loss|corrupt|leak/i;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const REQUEUE_THROTTLE_MS = DAY_MS;
export const RETRIAGE_SUBCAP = 50;
export const SECOND_OPINION_SUBCAP = 30;
export const WORK_QUEUE_CEILING_MS = 30 * DAY_MS;

export interface TriageBrief { component: string; symptom: string; expected: string; reproduction: string }

/** One validated model row (schema `feedback-triage-decision-v1`). */
export interface TriageModelRow {
  clusterId: string;
  disposition: TriageDisposition;
  reason: TriageReason;
  duplicateOf: string | null;
  fixedBy: string | null;
  severity: TriageSeverity;
  effort: TriageEffort;
  needsSpec: boolean;
  userFacing: boolean;
  priority: number;
  confidence: number;
  summary: string;
  brief: TriageBrief;
}

const BRIEF_CAPS: Record<keyof TriageBrief, number> = { component: 80, symptom: 300, expected: 200, reproduction: 400 };

/** Printable-character hygiene for a model-authored field: drop control chars, cap length with a marker. Never blocks. */
export function printable(value: unknown, max: number): string {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (text.length <= max) return text;
  const marker = ' [truncated]';
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

export function sanitizeBrief(raw: unknown): TriageBrief {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    component: printable(source.component, BRIEF_CAPS.component),
    symptom: printable(source.symptom, BRIEF_CAPS.symptom),
    expected: printable(source.expected, BRIEF_CAPS.expected),
    reproduction: printable(source.reproduction, BRIEF_CAPS.reproduction),
  };
}

export class TriageOutputRejected extends Error {
  constructor(message: string, readonly check: string) { super(message); this.name = 'TriageOutputRejected'; }
}

/**
 * Validate one model answer against the closed schema. Any structural problem rejects the
 * WHOLE batch (floor 1: nothing is ever defaulted to a disposition). Length/charset problems
 * in free text are hygiene and are truncated, never rejected.
 */
export function parseTriageOutput(raw: string, expectedIds: readonly string[]): TriageModelRow[] {
  const body = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1');
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new TriageOutputRejected('triage authority returned invalid JSON', 'invalid-json'); }
  const rows = (parsed as { decisions?: unknown })?.decisions;
  if (!Array.isArray(rows) || rows.length !== expectedIds.length) {
    throw new TriageOutputRejected(`triage authority returned ${Array.isArray(rows) ? rows.length : 'no'} decisions for ${expectedIds.length} items`, 'incomplete-decision-set');
  }
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  return rows.map((value) => {
    const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const clusterId = String(row.clusterId ?? '');
    if (!expected.has(clusterId) || seen.has(clusterId)) throw new TriageOutputRejected('triage authority changed or duplicated item ids', 'changed-or-duplicated-id');
    seen.add(clusterId);
    const disposition = String(row.disposition ?? '');
    if (!DISPOSITIONS.has(disposition)) throw new TriageOutputRejected('invalid disposition', 'invalid-disposition');
    const reason = String(row.reason ?? '');
    if (!REASONS.has(reason)) throw new TriageOutputRejected('invalid reason', 'invalid-reason');
    const severity = String(row.severity ?? '');
    if (!SEVERITIES.has(severity)) throw new TriageOutputRejected('invalid severity', 'invalid-severity');
    const effort = String(row.effort ?? '');
    if (!EFFORTS.has(effort)) throw new TriageOutputRejected('invalid effort', 'invalid-effort');
    if (typeof row.needsSpec !== 'boolean' || typeof row.userFacing !== 'boolean') throw new TriageOutputRejected('needsSpec/userFacing must be booleans', 'invalid-flags');
    const priority = Number(row.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new TriageOutputRejected('priority must be an integer 0..100', 'invalid-priority');
    const confidence = Number(row.confidence);
    if (typeof row.confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new TriageOutputRejected('confidence must be 0..1', 'invalid-confidence');
    const ref = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string' && typeof v !== 'number') throw new TriageOutputRejected('duplicateOf/fixedBy must be a string, number or null', 'invalid-reference');
      const text = String(v).trim();
      return text ? text.slice(0, 200) : null;
    };
    if (!row.brief || typeof row.brief !== 'object') throw new TriageOutputRejected('brief is required', 'missing-brief');
    if (typeof row.summary !== 'string') throw new TriageOutputRejected('summary is required', 'missing-summary');
    return {
      clusterId,
      disposition: disposition as TriageDisposition,
      reason: reason as TriageReason,
      duplicateOf: ref(row.duplicateOf),
      fixedBy: ref(row.fixedBy),
      severity: severity as TriageSeverity,
      effort: effort as TriageEffort,
      needsSpec: row.needsSpec as boolean,
      userFacing: row.userFacing as boolean,
      priority,
      confidence,
      summary: printable(row.summary, 400),
      brief: sanitizeBrief(row.brief),
    };
  });
}

/** What the deterministic floors know about one item at decision time. */
export interface FloorContext {
  reportCount: number;
  truncated: boolean;
  credentialShaped: boolean;
  keywordFloor: boolean;
  /** Neighbour cluster ids decided in an EARLIER tick with disposition work or hold. */
  eligibleDuplicateTargets: ReadonlySet<string>;
  /** PR numbers whose body or commits carry this item's exact cluster or feedback id; null = unknown (gh error). */
  exactIdPrs: ReadonlySet<string> | null;
  /** The ignore-rate brake is engaged right now. */
  brakeActive: boolean;
  /** ignore goes live (PIN-approved); otherwise ignores are shadowed. */
  ignoreLive: boolean;
}

export interface FloorOutcome {
  disposition: TriageDisposition;
  /** The model's reason, or the hold reason a floor assigned. */
  reason: string;
  floors: string[];
  /** Set when a would-ignore was turned into a hold (shadow/brake/review); the model's ignore reason. */
  wouldIgnoreReason: string | null;
  /** The model said ignore (a would-ignore) — what the brake counts. */
  countedAsIgnore: boolean;
  evidenceComplete: boolean;
  singleReportCritical: boolean;
  duplicateApplied: boolean;
  /** Days until the hold comes back (7 for possibly-fixed), null for no timer. */
  holdBaseDays: number | null;
  needsSecondOpinion: boolean;
}

/**
 * Apply floors 2–8 and the shadow rule to one validated row (floor 1 is batch validation,
 * floor 9 the stale-write guard at write time, floor 10 the re-queue throttle). The
 * never-ignore second opinion (floor 3) is resolved by the caller: this returns
 * needsSecondOpinion and the caller re-enters via applySecondOpinion.
 */
export function applyFloors(row: TriageModelRow, ctx: FloorContext): FloorOutcome {
  const floors: string[] = [];
  let disposition: TriageDisposition = row.disposition;
  let reason: string = row.reason;
  let wouldIgnoreReason: string | null = null;
  // A model-chosen hold comes back on the standard 14-day timer too.
  let holdBaseDays: number | null = row.disposition === 'hold' ? 14 : null;
  let needsSecondOpinion = false;
  const hold = (why: HoldReason, floor: string, days = 14) => {
    if (disposition === 'ignore') wouldIgnoreReason = wouldIgnoreReason ?? row.reason;
    disposition = 'hold'; reason = why; holdBaseDays = days; floors.push(floor);
  };

  // Floor 2: low confidence.
  if (row.confidence < CONFIDENCE_FLOOR) hold('needs-evidence', 'f2-low-confidence');
  // Floor 3: never-ignore for serious or security-shaped items → second opinion.
  if (disposition === 'ignore' && (row.severity === 'critical' || row.severity === 'high' || ctx.credentialShaped || ctx.keywordFloor)) {
    floors.push('f3-never-ignore');
    needsSecondOpinion = true;
  }
  // Floor 4: truncated evidence cannot be ignored. A second opinion could not change that
  // outcome, so none is spent on it.
  if (disposition === 'ignore' && ctx.truncated) { hold('evidence-truncated', 'f4-truncated-ignore'); needsSecondOpinion = false; }
  // Floor 5: a duplicate must name an eligible earlier-decided work/hold neighbour.
  let duplicateApplied = false;
  if (row.reason === 'duplicate' && disposition !== 'hold') {
    if (row.duplicateOf && row.duplicateOf !== row.clusterId && ctx.eligibleDuplicateTargets.has(row.duplicateOf)) {
      duplicateApplied = true;
    } else {
      hold('duplicate-unverified', 'f5-duplicate-unverified');
      needsSecondOpinion = false;
    }
  }
  // Floor 6: already-fixed must cite a PR from the exact-id list.
  if (row.reason === 'already-fixed' && disposition !== 'hold') {
    if (!(row.fixedBy && ctx.exactIdPrs?.has(row.fixedBy.replace(/^#/, '')))) {
      hold('possibly-fixed', 'f6-fix-unverified', 7);
      needsSecondOpinion = false;
    }
  }
  // Floor 7: a one-report critical keeps its severity but ranks after multi-report criticals.
  const singleReportCritical = row.severity === 'critical' && ctx.reportCount <= 1;
  if (singleReportCritical) floors.push('f7-single-report-critical');

  const evidenceComplete = !ctx.truncated;
  if (disposition === 'work' && ctx.truncated) floors.push('f4-work-on-truncated');
  // The brake counts the model's would-ignores (so shadow mode exercises it).
  const countedAsIgnore = row.disposition === 'ignore';
  if (!needsSecondOpinion) {
    // Floor 8: ignore-rate brake.
    if (disposition === 'ignore' && ctx.brakeActive) hold('ignore-rate-brake', 'f8-ignore-rate-brake');
    // §7 shadow ignore.
    if (disposition === 'ignore' && !ctx.ignoreLive) hold('ignore-shadow', 's7-ignore-shadow');
  }
  return { disposition, reason, floors, wouldIgnoreReason, countedAsIgnore, evidenceComplete, singleReportCritical, duplicateApplied, holdBaseDays, needsSecondOpinion };
}

/**
 * Resolve floor 3. `secondSaysIgnore` null = no second family available or its answer was
 * unusable. Both say ignore → the ignore stands (then the brake/shadow/truncation rules);
 * otherwise hold `needs-review`.
 */
export function applySecondOpinion(outcome: FloorOutcome, row: TriageModelRow, ctx: FloorContext, secondSaysIgnore: boolean | null): FloorOutcome {
  const next: FloorOutcome = { ...outcome, floors: [...outcome.floors], needsSecondOpinion: false };
  const hold = (why: HoldReason, floor: string, days = 14) => {
    next.wouldIgnoreReason = next.wouldIgnoreReason ?? row.reason;
    next.disposition = 'hold'; next.reason = why; next.holdBaseDays = days; next.floors.push(floor);
  };
  if (secondSaysIgnore !== true) {
    hold('needs-review', secondSaysIgnore === null ? 'f3-no-second-family' : 'f3-second-opinion-disagrees');
    return next;
  }
  next.floors.push('f3-second-opinion-agrees');
  if (ctx.truncated) { hold('evidence-truncated', 'f4-truncated-ignore'); return next; }
  if (ctx.brakeActive) { hold('ignore-rate-brake', 'f8-ignore-rate-brake'); return next; }
  if (!ctx.ignoreLive) hold('ignore-shadow', 's7-ignore-shadow');
  return next;
}

/** The fully deterministic comparison baseline (never decides or routes an item). */
export function ruleDefault(input: { reportCount: number; firstSeenAt: number; keywordFloor: boolean; now: number }): TriageDisposition {
  if (input.reportCount <= 1 && input.now - input.firstSeenAt > 30 * DAY_MS && !input.keywordFloor) return 'ignore';
  if (input.reportCount <= 1) return 'hold';
  return 'work';
}

const SEVERITY_TIER: Record<TriageSeverity, number> = { critical: 0, high: 2, medium: 3, low: 4 };

/** Rank tier: a one-report critical sits after every multi-report critical, before high. */
export function severityTier(severity: TriageSeverity, singleReportCritical: boolean): number {
  return severity === 'critical' && singleReportCritical ? 1 : SEVERITY_TIER[severity];
}

/** Priority band: only bands are compared (a model scalar is not calibrated across batches). */
export function priorityBand(priority: number): number {
  return priority >= 67 ? 0 : priority >= 34 ? 1 : 2;
}

export interface RankFields { severityTier: number; priorityBand: number; effectiveRecurrence: number; firstSeenAt: number; id: string }

/** Work-queue order: severity tier, priority band, effective recurrence (desc), oldest first-seen. */
export function compareRank(a: RankFields, b: RankFields): number {
  return a.severityTier - b.severityTier || a.priorityBand - b.priorityBand ||
    b.effectiveRecurrence - a.effectiveRecurrence || a.firstSeenAt - b.firstSeenAt || a.id.localeCompare(b.id);
}

/** Review interval after the Nth hold: base until the third, then 28, 56, capped at 90 days. */
export function holdIntervalDays(holdCount: number, baseDays: number): number {
  if (holdCount <= 3) return baseDays;
  return Math.min(90, 14 * 2 ** (holdCount - 3));
}

/** Ignore-rate brake state machine over the rolling window (floor 8). */
export interface BrakeInput {
  /** The last ≤100 counted decisions, newest last: true = would-ignore. */
  window: readonly boolean[];
  /** Decisions in the last 24 hours. */
  last24h: number;
  /** Total decisions ever (to know whether the shadow baseline exists). */
  totalDecisions: number;
  /** Ignore share of the first 100 decisions, once they exist. */
  baseline: number | null;
  engaged: boolean;
}

export function evaluateBrake(input: BrakeInput): { engaged: boolean; share: number | null; threshold: number; release: number } {
  const baselineReady = input.baseline !== null && input.totalDecisions >= 100;
  const threshold = baselineReady ? input.baseline! + 0.25 : 0.95;
  const release = baselineReady ? input.baseline! + 0.15 : 0.85;
  if (input.last24h < 20 || input.window.length === 0) return { engaged: false, share: null, threshold, release };
  const share = input.window.filter(Boolean).length / input.window.length;
  // A small epsilon keeps 0.3 + 0.15 from reading as 0.4499… (a boundary share is inside the band).
  const engaged = input.engaged ? share > release + 1e-9 : share > threshold + 1e-9;
  return { engaged, share, threshold, release };
}

/** Quiet window for operator messages: never between 23:00 and 07:30 in the given time zone. */
export function inQuietWindow(now: Date, timeZone?: string): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const minutes = hour * 60 + minute;
  return minutes >= 23 * 60 || minutes < 7 * 60 + 30;
}

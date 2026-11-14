/**
 * MachineLoadAssessor — the model assessment of machine load (trustworthy
 * machine load, Part B4 / phase P4). Shadow-first, advisory.
 *
 * Spec: docs/specs/trustworthy-machine-load-and-mesh-floor.md §4 B4.
 *
 * When a machine's OWN load verdict and the OUTSIDE view of it disagree, or its
 * own readings contradict each other, a fast model labels the snapshot: Jev
 * first, GPT-6 Luna (the shared JevCascade referee) when Jev is unsure. Fifteen
 * minutes later the same pass checks what actually happened to that machine
 * (recovered / timed out / restarted / still overloaded) and grades the label.
 *
 * CONTRACT (why this is safe to ship):
 *   - It acts on NOTHING. No placement, admission, shed, attention item or
 *     message reads its output. It appends content-free rows to a JSONL log;
 *     a read route summarises that log.
 *   - It runs only on the machine holding the serving lease (single-machine:
 *     always), so the pool asks once per disagreement, not once per machine.
 *   - Dev-gated and read live: `intelligence.jevLoadAssessment.enabled`
 *     omitted ⇒ live on a development agent, dark on the fleet; explicit false
 *     is the kill switch, honoured at the next tick. Inert without the vault
 *     `typesafe_api_key`. Bounded: one call at a time, a per-machine cooldown,
 *     a daily call cap seeded from the log, a fetch timeout.
 *   - What leaves the machine is numbers, a machine nickname and fixed words;
 *     it is secret-scrubbed anyway before it is sent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scrubForStore } from './durableSecretScrub.js';
import { resolveDevAgentGate } from './devAgentGate.js';
import { readJsonlTailLines } from '../utils/jsonl-tail.js';
import { askReferee, DEFAULT_CASCADE_BAND, type CascadeQuestion } from './JevCascade.js';
import type { IntelligenceProvider, MachineCapacity } from './types.js';

export const JEV_LOAD_ASSESSMENT_FEATURE = 'jev-load-assessment';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const LOAD_ASSESSMENT_MODEL = 'jev-1.13.0';
export const LOAD_ASSESSMENT_DEFAULT_TIMEOUT_MS = 1500;
export const LOAD_ASSESSMENT_DEFAULT_DAILY_CAP = 200;
export const LOAD_ASSESSMENT_TICK_MS = 60_000;
/** The same machine with the same conflicts is asked about at most this often. */
export const SAME_CONFLICT_COOLDOWN_MS = 30 * 60_000;
/** Any machine is asked about at most this often, whatever changed. */
export const MACHINE_MIN_SPACING_MS = 10 * 60_000;
/** How long after a label its outcome is read. */
export const OUTCOME_WINDOW_MS = 15 * 60_000;
/** Pending outcomes older than this (e.g. across a long restart) are dropped. */
export const PENDING_MAX_AGE_MS = 2 * 60 * 60_000;
export const MAX_PENDING = 200;
/** A load report older than this is not used as the machine's own view. */
export const OWN_REPORT_MAX_AGE_MS = 10 * 60_000;
/** Below this round trip a live machine is "answering quickly". */
export const QUICK_RTT_MS = 2000;
export const SUMMARY_TAIL_BYTES = 5_000_000;
const KEY_REREAD_MS = 10 * 60_000;

// ── Labels ────────────────────────────────────────────────────────────────

export type LoadAssessmentLabel = 'healthy_busy' | 'overloaded' | 'impaired' | 'network_problem' | 'cannot_tell';

export const LOAD_ASSESSMENT_CRITERIA: Readonly<Record<LoadAssessmentLabel, string>> = {
  healthy_busy: 'Busy but healthy: the machine keeps up with its work; the conflicting reading is a known quirk (for example a load average inflated by threads waiting on disk, or memory the system counts as used but can reclaim or compress).',
  overloaded: 'Overloaded: the machine has more work than it can keep up with (CPU or memory exhausted, slow to answer) and is likely to stay slow or need work moved off it.',
  impaired: 'Impaired: something on the machine is broken or stuck (its agent server is frozen, memory is critically short) whatever its workload.',
  network_problem: 'Network problem: the machine itself looks healthy and the failures are in reaching it.',
  cannot_tell: 'There is too little or too contradictory evidence to tell.',
};
const INSTRUCTIONS = 'What best describes the state of this computer in a group of computers that share work?';

export function loadAssessmentQuestions(): Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> {
  return { state: { type: 'choice', instructions: INSTRUCTIONS, criteria: { ...LOAD_ASSESSMENT_CRITERIA } } };
}

/** The referee is asked one true/false statement per definite label. */
export function refereeQuestions(): CascadeQuestion[] {
  return (['healthy_busy', 'overloaded', 'impaired', 'network_problem'] as const).map((rule) => ({
    rule,
    instructions: LOAD_ASSESSMENT_CRITERIA[rule],
  }));
}

/** Exactly one true statement names the label; none or several is `cannot_tell`. */
export function labelFromReferee(answers: Record<string, boolean>): LoadAssessmentLabel {
  const yes = Object.entries(answers).filter(([, v]) => v === true).map(([k]) => k);
  return yes.length === 1 && yes[0] in LOAD_ASSESSMENT_CRITERIA ? (yes[0] as LoadAssessmentLabel) : 'cannot_tell';
}

// ── Trigger detection (pure) ────────────────────────────────────────────────

export type LoadConflict =
  | 'own-ok-but-unreachable'
  | 'own-impaired-but-answering'
  | 'memory-free-but-os-pressure'
  | 'memory-short-but-os-normal'
  | 'cpu-idle-but-load-high';

/**
 * The disagreements (own verdict vs outside view) and contradictions (signal vs
 * signal) present in one machine's pool row. Empty = nothing worth asking about.
 */
export function detectLoadConflicts(cap: MachineCapacity): LoadConflict[] {
  const out: LoadConflict[] = [];
  const r = cap.loadReport;
  const age = typeof cap.loadReportAgeMs === 'number' ? cap.loadReportAgeMs : Infinity;
  if (!r || age > OWN_REPORT_MAX_AGE_MS) return out;
  const live = cap.liveness?.state === 'live';
  const unreachable = cap.liveness?.state === 'unreachable'
    && (cap.liveness.shape === 'struggling' || cap.liveness.shape === 'refusing');
  if (unreachable && (r.verdict === 'ok' || r.verdict === 'elevated')) out.push('own-ok-but-unreachable');
  if (live && r.verdict === 'impaired' && typeof cap.lastPullRttMs === 'number' && cap.lastPullRttMs < QUICK_RTT_MS) {
    out.push('own-impaired-but-answering');
  }
  if (r.memAvailablePct !== null && r.memAvailablePct >= 30 && (r.memPressureNative === 'warn' || r.memPressureNative === 'critical')) {
    out.push('memory-free-but-os-pressure');
  }
  if (r.memAvailablePct !== null && r.memAvailablePct < 15 && r.memPressureNative === 'normal') {
    out.push('memory-short-but-os-normal');
  }
  if (r.cpuIdlePct !== null && r.cpuIdlePct >= 40 && r.loadPerCore !== null && r.loadPerCore > 1.5) {
    out.push('cpu-idle-but-load-high');
  }
  return out;
}

const fmt = (v: number | null | undefined, unit = '', digits = 0): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : 'unknown';

const CONFLICT_WORDS: Record<LoadConflict, string> = {
  'own-ok-but-unreachable': 'its own report says it is fine, but requests to it are failing',
  'own-impaired-but-answering': 'its own report says it is impaired, but it answers requests quickly',
  'memory-free-but-os-pressure': 'much memory reads as available, but the operating system reports memory pressure',
  'memory-short-but-os-normal': 'little memory reads as available, but the operating system reports normal memory pressure',
  'cpu-idle-but-load-high': 'the processor is mostly idle, but the load average is high',
};

/** The state text sent to the models: numbers and fixed words only. */
export function buildAssessmentState(cap: MachineCapacity, conflicts: LoadConflict[]): string {
  const r = cap.loadReport!;
  const l = cap.liveness;
  const lines = [
    `MACHINE: ${(cap.nickname ?? cap.machineId).slice(0, 60)} (${r.platform}, ${fmt(r.cores)} cores)`,
    `ITS OWN LOAD REPORT (${fmt((cap.loadReportAgeMs ?? 0) / 1000)} s old): verdict ${r.verdict}; CPU idle ${fmt(r.cpuIdlePct, '%')}; load per core ${fmt(r.loadPerCore, '', 2)}; memory available ${fmt(r.memAvailablePct, '%')}; operating-system memory pressure ${r.memPressureNative ?? 'unknown'}; agent-server event-loop delay (p99) ${fmt(r.eventLoopLagP99Ms, ' ms')}; sessions ${fmt(r.sessionsActive)} of ${fmt(r.sessionsMax)}; running ${fmt(r.uptimeS / 60)} min since start.`,
    `HOW IT ANSWERS FROM OUTSIDE: ${l ? `${l.state}${l.shape ? ` (${l.shape})` : ''}${l.lastFailure ? `, last failure ${l.lastFailure}` : ''}, last evidence ${fmt((l.evidenceAgeMs ?? NaN) / 1000)} s ago` : 'unknown'}; last round trip ${fmt(cap.lastPullRttMs, ' ms')}.`,
    `WHAT DISAGREES: ${conflicts.map((c) => CONFLICT_WORDS[c]).join('; ')}.`,
  ];
  return lines.join('\n');
}

// ── Outcome + grade (pure) ──────────────────────────────────────────────────

export type LoadOutcome = 'recovered' | 'still-overloaded' | 'timed-out' | 'restarted' | 'unknown';

export function readOutcome(cap: MachineCapacity | undefined, bootIdAtLabel: string): LoadOutcome {
  if (!cap) return 'unknown';
  if (cap.loadReport && cap.loadReport.bootId !== bootIdAtLabel) return 'restarted';
  const state = cap.liveness?.state;
  if (state === 'unreachable' || state === 'stale') return 'timed-out';
  if (state !== 'live') return 'unknown';
  const v = cap.loadVerdict;
  if (v === 'ok' || v === 'elevated') return 'recovered';
  if (v === 'saturated' || v === 'impaired') return 'still-overloaded';
  return 'unknown';
}

/**
 * healthy_busy predicts "it will be fine"; overloaded / impaired /
 * network_problem predict trouble. cannot_tell and an unknown outcome grade
 * `unknown` — never counted as right or wrong.
 */
export function gradeLabel(label: LoadAssessmentLabel, outcome: LoadOutcome): 'right' | 'wrong' | 'unknown' {
  if (label === 'cannot_tell' || outcome === 'unknown') return 'unknown';
  const fine = outcome === 'recovered';
  if (label === 'healthy_busy') return fine ? 'right' : 'wrong';
  return fine ? 'wrong' : 'right';
}

// ── Rows ───────────────────────────────────────────────────────────────────

export type LoadAssessmentSkipReason =
  | 'disabled-no-key' | 'daily-cap' | 'scrub-error' | 'timeout' | 'http-error' | 'model-mismatch' | 'no-answers';

const CALL_REASONS: ReadonlySet<string> = new Set(['timeout', 'http-error', 'model-mismatch', 'no-answers']);

export type LoadAssessmentRow =
  | {
      kind: 'check';
      ts: string;
      id: string;
      machineId: string;
      bootId: string;
      conflicts: LoadConflict[];
      ownVerdict: string;
      liveness: string;
      jevLabel: LoadAssessmentLabel;
      jevP: number;
      label: LoadAssessmentLabel;
      decidedBy: 'jev' | 'referee' | 'jev-referee-failed';
      refereeModel?: string;
      model: string;
      ms: number;
    }
  | { kind: 'outcome'; ts: string; id: string; machineId: string; label: LoadAssessmentLabel; outcome: LoadOutcome; grade: 'right' | 'wrong' | 'unknown' }
  | { kind: 'skipped'; ts: string; machineId?: string; reason: LoadAssessmentSkipReason };

// ── The assessor ────────────────────────────────────────────────────────────

export interface JevLoadAssessmentConfig {
  enabled?: boolean;
  model?: string;
  timeoutMs?: number;
  maxChecksPerDay?: number;
  /** The Luna referee for unsure answers; on unless explicitly false. */
  referee?: { enabled?: boolean; timeoutMs?: number };
}

export interface MachineLoadAssessorDeps {
  getConfig: () => JevLoadAssessmentConfig | undefined;
  readKey: () => string | null;
  capacities: () => MachineCapacity[];
  /** True on the machine that should ask (the serving-lease holder; single machine: always). */
  isAssessor: () => boolean;
  referee?: IntelligenceProvider | null;
  logPath: string;
  metrics?: { record(r: Record<string, unknown>): void } | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Pending { id: string; machineId: string; bootId: string; label: LoadAssessmentLabel; atMs: number }

export class MachineLoadAssessor {
  private readonly deps: MachineLoadAssessorDeps;
  private readonly lastAsked = new Map<string, { signature: string; atMs: number }>();
  private pending: Pending[] = [];
  private seeded = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cachedKey: string | null = null;
  private keyReadAt = -Infinity;
  private noKeyNoted = false;
  private day = '';
  private dayCalls = 0;
  private capNotedDay = '';

  /** Labels made before this process started cannot be graded fairly (see settleOutcomes). */
  private readonly startedAtMs: number;

  constructor(deps: MachineLoadAssessorDeps) {
    this.deps = deps;
    this.startedAtMs = this.now();
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  start(intervalMs = LOAD_ASSESSMENT_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Never throws; passes never overlap. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cfg = this.deps.getConfig();
      if (!cfg || cfg.enabled !== true) return;
      if (!this.seeded) this.seed();
      const caps = this.deps.capacities();
      // Outcomes are read on every machine that labelled something, even after
      // the lease moved away, so a label is never left ungraded by a handover.
      this.settleOutcomes(caps);
      if (!this.deps.isAssessor()) return;
      if (!this.cachedKey && this.now() - this.keyReadAt >= KEY_REREAD_MS) this.refreshKey();
      if (!this.cachedKey) {
        if (!this.noKeyNoted) { this.noKeyNoted = true; this.skip('disabled-no-key'); }
        return;
      }
      for (const cap of caps) {
        const conflicts = detectLoadConflicts(cap);
        if (conflicts.length === 0) continue;
        if (!this.due(cap.machineId, conflicts.join(','))) continue;
        if (!(await this.assess(cap, conflicts, cfg)) || !this.cachedKey) break;
      }
    } catch {
      // @silent-fallback-ok — an advisory instrument never surfaces an error; the next tick retries.
    } finally {
      this.running = false;
    }
  }

  private refreshKey(): void {
    this.keyReadAt = this.now();
    try {
      this.cachedKey = this.deps.readKey() || null;
    } catch {
      // @silent-fallback-ok — an unreadable vault means "no key"; recorded as disabled-no-key.
      this.cachedKey = null;
    }
  }

  private due(machineId: string, signature: string): boolean {
    const prev = this.lastAsked.get(machineId);
    if (!prev) return true;
    const since = this.now() - prev.atMs;
    if (since < MACHINE_MIN_SPACING_MS) return false;
    return prev.signature !== signature || since >= SAME_CONFLICT_COOLDOWN_MS;
  }

  private settleOutcomes(caps: MachineCapacity[]): void {
    const nowMs = this.now();
    const keep: Pending[] = [];
    for (const p of this.pending) {
      if (nowMs - p.atMs > PENDING_MAX_AGE_MS) continue;
      if (nowMs - p.atMs < OUTCOME_WINDOW_MS) { keep.push(p); continue; }
      // A label made before this process started is graded `unknown`: our own
      // restart changes our bootId (a restart is not overload), and right after
      // boot a peer reads `stale` until the first direct pull lands. Either would
      // bias the accuracy this log exists to measure.
      const outcome = p.atMs < this.startedAtMs
        ? 'unknown'
        : readOutcome(caps.find((c) => c.machineId === p.machineId), p.bootId);
      this.write({
        kind: 'outcome', ts: new Date(nowMs).toISOString(), id: p.id, machineId: p.machineId,
        label: p.label, outcome, grade: gradeLabel(p.label, outcome),
      });
    }
    this.pending = keep;
  }

  /** Labels one machine. Returns false when the pass should stop (daily cap). */
  private async assess(cap: MachineCapacity, conflicts: LoadConflict[], cfg: JevLoadAssessmentConfig): Promise<boolean> {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.day !== day) { this.day = day; this.dayCalls = this.countCallsOn(day); }
    const cap_ = typeof cfg.maxChecksPerDay === 'number' && cfg.maxChecksPerDay >= 0 ? cfg.maxChecksPerDay : LOAD_ASSESSMENT_DEFAULT_DAILY_CAP;
    if (this.dayCalls >= cap_) {
      if (this.capNotedDay !== day) { this.capNotedDay = day; this.skip('daily-cap'); }
      return false;
    }
    this.lastAsked.set(cap.machineId, { signature: conflicts.join(','), atMs: this.now() });
    const scrubbed = scrubForStore(buildAssessmentState(cap, conflicts));
    if (scrubbed.error || scrubbed.truncated) { this.skip('scrub-error', cap.machineId); return true; }

    this.dayCalls++;
    const model = cfg.model || LOAD_ASSESSMENT_MODEL;
    const timeoutMs = typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? Math.min(cfg.timeoutMs, 10_000) : LOAD_ASSESSMENT_DEFAULT_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const t0 = this.now();
    let outcome: 'fired' | 'noop' | 'error' = 'error';
    let tokensIn: number | undefined;
    let modelServed: string | undefined;
    let jev: { label: LoadAssessmentLabel; p: number } | null = null;
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cachedKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: scrubbed.text, model, questions: loadAssessmentQuestions() }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) { this.cachedKey = null; this.keyReadAt = this.now(); this.noKeyNoted = false; }
        this.skip('http-error', cap.machineId);
        return true;
      }
      const json = (await res.json()) as {
        model?: string;
        usage?: { input_tokens?: number };
        answers?: Record<string, { choice?: unknown; probabilities?: Record<string, unknown> }>;
      };
      modelServed = typeof json.model === 'string' ? json.model : undefined;
      tokensIn = json.usage?.input_tokens;
      if (modelServed !== model) { this.skip('model-mismatch', cap.machineId); return true; }
      jev = readJevChoice(json.answers?.state);
      if (!jev) { this.skip('no-answers', cap.machineId); return true; }
      outcome = jev.label === 'healthy_busy' || jev.label === 'cannot_tell' ? 'noop' : 'fired';
    } catch (err) {
      this.skip((err as Error)?.name === 'AbortError' ? 'timeout' : 'http-error', cap.machineId);
      return true;
    } finally {
      clearTimeout(timer);
      try {
        this.deps.metrics?.record({
          feature: JEV_LOAD_ASSESSMENT_FEATURE, kind: 'llm', outcome, tokensIn,
          tokensOut: 0, // TypeSafe does not bill output tokens
          latencyMs: this.now() - t0, model: modelServed ?? model, framework: 'typesafe-api',
        });
      } catch { /* @silent-fallback-ok — metering must never break the instrument */ }
    }

    // Jev unsure (top probability inside the cascade band) → the Luna referee.
    let label = jev.label;
    let decidedBy: 'jev' | 'referee' | 'jev-referee-failed' = 'jev';
    let refereeModel: string | undefined;
    const unsure = jev.p <= DEFAULT_CASCADE_BAND.hi;
    if (unsure && this.deps.referee && cfg.referee?.enabled !== false) {
      const ref = await askReferee(this.deps.referee, scrubbed.text, refereeQuestions(), {
        component: 'MachineLoadAssessor',
        category: 'sentinel',
        timeoutMs: cfg.referee?.timeoutMs,
        now: this.deps.now,
      });
      refereeModel = ref.model;
      if (ref.ok) { label = labelFromReferee(ref.answers); decidedBy = 'referee'; }
      else decidedBy = 'jev-referee-failed';
    }

    const id = randomUUID();
    this.write({
      kind: 'check', ts: new Date(t0).toISOString(), id, machineId: cap.machineId,
      bootId: cap.loadReport!.bootId, conflicts, ownVerdict: cap.loadReport!.verdict,
      liveness: cap.liveness ? `${cap.liveness.state}${cap.liveness.shape ? `:${cap.liveness.shape}` : ''}` : 'unknown',
      jevLabel: jev.label, jevP: jev.p, label, decidedBy,
      ...(refereeModel ? { refereeModel } : {}),
      model: modelServed ?? model, ms: this.now() - t0,
    });
    this.pending.push({ id, machineId: cap.machineId, bootId: cap.loadReport!.bootId, label, atMs: t0 });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    return true;
  }

  /** Restores ungraded labels from the log, so a restart still grades them. */
  private seed(): void {
    this.seeded = true;
    const rows = readRows(this.deps.logPath);
    const graded = new Set(rows.filter((r) => r.kind === 'outcome').map((r) => (r as { id: string }).id));
    const nowMs = this.now();
    for (const r of rows) {
      if (r.kind !== 'check' || graded.has(r.id)) continue;
      const atMs = Date.parse(r.ts);
      if (!Number.isFinite(atMs) || nowMs - atMs > PENDING_MAX_AGE_MS) continue;
      this.pending.push({ id: r.id, machineId: r.machineId, bootId: r.bootId, label: r.label, atMs });
      this.lastAsked.set(r.machineId, { signature: r.conflicts.join(','), atMs });
    }
    this.pending = this.pending.slice(-MAX_PENDING);
  }

  private countCallsOn(day: string): number {
    let n = 0;
    for (const r of readRows(this.deps.logPath)) {
      if (!r.ts.startsWith(day)) continue;
      if (r.kind === 'check' || (r.kind === 'skipped' && CALL_REASONS.has(r.reason))) n++;
    }
    return n;
  }

  private skip(reason: LoadAssessmentSkipReason, machineId?: string): void {
    this.write({ kind: 'skipped', ts: new Date(this.now()).toISOString(), ...(machineId ? { machineId } : {}), reason });
  }

  private write(row: LoadAssessmentRow): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      fs.appendFileSync(this.deps.logPath, JSON.stringify(row) + '\n');
    } catch {
      // @silent-fallback-ok — an unwritable advisory log loses rows, never work.
    }
  }

  summary(): LoadAssessmentSummary {
    return summarizeLoadAssessmentLog(this.deps.logPath, this.deps.getConfig()?.enabled === true, this.pending.length);
  }
}

function readJevChoice(a: { choice?: unknown; probabilities?: Record<string, unknown> } | undefined): { label: LoadAssessmentLabel; p: number } | null {
  if (!a || typeof a.choice !== 'string' || !(a.choice in LOAD_ASSESSMENT_CRITERIA)) return null;
  const p = a.probabilities?.[a.choice];
  if (typeof p !== 'number' || !Number.isFinite(p)) return null;
  return { label: a.choice as LoadAssessmentLabel, p };
}

function readRows(logPath: string): LoadAssessmentRow[] {
  const rows: LoadAssessmentRow[] = [];
  for (const line of readJsonlTailLines(logPath, SUMMARY_TAIL_BYTES).lines) {
    try {
      const r = JSON.parse(line) as LoadAssessmentRow;
      if (r && typeof r.ts === 'string' && (r.kind === 'check' || r.kind === 'outcome' || r.kind === 'skipped')) rows.push(r);
    } catch { /* @silent-fallback-ok — a torn line is skipped */ }
  }
  return rows;
}

export interface LoadAssessmentSummary {
  enabled: boolean;
  since: string | null;
  checks: number;
  labels: Record<string, number>;
  decidedBy: Record<string, number>;
  conflicts: Record<string, number>;
  outcomes: Record<string, number>;
  grades: { right: number; wrong: number; unknown: number };
  /** right / (right + wrong); null until anything was graded right or wrong. */
  accuracy: number | null;
  pendingOutcomes: number;
  skipped: Record<string, number>;
}

export function summarizeLoadAssessmentLog(logPath: string, enabled: boolean, pendingOutcomes = 0): LoadAssessmentSummary {
  const out: LoadAssessmentSummary = {
    enabled, since: null, checks: 0, labels: {}, decidedBy: {}, conflicts: {}, outcomes: {},
    grades: { right: 0, wrong: 0, unknown: 0 }, accuracy: null, pendingOutcomes, skipped: {},
  };
  for (const r of readRows(logPath)) {
    if (!out.since) out.since = r.ts;
    if (r.kind === 'skipped') { out.skipped[r.reason] = (out.skipped[r.reason] ?? 0) + 1; continue; }
    if (r.kind === 'outcome') {
      out.outcomes[r.outcome] = (out.outcomes[r.outcome] ?? 0) + 1;
      out.grades[r.grade]++;
      continue;
    }
    out.checks++;
    out.labels[r.label] = (out.labels[r.label] ?? 0) + 1;
    out.decidedBy[r.decidedBy] = (out.decidedBy[r.decidedBy] ?? 0) + 1;
    for (const c of r.conflicts) out.conflicts[c] = (out.conflicts[c] ?? 0) + 1;
  }
  const decided = out.grades.right + out.grades.wrong;
  out.accuracy = decided > 0 ? out.grades.right / decided : null;
  return out;
}

// ── Production wiring ───────────────────────────────────────────────────────

let installed: MachineLoadAssessor | null = null;
export function installMachineLoadAssessor(a: MachineLoadAssessor | null): void {
  if (installed && installed !== a) installed.stop();
  installed = a;
}
export function getMachineLoadAssessor(): MachineLoadAssessor | null { return installed; }

/** The production factory, shared by server.ts and the E2E test. */
export function buildMachineLoadAssessor(opts: {
  readLiveIntelligence: () => unknown;
  bootBlock?: JevLoadAssessmentConfig;
  developmentAgent?: boolean;
  readSecret: (name: string) => unknown;
  capacities: () => MachineCapacity[];
  isAssessor: () => boolean;
  referee?: IntelligenceProvider | null;
  stateDir: string;
  metrics?: MachineLoadAssessorDeps['metrics'];
  fetchImpl?: typeof fetch;
  now?: () => number;
}): MachineLoadAssessor {
  return new MachineLoadAssessor({
    getConfig: () => {
      const intel = opts.readLiveIntelligence();
      const live = intel && typeof intel === 'object' ? (intel as Record<string, unknown>).jevLoadAssessment : undefined;
      const block = (live && typeof live === 'object' ? live : opts.bootBlock ?? {}) as JevLoadAssessmentConfig;
      const enabled = resolveDevAgentGate(typeof block.enabled === 'boolean' ? block.enabled : undefined, { developmentAgent: opts.developmentAgent });
      return { ...block, enabled };
    },
    readKey: () => {
      const v = opts.readSecret('typesafe_api_key');
      return typeof v === 'string' && v ? v : null;
    },
    capacities: opts.capacities,
    isAssessor: opts.isAssessor,
    referee: opts.referee ?? null,
    logPath: path.join(opts.stateDir, '..', 'logs', 'machine-load-assessment.jsonl'),
    metrics: opts.metrics,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
  });
}

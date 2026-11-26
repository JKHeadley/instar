/**
 * MaturationLadderService — measures every ladder and raises what is worth a
 * decision. It holds no authority to move a feature: the recurring review's
 * model decides, and POST /maturation/moves only enforces floors in front of
 * that decision. Spec: docs/specs/feature-maturation-ladder.md §6-§8.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Initiative, RolloutStage, MaturationEvaluationContract } from '../core/InitiativeTracker.js';
import { maybeRotateJsonlSegment } from '../utils/jsonl-rotation.js';
import { readJsonlQueries, RAN_FRESH_DAYS, type JsonlQuery } from './LadderEvidenceReader.js';
import {
  computeLadderState,
  contractForRung,
  crossedRung,
  deriveLadderRung,
  nextRung,
  parseLadderRegistry,
  projectionRef,
  raiseDue,
  LADDER_RESPONSE_SCHEMA,
  type EvaluationRow,
  type FeatureMetricsRef,
  type FeatureSummaryRef,
  type GuardPostureRef,
  type JsonlLogRef,
  type LadderEntry,
  type RungAdvance,
  type LadderMetric,
  type LadderRegistry,
  type LadderState,
  type MetricReading,
  type MetricView,
  type ObservedRung,
  type TargetRung,
} from './MaturationLadder.js';

/** The shipped registry, beside this module's package root. */
export function readShippedRegistry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.resolve(here, '..', '..', 'src', 'data', 'feature-ladders.json'), 'utf-8');
}

export const LADDER_AUDIT_FILE = 'logs/maturation-advances.jsonl';
export const MAX_RAISES_PER_PASS = 5;
const DAY_MS = 86_400_000;
const RAISE_ORDER: LadderState[] = ['harmed', 'ready-to-advance', 'not-started'];
const STUCK_READY_DAYS = 7;
const STUCK_BLIND_DAYS = 30;
const VIEW_CACHE_MS = 30_000;
const MAX_SAMPLES = 100_000;

export interface MetricsSummaryRow { feature: string; realLlmCalls?: number; errorRate?: number | null; fireRate?: number | null }

export interface MaturationLadderDeps {
  projectDir: string;
  machine: string;
  now?: () => number;
  /** The registry text; a test seam. Defaults to the shipped file. */
  readRegistry: () => string;
  /** The agent's config, re-read from disk. Null when it cannot be read. */
  readLiveConfig: () => Record<string, unknown> | null;
  shippedDefaults: () => unknown;
  d7: {
    registerMaturationProjection(ref: string, read: () => { value: number; samples: number } | null): void;
    readMaturationProjection(ref: string): { value: number; samples: number } | null;
    maturationContractHash(contract: ReturnType<typeof contractForRung>): string;
    evaluations(sinceMs: number): Array<{ featureId: string; status: string; dueSlotMs: number; contractHash: string }>;
  } | null;
  /** Feature-metrics rollups for a window. */
  featureMetrics: ((sinceHours: number) => MetricsSummaryRow[]) | null;
  /** Each guard's effective posture. */
  guardEffective: (() => Map<string, string>) | null;
  commitments: {
    record(input: Record<string, unknown>): { id: string };
    getActive(): Array<{ externalKey?: string; id: string }>;
  } | null;
  /** True on the machine that speaks for this agent (always true when alone). */
  holdsLease: () => boolean;
  /** Set only where a review reads what gets raised. */
  reviewTopic: () => number | null;
  /** Flags that must match across machines. */
  isCoherenceCritical: (configPath: string) => boolean;
  /** Writes one setting. Must persist or fail observably. */
  setConfig: (dotPath: string, value: unknown) => void;
  isDevelopmentAgent: () => boolean;
}

export interface LadderFeatureView {
  id: string;
  subject: string;
  title: string;
  aliases: string[];
  flagPath: string | null;
  rung: ObservedRung;
  flagMissing: boolean;
  next: TargetRung | null;
  state: LadderState;
  because?: string;
  final: LadderEntry['final'];
  risk: LadderEntry['risk'];
  rare: boolean;
  tracking: LadderEntry['tracking'];
  composedInto?: string;
  soak: { days: number; needed: number };
  metrics: MetricView[];
  passing: number;
  total: number;
  /** What a config move would write, and what is there now. */
  move: null | { kind: string; set?: Record<string, unknown>; from?: Record<string, unknown>; restartNeeded?: boolean };
  lastMove: { moveId: string; at: string; action: string } | null;
  stuckDays: number | null;
  stuck: 'stuck-ready' | 'stuck-blind' | 'stuck-rare' | null;
}

export interface LadderCounts {
  total: number;
  byState: Record<string, number>;
  byRung: Record<string, number>;
  withThresholds: number;
  trackingNeeded: number;
  preferenceOff: number;
  stuckReady: number;
  stuckBlind: number;
  stuckRare: number;
}

export type MoveRefusal =
  | 'unknown-feature' | 'not-ready' | 'not-a-config-move' | 'sensitive' | 'held'
  | 'not-a-development-agent' | 'changed-since-read' | 'write-not-verified' | 'not-found' | 'changed-since-move' | 'not-applied';

export type MoveResult =
  | { ok: true; moveId: string; state: 'applied'; old: Record<string, unknown>; set: Record<string, unknown>; restartNeeded?: boolean }
  | { ok: false; refused: MoveRefusal; detail?: string; moveId?: string };

interface AuditRow {
  at: string;
  action: 'raise' | 'rung-observed' | 'move-intent' | 'move-applied' | 'move-failed' | 'revert-applied' | 'revert-refused';
  id: string;
  moveId?: string;
  [k: string]: unknown;
}

const ABSENT = '__absent__';

/**
 * The kind of move a feature's next step really is. The view and `applyMove` both read this,
 * so the ladder cannot offer a setting that is really a code move. From dark, only an entry's `start` is a
 * setting (spec section 8); a rung's config move is for a feature already running there, so a
 * dark feature with no `start` reaches that rung through reviewed code.
 */
function nextAdvance(entry: LadderEntry, rung: string, rungAdvance: RungAdvance | undefined): RungAdvance | undefined {
  if (rung !== 'dark') return rungAdvance;
  if (entry.start) return { kind: 'config', set: entry.start.set };
  return rungAdvance?.kind === 'config' ? { kind: 'code' } : rungAdvance;
}

function readPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? ABSENT) === JSON.stringify(b ?? ABSENT);
}

/** A `ran` metric must be recent. A rare feature's bar is its whole window: it may fire less than weekly. */
function ranFreshDays(m: LadderMetric, rare: boolean): number {
  return rare ? m.windowDays : Math.min(RAN_FRESH_DAYS, m.windowDays);
}

export class MaturationLadderService {
  private registry: LadderRegistry | null = null;
  private registryError: string | null = null;
  private readings = new Map<string, Omit<MetricReading, 'metric'>>();
  private afterMoveReadings = new Map<string, Omit<MetricReading, 'metric'>>();
  private readonly lastRaisedAt = new Map<string, number>();
  private readonly lastObservedRung = new Map<string, string>();
  private readonly lastRungChangeAt = new Map<string, number>();
  private readonly lastMoves = new Map<string, { moveId: string; at: number; action: string; set: Record<string, unknown>; old: Record<string, unknown> }>();
  private viewCache: { at: number; features: LadderFeatureView[] } | null = null;
  private lastRefreshAt: number | null = null;
  private configReadable = true;
  private readonly now: () => number;
  private readonly auditPath: string;

  constructor(private readonly deps: MaturationLadderDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.auditPath = path.join(deps.projectDir, LADDER_AUDIT_FILE);
    this.loadRegistry();
    this.loadAudit();
    this.registerProjections();
  }

  private loadRegistry(): void {
    let text: string;
    try { text = this.deps.readRegistry(); } catch { // @silent-fallback-ok — reported on every response as ladder-file-unreadable
      this.registry = null;
      this.registryError = 'ladder-file-unreadable';
      return;
    }
    const parsed = parseLadderRegistry(text);
    if (parsed.ok) {
      this.registry = parsed.registry;
      this.registryError = null;
    } else {
      this.registry = null;
      this.registryError = `ladder-file-invalid:${parsed.reason}`;
    }
  }

  get error(): string | null { return this.registryError; }
  get entries(): LadderEntry[] { return this.registry?.entries ?? []; }

  private loadAudit(): void {
    let text = '';
    try { text = fs.readFileSync(this.auditPath, 'utf-8'); } catch { return; } // @silent-fallback-ok — no audit yet means nothing was raised or moved
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row: AuditRow;
      try { row = JSON.parse(line) as AuditRow; } catch { continue; }
      this.applyAuditRow(row);
    }
  }

  private applyAuditRow(row: AuditRow): void {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) return;
    if (row.action === 'raise') this.lastRaisedAt.set(row.id, at);
    if (row.action === 'rung-observed') {
      this.lastObservedRung.set(row.id, String(row.to));
      // A rung that changed by any route (a code move, a person) arms the same watch. First sight does not.
      if (row.from) this.lastRungChangeAt.set(row.id, at);
    }
    if (row.action === 'move-applied' && row.moveId) {
      this.lastMoves.set(row.id, { moveId: row.moveId, at, action: 'applied', set: (row.set ?? {}) as Record<string, unknown>, old: (row.old ?? {}) as Record<string, unknown> });
    }
    if (row.action === 'revert-applied' && row.moveId) {
      const cur = this.lastMoves.get(row.id);
      if (cur && cur.moveId === row.moveId) this.lastMoves.set(row.id, { ...cur, action: 'reverted' });
    }
  }

  private audit(row: AuditRow): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
      maybeRotateJsonlSegment(this.auditPath, { maxBytes: 10 * 1024 * 1024, archive: true });
      fs.appendFileSync(this.auditPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } finally {
      this.applyAuditRow(row);
    }
  }

  private registerProjections(): void {
    const d7 = this.deps.d7;
    if (!d7) return;
    for (const entry of this.entries) {
      for (const rung of Object.values(entry.rungs)) {
        for (const m of rung?.metrics ?? []) {
          if (m.source === 'feature-summary') continue;
          const ref = projectionRef(m);
          d7.registerMaturationProjection(ref, () => {
            const r = this.readings.get(ref);
            if (!r || r.value === null) return null;
            return { value: r.value, samples: Math.min(MAX_SAMPLES, Math.max(0, Math.round(r.samples))) };
          });
        }
      }
    }
  }

  // ── Evidence ─────────────────────────────────────────────────────────────

  private rungsOf(entry: LadderEntry, live: Record<string, unknown> | null): { rung: ObservedRung; flagMissing: boolean; target: TargetRung | null } {
    const { rung, flagMissing } = deriveLadderRung(entry, live ?? {}, this.deps.shippedDefaults());
    return { rung, flagMissing, target: nextRung(entry, rung) };
  }

  /** When this feature's post-move watch began: its last applied move or observed rung change. */
  private watchStart(id: string): number | null {
    const move = this.lastMoves.get(id);
    const applied = move && move.action === 'applied' ? move.at : null;
    const observed = this.lastRungChangeAt.get(id) ?? null;
    if (applied === null) return observed;
    return observed === null ? applied : Math.max(applied, observed);
  }

  /** Read every metric a pass needs. Async and off the event loop; call before D7 scores. */
  async refresh(): Promise<void> {
    const now = this.now();
    const live = this.deps.readLiveConfig();
    this.configReadable = live !== null;
    const current: Array<{ key: string; m: LadderMetric; sinceMs: number; rare?: boolean }> = [];
    const after: Array<{ key: string; m: LadderMetric; sinceMs: number; rare?: boolean }> = [];
    const seen = new Set<string>();
    for (const entry of this.entries) {
      for (const rung of Object.values(entry.rungs)) {
        for (const m of rung?.metrics ?? []) {
          const key = projectionRef(m);
          if (seen.has(key)) continue;
          seen.add(key);
          current.push({ key, m, sinceMs: now - m.windowDays * DAY_MS, rare: entry.rare });
        }
      }
      const { rung } = this.rungsOf(entry, live);
      const lastRung = this.lastObservedRung.get(entry.id);
      // An unreadable config would read every rung as dark: that is not a rung change.
      if (live !== null && lastRung !== rung && !entry.composedInto) {
        try {
          this.audit({ at: new Date(now).toISOString(), action: 'rung-observed', id: entry.id, from: lastRung ?? null, to: rung });
        } catch { /* @silent-fallback-ok — a lost row re-observes next pass */ }
      }
      const watchFrom = this.watchStart(entry.id);
      if (watchFrom !== null) {
        for (const m of crossedRung(entry, rung)?.metrics ?? []) {
          if (m.role === 'quality') continue;
          after.push({ key: `after:${entry.id}:${m.id}`, m, sinceMs: Math.max(watchFrom, now - m.windowDays * DAY_MS), rare: entry.rare });
        }
      }
    }
    const readings = new Map<string, Omit<MetricReading, 'metric'>>();
    const afterReadings = new Map<string, Omit<MetricReading, 'metric'>>();
    await this.readInto(current, readings, now);
    await this.readInto(after, afterReadings, now);
    this.readings = readings;
    this.afterMoveReadings = afterReadings;
    this.lastRefreshAt = now;
    this.viewCache = null;
  }

  private async readInto(
    items: Array<{ key: string; m: LadderMetric; sinceMs: number; rare?: boolean }>,
    out: Map<string, Omit<MetricReading, 'metric'>>,
    now: number,
  ): Promise<void> {
    const queries: JsonlQuery[] = [];
    const entryRare = new Map<string, boolean>();
    for (const { key, rare } of items) entryRare.set(key, rare === true);
    let guards: Map<string, string> | null = null;
    const metricCache = new Map<number, MetricsSummaryRow[] | null>();
    for (const { key, m, sinceMs } of items) {
      switch (m.source) {
        case 'jsonl-log':
          queries.push({
            key, ref: m.ref as JsonlLogRef, sinceMs, direction: m.direction,
            ...(m.role === 'ran' ? { freshWithinMs: ranFreshDays(m, entryRare.get(key) === true) * DAY_MS } : {}),
          });
          break;
        case 'feature-metrics': {
          const ref = m.ref as FeatureMetricsRef;
          // Same rule as logs: a crashed feature must not hold its numbers for the whole window.
          const days = m.role === 'ran' ? ranFreshDays(m, entryRare.get(key) === true) : m.windowDays;
          const hours = Math.max(1, Math.ceil(Math.min(now - sinceMs, days * DAY_MS) / 3_600_000));
          if (!metricCache.has(hours)) {
            try { metricCache.set(hours, this.deps.featureMetrics?.(hours) ?? null); } catch { metricCache.set(hours, null); }
          }
          const rows = metricCache.get(hours);
          const row = rows?.find(r => r.feature === ref.feature);
          if (!rows) out.set(key, { value: null, samples: 0, newestAt: null, reason: 'metrics-unavailable' });
          else if (!row) out.set(key, { value: m.role === 'ran' ? 0 : null, samples: 0, newestAt: null });
          else {
            const value = row[ref.field];
            out.set(key, { value: typeof value === 'number' ? value : null, samples: row.realLlmCalls ?? 0, newestAt: null });
          }
          break;
        }
        case 'guard-posture': {
          if (!guards) {
            try { guards = this.deps.guardEffective?.() ?? new Map(); } catch { guards = new Map(); }
          }
          const effective = guards.get((m.ref as GuardPostureRef).key);
          out.set(key, effective === undefined
            ? { value: null, samples: 0, newestAt: null, reason: 'guard-unknown' }
            : { value: effective === 'on-confirmed' ? 1 : 0, samples: 1, newestAt: null });
          break;
        }
        case 'feature-summary': {
          const r = this.deps.d7?.readMaturationProjection((m.ref as FeatureSummaryRef).ref) ?? null;
          out.set(key, r ? { value: r.value, samples: r.samples, newestAt: null } : { value: null, samples: 0, newestAt: null, reason: 'projection-unavailable' });
          break;
        }
      }
    }
    const answers = await readJsonlQueries(this.deps.projectDir, queries, now);
    for (const [key, r] of answers) out.set(key, r);
  }

  // ── D7 subjects ──────────────────────────────────────────────────────────

  /** The scorer's input: its own initiatives, with ladder contracts and in-memory subjects added. */
  subjects(initiatives: Initiative[]): Initiative[] {
    if (!this.registry) return initiatives;
    const live = this.deps.readLiveConfig();
    if (live === null) return initiatives;
    const byId = new Map(initiatives.map(i => [i.id, i]));
    const extra: Initiative[] = [];
    for (const entry of this.entries) {
      if (entry.disposition !== 'ladder') continue;
      const { rung, target } = this.rungsOf(entry, live);
      if (!target || rung === 'dark') continue;
      const rungDef = entry.rungs[target];
      if (!rungDef) continue;
      const contract = contractForRung(rungDef);
      const stage: RolloutStage = rung === 'dry-run' ? 'dry-run' : 'live';
      const existing = byId.get(entry.subject);
      // Independent target resolution reports this owner collision; never lend
      // a feature's contract or projections to a generic measurement initiative.
      if (existing?.measurement !== undefined) continue;
      if (existing) {
        byId.set(entry.subject, {
          ...existing,
          ...(existing.rollout ? { rollout: { ...existing.rollout, maturationEvaluation: contract, maturationContractError: undefined } } : { rollout: { flagPath: entry.flag?.path ?? entry.id, stage, maturationEvaluation: contract } }),
          ...(existing.rolloutAccounting ? { rolloutAccounting: { ...existing.rolloutAccounting, maturationEvaluation: contract, maturationContractError: undefined } } : {}),
        });
      } else {
        extra.push({ id: entry.subject, title: entry.title, rollout: { flagPath: entry.flag?.path ?? entry.id, stage, maturationEvaluation: contract } } as unknown as Initiative);
      }
    }
    return [...byId.values(), ...extra];
  }

  // ── Views ────────────────────────────────────────────────────────────────

  /** Exact retained contracts for measurement reads. Unlike features(), this
   * never uses the UI view cache to choose the live rung's contract. */
  measurementContracts(): Map<string, { contract: MaturationEvaluationContract | undefined; overridesInitiative: boolean }> | null {
    if (!this.registry) return null;
    const live = this.deps.readLiveConfig();
    if (live === null) return null;
    const out = new Map<string, { contract: MaturationEvaluationContract | undefined; overridesInitiative: boolean }>();
    for (const entry of this.entries) {
      if (entry.disposition !== 'ladder') continue;
      const { rung, target } = this.rungsOf(entry, live);
      const definition = entry.rungs[target ?? 'fleet'];
      out.set(entry.subject, { contract: definition ? contractForRung(definition) : undefined,
        overridesInitiative: Boolean(target && rung !== 'dark' && definition) });
    }
    return out;
  }

  private heldReason(live: Record<string, unknown> | null, entry: LadderEntry): string | null {
    const holds = readPath(live, 'maturation.ladder.holds') as Record<string, unknown> | undefined;
    const h = holds?.[entry.id];
    return typeof h === 'string' && h.trim() ? h.trim() : null;
  }

  features(): LadderFeatureView[] {
    const now = this.now();
    if (this.viewCache && now - this.viewCache.at < VIEW_CACHE_MS) return this.viewCache.features;
    const live = this.deps.readLiveConfig();
    const rows = this.deps.d7?.evaluations(now - 62 * DAY_MS) ?? [];
    const bySubject = new Map<string, EvaluationRow[]>();
    for (const r of rows) {
      const list = bySubject.get(r.featureId) ?? [];
      list.push(r);
      bySubject.set(r.featureId, list);
    }
    const out: LadderFeatureView[] = [];
    for (const entry of this.entries) {
      const { rung, flagMissing, target } = this.rungsOf(entry, live);
      const rungDef = target ? entry.rungs[target] : undefined;
      const readingFor = (m: LadderMetric, map: Map<string, Omit<MetricReading, 'metric'>>, key: string): MetricReading => {
        const r = map.get(key);
        return { metric: m, value: r?.value ?? null, samples: r?.samples ?? 0, newestAt: r?.newestAt ?? null,
          ...(r?.coverageDays !== undefined ? { coverageDays: r.coverageDays } : {}),
          ...(r?.reason ? { reason: r.reason } : {}) };
      };
      const move = this.lastMoves.get(entry.id);
      const watchFrom = this.watchStart(entry.id);
      const afterMove = watchFrom !== null
        ? (crossedRung(entry, rung)?.metrics ?? []).filter(m => m.role !== 'quality').map(m => readingFor(m, this.afterMoveReadings, `after:${entry.id}:${m.id}`))
        : [];
      // At its last rung there is no next bar, so show the rung it crossed. A number under
      // the post-move watch is the one that judged it, so `harmed` shows why and when it clears.
      const shown = target ? rungDef : crossedRung(entry, rung);
      const readings = (shown?.metrics ?? []).map(m => {
        const after = `after:${entry.id}:${m.id}`;
        return !target && watchFrom !== null && this.afterMoveReadings.has(after)
          ? readingFor(m, this.afterMoveReadings, after)
          : readingFor(m, this.readings, projectionRef(m));
      });
      const contract = rungDef ? contractForRung(rungDef) : null;
      const evaluations = bySubject.get(entry.subject) ?? [];
      const result = computeLadderState({
        entry, rung, target, readings, afterMove, evaluations,
        contractHash: contract && this.deps.d7 ? this.deps.d7.maturationContractHash(contract) : null,
        now, lastMoveAt: watchFrom, heldReason: this.heldReason(live, entry),
      });
      let stuckDays: number | null = null;
      let stuck: LadderFeatureView['stuck'] = null;
      if (result.state === 'ready-to-advance') {
        stuckDays = Math.max(0, result.soak.days - result.soak.needed);
        if (stuckDays >= STUCK_READY_DAYS) stuck = 'stuck-ready';
      } else if (result.state === 'no-data' || result.state === 'no-opportunity') {
        const sorted = [...evaluations].sort((a, b) => a.dueSlotMs - b.dueSlotMs);
        stuckDays = sorted.length ? Math.floor((now - sorted[0].dueSlotMs) / DAY_MS) : 0;
        if (stuckDays >= STUCK_BLIND_DAYS) stuck = result.state === 'no-data' ? 'stuck-blind' : 'stuck-rare';
      }
      const adv = nextAdvance(entry, rung, rungDef?.advance);
      out.push({
        id: entry.id,
        subject: entry.subject,
        title: entry.title,
        aliases: entry.aliases,
        flagPath: entry.flag?.path ?? null,
        rung,
        flagMissing,
        next: target,
        state: result.state,
        ...(result.because ? { because: result.because } : {}),
        final: entry.final,
        risk: entry.risk,
        rare: entry.rare === true,
        tracking: entry.tracking,
        ...(entry.composedInto ? { composedInto: entry.composedInto } : {}),
        soak: result.soak,
        metrics: result.metrics,
        passing: result.passing,
        total: result.total,
        move: adv ? (adv.kind === 'config'
          ? { kind: 'config', set: adv.set, from: Object.fromEntries(Object.keys(adv.set).map(k => [k, readPath(live, k) ?? null])), ...(entry.restartNeeded ? { restartNeeded: true } : {}) }
          : { kind: adv.kind }) : null,
        lastMove: move ? { moveId: move.moveId, at: new Date(move.at).toISOString(), action: move.action } : null,
        stuckDays,
        stuck,
      });
    }
    // A composed flag moves with its parent, so it shows the parent's state.
    const byId = new Map(out.map(f => [f.id, f]));
    for (const f of out) {
      if (f.composedInto) f.because = byId.get(f.composedInto)?.state;
    }
    this.viewCache = { at: now, features: out };
    return out;
  }

  counts(features = this.features()): LadderCounts {
    const c: LadderCounts = { total: features.length, byState: {}, byRung: {}, withThresholds: 0, trackingNeeded: 0, preferenceOff: 0, stuckReady: 0, stuckBlind: 0, stuckRare: 0 };
    for (const f of features) {
      c.byState[f.state] = (c.byState[f.state] ?? 0) + 1;
      c.byRung[f.rung] = (c.byRung[f.rung] ?? 0) + 1;
      if (f.total > 0) c.withThresholds++;
      if (f.tracking.state === 'needed' && f.state !== 'composed' && f.state !== 'retire-pending') c.trackingNeeded++;
      if (f.final === 'default-off-by-preference') c.preferenceOff++;
      if (f.stuck === 'stuck-ready') c.stuckReady++;
      if (f.stuck === 'stuck-blind') c.stuckBlind++;
      if (f.stuck === 'stuck-rare') c.stuckRare++;
    }
    return c;
  }

  response(id?: string): Record<string, unknown> {
    const features = this.features();
    const selected = id ? features.filter(f => f.id === id || f.aliases.includes(id) || f.subject === id) : features;
    return {
      schema: LADDER_RESPONSE_SCHEMA,
      advisory: true,
      generatedAt: new Date(this.now()).toISOString(),
      machine: this.deps.machine,
      registry: this.registryError ?? 'ok',
      configReadable: this.configReadable,
      evidenceReadAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null,
      counts: this.counts(features),
      features: selected,
    };
  }

  // ── Raising ──────────────────────────────────────────────────────────────

  /** Record what is worth a decision. A record, not a message; the review reads it. */
  /* @self-action-controller: maturation-ladder-raise */
  raise(): string[] {
    const topic = this.deps.reviewTopic();
    if (!topic || !this.deps.commitments || !this.deps.holdsLease()) return [];
    // Unreadable config reads every feature as off; never raise on that.
    if (this.deps.readLiveConfig() === null) return [];
    this.viewCache = null;
    const now = this.now();
    const features = this.features();
    const open = new Set(this.deps.commitments.getActive().map(c => c.externalKey).filter(Boolean));
    const raised: string[] = [];
    for (const state of RAISE_ORDER) {
      for (const f of features) {
        if (raised.length >= MAX_RAISES_PER_PASS) return raised;
        if (f.state !== state) continue;
        // A sensitive feature that is off stays off until its operator says otherwise; only a preference final can close it.
        if (state === 'not-started' && f.risk === 'sensitive') continue;
        const key = `maturation:${f.id}`;
        if (open.has(key)) continue;
        if (!raiseDue(state, this.lastRaisedAt.get(f.id), now)) continue;
        const evidence = f.metrics.map(m => `${m.id}=${m.value ?? 'none'} (${m.direction} ${m.threshold}, ${m.samples} samples)`).join('; ');
        const ask = state === 'harmed' ? `Look at ${f.title}: it reads harmed (${f.because ?? 'a harm bar failed'}) since its last move.`
          : state === 'not-started' ? `Decide how to start ${f.title}: nothing runs it, so no number can exist yet.`
            : `Decide whether ${f.title} moves to ${f.next}: its numbers have held for ${f.soak.days} days.`;
        try {
          const c = this.deps.commitments.record({
            type: 'one-time-action',
            topicId: topic,
            owner: 'agent',
            blockedOn: 'none',
            beaconEnabled: false,
            externalKey: key,
            source: 'agent',
            userRequest: ask,
            agentResponse: `Raised by the maturation ladder for the next review. ${evidence}`.slice(0, 1000),
          });
          this.audit({ at: new Date(now).toISOString(), action: 'raise', id: f.id, state, commitment: c.id, rung: f.rung, next: f.next, metrics: f.metrics, soak: f.soak });
          raised.push(f.id);
        } catch { /* @silent-fallback-ok — not recorded as raised, so the next pass retries */ }
      }
    }
    return raised;
  }

  // ── Moves ────────────────────────────────────────────────────────────────

  private readConfigFresh(): Record<string, unknown> | null {
    return this.deps.readLiveConfig();
  }

  /** Apply a decision the review's model already made. Every floor here can only refuse. */
  applyMove(input: {
    id: string;
    target: TargetRung;
    reason: string;
    from: Record<string, unknown>;
    opinions: unknown[];
  }): MoveResult {
    this.viewCache = null;
    const feature = this.features().find(f => f.id === input.id);
    const entry = this.entries.find(e => e.id === input.id);
    if (!feature || !entry) return { ok: false, refused: 'unknown-feature' };
    if (feature.state === 'held') return { ok: false, refused: 'held', detail: feature.because };
    const startable = feature.state === 'not-started';
    if (!startable && feature.state !== 'ready-to-advance') return { ok: false, refused: 'not-ready', detail: feature.state };
    if (feature.next !== input.target) return { ok: false, refused: 'not-ready', detail: `next is ${feature.next}` };
    const adv = nextAdvance(entry, feature.rung, entry.rungs[input.target]?.advance);
    if (!adv || adv.kind !== 'config') return { ok: false, refused: 'not-a-config-move', detail: adv?.kind };
    if (entry.risk !== 'standard') return { ok: false, refused: 'sensitive' };
    if (Object.keys(adv.set).some(k => this.deps.isCoherenceCritical(k)) || (entry.flag && this.deps.isCoherenceCritical(`${entry.flag.path}.enabled`))) {
      return { ok: false, refused: 'sensitive', detail: 'must match across machines' };
    }
    if (!this.deps.isDevelopmentAgent()) return { ok: false, refused: 'not-a-development-agent' };
    const live = this.readConfigFresh();
    const old: Record<string, unknown> = {};
    for (const k of Object.keys(adv.set)) {
      const cur = readPath(live, k);
      old[k] = cur === undefined ? ABSENT : cur;
      if (!sameValue(cur, input.from?.[k])) return { ok: false, refused: 'changed-since-read', detail: k };
    }
    const moveId = crypto.randomUUID();
    const at = new Date(this.now()).toISOString();
    this.audit({ at, action: 'move-intent', id: entry.id, moveId, target: input.target, reason: input.reason, opinions: input.opinions, metrics: feature.metrics, soak: feature.soak, set: adv.set, old });
    for (const [k, v] of Object.entries(adv.set)) this.deps.setConfig(k, v);
    const after = this.readConfigFresh();
    const failed = Object.entries(adv.set).find(([k, v]) => !sameValue(readPath(after, k), v));
    if (failed) {
      this.audit({ at: new Date(this.now()).toISOString(), action: 'move-failed', id: entry.id, moveId, key: failed[0] });
      return { ok: false, refused: 'write-not-verified', detail: failed[0], moveId };
    }
    this.audit({ at: new Date(this.now()).toISOString(), action: 'move-applied', id: entry.id, moveId, target: input.target, set: adv.set, old, reason: input.reason });
    this.viewCache = null;
    return { ok: true, moveId, state: 'applied', old, set: adv.set, ...(entry.restartNeeded ? { restartNeeded: true } : {}) };
  }

  /** Undo a move, only if what it wrote is still there. A revert also holds the feature, so nothing repeats. */
  revertMove(moveId: string, reason: string): MoveResult {
    this.viewCache = null;
    const found = [...this.lastMoves.entries()].find(([, m]) => m.moveId === moveId);
    if (!found) return { ok: false, refused: 'not-found' };
    const [id, move] = found;
    if (move.action !== 'applied') return { ok: false, refused: 'not-applied', detail: move.action };
    // All-or-nothing before any write; a partial set refuses by name.
    const live = this.readConfigFresh();
    for (const [k, v] of Object.entries(move.set)) {
      if (!sameValue(readPath(live, k), v)) {
        this.audit({ at: new Date(this.now()).toISOString(), action: 'revert-refused', id, moveId, key: k });
        return { ok: false, refused: 'changed-since-move', detail: k };
      }
    }
    for (const [k, v] of Object.entries(move.old)) this.deps.setConfig(k, v === ABSENT ? null : v);
    const holds = { ...((readPath(live, 'maturation.ladder.holds') as Record<string, string> | undefined) ?? {}), [id]: `Reverted ${new Date(this.now()).toISOString().slice(0, 10)}: ${reason}`.slice(0, 200) };
    this.deps.setConfig('maturation.ladder.holds', holds);
    this.audit({ at: new Date(this.now()).toISOString(), action: 'revert-applied', id, moveId, reason, restored: move.old });
    this.viewCache = null;
    return { ok: true, moveId, state: 'applied', old: move.set, set: move.old };
  }

  auditRows(limit: number): AuditRow[] {
    let text = '';
    try { text = fs.readFileSync(this.auditPath, 'utf-8'); } catch { return []; } // @silent-fallback-ok — no audit file means no rows
    const rows: AuditRow[] = [];
    for (const line of text.split('\n').slice(-limit - 1)) {
      if (!line) continue;
      try { rows.push(JSON.parse(line) as AuditRow); } catch { /* @silent-fallback-ok — a torn line is skipped */ }
    }
    return rows;
  }
}

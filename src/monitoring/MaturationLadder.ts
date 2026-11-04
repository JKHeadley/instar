/**
 * MaturationLadder — the pure core of the measured path to default-on.
 *
 * Spec: docs/specs/feature-maturation-ladder.md (Justin, topic 136110, 2026-11-03).
 *
 * Governed by: Maturation Path — Test Agent → Development Agent → Fleet
 *
 * This module parses the registry (src/data/feature-ladders.json), derives each
 * feature's rung from what the code actually ships, turns the next rung into a
 * D7 contract, and reduces D7's rows to one plain state. It reads no files,
 * calls nothing and decides nothing: D7 stays the only thing that says `ready`,
 * and the review job's model stays the only thing that decides a move.
 */

import { resolveDevAgentGate } from '../core/devAgentGate.js';
import type { MaturationEvaluationContract } from '../core/InitiativeTracker.js';

export const LADDERS_SCHEMA = 'feature-ladders/1';
export const LADDER_RESPONSE_SCHEMA = 'maturation-ladder/1';

/** Observed rungs. `dark` is "nobody runs it"; no test-agent role exists to observe yet. */
export const OBSERVED_RUNGS = ['dark', 'dry-run', 'dev-agent-live', 'fleet'] as const;
export type ObservedRung = typeof OBSERVED_RUNGS[number];
/** Rungs a feature can be asked to earn. */
export type TargetRung = 'dev-agent-live' | 'fleet';

export type MetricRole = 'ran' | 'quality' | 'harm';
export type MetricSource = 'jsonl-log' | 'feature-metrics' | 'guard-posture' | 'feature-summary';
export type MetricDirection = 'at-least' | 'at-most';

export interface JsonlLogRef {
  file: string;
  where?: Record<string, string | number | boolean>;
  of?: Record<string, string | number | boolean>;
  value: 'count' | 'ratio';
  timeField?: string;
  /** Keep only the last row per this field's value, so a re-graded event counts once. */
  dedupe?: string;
}
export interface FeatureMetricsRef { feature: string; field: 'errorRate' | 'fireRate' | 'realLlmCalls' }
export interface GuardPostureRef { key: string }
export interface FeatureSummaryRef { ref: string }

export interface LadderMetric {
  id: string;
  role: MetricRole;
  source: MetricSource;
  ref: JsonlLogRef | FeatureMetricsRef | GuardPostureRef | FeatureSummaryRef;
  direction: MetricDirection;
  threshold: number;
  minSamples: number;
  windowDays: number;
}

export type RungAdvance =
  | { kind: 'config'; set: Record<string, string | number | boolean> }
  | { kind: 'owner-driver'; driver: string }
  | { kind: 'code' };

export interface LadderRung {
  soakDays: number;
  advance: RungAdvance;
  metrics: LadderMetric[];
}

export interface LadderPreference { decidedBy: string; reason: string; decidedAt: string; ref: string }

export interface LadderEntry {
  id: string;
  title: string;
  aliases: string[];
  /** D7 feature id. The spec-born initiative's id when one exists; else derived from `id`. */
  subject: string;
  /**
   * `on`: the value meaning fully live, default `enabled: true`.
   * `dryRunPath`: where its dry-run lives when not `<path>.dryRun`.
   * `dryRunDefault`: the code treats an absent dry-run as on, with no shipped key to read.
   */
  flag: { path: string; on?: string | boolean; dryRunPath?: string; dryRunDefault?: boolean } | null;
  disposition: 'ladder' | 'composed' | 'retire';
  composedInto?: string;
  retire?: { reason: string; ref: string };
  final: 'default-on' | 'default-off-by-preference';
  preference?: LadderPreference;
  risk: 'standard' | 'sensitive';
  /** Fires only on incidents, so idle is healthy: `no-opportunity`, not `no-data`. */
  rare?: boolean;
  /** How to start it safely when nothing runs it yet: a setting under its flag, normally a dry-run. */
  start?: { set: Record<string, string | number | boolean> };
  /** The setting is read at boot, so a move needs a restart to take effect. */
  restartNeeded?: boolean;
  tracking: { state: 'measured' | 'needed'; plan: string };
  rungs: Partial<Record<TargetRung, LadderRung>>;
}

export interface LadderRegistry { schema: typeof LADDERS_SCHEMA; entries: LadderEntry[] }

export type LadderParseResult =
  | { ok: true; registry: LadderRegistry }
  | { ok: false; reason: string };

const ID_RE = /^[A-Za-z0-9._:+\-/ (),~]{1,160}$/;
const METRIC_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SUBJECT_RE = METRIC_ID_RE;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const FLAT_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_ENTRIES = 1024;
const MAX_TEXT = 400;

/**
 * Evidence files may only live in an agent's log or state folders, and only as
 * JSONL. Registry entries are reviewed code, so this is a second lock rather
 * than the first: a typo must not reach a credential file.
 */
export const EVIDENCE_FILE_RE = /^(logs|\.instar\/logs|\.instar\/state)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.jsonl$/;
const SHARED_EVIDENCE_FILE = 'logs/feature-evidence.jsonl';
const EVIDENCE_DENY_RE = /credential|secret|token|account|peers\//i;

export function isEvidenceFileAllowed(file: string): boolean {
  return EVIDENCE_FILE_RE.test(file) && !file.split('/').includes('..') && !EVIDENCE_DENY_RE.test(file);
}

/** D7 only accepts kebab ids, and flag paths are dotted. */
export function subjectFromId(id: string): string {
  const slug = id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length <= 63 && slug) return slug;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `${slug.slice(0, 54).replace(/-+$/g, '')}-${h.toString(36).slice(0, 8)}`;
}

function isText(v: unknown, max = MAX_TEXT): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function isFlatMatch(v: unknown): v is Record<string, string | number | boolean> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 8) return false;
  return entries.every(([k, x]) => FLAT_FIELD_RE.test(k)
    && (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'));
}

function metricRefError(source: unknown, ref: unknown): string | null {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return 'ref';
  const r = ref as Record<string, unknown>;
  switch (source) {
    case 'jsonl-log': {
      if (typeof r.file !== 'string' || !isEvidenceFileAllowed(r.file)) return 'ref.file';
      if (r.value !== 'count' && r.value !== 'ratio') return 'ref.value';
      if (r.where !== undefined && !isFlatMatch(r.where)) return 'ref.where';
      if (r.of !== undefined && !isFlatMatch(r.of)) return 'ref.of';
      if (r.value === 'ratio' && (r.of === undefined || r.where === undefined)) return 'ref.ratio-needs-where-and-of';
      if (r.timeField !== undefined && (typeof r.timeField !== 'string' || !FLAT_FIELD_RE.test(r.timeField))) return 'ref.timeField';
      if (r.dedupe !== undefined && (typeof r.dedupe !== 'string' || !FLAT_FIELD_RE.test(r.dedupe))) return 'ref.dedupe';
      // The shared log holds every feature's rows, so another feature's activity must not count as this one's exposure.
      if (r.file === SHARED_EVIDENCE_FILE) {
        const whereId = (r.where as Record<string, unknown> | undefined)?.featureId;
        const ofId = (r.of as Record<string, unknown> | undefined)?.featureId;
        if (typeof whereId !== 'string' || whereId !== ofId) return 'ref.shared-log-needs-featureId-in-where-and-of';
      }
      return null;
    }
    case 'feature-metrics':
      if (!isText(r.feature, 120)) return 'ref.feature';
      if (r.field !== 'errorRate' && r.field !== 'fireRate' && r.field !== 'realLlmCalls') return 'ref.field';
      return null;
    case 'guard-posture':
      return isText(r.key, 200) ? null : 'ref.key';
    case 'feature-summary':
      return isText(r.ref, 120) ? null : 'ref.ref';
    default:
      return 'source';
  }
}

function rungError(raw: unknown, flagPath: string | null): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not-an-object';
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.soakDays) || (r.soakDays as number) < 1 || (r.soakDays as number) > 60) return 'soakDays';
  const a = r.advance as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object') return 'advance';
  if (a.kind === 'config') {
    if (!isFlatConfigSet(a.set)) return 'advance.set';
    if (!flagPath) return 'advance.set-needs-a-flag';
    for (const key of Object.keys(a.set)) {
      if (key !== flagPath && !key.startsWith(`${flagPath}.`)) return 'advance.set-outside-the-flag';
      if (key.endsWith('sessionPool.stage')) return 'advance.set-stage-has-its-own-writer';
    }
  } else if (a.kind === 'owner-driver') {
    if (!isText(a.driver, 80)) return 'advance.driver';
  } else if (a.kind !== 'code') {
    return 'advance.kind';
  }
  if (!Array.isArray(r.metrics) || r.metrics.length < 1 || r.metrics.length > 16) return 'metrics';
  const ids = new Set<string>();
  const roles = new Set<string>();
  let judgeRoleFromOwnBehaviour = false;
  for (let i = 0; i < r.metrics.length; i++) {
    const m = r.metrics[i] as Record<string, unknown>;
    if (!m || typeof m !== 'object') return `metrics[${i}]`;
    if (typeof m.id !== 'string' || !METRIC_ID_RE.test(m.id) || ids.has(m.id)) return `metrics[${i}].id`;
    ids.add(m.id);
    if (m.role !== 'ran' && m.role !== 'quality' && m.role !== 'harm') return `metrics[${i}].role`;
    const refErr = metricRefError(m.source, m.ref);
    if (refErr) return `metrics[${i}].${refErr}`;
    if (m.direction !== 'at-least' && m.direction !== 'at-most') return `metrics[${i}].direction`;
    if (typeof m.threshold !== 'number' || !Number.isFinite(m.threshold)) return `metrics[${i}].threshold`;
    if (!Number.isInteger(m.minSamples) || (m.minSamples as number) < 1 || (m.minSamples as number) > 100_000) return `metrics[${i}].minSamples`;
    if (!Number.isInteger(m.windowDays) || (m.windowDays as number) < 1 || (m.windowDays as number) > 30) return `metrics[${i}].windowDays`;
    // A guard being on says it is switched on. It can show the feature ran, never that it did well.
    if (m.source === 'guard-posture' && m.role !== 'ran') return `metrics[${i}].guard-posture-may-only-show-ran`;
    roles.add(m.role);
    if (m.role !== 'ran') judgeRoleFromOwnBehaviour = true;
  }
  // Enough to judge: it must show it ran AND how it did.
  if (!roles.has('ran')) return 'needs-a-ran-metric';
  if (!judgeRoleFromOwnBehaviour) return 'needs-a-quality-or-harm-metric';
  return null;
}

function isFlatConfigSet(v: unknown): v is Record<string, string | number | boolean> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 4) return false;
  return entries.every(([k, x]) => /^[A-Za-z][A-Za-z0-9.]{0,200}$/.test(k)
    && (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'));
}

/** Validate the registry. A bad file is refused whole, naming the failing field. */
export function parseLadderRegistry(text: string): LadderParseResult {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'invalid-json' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'not-an-object' };
  const d = doc as Record<string, unknown>;
  if (d.schema !== LADDERS_SCHEMA) return { ok: false, reason: 'schema' };
  if (!Array.isArray(d.entries) || d.entries.length > MAX_ENTRIES) return { ok: false, reason: 'entries' };
  const seen = new Set<string>();
  const subjects = new Set<string>();
  const entries: LadderEntry[] = [];
  for (let i = 0; i < d.entries.length; i++) {
    const e = d.entries[i] as Record<string, unknown>;
    const at = `entries[${i}]`;
    if (!e || typeof e !== 'object') return { ok: false, reason: at };
    if (typeof e.id !== 'string' || !ID_RE.test(e.id) || seen.has(e.id)) return { ok: false, reason: `${at}.id` };
    seen.add(e.id);
    if (!isText(e.title, 160)) return { ok: false, reason: `${at}.title` };
    if (e.aliases !== undefined && (!Array.isArray(e.aliases) || e.aliases.some(a => typeof a !== 'string' || !ID_RE.test(a)))) return { ok: false, reason: `${at}.aliases` };
    if (e.subject !== undefined && (typeof e.subject !== 'string' || !SUBJECT_RE.test(e.subject))) return { ok: false, reason: `${at}.subject` };
    const subject = (e.subject as string | undefined) ?? subjectFromId(e.id);
    if (subjects.has(subject)) return { ok: false, reason: `${at}.subject-collides` };
    subjects.add(subject);
    if (e.rare !== undefined && typeof e.rare !== 'boolean') return { ok: false, reason: `${at}.rare` };
    if (e.restartNeeded !== undefined && typeof e.restartNeeded !== 'boolean') return { ok: false, reason: `${at}.restartNeeded` };
    if (e.flag !== null) {
      const f = e.flag as Record<string, unknown> | undefined;
      if (!f || typeof f !== 'object' || typeof f.path !== 'string' || !/^[A-Za-z][A-Za-z0-9.]{0,200}$/.test(f.path)) return { ok: false, reason: `${at}.flag` };
      if (f.on !== undefined && typeof f.on !== 'string' && typeof f.on !== 'boolean') return { ok: false, reason: `${at}.flag.on` };
      if (f.dryRunPath !== undefined && (typeof f.dryRunPath !== 'string' || !/^[A-Za-z][A-Za-z0-9.]{0,200}$/.test(f.dryRunPath))) return { ok: false, reason: `${at}.flag.dryRunPath` };
      if (f.dryRunDefault !== undefined && typeof f.dryRunDefault !== 'boolean') return { ok: false, reason: `${at}.flag.dryRunDefault` };
    }
    if (e.risk !== 'standard' && e.risk !== 'sensitive') return { ok: false, reason: `${at}.risk` };
    const t = e.tracking as Record<string, unknown> | undefined;
    if (!t || (t.state !== 'measured' && t.state !== 'needed') || !isText(t.plan)) return { ok: false, reason: `${at}.tracking` };
    if (e.final !== 'default-on' && e.final !== 'default-off-by-preference') return { ok: false, reason: `${at}.final` };
    if (e.final === 'default-off-by-preference') {
      const p = e.preference as Record<string, unknown> | undefined;
      if (!p || !isText(p.decidedBy, 80) || !isText(p.reason) || typeof p.decidedAt !== 'string' || !DATE_RE.test(p.decidedAt) || !isText(p.ref, 200)) {
        return { ok: false, reason: `${at}.preference` };
      }
    }
    const rungs = (e.rungs ?? {}) as Record<string, unknown>;
    if (typeof rungs !== 'object' || Array.isArray(rungs)) return { ok: false, reason: `${at}.rungs` };
    for (const k of Object.keys(rungs)) {
      if (k !== 'dev-agent-live' && k !== 'fleet') return { ok: false, reason: `${at}.rungs.${k}` };
      const err = rungError(rungs[k], (e.flag as { path?: string } | null)?.path ?? null);
      if (err) return { ok: false, reason: `${at}.rungs.${k}.${err}` };
      // Default-on is a shipped default, which a local setting cannot reach.
      if (k === 'fleet' && (rungs[k] as { advance?: { kind?: string } }).advance?.kind === 'config') return { ok: false, reason: `${at}.rungs.fleet.config-cannot-reach-fleet` };
    }
    if (e.disposition === 'composed') {
      if (!isText(e.composedInto, 160)) return { ok: false, reason: `${at}.composedInto` };
      if (Object.keys(rungs).length) return { ok: false, reason: `${at}.composed-has-no-rungs` };
    } else if (e.disposition === 'retire') {
      const r = e.retire as Record<string, unknown> | undefined;
      if (!r || !isText(r.reason) || !isText(r.ref, 200)) return { ok: false, reason: `${at}.retire` };
    } else if (e.disposition === 'ladder') {
      if (!e.flag) return { ok: false, reason: `${at}.ladder-needs-a-flag` };
      if (e.start !== undefined) {
        const set = (e.start as { set?: unknown }).set;
        if (!isFlatConfigSet(set)) return { ok: false, reason: `${at}.start` };
        const flagPath = (e.flag as { path: string }).path;
        for (const key of Object.keys(set)) {
          if (key !== flagPath && !key.startsWith(`${flagPath}.`)) return { ok: false, reason: `${at}.start-outside-the-flag` };
          if (key.endsWith('sessionPool.stage')) return { ok: false, reason: `${at}.start-stage-has-its-own-writer` };
        }
      }
      if (!rungs.fleet && e.final === 'default-on') return { ok: false, reason: `${at}.default-on-needs-a-fleet-rung` };
      // A preference final closes only the step to default-on; the feature still earns its lower rung.
      if (e.final === 'default-off-by-preference' && !rungs['dev-agent-live']) return { ok: false, reason: `${at}.preference-still-needs-a-dev-rung` };
      if (!rungs['dev-agent-live'] && !rungs.fleet) return { ok: false, reason: `${at}.ladder-needs-a-rung` };
    } else {
      return { ok: false, reason: `${at}.disposition` };
    }
    entries.push({
      id: e.id,
      title: e.title,
      aliases: (e.aliases as string[] | undefined) ?? [],
      subject,
      flag: (e.flag as LadderEntry['flag']) ?? null,
      disposition: e.disposition as LadderEntry['disposition'],
      ...(e.composedInto ? { composedInto: e.composedInto as string } : {}),
      ...(e.retire ? { retire: e.retire as LadderEntry['retire'] } : {}),
      final: e.final,
      ...(e.preference ? { preference: e.preference as LadderPreference } : {}),
      risk: e.risk,
      ...(e.rare ? { rare: true } : {}),
      ...(e.start ? { start: e.start as LadderEntry['start'] } : {}),
      ...(e.restartNeeded ? { restartNeeded: true } : {}),
      tracking: { state: t.state as 'measured' | 'needed', plan: t.plan as string },
      rungs: rungs as LadderEntry['rungs'],
    });
  }
  const ids = new Set(entries.map(e => e.id));
  for (const e of entries) {
    if (e.disposition !== 'composed') continue;
    const parent = entries.find(x => x.id === e.composedInto);
    if (!ids.has(e.composedInto!) || !parent || parent.disposition !== 'ladder') {
      return { ok: false, reason: `composedInto:${e.id}` };
    }
  }
  return { ok: true, registry: { schema: LADDERS_SCHEMA, entries } };
}

// ── Rung ───────────────────────────────────────────────────────────────────

function readPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

interface FlagRead { fullyOn: boolean; dryRun: boolean }

function dryRunOf(flag: NonNullable<LadderEntry['flag']>, root: unknown, obj: Record<string, unknown> | null): boolean {
  const raw = flag.dryRunPath ? readPath(root, flag.dryRunPath) : obj?.dryRun;
  return typeof raw === 'boolean' ? raw : flag.dryRunDefault === true;
}

function readFlag(entry: LadderEntry, root: unknown, gateConfig: { developmentAgent?: boolean } | null): FlagRead {
  const flag = entry.flag!;
  const raw = readPath(root, flag.path);
  if (flag.on !== undefined) {
    // A stage-style flag: fully on means this exact value (or, for a boolean `on`, this boolean).
    const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    const value = obj ? obj.enabled : raw;
    return { fullyOn: value === flag.on, dryRun: dryRunOf(flag, root, obj) };
  }
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const explicit = obj ? obj.enabled as boolean | undefined : typeof raw === 'boolean' ? raw : undefined;
  const on = gateConfig ? resolveDevAgentGate(explicit, gateConfig) : explicit === true;
  return { fullyOn: on, dryRun: dryRunOf(flag, root, obj) };
}

/**
 * The rung comes from what is shipped and what runs here, never from a label.
 * The shipped default alone decides `fleet`; a shipped dry-run is not fleet.
 */
export function deriveLadderRung(
  entry: LadderEntry,
  liveConfig: unknown,
  shippedDefaults: unknown,
): { rung: ObservedRung; flagMissing: boolean } {
  if (!entry.flag) return { rung: 'dark', flagMissing: true };
  const shippedRaw = readPath(shippedDefaults, entry.flag.path);
  const liveRaw = readPath(liveConfig, entry.flag.path);
  const flagMissing = shippedRaw === undefined && liveRaw === undefined
    && !(liveConfig as { developmentAgent?: boolean } | null)?.developmentAgent;
  const shipped = readFlag(entry, shippedDefaults, null);
  if (shipped.fullyOn && !shipped.dryRun) return { rung: 'fleet', flagMissing: false };
  const live = readFlag(entry, liveConfig, (liveConfig ?? {}) as { developmentAgent?: boolean });
  if (live.fullyOn && !live.dryRun) return { rung: 'dev-agent-live', flagMissing };
  if (live.fullyOn) return { rung: 'dry-run', flagMissing };
  return { rung: 'dark', flagMissing };
}

export function nextRung(entry: LadderEntry, rung: ObservedRung): TargetRung | null {
  if (entry.disposition !== 'ladder') return null;
  if (rung === 'fleet') return null;
  if (rung === 'dev-agent-live') return entry.final === 'default-on' ? 'fleet' : null;
  if (entry.rungs['dev-agent-live']) return 'dev-agent-live';
  return entry.final === 'default-on' ? 'fleet' : null;
}

/** The rung just below `target`, whose bar a feature already crossed. */
export function crossedRung(entry: LadderEntry, rung: ObservedRung): LadderRung | null {
  if (rung === 'fleet') return entry.rungs.fleet ?? entry.rungs['dev-agent-live'] ?? null;
  if (rung === 'dev-agent-live') return entry.rungs['dev-agent-live'] ?? null;
  return null;
}

/** D7's contract for the rung this feature is working toward. Same scorer, more subjects. */
export function contractForRung(rung: LadderRung): MaturationEvaluationContract {
  return {
    cadenceHours: 6,
    evidenceMaxAgeHours: 12,
    metrics: rung.metrics.map(m => ({
      id: m.id,
      source: 'feature-summary' as const,
      sourceRef: projectionRef(m),
      direction: m.direction,
      threshold: m.threshold,
      minSamples: m.minSamples,
    })),
  };
}

/** Stable D7 source ref for a ladder metric. `feature-summary` keeps its own ref. */
export function projectionRef(m: LadderMetric): string {
  if (m.source === 'feature-summary') return (m.ref as FeatureSummaryRef).ref;
  const body = JSON.stringify({ s: m.source, r: m.ref, w: m.windowDays });
  let h = 0;
  for (let i = 0; i < body.length; i++) h = (h * 31 + body.charCodeAt(i)) >>> 0;
  return `ladder.${m.id}.${h.toString(36)}`;
}

// ── State ──────────────────────────────────────────────────────────────────

export type LadderState =
  | 'retire-pending' | 'composed' | 'held' | 'harmed' | 'at-final' | 'not-started'
  | 'no-opportunity' | 'no-data' | 'hold' | 'collecting' | 'soaking' | 'ready-to-advance';

export interface MetricReading {
  metric: LadderMetric;
  value: number | null;
  samples: number;
  /** Newest matching row, when known. */
  newestAt: number | null;
  /** Days of the window the log actually covers, when rotation may have cut it. */
  coverageDays?: number;
  /** Why no number exists (a read failed, the file is too big, or the data was cut). */
  reason?: string;
}

export interface EvaluationRow { status: string; dueSlotMs: number; contractHash: string }

export interface LadderStateInput {
  entry: LadderEntry;
  rung: ObservedRung;
  target: TargetRung | null;
  /** Readings for the next rung's metrics. */
  readings: MetricReading[];
  /** Readings for the crossed rung's `harm` and `ran` metrics, windowed from the move. */
  afterMove: MetricReading[];
  /** D7 rows for this subject, any order. */
  evaluations: EvaluationRow[];
  contractHash: string | null;
  now: number;
  /** When a move for this feature was last applied here, if any. */
  lastMoveAt: number | null;
  /** This agent's operator holds it, with a reason. */
  heldReason: string | null;
}

export interface MetricView {
  id: string;
  role: MetricRole;
  direction: MetricDirection;
  threshold: number;
  minSamples: number;
  value: number | null;
  samples: number;
  pass: boolean | null;
  coverageDays?: number;
  reason?: string;
}

export interface LadderStateResult {
  state: LadderState;
  /** Why, in a word or two, when the state alone does not say. */
  because?: string;
  soak: { days: number; needed: number };
  metrics: MetricView[];
  passing: number;
  total: number;
}

const DAY_MS = 86_400_000;

/** A closed raise is not reopened right away, so a review's "extend" decision sticks. */
const RAISE_AGAIN_AFTER_DAYS: Partial<Record<LadderState, number>> = { 'ready-to-advance': 7, 'not-started': 14, harmed: 1 };

export function raiseDue(state: LadderState, lastRaisedAt: number | undefined, now: number): boolean {
  const days = RAISE_AGAIN_AFTER_DAYS[state];
  if (days === undefined) return false;
  return lastRaisedAt === undefined || now - lastRaisedAt >= days * DAY_MS;
}

export const HARM_WATCH_DAYS = 14;
export const SILENT_AFTER_MOVE_DAYS = 3;

export function metricPasses(direction: MetricDirection, value: number, threshold: number): boolean {
  return direction === 'at-least' ? value >= threshold : value <= threshold;
}

function view(r: MetricReading): MetricView {
  const enough = r.value !== null && r.samples >= r.metric.minSamples;
  return {
    id: r.metric.id,
    role: r.metric.role,
    direction: r.metric.direction,
    threshold: r.metric.threshold,
    minSamples: r.metric.minSamples,
    value: r.value,
    samples: r.samples,
    pass: enough ? metricPasses(r.metric.direction, r.value as number, r.metric.threshold) : null,
    ...(r.coverageDays !== undefined ? { coverageDays: r.coverageDays } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  };
}

/** Whole days of unbroken D7 `ready` under this contract. Any other row restarts it. */
export function soakDays(evaluations: EvaluationRow[], contractHash: string | null, now: number): number {
  if (!contractHash) return 0;
  const rows = [...evaluations].sort((a, b) => b.dueSlotMs - a.dueSlotMs);
  let oldest: number | null = null;
  for (const r of rows) {
    if (r.contractHash !== contractHash || r.status !== 'ready') break;
    oldest = r.dueSlotMs;
  }
  if (oldest === null) return 0;
  return Math.max(0, Math.floor((now - oldest) / DAY_MS));
}

export function computeLadderState(input: LadderStateInput): LadderStateResult {
  const { entry, rung, target, readings, afterMove, evaluations, contractHash, now, lastMoveAt, heldReason } = input;
  const metrics = readings.map(view);
  const passing = metrics.filter(m => m.pass === true).length;
  const total = metrics.length;
  const needed = target ? entry.rungs[target]?.soakDays ?? 0 : 0;
  const days = soakDays(evaluations, contractHash, now);
  const done = (state: LadderState, because?: string): LadderStateResult => ({
    state, ...(because ? { because } : {}), soak: { days, needed }, metrics, passing, total,
  });

  if (entry.disposition === 'retire') return done('retire-pending');
  if (entry.disposition === 'composed') return done('composed');
  if (heldReason) return done('held', heldReason);

  if (lastMoveAt !== null && now - lastMoveAt <= HARM_WATCH_DAYS * DAY_MS) {
    const after = afterMove.map(view);
    const failing = after.find(m => m.role === 'harm' && m.pass === false);
    if (failing) return done('harmed', failing.id);
    const silentLongEnough = now - lastMoveAt >= SILENT_AFTER_MOVE_DAYS * DAY_MS;
    const ran = after.filter(m => m.role === 'ran');
    // A failed read is not silence: only a real zero can say the feature went quiet.
    if (silentLongEnough && !entry.rare && ran.length > 0 && ran.every(m => m.value === 0)) return done('harmed', 'silent-after-move');
  }

  if (target === null) return done('at-final');
  if (rung === 'dark') return done('not-started');

  const ran = metrics.filter(m => m.role === 'ran');
  // A failed read is not silence: it says it cannot tell, so it stays `collecting`.
  if (ran.length > 0 && ran.every(m => m.value === 0 || (m.value === null && !m.reason))) return done(entry.rare ? 'no-opportunity' : 'no-data');
  if (metrics.some(m => m.pass === false)) return done('hold');
  if (metrics.some(m => m.pass === null)) return done('collecting');
  const latest = [...evaluations].sort((a, b) => b.dueSlotMs - a.dueSlotMs)[0];
  if (!latest || latest.contractHash !== contractHash || latest.status !== 'ready') return done('collecting');
  if (days >= needed) return done('ready-to-advance');
  return done('soaking');
}

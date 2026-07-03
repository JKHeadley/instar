/**
 * DefectClassRegistry — the class registry loader + the DERIVED-count and
 * escalation-threshold logic for the Class-Closure Gate + Standards-Delta
 * Escalator (docs/specs/class-closure-gate.md).
 *
 * Pure library over a repo checkout (fs reads only, no server/runtime). Used by:
 *   - the CI gate lint (report-only) — validates declarations, derives counts,
 *     computes threshold crossings;
 *   - the runtime read route `GET /class-closure` — reports registry + posture;
 *   - the StandardsDeltaEscalator — drafts proposals for crossed thresholds.
 *
 * KEY INVARIANTS (converged spec):
 *   - `instanceCount` in the registry file is a CACHE. The AUTHORITATIVE count
 *     is DERIVED by scanning the committed decision-audit declarations, deduped
 *     by PR number (round-3 material finding C1: scanning the mirrored
 *     side-effects host too would double-count). The lint VALIDATES the cache;
 *     the periodic pass MUTATES it.
 *   - `escalatedAt: "seeded-closed"` + `evidenceCountAtLastAck === instanceCount`
 *     at seed time suppresses ONLY historical backfill; a post-seed declaration
 *     that grows the class past that baseline fires the deterministic re-raise.
 */

import fs from 'node:fs';
import path from 'node:path';

export type DefectClassSeverity = 'critical' | 'normal';
export type DefectClassStatus = 'confirmed' | 'unconfirmed';
export type EnforcementGrade = 'ratchet' | 'gate' | 'lint' | 'spec-only' | 'documented-only';

export interface DefectClassEntry {
  id: string;
  description: string;
  includes: string[];
  excludes: string[];
  canonicalExamples: string[];
  status: DefectClassStatus;
  severity: DefectClassSeverity;
  closureStandard: string | null;
  /** The closure standard's enforcement status as last graded (nullable cache). */
  closureStandardEnforcement: EnforcementGrade | null;
  /** CACHE — the DERIVED, deduped-by-PR count. Validated by the lint, mutated by the pass. */
  instanceCount: number;
  /** ISO timestamp | "seeded-closed" | null (never escalated). */
  escalatedAt: string | null;
  /** The count at the last operator acknowledgement — the re-raise baseline. */
  evidenceCountAtLastAck: number;
  /** The open proposal id, if a proposal is currently drafted. */
  proposalId: string | null;
  /** REQUIRED for a novel class: the nearest existing class + why it doesn't fit. */
  nearestExistingClass?: string;
}

export interface DefectClassRegistryFile {
  note?: string;
  version: number;
  classes: DefectClassEntry[];
}

/** The class-closure declaration block embedded in an instar-dev decision-audit entry. */
export interface ClassClosureDeclaration {
  /** A class id from the registry, or 'novel'. */
  defectClass: string;
  closure: 'guard' | 'gap';
  /** Required with closure:'guard'. */
  guardEvidence?: {
    /** The guard's ENFORCEMENT TYPE as graded by the coverage audit's grader. */
    enforcementType: EnforcementGrade;
    /** The guard citation (path / METHOD route / symbol). */
    citation: string;
    /** One line on how this guard would have caught THIS defect. */
    howCaught: string;
  };
  /** Required with closure:'gap': the tracked standards-gap evolution-action id. */
  gapItem?: string;
  /** The fix's PR number — the natural dedup key (two entries citing the same PR + class count once). */
  prNumber?: number | null;
  /** Per-COMPONENT granularity (matches the registry). */
  component?: string;
  /** Required when defectClass === 'novel' (full semantics of the proposed class). */
  novelClass?: Partial<DefectClassEntry> & { nearestExistingClass: string };
  /** The A/B verdict summary for a prompt-touching fix (mechanical arm). */
  abVerdict?: { runId: string; routes: string[]; fixed: number; regressed: number };
}

/** A declaration paired with its source decision-audit entry metadata. */
export interface DecisionDeclaration extends ClassClosureDeclaration {
  /** Source decision-audit entry filename (for audit). */
  source: string;
  /** The entry's timestamp. */
  ts?: string;
}

export const DEFAULT_SPREAD_N = 3; // ≥N across ≥2 components (normal severity)
export const DEFAULT_SINGLE_K = 5; // ≥K within one component (normal severity)
export const DEFAULT_GAP_MAX_AGE_DAYS = 45;

export const REGISTRY_REL_PATH = path.join('docs', 'defect-classes.json');

/** Is `repoRoot` an instar checkout carrying the class registry (repo-gate)? */
export function isClassClosureRepo(repoRoot: string): boolean {
  try {
    return (
      fs.existsSync(path.join(repoRoot, '.git')) &&
      fs.existsSync(path.join(repoRoot, 'package.json')) &&
      fs.existsSync(path.join(repoRoot, REGISTRY_REL_PATH))
    );
  } catch {
    return false;
  }
}

/** Load + parse the registry file. Throws on missing/malformed JSON. */
export function loadDefectClassRegistry(repoRoot: string): DefectClassRegistryFile {
  const p = path.join(repoRoot, REGISTRY_REL_PATH);
  const raw = fs.readFileSync(p, 'utf-8');
  const parsed = JSON.parse(raw) as DefectClassRegistryFile;
  const v = validateRegistry(parsed);
  if (!v.ok) {
    throw new Error(`defect-classes.json is invalid: ${v.errors.join('; ')}`);
  }
  return parsed;
}

/** Structural validation (used by the lint + tests). Never throws. */
export function validateRegistry(reg: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!reg || typeof reg !== 'object') return { ok: false, errors: ['registry is not an object'] };
  const r = reg as Partial<DefectClassRegistryFile>;
  if (typeof r.version !== 'number') errors.push('version must be a number');
  if (!Array.isArray(r.classes)) {
    errors.push('classes must be an array');
    return { ok: errors.length === 0, errors };
  }
  const ids = new Set<string>();
  for (const [i, c] of r.classes.entries()) {
    const where = `class[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); continue; }
    const e = c as Partial<DefectClassEntry>;
    if (!e.id || typeof e.id !== 'string') errors.push(`${where}.id missing`);
    else {
      if (ids.has(e.id)) errors.push(`${where}.id duplicate: ${e.id}`);
      ids.add(e.id);
      if (!/^[a-z0-9-]+$/.test(e.id)) errors.push(`${where}.id must match ^[a-z0-9-]+$`);
    }
    if (!e.description || typeof e.description !== 'string') errors.push(`${where}.description missing`);
    if (!Array.isArray(e.includes) || e.includes.length < 1) errors.push(`${where}.includes needs ≥1 entry`);
    if (!Array.isArray(e.excludes) || e.excludes.length < 1) errors.push(`${where}.excludes needs ≥1 entry`);
    if (!Array.isArray(e.canonicalExamples)) errors.push(`${where}.canonicalExamples must be an array`);
    if (e.status !== 'confirmed' && e.status !== 'unconfirmed') errors.push(`${where}.status invalid`);
    if (e.severity !== 'critical' && e.severity !== 'normal') errors.push(`${where}.severity invalid`);
    if (typeof e.instanceCount !== 'number') errors.push(`${where}.instanceCount must be a number`);
    if (typeof e.evidenceCountAtLastAck !== 'number') errors.push(`${where}.evidenceCountAtLastAck must be a number`);
    if (!('closureStandard' in e)) errors.push(`${where}.closureStandard missing (nullable ok)`);
    if (!('proposalId' in e)) errors.push(`${where}.proposalId missing (nullable ok)`);
    // A novel class enters unconfirmed and REQUIRES a nearestExistingClass.
    if (e.status === 'unconfirmed' && !e.nearestExistingClass) {
      errors.push(`${where} is unconfirmed but has no nearestExistingClass`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Read the class-closure declarations from committed decision-audit entries.
 * The decision-audit entry is the SINGLE machine-readable counting host — the
 * side-effects artifact mirror is display-only and is NOT read here (C1 fix).
 */
export function readDecisionDeclarations(repoRoot: string): DecisionDeclaration[] {
  const dir = path.join(repoRoot, '.instar', 'instar-dev-decisions');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    // @silent-fallback-ok: an absent/unreadable decisions dir means there are simply no
    // declarations to count yet (a fresh repo, or a checkout with no instar-dev history) —
    // the empty list is the correct answer, not a degraded result. This is a pure library
    // over a repo checkout with no runtime/DegradationReporter surface (spec §"Pure library").
    return [];
  }
  const out: DecisionDeclaration[] = [];
  for (const f of files) {
    let entry: { classClosure?: ClassClosureDeclaration; ts?: string };
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    } catch {
      continue;
    }
    if (entry && entry.classClosure && typeof entry.classClosure === 'object') {
      out.push({ ...entry.classClosure, source: f, ts: entry.ts });
    }
  }
  return out;
}

export interface DerivedClassData {
  /** Distinct-PR count (the deduped instance count). */
  dedupedCount: number;
  /** Distinct components. */
  componentCount: number;
  /** The largest distinct-PR count within a single component. */
  maxSingleComponentCount: number;
  /** Any open gap declaration for this class. */
  hasOpenGap: boolean;
  /** The distinct PR numbers seen (for audit). */
  prs: number[];
  /** The distinct components seen. */
  components: string[];
}

/**
 * Derive per-class counts from declarations, deduped by PR number. Two
 * declarations citing the same PR + class count ONCE. A declaration with no
 * prNumber falls back to its source filename as the dedup key (still counts once).
 */
export function deriveClassData(declarations: DecisionDeclaration[]): Map<string, DerivedClassData> {
  const byClass = new Map<string, DecisionDeclaration[]>();
  for (const d of declarations) {
    if (!d.defectClass) continue;
    const list = byClass.get(d.defectClass) ?? [];
    list.push(d);
    byClass.set(d.defectClass, list);
  }
  const result = new Map<string, DerivedClassData>();
  for (const [classId, list] of byClass) {
    const dedupKey = (d: DecisionDeclaration): string =>
      d.prNumber != null ? `pr:${d.prNumber}` : `src:${d.source}`;
    const seen = new Set<string>();
    const prs = new Set<number>();
    const components = new Set<string>();
    const perComponentKeys = new Map<string, Set<string>>();
    let hasOpenGap = false;
    for (const d of list) {
      const key = dedupKey(d);
      seen.add(key);
      if (d.prNumber != null) prs.add(d.prNumber);
      const comp = d.component ?? '<unspecified>';
      components.add(comp);
      const compSet = perComponentKeys.get(comp) ?? new Set<string>();
      compSet.add(key);
      perComponentKeys.set(comp, compSet);
      if (d.closure === 'gap') hasOpenGap = true;
    }
    let maxSingleComponentCount = 0;
    for (const s of perComponentKeys.values()) {
      maxSingleComponentCount = Math.max(maxSingleComponentCount, s.size);
    }
    result.set(classId, {
      dedupedCount: seen.size,
      componentCount: components.size,
      maxSingleComponentCount,
      hasOpenGap,
      prs: [...prs].sort((a, b) => a - b),
      components: [...components].sort(),
    });
  }
  return result;
}

export interface EscalationVerdict {
  shouldEscalate: boolean;
  /** The arm that crossed the threshold, if any. */
  arm: 'critical-1' | 'spread' | 'gap-plus' | 'single-component' | null;
  reason: string;
  /** True when the derived count exceeds the last-ack baseline (new, un-acked evidence). */
  newEvidence: boolean;
}

export interface EscalationThresholds {
  spreadN?: number;
  singleK?: number;
}

/**
 * Deterministic threshold logic. Fires ONLY when there is NEW evidence past the
 * last-ack baseline (seeded-closed suppression + dedup re-raise) AND a severity
 * arm crosses:
 *   - critical  ⇒ escalates at ≥1 confirmed instance (any new evidence).
 *   - normal    ⇒ ≥N across ≥2 components, OR ≥2 + an open gap, OR ≥K in one component.
 */
export function computeEscalation(
  entry: Pick<DefectClassEntry, 'severity' | 'evidenceCountAtLastAck'>,
  derived: DerivedClassData,
  thresholds: EscalationThresholds = {},
): EscalationVerdict {
  const N = thresholds.spreadN ?? DEFAULT_SPREAD_N;
  const K = thresholds.singleK ?? DEFAULT_SINGLE_K;
  const newEvidence = derived.dedupedCount > entry.evidenceCountAtLastAck;
  if (!newEvidence) {
    return {
      shouldEscalate: false,
      arm: null,
      reason: `no new evidence past ack baseline (derived ${derived.dedupedCount} ≤ ack ${entry.evidenceCountAtLastAck})`,
      newEvidence: false,
    };
  }
  if (entry.severity === 'critical') {
    return {
      shouldEscalate: true,
      arm: 'critical-1',
      reason: `critical class recurred (derived ${derived.dedupedCount} > ack ${entry.evidenceCountAtLastAck}); escalates at 1`,
      newEvidence: true,
    };
  }
  // normal severity — three arms.
  if (derived.dedupedCount >= N && derived.componentCount >= 2) {
    return {
      shouldEscalate: true,
      arm: 'spread',
      reason: `≥${N} instances (${derived.dedupedCount}) across ≥2 components (${derived.componentCount})`,
      newEvidence: true,
    };
  }
  if (derived.dedupedCount >= 2 && derived.hasOpenGap) {
    return {
      shouldEscalate: true,
      arm: 'gap-plus',
      reason: `≥2 instances (${derived.dedupedCount}) + an open gap item`,
      newEvidence: true,
    };
  }
  if (derived.maxSingleComponentCount >= K) {
    return {
      shouldEscalate: true,
      arm: 'single-component',
      reason: `≥${K} instances (${derived.maxSingleComponentCount}) within one component`,
      newEvidence: true,
    };
  }
  return {
    shouldEscalate: false,
    arm: null,
    reason: `no normal-severity arm crossed (count ${derived.dedupedCount}, components ${derived.componentCount}, maxSingle ${derived.maxSingleComponentCount})`,
    newEvidence: true,
  };
}

/** Whether a gap item is open past the max-age escalation ceiling. */
export function gapOpenPastMaxAge(
  gapOpenedAtIso: string,
  now: number = Date.now(),
  maxAgeDays: number = DEFAULT_GAP_MAX_AGE_DAYS,
): boolean {
  const opened = Date.parse(gapOpenedAtIso);
  if (Number.isNaN(opened)) return false;
  const ageDays = (now - opened) / (24 * 60 * 60 * 1000);
  return ageDays > maxAgeDays;
}

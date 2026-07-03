// defect-class-registry.mjs — the SELF-CONTAINED ESM mirror of the pure
// registry/derive/threshold logic in src/core/DefectClassRegistry.ts, used by
// the class-closure gate's CI lint (scripts/class-closure-lint.mjs).
//
// WHY a mirror: PR-gate lints run on a fresh checkout with NO build step
// (decision-audit-gate.yml precedent), so the lint cannot import the TS module
// from dist/. This file re-implements the SAME pure functions the lint needs —
// loadRegistry, validateRegistry, readDecisionDeclarations, deriveClassData,
// computeEscalation (+ the small helpers/constants they lean on).
//
// tests/unit/class-closure-registry-parity.test.ts pins this mirror's outputs
// EQUAL to src/core/DefectClassRegistry.ts for the same inputs, so the two
// implementations cannot drift (Structure > Willpower). If you edit one, edit
// the other and the parity test will hold you to it.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SPREAD_N = 3; // ≥N across ≥2 components (normal severity)
export const DEFAULT_SINGLE_K = 5; // ≥K within one component (normal severity)
export const DEFAULT_GAP_MAX_AGE_DAYS = 45;

export const REGISTRY_REL_PATH = path.join('docs', 'defect-classes.json');

/** Is `repoRoot` an instar checkout carrying the class registry (repo-gate)? */
export function isClassClosureRepo(repoRoot) {
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

/** Load + parse the registry file. Throws on missing/malformed JSON or invalid shape. */
export function loadRegistry(repoRoot) {
  const p = path.join(repoRoot, REGISTRY_REL_PATH);
  const raw = fs.readFileSync(p, 'utf-8');
  const parsed = JSON.parse(raw);
  const v = validateRegistry(parsed);
  if (!v.ok) {
    throw new Error(`defect-classes.json is invalid: ${v.errors.join('; ')}`);
  }
  return parsed;
}

/** Structural validation (used by the lint + tests). Never throws. */
export function validateRegistry(reg) {
  const errors = [];
  if (!reg || typeof reg !== 'object') return { ok: false, errors: ['registry is not an object'] };
  const r = reg;
  if (typeof r.version !== 'number') errors.push('version must be a number');
  if (!Array.isArray(r.classes)) {
    errors.push('classes must be an array');
    return { ok: errors.length === 0, errors };
  }
  const ids = new Set();
  for (const [i, c] of r.classes.entries()) {
    const where = `class[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); continue; }
    const e = c;
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
 * @returns {Array<object>} declarations, each with `.source` (filename) + `.ts`.
 */
export function readDecisionDeclarations(repoRoot) {
  const dir = path.join(repoRoot, '.instar', 'instar-dev-decisions');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let entry;
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

/**
 * Derive per-class counts from declarations, deduped by PR number. Two
 * declarations citing the same PR + class count ONCE. A declaration with no
 * prNumber falls back to its source filename as the dedup key (still counts once).
 * @returns {Map<string, object>} classId → DerivedClassData.
 */
export function deriveClassData(declarations) {
  const byClass = new Map();
  for (const d of declarations) {
    if (!d.defectClass) continue;
    const list = byClass.get(d.defectClass) ?? [];
    list.push(d);
    byClass.set(d.defectClass, list);
  }
  const result = new Map();
  for (const [classId, list] of byClass) {
    const dedupKey = (d) => (d.prNumber != null ? `pr:${d.prNumber}` : `src:${d.source}`);
    const seen = new Set();
    const prs = new Set();
    const components = new Set();
    const perComponentKeys = new Map();
    let hasOpenGap = false;
    for (const d of list) {
      const key = dedupKey(d);
      seen.add(key);
      if (d.prNumber != null) prs.add(d.prNumber);
      const comp = d.component ?? '<unspecified>';
      components.add(comp);
      const compSet = perComponentKeys.get(comp) ?? new Set();
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

/**
 * Deterministic threshold logic. Fires ONLY when there is NEW evidence past the
 * last-ack baseline (seeded-closed suppression + dedup re-raise) AND a severity
 * arm crosses:
 *   - critical  ⇒ escalates at ≥1 confirmed instance (any new evidence).
 *   - normal    ⇒ ≥N across ≥2 components, OR ≥2 + an open gap, OR ≥K in one component.
 * @param {{ severity: string, evidenceCountAtLastAck: number }} entry
 * @param {object} derived  DerivedClassData
 * @param {{ spreadN?: number, singleK?: number }} thresholds
 */
export function computeEscalation(entry, derived, thresholds = {}) {
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
export function gapOpenPastMaxAge(gapOpenedAtIso, now = Date.now(), maxAgeDays = DEFAULT_GAP_MAX_AGE_DAYS) {
  const opened = Date.parse(gapOpenedAtIso);
  if (Number.isNaN(opened)) return false;
  const ageDays = (now - opened) / (24 * 60 * 60 * 1000);
  return ageDays > maxAgeDays;
}

import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

export const checkerIdFor = (kind, relativePath) =>
  `${kind}:${relativePath.split(path.sep).join('/')}`;

function candidateKind(relativePath) {
  const rel = relativePath.split(path.sep).join('/');
  const base = path.posix.basename(rel);
  const ext = path.posix.extname(base);
  if (rel.startsWith('scripts/') && SCRIPT_EXTENSIONS.has(ext) && /^(lint-|check-)/.test(base)) {
    return 'script';
  }
  if (rel.startsWith('src/monitoring/probes/') && SOURCE_EXTENSIONS.has(ext) && /probe/i.test(base)) {
    return 'probe';
  }
  if (rel.startsWith('src/core/reviewers/') && SOURCE_EXTENSIONS.has(ext) && !base.endsWith('.d.ts')) {
    return 'reviewer';
  }
  if (rel.startsWith('src/') && SOURCE_EXTENSIONS.has(ext) && /detector(?:log)?\.(?:ts|tsx)$/i.test(base)) {
    return 'detector';
  }
  return null;
}

/** Apply the production census rule to a repository-relative path. */
export function checkerIdForCandidatePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const kind = candidateKind(normalized);
  return kind ? checkerIdFor(kind, normalized) : null;
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`checker population unavailable: cannot read ${path.relative(root, dir) || '.'}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'coverage') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    const rel = path.relative(root, full).split(path.sep).join('/');
    const id = checkerIdForCandidatePath(rel);
    if (!id) continue;
    try {
      fs.readFileSync(full, 'utf8');
    } catch (error) {
      throw new Error(`checker population unavailable: cannot read ${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
    out.push({ id, kind: id.slice(0, id.indexOf(':')), relativePath: rel });
  }
}

/** Derive the checker denominator from production code paths, recursively. */
export function deriveCheckerPopulation(root) {
  const resolved = path.resolve(root);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new Error(`checker population unavailable: root cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isDirectory()) throw new Error('checker population unavailable: root is not a directory');
  const population = [];
  walk(resolved, path.join(resolved, 'scripts'), population);
  walk(resolved, path.join(resolved, 'src'), population);
  population.sort((a, b) => a.id.localeCompare(b.id));
  if (population.length === 0) {
    throw new Error('checker population empty: 0/0 is NOT-PROVEN, never clean');
  }
  return population;
}

/**
 * Numeric legacy-debt ratchet. Coverage IDs name executable blind cases; the
 * denominator is always derived above. The uncovered count may only shrink.
 */
export function evaluateBlindInputCoverage({ population, coverageIds, maxUncovered }) {
  if (!Array.isArray(population) || population.length === 0) {
    return { passed: false, reason: 'empty-population', populationCount: 0, coveredCount: 0, uncovered: [] };
  }
  const ids = population.map((entry) => typeof entry === 'string' ? entry : entry.id);
  const populationSet = new Set(ids);
  if (populationSet.size !== ids.length) {
    return { passed: false, reason: 'duplicate-population-id', populationCount: ids.length, coveredCount: 0, uncovered: [] };
  }
  const coverage = [...new Set(coverageIds)];
  const unknownCoverage = coverage.filter((id) => !populationSet.has(id));
  if (unknownCoverage.length > 0) {
    return { passed: false, reason: 'coverage-id-not-in-population', populationCount: ids.length, coveredCount: 0, uncovered: ids, unknownCoverage };
  }
  const covered = new Set(coverage);
  const uncovered = ids.filter((id) => !covered.has(id));
  const passed = uncovered.length <= maxUncovered;
  return {
    passed,
    reason: passed ? 'within-ratchet' : 'uncovered-checker-count-increased',
    populationCount: ids.length,
    coveredCount: covered.size,
    uncovered,
    maxUncovered,
  };
}

/**
 * A new checker is not legacy debt. It may enter the covered set only when the
 * executable case runner produced a fresh proof for that exact checker ID.
 * Comparing identities (rather than only cardinality) prevents a removed
 * legacy checker from donating its grandfathered slot to a new unchecked one.
 */
export function evaluateProtectedBlindInputCoverage({
  population,
  protectedPopulationIds,
  executionProvenIds,
  maxUncovered,
}) {
  if (!Array.isArray(protectedPopulationIds) || protectedPopulationIds.length === 0) {
    return {
      passed: false,
      reason: 'protected-population-unavailable',
      populationCount: Array.isArray(population) ? population.length : 0,
      coveredCount: 0,
      uncovered: [],
    };
  }
  const basic = evaluateBlindInputCoverage({
    population,
    coverageIds: executionProvenIds,
    maxUncovered,
  });
  if (basic.reason === 'empty-population' || basic.reason === 'duplicate-population-id' ||
      basic.reason === 'coverage-id-not-in-population') return basic;

  const ids = population.map((entry) => typeof entry === 'string' ? entry : entry.id);
  const protectedSet = new Set(protectedPopulationIds);
  const provenSet = new Set(executionProvenIds);
  const newCheckerIds = ids.filter((id) => !protectedSet.has(id));
  const newWithoutExecutionProof = newCheckerIds.filter((id) => !provenSet.has(id));
  if (newWithoutExecutionProof.length > 0) {
    return {
      ...basic,
      passed: false,
      reason: 'new-checker-without-execution-proof',
      newCheckerIds,
      newWithoutExecutionProof,
    };
  }
  return { ...basic, newCheckerIds, newWithoutExecutionProof: [] };
}

/**
 * Bootstrap from what was actually demonstrated, not from candidate enrollment.
 * Once a protected copy records a lower ceiling it remains the upper bound.
 */
export function deriveProtectedCeiling({
  protectedPopulationIds,
  executionProvenIds,
  recordedProtectedCeiling = null,
}) {
  if (!Array.isArray(protectedPopulationIds) || protectedPopulationIds.length === 0) {
    throw new Error('protected checker population empty');
  }
  const proven = new Set(executionProvenIds);
  const executionDerived = protectedPopulationIds.filter((id) => !proven.has(id)).length;
  if (recordedProtectedCeiling === null) return executionDerived;
  if (!Number.isSafeInteger(recordedProtectedCeiling) || recordedProtectedCeiling < 0) {
    throw new Error('protected ceiling malformed');
  }
  return Math.min(recordedProtectedCeiling, executionDerived);
}

/** A legacy-debt ceiling is allowed to stay level or fall, never rise. */
export function evaluateCeilingRatchet({ currentCeiling, protectedCeiling }) {
  if (!Number.isSafeInteger(currentCeiling) || currentCeiling < 0 ||
      !Number.isSafeInteger(protectedCeiling) || protectedCeiling < 0) {
    return { passed: false, reason: 'invalid-ratchet-ceiling', currentCeiling, protectedCeiling };
  }
  return {
    passed: currentCeiling <= protectedCeiling,
    reason: currentCeiling <= protectedCeiling ? 'ceiling-held-or-lowered' : 'ratchet-ceiling-raised',
    currentCeiling,
    protectedCeiling,
  };
}

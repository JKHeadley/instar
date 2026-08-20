// safe-git-allow: standalone prebuild lint uses only read-only merge-base/ls-tree/show; compiled SafeGitExecutor is not reliably available yet.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  deriveCheckerPopulation,
  checkerIdForCandidatePath,
  evaluateBlindInputCoverage,
  evaluateCeilingRatchet,
} from './lib/checker-blind-input-ratchet.mjs';
import { BLIND_INPUT_CASE_IDS } from './checker-blind-input-cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 2026-08-17 baseline: 96 code-derived checkers, 5 executable blind cases.
// This legacy debt ceiling may only shrink; a new uncovered checker fails.
export const MAX_UNCOVERED_CHECKERS = 91;
const CEILING_SOURCE = 'scripts/lint-checker-blind-input-coverage.mjs';

function option(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(root, args) {
  const child = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (child.error || child.status !== 0) return null;
  return child.stdout.trim();
}

/**
 * Read the ceiling from the protected branch's merge base. On the first change
 * that introduces this file, derive the bootstrap ceiling from the protected
 * tree itself: candidate bytes contain no second number they can raise.
 * Prefer the fleet upstream when it is configured; CI names that remote origin.
 */
export function readProtectedCeiling(root) {
  // Deliberately no environment/argv override: candidate-controlled input may
  // not redefine the authority it is compared against (especially to HEAD).
  const refs = ['upstream/main', 'origin/main'];
  let sawReachableBase = false;
  for (const ref of refs) {
    const base = git(root, ['merge-base', 'HEAD', ref]);
    if (!base) continue;
    sawReachableBase = true;
    const tree = git(root, ['ls-tree', '-r', '--name-only', base]);
    if (tree === null) throw new Error(`protected checker population unreadable at ${base.slice(0, 12)}`);
    const protectedIds = tree.split('\n').map(checkerIdForCandidatePath).filter(Boolean);
    if (protectedIds.length === 0) throw new Error(`protected checker population empty at ${base.slice(0, 12)}`);
    const covered = new Set(BLIND_INPUT_CASE_IDS);
    const derivedCeiling = protectedIds.filter((id) => !covered.has(id)).length;
    const source = git(root, ['show', `${base}:${CEILING_SOURCE}`]);
    if (source === null) return derivedCeiling;
    const match = source.match(/export const MAX_UNCOVERED_CHECKERS = (\d+);/);
    if (!match) throw new Error(`protected ceiling unreadable at ${base.slice(0, 12)}:${CEILING_SOURCE}`);
    return Math.min(Number(match[1]), derivedCeiling);
  }
  if (!sawReachableBase) throw new Error('protected ceiling unavailable: no reachable upstream/main or origin/main merge base');
  throw new Error('protected ceiling unavailable');
}

export function runCheckerBlindInputCoverage({
  root = option('--root') ?? ROOT,
  executeCases = !process.argv.includes('--structural-only'),
} = {}) {
  const protectedCeiling = readProtectedCeiling(ROOT);
  const ceiling = evaluateCeilingRatchet({
    currentCeiling: MAX_UNCOVERED_CHECKERS,
    protectedCeiling,
  });
  if (!ceiling.passed) {
    console.error(`checker-blind-input: NOT-PROVEN — ${ceiling.reason}`);
    console.error(JSON.stringify(ceiling, null, 2));
    return 1;
  }
  const population = deriveCheckerPopulation(root);
  const result = evaluateBlindInputCoverage({
    population,
    coverageIds: BLIND_INPUT_CASE_IDS,
    maxUncovered: MAX_UNCOVERED_CHECKERS,
  });
  if (!result.passed) {
    console.error(`checker-blind-input: NOT-PROVEN — ${result.reason}`);
    console.error(JSON.stringify(result, null, 2));
    return 1;
  }
  console.log(
    `checker-blind-input: population=${result.populationCount} ` +
    `covered=${result.coveredCount} legacy-uncovered=${result.uncovered.length}/${MAX_UNCOVERED_CHECKERS}`,
  );
  if (!executeCases) return 0;

  const vitest = path.join(root, 'node_modules', '.bin', 'vitest');
  const child = spawnSync(vitest, [
    'run',
    'tests/unit/checker-blind-input-ratchet.test.ts',
    '--reporter=dot',
  ], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, INSTAR_CHECKER_BLIND_PIPELINE: '1' },
  });
  if (child.error) {
    console.error(`checker-blind-input: NOT-PROVEN — blind-case runner unavailable: ${child.error.message}`);
    return 1;
  }
  if (child.status !== 0) {
    console.error(`checker-blind-input: NOT-PROVEN — executable blind cases exited ${child.status}`);
    return 1;
  }
  console.log('checker-blind-input: executable blind cases passed');
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    process.exitCode = runCheckerBlindInputCoverage();
  } catch (error) {
    console.error(`checker-blind-input: NOT-PROVEN — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

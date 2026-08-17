#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  deriveCheckerPopulation,
  evaluateBlindInputCoverage,
} from './lib/checker-blind-input-ratchet.mjs';
import { BLIND_INPUT_CASE_IDS } from './checker-blind-input-cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 2026-08-17 baseline: 96 code-derived checkers, 5 executable blind cases.
// This legacy debt ceiling may only shrink; a new uncovered checker fails.
export const MAX_UNCOVERED_CHECKERS = 91;

function option(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function runCheckerBlindInputCoverage({
  root = option('--root') ?? ROOT,
  executeCases = !process.argv.includes('--structural-only'),
} = {}) {
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

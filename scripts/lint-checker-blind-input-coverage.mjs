// safe-git-allow: standalone prebuild lint uses only read-only merge-base/ls-tree/show; compiled SafeGitExecutor is not reliably available yet.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  deriveCheckerPopulation,
  deriveProtectedCeiling,
  checkerIdForCandidatePath,
  evaluateProtectedBlindInputCoverage,
  evaluateCeilingRatchet,
} from './lib/checker-blind-input-ratchet.mjs';
import { BLIND_INPUT_CASE_IDS } from './checker-blind-input-cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 2026-08-17 baseline: 96 code-derived checkers, 5 executable blind cases.
// This legacy debt ceiling may only shrink; a new uncovered checker fails.
export const MAX_UNCOVERED_CHECKERS = 91;
const CEILING_SOURCE = 'scripts/lint-checker-blind-input-coverage.mjs';
const CANONICAL_PROTECTED_REMOTE = 'https://github.com/JKHeadley/instar.git';
const PROTECTED_MAIN_REF = 'refs/heads/main';
const EXECUTION_RECORD_PREFIX = 'CHECKER_BLIND_EXECUTION ';
const SYSTEM_GIT = '/usr/bin/git';

function option(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(root, args, timeout = 15_000) {
  const {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _alternateObjects,
    GIT_CONFIG_COUNT: _configCount,
    GIT_CONFIG_PARAMETERS: _configParameters,
    GIT_DIR: _gitDir,
    GIT_OBJECT_DIRECTORY: _objectDirectory,
    GIT_WORK_TREE: _workTree,
    ...ambient
  } = process.env;
  const child = spawnSync(SYSTEM_GIT, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    env: { ...ambient, GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (child.error || child.status !== 0) return null;
  return child.stdout.trim();
}

function canonicalRemoteMain(root) {
  const child = spawnSync(SYSTEM_GIT, [
    'ls-remote',
    '--refs',
    CANONICAL_PROTECTED_REMOTE,
    PROTECTED_MAIN_REF,
  ], {
    // Outside the candidate repository, with system/global/local config and
    // replacement objects disabled. Candidate URL rewrites cannot redirect
    // the pinned HTTPS authority.
    cwd: path.parse(root).root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: path.parse(root).root,
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (child.error || child.status !== 0) return null;
  return child.stdout.trim();
}

/**
 * Resolve the protected side through the canonical server, then use only the
 * content-addressed SHA returned by that server. Local refs and candidate
 * remotes are deliberately absent from this trust path.
 */
export function readProtectedState(root) {
  const advertised = canonicalRemoteMain(root);
  const fields = advertised?.split(/\s+/) ?? [];
  if (fields.length !== 2 || fields[1] !== PROTECTED_MAIN_REF || !/^[0-9a-f]{40}$/.test(fields[0])) {
    throw new Error('protected main unavailable from canonical server');
  }
  return readProtectedStateAt(root, fields[0]);
}

/** Resolve a caller-supplied content-addressed SHA; production obtains it only above. */
export function readProtectedStateAt(root, protectedMainSha) {
  if (!/^[0-9a-f]{40}$/.test(protectedMainSha)) throw new Error('protected main SHA is malformed');
  const base = git(root, ['merge-base', 'HEAD', protectedMainSha]);
  if (!base || !/^[0-9a-f]{40}$/.test(base)) {
    throw new Error(`protected merge base unavailable for canonical main ${protectedMainSha.slice(0, 12)}`);
  }
  const tree = git(root, ['ls-tree', '-r', '--name-only', base]);
  if (tree === null) throw new Error(`protected checker population unreadable at ${base.slice(0, 12)}`);
  const populationIds = tree.split('\n').map(checkerIdForCandidatePath).filter(Boolean);
  if (populationIds.length === 0) throw new Error(`protected checker population empty at ${base.slice(0, 12)}`);

  const source = git(root, ['show', `${base}:${CEILING_SOURCE}`]);
  let recordedCeiling = null;
  if (source !== null) {
    const match = source.match(/export const MAX_UNCOVERED_CHECKERS = (\d+);/);
    if (!match) throw new Error(`protected ceiling unreadable at ${base.slice(0, 12)}:${CEILING_SOURCE}`);
    recordedCeiling = Number(match[1]);
  }
  return { protectedMainSha, baseSha: base, populationIds, recordedCeiling };
}

function parseExecutionRecords(output) {
  const records = [];
  for (const line of output.split('\n')) {
    const marker = line.indexOf(EXECUTION_RECORD_PREFIX);
    if (marker === -1) continue;
    try {
      records.push(JSON.parse(line.slice(marker + EXECUTION_RECORD_PREFIX.length)));
    } catch {
      throw new Error('blind-case deciding output is malformed');
    }
  }
  const ids = records.map((record) => record?.id);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new Error('blind-case deciding output has missing or duplicate checker IDs');
  }
  if (records.some((record) => record.control !== 'clean' || record.blind !== 'refused' ||
      !Number.isSafeInteger(record.controlInvocations) || record.controlInvocations < 1 ||
      !Number.isSafeInteger(record.blindInvocations) || record.blindInvocations < 1)) {
    throw new Error('blind-case deciding output lacks observed invocation, a clean control, or blind refusal');
  }
  return ids;
}

function runExecutableCases(root) {
  const vitest = path.join(root, 'node_modules', '.bin', 'vitest');
  const child = spawnSync(vitest, [
    'run',
    'tests/unit/checker-blind-input-ratchet.test.ts',
    '--reporter=dot',
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, INSTAR_CHECKER_BLIND_PIPELINE: '1' },
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) throw new Error(`blind-case runner unavailable: ${child.error.message}`);
  if (child.status !== 0) throw new Error(`executable blind cases exited ${child.status}`);
  const executionIds = parseExecutionRecords(`${child.stdout ?? ''}\n${child.stderr ?? ''}`);
  const declared = [...BLIND_INPUT_CASE_IDS].sort();
  const observed = [...executionIds].sort();
  if (JSON.stringify(declared) !== JSON.stringify(observed)) {
    throw new Error(`declared coverage lacks matching execution proof: declared=${declared.length} observed=${observed.length}`);
  }
  return executionIds;
}

export function runCheckerBlindInputCoverage({
  root = option('--root') ?? ROOT,
  executeCases = !process.argv.includes('--structural-only'),
} = {}) {
  if (!executeCases) {
    console.error('checker-blind-input: NOT-PROVEN — execution-evidence-required');
    return 1;
  }
  const executionProvenIds = runExecutableCases(root);
  const protectedState = readProtectedState(ROOT);
  const protectedCeiling = deriveProtectedCeiling({
    protectedPopulationIds: protectedState.populationIds,
    executionProvenIds,
    recordedProtectedCeiling: protectedState.recordedCeiling,
  });
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
  const result = evaluateProtectedBlindInputCoverage({
    population,
    protectedPopulationIds: protectedState.populationIds,
    executionProvenIds,
    maxUncovered: MAX_UNCOVERED_CHECKERS,
  });
  if (!result.passed) {
    console.error(`checker-blind-input: NOT-PROVEN — ${result.reason}`);
    console.error(JSON.stringify(result, null, 2));
    return 1;
  }
  console.log(
    `checker-blind-input: population=${result.populationCount} ` +
    `execution-proven=${result.coveredCount} legacy-uncovered=${result.uncovered.length}/${MAX_UNCOVERED_CHECKERS} ` +
    `new-checkers=${result.newCheckerIds.length} protected-base=${protectedState.baseSha.slice(0, 12)}`,
  );
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

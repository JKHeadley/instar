// safe-git-allow: standalone prebuild lint uses only read-only merge-base/ls-tree/show; compiled SafeGitExecutor is not reliably available yet.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
const SYSTEM_GIT = '/usr/bin/git';
const VITE_NODE_ENTRY = 'node_modules/vite-node/vite-node.mjs';
const CORE_WORKER_LABEL = 'core-generated-checker-case-worker.ts';
const CORE_RECEIPT_PREFIX = 'CHECKER_BLIND_CORE_RECEIPT ';

class GuardMeasurementError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function unknown(message) {
  return new GuardMeasurementError('UNKNOWN', message);
}

function notProven(message) {
  return new GuardMeasurementError('NOT-PROVEN', message);
}

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
    throw unknown('protected main unavailable from canonical server');
  }
  return readProtectedStateAt(root, fields[0]);
}

/** Resolve a caller-supplied content-addressed SHA; production obtains it only above. */
export function readProtectedStateAt(root, protectedMainSha) {
  if (!/^[0-9a-f]{40}$/.test(protectedMainSha)) throw unknown('protected main SHA is malformed');
  const base = git(root, ['merge-base', 'HEAD', protectedMainSha]);
  if (!base || !/^[0-9a-f]{40}$/.test(base)) {
    throw unknown(`protected merge base unavailable for canonical main ${protectedMainSha.slice(0, 12)}`);
  }
  const tree = git(root, ['ls-tree', '-r', '--name-only', base]);
  if (tree === null) throw unknown(`protected checker population unreadable at ${base.slice(0, 12)}`);
  const populationIds = tree.split('\n').map(checkerIdForCandidatePath).filter(Boolean);
  if (populationIds.length === 0) throw unknown(`protected checker population empty at ${base.slice(0, 12)}`);

  const source = git(root, ['show', `${base}:${CEILING_SOURCE}`]);
  let recordedCeiling = null;
  if (source !== null) {
    const match = source.match(/export const MAX_UNCOVERED_CHECKERS = (\d+);/);
    if (!match) throw unknown(`protected ceiling unreadable at ${base.slice(0, 12)}:${CEILING_SOURCE}`);
    recordedCeiling = Number(match[1]);
  }
  return { protectedMainSha, baseSha: base, populationIds, recordedCeiling };
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw notProven(`core execution receipt is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function coreWorkerSource(root) {
  const moduleUrl = (relativePath) => new URL(relativePath, `file://${root.replaceAll('\\', '/')}/`).href;
  return `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from ${JSON.stringify(moduleUrl('src/core/SafeFsExecutor.ts'))};
import { runLint } from ${JSON.stringify(moduleUrl('scripts/lint-llm-attribution.js'))};
import { createGuardPostureProbes } from ${JSON.stringify(moduleUrl('src/monitoring/probes/GuardPostureProbe.ts'))};
import { StandardsConformanceReviewer } from ${JSON.stringify(moduleUrl('src/core/reviewers/standards-conformance.ts'))};
import { HumanAsDetectorLog } from ${JSON.stringify(moduleUrl('src/monitoring/HumanAsDetectorLog.ts'))};
import { deriveCheckerPopulation } from ${JSON.stringify(moduleUrl('scripts/lib/checker-blind-input-ratchet.mjs'))};
const root = ${JSON.stringify(root)};
const id = process.argv[2];
const phase = process.argv[3];
if (phase !== 'control' && phase !== 'blind') process.exit(2);
async function observe() {
  switch (id) {
    case 'script:scripts/lint-llm-attribution.js': {
      if (phase === 'blind') {
        const result = runLint([path.join(root, 'src', '.checker-blind-attribution-missing.ts')]);
        return result.real.length === 0 && result.stale.length === 0 && result.blind.length === 0;
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-core-attribution-'));
      try {
        const file = path.join(dir, 'readable.ts');
        fs.writeFileSync(file, 'export const readable = true;\\n');
        const result = runLint([file]);
        return result.real.length === 0 && result.stale.length === 0 && result.blind.length === 0;
      } finally {
        SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'checker-core:attribution' });
      }
    }
    case 'probe:src/monitoring/probes/GuardPostureProbe.ts': {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-core-guard-'));
      try {
        const [probe] = createGuardPostureProbes(phase === 'control' ? {
          getLocalPosture: () => ({ guards: [], summary: {
            onConfirmed: 0, onUnverified: 0, onStale: 0, onDryRun: 0,
            off: 0, offDeviant: 0, offDarkDefault: 0, divergedPendingRestart: 0,
            errored: 0, missing: 0, offRuntimeDivergent: 0, runtimeEnriched: '0/0',
          } }),
          getPeerPostures: () => [], emitAttention: async () => {}, stateDir,
        } : {
          getLocalPosture: () => null,
          getPeerPostures: () => [{ machineId: 'blind-peer', online: true, posture: null, postureAgeMs: null }],
          deepReadPeer: async () => { throw new Error('unreachable'); },
          emitAttention: async () => {}, stateDir,
        });
        const result = await probe.run();
        return result.passed;
      } finally {
        SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'checker-core:guard' });
      }
    }
    case 'reviewer:src/core/reviewers/standards-conformance.ts': {
      const articles = [{ family: 'Interaction', name: 'Signal vs. Authority', rule: 'Independent judgment.', inPractice: '' }];
      let calls = 0;
      const provider = phase === 'control' ? {
        async evaluate() { calls += 1; return calls === 1 ? '[]' : '{"verdict":"fit","reason":"control"}'; },
      } : { async evaluate() { throw new Error('provider down'); } };
      const reviewer = new StandardsConformanceReviewer(provider);
      const report = await reviewer.review('spec', articles);
      const fit = await reviewer.judgeFit('spec', 'Signal vs. Authority', articles);
      return phase === 'control'
        ? report.conclusion === 'fits' && fit.verdict === 'fit'
        : report.conclusion === 'fits' || fit.verdict === 'fit';
    }
    case 'detector:src/monitoring/HumanAsDetectorLog.ts': {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-core-detector-'));
      try {
        if (phase === 'blind') fs.writeFileSync(path.join(stateDir, 'metrics'), 'not a directory');
        HumanAsDetectorLog.resetForTesting();
        const log = HumanAsDetectorLog.getInstance();
        log.configure({ stateDir, agentName: 'checker-core' });
        const originalWarn = console.warn;
        const originalError = console.error;
        console.warn = () => {};
        console.error = () => {};
        try { log.observe({ text: "that's wrong", source: 'test', topicId: 29723 }); }
        finally { console.warn = originalWarn; console.error = originalError; }
        return log.getCaptureFailures().length === 0;
      } finally {
        HumanAsDetectorLog.resetForTesting();
        SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'checker-core:detector' });
      }
    }
    case 'script:scripts/lint-checker-blind-input-coverage.mjs': {
      if (phase === 'control') return deriveCheckerPopulation(root).length > 0;
      let rejected = false;
      try { deriveCheckerPopulation(path.join(root, '__missing-checker-root__')); } catch { rejected = true; }
      return !rejected;
    }
    default: throw new Error('core has no executable case for ' + String(id));
  }
}
try {
  const clean = await observe();
  process.exitCode = (phase === 'control' ? clean : !clean) ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;
}

function observerSource({ realNode, root, worker, receiptFile, tokenHash, declaredIds }) {
  return `#!${realNode}\n`
    + `import fs from 'node:fs';\n`
    + `import path from 'node:path';\n`
    + `import { spawn } from 'node:child_process';\n`
    + `const argv = process.argv.slice(2);\n`
    + `const root = ${JSON.stringify(root)};\n`
    + `const realNode = ${JSON.stringify(realNode)};\n`
    + `const expectedEntry = path.resolve(root, ${JSON.stringify(VITE_NODE_ENTRY)});\n`
    + `const expectedWorker = ${JSON.stringify(worker)};\n`
    + `const declared = new Set(${JSON.stringify(declaredIds)});\n`
    + `const resolve = (value) => { try { return fs.realpathSync(path.resolve(root, value)); } catch { return path.resolve(root, value); } };\n`
    + `const scriptIndex = argv.indexOf('--script');\n`
    + `const id = scriptIndex >= 0 ? argv[scriptIndex + 2] : null;\n`
    + `const phase = scriptIndex >= 0 ? argv[scriptIndex + 3] : null;\n`
    + `const target = argv.length > 0 && resolve(argv[0]) === resolve(expectedEntry) && resolve(argv[scriptIndex + 1] ?? '') === resolve(expectedWorker) && declared.has(id) && (phase === 'control' || phase === 'blind');\n`
    + `const child = spawn(realNode, argv, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });\n`
    + `const forward = (signal) => { try { child.kill(signal); } catch {} };\n`
    + `for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => forward(signal));\n`
    + `child.once('error', (error) => { console.error(error.message); process.exit(1); });\n`
    + `child.once('exit', (code, signal) => {\n`
    + `  const childExitCode = typeof code === 'number' ? code : null;\n`
    + `  if (target) {\n`
    + `    const receipt = { source: 'checker-blind-core', tokenSha256: ${JSON.stringify(tokenHash)}, id, phase, nodeEntry: ${JSON.stringify(VITE_NODE_ENTRY)}, worker: ${JSON.stringify(CORE_WORKER_LABEL)}, childExitCode, signal: signal ?? null, emittedAfterChildExit: true };\n`
    + `    fs.appendFileSync(${JSON.stringify(receiptFile)}, JSON.stringify(receipt) + '\\n', 'utf8');\n`
    + `  }\n`
    + `  process.exit(childExitCode ?? 1);\n`
    + `});\n`;
}

export function validateCoreExecutionReceipts({ records, tokenHash, declaredIds }) {
  const expected = new Set(declaredIds.flatMap((id) => [`${id}\u0000control`, `${id}\u0000blind`]));
  const seen = new Set();
  const invalid = [];
  for (const record of records) {
    const key = `${String(record?.id)}\u0000${String(record?.phase)}`;
    const valid = record?.source === 'checker-blind-core'
      && record.tokenSha256 === tokenHash
      && record.nodeEntry === VITE_NODE_ENTRY
      && record.worker === CORE_WORKER_LABEL
      && record.childExitCode === 0
      && record.emittedAfterChildExit === true
      && expected.has(key)
      && !seen.has(key);
    if (!valid) invalid.push(record);
    else seen.add(key);
  }
  const missing = [...expected].filter((key) => !seen.has(key));
  return { passed: invalid.length === 0 && missing.length === 0 && seen.size === expected.size, invalid, missing };
}

function runExecutableCases(root) {
  const vitest = path.join(root, 'node_modules', '.bin', 'vitest');
  const declared = [...BLIND_INPUT_CASE_IDS].sort();
  const token = `${crypto.randomUUID()}-${crypto.randomBytes(16).toString('hex')}`;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const observerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-blind-core-'));
  const receiptFile = path.join(observerRoot, 'receipts.jsonl');
  const wrapper = path.join(observerRoot, 'node');
  const worker = path.join(observerRoot, CORE_WORKER_LABEL);
  try {
    fs.writeFileSync(worker, coreWorkerSource(fs.realpathSync(root)), 'utf8');
    fs.writeFileSync(wrapper, observerSource({
      realNode: process.execPath,
      root,
      worker,
      receiptFile,
      tokenHash,
      declaredIds: declared,
    }), { mode: 0o755 });
    const child = spawnSync(vitest, [
      'run',
      'tests/unit/checker-blind-input-ratchet.test.ts',
      '--reporter=dot',
    ], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${observerRoot}${path.delimiter}${process.env.PATH ?? ''}`,
        INSTAR_CHECKER_BLIND_PIPELINE: '1',
        INSTAR_CHECKER_BLIND_CORE_WORKER: worker,
      },
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) throw unknown(`blind-case runner unavailable: ${child.error.message}`);
    if (child.status !== 0) throw notProven(`executable blind cases exited ${child.status}`);
    const records = readJsonLines(receiptFile);
    const validation = validateCoreExecutionReceipts({ records, tokenHash, declaredIds: declared });
    if (!validation.passed) {
      throw notProven(`independent checker execution receipt incomplete: missing=${validation.missing.length} invalid=${validation.invalid.length}`);
    }
    for (const record of records) {
      console.log(`${CORE_RECEIPT_PREFIX}${JSON.stringify(record)}`);
    }
    return declared;
  } finally {
    fs.rmSync(observerRoot, { recursive: true, force: true });
  }
}

export function runCheckerBlindInputCoverage({
  root = option('--root') ?? ROOT,
  executeCases = !process.argv.includes('--structural-only'),
} = {}) {
  if (!executeCases) {
    console.error('checker-blind-input: UNKNOWN — execution-evidence-required');
    return 1;
  }
  const protectedState = readProtectedState(ROOT);
  const population = deriveCheckerPopulation(root);
  const executionProvenIds = runExecutableCases(root);
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
    const status = error instanceof GuardMeasurementError
      ? error.status
      : /(?:population unavailable|population unreadable|population empty|protected main|protected merge base|protected ceiling unreadable)/i.test(error instanceof Error ? error.message : String(error))
        ? 'UNKNOWN'
        : 'NOT-PROVEN';
    console.error(`checker-blind-input: ${status} — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

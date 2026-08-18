import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { runLint } from '../../scripts/lint-llm-attribution.js';
import { createGuardPostureProbes } from '../../src/monitoring/probes/GuardPostureProbe.js';
import { StandardsConformanceReviewer } from '../../src/core/reviewers/standards-conformance.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import type { StandardArticle } from '../../src/core/StandardsRegistryParser.js';
import { HumanAsDetectorLog } from '../../src/monitoring/HumanAsDetectorLog.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { BLIND_INPUT_CASE_IDS } from '../../scripts/checker-blind-input-cases.mjs';
import {
  deriveProtectedCeiling,
  deriveCheckerPopulation,
  evaluateBlindInputCoverage,
  evaluateProtectedBlindInputCoverage,
  evaluateCeilingRatchet,
} from '../../scripts/lib/checker-blind-input-ratchet.mjs';
import {
  MAX_UNCOVERED_CHECKERS,
  readProtectedStateAt,
  validateCoreExecutionReceipts,
} from '../../scripts/lint-checker-blind-input-coverage.mjs';
import { createAuthenticatedReceiptAuthority } from '../../scratchpad/phaseB/authenticated-execution-receipt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CASE_WORKER = process.env.INSTAR_CHECKER_BLIND_CORE_WORKER
  ?? path.join(ROOT, 'tests', 'helpers', 'checker-blind-input-case-worker.ts');
const VITE_NODE = path.join(ROOT, 'node_modules', '.bin', 'vite-node');

interface BlindObservation {
  /** Independent test oracle: true means the checker reported clean while blind. */
  clean: boolean;
  /** Candidate testimony retained only for the attack fixture; never credited. */
  invocations?: number;
  evidence: unknown;
  /** Optional subject testimony; deliberately ignored by the oracle. */
  subjectClaim?: string;
}

interface BlindCase {
  control: () => Promise<BlindObservation> | BlindObservation;
  blind: () => Promise<BlindObservation> | BlindObservation;
}

function runObservedCaseChild(id: string, phase: 'control' | 'blind') {
  const child = spawnSync(VITE_NODE, ['--script', CASE_WORKER, id, phase], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    passed: child.status === 0 && !child.error,
    exitCode: child.status,
    output: `${child.stdout ?? ''}${child.stderr ?? ''}`.trim(),
    spawnError: child.error?.message ?? null,
  };
}

async function executeBlindCases(cases: Map<string, BlindCase>, { requireObservedChildren = true } = {}) {
  const failures: Array<{ id: string; phase: 'control' | 'blind'; reason: string; evidence: unknown }> = [];
  const provenIds: string[] = [];
  for (const [id, run] of cases) {
    const control = await run.control();
    const blind = await run.blind();
    const controlChild = requireObservedChildren ? runObservedCaseChild(id, 'control') : { passed: true };
    const blindChild = requireObservedChildren ? runObservedCaseChild(id, 'blind') : { passed: true };
    if (!control.clean || !controlChild.passed) {
      failures.push({
        id,
        phase: 'control',
        reason: !control.clean ? 'control-not-clean' : 'checker-not-observed',
        evidence: !controlChild.passed ? controlChild : control.evidence,
      });
    }
    if (blind.clean || !blindChild.passed) {
      failures.push({
        id,
        phase: 'blind',
        reason: blind.clean ? 'blind-input-accepted' : 'checker-not-observed',
        evidence: !blindChild.passed ? blindChild : blind.evidence,
      });
    }
    if (control.clean && !blind.clean && controlChild.passed && blindChild.passed) {
      provenIds.push(id);
    }
  }
  return { failures, provenIds };
}

const CASES = new Map<string, BlindCase>([
  ['script:scripts/lint-llm-attribution.js', {
    control: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-control-attribution-'));
      const file = path.join(dir, 'readable.ts');
      try {
        fs.writeFileSync(file, 'export const readable = true;\n');
        let invocations = 0;
        invocations += 1;
        const result = runLint([file]);
        return { clean: result.real.length === 0 && result.stale.length === 0 && result.blind.length === 0, invocations, evidence: result };
      } finally {
        SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'checker-blind-input:attribution-control' });
      }
    },
    blind: () => {
      const file = path.join(ROOT, 'src', `.checker-blind-attribution-missing-${process.pid}.ts`);
      let invocations = 0;
      invocations += 1;
      const result = runLint([file]);
      return {
        clean: result.real.length === 0 && result.stale.length === 0 && result.blind.length === 0,
        invocations,
        evidence: result,
        subjectClaim: 'process exit is intentionally not trusted by this case',
      };
    },
  }],
  ['probe:src/monitoring/probes/GuardPostureProbe.ts', {
    control: async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-control-guard-'));
      try {
        const [probe] = createGuardPostureProbes({
          getLocalPosture: () => ({
            guards: [],
            summary: {
              onConfirmed: 0, onUnverified: 0, onStale: 0, onDryRun: 0,
              off: 0, offDeviant: 0, offDarkDefault: 0, divergedPendingRestart: 0,
              errored: 0, missing: 0, offRuntimeDivergent: 0, runtimeEnriched: '0/0',
            },
          }),
          getPeerPostures: () => [],
          emitAttention: async () => {},
          stateDir,
        });
        let invocations = 0;
        invocations += 1;
        const result = await probe.run();
        return { clean: result.passed, invocations, evidence: result };
      } finally {
        SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'checker-blind-input:guard-control' });
      }
    },
    blind: async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-blind-guard-'));
      try {
        const [probe] = createGuardPostureProbes({
          getLocalPosture: () => null,
          getPeerPostures: () => [{ machineId: 'blind-peer', online: true, posture: null, postureAgeMs: null }],
          deepReadPeer: async () => { throw new Error('unreachable'); },
          emitAttention: async () => {},
          stateDir,
        });
        let invocations = 0;
        invocations += 1;
        const result = await probe.run();
        return { clean: result.passed, invocations, evidence: result };
      } finally {
        SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'checker-blind-input:guard' });
      }
    },
  }],
  ['reviewer:src/core/reviewers/standards-conformance.ts', {
    control: async () => {
      const articles: StandardArticle[] = [{
        family: 'Interaction', name: 'Signal vs. Authority', rule: 'Independent judgment.', inPractice: '',
      }];
      let calls = 0;
      const provider: IntelligenceProvider = {
        async evaluate() {
          calls += 1;
          return calls === 1 ? '[]' : '{"verdict":"fit","reason":"control"}';
        },
      };
      const reviewer = new StandardsConformanceReviewer(provider);
      let invocations = 0;
      invocations += 1;
      const report = await reviewer.review('spec', articles);
      invocations += 1;
      const fit = await reviewer.judgeFit('spec', 'Signal vs. Authority', articles);
      return { clean: report.conclusion === 'fits' && fit.verdict === 'fit', invocations, evidence: { report, fit } };
    },
    blind: async () => {
      const articles: StandardArticle[] = [{
        family: 'Interaction', name: 'Signal vs. Authority', rule: 'Independent judgment.', inPractice: '',
      }];
      const provider: IntelligenceProvider = { async evaluate() { throw new Error('provider down'); } };
      const reviewer = new StandardsConformanceReviewer(provider);
      let invocations = 0;
      invocations += 1;
      const report = await reviewer.review('spec', articles);
      invocations += 1;
      const fit = await reviewer.judgeFit('spec', 'Signal vs. Authority', articles);
      return {
        clean: report.conclusion === 'fits' || fit.verdict === 'fit',
        invocations,
        evidence: { report, fit },
      };
    },
  }],
  ['detector:src/monitoring/HumanAsDetectorLog.ts', {
    control: () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-control-detector-'));
      try {
        HumanAsDetectorLog.resetForTesting();
        const log = HumanAsDetectorLog.getInstance();
        log.configure({ stateDir, agentName: 'control-case' });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        let invocations = 0;
        invocations += 1;
        log.observe({ text: "that's wrong", source: 'test', topicId: 29723 });
        const failures = log.getCaptureFailures();
        return { clean: failures.length === 0, invocations, evidence: failures };
      } finally {
        vi.restoreAllMocks();
        HumanAsDetectorLog.resetForTesting();
        SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'checker-blind-input:detector-control' });
      }
    },
    blind: () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-blind-detector-'));
      try {
        fs.writeFileSync(path.join(stateDir, 'metrics'), 'not a directory');
        HumanAsDetectorLog.resetForTesting();
        const log = HumanAsDetectorLog.getInstance();
        log.configure({ stateDir, agentName: 'blind-case' });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        let invocations = 0;
        invocations += 1;
        log.observe({ text: "that's wrong", source: 'test', topicId: 29723 });
        const failures = log.getCaptureFailures();
        return { clean: failures.length === 0, invocations, evidence: failures };
      } finally {
        vi.restoreAllMocks();
        HumanAsDetectorLog.resetForTesting();
        SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'checker-blind-input:detector' });
      }
    },
  }],
  ['script:scripts/lint-checker-blind-input-coverage.mjs', {
    control: () => {
      let invocations = 0;
      invocations += 1;
      const population = deriveCheckerPopulation(ROOT);
      return { clean: population.length > 0, invocations, evidence: { population: population.length } };
    },
    blind: () => {
      let rejected = false;
      let invocations = 0;
      invocations += 1;
      try { deriveCheckerPopulation(path.join(ROOT, '__missing-checker-root__')); }
      catch { rejected = true; }
      return { clean: !rejected, invocations, evidence: { rejectedMissingRoot: rejected } };
    },
  }],
]);

function makePopulationRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-population-'));
  fs.mkdirSync(path.join(root, 'scripts', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'core', 'reviewers', 'nested'), { recursive: true });
  return root;
}

describe('checker blind-input class ratchet', () => {
  it('derives a non-empty production population and holds legacy exceptions at the pinned ceiling', () => {
    const population = deriveCheckerPopulation(ROOT);
    const result = evaluateBlindInputCoverage({
      population,
      coverageIds: BLIND_INPUT_CASE_IDS,
      maxUncovered: MAX_UNCOVERED_CHECKERS,
    });
    expect(result.passed).toBe(true);
    expect(result.populationCount).toBeGreaterThan(90);
    expect(result.coveredCount).toBe(CASES.size);
    expect(result.uncovered.length).toBeLessThanOrEqual(MAX_UNCOVERED_CHECKERS);
  });

  it('executes every declared blind case and none reports clean', async () => {
    expect([...CASES.keys()].sort()).toEqual([...BLIND_INPUT_CASE_IDS].sort());
    const execution = await executeBlindCases(CASES);
    expect(execution.failures).toEqual([]);
    expect(execution.provenIds.sort()).toEqual([...BLIND_INPUT_CASE_IDS].sort());
  });

  it('P1 symbol-preserving hollow: an inert case with the same id fails', async () => {
    const hollow = new Map(CASES);
    hollow.set('script:scripts/lint-llm-attribution.js', {
      control: () => ({ clean: true, invocations: 1, evidence: 'control' }),
      blind: () => ({ clean: true, invocations: 1, evidence: 'inert body' }),
    });
    expect((await executeBlindCases(hollow, { requireObservedChildren: false })).failures).toContainEqual({
      id: 'script:scripts/lint-llm-attribution.js',
      phase: 'blind',
      reason: 'blind-input-accepted',
      evidence: 'inert body',
    });
  });

  it('refuses a never-invoked checker even when candidate testimony says invocations 1', async () => {
    const hollow = new Map<string, BlindCase>([[
      'script:scripts/lint-new-but-never-invoked.mjs',
      {
        control: () => ({ clean: true, invocations: 1, evidence: 'forged-positive-counter' }),
        blind: () => ({ clean: false, invocations: 1, evidence: 'forged-positive-counter' }),
      },
    ]]);
    expect((await executeBlindCases(hollow)).failures).toEqual([
      expect.objectContaining({
        id: 'script:scripts/lint-new-but-never-invoked.mjs',
        phase: 'control',
        reason: 'checker-not-observed',
      }),
      expect.objectContaining({
        id: 'script:scripts/lint-new-but-never-invoked.mjs',
        phase: 'blind',
        reason: 'checker-not-observed',
      }),
    ]);
  });

  it('credits only a complete pair of private-channel authenticated post-exit receipts', async () => {
    const authority = await createAuthenticatedReceiptAuthority({ issuer: 'checker-unit' });
    try {
      const records = [];
      for (const phase of ['control', 'blind'] as const) {
        const receipt = await authority.issue({
          guardId: 'script:scripts/lint-real.mjs', kind: phase,
          observerPid: process.pid, childPid: process.pid, childExitCode: 0,
          signal: null, argv: [process.execPath, 'lint-real.mjs', phase],
          startedAt: new Date().toISOString(), childExitedAt: new Date().toISOString(),
          emittedAfterChildExit: true,
        });
        expect(await authority.authenticate(receipt, { kind: phase, childExitCode: 0 })).toBe(true);
        records.push(receipt);
      }
      expect(validateCoreExecutionReceipts({
        records,
        declaredIds: ['script:scripts/lint-real.mjs'],
      })).toMatchObject({ passed: true, invalid: [], missing: [] });
    } finally {
      await authority.close();
    }
  });

  it('rejects candidate-authored execution testimony without core receipts', () => {
    expect(validateCoreExecutionReceipts({
      records: [{
        source: 'CHECKER_BLIND_EXECUTION',
        guardId: 'script:scripts/lint-never-invoked.mjs',
        kind: 'control', invocations: 1,
      }],
      declaredIds: ['script:scripts/lint-never-invoked.mjs'],
    })).toMatchObject({
      passed: false,
      invalid: [expect.objectContaining({ invocations: 1 })],
      missing: [
        'script:scripts/lint-never-invoked.mjs\0control',
        'script:scripts/lint-never-invoked.mjs\0blind',
      ],
    });
  });

  it('P2 subject self-report is ignored by the independent oracle', async () => {
    const liar = new Map<string, BlindCase>([[
      'liar',
      {
        control: () => ({ clean: true, invocations: 1, subjectClaim: 'not-proven', evidence: { inputReadable: true } }),
        blind: () => ({ clean: false, invocations: 1, subjectClaim: 'clean', evidence: { inputReadable: false } }),
      },
    ]]);
    expect((await executeBlindCases(liar, { requireObservedChildren: false })).failures).toEqual([]);
  });

  it('P4a empty population is an error, never 0/0 clean', () => {
    const result = evaluateBlindInputCoverage({ population: [], coverageIds: [], maxUncovered: 0 });
    expect(result).toMatchObject({ passed: false, reason: 'empty-population' });
  });

  it('P4b recursively catches planted checkers outside top-level globs', () => {
    const root = makePopulationRoot();
    try {
      fs.writeFileSync(path.join(root, 'scripts', 'nested', 'lint-planted.mjs'), 'export const planted = true;\n');
      fs.writeFileSync(path.join(root, 'src', 'core', 'reviewers', 'nested', 'FifthReviewer.ts'), 'export class FifthReviewer {}\n');
      const population = deriveCheckerPopulation(root);
      expect(population.map((p) => p.id)).toEqual([
        'reviewer:src/core/reviewers/nested/FifthReviewer.ts',
        'script:scripts/nested/lint-planted.mjs',
      ]);
      const result = evaluateBlindInputCoverage({ population, coverageIds: [], maxUncovered: 0 });
      expect(result).toMatchObject({ passed: false, reason: 'uncovered-checker-count-increased' });
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'checker-population:p4b' });
    }
  });

  it('does not let retired legacy debt grandfather a different new checker', () => {
    const result = evaluateProtectedBlindInputCoverage({
      population: ['legacy-b', 'new-checker'],
      protectedPopulationIds: ['legacy-a', 'legacy-b'],
      executionProvenIds: [],
      maxUncovered: 2,
    });
    expect(result).toMatchObject({
      passed: false,
      reason: 'new-checker-without-execution-proof',
      newWithoutExecutionProof: ['new-checker'],
    });
  });

  it('derives bootstrap ceiling only from execution-proven protected checkers', () => {
    expect(deriveProtectedCeiling({
      protectedPopulationIds: ['legacy-a', 'legacy-b', 'legacy-c'],
      executionProvenIds: ['legacy-a', 'candidate-new'],
    })).toBe(2);
    expect(deriveProtectedCeiling({
      protectedPopulationIds: ['legacy-a', 'legacy-b', 'legacy-c'],
      executionProvenIds: [],
      recordedProtectedCeiling: 1,
    })).toBe(1);
  });

  it('P5 missing population source is unavailable evidence, never a clean result', () => {
    expect(() => deriveCheckerPopulation(path.join(ROOT, '__missing__'))).toThrow(/population unavailable/);
  });

  it('refuses to raise the legacy ceiling in the same change that raises debt', () => {
    expect(evaluateCeilingRatchet({ currentCeiling: 91, protectedCeiling: 91 }))
      .toMatchObject({ passed: true, reason: 'ceiling-held-or-lowered' });
    expect(evaluateCeilingRatchet({ currentCeiling: 92, protectedCeiling: 91 }))
      .toMatchObject({ passed: false, reason: 'ratchet-ceiling-raised' });
  });

  it('derives bootstrap authority from canonical protected main, never a local tracking ref', () => {
    const entry = fs.readFileSync(path.join(ROOT, 'scripts', 'lint-checker-blind-input-coverage.mjs'), 'utf8');
    expect(entry).not.toContain('INITIAL_MAX_UNCOVERED_CHECKERS');
    expect(entry).not.toContain('CHECKER_BLIND_INPUT_BASE_REF');
    expect(entry).not.toContain("'upstream/main'");
    expect(entry).not.toContain("'origin/main'");
    expect(entry).toContain("const CANONICAL_PROTECTED_REMOTE = 'https://github.com/JKHeadley/instar.git'");
    const head = SafeGitExecutor.readSync(['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      operation: 'checker-blind-input-ratchet:read-head',
      sourceTreeReadOk: true,
    }).trim();
    const state = readProtectedStateAt(ROOT, head);
    expect(state.protectedMainSha).toBe(head);
    expect(state.baseSha).toBe(head);
    expect(state.populationIds.length).toBeGreaterThan(90);
  });
});

describe('P3 — the ratchet own test rejects all four guard sabotages', () => {
  const sourcePath = path.join(ROOT, 'scripts', 'lib', 'checker-blind-input-ratchet.mjs');
  const source = fs.readFileSync(sourcePath, 'utf8');

  function guardOwnSuite(modulePath: string, dir: string) {
    const suite = path.join(dir, 'guard-own.test.mjs');
    fs.writeFileSync(suite, `
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBlindInputCoverage } from ${JSON.stringify(pathToFileURL(modulePath).href)};
test('empty population is not proof', () => {
  assert.deepEqual(evaluateBlindInputCoverage({population:[],coverageIds:[],maxUncovered:0}), {
    passed:false,reason:'empty-population',populationCount:0,coveredCount:0,uncovered:[]
  });
});
test('unknown coverage id is rejected', () => {
  assert.equal(evaluateBlindInputCoverage({population:['known'],coverageIds:['unknown'],maxUncovered:1}).passed, false);
});
test('new uncovered checker is named and rejected', () => {
  const r = evaluateBlindInputCoverage({population:['legacy','new-checker'],coverageIds:['legacy'],maxUncovered:0});
  assert.equal(r.passed, false);
  assert.deepEqual(r.uncovered, ['new-checker']);
});
test('genuinely covered population passes', () => {
  assert.equal(evaluateBlindInputCoverage({population:['known'],coverageIds:['known'],maxUncovered:0}).passed, true);
});
`);
    return spawnSync(process.execPath, ['--test', suite], { encoding: 'utf8' });
  }

  function replaceGuardBody(body: string): string {
    const signature = /export function evaluateBlindInputCoverage\(\{ population, coverageIds, maxUncovered \}\) \{/;
    const match = signature.exec(body);
    expect(match).not.toBeNull();
    const open = (match?.index ?? 0) + (match?.[0].length ?? 0) - 1;
    let depth = 0;
    for (let i = open; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      if (body[i] === '}') depth -= 1;
      if (depth === 0) {
        return `${body.slice(0, open + 1)}\n  return { passed: true, reason: 'within-ratchet', populationCount: population.length, coveredCount: coverageIds.length, uncovered: [], maxUncovered };\n${body.slice(i)}`;
      }
    }
    throw new Error('guard body did not close');
  }

  function decidingOutput(result: ReturnType<typeof spawnSync>): string {
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  }

  it('3a DELETE', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-p3-delete-'));
    const file = path.join(dir, 'guard.mjs');
    try {
      fs.writeFileSync(file, source);
      // Rename the isolated copy away from the import target: this is a real
      // DELETE mutation from the guard consumer's perspective without invoking
      // a raw destructive filesystem primitive in the test harness.
      fs.renameSync(file, `${file}.deleted`);
      expect(fs.existsSync(file)).toBe(false); // mutation-applied control
      const result = guardOwnSuite(file, dir);
      console.log(`P3_3a_DELETE mutationApplied=true guardOwnTestExit=${result.status}\n${decidingOutput(result)}`);
      expect(result.status).not.toBe(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'checker-p3:delete' });
    }
  });

  it('3b COMMENT OUT every executable line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-p3-comment-'));
    const file = path.join(dir, 'guard.mjs');
    try {
      const commented = source.split('\n').map((line) => `// ${line}`).join('\n');
      fs.writeFileSync(file, commented);
      expect(fs.readFileSync(file, 'utf8').split('\n').every((line) => line.startsWith('// '))).toBe(true);
      const result = guardOwnSuite(file, dir);
      console.log(`P3_3b_COMMENT_OUT mutationApplied=true guardOwnTestExit=${result.status}\n${decidingOutput(result)}`);
      expect(result.status).not.toBe(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'checker-p3:comment' });
    }
  });

  it('3c SUPERSTRING RENAME of the exact guard symbol', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-p3-rename-'));
    const file = path.join(dir, 'guard.mjs');
    try {
      const renamed = source.replaceAll('evaluateBlindInputCoverage', 'evaluateBlindInputCoverageDisabled');
      fs.writeFileSync(file, renamed);
      expect(renamed).toContain('evaluateBlindInputCoverageDisabled');
      expect(/\bevaluateBlindInputCoverage\b/.test(renamed)).toBe(false); // mutation applied; substring still exists
      const result = guardOwnSuite(file, dir);
      console.log(`P3_3c_SUPERSTRING_RENAME mutationApplied=true guardOwnTestExit=${result.status}\n${decidingOutput(result)}`);
      expect(result.status).not.toBe(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'checker-p3:rename' });
    }
  });

  it('3d TYPE-PRESERVING HOLLOW BODY returns a passing verdict', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-p3-hollow-'));
    const file = path.join(dir, 'guard.mjs');
    try {
      const hollow = replaceGuardBody(source);
      fs.writeFileSync(file, hollow);
      expect(hollow).toContain("return { passed: true, reason: 'within-ratchet'");
      expect(hollow).toContain('export function evaluateBlindInputCoverage');
      const result = guardOwnSuite(file, dir);
      const output = decidingOutput(result);
      console.log(`P3_3d_TYPE_PRESERVING_HOLLOW mutationApplied=true guardOwnTestExit=${result.status}\n${output}`);
      expect(result.status).not.toBe(0);
      expect(output).toContain('# tests 4');
      expect(output).toContain('# fail 3');
      expect(output).toMatch(/AssertionError|Expected values to be strictly equal/);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'checker-p3:hollow' });
    }
  });
});

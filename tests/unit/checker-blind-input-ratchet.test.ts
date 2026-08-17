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
import { BLIND_INPUT_CASE_IDS } from '../../scripts/checker-blind-input-cases.mjs';
import {
  deriveCheckerPopulation,
  evaluateBlindInputCoverage,
} from '../../scripts/lib/checker-blind-input-ratchet.mjs';
import { MAX_UNCOVERED_CHECKERS } from '../../scripts/lint-checker-blind-input-coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface BlindObservation {
  /** Independent test oracle: true means the checker reported clean while blind. */
  clean: boolean;
  evidence: unknown;
  /** Optional subject testimony; deliberately ignored by the oracle. */
  subjectClaim?: string;
}

type BlindCase = () => Promise<BlindObservation> | BlindObservation;

async function executeBlindCases(cases: Map<string, BlindCase>) {
  const failures: Array<{ id: string; evidence: unknown }> = [];
  for (const [id, run] of cases) {
    const observation = await run();
    if (observation.clean) failures.push({ id, evidence: observation.evidence });
  }
  return failures;
}

const CASES = new Map<string, BlindCase>([
  ['script:scripts/lint-llm-attribution.js', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'src', '.checker-blind-attribution-'));
    const file = path.join(dir, 'fixture.ts');
    fs.writeFileSync(file, `await provider.evaluate('untagged');\n`);
    try {
      fs.chmodSync(file, 0o000);
      const result = runLint([file]);
      return {
        clean: result.real.length === 0 && result.stale.length === 0 && result.blind.length === 0,
        evidence: result,
        subjectClaim: 'process exit is intentionally not trusted by this case',
      };
    } finally {
      try { fs.chmodSync(file, 0o600); } catch { /* bounded cleanup */ }
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'checker-blind-input:attribution' });
    }
  }],
  ['probe:src/monitoring/probes/GuardPostureProbe.ts', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-blind-guard-'));
    try {
      const [probe] = createGuardPostureProbes({
        getLocalPosture: () => null,
        getPeerPostures: () => [{ machineId: 'blind-peer', online: true, posture: null, postureAgeMs: null }],
        deepReadPeer: async () => { throw new Error('unreachable'); },
        emitAttention: async () => {},
        stateDir,
      });
      const result = await probe.run();
      return { clean: result.passed, evidence: result };
    } finally {
      SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'checker-blind-input:guard' });
    }
  }],
  ['reviewer:src/core/reviewers/standards-conformance.ts', async () => {
    const articles: StandardArticle[] = [{
      family: 'Interaction', name: 'Signal vs. Authority', rule: 'Independent judgment.', inPractice: '',
    }];
    const provider: IntelligenceProvider = { async evaluate() { throw new Error('provider down'); } };
    const reviewer = new StandardsConformanceReviewer(provider);
    const report = await reviewer.review('spec', articles);
    const fit = await reviewer.judgeFit('spec', 'Signal vs. Authority', articles);
    return {
      clean: report.conclusion === 'fits' || fit.verdict === 'fit',
      evidence: { report, fit },
    };
  }],
  ['detector:src/monitoring/HumanAsDetectorLog.ts', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-blind-detector-'));
    try {
      fs.writeFileSync(path.join(stateDir, 'metrics'), 'not a directory');
      HumanAsDetectorLog.resetForTesting();
      const log = HumanAsDetectorLog.getInstance();
      log.configure({ stateDir, agentName: 'blind-case' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      log.observe({ text: "that's wrong", source: 'test', topicId: 29723 });
      const failures = log.getCaptureFailures();
      return { clean: failures.length === 0, evidence: failures };
    } finally {
      vi.restoreAllMocks();
      HumanAsDetectorLog.resetForTesting();
      SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'checker-blind-input:detector' });
    }
  }],
  ['script:scripts/lint-checker-blind-input-coverage.mjs', () => {
    let rejected = false;
    try { deriveCheckerPopulation(path.join(ROOT, '__missing-checker-root__')); }
    catch { rejected = true; }
    return { clean: !rejected, evidence: { rejectedMissingRoot: rejected } };
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
    expect(await executeBlindCases(CASES)).toEqual([]);
  });

  it('P1 symbol-preserving hollow: an inert case with the same id fails', async () => {
    const hollow = new Map(CASES);
    hollow.set('script:scripts/lint-llm-attribution.js', () => ({ clean: true, evidence: 'inert body' }));
    expect(await executeBlindCases(hollow)).toContainEqual({
      id: 'script:scripts/lint-llm-attribution.js',
      evidence: 'inert body',
    });
  });

  it('P2 subject self-report is ignored by the independent oracle', async () => {
    const liar = new Map<string, BlindCase>([[
      'liar',
      () => ({ clean: false, subjectClaim: 'clean', evidence: { inputReadable: false } }),
    ]]);
    expect(await executeBlindCases(liar)).toEqual([]);
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

  it('P5 missing population source throws NOT-PROVEN instead of returning clean', () => {
    expect(() => deriveCheckerPopulation(path.join(ROOT, '__missing__'))).toThrow(/population unavailable/);
  });
});

describe('P3 — the ratchet own test rejects all three guard sabotages', () => {
  const sourcePath = path.join(ROOT, 'scripts', 'lib', 'checker-blind-input-ratchet.mjs');
  const source = fs.readFileSync(sourcePath, 'utf8');

  function exactImportExit(modulePath: string): number | null {
    const code = `import { evaluateBlindInputCoverage } from ${JSON.stringify(pathToFileURL(modulePath).href)};\n` +
      `const r = evaluateBlindInputCoverage({population:[],coverageIds:[],maxUncovered:0});\n` +
      `if (r.passed) process.exit(7);`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).status;
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
      const testExit = exactImportExit(file);
      console.log(`P3_3a_DELETE mutationApplied=true guardOwnTestExit=${testExit}`);
      expect(testExit).not.toBe(0);
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
      const testExit = exactImportExit(file);
      console.log(`P3_3b_COMMENT_OUT mutationApplied=true guardOwnTestExit=${testExit}`);
      expect(testExit).not.toBe(0);
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
      const testExit = exactImportExit(file);
      console.log(`P3_3c_SUPERSTRING_RENAME mutationApplied=true guardOwnTestExit=${testExit}`);
      expect(testExit).not.toBe(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'checker-p3:rename' });
    }
  });
});

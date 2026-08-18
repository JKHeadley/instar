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
  evaluateCeilingRatchet,
} from '../../scripts/lib/checker-blind-input-ratchet.mjs';
import {
  MAX_UNCOVERED_CHECKERS,
  readProtectedCeiling,
} from '../../scripts/lint-checker-blind-input-coverage.mjs';

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
    // Keep the blind fixture outside the repository tree.  The safe filesystem
    // guard intentionally rejects mutation fixtures nested under a git root;
    // this case must exercise unreadable input, not trip that source-tree guard.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-blind-attribution-'));
    const file = path.join(ROOT, 'src', `.checker-blind-attribution-missing-${process.pid}.ts`);
    try {
      // A dangling symlink makes the read fail for every user, including root
      // (chmod-only fixtures are readable by root and falsely look clean).
      const result = runLint([file]);
      return {
        clean: result.real.length === 0 && result.stale.length === 0 && result.blind.length === 0,
        evidence: result,
        subjectClaim: 'process exit is intentionally not trusted by this case',
      };
    } finally {
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

  it('refuses to raise the legacy ceiling in the same change that raises debt', () => {
    expect(evaluateCeilingRatchet({ currentCeiling: 91, protectedCeiling: 91 }))
      .toMatchObject({ passed: true, reason: 'ceiling-held-or-lowered' });
    expect(evaluateCeilingRatchet({ currentCeiling: 92, protectedCeiling: 91 }))
      .toMatchObject({ passed: false, reason: 'ratchet-ceiling-raised' });
  });

  it('derives bootstrap authority from the protected tree, not a second candidate constant', () => {
    const entry = fs.readFileSync(path.join(ROOT, 'scripts', 'lint-checker-blind-input-coverage.mjs'), 'utf8');
    expect(entry).not.toContain('INITIAL_MAX_UNCOVERED_CHECKERS');
    expect(entry).not.toContain('CHECKER_BLIND_INPUT_BASE_REF');
    expect(readProtectedCeiling(ROOT)).toBe(MAX_UNCOVERED_CHECKERS);
  });
});

describe('P3 — the ratchet own test rejects all four guard sabotages', () => {
  const sourcePath = path.join(ROOT, 'scripts', 'lib', 'checker-blind-input-ratchet.mjs');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const guardResultSchema = 'checker-blind-input/guard-own-results-v1';
  const hollowExpectedResults = [
    { testNumber: 1, identity: 'empty population is not proof', outcome: 'fail', failureCode: 'ERR_ASSERTION' },
    { testNumber: 2, identity: 'unknown coverage id is rejected', outcome: 'fail', failureCode: 'ERR_ASSERTION' },
    { testNumber: 3, identity: 'new uncovered checker is named and rejected', outcome: 'fail', failureCode: 'ERR_ASSERTION' },
    { testNumber: 4, identity: 'genuinely covered population passes', outcome: 'pass', failureCode: null },
  ] as const;

  interface GuardOwnResult {
    schema: typeof guardResultSchema;
    tests: Array<{
      testNumber: number;
      identity: string;
      outcome: 'pass' | 'fail';
      failureCode: string | null;
    }>;
  }

  function parseGuardOwnResult(raw: string): GuardOwnResult {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('guard-own result is not JSON');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('guard-own result must be an object');
    }
    const record = value as Record<string, unknown>;
    if (record.schema !== guardResultSchema || !Array.isArray(record.tests)) {
      throw new Error('guard-own result does not match schema v1');
    }
    const rootKeys = Object.keys(record).sort();
    if (rootKeys.length !== 2 || rootKeys[0] !== 'schema' || rootKeys[1] !== 'tests') {
      throw new Error('guard-own result has unknown root fields');
    }
    const tests = record.tests.map((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`guard-own test result ${index} must be an object`);
      }
      const item = entry as Record<string, unknown>;
      const keys = Object.keys(item).sort();
      if (keys.join(',') !== 'failureCode,identity,outcome,testNumber') {
        throw new Error(`guard-own test result ${index} has the wrong fields`);
      }
      if (!Number.isInteger(item.testNumber) || (item.testNumber as number) < 1) {
        throw new Error(`guard-own test result ${index} has an invalid test number`);
      }
      if (typeof item.identity !== 'string' || item.identity.length === 0) {
        throw new Error(`guard-own test result ${index} has an invalid identity`);
      }
      if (item.outcome !== 'pass' && item.outcome !== 'fail') {
        throw new Error(`guard-own test result ${index} has an invalid outcome`);
      }
      if (item.failureCode !== null && typeof item.failureCode !== 'string') {
        throw new Error(`guard-own test result ${index} has an invalid failure code`);
      }
      return {
        testNumber: item.testNumber as number,
        identity: item.identity,
        outcome: item.outcome,
        failureCode: item.failureCode,
      };
    });
    return { schema: guardResultSchema, tests };
  }

  function guardOwnSuite(modulePath: string, dir: string, renderer: 'tap' | 'spec' = 'spec') {
    const suite = path.join(dir, 'guard-own.test.mjs');
    const reporter = path.join(dir, 'guard-own-results-reporter.mjs');
    const structuredDestination = path.join(dir, `guard-own-${renderer}-results.json`);
    const renderedDestination = path.join(dir, `guard-own-${renderer}-rendered.txt`);
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
    fs.writeFileSync(reporter, `
export default async function* guardOwnResults(source) {
  const tests = [];
  for await (const event of source) {
    if (event.type !== 'test:complete' || event.data.details.type === 'suite' || event.data.skip || event.data.todo) continue;
    if (typeof event.data.file === 'string' && event.data.name === event.data.file) continue;
    const error = event.data.details.error;
    const cause = error && typeof error === 'object' ? error.cause : undefined;
    const failureCode = cause && typeof cause === 'object' && typeof cause.code === 'string'
      ? cause.code
      : error && typeof error === 'object' && typeof error.code === 'string' ? error.code : null;
    tests.push({
      testNumber: event.data.testNumber,
      identity: event.data.name,
      outcome: event.data.details.passed ? 'pass' : 'fail',
      failureCode,
    });
  }
  yield JSON.stringify({ schema: ${JSON.stringify(guardResultSchema)}, tests });
}
`);
    const child = spawnSync(process.execPath, [
      '--test',
      '--test-reporter', renderer,
      '--test-reporter-destination', renderedDestination,
      '--test-reporter', reporter,
      '--test-reporter-destination', structuredDestination,
      suite,
    ], { encoding: 'utf8' });
    return {
      ...child,
      renderer,
      renderedOutput: fs.existsSync(renderedDestination) ? fs.readFileSync(renderedDestination, 'utf8').trim() : '',
      structuredOutput: fs.existsSync(structuredDestination) ? fs.readFileSync(structuredDestination, 'utf8').trim() : '',
    };
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

  function decidingOutput(result: ReturnType<typeof guardOwnSuite>): string {
    return `${result.renderedOutput}\n${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
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
      const tapResult = guardOwnSuite(file, dir, 'tap');
      const specResult = guardOwnSuite(file, dir, 'spec');
      const tapStructured = parseGuardOwnResult(tapResult.structuredOutput);
      const specStructured = parseGuardOwnResult(specResult.structuredOutput);
      expect(tapResult.status).not.toBe(0);
      expect(specResult.status).not.toBe(0);
      expect(tapStructured.tests).toEqual(hollowExpectedResults);
      expect(specStructured.tests).toEqual(hollowExpectedResults);
      expect(tapStructured).toEqual(specStructured);
      console.log(
        `P3_3d_TYPE_PRESERVING_HOLLOW mutationApplied=true tapChildExit=${tapResult.status} specChildExit=${specResult.status}`,
      );
      console.log(
        `F4_DECORATION_CONTROL renderer=tap structuredVerdict=reject structured=${JSON.stringify(tapStructured)}\n${tapResult.renderedOutput}`,
      );
      console.log(
        `F4_DECORATION_CONTROL renderer=spec structuredVerdict=reject structured=${JSON.stringify(specStructured)}\n${specResult.renderedOutput}`,
      );
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'checker-p3:hollow' });
    }
  });
});

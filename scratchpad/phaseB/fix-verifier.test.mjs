import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  deriveRung,
  effectiveClasses,
  summarizeProperties,
  validateManifestObject,
  validatePipelineContract,
  validateRelevanceEvidence,
  validatePipelineEvidence,
  runPipelineWiringControls,
} from './fix-verifier.mjs';

function evidence(overrides = {}) {
  return {
    id: 'mutation',
    property: 'P1',
    violationClass: 'hollowing',
    mutationApplied: true,
    guardOutcome: 'fail',
    ...overrides,
  };
}

function completeEvidence() {
  return [
    evidence({ id: 'p1', property: 'P1', violationClass: 'hollowing' }),
    evidence({ id: 'p2', property: 'P2', violationClass: 'self-report / false testimony' }),
    evidence({ id: 'p3a', property: 'P3', violationClass: 'guard removal' }),
    evidence({ id: 'p3b', property: 'P3', violationClass: 'guard removal' }),
    evidence({ id: 'p3c', property: 'P3', violationClass: 'guard removal' }),
    evidence({ id: 'p3d', property: 'P3', violationClass: 'guard removal', guardRun: { runs: [{ decidingOutput: { kind: 'assertion-or-test-failure' } }] } }),
    evidence({ id: 'p4a', property: 'P4', violationClass: 'vacuous measurement' }),
    evidence({ id: 'p4b', property: 'P4', violationClass: 'population evasion' }),
    evidence({ id: 'p5', property: 'P5', violationClass: 'blind input / fail-open' }),
  ];
}

test('checked adapter registry refuses to claim it can measure zero adapters', () => {
  assert.throws(
    () => validateManifestObject({ schemaVersion: 1, adapters: [] }, '/tmp/manifest.json', { checkAdapters: false }),
    /adapter registry is empty; no guard can be measured/,
  );
});

test('checked adapter registry refuses duplicate guard identifiers', () => {
  const guard = { id: 'same', adapter: 'a.mjs', guardFiles: ['g'], subjectFiles: ['s'] };
  assert.throws(
    () => validateManifestObject({ schemaVersion: 1, adapters: [guard, guard] }, '/tmp/manifest.json', { checkAdapters: false }),
    /duplicates same/,
  );
});

test('a mutation that did not verify applied makes its property unknown', () => {
  const all = completeEvidence();
  all[0] = evidence({ id: 'p1', mutationApplied: false, guardOutcome: 'unknown' });
  const properties = summarizeProperties(all, true);
  assert.equal(properties.P1.outcome, 'unknown');
  assert.notEqual(properties.P1.outcome, 'not-proven');
});

test('an applied but irrelevant mutation makes its property unknown', () => {
  const all = completeEvidence();
  all[0] = evidence({ id: 'p1', mutationRelevant: false, guardOutcome: 'pass' });
  const properties = summarizeProperties(all, true);
  assert.equal(properties.P1.outcome, 'unknown');
});

test('relevance envelope rejects malformed proven evidence', () => {
  assert.equal(validateRelevanceEvidence({ status: 'proven', mode: 'declared-load-bearing-input', checks: [] }).valid, false);
  assert.equal(validateRelevanceEvidence({ status: 'proven', mode: 'path-overlap', checks: [{ passed: true }] }).valid, false);
  assert.equal(validateRelevanceEvidence({ status: 'proven', mode: 'declared-load-bearing-input', checks: [{ passed: false }] }).valid, false);
  assert.equal(validateRelevanceEvidence({ status: 'proven', mode: 'declared-load-bearing-input', checks: [{ passed: true }] }).valid, true);
});

test('pipeline contract is anchored in a protected workflow job and exact real command', () => {
  const contract = {
    protectedRemoteUrl: 'https://github.com/JKHeadley/instar.git',
    protectedRef: 'refs/heads/main',
    workflowPath: '.github/workflows/ci.yml',
    workflowJob: 'lint',
    workflowCommandPrefix: 'npm run lint',
    invocationPrefix: ['npm', 'run', 'lint'],
    observer: { nodeEntry: 'scripts/lint-testing-integrity.mjs', requiredArgs: [] },
  };
  const workflow = 'jobs:\n  lint:\n    steps:\n      - run: npm run lint\n';
  assert.equal(validatePipelineContract(contract, ['npm', 'run', 'lint'], workflow).valid, true);
  assert.equal(validatePipelineContract(contract, ['npm', 'run', 'test'], workflow).valid, false);
  assert.equal(validatePipelineContract(contract, ['npm', 'run', 'lint'], 'jobs:\n  lint:\n    steps:\n      - run: npm run test\n').valid, false);
});

test('wiring rejects adapter testimony and requires a core-minted runtime receipt', () => {
  assert.equal(validatePipelineEvidence(undefined).valid, false);
  assert.equal(validatePipelineEvidence({ status: 'proven', mode: 'adapter-command-contract', checks: [{ passed: true }] }).valid, false);
  assert.equal(validatePipelineEvidence({ status: 'proven', mode: 'core-minted-process-receipt', checks: [{ passed: false }] }).valid, false);
});

test('C3 short-circuits the exact guard child while the real wrapper succeeds and produces no receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-verifier-wiring-test-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fix-verifier-wiring-fixture',
      private: true,
      scripts: { wired: 'node guard.mjs' },
    }));
    fs.writeFileSync(path.join(root, 'guard.mjs'), "console.log('[fixture-guard] PASS');\n");
    const contract = {
      observer: { nodeEntry: 'guard.mjs', requiredArgs: [] },
    };
    const result = runPipelineWiringControls({
      command: { argv: ['npm', 'run', 'wired'], timeoutMs: 30_000 },
      cwd: root,
      guardId: 'fixture-guard',
      contract,
      observerRoot: path.join(root, '.observer'),
    });
    assert.equal(result.positive.run.exitCode, 0);
    assert.equal(result.positive.receipts.length, 1);
    assert.equal(result.positive.receipts[0].token, result.token);
    assert.equal(result.C3.run.exitCode, 0);
    assert.equal(result.C3.shortCircuitEvents.length, 1);
    assert.equal(result.C3.receipts.length, 0);
    assert.equal(result.C3.outcome, 'proven');
    assert.equal(result.envelope.status, 'proven');
    assert.equal(validatePipelineEvidence(result.envelope).valid, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pipeline that stops before the guard is UNKNOWN, including C3', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-verifier-wiring-blocked-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fix-verifier-wiring-blocked-fixture',
      private: true,
      scripts: { blocked: "node -e \"console.error('upstream gate stopped'); process.exit(1)\" && node guard.mjs" },
    }));
    fs.writeFileSync(path.join(root, 'guard.mjs'), "console.log('[fixture-guard] PASS');\n");
    const result = runPipelineWiringControls({
      command: { argv: ['npm', 'run', 'blocked'], timeoutMs: 30_000 },
      cwd: root,
      guardId: 'fixture-guard',
      contract: { observer: { nodeEntry: 'guard.mjs', requiredArgs: [] } },
      observerRoot: path.join(root, '.observer'),
    });
    assert.equal(result.positive.run.exitCode, 1);
    assert.equal(result.positive.receipts.length, 0);
    assert.equal(result.C3.shortCircuitEvents.length, 0);
    assert.equal(result.C3.outcome, 'unknown');
    assert.equal(result.envelope.status, 'unknown');
    assert.equal(validatePipelineEvidence(result.envelope).valid, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a verified mutation followed by a passing guard is not-proven, not unknown', () => {
  const all = completeEvidence();
  all[0] = evidence({ id: 'p1', guardOutcome: 'pass' });
  const properties = summarizeProperties(all, true);
  assert.equal(properties.P1.outcome, 'not-proven');
});

test('P3 requires all four sabotages to fail, including the type-preserving hollow', () => {
  const all = completeEvidence();
  all.find((item) => item.id === 'p3d').guardOutcome = 'pass';
  const properties = summarizeProperties(all, true);
  assert.equal(properties.P3.outcome, 'not-proven');
  assert.ok(!effectiveClasses(all, properties, true).includes('guard removal'));
});

test('P4 reports named classes independently but the property needs both mutations', () => {
  const all = completeEvidence();
  all.find((item) => item.id === 'p4b').guardOutcome = 'pass';
  const properties = summarizeProperties(all, true);
  const classes = effectiveClasses(all, properties, true);
  assert.equal(properties.P4.outcome, 'not-proven');
  assert.ok(classes.includes('vacuous measurement'));
  assert.ok(!classes.includes('population evasion'));
});

test('effective requires wired, C1, and all five properties proven', () => {
  const all = completeEvidence();
  const properties = summarizeProperties(all, true);
  assert.equal(deriveRung({ exists: true, wired: true, positiveControlPassed: true, properties }), 'effective');
  assert.deepEqual(effectiveClasses(all, properties, true), [
    'blind input / fail-open',
    'guard removal',
    'hollowing',
    'population evasion',
    'self-report / false testimony',
    'vacuous measurement',
  ]);
});

test('unknown forces the overall rung to not-proven even when wiring ran', () => {
  const all = completeEvidence();
  all[0] = evidence({ id: 'p1', mutationApplied: false, guardOutcome: 'unknown' });
  const properties = summarizeProperties(all, true);
  assert.equal(deriveRung({ exists: true, wired: true, positiveControlPassed: true, properties }), 'not-proven');
});

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
  sameRealFile,
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

test('declared-entry realpath equality refuses every resolution failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-verifier-w4-resolution-failure-'));
  try {
    fs.writeFileSync(path.join(root, 'present.mjs'), 'export {};\n');
    assert.equal(sameRealFile('missing.mjs', 'missing.mjs', root), false);
    assert.equal(sameRealFile('present.mjs', 'missing.mjs', root), false);
    assert.equal(sameRealFile('', 'present.mjs', root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wiring rejects adapter testimony and requires a core-minted runtime receipt', () => {
  assert.equal(validatePipelineEvidence(undefined).valid, false);
  assert.equal(validatePipelineEvidence({ status: 'proven', mode: 'adapter-command-contract', checks: [{ passed: true }] }).valid, false);
  assert.equal(validatePipelineEvidence({ status: 'proven', mode: 'core-authenticated-observer-events-hmac-receipt', checks: [{ passed: false }] }).valid, false);
});

test('C3 short-circuits the exact guard child while the real wrapper succeeds and produces no receipt', async () => {
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
    const result = await runPipelineWiringControls({
      command: { argv: ['npm', 'run', 'wired'], timeoutMs: 30_000 },
      cwd: root,
      guardId: 'fixture-guard',
      contract,
      observerRoot: path.join(root, '.observer'),
    });
    assert.equal(result.positive.run.exitCode, 0);
    assert.equal(result.positive.receipts.length, 1);
    assert.match(result.positive.receipts[0].mac, /^[a-f0-9]{64}$/);
    assert.equal(result.positive.receipts[0].childExitCode, 0);
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

test('W4 positive accepts shim and module spellings only when they resolve to the same real entry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-verifier-w4-same-entry-'));
  try {
    const binDir = path.join(root, 'node_modules', '.bin');
    const moduleDir = path.join(root, 'node_modules', 'vitest');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fix-verifier-w4-same-entry',
      private: true,
      scripts: { wired: 'node node_modules/.bin/vitest' },
    }));
    fs.writeFileSync(path.join(moduleDir, 'vitest.mjs'), "console.log('[w4-positive] real module ran');\n");
    fs.symlinkSync('../vitest/vitest.mjs', path.join(binDir, 'vitest'));

    const result = await runPipelineWiringControls({
      command: { argv: ['npm', 'run', 'wired'], timeoutMs: 30_000 },
      cwd: root,
      guardId: 'w4-same-real-entry',
      contract: { observer: { nodeEntry: 'node_modules/vitest/vitest.mjs', requiredArgs: [] } },
      observerRoot: path.join(root, '.observer'),
    });

    assert.equal(fs.realpathSync(path.join(binDir, 'vitest')), fs.realpathSync(path.join(moduleDir, 'vitest.mjs')));
    assert.equal(result.positive.run.exitCode, 0);
    assert.equal(result.positive.receipts.length, 1);
    assert.equal(result.C3.outcome, 'proven');
    assert.equal(result.envelope.status, 'proven');
    console.log('W4_POSITIVE shimRealPathEqualsModule=true authenticatedReceipts=1 verdict=PROVEN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W4 negative refuses a shim to a same-named real file in another directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-verifier-w4-wrong-entry-'));
  try {
    const binDir = path.join(root, 'node_modules', '.bin');
    const declaredDir = path.join(root, 'node_modules', 'vitest');
    const wrongDir = path.join(root, 'node_modules', 'other');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(declaredDir, { recursive: true });
    fs.mkdirSync(wrongDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fix-verifier-w4-wrong-entry',
      private: true,
      scripts: { wired: 'node node_modules/.bin/vitest' },
    }));
    fs.writeFileSync(path.join(declaredDir, 'vitest.mjs'), "throw new Error('declared entry must not run');\n");
    fs.writeFileSync(path.join(wrongDir, 'vitest.mjs'), "console.log('[w4-negative] wrong same-named module ran');\n");
    fs.symlinkSync('../other/vitest.mjs', path.join(binDir, 'vitest'));

    const result = await runPipelineWiringControls({
      command: { argv: ['npm', 'run', 'wired'], timeoutMs: 30_000 },
      cwd: root,
      guardId: 'w4-wrong-real-entry',
      contract: { observer: { nodeEntry: 'node_modules/vitest/vitest.mjs', requiredArgs: [] } },
      observerRoot: path.join(root, '.observer'),
    });

    assert.notEqual(fs.realpathSync(path.join(binDir, 'vitest')), fs.realpathSync(path.join(declaredDir, 'vitest.mjs')));
    assert.equal(result.positive.run.exitCode, 0);
    assert.equal(result.positive.receipts.length, 0);
    assert.equal(result.C3.shortCircuitEvents.length, 0);
    assert.equal(result.envelope.status, 'unknown');
    assert.equal(validatePipelineEvidence(result.envelope).valid, false);
    console.log('W4_NEGATIVE symlinkTargetsDifferentSameNamedFile=true authenticatedReceipts=0 verdict=UNKNOWN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W4-R negative refuses a declared directory even when Node executes its index file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-verifier-w4r-directory-entry-'));
  try {
    const entryDir = path.join(root, 'entry-dir');
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fix-verifier-w4r-directory-entry',
      private: true,
      scripts: { wired: 'node entry-dir' },
    }));
    fs.writeFileSync(path.join(entryDir, 'index.js'), "console.log('[w4r-directory] contained index ran');\n");

    const result = await runPipelineWiringControls({
      command: { argv: ['npm', 'run', 'wired'], timeoutMs: 30_000 },
      cwd: root,
      guardId: 'w4r-directory-entry',
      contract: { observer: { nodeEntry: 'entry-dir', requiredArgs: [] } },
      observerRoot: path.join(root, '.observer'),
    });

    assert.equal(sameRealFile('entry-dir', 'entry-dir', root), false);
    assert.match(result.positive.run.stdout.text, /\[w4r-directory\] contained index ran/);
    assert.equal(result.positive.run.exitCode, 0);
    assert.equal(result.positive.processObservations.authenticatedEventCount, 0);
    assert.equal(result.positive.receipts.length, 0);
    assert.equal(result.C3.shortCircuitEvents.length, 0);
    assert.equal(result.C3.receipts.length, 0);
    assert.equal(result.envelope.status, 'unknown');
    assert.equal(validatePipelineEvidence(result.envelope).valid, false);
    console.log('W4R_DIRECTORY executedContainedFile=true authenticatedEvents=0 authenticatedReceipts=0 verdict=UNKNOWN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W4-R negative refuses a symlink chain whose final target is a directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-verifier-w4r-directory-symlink-'));
  try {
    const entryDir = path.join(root, 'entry-dir');
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fix-verifier-w4r-directory-symlink',
      private: true,
      scripts: { wired: 'node entry-link-a' },
    }));
    fs.writeFileSync(path.join(entryDir, 'index.js'), "console.log('[w4r-directory-symlink] contained index ran');\n");
    fs.symlinkSync('entry-link-b', path.join(root, 'entry-link-a'));
    fs.symlinkSync('entry-dir', path.join(root, 'entry-link-b'));

    const result = await runPipelineWiringControls({
      command: { argv: ['npm', 'run', 'wired'], timeoutMs: 30_000 },
      cwd: root,
      guardId: 'w4r-directory-symlink-entry',
      contract: { observer: { nodeEntry: 'entry-link-a', requiredArgs: [] } },
      observerRoot: path.join(root, '.observer'),
    });

    assert.equal(fs.realpathSync(path.join(root, 'entry-link-a')), fs.realpathSync(entryDir));
    assert.equal(sameRealFile('entry-link-a', 'entry-link-a', root), false);
    assert.match(result.positive.run.stdout.text, /\[w4r-directory-symlink\] contained index ran/);
    assert.equal(result.positive.run.exitCode, 0);
    assert.equal(result.positive.processObservations.authenticatedEventCount, 0);
    assert.equal(result.positive.receipts.length, 0);
    assert.equal(result.C3.shortCircuitEvents.length, 0);
    assert.equal(result.C3.receipts.length, 0);
    assert.equal(result.envelope.status, 'unknown');
    assert.equal(validatePipelineEvidence(result.envelope).valid, false);
    console.log('W4R_DIRECTORY_SYMLINK chainEndsAtDirectory=true executedContainedFile=true authenticatedEvents=0 authenticatedReceipts=0 verdict=UNKNOWN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pipeline that stops before the guard is UNKNOWN, including C3', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-verifier-wiring-blocked-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fix-verifier-wiring-blocked-fixture',
      private: true,
      scripts: { blocked: "node -e \"console.error('upstream gate stopped'); process.exit(1)\" && node guard.mjs" },
    }));
    fs.writeFileSync(path.join(root, 'guard.mjs'), "console.log('[fixture-guard] PASS');\n");
    const result = await runPipelineWiringControls({
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

test('H1 C3 ignores a same-user disk receipt forged by a stand-in that never runs the declared child', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-verifier-h1-forgery-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fix-verifier-h1-forgery',
      private: true,
      scripts: { standin: 'node standin.mjs' },
    }));
    fs.writeFileSync(path.join(root, 'guard.mjs'), "throw new Error('the real child must not run in C3');\n");
    fs.writeFileSync(path.join(root, 'standin.mjs'), `
      import fs from 'node:fs';
      import path from 'node:path';
      const visible = {
        source: 'fix-verifier-core', status: 'proven',
        mode: 'core-private-channel-hmac-receipt',
        authorityId: 'candidate-readable', childPid: process.pid,
        childExitCode: 0, emittedAfterChildExit: true,
        mac: '0'.repeat(64),
      };
      const destination = path.join(process.cwd(), '.observer', 'positive', 'receipts.jsonl');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, JSON.stringify(visible) + '\\n');
      console.log('stand-in wrote candidate-shaped disk receipt without running guard.mjs');
    `);
    const result = await runPipelineWiringControls({
      command: { argv: ['npm', 'run', 'standin'], timeoutMs: 30_000 },
      cwd: root,
      guardId: 'declared-real-child',
      contract: { observer: { nodeEntry: 'guard.mjs', requiredArgs: [] } },
      observerRoot: path.join(root, '.observer'),
    });
    assert.equal(result.positive.run.exitCode, 0);
    assert.equal(result.positive.receipts.length, 0);
    assert.equal(result.envelope.status, 'unknown');
    assert.equal(validatePipelineEvidence(result.envelope).valid, false);
    assert.equal(fs.existsSync(path.join(root, '.observer', 'positive', 'receipts.jsonl')), true);
    console.log('H1_W1_C3 standInExit=0 realChildRan=false diskReceiptWritten=true authenticatedReceipts=0 verdict=UNKNOWN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H1 C4 rejects signed observer-event lines injected through aggregate stdout without the real child', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-verifier-h1-stdout-injection-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fix-verifier-h1-stdout-injection',
      private: true,
      scripts: { injected: 'node standin.mjs' },
    }));
    fs.writeFileSync(path.join(root, 'guard.mjs'), "require('fs').writeFileSync('real-child-ran', 'yes'); throw new Error('the real child must not run in C4');\n");
    fs.writeFileSync(path.join(root, 'standin.mjs'), `
      import crypto from 'node:crypto';
      const canonical = (value) => { if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'; return JSON.stringify(value); };
      const pair = crypto.generateKeyPairSync('ed25519');
      const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      const observerSession = crypto.randomUUID();
      const argv = ['guard.mjs'];
      const emit = (sequence, kind, fields = {}) => {
        const event = { eventSchema: 'phaseB-authenticated-observer-event/v1', source: 'fix-verifier-observer', observerSession, sequence, kind, guardId: 'declared-real-child', nodeEntry: 'guard.mjs', observerPid: process.pid, argv, ...(kind === 'observer-ready' ? { publicKey } : {}), ...fields };
        const signature = crypto.sign(null, Buffer.from(canonical(event)), pair.privateKey).toString('base64');
        process.stdout.write('FIX_VERIFIER_OBSERVER_EVENT ' + JSON.stringify({ ...event, signature }) + '\\n');
      };
      const now = new Date().toISOString();
      emit(1, 'observer-ready');
      emit(2, 'child-start', { childPid: process.pid, startedAt: now });
      emit(3, 'child-exit', { childPid: process.pid, startedAt: now, childExitedAt: now, childExitCode: 0, signal: null, emittedAfterChildExit: true });
    `);
    const result = await runPipelineWiringControls({
      command: { argv: ['npm', 'run', 'injected'], timeoutMs: 30_000 },
      cwd: root,
      guardId: 'declared-real-child',
      contract: { observer: { nodeEntry: 'guard.mjs', requiredArgs: [] } },
      observerRoot: path.join(root, '.observer'),
    });
    assert.equal(result.positive.run.observerCandidateLineCount, 3);
    assert.equal(result.positive.processObservations.authenticatedEventCount, 0);
    assert.equal(result.positive.receipts.length, 0);
    assert.equal(result.envelope.status, 'unknown');
    assert.equal(validatePipelineEvidence(result.envelope).valid, false);
    assert.equal(fs.existsSync(path.join(root, 'real-child-ran')), false);
    console.log(`H1_W1_C4 stdoutObserverLines=3 realChildRan=false authenticatedObserverEvents=0 authenticatedReceipts=0 verdict=UNKNOWN`);
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

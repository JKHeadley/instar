// safe-git-allow: test-tmpdir-cleanup — afterEach removes only directories created by mkdtempSync.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checkerSource = path.join(repoRoot, 'scripts/check-phase-complete.cjs');
const expectationSource = path.join(repoRoot, 'scripts/lib/phase-acceptance-output.cjs');
const fixtureDirs: string[] = [];

const expectedSevenPassed = {
  source: 'stdout',
  schema: 'instar-parity-summary/v1',
  equals: {
    total: 7,
    passed: 7,
    failed: 0,
    skipped: 0,
  },
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runControlledGate(stdout: string, runnerExitCode = 0) {
  const root = mkdtempSync(path.join(tmpdir(), 'instar-r2-acceptance-'));
  fixtureDirs.push(root);
  const scriptsDir = path.join(root, 'scripts');
  const libDir = path.join(scriptsDir, 'lib');
  const acceptanceDir = path.join(root, 'specs/provider-portability/acceptance');
  mkdirSync(libDir, { recursive: true });
  mkdirSync(acceptanceDir, { recursive: true });
  copyFileSync(checkerSource, path.join(scriptsDir, 'check-phase-complete.cjs'));
  copyFileSync(expectationSource, path.join(libDir, 'phase-acceptance-output.cjs'));

  const markerPath = path.join(root, 'runner-executed.marker');
  const runnerPath = path.join(root, 'controlled-runner.cjs');
  writeFileSync(
    runnerPath,
    [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed');`,
      `process.stdout.write(${JSON.stringify(stdout)});`,
      `process.exit(${runnerExitCode});`,
      '',
    ].join('\n'),
  );

  writeFileSync(
    path.join(acceptanceDir, 'phase-R2.json'),
    JSON.stringify({
      phase: 'R2',
      name: 'population assertion control',
      status: 'probe',
      structuralGates: [],
      realApiGates: [{
        id: 'population-control',
        description: 'controlled output',
        command: `${shellQuote(process.execPath)} ${shellQuote(runnerPath)}`,
        expectExitCode: 0,
        expectJson: expectedSevenPassed,
      }],
    }),
  );

  const result = spawnSync(
    process.execPath,
    [path.join(scriptsDir, 'check-phase-complete.cjs'), 'R2'],
    { cwd: root, encoding: 'utf8' },
  );
  expect(result.error).toBeUndefined();
  expect(existsSync(markerPath)).toBe(true);
  expect(readFileSync(markerPath, 'utf8')).toBe('executed');
  return result;
}

afterEach(() => {
  for (const fixtureDir of fixtureDirs.splice(0)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('phase acceptance structured population assertions', () => {
  it('must-fire: rejects the legacy false-positive text "10 fail" even when the runner exits zero', () => {
    const result = runControlledGate('10 fail\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[FAIL] population-control');
    expect(result.stderr).toContain('expected stdout to be one JSON document');
    console.log('R2_C1 runnerExecuted=true runnerExit=0 stdout="10 fail" repairedGate=FAIL');
  });

  it('must-fire: rejects a structured ran-and-some-failed result independently of exit code', () => {
    const result = runControlledGate(JSON.stringify({
      schema: 'instar-parity-summary/v1',
      total: 7,
      passed: 6,
      failed: 1,
      skipped: 0,
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('field "passed" to equal 7, got 6');
    console.log('R2_C2 runnerExecuted=true runnerExit=0 total=7 failed=1 repairedGate=FAIL');
  });

  it('must-fire: rejects a structured zero-scenario result even when the runner exits zero', () => {
    const result = runControlledGate(JSON.stringify({
      schema: 'instar-parity-summary/v1',
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('field "total" to equal 7, got 0');
    console.log('R2_C3 runnerExecuted=true runnerExit=0 total=0 failed=0 repairedGate=FAIL');
  });

  it('must-not-fire: accepts an exact seven-scenario all-passed result', () => {
    const result = runControlledGate(JSON.stringify({
      schema: 'instar-parity-summary/v1',
      total: 7,
      passed: 7,
      failed: 0,
      skipped: 0,
    }));
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[PASS] population-control');
    console.log('R2_C4 runnerExecuted=true runnerExit=0 total=7 failed=0 repairedGate=PASS');
  });
});

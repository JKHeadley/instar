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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_SMOKETEST_SCHEMA,
  codexSmoketestSuccess,
  createCodexSmoketestReporter,
} from '../../src/providers/adapters/openai-codex/smoketest-result.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checkerSource = path.join(repoRoot, 'scripts/check-phase-complete.cjs');
const expectationSource = path.join(repoRoot, 'scripts/lib/phase-acceptance-output.cjs');
const phase4ManifestPath = path.join(repoRoot, 'specs/provider-portability/acceptance/phase-4.json');
const smokeProducerPath = path.join(repoRoot, 'src/providers/adapters/openai-codex/_smoketest.ts');
const smokeResultPath = path.join(repoRoot, 'src/providers/adapters/openai-codex/smoketest-result.ts');
const viteNodePath = path.join(repoRoot, 'node_modules/vite-node/vite-node.mjs');
const fixtureDirs: string[] = [];

const expectedSmokeSuccess = {
  source: 'stdout',
  schema: CODEX_SMOKETEST_SCHEMA,
  equals: {
    status: 'passed',
    responseNonEmpty: true,
  },
};

function captureReporter(jsonOutput: boolean) {
  let stdout = '';
  let stderr = '';
  const reporter = createCodexSmoketestReporter(jsonOutput, {
    stdout: { write: (chunk: string) => { stdout += chunk; } },
    stderr: { write: (chunk: string) => { stderr += chunk; } },
  });
  return {
    reporter,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runControlledGate(stdout: string, runnerExitCode = 0) {
  const root = mkdtempSync(path.join(tmpdir(), 'instar-r4-smoketest-'));
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
    path.join(acceptanceDir, 'phase-R4.json'),
    JSON.stringify({
      phase: 'R4',
      name: 'structured Codex smoke control',
      status: 'probe',
      structuralGates: [],
      realApiGates: [{
        id: 'codex-smoketest-control',
        description: 'controlled smoke result',
        command: `${shellQuote(process.execPath)} ${shellQuote(runnerPath)}`,
        expectExitCode: 0,
        expectJson: expectedSmokeSuccess,
      }],
    }),
  );

  const result = spawnSync(
    process.execPath,
    [path.join(scriptsDir, 'check-phase-complete.cjs'), 'R4'],
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

describe('phase acceptance structured Codex smoke result', () => {
  it('ratchets the production Phase 4 gate to the structured contract', () => {
    const manifest = JSON.parse(readFileSync(phase4ManifestPath, 'utf8')) as {
      realApiGates: Array<Record<string, unknown>>;
    };
    const gate = manifest.realApiGates.find((candidate) => candidate.id === 'codex-smoketest');
    expect(gate).toBeDefined();
    expect(gate).not.toHaveProperty('expectStdoutContains');
    expect(gate).toMatchObject({
      command: expect.stringContaining('_smoketest.ts --json'),
      expectExitCode: 0,
      expectJson: expectedSmokeSuccess,
    });
  });

  it('must-fire: rejects the old PASSED sentinel even with exit zero', () => {
    const result = runControlledGate('[openai-codex smoketest] PASSED\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[FAIL] codex-smoketest-control');
    expect(result.stderr).toContain('expected stdout to be one JSON document');
    console.log('R4_C1 runnerExecuted=true runnerExit=0 legacySentinel=true repairedGate=FAIL');
  });

  it('must-fire: rejects a structured non-success even with exit zero', () => {
    const result = runControlledGate(JSON.stringify({
      schema: CODEX_SMOKETEST_SCHEMA,
      status: 'failed',
      responseNonEmpty: false,
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('field "status" to equal "passed", got "failed"');
    console.log('R4_C2 runnerExecuted=true runnerExit=0 status=failed repairedGate=FAIL');
  });

  it('must-fire: preserves non-zero exit refusal even with a valid receipt', () => {
    const result = runControlledGate(JSON.stringify(codexSmoketestSuccess('PONGXYZ')), 3);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected exit 0, got 3');
    console.log('R4_C3 runnerExecuted=true runnerExit=3 receipt=valid repairedGate=FAIL');
  });

  it('must-not-fire: accepts exact structured success without the word PASSED', () => {
    const capture = captureReporter(true);
    capture.reporter.info('[openai-codex smoketest] wording may change');
    const receipt = capture.reporter.success('PONGXYZ');
    const stdout = capture.stdout();
    expect(stdout).toBe(`${JSON.stringify(receipt)}\n`);
    expect(stdout).not.toContain('PASSED');
    expect(capture.stderr()).toContain('wording may change');
    const result = runControlledGate(stdout);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[PASS] codex-smoketest-control');
    console.log('R4_C4 runnerExecuted=true runnerExit=0 receipt=valid legacySentinel=false repairedGate=PASS');
  });

  it('does not issue a success receipt for empty provider output', () => {
    const capture = captureReporter(true);
    expect(capture.reporter.success('')).toBeNull();
    expect(capture.stdout()).toBe('');
    expect(codexSmoketestSuccess('PONGXYZ')).toEqual({
      schema: CODEX_SMOKETEST_SCHEMA,
      status: 'passed',
      responseNonEmpty: true,
    });
  });

  it('preserves the existing human-readable success mode', () => {
    const capture = captureReporter(false);
    capture.reporter.info('[openai-codex smoketest] response arrived');
    capture.reporter.success('PONGXYZ');
    expect(capture.stderr()).toBe('');
    expect(capture.stdout()).toBe(
      '[openai-codex smoketest] response arrived\n'
      + '[openai-codex smoketest] PASSED\n',
    );
  });

  it('delivers JSON stdout and diagnostics before a child exits naturally', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'instar-r4-smoke-child-'));
    fixtureDirs.push(root);
    const childPath = path.join(root, 'receipt-child.ts');
    writeFileSync(childPath, [
      `import { createCodexSmoketestReporter } from ${JSON.stringify(pathToFileURL(smokeResultPath).href)};`,
      'const reporter = createCodexSmoketestReporter(true);',
      "reporter.info('[openai-codex smoketest] diagnostic before receipt');",
      "process.exitCode = reporter.success('PONGXYZ') ? 0 : 1;",
      '',
    ].join('\n'));

    const result = spawnSync(process.execPath, [viteNodePath, childPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(codexSmoketestSuccess('PONGXYZ'))}\n`);
    expect(result.stderr).toContain('diagnostic before receipt');
  });

  it('lets the actual no-credential CLI flush both diagnostics before exit 2', () => {
    const emptyCodexHome = mkdtempSync(path.join(tmpdir(), 'instar-r4-empty-codex-home-'));
    fixtureDirs.push(emptyCodexHome);
    const env = { ...process.env, CODEX_HOME: emptyCodexHome };
    delete env.OPENAI_API_KEY;

    const result = spawnSync(
      process.execPath,
      [viteNodePath, smokeProducerPath, '--json'],
      { cwd: repoRoot, encoding: 'utf8', env },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('BLOCKED — no Codex credentials available');
    expect(result.stderr).toContain('Set OPENAI_API_KEY=sk-... or run `codex login`');
  });
});

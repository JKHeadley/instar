/**
 * The parked-test re-check must parse the exclusion list correctly — including its prose.
 *
 * WHY THIS TEST IS THE IMPORTANT ONE. The first version of the script used a naive
 * `/'([^']+)'/g` over the whole `FLAKY_TESTS` block. That array is heavily commented BY DESIGN —
 * the comments are what stop the next person re-parking a test on a wrong label — and one of those
 * comments contains an apostrophe ("the test's own beforeAll").
 *
 * The damage was worse than a stray entry. A single unbalanced apostrophe shifts quote PAIRING for
 * everything after it, so the naive parser both INVENTED entries (`s own`) and SILENTLY DROPPED
 * dozens of real ones. It reported 42 dangling files where there is exactly one, and a count of 92
 * against a true 91.
 *
 * That count was not only wrong here: it was published in a release note. A parser that fails by
 * producing a plausible number is the exact failure this repository keeps finding — so the parser is
 * pinned against prose, not just against a clean list.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/recheck-parked-tests.mjs');

function runAgainstRealRepo(): { parkedTotal: number; missingFiles: string[]; globPatterns: string[] } {
  const res = spawnSync(process.execPath, [SCRIPT, '--missing-only', '--json'], {
    cwd: ROOT, encoding: 'utf-8', timeout: 120_000,
  });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout);
}

type SyntheticMode = 'real' | 'ansi-rendered' | 'wrong-wording' | 'corrupt-report' | 'missing-runner';
type SyntheticRun = {
  runs: Array<'pass' | 'fail' | 'errored'>;
  runDetails: Array<{
    outcome: 'pass' | 'fail' | 'errored';
    reason: string;
    exitCode: number | null;
    structured?: { total: number; passed: number; failed: number };
  }>;
  verdict: string;
};

function copyProductionScript(dir: string): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/recheck-parked-tests.mjs'));

  // The production script uses the repository's destructive-filesystem funnel for temporary
  // report cleanup. Synthetic repositories copy the exact compiled runtime dependencies rather
  // than substituting a weaker cleanup implementation.
  const distCore = path.join(dir, 'dist', 'core');
  fs.mkdirSync(distCore, { recursive: true });
  for (const file of ['SafeFsExecutor.js', 'SafeGitExecutor.js', 'SourceTreeGuard.js']) {
    fs.copyFileSync(path.join(ROOT, 'dist', 'core', file), path.join(distCore, file));
  }
}

function writeSyntheticRepo(mode: SyntheticMode, testBody: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-outcome-'));
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  copyProductionScript(dir);
  fs.writeFileSync(path.join(dir, 'vitest.push.config.ts'), [
    'const FLAKY_TESTS = [',
    "  'tests/outcome.test.ts',",
    '];',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'vitest.config.mjs'),
    'export default { test: { globals: true } };\n');
  fs.writeFileSync(path.join(dir, 'tests/outcome.test.ts'), testBody);

  if (mode !== 'missing-runner') {
    const bin = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    const realVitest = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const wrapper = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      `const realVitest = ${JSON.stringify(realVitest)};`,
      "const args = [...process.argv.slice(2), '--cache=false'];",
      "const result = spawnSync(process.execPath, [realVitest, ...args], { cwd: process.cwd(), encoding: 'utf8', env: process.env });",
      ...(mode === 'wrong-wording' ? [
        "const stdout = result.stdout || '';",
        "const stderr = result.stderr || '';",
      ] : [
        "const stdout = (result.stdout || '').replaceAll('Tests', 'Checks');",
        "const stderr = (result.stderr || '').replaceAll('Tests', 'Checks');",
      ]),
      ...(mode === 'ansi-rendered' ? [
        "const renderedStdout = stdout.replace(/(Checks)(\\s+)(1)(\\s+failed)/, '$1$2\\u001b[31m$3$4\\u001b[39m');",
        "const renderedStderr = stderr.replace(/(Checks)(\\s+)(1)(\\s+failed)/, '$1$2\\u001b[31m$3$4\\u001b[39m');",
      ] : [
        'const renderedStdout = stdout;',
        'const renderedStderr = stderr;',
      ]),
      "if (process.env.R3_RENDER_CAPTURE) fs.writeFileSync(process.env.R3_RENDER_CAPTURE, renderedStdout + renderedStderr);",
      ...(mode === 'corrupt-report' ? [
        "const outputArg = args.find((arg) => arg.startsWith('--outputFile.json='));",
        "if (outputArg) fs.writeFileSync(outputArg.slice('--outputFile.json='.length), '{not-json');",
      ] : []),
      'process.stdout.write(renderedStdout);',
      'process.stderr.write(renderedStderr);',
      'process.exit(result.status ?? 1);',
      '',
    ].join('\n');
    const wrapperPath = path.join(bin, 'vitest');
    fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  }
  return dir;
}

function runSyntheticRepo(dir: string): { result: SyntheticRun; rendered: string } {
  const renderCapture = path.join(dir, 'rendered.txt');
  const res = spawnSync(process.execPath,
    ['scripts/recheck-parked-tests.mjs', '--slice', '1', '--runs', '1', '--json'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env, R3_RENDER_CAPTURE: renderCapture },
    });
  expect(res.status, res.stderr).toBe(0);
  const report = JSON.parse(res.stdout);
  expect(report.checked).toHaveLength(1);
  return {
    result: report.checked[0],
    rendered: fs.existsSync(renderCapture) ? fs.readFileSync(renderCapture, 'utf-8') : '',
  };
}

function removeSyntheticRepo(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/recheck-parked-tests.test.ts:outcome-cleanup',
  });
}

function expectRenderedWrapperSummary(rendered: string): void {
  const text = stripVTControlCharacters(rendered);
  expect(text).toMatch(/Checks\s+1\s+failed/);
  expect(text).not.toMatch(/Tests\s+1\s+failed/);
}

describe('parked-test re-check', () => {
  it('always exits 0 — it reports, it does not gate', () => {
    // Gating here would recreate the original problem from the other side: a red build for a test
    // somebody parked deliberately.
    const res = spawnSync(process.execPath, [SCRIPT, '--missing-only'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 120_000,
    });
    expect(res.status).toBe(0);
  });

  it('THE PARSER: prose in the array does not become an entry', () => {
    const report = runAgainstRealRepo();
    // Every entry must look like a test path. `s own` — the fragment the naive parser produced from
    // an apostrophe in a comment — could never satisfy this.
    for (const f of [...report.missingFiles, ...report.globPatterns]) {
      expect(f, `${f} is not a test path`).toMatch(/^tests\//);
    }
    expect(report.parkedTotal).toBeGreaterThan(50);
  });

  it('RATCHET: the live exclusion list has no entry for a file that does not exist', () => {
    // This used to assert the OPPOSITE — that the report CONTAINS
    // 'tests/unit/slack-stall-active-gate.test.ts', the one real dangling entry
    // in the repo at the time. That made a known defect load-bearing: fixing the
    // dangling entry broke the test that used it as a fixture, and the only way
    // to go green was to put the defect back.
    //
    // The capability this was reaching for — "the tool detects an exclusion whose
    // file is gone" — is proven properly by the synthetic-config test below,
    // which builds two missing files and requires both to be found. That proof
    // does not need the repo to keep a defect around.
    //
    // So the assertion is inverted into a ratchet: the list must stay clean. Park
    // a test and later delete the file, and this goes red — which is the failure
    // the parked-list re-check exists to surface.
    const report = runAgainstRealRepo();
    expect(
      report.missingFiles,
      'an exclusion points at a file that no longer exists — remove the exclusion, do not re-add the file',
    ).toEqual([]);
  });

  it('reports glob patterns separately rather than pretending they are files', () => {
    const report = runAgainstRealRepo();
    for (const g of report.globPatterns) expect(g).toContain('*');
    // A glob must never be counted as a missing file — it resolves to many, or none.
    for (const g of report.globPatterns) expect(report.missingFiles).not.toContain(g);
  });

  it('REGRESSION: an apostrophe in a comment cannot corrupt the parse', () => {
    // Reproduces the exact failure in miniature, against a synthetic config.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-parse-'));
    try {
      fs.writeFileSync(path.join(dir, 'vitest.push.config.ts'), [
        'const FLAKY_TESTS = [',
        "  // the test's own beforeAll regenerates it — an apostrophe, deliberately",
        "  'tests/unit/alpha.test.ts',",
        "  'tests/unit/beta.test.ts',",
        '];',
      ].join('\n'));
      copyProductionScript(dir);

      const res = spawnSync(process.execPath, ['scripts/recheck-parked-tests.mjs', '--missing-only', '--json'], {
        cwd: dir, encoding: 'utf-8', timeout: 60_000,
      });
      const out = JSON.parse(res.stdout);
      expect(out.parkedTotal).toBe(2);
      expect(out.missingFiles.sort()).toEqual(['tests/unit/alpha.test.ts', 'tests/unit/beta.test.ts']);
    } finally {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true, force: true,
        operation: 'tests/unit/recheck-parked-tests.test.ts:cleanup',
      });
    }
  });

  it('MUST-FIRE: a genuine failure comes from JSON even when rendered wording changes', () => {
    const dir = writeSyntheticRepo('ansi-rendered', [
      "it('genuinely fails', () => {",
      '  expect(1).toBe(2);',
      '});',
    ].join('\n'));
    try {
      const { result, rendered } = runSyntheticRepo(dir);
      expectRenderedWrapperSummary(rendered);
      expect(result.runs).toEqual(['fail']);
      expect(result.verdict).toBe('deterministic-fail');
      expect(result.runDetails[0]).toMatchObject({
        outcome: 'fail',
        reason: 'tests-failed',
        exitCode: 1,
        structured: { total: 1, passed: 0, failed: 1 },
      });
    } finally {
      removeSyntheticRepo(dir);
    }
  });

  it('MUST-FIRE CONTROL: the rendered-summary contract rejects wrong Tests wording', () => {
    const dir = writeSyntheticRepo('wrong-wording', [
      "it('genuinely fails', () => {",
      '  expect(1).toBe(2);',
      '});',
    ].join('\n'));
    try {
      const { rendered } = runSyntheticRepo(dir);
      expect(stripVTControlCharacters(rendered)).toMatch(/Tests\s+1\s+failed/);
      expect(() => expectRenderedWrapperSummary(rendered)).toThrowError(/Checks/);
    } finally {
      removeSyntheticRepo(dir);
    }
  });

  it('MUST-NOT-FIRE: a passing run remains a structured pass', () => {
    const dir = writeSyntheticRepo('real', [
      "it('genuinely passes', () => {",
      '  expect(1).toBe(1);',
      '});',
    ].join('\n'));
    try {
      const { result } = runSyntheticRepo(dir);
      expect(result.runs).toEqual(['pass']);
      expect(result.verdict).toBe('deterministic-pass');
      expect(result.runDetails[0]).toMatchObject({
        outcome: 'pass',
        reason: 'tests-passed',
        exitCode: 0,
        structured: { total: 1, passed: 1, failed: 0 },
      });
    } finally {
      removeSyntheticRepo(dir);
    }
  });

  it('MUST-NOT-FIRE: never-started and unparseable runs stay distinct errors', () => {
    const neverStarted = writeSyntheticRepo('missing-runner', "it('would pass', () => expect(1).toBe(1));\n");
    const unparseable = writeSyntheticRepo('corrupt-report', "it('runs then fails', () => expect(1).toBe(2));\n");
    try {
      const missingResult = runSyntheticRepo(neverStarted).result;
      const unparseableResult = runSyntheticRepo(unparseable).result;
      expect(missingResult.runs).toEqual(['errored']);
      expect(missingResult.verdict).toBe('could-not-run');
      expect(missingResult.runDetails[0]).toMatchObject({
        outcome: 'errored', reason: 'runner-not-started', exitCode: null,
      });
      expect(unparseableResult.runs).toEqual(['errored']);
      expect(unparseableResult.verdict).toBe('could-not-run');
      expect(unparseableResult.runDetails[0]).toMatchObject({
        outcome: 'errored', reason: 'structured-report-unparseable', exitCode: 1,
      });
    } finally {
      removeSyntheticRepo(neverStarted);
      removeSyntheticRepo(unparseable);
    }
  });
});

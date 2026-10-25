#!/usr/bin/env node
// safe-git-allow: pre-push smoke runner — read-only git, then Vitest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  changedFilesSince,
  classifyVitestListRun,
  evaluateAffectedSmokeSelection,
  evaluateSmokeBreadth,
  failedTestFilesFromVitestJson,
  readSmokeLimits,
  resolvePrePushBase,
  summarizeVitestFilesOnlyJson,
  summarizeVitestListJson,
} from './lib/pre-push-scope.mjs';

function run(command, args, opts = {}) {
  return spawnSync(command, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    encoding: 'utf-8',
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout,
  });
}

function printSkip(reason) {
  console.log(`⏭️  Local smoke too broad; CI is the authority. ${reason}.`);
  console.log('   The PR test matrix still runs the full suite before merge.');
}

function printIndeterminateSkip(reason) {
  console.warn(`⏭️  LOCAL SMOKE SKIPPED — affected set indeterminate; tests run: 0. ${reason}.`);
  console.warn('   PRE_PUSH_SMOKE_RESULT=SKIPPED reason=affected-set-indeterminate tests_run=0');
  console.warn('   The local tier did not pass; CI remains the authority and runs the full suite before merge.');
}

function readFailedFiles(reportFile) {
  try {
    return failedTestFilesFromVitestJson(fs.readFileSync(reportFile, 'utf-8'), { cwd: process.cwd() });
  } catch (err) {
    console.warn(`pre-push smoke: could not read failed test files from Vitest JSON (${err instanceof Error ? err.message : err}).`);
    return [];
  }
}

function listAffectedTests(baseRef, { filesOnly = false } = {}) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pre-push-list-'));
  const reportFile = path.join(reportDir, 'vitest-list.json');
  try {
    const result = run('npx', [
      'vitest',
      'list',
      ...(filesOnly ? ['--filesOnly'] : []),
      '--config',
      'vitest.push.config.ts',
      '--changed',
      baseRef,
      `--json=${reportFile}`,
    ], {
      timeout: Number.parseInt(process.env.INSTAR_PRE_PUSH_SMOKE_LIST_TIMEOUT_MS ?? '', 10) || 120_000,
    });

    if (result.status !== 0) return { result };

    try {
      const text = fs.readFileSync(reportFile, 'utf-8');
      const selected = filesOnly ? summarizeVitestFilesOnlyJson(text) : summarizeVitestListJson(text);
      return { result, selected };
    } catch (err) {
      return { result, selectionError: err };
    }
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}

/** Shared handling of a listing run that did not produce a usable selection. */
function exitOnUnusableListing(listed) {
  const list = listed.result;
  const listDisposition = classifyVitestListRun(list);
  if (listDisposition.action === 'skip-indeterminate') {
    process.stdout.write(list.stdout ?? '');
    process.stderr.write(list.stderr ?? '');
    printIndeterminateSkip(listDisposition.reason);
    process.exit(0);
  }
  if (listDisposition.action === 'fail') {
    process.stdout.write(list.stdout ?? '');
    process.stderr.write(list.stderr ?? '');
    process.exit(listDisposition.exitCode);
  }
  if (listed.selectionError || !listed.selected) {
    process.stdout.write(list.stdout ?? '');
    process.stderr.write(list.stderr ?? '');
    console.error(
      `pre-push smoke: could not determine the affected test set from Vitest JSON (${listed.selectionError instanceof Error ? listed.selectionError.message : listed.selectionError ?? 'missing structured result'}) — refusing a reassuring local pass.`,
    );
    process.exit(1);
  }
}

function runAffectedSmoke(baseRef) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pre-push-smoke-'));
  const reportFile = path.join(reportDir, 'vitest-results.json');
  try {
    const result = run('npx', [
      'vitest',
      'run',
      '--config',
      'vitest.push.config.ts',
      '--changed',
      baseRef,
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportFile}`,
    ], {
      stdio: 'inherit',
    });

    if ((result.status ?? 1) === 0) return 0;

    const failedFiles = readFailedFiles(reportFile);
    if (failedFiles.length === 0) {
      console.warn('pre-push smoke: no failed test files were found for focused retry; preserving original failure.');
      return result.status ?? 1;
    }

    console.log('');
    console.log(`⚠️  Attempt 1 failed — retrying ${failedFiles.length} failed test file${failedFiles.length === 1 ? '' : 's'} once.`);
    for (const file of failedFiles) console.log(`   - ${file}`);
    console.log('');

    const retry = run('npx', ['vitest', 'run', '--config', 'vitest.push.config.ts', ...failedFiles], {
      stdio: 'inherit',
    });
    return retry.status ?? 1;
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}

const base = resolvePrePushBase();
const limits = readSmokeLimits();
let changed = [];

try {
  changed = changedFilesSince(base.ref);
} catch (err) {
  console.warn(`pre-push smoke: could not compute changed files from ${base.ref} (${err instanceof Error ? err.message : err}) — skipping local smoke; CI is the authority.`);
  process.exit(0);
}

console.log(`🧪 Running smoke tier against ${base.ref} (${base.reason}); changed files: ${changed.length}.`);

if (changed.length === 0) {
  console.log('✅ No changed files relative to smoke base; skipping local smoke.');
  process.exit(0);
}

let breadth = evaluateSmokeBreadth({ changedFileCount: changed.length, testFileCount: 0, testCaseCount: 0 }, limits);
if (breadth.skip) {
  printSkip(breadth.reason);
  process.exit(0);
}

// Stage 1: file names only. It imports no test file, so a change that reaches
// hundreds of tests is found too broad in seconds instead of timing out the
// full listing (which then skipped the smoke tier with tests_run=0).
const filesListed = listAffectedTests(base.ref, { filesOnly: true });
exitOnUnusableListing(filesListed);
breadth = evaluateSmokeBreadth(
  { changedFileCount: changed.length, testFileCount: filesListed.selected.testFileCount, testCaseCount: 0 },
  limits,
);
if (breadth.skip) {
  printSkip(breadth.reason);
  process.exit(0);
}
if (filesListed.selected.testFileCount === 0) {
  console.log('✅ No affected tests selected by Vitest.');
  process.exit(0);
}

// Stage 2: collect test cases, now bounded by the file cap.
const listed = listAffectedTests(base.ref);
exitOnUnusableListing(listed);

const selected = listed.selected;
console.log(`🧪 Smoke affected set: ${selected.testFileCount} test files / ${selected.testCaseCount} test cases.`);

const selection = evaluateAffectedSmokeSelection(
  { changedFileCount: changed.length, testFileCount: selected.testFileCount, testCaseCount: selected.testCaseCount },
  limits,
);
if (selection.action === 'skip') {
  printSkip(selection.reason);
  process.exit(0);
}

if (selection.action === 'no-tests') {
  console.log('✅ No affected tests selected by Vitest.');
  process.exit(0);
}

process.exit(runAffectedSmoke(base.ref));

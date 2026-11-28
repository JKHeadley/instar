#!/usr/bin/env node
// safe-git-allow: pre-push smoke runner — read-only git, then Vitest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  changedFilesSince,
  classifySmokeInputs,
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

function printIndeterminateFailure(reason) {
  console.warn(`LOCAL SMOKE REQUIRES VERIFICATION — affected set indeterminate; tests run: 0. ${reason}.`);
  console.warn('   PRE_PUSH_SMOKE_RESULT=VERIFY reason=affected-set-indeterminate tests_run=0');
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

function listSmokeTests(selection, { filesOnly = false } = {}) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pre-push-list-'));
  const reportFile = path.join(reportDir, 'vitest-list.json');
  try {
    const result = run('npx', [
      'vitest',
      'list',
      ...(filesOnly ? ['--filesOnly'] : []),
      '--config',
      'vitest.push.config.ts',
      ...selection,
      `--json=${reportFile}`,
    ], {
      timeout: Number.parseInt(process.env.INSTAR_PRE_PUSH_SMOKE_LIST_TIMEOUT_MS ?? '', 10) || 120_000,
    });

    if (result.status !== 0) return { result };

    try {
      const text = fs.readFileSync(reportFile, 'utf-8');
      const selected = filesOnly ? summarizeVitestFilesOnlyJson(text, { includeFiles: true }) : summarizeVitestListJson(text);
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
  if (listDisposition.action === 'verify-indeterminate') {
    process.stdout.write(list.stdout ?? '');
    process.stderr.write(list.stderr ?? '');
    printIndeterminateFailure(listDisposition.reason);
    process.exit(1);
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

function runAffectedSmoke(selection) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pre-push-smoke-'));
  const reportFile = path.join(reportDir, 'vitest-results.json');
  try {
    const result = run('npx', [
      'vitest',
      'run',
      '--config',
      'vitest.push.config.ts',
      ...selection,
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
  console.warn(`pre-push smoke: could not compute changed files from ${base.ref} (${err instanceof Error ? err.message : err}) — local verification required.`);
  process.exit(1);
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

const { directTests, deferredE2e, sharedInput, hasSourceChange } = classifySmokeInputs(changed);
let files;
const direct = Boolean(sharedInput) || !hasSourceChange;
if (direct) {
  if (sharedInput) console.log(`Local smoke: shared input ${sharedInput}; related coverage deferred to CI.`);
  if (deferredE2e.length > 0) console.log(`Local smoke: ${deferredE2e.length} directly changed E2E files deferred to the CI E2E job.`);
  files = directTests.filter(file => fs.existsSync(file)).map(file => path.resolve(file));
} else {
  // Related discovery transforms imports. Do it once and reuse the file list.
  const filenames = listSmokeTests(['--changed', base.ref], { filesOnly: true });
  exitOnUnusableListing(filenames);
  files = filenames.selected.files;
}

breadth = evaluateSmokeBreadth({ changedFileCount: changed.length, testFileCount: files.length, testCaseCount: 0 }, limits);
if (breadth.skip) {
  printSkip(breadth.reason);
  process.exit(0);
}
if (files.length === 0) {
  console.log('Local smoke: zero test files selected. CI supplies full coverage.');
  process.exit(0);
}

// Collect and run the exact bounded file selection without another related scan.
const listed = listSmokeTests(files);
exitOnUnusableListing(listed);

const selected = listed.selected;
console.log(`🧪 Local smoke ${direct ? 'direct' : 'related'} selection: ${selected.testFileCount} test files / ${selected.testCaseCount} test cases.`);

const selection = evaluateAffectedSmokeSelection(
  { changedFileCount: changed.length, testFileCount: selected.testFileCount, testCaseCount: selected.testCaseCount },
  limits,
);
if (selection.action === 'skip') {
  printSkip(selection.reason);
  process.exit(0);
}

if (selection.action === 'no-tests') {
  console.log(direct ? 'Local smoke: zero test cases selected from directly changed files under the push config.' : 'Local smoke: zero test cases selected from the related file list.');
  process.exit(0);
}

process.exit(runAffectedSmoke(files));

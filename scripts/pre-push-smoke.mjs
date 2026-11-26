#!/usr/bin/env node
// safe-git-allow: pre-push smoke runner — read-only git, then Vitest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  changedFilesSince,
  classifyVitestListRun,
  directSmokeCheckoutClean,
  directSmokeReportMatches,
  evaluateAffectedSmokeSelection,
  evaluateSmokeBreadth,
  failedTestFilesFromVitestJson,
  readSmokeLimits,
  resolvePrePushBase,
  summarizeVitestFilesOnlyJson,
  summarizeVitestListJson,
  supportsDirectSmoke,
  trackedDirectSmokeTests,
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

function listAffectedTests(baseRef, { filesOnly = false, selectedFiles } = {}) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pre-push-list-'));
  const reportFile = path.join(reportDir, 'vitest-list.json');
  try {
    const result = run('npx', [
      'vitest',
      'list',
      ...(filesOnly ? ['--filesOnly'] : []),
      '--config',
      'vitest.push.config.ts',
      ...(selectedFiles ? selectedFiles : ['--changed', baseRef]),
      `--json=${reportFile}`,
    ], {
      timeout: Number.parseInt(process.env.INSTAR_PRE_PUSH_SMOKE_LIST_TIMEOUT_MS ?? '', 10) || 120_000,
    });

    if (result.status !== 0) return { result };

    try {
      const text = fs.readFileSync(reportFile, 'utf-8');
      const parse = filesOnly ? summarizeVitestFilesOnlyJson : summarizeVitestListJson;
      const selected = parse(text, { includePaths: selectedFiles !== undefined });
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

function directReportMatches(reportFile, expectedCounts) {
  try {
    return directSmokeReportMatches(fs.readFileSync(reportFile, 'utf8'), expectedCounts);
  } catch {
    return false;
  }
}

function runAffectedSmoke(baseRef, selectedFiles, expectedCounts) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pre-push-smoke-'));
  const reportFile = path.join(reportDir, 'vitest-results.json');
  try {
    const result = run('npx', [
      'vitest',
      'run',
      '--config',
      'vitest.push.config.ts',
      ...(selectedFiles ? selectedFiles : ['--changed', baseRef]),
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportFile}`,
    ], {
      stdio: 'inherit',
    });

    if (selectedFiles && (result.signal || result.error || !directReportMatches(reportFile, expectedCounts))) {
      console.error('Direct smoke results did not contain the expected files and case counts.');
      return 1;
    }
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

    const retryReport = path.join(reportDir, 'vitest-retry-results.json');
    const retryFiles = selectedFiles ? failedFiles.map(file => path.resolve(file)) : failedFiles;
    const retry = run('npx', ['vitest', 'run', '--config', 'vitest.push.config.ts',
      ...(selectedFiles ? ['--reporter=default', '--reporter=json', `--outputFile.json=${retryReport}`] : []),
      ...retryFiles], { stdio: 'inherit' });
    if (selectedFiles) {
      const retryCounts = new Map(retryFiles.map(file => [file, { ...expectedCounts.get(file), mustExecute: true }]));
      if (retry.signal || retry.error || !directReportMatches(retryReport, retryCounts)) {
        console.error('Direct smoke retry did not contain the expected files and case counts.');
        return 1;
      }
    }
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

// Stage 1: file names only. It imports no test file, so a change that reaches
// hundreds of tests is found too broad in seconds instead of timing out the
// full listing (which then skipped the smoke tier with tests_run=0).
let directFiles;
let selector;
if (supportsDirectSmoke(changed) && directSmokeCheckoutClean()) {
  try { selector = await import('./lib/pre-push-direct.mjs'); }
  catch { console.warn('Direct smoke selection unavailable. Using affected-test discovery.'); }
  if (selector) {
    const inventory = listAffectedTests(base.ref, { filesOnly: true, selectedFiles: [] });
    exitOnUnusableListing(inventory);
    directFiles = selector.selectDirectSmokeFiles(changed, inventory.selected.files, process.cwd(), trackedDirectSmokeTests()) ?? undefined;
    if (directFiles) console.log(`Direct Local Verify smoke includes ${directFiles.length} files. Full shared coverage still applies.`);
  }
}
let testFileCount = directFiles?.length;
if (testFileCount === undefined) {
  const filesListed = listAffectedTests(base.ref, { filesOnly: true });
  exitOnUnusableListing(filesListed);
  testFileCount = filesListed.selected.testFileCount;
}
breadth = evaluateSmokeBreadth(
  { changedFileCount: changed.length, testFileCount, testCaseCount: 0 },
  limits,
);
if (breadth.skip) {
  printSkip(breadth.reason);
  process.exit(0);
}
if (testFileCount === 0) {
  console.log('✅ No affected tests selected by Vitest.');
  process.exit(0);
}

// Stage 2: collect test cases, now bounded by the file cap.
const listed = listAffectedTests(base.ref, { selectedFiles: directFiles });
exitOnUnusableListing(listed);

const selected = listed.selected;
if (directFiles && selected.files.join('\n') !== directFiles.join('\n')) {
  printIndeterminateFailure('direct smoke case discovery did not match the selected files');
  process.exit(1);
}
console.log(`🧪 Smoke affected set: ${selected.testFileCount} test files / ${selected.testCaseCount} test cases.`);

let selectedCases = selected.testCaseCount;
if (directFiles) {
  const bounded = selector.boundDirectSmokeCases(changed, selected.casesByFile, process.cwd(), limits.maxTestCases);
  if (bounded) {
    directFiles = bounded.files;
    selectedCases = bounded.cases;
    console.log(`Direct smoke will run ${selectedCases} cases across ${directFiles.length} files within the local budget.`);
  }
}

const selection = evaluateAffectedSmokeSelection(
  { changedFileCount: changed.length, testFileCount: directFiles?.length ?? selected.testFileCount, testCaseCount: selectedCases },
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

const requiredFiles = directFiles
  ? new Set(selector.mandatoryDirectSmokeFiles(changed).map(file => path.resolve(file)))
  : null;
const expectedCounts = directFiles
  ? new Map(directFiles.map(file => [file, { cases: selected.casesByFile[file], mustExecute: requiredFiles.has(file) }]))
  : null;
process.exit(runAffectedSmoke(base.ref, directFiles, expectedCounts));

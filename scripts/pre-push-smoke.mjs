#!/usr/bin/env node
// safe-git-allow: pre-push smoke runner — read-only git, then Vitest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  changedFilesSince,
  evaluateSmokeBreadth,
  failedTestFilesFromVitestJson,
  readSmokeLimits,
  resolvePrePushBase,
  summarizeVitestList,
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

function readFailedFiles(reportFile) {
  try {
    return failedTestFilesFromVitestJson(fs.readFileSync(reportFile, 'utf-8'), { cwd: process.cwd() });
  } catch (err) {
    console.warn(`pre-push smoke: could not read failed test files from Vitest JSON (${err instanceof Error ? err.message : err}).`);
    return [];
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

const list = run('npx', ['vitest', 'list', '--config', 'vitest.push.config.ts', '--changed', base.ref], {
  timeout: Number.parseInt(process.env.INSTAR_PRE_PUSH_SMOKE_LIST_TIMEOUT_MS ?? '', 10) || 120_000,
});

if (list.status !== 0) {
  process.stdout.write(list.stdout ?? '');
  process.stderr.write(list.stderr ?? '');
  if (list.signal === 'SIGTERM') {
    console.warn('pre-push smoke: affected-test listing timed out — skipping local smoke; CI is the authority.');
    process.exit(0);
  }
  process.exit(list.status ?? 1);
}

const selected = summarizeVitestList(list.stdout);
console.log(`🧪 Smoke affected set: ${selected.testFileCount} test files / ${selected.testCaseCount} test cases.`);

breadth = evaluateSmokeBreadth(
  { changedFileCount: changed.length, testFileCount: selected.testFileCount, testCaseCount: selected.testCaseCount },
  limits,
);
if (breadth.skip) {
  printSkip(breadth.reason);
  process.exit(0);
}

if (selected.testCaseCount === 0) {
  console.log('✅ No affected tests selected by Vitest.');
  process.exit(0);
}

process.exit(runAffectedSmoke(base.ref));

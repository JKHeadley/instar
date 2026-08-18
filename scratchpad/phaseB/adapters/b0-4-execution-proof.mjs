#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [adapterPathArg, repoArg, commitArg, nodeModulesArg, outputArg] = process.argv.slice(2);
if (![adapterPathArg, repoArg, commitArg, nodeModulesArg, outputArg].every(Boolean)) {
  throw new Error('usage: b0-4-execution-proof.mjs <adapter> <repo> <commit> <node_modules> <output>');
}

const adapterPath = fs.realpathSync(adapterPathArg);
const repo = fs.realpathSync(repoArg);
const nodeModules = fs.realpathSync(nodeModulesArg);
const output = path.resolve(outputArg);
const adapter = await import(`${pathToFileURL(adapterPath).href}?proof=${Date.now()}`);
const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(adapterPath), '..', 'fix-verifier.manifest.json'), 'utf8'));
const manifestEntry = manifest.adapters.find((entry) => path.basename(entry.adapter) === path.basename(adapterPath));
if (!manifestEntry) throw new Error(`adapter has no manifest entry: ${adapterPath}`);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b0-4-execution-proof-'));

function spawn(argv, cwd, timeoutMs = 180_000) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', B0_4_EXECUTION_PROOF: '1' },
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = `${stdout}\n${stderr}`;
  const decidingLines = combined.split('\n').filter((line) =>
    /Test Files|Tests\s+(?:\d+|no tests)|AssertionError|expected|received|No test files found|Cannot find name|failed to load|Transform failed|ERR_MODULE_NOT_FOUND|B0\.4-|lint-no-unregistered-self-action:/.test(line),
  ).slice(-20);
  let decidingKind = 'no-deciding-output';
  if (/No test files found|Tests\s+no tests|Cannot find name|failed to load|Transform failed|ERR_MODULE_NOT_FOUND|does not provide an export|ReferenceError/.test(combined)) decidingKind = 'compile-or-no-tests';
  else if (result.status === 0) decidingKind = 'suite-passed';
  else if (/AssertionError|expected|received|(?:Test Files|Tests)\s+\d+\s+failed|violation\(s\)/.test(combined)) decidingKind = 'assertion-or-test-failure';
  return {
    argv,
    exitCode: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    decidingOutput: { kind: decidingKind, lines: decidingLines },
    stdoutTail: stdout.split('\n').slice(-40),
    stderrTail: stderr.split('\n').slice(-40),
  };
}

function requireOk(argv, cwd) {
  const result = spawn(argv, cwd, 120_000);
  if (result.exitCode !== 0 || result.error) throw new Error(`${argv.join(' ')} failed: ${JSON.stringify(result)}`);
}

let copyIndex = 0;
function cloneCase(label) {
  const root = path.join(tempRoot, `${String(++copyIndex).padStart(2, '0')}-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}`);
  requireOk(['git', 'clone', '--shared', '--no-checkout', '--quiet', repo, root], tempRoot);
  requireOk(['git', 'checkout', '--detach', '--quiet', commitArg], root);
  fs.symlinkSync(nodeModules, path.join(root, 'node_modules'), 'dir');
  adapter.prepareWorkspace?.(root);
  return root;
}

function runCommands(root) {
  return adapter.guardCommands.map((command) => spawn(command.argv, root, command.timeoutMs));
}

function snapshot(root, rel) {
  try {
    const stat = fs.lstatSync(path.join(root, rel));
    return {
      exists: true,
      mode: (stat.mode % 0o1000).toString(8).padStart(3, '0'),
      bytes: stat.isFile() ? stat.size : null,
      sha256: stat.isFile() && (stat.mode % 0o1000) !== 0 ? crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex') : null,
    };
  } catch (error) {
    return { exists: false, error: error.code ?? error.message };
  }
}

const record = {
  schemaVersion: 1,
  purpose: 'mutation execution proof only; no instrument verdict is derived',
  adapter: adapterPath,
  pinnedCommit: commitArg,
  positive: null,
  mutations: [],
};

try {
  const positiveRoot = cloneCase('positive');
  record.positive = { runs: runCommands(positiveRoot) };

  for (const mutation of adapter.mutations) {
    const root = cloneCase(mutation.id);
    const before = Object.fromEntries(mutation.paths.map((rel) => [rel, snapshot(root, rel)]));
    let applyError = null;
    let verification = { ok: false, checks: [] };
    let relevance = { status: 'unknown', mode: 'not-run', checks: [] };
    try {
      mutation.apply(root);
      verification = mutation.verify(root);
      const afterForRelevance = Object.fromEntries(mutation.paths.map((rel) => [rel, snapshot(root, rel)]));
      const changedPaths = mutation.paths.filter((rel) => JSON.stringify(before[rel]) !== JSON.stringify(afterForRelevance[rel]));
      relevance = adapter.verifyMutationRelevant({
        root,
        mutation,
        changedPaths,
        guardFiles: manifestEntry.guardFiles,
        subjectFiles: manifestEntry.subjectFiles,
      });
    } catch (error) {
      applyError = error.message;
    }
    const runs = applyError ? [] : runCommands(root);
    const after = Object.fromEntries(mutation.paths.map((rel) => [rel, snapshot(root, rel)]));
    const changedPaths = mutation.paths.filter((rel) => JSON.stringify(before[rel]) !== JSON.stringify(after[rel]));
    record.mutations.push({
      id: mutation.id,
      property: mutation.property,
      violationClass: mutation.violationClass,
      applyError,
      verification,
      relevance,
      proof: { before, after, changedPaths },
      runs,
    });
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  adapter: path.basename(adapterPath),
  pinnedCommit: record.pinnedCommit,
  positive: record.positive.runs.map((run) => ({ exitCode: run.exitCode, decidingOutput: run.decidingOutput })),
  mutations: record.mutations.map((item) => ({
    id: item.id,
    applyError: item.applyError,
    verification: item.verification.ok,
    relevance: item.relevance.status,
    runs: item.runs.map((run) => ({ exitCode: run.exitCode, decidingOutput: run.decidingOutput })),
  })),
}, null, 2));

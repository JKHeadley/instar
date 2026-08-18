#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import {
  createAuthenticatedReceiptAuthority,
  isLiveAuthenticatedReceipt,
} from './authenticated-execution-receipt.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_MANIFEST = path.join(SCRIPT_DIR, 'fix-verifier.manifest.json');
const PROPERTY_IDS = ['P1', 'P2', 'P3', 'P4', 'P5'];
const OUTPUT_LIMIT = 16_000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isoNow() {
  return new Date().toISOString();
}

function clip(value, limit = OUTPUT_LIMIT) {
  const text = String(value ?? '');
  if (text.length <= limit) return { text, truncated: false, originalChars: text.length };
  const half = Math.floor(limit / 2);
  return {
    text: `${text.slice(0, half)}\n...[${text.length - limit} chars omitted]...\n${text.slice(-half)}`,
    truncated: true,
    originalChars: text.length,
  };
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    fixture: 'none',
    keepTemp: false,
    forceMutationFailure: [],
    nodeModules: null,
    output: null,
    wiringOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--guard') args.guard = argv[++i];
    else if (key === '--repo') args.repo = argv[++i];
    else if (key === '--commit') args.commit = argv[++i];
    else if (key === '--manifest') args.manifest = argv[++i];
    else if (key === '--fixture') args.fixture = argv[++i];
    else if (key === '--force-mutation-failure') args.forceMutationFailure.push(...String(argv[++i] ?? '').split(',').filter(Boolean));
    else if (key === '--node-modules') args.nodeModules = argv[++i];
    else if (key === '--output') args.output = argv[++i];
    else if (key === '--wiring-only') args.wiringOnly = true;
    else if (key === '--keep-temp') args.keepTemp = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  for (const required of ['guard', 'repo', 'commit']) {
    if (!args[required]) throw new Error(`missing required --${required}`);
  }
  if (!['none', 'deliberately-hollow-guard'].includes(args.fixture)) {
    throw new Error(`unsupported --fixture ${args.fixture}`);
  }
  for (const forced of args.forceMutationFailure) {
    if (!PROPERTY_IDS.includes(forced) && !/^p[1-5][a-z]?-/.test(forced)) {
      throw new Error(`invalid forced mutation selector: ${forced}`);
    }
  }
  return args;
}

export function validateManifestObject(manifest, manifestPath, { checkAdapters = true } = {}) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) problems.push('manifest must be an object');
  if (manifest?.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (!Array.isArray(manifest?.adapters)) problems.push('adapters must be an array');
  else if (manifest.adapters.length === 0) problems.push('adapter registry is empty; no guard can be measured');
  const ids = new Set();
  for (const [index, guard] of (manifest?.adapters ?? []).entries()) {
    const prefix = `adapters[${index}]`;
    if (!guard || typeof guard !== 'object') { problems.push(`${prefix} must be an object`); continue; }
    if (typeof guard.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(guard.id)) problems.push(`${prefix}.id is invalid`);
    else if (ids.has(guard.id)) problems.push(`${prefix}.id duplicates ${guard.id}`);
    else ids.add(guard.id);
    if (typeof guard.adapter !== 'string' || guard.adapter.length === 0) problems.push(`${prefix}.adapter is required`);
    if (!Array.isArray(guard.guardFiles) || guard.guardFiles.length === 0) problems.push(`${prefix}.guardFiles must be non-empty`);
    if (!Array.isArray(guard.subjectFiles) || guard.subjectFiles.length === 0) problems.push(`${prefix}.subjectFiles must be non-empty`);
    for (const [field, values] of [['guardFiles', guard.guardFiles], ['subjectFiles', guard.subjectFiles]]) {
      for (const rel of values ?? []) {
        if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split('/').includes('..')) problems.push(`${prefix}.${field} contains unsafe path`);
      }
    }
    if (checkAdapters && typeof guard.adapter === 'string') {
      const adapter = path.resolve(path.dirname(manifestPath), guard.adapter);
      if (!adapter.startsWith(`${path.dirname(manifestPath)}${path.sep}`) || !fs.existsSync(adapter)) {
        problems.push(`${prefix}.adapter does not resolve inside the manifest directory`);
      }
    }
  }
  if (problems.length) throw new Error(`invalid checked adapter registry: ${problems.join('; ')}`);
  return { count: manifest.adapters.length, ids: [...ids].sort() };
}

function directSpawn(argv, options = {}) {
  const startedAt = isoNow();
  const startedMs = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = `${stdout}${stderr}`;
  return {
    argv,
    cwd: options.cwd,
    startedAt,
    endedAt: isoNow(),
    durationMs: Date.now() - startedMs,
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    spawnError: result.error?.message ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: clip(stdout),
    stderr: clip(stderr),
    outputSha256: sha256(combined),
    exitProvenance: 'direct child status from spawnSync; shell=false',
  };
}

function processRecord(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'command='], {
    encoding: 'utf8', timeout: 2_000, env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+([\s\S]+)$/);
  return match ? { pid, ppid: Number(match[1]), command: match[2] } : null;
}

function descendantOf(pid, ancestorPid) {
  let cursor = pid;
  const seen = new Set();
  for (let depth = 0; depth < 32 && cursor > 1 && !seen.has(cursor); depth++) {
    if (cursor === ancestorPid) return true;
    seen.add(cursor);
    const record = processRecord(cursor);
    if (!record) return false;
    cursor = record.ppid;
  }
  return cursor === ancestorPid;
}

function streamingSpawn(argv, options = {}, onObserverEvent = () => {}) {
  return new Promise((resolve) => {
    const startedAt = isoNow();
    const startedMs = Date.now();
    let stdout = '';
    let stderr = '';
    let stdoutLines = '';
    let observerError = null;
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        argv, cwd: options.cwd, startedAt, endedAt: isoNow(), durationMs: Date.now() - startedMs,
        pid: null, exitCode: null, signal: null, spawnError: error.message, timedOut: false,
        stdout: clip(''), stderr: clip(''), outputSha256: sha256(''), observerError: null,
        exitProvenance: 'direct child spawn failed before a pid existed',
      });
      return;
    }
    const consumeLines = () => {
      for (;;) {
        const newline = stdoutLines.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutLines.slice(0, newline);
        stdoutLines = stdoutLines.slice(newline + 1);
        if (!line.startsWith('FIX_VERIFIER_OBSERVER_EVENT ')) continue;
        try { onObserverEvent(JSON.parse(line.slice('FIX_VERIFIER_OBSERVER_EVENT '.length)), child.pid); }
        catch (error) {
          observerError = error instanceof Error ? error.message : String(error);
          try { child.kill('SIGTERM'); } catch {}
        }
      }
    };
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutLines += text;
      consumeLines();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => { observerError ??= error.message; });
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2_000).unref();
    }, options.timeoutMs ?? 30_000);
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      consumeLines();
      const combined = `${stdout}${stderr}`;
      resolve({
        argv, cwd: options.cwd, startedAt, endedAt: isoNow(), durationMs: Date.now() - startedMs,
        pid: child.pid, exitCode: typeof code === 'number' ? code : null, signal: signal ?? null,
        spawnError: null, timedOut, stdout: clip(stdout), stderr: clip(stderr),
        outputSha256: sha256(combined), observerError,
        exitProvenance: 'direct child status from spawn; shell=false; nested observer pids validated live with ps',
      });
    });
  });
}

function requireSuccess(argv, options = {}) {
  const run = directSpawn(argv, options);
  if (run.exitCode !== 0 || run.spawnError) {
    throw new Error(`${argv.join(' ')} failed: ${run.spawnError ?? run.stderr.text ?? run.stdout.text}`);
  }
  return run;
}

function gitText(repo, args) {
  const run = requireSuccess(['git', ...args], { cwd: repo });
  return run.stdout.text.trim();
}

function snapshotPath(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) throw new Error(`snapshot path escapes isolated root: ${rel}`);
  try {
    const stat = fs.lstatSync(abs);
    const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other';
    let contentSha256 = null;
    let bytes = null;
    if (stat.isFile()) {
      const content = fs.readFileSync(abs);
      contentSha256 = sha256(content);
      bytes = content.length;
    } else if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(abs);
      contentSha256 = sha256(target);
      bytes = Buffer.byteLength(target);
    }
    return { exists: true, type, mode: (stat.mode & 0o777).toString(8).padStart(3, '0'), bytes, contentSha256 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, type: null, mode: null, bytes: null, contentSha256: null };
    return { exists: null, error: error.message };
  }
}

function snapshotPaths(root, paths) {
  return Object.fromEntries([...new Set(paths)].sort().map((rel) => [rel, snapshotPath(root, rel)]));
}

function changedSnapshotPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((rel) => JSON.stringify(before[rel]) !== JSON.stringify(after[rel]));
}

function runGuardCommands(commands, cwd) {
  const executionToken = crypto.randomUUID();
  const runs = commands.map((command) => {
    const run = directSpawn(command.argv, {
      cwd,
      timeoutMs: command.timeoutMs,
      env: { ...process.env, CI: '1', B0_FIX_VERIFIER_EXECUTION_TOKEN: executionToken },
    });
    const combined = `${run.stdout.text}\n${run.stderr.text}`;
    const observedBy = (command.observeAny ?? []).filter((token) => combined.includes(token));
    const decidingLines = combined.split('\n').filter((line) =>
      /Cannot find name|Test Files|Tests\s+\d+|AssertionError|expected|received|No test files found/.test(line),
    ).slice(-12);
    let decidingKind = 'no-deciding-output';
    if (/Cannot find name|No test files found|Tests\s+0\s+passed|Tests\s+no tests/.test(combined)) decidingKind = 'compile-or-no-tests';
    else if (run.exitCode === 0) decidingKind = 'suite-passed';
    else if (/AssertionError|expected|received|(?:Test Files|Tests)\s+\d+\s+failed/.test(combined)) decidingKind = 'assertion-or-test-failure';
    return {
      ...run,
      observed: observedBy.length > 0,
      observedBy,
      decidingOutput: { kind: decidingKind, lines: decidingLines },
    };
  });
  const executable = runs.every((run) => run.spawnError === null && run.exitCode !== null && !run.timedOut);
  const observed = runs.every((run) => run.observed);
  let outcome = 'unknown';
  if (executable && observed) outcome = runs.every((run) => run.exitCode === 0) ? 'pass' : 'fail';
  return {
    executionToken,
    processProof: 'each argv was spawned directly with shell=false; the recorded exitCode is the child process status',
    outcome,
    executable,
    observed,
    runs,
  };
}

function writeJsonAtomic(outputPath, record) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, absolute);
}

function shouldForce(selectorList, mutation) {
  return selectorList.includes(mutation.property) || selectorList.includes(mutation.id);
}

export function summarizeProperties(mutationEvidence, positiveControlPassed) {
  const properties = {};
  for (const property of PROPERTY_IDS) {
    const evidence = mutationEvidence.filter((item) => item.property === property);
    if (evidence.length === 0) throw new Error(`${property} has an empty mutation population (0/0 is an error)`);
    let outcome;
    if (!positiveControlPassed) outcome = 'unknown';
    else if (evidence.some((item) => !item.mutationApplied || item.mutationRelevant === false || item.guardOutcome === 'unknown')) outcome = 'unknown';
    else if (evidence.every((item) => item.guardOutcome === 'fail')) outcome = 'proven';
    else outcome = 'not-proven';
    if (property === 'P3') {
      const typePreserving = evidence.find((item) => item.id.includes('p3d'));
      const substantive = typePreserving?.guardRun?.runs?.some((run) => run.decidingOutput?.kind === 'assertion-or-test-failure');
      if (!substantive) outcome = 'not-proven';
    }
    properties[property] = { outcome, mutations: evidence.map((item) => item.id) };
  }
  return properties;
}

export function effectiveClasses(mutationEvidence, properties, positiveControlPassed) {
  if (!positiveControlPassed) return [];
  const classes = new Set();
  for (const item of mutationEvidence) {
    if (!item.mutationApplied || item.guardOutcome !== 'fail') continue;
    if (item.property === 'P3') continue;
    classes.add(item.violationClass);
  }
  if (properties.P3?.outcome === 'proven') classes.add('guard removal');
  return [...classes].sort();
}

export function deriveRung({ exists, wired, positiveControlPassed, properties }) {
  const outcomes = Object.values(properties).map((item) => item.outcome);
  if (!exists) return 'not-proven';
  if (outcomes.includes('unknown') || !positiveControlPassed) return 'not-proven';
  if (wired && outcomes.every((value) => value === 'proven')) return 'effective';
  if (wired) return 'wired';
  return 'exists';
}

const RELEVANCE_MODES = new Set(['declared-load-bearing-input', 'outside-enumeration']);

export function validateRelevanceEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return { valid: false, reason: 'relevance evidence is not an object' };
  if (evidence.status !== 'proven' && evidence.status !== 'unknown') return { valid: false, reason: 'relevance status must be proven or unknown' };
  if (!RELEVANCE_MODES.has(evidence.mode)) return { valid: false, reason: `relevance mode is not allowed: ${String(evidence.mode)}` };
  if (!Array.isArray(evidence.checks) || evidence.checks.length === 0) return { valid: false, reason: 'relevance checks must be a non-empty array' };
  if (evidence.checks.some((check) => !check || check.passed !== true)) return { valid: false, reason: 'every relevance check must pass' };
  return { valid: true };
}

function normalizedInvocation(argv) {
  if (!Array.isArray(argv)) return [];
  if (argv[0] !== 'env') return argv;
  let index = 1;
  while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index])) index += 1;
  return argv.slice(index);
}

function safeRelativeFile(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split('/').includes('..');
}

export function validatePipelineContract(contract, commandArgv, protectedWorkflowText) {
  const problems = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return { valid: false, reason: 'pipeline contract is not an object', checks: [] };
  }
  if (typeof contract.protectedRemoteUrl !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(contract.protectedRemoteUrl)) {
    problems.push('protectedRemoteUrl must be a pinned GitHub repository URL');
  }
  if (typeof contract.protectedRef !== 'string' || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(contract.protectedRef)) {
    problems.push('protectedRef must be a full branch ref');
  }
  if (!safeRelativeFile(contract.workflowPath)) problems.push('workflowPath must be a safe relative file');
  if (typeof contract.workflowJob !== 'string' || contract.workflowJob.length === 0) problems.push('workflowJob is required');
  if (typeof contract.workflowCommandPrefix !== 'string' || contract.workflowCommandPrefix.trim().length === 0) problems.push('workflowCommandPrefix is required');
  if (!Array.isArray(contract.invocationPrefix) || contract.invocationPrefix.length === 0 || contract.invocationPrefix.some((item) => typeof item !== 'string' || item.length === 0)) {
    problems.push('invocationPrefix must be a non-empty argv array');
  }
  if (!contract.observer || typeof contract.observer !== 'object' || !safeRelativeFile(contract.observer.nodeEntry)) {
    problems.push('observer.nodeEntry must be a safe relative file');
  }
  if (!Array.isArray(contract.observer?.requiredArgs) || contract.observer.requiredArgs.some((item) => typeof item !== 'string' || item.length === 0)) {
    problems.push('observer.requiredArgs must be an array of non-empty strings');
  }

  const normalized = normalizedInvocation(commandArgv);
  const invocationMatches = Array.isArray(contract.invocationPrefix)
    && contract.invocationPrefix.every((item, index) => normalized[index] === item);
  if (!invocationMatches) problems.push('adapter command does not invoke the manifest-pinned real pipeline entry');

  let workflowCommandFound = false;
  let workflowParseError = null;
  try {
    const parsed = parseYaml(protectedWorkflowText);
    const steps = parsed?.jobs?.[contract.workflowJob]?.steps;
    if (!Array.isArray(steps)) throw new Error(`workflow job ${contract.workflowJob} has no steps`);
    workflowCommandFound = steps.some((step) => typeof step?.run === 'string'
      && step.run.split('\n').some((line) => line.trim().startsWith(contract.workflowCommandPrefix)));
  } catch (error) {
    workflowParseError = error.message;
  }
  if (workflowParseError) problems.push(`protected workflow could not be parsed: ${workflowParseError}`);
  else if (!workflowCommandFound) problems.push('protected workflow job does not declare the pinned pipeline command');

  const checks = [
    { check: 'protected remote URL is instrument-pinned', passed: !problems.some((item) => item.startsWith('protectedRemoteUrl')) },
    { check: 'protected branch ref is instrument-pinned', passed: !problems.some((item) => item.startsWith('protectedRef')) },
    { check: 'adapter command invokes the pinned real entry', passed: invocationMatches },
    { check: 'protected workflow job declares the pinned command', passed: workflowCommandFound && !workflowParseError },
    { check: 'observer target is a safe exact child entry', passed: safeRelativeFile(contract.observer?.nodeEntry) },
  ];
  return { valid: problems.length === 0, reason: problems.join('; ') || null, checks, normalizedInvocation: normalized };
}

function observerSource({ realNode, cwd, guardId, nodeEntry, requiredArgs, shortCircuit }) {
  return `#!${realNode}\n`
    + `import fs from 'node:fs';\n`
    + `import path from 'node:path';\n`
    + `import { spawn } from 'node:child_process';\n`
    + `const argv = process.argv.slice(2);\n`
    + `const cwd = ${JSON.stringify(cwd)};\n`
    + `const expected = ${JSON.stringify(path.resolve(cwd, nodeEntry))};\n`
    + `const required = ${JSON.stringify(requiredArgs)};\n`
    + `const resolve = (value) => { try { return fs.realpathSync(path.resolve(cwd, value)); } catch { return path.resolve(cwd, value); } };\n`
    + `const target = argv.length > 0 && resolve(argv[0]) === resolve(expected) && required.every((item) => argv.includes(item));\n`
    + `const emit = (kind, fields = {}) => process.stdout.write('FIX_VERIFIER_OBSERVER_EVENT ' + JSON.stringify({ source: 'fix-verifier-observer', kind, guardId: ${JSON.stringify(guardId)}, nodeEntry: ${JSON.stringify(nodeEntry)}, observerPid: process.pid, argv, ...fields }) + '\\n');\n`
    + `if (target) {\n`
    + `  emit('observer-ready');\n`
    + `  process.kill(process.pid, 'SIGSTOP');\n`
    + `}\n`
    + `if (target && ${shortCircuit ? 'true' : 'false'}) {\n`
    + `  emit('short-circuit', { shortCircuitedAt: new Date().toISOString() });\n`
    + `  process.stdout.write('[fix-verifier-C3] authenticated observer short-circuited guard=' + ${JSON.stringify(guardId)} + ' entry=' + ${JSON.stringify(nodeEntry)} + '\\n');\n`
    + `  process.exit(0);\n`
    + `}\n`
    + `const startedAt = new Date().toISOString();\n`
    + `const child = spawn(${JSON.stringify(realNode)}, argv, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });\n`
    + `if (target) {\n`
    + `  try { child.kill('SIGSTOP'); } catch {}\n`
    + `  emit('child-start', { childPid: child.pid, startedAt });\n`
    + `}\n`
    + `const forward = (signal) => { try { child.kill(signal); } catch {} };\n`
    + `for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => forward(signal));\n`
    + `child.once('error', (error) => { console.error(error.message); process.exit(1); });\n`
    + `child.once('exit', (code, signal) => {\n`
    + `  const childExitCode = typeof code === 'number' ? code : null;\n`
    + `  if (target) {\n`
    + `    emit('child-exit', { childPid: child.pid, startedAt, childExitedAt: new Date().toISOString(), childExitCode, signal: signal ?? null, emittedAfterChildExit: true });\n`
    + `  }\n`
    + `  process.exit(childExitCode ?? 1);\n`
    + `});\n`;
}

async function runObservedPipelinePass({ command, cwd, guardId, contract, observerRoot, authority, shortCircuit }) {
  const label = shortCircuit ? 'c3' : 'positive';
  const root = path.join(observerRoot, label);
  fs.mkdirSync(root, { recursive: true });
  const wrapper = path.join(root, 'node');
  fs.writeFileSync(wrapper, observerSource({
    realNode: process.execPath,
    cwd,
    guardId,
    nodeEntry: contract.observer.nodeEntry,
    requiredArgs: contract.observer.requiredArgs,
    shortCircuit,
  }), { mode: 0o755 });
  const events = [];
  let observerReady = null;
  let validatedChildStart = null;
  let childExit = null;
  let shortCircuitEvent = null;
  const expectedEntry = path.resolve(cwd, contract.observer.nodeEntry);
  const continueStopped = (pid) => { try { process.kill(pid, 'SIGCONT'); } catch {} };
  const run = await streamingSpawn(command.argv, {
    cwd,
    timeoutMs: command.timeoutMs,
    env: { ...process.env, CI: '1', PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` },
  }, (event, pipelinePid) => {
    events.push(event);
    if (event?.source !== 'fix-verifier-observer' || event.guardId !== guardId || event.nodeEntry !== contract.observer.nodeEntry) {
      throw new Error('observer event identity is invalid');
    }
    if (event.kind === 'observer-ready') {
      const record = processRecord(event.observerPid);
      const argvValid = Array.isArray(event.argv)
        && event.argv.length > 0
        && (() => { try { return fs.realpathSync(path.resolve(cwd, event.argv[0])) === fs.realpathSync(expectedEntry); } catch { return false; } })()
        && contract.observer.requiredArgs.every((item) => event.argv.includes(item));
      const valid = record?.command.includes(wrapper) && descendantOf(event.observerPid, pipelinePid) && argvValid;
      observerReady = { event, valid, processRecord: record };
      continueStopped(event.observerPid);
      if (!valid) throw new Error('observer-ready process identity was not the instrument wrapper in the pipeline descendant tree');
      return;
    }
    if (event.kind === 'child-start') {
      const record = processRecord(event.childPid);
      const valid = observerReady?.valid === true
        && record?.ppid === event.observerPid
        && descendantOf(event.childPid, pipelinePid)
        && record.command.includes(contract.observer.nodeEntry)
        && Array.isArray(event.argv)
        && event.argv.length > 0;
      validatedChildStart = { event, valid, processRecord: record };
      continueStopped(event.childPid);
      if (!valid) throw new Error('observed child pid was not the exact declared descendant process');
      return;
    }
    if (event.kind === 'child-exit') childExit = event;
    if (event.kind === 'short-circuit') shortCircuitEvent = event;
  });
  const receipts = [];
  let shortCircuitReceipt = null;
  if (!shortCircuit && run.exitCode === 0 && !run.spawnError && !run.observerError
      && validatedChildStart?.valid && childExit
      && childExit.childPid === validatedChildStart.event.childPid
      && childExit.childExitCode === 0 && childExit.emittedAfterChildExit === true) {
    const receipt = await authority.issue({
      guardId, kind: 'child-exit', observerPid: childExit.observerPid,
      childPid: childExit.childPid, childExitCode: childExit.childExitCode, signal: childExit.signal,
      argv: childExit.argv, startedAt: childExit.startedAt, childExitedAt: childExit.childExitedAt,
      emittedAfterChildExit: true,
    });
    if (await authority.authenticate(receipt, { guardId, kind: 'child-exit', childPid: childExit.childPid, childExitCode: 0 })) {
      receipts.push(receipt);
      process.stdout.write(`[fix-verifier-wiring] authenticated guard=${guardId} entry=${contract.observer.nodeEntry} childPid=${childExit.childPid} childExit=0\n`);
    }
  }
  if (shortCircuit && run.exitCode === 0 && !run.spawnError && !run.observerError
      && observerReady?.valid && shortCircuitEvent?.observerPid === observerReady.event.observerPid) {
    const receipt = await authority.issue({
      guardId, kind: 'short-circuit', observerPid: shortCircuitEvent.observerPid,
      childPid: shortCircuitEvent.observerPid, childExitCode: 0, signal: null,
      argv: [wrapper, ...shortCircuitEvent.argv], startedAt: shortCircuitEvent.shortCircuitedAt,
      childExitedAt: run.endedAt, emittedAfterChildExit: true,
    });
    if (await authority.authenticate(receipt, { guardId, kind: 'short-circuit', childPid: shortCircuitEvent.observerPid })) {
      shortCircuitReceipt = receipt;
    }
  }
  return {
    run,
    observer: { wrapper, nodeEntry: contract.observer.nodeEntry, requiredArgs: contract.observer.requiredArgs },
    receipts,
    shortCircuitEvents: shortCircuitEvent ? [shortCircuitEvent] : [],
    shortCircuitReceipt,
    processObservations: { observerReady, validatedChildStart, childExit, eventCount: events.length },
  };
}

export async function runPipelineWiringControls({ command, cwd, guardId, contract, observerRoot }) {
  const authority = await createAuthenticatedReceiptAuthority({ issuer: `fix-verifier:${guardId}` });
  let positive;
  let C3;
  try {
    positive = await runObservedPipelinePass({ command, cwd, guardId, contract, observerRoot, authority, shortCircuit: false });
    C3 = await runObservedPipelinePass({ command, cwd, guardId, contract, observerRoot, authority, shortCircuit: true });
  } finally {
    await authority.close();
  }
  const receipt = positive.receipts.length === 1 ? positive.receipts[0] : null;
  const positiveReceiptValid = isLiveAuthenticatedReceipt(receipt)
    && receipt.guardId === guardId
    && receipt.kind === 'child-exit'
    && receipt.childExitCode === 0
    && receipt.emittedAfterChildExit === true;
  const c3Event = C3.shortCircuitEvents.length === 1 ? C3.shortCircuitEvents[0] : null;
  const c3Valid = C3.run.exitCode === 0 && !C3.run.spawnError && C3.receipts.length === 0
    && isLiveAuthenticatedReceipt(C3.shortCircuitReceipt)
    && c3Event?.source === 'fix-verifier-observer'
    && c3Event.guardId === guardId
    && c3Event.nodeEntry === contract.observer.nodeEntry;
  C3.outcome = c3Valid
    ? 'proven'
    : !c3Event || !C3.shortCircuitReceipt || C3.run.exitCode === null || C3.run.spawnError || C3.run.exitCode !== 0
      ? 'unknown'
      : 'not-proven';
  const checks = [
    { check: 'real declared pipeline wrapper exited successfully', passed: positive.run.exitCode === 0 && !positive.run.spawnError },
    { check: 'private-channel authority authenticated exactly one post-child receipt', passed: positiveReceiptValid },
    { check: 'C3 wrapper still exited successfully', passed: C3.run.exitCode === 0 && !C3.run.spawnError },
    { check: 'C3 authenticated the instrument observer short-circuit', passed: Boolean(c3Event) && isLiveAuthenticatedReceipt(C3.shortCircuitReceipt) },
    { check: 'C3 produced no guard execution receipt', passed: C3.receipts.length === 0 },
  ];
  const status = checks.every((item) => item.passed) ? 'proven' : 'unknown';
  return {
    authorityId: receipt?.authorityId ?? C3.shortCircuitReceipt?.authorityId ?? null,
    positive,
    C3,
    envelope: {
      source: 'fix-verifier-core',
      status,
      mode: 'core-private-channel-hmac-receipt',
      authorityId: receipt?.authorityId ?? null,
      receipt,
      C3: {
        outcome: C3.outcome,
        receiptCount: C3.receipts.length,
        shortCircuitEvent: c3Event,
        shortCircuitReceipt: C3.shortCircuitReceipt,
      },
      checks,
    },
  };
}

const PIPELINE_MODES = new Set(['core-private-channel-hmac-receipt']);
export function validatePipelineEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return { valid: false, reason: 'pipeline evidence is not an object' };
  if (evidence.source !== 'fix-verifier-core' || evidence.status !== 'proven' || !PIPELINE_MODES.has(evidence.mode)) return { valid: false, reason: 'pipeline evidence is not a core-minted proven envelope' };
  if (!isLiveAuthenticatedReceipt(evidence.receipt) || evidence.receipt?.emittedAfterChildExit !== true) {
    return { valid: false, reason: 'pipeline receipt was not authenticated live by the private-channel authority' };
  }
  if (evidence.C3?.outcome !== 'proven' || evidence.C3?.receiptCount !== 0
      || !evidence.C3?.shortCircuitEvent || !isLiveAuthenticatedReceipt(evidence.C3?.shortCircuitReceipt)) {
    return { valid: false, reason: 'C3 did not authenticate wrapper success without a guard receipt' };
  }
  if (!Array.isArray(evidence.checks) || evidence.checks.length === 0 || evidence.checks.some((check) => !check || check.passed !== true)) {
    return { valid: false, reason: 'pipeline checks must be non-empty and all pass' };
  }
  return { valid: true };
}

async function measure(args) {
  const manifestPath = fs.realpathSync(path.resolve(args.manifest));
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const adapterRegistry = validateManifestObject(manifest, manifestPath);
  const guard = manifest.adapters.find((item) => item.id === args.guard);
  if (!guard) throw new Error(`guard ${args.guard} has no entry in the checked adapter registry`);

  const adapterPath = path.resolve(path.dirname(manifestPath), guard.adapter);
  const adapter = await import(`${pathToFileURL(adapterPath).href}?v=${sha256(fs.readFileSync(adapterPath)).slice(0, 12)}`);
  if (!Array.isArray(adapter.mutations) || adapter.mutations.length === 0) throw new Error('adapter mutation population is empty (0/0 is an error)');
  for (const property of PROPERTY_IDS) {
    if (!adapter.mutations.some((mutation) => mutation.property === property)) throw new Error(`adapter has no ${property} mutation`);
  }
  if (!Array.isArray(adapter.pipelineCommands) || adapter.pipelineCommands.length === 0) throw new Error('adapter pipeline command population is empty');
  if (!Array.isArray(adapter.guardCommands) || adapter.guardCommands.length === 0) throw new Error('adapter guard command population is empty');

  const inputRepo = fs.realpathSync(path.resolve(args.repo));
  const targetRoot = fs.realpathSync(gitText(inputRepo, ['rev-parse', '--show-toplevel']));
  const resolvedCommit = gitText(targetRoot, ['rev-parse', `${args.commit}^{commit}`]);
  const targetStatusBefore = gitText(targetRoot, ['status', '--porcelain=v1']);
  const targetRemote = (() => {
    for (const name of ['upstream', 'origin']) {
      const run = directSpawn(['git', 'remote', 'get-url', name], { cwd: targetRoot });
      if (run.exitCode === 0) return { name, url: run.stdout.text.trim() };
    }
    return { name: null, url: null };
  })();

  const existenceRows = [...new Set([...guard.guardFiles, ...guard.subjectFiles])].map((rel) => {
    const run = directSpawn(['git', 'cat-file', '-e', `${resolvedCommit}:${rel}`], { cwd: targetRoot });
    return { path: rel, existsAtCommit: run.exitCode === 0, exitCode: run.exitCode, stderr: run.stderr };
  });
  const exists = existenceRows.every((item) => item.existsAtCommit);
  if (!exists) throw new Error(`guard/subject path absent at target commit: ${existenceRows.filter((item) => !item.existsAtCommit).map((item) => item.path).join(', ')}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fix-verifier-'));
  const copies = [];
  let dependencyEvidence;
  let nodeModulesPath;
  let isolationSource;
  let protectedBaseEvidence = null;
  let pipelineContractValidation = { valid: false, reason: 'guard has no structured pipeline contract', checks: [] };

  const cloneCase = (label, attachDependencies = true, workspaceKind = 'guard') => {
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, '-');
    const root = path.join(tempRoot, `${String(copies.length + 1).padStart(2, '0')}-${safe}`);
    requireSuccess(['git', 'clone', '--shared', '--no-checkout', '--quiet', isolationSource, root], { cwd: tempRoot, timeoutMs: 120_000 });
    requireSuccess(['git', 'checkout', '--detach', '--quiet', resolvedCommit], { cwd: root, timeoutMs: 120_000 });
    const actual = gitText(root, ['rev-parse', 'HEAD']);
    if (actual !== resolvedCommit) throw new Error(`isolated clone commit mismatch: ${actual} != ${resolvedCommit}`);
    if (protectedBaseEvidence?.commit) {
      for (const ref of ['refs/remotes/origin/main', 'refs/remotes/upstream/main', 'refs/heads/main']) {
        requireSuccess(['git', 'update-ref', ref, protectedBaseEvidence.commit], { cwd: root });
      }
      const mergeBase = gitText(root, ['merge-base', protectedBaseEvidence.commit, resolvedCommit]);
      if (!mergeBase) throw new Error('isolated clone has no merge base with the protected branch');
    }
    if (attachDependencies) {
      const destination = path.join(root, 'node_modules');
      fs.symlinkSync(nodeModulesPath, destination, 'dir');
      if (workspaceKind === 'pipeline' && typeof adapter.preparePipelineWorkspace === 'function') adapter.preparePipelineWorkspace(root, protectedBaseEvidence);
      else if (typeof adapter.prepareWorkspace === 'function') adapter.prepareWorkspace(root, protectedBaseEvidence);
    }
    copies.push({ label, root, commit: actual });
    return root;
  };

  try {
    isolationSource = path.join(tempRoot, '00-isolation-source');
    requireSuccess(['git', 'clone', '--shared', '--no-checkout', '--quiet', targetRoot, isolationSource], { cwd: tempRoot, timeoutMs: 120_000 });
    if (guard.pipeline) {
      const remote = directSpawn(['git', 'ls-remote', guard.pipeline.protectedRemoteUrl, guard.pipeline.protectedRef], { cwd: isolationSource, timeoutMs: 120_000 });
      const line = remote.stdout.text.trim().split('\n').find((item) => item.endsWith(`\t${guard.pipeline.protectedRef}`));
      const serverCommit = line?.split(/\s+/)[0] ?? null;
      if (remote.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(serverCommit ?? '')) {
        throw new Error(`could not resolve protected base from server: ${remote.stderr.text || remote.stdout.text}`);
      }
      requireSuccess([
        'git', 'fetch', '--quiet', '--no-tags', guard.pipeline.protectedRemoteUrl,
        `${guard.pipeline.protectedRef}:refs/fix-verifier/protected-base`,
      ], { cwd: isolationSource, timeoutMs: 120_000 });
      const fetchedCommit = gitText(isolationSource, ['rev-parse', 'refs/fix-verifier/protected-base^{commit}']);
      if (fetchedCommit !== serverCommit) throw new Error(`protected-base fetch mismatch: ${fetchedCommit} != ${serverCommit}`);
      const protectedWorkflowText = gitText(isolationSource, ['show', `${fetchedCommit}:${guard.pipeline.workflowPath}`]);
      const pipelineCommand = adapter.pipelineCommands[guard.pipeline.commandIndex ?? 0];
      if (!pipelineCommand) throw new Error('pipeline contract selects a missing adapter command');
      pipelineContractValidation = validatePipelineContract(guard.pipeline, pipelineCommand.argv, protectedWorkflowText);
      if (!pipelineContractValidation.valid) throw new Error(`invalid protected pipeline contract: ${pipelineContractValidation.reason}`);
      requireSuccess(['git', 'update-ref', 'refs/remotes/origin/main', fetchedCommit], { cwd: isolationSource });
      requireSuccess(['git', 'update-ref', 'refs/remotes/upstream/main', fetchedCommit], { cwd: isolationSource });
      requireSuccess(['git', 'update-ref', 'refs/heads/main', fetchedCommit], { cwd: isolationSource });
      const mergeBase = gitText(isolationSource, ['merge-base', fetchedCommit, resolvedCommit]);
      if (!mergeBase) throw new Error('candidate has no merge base with the server-resolved protected branch');
      protectedBaseEvidence = {
        remoteUrl: guard.pipeline.protectedRemoteUrl,
        ref: guard.pipeline.protectedRef,
        commit: fetchedCommit,
        serverResolved: true,
        fetchMatchesServer: true,
        workflowPath: guard.pipeline.workflowPath,
        workflowSha256: sha256(protectedWorkflowText),
        mergeBase,
      };
    }

    if (args.nodeModules) {
      nodeModulesPath = fs.realpathSync(path.resolve(args.nodeModules));
      if (!fs.statSync(nodeModulesPath).isDirectory()) throw new Error('--node-modules must name a directory');
      dependencyEvidence = { mode: 'provided', path: nodeModulesPath, prepared: true };
    } else {
      const seed = cloneCase('dependency-seed', false);
      const prepare = directSpawn(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: seed, timeoutMs: 300_000 });
      dependencyEvidence = { mode: 'npm-ci-isolated-seed', run: prepare, prepared: prepare.exitCode === 0 && !prepare.spawnError };
      if (!dependencyEvidence.prepared) throw new Error(`dependency preparation failed: ${prepare.stderr.text || prepare.stdout.text}`);
      nodeModulesPath = fs.realpathSync(path.join(seed, 'node_modules'));
    }

    const fixtureEvidence = [];
    const applyFixture = (root) => {
      if (args.fixture === 'none') return null;
      if (typeof adapter.applyDeliberatelyHollowGuard !== 'function') throw new Error('adapter does not implement deliberately-hollow-guard fixture');
      const before = snapshotPaths(root, guard.guardFiles);
      const fixture = adapter.applyDeliberatelyHollowGuard(root);
      const after = snapshotPaths(root, fixture.paths);
      const verification = fixture.verify();
      const changedPaths = changedSnapshotPaths(before, after);
      const evidence = { root, before, after, changedPaths, verification, applied: verification.ok && changedPaths.length > 0 };
      fixtureEvidence.push(evidence);
      if (!evidence.applied) throw new Error('deliberately hollow guard fixture could not be verified');
      return evidence;
    };

    const wiringRoot = cloneCase('pipeline-wiring', true, 'pipeline');
    applyFixture(wiringRoot);
    const selectedPipelineCommand = guard.pipeline ? adapter.pipelineCommands[guard.pipeline.commandIndex ?? 0] : null;
    const wiringRun = selectedPipelineCommand && pipelineContractValidation.valid
      ? await runPipelineWiringControls({
          command: selectedPipelineCommand,
          cwd: wiringRoot,
          guardId: guard.id,
          contract: guard.pipeline,
          observerRoot: path.join(tempRoot, 'pipeline-observer'),
        })
      : null;
    const rawPipelineEvidence = wiringRun?.envelope;
    const pipelineValidation = validatePipelineEvidence(rawPipelineEvidence);
    const wired = pipelineContractValidation.valid && pipelineValidation.valid;
    const wiringOutcome = wired
      ? 'proven'
      : !wiringRun
        || wiringRun.positive.receipts.length === 0 && wiringRun.positive.run.exitCode !== 0
        || wiringRun.positive.run.exitCode === null
        || wiringRun.positive.run.spawnError
        ? 'unknown'
        : 'not-proven';

    let positiveRun = null;
    let positiveControlPassed = false;
    const mutationEvidence = [];
    if (!args.wiringOnly) {
      const positiveRoot = cloneCase('positive-control');
      applyFixture(positiveRoot);
      positiveRun = runGuardCommands(adapter.guardCommands, positiveRoot);
      positiveControlPassed = positiveRun.outcome === 'pass';

      for (const mutation of adapter.mutations) {
        const root = cloneCase(mutation.id);
        applyFixture(root);
        const before = snapshotPaths(root, mutation.paths);
        let applyError = null;
        let verification = { ok: false, checks: [] };
        if (shouldForce(args.forceMutationFailure, mutation)) {
          applyError = `forced mutation failure for ${mutation.id}`;
        } else {
          try {
            mutation.apply(root);
            verification = mutation.verify(root);
          } catch (error) {
            applyError = error.message;
          }
        }
        const after = snapshotPaths(root, mutation.paths);
        const changedPaths = changedSnapshotPaths(before, after);
        const gitStatusRun = directSpawn(['git', 'status', '--porcelain=v1'], { cwd: root });
        const rootIsIsolated = root.startsWith(`${tempRoot}${path.sep}`) && root !== targetRoot;
        const mutationApplied = !applyError && verification.ok === true && changedPaths.length > 0 && rootIsIsolated;
        const rawRelevanceEvidence = mutationApplied && typeof adapter.verifyMutationRelevant === 'function'
          ? adapter.verifyMutationRelevant({ root, mutation, changedPaths, guard, guardFiles: guard.guardFiles, subjectFiles: guard.subjectFiles })
          : { status: 'unknown', mode: 'declared-load-bearing-input', checks: [{ check: 'adapter supplied structured relevance evidence', passed: false }] };
        const relevanceValidation = validateRelevanceEvidence(rawRelevanceEvidence);
        const relevanceEvidence = relevanceValidation.valid
          ? rawRelevanceEvidence
          : { ...rawRelevanceEvidence, status: 'unknown', rejected: true, rejectionReason: relevanceValidation.reason };
        const mutationRelevant = mutationApplied && relevanceValidation.valid && relevanceEvidence.status === 'proven';
        let guardRun = null;
        let guardOutcome = 'unknown';
        if (mutationApplied && mutationRelevant) {
          guardRun = runGuardCommands(adapter.guardCommands, root);
          guardOutcome = guardRun.outcome;
        }
        mutationEvidence.push({
          id: mutation.id,
          property: mutation.property,
          label: mutation.label,
          violationClass: mutation.violationClass,
          isolatedRoot: root,
          rootIsIsolated,
          applyError,
          mutationApplied,
          mutationRelevant,
          relevanceEvidence,
          proof: { before, after, changedPaths, adapterVerification: verification, gitStatus: gitStatusRun },
          guardOutcome,
          guardRun,
        });
      }
    }

    const properties = args.wiringOnly
      ? Object.fromEntries(PROPERTY_IDS.map((property) => [property, { outcome: 'unknown', mutations: [] }]))
      : summarizeProperties(mutationEvidence, positiveControlPassed);
    const effectiveAgainst = args.wiringOnly ? [] : effectiveClasses(mutationEvidence, properties, positiveControlPassed);
    const rung = args.wiringOnly ? (exists && wired ? 'wired' : exists ? 'exists' : 'not-proven') : deriveRung({ exists, wired, positiveControlPassed, properties });
    const targetStatusAfter = gitText(targetRoot, ['status', '--porcelain=v1']);
    const targetUntouched = targetStatusBefore === targetStatusAfter;
    if (!targetUntouched) throw new Error('target working-tree porcelain changed during isolated measurement');

    return {
      schemaVersion: 1,
      measuredAt: isoNow(),
      instrument: {
        path: SCRIPT_PATH,
        sha256: sha256(fs.readFileSync(SCRIPT_PATH)),
        manifest: { path: manifestPath, sha256: sha256(manifestBytes), adapterRegistryChecked: true, ...adapterRegistry },
        adapter: { path: adapterPath, sha256: sha256(fs.readFileSync(adapterPath)) },
      },
      guardId: guard.id,
      description: guard.description,
      fixture: args.fixture,
      measurementScope: args.wiringOnly ? 'wiring-only' : 'full-property-and-wiring',
      target: {
        tree: targetRoot,
        requestedCommit: args.commit,
        commit: resolvedCommit,
        remote: targetRemote,
        dirtyAtStart: targetStatusBefore.length > 0,
        porcelainAtStart: targetStatusBefore.split('\n').filter(Boolean),
      },
      adapterRegistry: {
        source: manifestPath,
        sourceSha256: sha256(manifestBytes),
        schemaChecked: true,
        semanticRole: 'list of implemented adapters; never a guard census or coverage denominator',
        nonEmpty: adapterRegistry.count > 0,
        adaptedGuardCount: adapterRegistry.count,
        ids: adapterRegistry.ids,
      },
      coverageAggregate: {
        emitted: false,
        ratio: null,
        denominator: null,
        notMeasured: null,
        reason: 'this command verifies one requested guard; adapter registration is not the real guard census',
      },
      existence: { outcome: exists ? 'proven' : 'not-proven', files: existenceRows },
      wiring: {
        outcome: wiringOutcome,
        declaredEntryPoint: guard.pipelineEntryPoint,
        establishedBy: wired
          ? 'core-minted token received from the exact manifest-pinned guard child after it exited through the protected workflow command; C3 wrapper success produced no receipt'
          : 'no valid core-minted post-child receipt relationship was established',
        protectedBase: protectedBaseEvidence,
        contract: pipelineContractValidation,
        pipelineEvidence: pipelineValidation.valid ? rawPipelineEvidence : { status: 'unknown', rejected: true, rejectionReason: pipelineValidation.reason },
        run: wiringRun,
      },
      controls: {
        C1: args.wiringOnly
          ? { outcome: wired ? 'proven' : wiringOutcome, required: 'untouched guard passes through the real protected-workflow entry and emits the post-child receipt', run: wiringRun?.positive ?? null }
          : { outcome: positiveControlPassed ? 'proven' : positiveRun.outcome === 'unknown' ? 'unknown' : 'not-proven', required: 'pristine guard passes', run: positiveRun },
        C2: args.wiringOnly
          ? {
              outcome: wiringRun?.C3?.outcome === 'proven' ? 'proven' : 'unknown',
              required: 'the C3 short-circuit is independently recorded against the exact observed child before its result is interpreted',
              perMutation: { 'C3-exact-child-short-circuit': wiringRun?.C3?.outcome === 'proven' ? 'proven' : 'unknown' },
            }
          : {
              outcome: mutationEvidence.every((item) => item.mutationApplied && item.mutationRelevant) ? 'proven' : 'unknown',
              required: 'every mutation is verified applied before guard output is interpreted',
              perMutation: Object.fromEntries(mutationEvidence.map((item) => [item.id, item.mutationApplied && item.mutationRelevant ? 'proven' : 'unknown'])),
            },
        C3: {
          outcome: wiringRun?.C3?.outcome ?? 'unknown',
          required: 'the real wrapper succeeds while the exact guard child is skipped, and no execution receipt exists',
          run: wiringRun?.C3 ?? null,
        },
      },
      properties,
      effectiveAgainst,
      rung,
      mutations: mutationEvidence,
      isolation: {
        method: 'throwaway clones from an isolation seed; server-resolved protected base installed as origin/main, upstream/main, and main; dependency-only node_modules symlink',
        tempRoot,
        copies,
        fixtureEvidence,
        protectedBase: protectedBaseEvidence,
        targetPorcelainUnchanged: targetUntouched,
        cleanup: args.keepTemp ? 'retained by explicit --keep-temp' : 'removed before record emission',
      },
      dependencies: dependencyEvidence,
    };
  } finally {
    if (!args.keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function fatalRecord(args, error) {
  return {
    schemaVersion: 1,
    measuredAt: isoNow(),
    guardId: args?.guard ?? null,
    target: { tree: args?.repo ?? null, requestedCommit: args?.commit ?? null, commit: null },
    rung: 'not-proven',
    properties: Object.fromEntries(PROPERTY_IDS.map((property) => [property, { outcome: 'unknown', mutations: [] }])),
    effectiveAgainst: [],
    fatal: { name: error.name, message: error.message, stack: clip(error.stack ?? '').text },
  };
}

async function main() {
  let args;
  let record;
  let exitCode;
  try {
    args = parseArgs(process.argv.slice(2));
    record = await measure(args);
    const unknown = Object.values(record.properties).some((item) => item.outcome === 'unknown');
    exitCode = args.wiringOnly
      ? record.wiring?.outcome === 'proven' && record.controls?.C3?.outcome === 'proven' ? 0 : record.wiring?.outcome === 'unknown' ? 2 : 1
      : record.rung === 'effective' ? 0 : unknown ? 2 : 1;
  } catch (error) {
    record = fatalRecord(args, error);
    exitCode = 2;
  }
  if (args?.output) writeJsonAtomic(args.output, record);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  process.exit(exitCode);
}

const IS_MAIN = process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT_PATH);
if (IS_MAIN) main();

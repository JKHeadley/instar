/**
 * job-launch-intent-record — regressions for the second-pass code review (Fable 5.2 + GPT 6 Astra).
 * Not part of the frozen acceptance set; each case pins one review finding:
 *   1. an operator-set thinkingMode on an installed built-in manifest survives reinstall;
 *   2. a bare command name on PATH gets a cache key, so its version is cached;
 *   3. legacy `execute.type: script` rows (no `runner`) are not main-path runs for graduation;
 *   4. a failed probe never downgrades a known cliVersion on the run row;
 *   5. a confined spawn (`/usr/bin/env -i`) corroborates env against the allowlist pairs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';
import { createCliVersionReader } from '../../src/core/cliVersionReader.js';
import { evaluateLaunchMechanismGraduation } from '../../src/scheduler/launchIntentEvidence.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { SessionManager } from '../../src/core/SessionManager.js';

describe('review fix 1: built-in thinkingMode survives reinstall', () => {
  let workspace: string;
  let stateDir: string;
  let packageRoot: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'job-launch-fix1-'));
    stateDir = path.join(workspace, 'agent', '.instar');
    packageRoot = path.join(workspace, 'pkg');
    const templatesDir = path.join(packageRoot, 'src', 'scaffold', 'templates', 'jobs', 'instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, 'fix1-builtin.md'),
      '---\nname: fix1-builtin\ndescription: d\nschedule: "*/5 * * * *"\npriority: low\nexpectedDurationMinutes: 1\nmodel: haiku\nenabled: true\ntoolAllowlist: "*"\nunrestrictedTools: true\n---\nbody\n');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'tests/unit/job-launch-review-fixes.test.ts:cleanup' }));

  const manifestPath = () => path.join(stateDir, 'jobs', 'schedule', 'fix1-builtin.json');

  it('keeps an operator-set value and ignores an out-of-enum one', () => {
    expect(installBuiltinJobs({ agentStateDir: stateDir, packageRoot, port: 4042 }).errors).toEqual([]);
    const m = JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
    expect(m.thinkingMode).toBeUndefined();
    fs.writeFileSync(manifestPath(), JSON.stringify({ ...m, thinkingMode: 'low' }, null, 2));
    expect(installBuiltinJobs({ agentStateDir: stateDir, packageRoot, port: 4042 }).errors).toEqual([]);
    expect(JSON.parse(fs.readFileSync(manifestPath(), 'utf-8')).thinkingMode).toBe('low');

    fs.writeFileSync(manifestPath(), JSON.stringify({ ...m, thinkingMode: 'banana' }, null, 2));
    expect(installBuiltinJobs({ agentStateDir: stateDir, packageRoot, port: 4042 }).errors).toEqual([]);
    expect(JSON.parse(fs.readFileSync(manifestPath(), 'utf-8')).thinkingMode).toBeUndefined();
  });
});

describe('review fix 2: a bare PATH command gets a cached version', () => {
  const origPath = process.env.PATH;
  afterEach(() => { process.env.PATH = origPath; });

  it('resolves `codex` on PATH, caches the probe, and does not probe again', async () => {
    process.env.PATH = ['/nope', '/opt/tools/bin'].join(path.delimiter);
    const files: Record<string, { size: number; mtimeMs: number }> = { '/opt/tools/bin/codex': { size: 7, mtimeMs: 3 } };
    const execFile = vi.fn(async () => ({ stdout: 'codex-cli 0.99.1\n' }));
    const reader = createCliVersionReader({
      execFile,
      stat: (p) => files[p],
      realpath: (p) => {
        if (!p.startsWith('/')) throw new Error('ENOENT');
        return p;
      },
      now: () => 1_000,
    });
    expect(reader.cached('codex')).toBe('unknown');
    expect(await reader.probe('codex')).toBe('0.99.1');
    expect(reader.cached('codex')).toBe('0.99.1');
    expect(await reader.probe('codex')).toBe('0.99.1');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('skips a non-executable PATH entry, as execution does, and keys the executable one', async () => {
    process.env.PATH = ['/first/bin', '/second/bin'].join(path.delimiter);
    const files: Record<string, { size: number; mtimeMs: number }> = {
      '/first/bin/codex': { size: 1, mtimeMs: 1 },
      '/second/bin/codex': { size: 9, mtimeMs: 9 },
    };
    const keyed: string[] = [];
    const reader = createCliVersionReader({
      execFile: async () => ({ stdout: 'codex-cli 0.99.2\n' }),
      stat: (p) => files[p],
      realpath: (p) => { keyed.push(p); return p; },
      isExecutable: (p) => p.startsWith('/second/'),
      now: () => 1_000,
    });
    expect(await reader.probe('codex')).toBe('0.99.2');
    expect(keyed.every((p) => p === '/second/bin/codex')).toBe(true);
    expect(reader.cached('codex')).toBe('0.99.2');
  });
});

describe('review fix 3: legacy script rows are not main-path runs', () => {
  it('a row from runScriptJob (sessionId script-*, no runner) needs no launch record', () => {
    const verdict = evaluateLaunchMechanismGraduation(
      [{ runId: 'r1', slug: 'j', sessionId: 'script-j-abc', result: 'success' }],
      { jobSlug: 'j', expectedValue: 'low', minRuns: 1, evidence: [] },
    );
    expect(verdict.reasons.join(' ')).not.toMatch(/has no launch record/);
  });

  it('a main-path job row without a launch is still a violation', () => {
    const verdict = evaluateLaunchMechanismGraduation(
      [{ runId: 'r2', slug: 'j', sessionId: 'job-j-abc', result: 'success' }],
      { jobSlug: 'j', expectedValue: 'low', minRuns: 1, evidence: [] },
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join(' ')).toMatch(/has no launch record/);
  });
});

describe('review fix 4: a failed probe never downgrades a known version', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-launch-fix4-'));
    fs.mkdirSync(path.join(dir, 'ledger'), { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-launch-review-fixes.test.ts:cleanup' }));

  it('keeps 2.1.322 when the later probe returns unknown, and still upgrades unknown → known', () => {
    const h = new JobRunHistory(dir);
    const launch = (v: string) => ({ cliVersion: v, requested: {}, applied: [], dropped: [] });
    const known = h.recordStart({ slug: 'j', sessionId: 's1', trigger: 'scheduled', launch: launch('2.1.322') } as never);
    h.recordLaunchVersion(known, 'unknown');
    expect((h.findRun(known) as unknown as { launch: { cliVersion: string } }).launch.cliVersion).toBe('2.1.322');
    const pending = h.recordStart({ slug: 'j', sessionId: 's2', trigger: 'scheduled', launch: launch('unknown') } as never);
    h.recordLaunchVersion(pending, '2.1.322');
    expect((h.findRun(pending) as unknown as { launch: { cliVersion: string } }).launch.cliVersion).toBe('2.1.322');
  });
});

describe('review fix 5: confined spawn env corroboration', () => {
  type Capture = (sink: { launch?: unknown }, bin: string, outcome: unknown, mode: unknown, args: string[]) => string[];
  const fakeThis = { cliVersionReader: { cached: () => 'unknown' }, launchBinaries: new Map() };
  const capture = (SessionManager.prototype as unknown as { captureLaunchRecord: Capture }).captureLaunchRecord.bind(fakeThis);
  const offOutcome = {
    applied: [{ feature: 'thinkingMode', requestedValue: 'off', value: 'MAX_THINKING_TOKENS=0', channel: 'env' }],
    dropped: [],
  };

  it('a -e flag that env -i wipes does not corroborate: no record is written', () => {
    const sink: { launch?: unknown } = {};
    capture(sink, '/bin/claude', offOutcome, 'off', [
      'new-session', '-d', '-e', 'MAX_THINKING_TOKENS=0', '-e', 'INSTAR_SESSION_ID=x',
      '/usr/bin/env', '-i', 'PATH=/usr/bin', 'INSTAR_SESSION_ID=x', '/bin/claude', '-p', 'hi',
    ]);
    expect(sink.launch).toBeUndefined();
  });

  it('a pair carried inside env -i corroborates', () => {
    const sink: { launch?: unknown } = {};
    capture(sink, '/bin/claude', offOutcome, 'off', [
      'new-session', '-d', '/usr/bin/env', '-i', 'PATH=/usr/bin', 'MAX_THINKING_TOKENS=0', '/bin/claude', '-p', 'hi',
    ]);
    expect(sink.launch).toBeDefined();
  });

  it('an unconfined spawn still corroborates against the -e flags', () => {
    const sink: { launch?: unknown } = {};
    capture(sink, '/bin/claude', offOutcome, 'off', ['new-session', '-d', '-e', 'MAX_THINKING_TOKENS=0', '/bin/claude', '-p', 'hi']);
    expect(sink.launch).toBeDefined();
  });
});

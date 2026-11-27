import { FailureEvidence } from '../../../src/localVerify/failureEvidence.js';
// safe-git-allow: test fixture setup — builds a throwaway repo for the directory-rename regression.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
/**
 * Tier-1 tests for the local-verify run orchestrator (spec
 * local-verify-merge-authority.md §2 Run steps 1–5 and 8) with fake seams:
 * the git / process / fs / clock / holders seams are in-memory, so every
 * branch (happy path, conflict, each deadline, dirty tree, harness read
 * failure, single flight) is exercised without spawning anything.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {
  runVerify, verifyPaths, splitScript, parseNameStatus, bareConfigTemplate,
  type OrchestratorSeams, type VerifyRunInput, type VerifyRunResult, type GitResult, type ExecResult,
} from '../../../src/localVerify/orchestrator.js';
import { parseVitestJson } from '../../../src/localVerify/laneReport.js';
import { BORROWED_CANARY, BORROWED_CANARY_FILES } from '../../../src/localVerify/borrowedCanary.js';
import { LOCAL_VERIFY_DEADLINES, LOCAL_VERIFY_LIMITS } from '../../../src/localVerify/policy.js';

/** Lane processes in one verify: unit + the integration shards + the e2e shards. */
const LANE_PROCS = 1 + LOCAL_VERIFY_LIMITS.integrationShards + LOCAL_VERIFY_LIMITS.e2eShards;
const E2E_N = LOCAL_VERIFY_LIMITS.e2eShards;
/** An e2e lane process (its config), whatever the shard. */
const isE2e = (args: string[]) => args.includes('vitest.e2e.config.ts');
import { artifactSha256 } from '../../../scripts/lib/instar-dev-trace.mjs';

const HOME = '/agents/echo';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MB = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const COMMIT = 'e'.repeat(40);
const MIN = 60_000;
const P = verifyPaths(HOME, HEAD);

const TEST_FILES = ['tests/unit/a.test.ts', 'tests/integration/b.test.ts', 'tests/e2e/c.test.ts'];
const PKG = JSON.stringify({
  name: 'instar',
  scripts: { build: 'tsc && node scripts/gen.mjs', lint: 'tsc --noEmit && node scripts/lint-a.js' },
  devDependencies: { vitest: '^2.1.9' },
});
const UNIT_SRC = `import { it } from 'vitest'; it('a', () => {});`;

function vitestReport(rel: string, statuses: string[], msg = 'boom'): string {
  return vitestReportMany({ [rel]: statuses }, msg);
}
function vitestReportMany(byFile: Record<string, string[]>, msg = 'boom'): string {
  return JSON.stringify({
    testResults: Object.entries(byFile).map(([rel, statuses]) => ({
      name: path.join(P.runDir, rel), status: statuses.includes('failed') ? 'failed' : 'passed', message: '',
      startTime: 0, endTime: 1,
      assertionResults: statuses.map((s, i) => ({ status: s, title: `t${i}`, fullName: `t${i}`, ancestorTitles: [], failureMessages: s === 'failed' ? [msg] : [], meta: {} })),
    })),
  });
}

/** A named test in a fake report (spec local-verify-import-related-rerun.md). */
interface NamedTest { name: string; status: string; msg?: string }
function namedReport(byFile: Record<string, NamedTest[] | { tests: NamedTest[]; message?: string; status?: 'passed' | 'failed' }>): string {
  return JSON.stringify({
    testResults: Object.entries(byFile).map(([rel, v]) => {
      const tests = Array.isArray(v) ? v : v.tests;
      const message = Array.isArray(v) ? '' : v.message ?? '';
      const status = (!Array.isArray(v) && v.status) || (tests.some((t) => t.status === 'failed') || message ? 'failed' : 'passed');
      return {
        name: path.join(P.runDir, rel), status, message, startTime: 0, endTime: 1,
        assertionResults: tests.map((t) => ({ status: t.status, title: t.name, fullName: t.name, ancestorTitles: [], failureMessages: t.status === 'failed' ? [t.msg ?? 'boom'] : [], meta: {} })),
      };
    }),
  });
}

interface FakeOpts {
  /** A lane whose files report NAMED tests (replaces the lane's single file, like `laneFiles`). */
  laneNamed?: Partial<Record<'unit' | 'integration' | 'e2e', Record<string, NamedTest[] | { tests: NamedTest[]; message?: string; status?: 'passed' | 'failed' }>>>;
  /** Named solo-run reports per file: one list per run, the last one repeated. */
  rerunNamed?: Record<string, NamedTest[][]>;
  /** Extra test files in the merge tree (reported by a test's own exec override). */
  extraTree?: string[];
  /** Per-step durations (ms) for exec steps, by step key: npm-ci, build, lint, unit, integration, e2e. */
  durations?: Partial<Record<string, number>>;
  gitTimeout?: string; // a git verb that times out
  gitDurations?: Partial<Record<string, number>>;
  mergeTreeStatus?: number;
  npmCiStatus?: number;
  lintStatus?: number;
  laneStatuses?: Partial<Record<'unit' | 'integration' | 'e2e', string[]>>;
  porcelain?: string;
  diff?: string;
  /** rev:path → text; a missing key makes `show` fail. */
  shows?: Record<string, string>;
  /** Holders seen before each lane, consumed in order of calls. */
  holders?: Array<number[]>;
  /** A lane with several files: file → statuses of its first run (replaces the lane's single file). */
  laneFiles?: Partial<Record<'unit' | 'integration' | 'e2e', Record<string, string[]>>>;
  /** Isolation re-run outcome per file (default passes); 'deadline' = the re-run hits its deadline. */
  rerun?: Record<string, string[] | 'deadline'>;
  /** Duration of each isolation re-run (default 1000 ms). */
  rerunMs?: number;
  /** Unhandled errors the trusted reporter records per lane run (default 0). */
  unhandled?: Partial<Record<'unit' | 'integration' | 'e2e', number>>;
  /** Unhandled errors in an isolation re-run (default 0). */
  rerunUnhandled?: number;
  /** No trusted reporter available (unknown unhandled count). */
  noReporter?: boolean;
  /** Relative import graph per test file (default: the file alone). */
  imports?: Record<string, string[]>;
  /** `git log` responder (default: empty output). */
  log?: (args: string[]) => GitResult;
  /** Lanes whose run only ends when the run's fail-fast signal aborts it (when a signal is passed). */
  hang?: Array<'unit' | 'integration' | 'e2e'>;
  /** Override a lane's exit code (e.g. null = killed by a signal after writing its report). */
  laneExit?: Partial<Record<'unit' | 'integration' | 'e2e', number | null>>;
  /** Isolation re-runs that only end when the run's fail-fast signal aborts them. */
  rerunHang?: string[];
  /** Results of the focused first run and optional retry. */
  preflightStatuses?: Array<'passed' | 'failed'>;
  preflightQuiescent?: boolean;
  preflightRunDurationMs?: number;
  /** Answer some git calls differently (null: the default answer). */
  gitOverride?: (args: string[]) => GitResult | null;
}

function fake(o: FakeOpts = {}) {
  let t = 1_700_000_000_000;
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const removed: string[] = [];
  const gitCalls: Array<{ args: string[]; cwd: string; gitDir: string; workTree?: string; timeoutMs: number }> = [];
  const execCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; deadlineMs: number }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let holderCall = 0;
  let pid = 1000;
  let preflightRun = 0;
  const soloRuns = new Map<string, number>();
  const shardLists: Array<{ lane: string; files: string[] }> = [];

  files.set(path.join(P.runDir, 'package.json'), PKG);
  const shows: Record<string, string> = o.shows ?? {
    [`${HEAD}:package.json`]: PKG,
    [`${HEAD}:tests/unit/a.test.ts`]: UNIT_SRC,
    [`${MB}:tests/unit/a.test.ts`]: UNIT_SRC,
  };

  const gitImpl = (args: string[]): GitResult => {
    const ok = (stdout = ''): GitResult => ({ status: 0, stdout, stderr: '', timedOut: false });
    const verb = args[0];
    const over = o.gitOverride?.(args);
    if (over) return over;
    if (o.gitTimeout === verb) return { status: null, stdout: '', stderr: 'timeout', timedOut: true };
    switch (verb) {
      case 'init': dirs.add(P.bare); dirs.add(path.join(P.bare, 'objects')); dirs.add(path.join(P.bare, 'refs')); files.set(path.join(P.bare, 'HEAD'), 'ref: refs/heads/main'); return ok();
      case 'merge-tree': return o.mergeTreeStatus ? { status: o.mergeTreeStatus, stdout: `${TREE}\nCONFLICT`, stderr: '', timedOut: false } : ok(`${TREE}\n`);
      case 'commit-tree': return ok(`${COMMIT}\n`);
      case 'worktree': {
        if (args[1] === 'add') { dirs.add(args[3]); files.set(path.join(args[3], '.git'), `gitdir: ${P.bare}/worktrees/${path.basename(args[3])}\n`); }
        if (args[1] === 'remove') dirs.delete(args[2]);
        return ok();
      }
      case 'status': return ok(o.porcelain ?? '');
      case 'ls-tree': {
        const extra = [...Object.values(o.laneFiles ?? {}), ...Object.values(o.laneNamed ?? {})].flatMap((m) => Object.keys(m ?? {}));
        return ok(['package.json', 'src/index.ts', ...TEST_FILES, ...extra, ...(o.extraTree ?? []), 'tests/fixtures/x.test.ts'].join('\n') + '\n');
      }
      case 'merge-base': return ok(`${MB}\n`);
      case 'diff': return ok(o.diff ?? 'M\ttests/unit/a.test.ts\nM\tsrc/index.ts\n');
      case 'log': return o.log ? o.log(args) : ok('');
      case 'show': {
        const k = args[1];
        return k in shows ? ok(shows[k]) : { status: 128, stdout: '', stderr: 'fatal: bad object', timedOut: false };
      }
      default: return ok();
    }
  };

  const stepKey = (command: string, args: string[]): string => {
    if (command === 'npm') return 'npm-ci';
    if (command === 'sh') return args[1].startsWith('tsc --noEmit') || args[1].includes('lint') ? 'lint' : 'build';
    const cfg = args[args.indexOf('--config') + 1];
    return cfg === 'vitest.config.ts' ? 'unit' : cfg.includes('integration') ? 'integration' : 'e2e';
  };

  const seams: OrchestratorSeams = {
    async git(args, opts) {
      gitCalls.push({ args, cwd: opts.cwd, gitDir: opts.gitDir, workTree: opts.workTree, timeoutMs: opts.timeoutMs });
      const duration = o.gitDurations?.[args[0]] ?? 0;
      t += Math.min(duration, opts.timeoutMs);
      if (duration > opts.timeoutMs) return { status: null, stdout: '', stderr: 'timeout', timedOut: true };
      return gitImpl(args);
    },
    async exec(command, args, opts) {
      execCalls.push({ command, args, env: opts.env, deadlineMs: opts.deadlineMs });
      opts.onPid?.(++pid);
      if (args.includes('vitest.push.config.ts')) {
        const out = args.find((a) => a.startsWith('--json=') || a.startsWith('--outputFile.json='))!.split('=')[1];
        const selected = 'tests/unit/a.test.ts';
        if (args[0] === 'list') {
          files.set(out, JSON.stringify(args.includes('--filesOnly')
            ? [{ file: path.join(P.runDir, selected) }]
            : [{ file: path.join(P.runDir, selected), name: 'a' }]));
          t += 1000;
          return { status: 0, signal: null, stdout: '', stderr: '', deadlineKilled: false, pid, quiescent: o.preflightQuiescent ?? true };
        }
        const status = o.preflightStatuses?.[preflightRun++] ?? 'passed';
        const duration = o.preflightRunDurationMs ?? 1000;
        if (duration > opts.deadlineMs) {
          t += opts.deadlineMs;
          return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', deadlineKilled: true, pid,
            quiescent: o.preflightQuiescent ?? true };
        }
        files.set(out, vitestReport(selected, [status]));
        if (opts.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE) files.set(opts.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE, JSON.stringify({ v: 1, unhandledErrors: 0, messages: [] }));
        t += duration;
        return { status: status === 'failed' ? 1 : 0, signal: null, stdout: '', stderr: '', deadlineKilled: false, pid, quiescent: o.preflightQuiescent ?? true };
      }
      const key = stepKey(command, args);
      const dur = o.durations?.[key] ?? 1000;
      const r = (status: number | null): ExecResult => ({ status, signal: null, stdout: '', stderr: '', deadlineKilled: false, pid });
      if (dur > opts.deadlineMs) {
        t += opts.deadlineMs;
        return { ...r(null), signal: 'SIGTERM', deadlineKilled: true };
      }
      t += dur;
      if (key === 'npm-ci') return r(o.npmCiStatus ?? 0);
      if (key === 'lint') return r(o.lintStatus ?? 0);
      if (key === 'build') return r(0);
      const out = args.find((a) => a.startsWith('--outputFile='))!.slice('--outputFile='.length);
      const lane = key as 'unit' | 'integration' | 'e2e';
      if (o.hang?.includes(lane) && opts.signal) {
        const sig = opts.signal;
        await new Promise<void>((res) => { if (sig.aborted) res(); else sig.addEventListener('abort', () => res(), { once: true }); });
        return { ...r(null), signal: 'SIGTERM', aborted: true };
      }
      const errFile = opts.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE;
      const isRerun = out.includes('-rerun-');
      if (errFile && args.includes('--reporter=/opt/instar/dist/localVerify/unhandledErrorsReporter.js')) {
        files.set(errFile, JSON.stringify({ v: 1, unhandledErrors: isRerun ? (o.rerunUnhandled ?? 0) : (o.unhandled?.[lane] ?? 0), messages: [] }));
      }
      const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--config');
      if (positional.length > 0 && !isRerun) {
        // A balanced shard: an explicit file list. It reports exactly the lane's files it names.
        shardLists.push({ lane, files: positional });
        // vitest's real rule: a file runs when any filter is a case-insensitive substring of its path.
        const mine = (o.laneFiles?.[lane] ? Object.keys(o.laneFiles[lane]!) : [TEST_FILES.find((f) => f.includes(`/${lane}/`))!]).filter((f) => positional.some((q) => f.toLowerCase().includes(q.toLowerCase())));
        files.set(out, mine.length ? vitestReportMany(Object.fromEntries(mine.map((f) => [f, o.laneFiles?.[lane]?.[f] ?? o.laneStatuses?.[lane] ?? ['passed']]))) : JSON.stringify({ testResults: [] }));
        return r(mine.some((f) => (o.laneFiles?.[lane]?.[f] ?? o.laneStatuses?.[lane] ?? []).includes('failed')) ? 1 : 0);
      }
      if (positional.length > 0) {
        // An isolation re-run of one file.
        const file = positional[0];
        if (o.rerunHang?.includes(file) && opts.signal) {
          const sig = opts.signal;
          await new Promise<void>((res) => { if (sig.aborted) res(); else sig.addEventListener('abort', () => res(), { once: true }); });
          return { ...r(null), signal: 'SIGTERM', aborted: true };
        }
        const outcome = o.rerun?.[file] ?? ['passed'];
        const rd = o.rerunMs ?? 1000;
        if (outcome === 'deadline' || rd > opts.deadlineMs) { t += opts.deadlineMs; return { ...r(null), signal: 'SIGTERM', deadlineKilled: true }; }
        t += rd - dur; // (dur was already added)
        const namedRuns = o.rerunNamed?.[file];
        if (namedRuns) {
          const n = soloRuns.get(file) ?? 0;
          soloRuns.set(file, n + 1);
          const tests = namedRuns[Math.min(n, namedRuns.length - 1)];
          files.set(out, namedReport({ [file]: tests }));
          return r(tests.some((x) => x.status === 'failed') ? 1 : 0);
        }
        files.set(out, vitestReport(file, outcome, 'boom again'));
        return r(outcome.includes('failed') ? 1 : 0);
      }
      const shard = args.find((a) => a.startsWith('--shard='));
      if (shard && !shard.startsWith('--shard=1/')) {
        files.set(out, JSON.stringify({ testResults: [] }));
        return r(0);
      }
      const namedLane = o.laneNamed?.[lane];
      if (namedLane) {
        files.set(out, namedReport(namedLane));
        return r(Object.values(namedLane).some((v) => (Array.isArray(v) ? v : v.tests).some((x) => x.status === 'failed') || (!Array.isArray(v) && !!v.message)) ? 1 : 0);
      }
      // `--exclude=<path>` removes exactly that path from what the process runs (a lane's rest after its first part).
      const excluded = new Set(args.filter((a) => a.startsWith('--exclude=')).map((a) => a.slice('--exclude='.length)));
      const all = o.laneFiles?.[lane];
      const many = all && excluded.size > 0 ? Object.fromEntries(Object.entries(all).filter(([f]) => !excluded.has(f))) : all;
      if (many) {
        files.set(out, vitestReportMany(many));
        return r(Object.values(many).some((x) => x.includes('failed')) ? 1 : 0);
      }
      const file = TEST_FILES.find((f) => f.includes(`/${lane}/`))!;
      const statuses = o.laneStatuses?.[lane] ?? ['passed'];
      files.set(out, vitestReport(file, statuses));
      if (o.laneExit && lane in o.laneExit) return r(o.laneExit[lane] as number | null);
      return r(statuses.includes('failed') ? 1 : 0);
    },
    fs: {
      exists: (p) => files.has(p) || dirs.has(p),
      mkdirp: (p) => { dirs.add(p); },
      writeFile: (p, d) => { files.set(p, d); },
      readFile: (p) => files.get(p) ?? (p.includes('/runs/') && p.endsWith('/package.json') ? PKG : null),
      size: (p) => (files.has(p) ? Buffer.byteLength(files.get(p)!) : null),
      mkdtemp: (prefix) => { const d = `/tmp/${prefix}${dirs.size}`; dirs.add(d); return d; },
      removeTree: async (p) => { removed.push(p); dirs.delete(p); for (const k of [...files.keys()]) if (k.startsWith(p + '/')) files.delete(k); },
    },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    foreignSuiteHolders: () => (o.holders?.[holderCall++] ?? []).map((pid) => ({ pid })),
    log: (e) => { logs.push(e); },
    unhandledErrorsReporter: () => (o.noReporter ? null : '/opt/instar/dist/localVerify/unhandledErrorsReporter.js'),
    importGraph: (fs2) => fs2.flatMap((abs) => {
      const rel = path.relative(P.runDir, abs);
      return [abs, ...(o.imports?.[rel] ?? []).map((x) => path.join(P.runDir, x))];
    }),
  };
  return { seams, files, dirs, removed, gitCalls, execCalls, logs, shardLists, now: () => t };
}

function input(over: Partial<VerifyRunInput> = {}): VerifyRunInput {
  return {
    repo: 'JKHeadley/instar', pr: 42, headSha: HEAD, baseSha: BASE, baseRefName: 'main', agentHome: HOME,
    remoteUrl: 'https://github.com/JKHeadley/instar.git', nodeVersion: 'v24.1.0', machineId: 'm_studio',
    verifierVersion: '1.3.1204', policyHash: 'f'.repeat(64), protectedList: ['.github/', 'scripts/safe-merge.mjs'],
    baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/x', CI: 'true' },
    isolation: { allowed: true, notCleanOnGreenMain: [] }, ...over,
  };
}

describe('helpers', () => {
  it('splitScript splits on && and trims', () => {
    expect(splitScript('tsc --noEmit && node a.js &&  node b.js --x ')).toEqual(['tsc --noEmit', 'node a.js', 'node b.js --x']);
    expect(splitScript(undefined)).toEqual([]);
  });
  it('parseNameStatus reads A/M/D rows', () => {
    expect(parseNameStatus('A\ta.ts\nD\tb.ts\nM\tc d.ts\n')).toEqual([
      { status: 'A', path: 'a.ts' }, { status: 'D', path: 'b.ts' }, { status: 'M', path: 'c d.ts' },
    ]);
  });
  it('the bare config pins the identity and an empty hooks dir', () => {
    const c = bareConfigTemplate('https://example/x.git');
    expect(c).toContain('email = noreply@local');
    expect(c).toContain('name = local-verify');
    expect(c).toContain('hooksPath = hooks');
    expect(c).toContain('url = https://example/x.git');
    expect(c).toMatch(/\[merge\]\s*\n\s*directoryRenames = false/);
  });

  // Found on the first real run (PR 2247, 2026-10-21): every release moves
  // upgrades/next/*.md out, so git's directory-rename guess "moved" a PR's new
  // fragment and reported a conflict that GitHub (MERGEABLE) does not.
  it('a release that empties a directory does not make a PR adding to it conflict', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-dirrename-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    try {
      g('init', '-q', '-b', 'main');
      g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
      fs.mkdirSync(path.join(dir, 'upgrades/next'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'upgrades/next/a.md'), 'a\n');
      fs.writeFileSync(path.join(dir, 'upgrades/next/b.md'), 'b\n');
      g('add', '.'); g('commit', '-qm', 'base');
      g('checkout', '-qb', 'pr');
      fs.writeFileSync(path.join(dir, 'upgrades/next/c.md'), 'c\n');
      g('add', '.'); g('commit', '-qm', 'pr adds a fragment');
      g('checkout', '-q', 'main');
      g('mv', 'upgrades/next/a.md', 'upgrades/a.md'); g('mv', 'upgrades/next/b.md', 'upgrades/b.md');
      g('commit', '-qm', 'release moves fragments');
      // Without the setting git guesses a directory rename and conflicts.
      expect(() => g('merge-tree', '--write-tree', 'main', 'pr')).toThrow();
      // With the template's setting, as the bare clone runs it, the merge is clean.
      fs.appendFileSync(path.join(dir, '.git/config'), bareConfigTemplate('x').split('[merge]')[1] ? `[merge]${bareConfigTemplate('x').split('[merge]')[1]}` : '');
      expect(g('merge-tree', '--write-tree', 'main', 'pr')).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'orchestrator.test.ts' });
    }
  });
});

describe('runVerify — happy path', () => {
  it('logs one timed step event per process step (the Acceptance measurement reads them)', async () => {
    const f = fake();
    await runVerify(input(), f.seams);
    const steps = f.logs.filter((l) => l.event === 'step');
    expect(steps.length).toBe(f.execCalls.length);
    for (const s of steps) {
      expect(typeof s.step).toBe('string');
      expect(typeof s.ms).toBe('number');
      expect(s.deadlineKilled).toBe(false);
    }
    expect(steps.map((s) => s.step)).toEqual(expect.arrayContaining(['npm-ci', 'build-lint', 'unit', ...Array.from({ length: LOCAL_VERIFY_LIMITS.integrationShards }, (_, k) => `integration-${k + 1}`), ...Array.from({ length: E2E_N }, (_, k) => `e2e-${k + 1}`)]));
  });

  it('gives every step a UTF-8 locale when the base environment has none (CI parity)', async () => {
    const f = fake();
    await runVerify(input(), f.seams);
    expect(f.execCalls.length).toBeGreaterThan(0);
    for (const c of f.execCalls) expect(c.env.LANG).toBe('C.UTF-8');
  });

  it('sets HUSKY=0 for npm ci only, never for the lanes (it breaks npm pack --json output)', async () => {
    const f = fake();
    await runVerify(input(), f.seams);
    const ci = f.execCalls.find((c) => c.args[0] === 'ci');
    expect(ci?.env.HUSKY).toBe('0');
    const lanes = f.execCalls.filter((c) => c.args.includes('--config'));
    expect(lanes.length).toBe(LANE_PROCS); // unit, the integration shards, the e2e shards
    for (const l of lanes) expect(l.env.HUSKY).toBeUndefined();
  });

  it("keeps the operator's own locale when one is set", async () => {
    const f = fake();
    await runVerify({ ...input(), baseEnv: { ...input().baseEnv, LC_ALL: 'en_US.UTF-8' } }, f.seams);
    for (const c of f.execCalls) {
      expect(c.env.LC_ALL).toBe('en_US.UTF-8');
      expect(c.env.LANG).toBeUndefined();
    }
  });

  it('produces a validated success record and runs each step as specified', async () => {
    const f = fake();
    const r = await runVerify(input(), f.seams);
    expect(r.kind).toBe('record');
    if (r.kind !== 'record') return;
    expect(r.record.outcome).toBe('success');
    expect(r.reasons).toEqual([]);
    expect(r.record.mergeTree).toBe(TREE);
    expect(r.record.lanes.map((l) => l.name)).toEqual(['unit', 'integration', 'e2e']);
    expect(r.record).toMatchObject({ harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false });
    expect(r.keptWorktree).toBeNull();

    const verbs = f.gitCalls.map((c) => c.args.join(' '));
    expect(verbs).toContain(`fetch --no-tags --no-recurse-submodules origin ${HEAD} ${BASE}`);
    expect(verbs).toContain(`update-ref refs/heads/main ${BASE}`);
    expect(verbs).toContain(`update-ref refs/remotes/origin/main ${BASE}`);
    expect(verbs).toContain(`merge-tree --write-tree ${BASE} ${HEAD}`);
    expect(verbs).toContain(`commit-tree ${TREE} -p ${BASE} -p ${HEAD} -m local-verify merge`);
    expect(verbs).toContain(`worktree add --detach ${P.runDir} ${COMMIT}`);
    expect(verbs).toContain(`worktree remove ${P.runDir}`);
    // Bare clone config and hooks reset every run.
    expect(f.files.get(path.join(P.bare, 'config'))).toContain('noreply@local');
    expect(f.removed).toContain(path.join(P.bare, 'hooks'));

    const [ci, ...rest] = f.execCalls;
    expect(ci.command).toBe('npm');
    expect(ci.args[0]).toBe('ci');
    const sh = rest.filter((c) => c.command === 'sh').map((c) => c.args[1]);
    expect(sh).toEqual(['tsc', 'node scripts/gen.mjs', 'tsc --noEmit', 'node scripts/lint-a.js']);
    const lanes = rest.filter((c) => c.command.endsWith('vitest'));
    expect(lanes).toHaveLength(LANE_PROCS);
    // With no duration history the slow lanes use vitest's own --shard; every lane process has its own TMPDIR and tmux server.
    const shardArgs = (n: number) => Array.from({ length: n }, (_, k) => `--shard=${k + 1}/${n}`);
    expect(lanes.filter((l) => l.args.some((a) => a.startsWith('--shard='))).map((l) => l.args.find((a) => a.startsWith('--shard=')))).toEqual([...shardArgs(LOCAL_VERIFY_LIMITS.integrationShards), ...shardArgs(E2E_N)]);
    expect(new Set(lanes.map((l) => l.env.TMPDIR)).size).toBe(LANE_PROCS);
    expect(new Set(lanes.map((l) => l.env.TMUX_TMPDIR)).size).toBe(LANE_PROCS);
    for (const l of lanes) {
      expect(l.command).toBe(path.join(P.runDir, 'node_modules', '.bin', 'vitest'));
      expect(l.args).toContain('--allowOnly=false');
      expect(l.args).toContain('--reporter=json');
      expect(l.env.CI).toBeUndefined();
      expect(l.env.TMPDIR).toMatch(/lv-tmp-/);
      expect(l.env.TMUX_TMPDIR).toMatch(/lv-tmux-/);
      expect(l.env.PATH!.startsWith(path.join(P.runDir, 'node_modules', '.bin'))).toBe(true);
      // Reports go outside the worktree so they never dirty the tree.
      expect(l.args.find((a) => a.startsWith('--outputFile='))!.startsWith(`--outputFile=${P.reportsDir}`)).toBe(true);
    }
    expect(lanes[0].env).toMatchObject({ AUDIT_CHANGE_KIND: 'pull_request', AUDIT_CHANGE_BASE_SHA: BASE, AUDIT_CHANGE_HEAD_SHA: HEAD });
    expect(lanes[1].env.AUDIT_CHANGE_KIND).toBeUndefined();
    // Temp dirs removed: the run's pair plus one pair per lane process.
    expect(f.removed.filter((p) => p.startsWith('/tmp/lv-'))).toHaveLength(2 + 2 * LANE_PROCS);
  });
});

describe('runVerify — focused PR preflight', () => {
  const focused = (mode: 'observe' | 'enforce') => input({ preflightMode: mode, preflightRediscoverable: true });
  it('keeps an observed stable red diagnostic while the complete lanes determine green', async () => {
    const f = fake({ preflightStatuses: ['failed', 'failed'] });
    const r = await runVerify(focused('observe'), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'success', preflight: { mode: 'observe', outcome: 'red', reason: 'observed-stable-red' } });
    expect(f.execCalls.filter((c) => c.args.includes('vitest.push.config.ts'))).toHaveLength(4);
    expect(f.execCalls.filter((c) => c.args.includes('vitest.config.ts'))).toHaveLength(1);
  });
  it('stops only an eligible stable assertion red before the full-suite slot', async () => {
    const f = fake({ preflightStatuses: ['failed', 'failed'] });
    const r = await runVerify(focused('enforce'), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'failure', lanes: [], preflight: { mode: 'enforce', outcome: 'red', reason: 'preflight-red' } });
    expect(f.execCalls.filter((c) => c.args.includes('vitest.config.ts'))).toHaveLength(0);
  });
  it('continues all full lanes after a failed first attempt passes its retry', async () => {
    const f = fake({ preflightStatuses: ['failed', 'passed'] });
    const r = await runVerify(focused('enforce'), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'success', preflight: { mode: 'enforce', outcome: 'pass', reason: 'retry-green' } });
    expect(f.execCalls.filter((c) => c.args.includes('vitest.config.ts'))).toHaveLength(1);
  });
  it('turns an unconfirmed process-group cleanup into an infrastructure error before lanes', async () => {
    const f = fake({ preflightQuiescent: false });
    const r = await runVerify(focused('enforce'), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'error', errorStep: 'preflight-cleanup', lanes: [] });
    expect(f.execCalls.filter((c) => c.args.includes('vitest.config.ts'))).toHaveLength(0);
  });
  it('charges a slow post-preflight cleanliness check to the 90-second cap', async () => {
    const f = fake({ gitDurations: { status: 100_000 } });
    const r = await runVerify(focused('enforce'), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'error', errorStep: 'deadline:preflight-porcelain', lanes: [] });
    expect(r.kind === 'record' && r.record?.preflight?.elapsedMs).toBeLessThanOrEqual(90_000);
    expect(f.gitCalls.find((c) => c.args[0] === 'status')?.timeoutMs).toBeLessThanOrEqual(90_000);
    expect(f.execCalls.filter((c) => c.args.includes('vitest.config.ts'))).toHaveLength(0);
  });
  it('continues full verification after a contained preflight deadline and a clean final status check', async () => {
    const f = fake({ preflightRunDurationMs: 100_000 });
    const r = await runVerify(focused('enforce'), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'success', preflight: { outcome: 'timeout', reason: 'first-run-timeout' } });
    expect(r.kind === 'record' && r.record?.preflight?.elapsedMs).toBeLessThanOrEqual(90_000);
    expect(f.gitCalls.find((c) => c.args[0] === 'status')?.timeoutMs).toBeGreaterThan(0);
    expect(f.execCalls.filter((c) => c.args.includes('vitest.config.ts'))).toHaveLength(1);
  });
  it('freezes preflight elapsed time before the full suite runs', async () => {
    const f = fake({ durations: { unit: 60_000, integration: 60_000, e2e: 60_000 } });
    const r = await runVerify(focused('observe'), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'success', preflight: { outcome: 'pass' } });
    expect(r.kind === 'record' && r.record?.preflight?.elapsedMs).toBeLessThan(10_000);
  });
  it('skips focused work for a changed harness file while the full lanes still decide green', async () => {
    const f = fake({ diff: 'M\ttests/vitest-setup.ts\n' });
    const r = await runVerify(focused('enforce'), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'success', preflight: { outcome: 'skip', reason: 'harness-changing' } });
    expect(f.execCalls.filter((c) => c.args.includes('vitest.push.config.ts'))).toHaveLength(0);
    expect(f.execCalls.filter((c) => c.args.includes('vitest.config.ts'))).toHaveLength(1);
    expect(f.gitCalls.find((c) => c.args[0] === 'merge-base')?.timeoutMs).toBeLessThanOrEqual(80_000);
  });
});

describe('runVerify — errors', () => {
  it('a merge conflict is error:conflict with no merge tree', async () => {
    const r = await runVerify(input(), fake({ mergeTreeStatus: 1 }).seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'error', errorStep: 'conflict', mergeTree: '' });
  });
  it('an npm ci failure is an infrastructure error', async () => {
    const r = await runVerify(input(), fake({ npmCiStatus: 1 }).seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'error', errorStep: 'npm-ci' });
  });
  it.each([
    ['fetch', { gitTimeout: 'fetch' }, 'deadline:fetch'],
    ['npm ci', { durations: { 'npm-ci': LOCAL_VERIFY_DEADLINES.npmCiMs + 1 } }, 'deadline:npm-ci'],
    ['build+lint', { durations: { build: 8 * MIN, lint: 8 * MIN } }, 'deadline:build-lint'],
    ['unit lane', { durations: { unit: LOCAL_VERIFY_DEADLINES.lanes.unit + 1 } }, 'deadline:unit'],
    ['integration lane', { durations: { integration: LOCAL_VERIFY_DEADLINES.lanes.integration + 1 } }, 'deadline:integration-1'],
    ['e2e lane', { durations: { e2e: LOCAL_VERIFY_DEADLINES.lanes.e2e + 1 } }, 'deadline:e2e-1'],
  ] as const)('%s past its deadline → error naming the step', async (_n, o, step) => {
    const f = fake(o as FakeOpts);
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'error', errorStep: step });
    // An error keeps the worktree for inspection when it existed.
    if (step !== 'deadline:fetch' && r.kind === 'record') expect(r.keptWorktree).toBe(P.runDir);
  });
  it('the overall active-work deadline caps a step → deadline:total', async () => {
    const f = fake({ durations: { 'npm-ci': 9 * MIN, e2e: 40 * MIN, integration: 29 * MIN, unit: 9 * MIN, build: MIN, lint: MIN } });
    const r = await runVerify(input({ deadlines: { ...LOCAL_VERIFY_DEADLINES, totalActiveMs: 90 * MIN } }), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'error', errorStep: 'deadline:total' });
  });
});

describe('runVerify — failures', () => {
  it.each(['same inventory', 'failed again', 'different inventory'])('requires same-file recovery after a named retry: %s', async (confirmation) => {
    const wholeFilePassed = confirmation === 'same inventory';
    const file = 'tests/unit/a.test.ts';
    const predecessor = { name: 'suite predecessor', status: 'passed' };
    const affected = { name: 'suite failed [literal]', status: 'failed' };
    const recovered = { ...affected, status: 'passed' };
    const f = fake({ diff: 'M\tsrc/index.ts\n', laneNamed: { unit: { [file]: [predecessor, affected] } }, rerunNamed: {
      [file]: [[{ ...predecessor, status: 'skipped' }, recovered], [
        confirmation === 'different inventory' ? { ...predecessor, name: 'replacement' } : predecessor,
        confirmation === 'failed again' ? affected : recovered,
      ]],
    } });
    const result = await runVerify(input({ namedFlakeRetry: { quarantined: [] } }), f.seams);
    expect(result).toMatchObject({ kind: 'record', record: { outcome: wholeFilePassed ? 'success' : 'failure' } });
    const reruns = f.execCalls.filter((call) => call.args.some((arg) => arg.includes('/unit-rerun-')));
    expect(reruns).toHaveLength(2);
    expect(reruns[0].args).toContain('--testNamePattern=^(?:suite failed \\[literal\\])$');
    expect(reruns[1].args.some((arg) => arg.startsWith('--testNamePattern'))).toBe(false);
    if (wholeFilePassed) expect(result).toMatchObject({ record: { flakyRetried: [{ namedRetry: true, failedTests: [affected.name] }] } });
    else expect(result).not.toHaveProperty('flakyRetried');
  });

  it('rejects a whole-file proof that swaps which tests passed and skipped', async () => {
    const file = 'tests/unit/a.test.ts';
    const first = { name: 'first', status: 'passed' };
    const second = { name: 'second', status: 'skipped' };
    const failed = { name: 'target', status: 'failed' };
    const recovered = { ...failed, status: 'passed' };
    const f = fake({ diff: 'M\tsrc/index.ts\n', laneNamed: { unit: { [file]: [first, second, failed] } }, rerunNamed: {
      [file]: [[recovered], [{ ...first, status: 'skipped' }, { ...second, status: 'passed' }, recovered]],
    } });
    const result = await runVerify(input({ namedFlakeRetry: { quarantined: [] } }), f.seams);
    expect(result).toMatchObject({ kind: 'record', record: { outcome: 'failure' } });
    expect(result).not.toHaveProperty('flakyRetried');
  });

  it.each([1, 4])('only re-runs a small named failure set that is not quarantined, failures=%s', async (count) => {
    const file = 'tests/unit/a.test.ts';
    const failures = Array.from({ length: count }, (_, i) => ({ name: `suite case ${i}`, status: 'failed' }));
    const f = fake({ diff: 'M\tsrc/index.ts\n', laneNamed: { unit: { [file]: failures } }, rerunNamed: {
      [file]: [failures.map((test) => ({ ...test, status: 'passed' }))],
    } });
    const result = await runVerify(input({ namedFlakeRetry: { quarantined: [] } }), f.seams);
    expect(result).toMatchObject({ kind: 'record', record: { outcome: count === 1 ? 'success' : 'failure' } });
    expect(f.execCalls.filter((call) => call.args.some((arg) => arg.startsWith('--testNamePattern')))).toHaveLength(count === 1 ? 1 : 0);
    const quarantined = fake({ diff: 'M\tsrc/index.ts\n', laneNamed: { unit: { [file]: [failures[0]] } } });
    expect(await runVerify(input({ namedFlakeRetry: { quarantined: [{ file, test: failures[0].name }] } }), quarantined.seams))
      .toMatchObject({ kind: 'record', record: { outcome: 'failure' } });
    expect(quarantined.execCalls.some((call) => call.args.some((arg) => arg.startsWith('--testNamePattern')))).toBe(false);
  });

  it('a failed test that fails again on its isolation re-run is a failure and the worktree is kept', async () => {
    const r = await runVerify(input(), fake({ laneStatuses: { integration: ['passed', 'failed'] }, rerun: { 'tests/integration/b.test.ts': ['passed', 'failed'] } }).seams);
    expect(r.kind).toBe('record');
    if (r.kind !== 'record') return;
    expect(r.record.outcome).toBe('failure');
    expect(r.record.failedFiles).toEqual(['tests/integration/b.test.ts']);
    expect(r.reasons).toContain('file-failed:tests/integration/b.test.ts:1');
    expect(r.keptWorktree).toBe(P.runDir);
  });
  it('does not diagnose a failed assertion when another lane also has an infrastructure exit', async () => {
    const f = fake({ laneStatuses: { integration: ['passed', 'failed'] },
      rerun: { 'tests/integration/b.test.ts': ['passed', 'failed'] } });
    const exec = f.seams.exec;
    f.seams.exec = async (command, args, opts) => {
      const result = await exec(command, args, opts);
      return isE2e(args) ? { ...result, status: 1 } : result;
    };
    const r = await runVerify(input(), f.seams);
    expect(r.kind).toBe('record');
    if (r.kind !== 'record') return;
    expect(r.reasons).toContain('file-failed:tests/integration/b.test.ts:1');
    expect(r.reasons.some((reason) => reason.startsWith('lane-exit-nonzero:e2e:'))).toBe(true);
    expect(r.record.failedFiles).toBeUndefined();
  });
  it('a dirty tree after the lanes fails the run', async () => {
    const r = await runVerify(input(), fake({ porcelain: '?? tests/unit/leftover.txt\n' }).seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(r.kind === 'record' && r.reasons).toContain('dirty-tree');
    if (r.kind === 'record') expect(r.record.failedFiles).toBeUndefined();
  });
  it('a lint step failure is a failure that stops before the lanes', async () => {
    const f = fake({ lintStatus: 1 });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(r.kind === 'record' && r.reasons[0]).toMatch(/^lint-failed:tsc --noEmit/);
    expect(f.execCalls.some((c) => c.command.endsWith('vitest'))).toBe(false);
  });
});

describe('runVerify — classification', () => {
  it('a harness read failure classifies the PR harness-changing, outcome unchanged', async () => {
    const f = fake({ shows: {} });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'success', harnessChanging: true });
    expect(f.logs.some((l) => l.event === 'classify-read-failure')).toBe(true);
  });
  it('a harness path, a protected path, an added skip and a deleted test file are all flagged', async () => {
    const f = fake({
      diff: 'M\tvitest.config.ts\nM\t.github/workflows/ci.yml\nM\ttests/unit/a.test.ts\nD\ttests/unit/gone.test.ts\n',
      shows: {
        [`${HEAD}:package.json`]: PKG,
        [`${MB}:tests/unit/a.test.ts`]: UNIT_SRC,
        [`${HEAD}:tests/unit/a.test.ts`]: `import { it } from 'vitest'; it.skip('a', () => {});`,
        [`${MB}:tests/unit/gone.test.ts`]: UNIT_SRC,
      },
    });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ harnessChanging: true, protectedPath: true, skipsAdded: true, testsRemoved: true });
  });
  // 2026-10-23: the verify child runs from the installed copy, which has no typescript;
  // every PR touching a .test.ts was recorded harness-changing (classify-read-failure).
  const noParser = () => { throw new Error('typescript not found (tried: verifier install)'); };
  it('a missing parser flags the ratchet (skips-added, tests-removed), never harness-changing', async () => {
    const f = fake({
      diff: 'M\tsrc/foo.ts\nM\ttests/unit/a.test.ts\n',
      shows: { [`${HEAD}:package.json`]: PKG, [`${MB}:tests/unit/a.test.ts`]: UNIT_SRC, [`${HEAD}:tests/unit/a.test.ts`]: UNIT_SRC },
    });
    const r = await runVerify(input(), { ...f.seams, typescript: noParser });
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: true, testsRemoved: true });
    expect(f.logs.some((l) => l.event === 'skip-ratchet-failure')).toBe(true);
    expect(f.logs.some((l) => l.event === 'classify-read-failure')).toBe(false);
  });
  it('a missing parser flags nothing when no inventoried test file changed', async () => {
    const f = fake({ diff: 'M\tsrc/foo.ts\nM\ttests/fixtures/x.test.ts\n', shows: { [`${HEAD}:package.json`]: PKG, [`${MB}:tests/fixtures/x.test.ts`]: UNIT_SRC, [`${HEAD}:tests/fixtures/x.test.ts`]: UNIT_SRC } });
    const r = await runVerify(input(), { ...f.seams, typescript: noParser });
    expect(r.kind === 'record' && r.record).toMatchObject({ harnessChanging: false, skipsAdded: false, testsRemoved: false });
    expect(f.logs.find((l) => l.event === 'skip-ratchet-failure')).toMatchObject({ inventoriedChanged: 0 });
  });
  it('an injected parser is the one the ratchet uses', async () => {
    const real = await import('typescript');
    let calls = 0;
    const f = fake({
      diff: 'M\ttests/unit/a.test.ts\n',
      shows: { [`${HEAD}:package.json`]: PKG, [`${MB}:tests/unit/a.test.ts`]: UNIT_SRC, [`${HEAD}:tests/unit/a.test.ts`]: UNIT_SRC },
    });
    const r = await runVerify(input(), { ...f.seams, typescript: () => { calls++; return (real.default ?? real) as never; } });
    expect(calls).toBe(1);
    expect(r.kind === 'record' && r.record).toMatchObject({ harnessChanging: false, skipsAdded: false, testsRemoved: false });
  });
});

describe('runVerify — independent review of a flagged record (directive 2026-10-22)', () => {
  const TRACE = '.instar/instar-dev-traces/2026-10-22-fix-abc.json';
  const ART = 'upgrades/side-effects/fix.md';
  const ARTIFACT = '# Side-effects review\n\n' + 'A real review of what this change touches and why it is safe. '.repeat(6)
    + '\n\n## Second-pass review (if required)\n\n**Reviewer:** codey\n**Independent read of the artifact: concur**\n';
  const TRACE_COMMIT = '7'.repeat(40);
  const trace = (over: Record<string, unknown> = {}) => JSON.stringify({
    phase: 'complete', artifactPath: ART, coveredFiles: ['scripts/safe-merge.mjs', 'src/index.ts'],
    secondPass: 'true', reviewerConcurred: true, artifactSha256: artifactSha256(ARTIFACT), ...over,
  });
  /** git log: the trace's last commit in mb..head, and the flagged-path commits after it (`later`). */
  const logFor = (later = '') => (args: string[]): GitResult => {
    const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: '', timedOut: false });
    if (args.includes('-1') && args.at(-1) === TRACE && args.includes(`${MB}..${HEAD}`)) return ok(`${TRACE_COMMIT}\n`);
    if (args.includes(`${TRACE_COMMIT}..${HEAD}`)) return ok(later);
    return ok('');
  };
  /** A protected-path PR (scripts/safe-merge.mjs is on the protected list AND a harness glob). */
  const run = async (o: { diff?: string; shows?: Record<string, string>; later?: string } = {}) => {
    const f = fake({
      diff: o.diff ?? `M\tscripts/safe-merge.mjs\nM\tsrc/index.ts\nA\t${TRACE}\nA\t${ART}\n`,
      shows: { [`${HEAD}:package.json`]: PKG, [`${HEAD}:${TRACE}`]: trace(), [`${HEAD}:${ART}`]: ARTIFACT, ...o.shows },
      log: logFor(o.later),
    });
    const r = await runVerify(input(), f.seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    return { record: r.record, logs: f.logs };
  };

  it('records the PR\'s concurring trace that covers every flagged path, read from the head tree', async () => {
    const { record } = await run();
    expect(record).toMatchObject({ harnessChanging: true, protectedPath: true, independentReview: { trace: TRACE, concurred: true } });
  });

  it('bound to the head: a flagged file edited after the trace\'s last commit needs a new review', async () => {
    const { record, logs } = await run({ later: `${'8'.repeat(40)}\n` });
    expect(record.protectedPath).toBe(true);
    expect(record.independentReview).toBeUndefined();
    expect(JSON.stringify(logs.find((l) => l.event === 'independent-review-absent'))).toMatch(/flagged-changed-after-trace:888888888888/);
    // The binding query runs over exactly the flagged paths after the trace commit.
    const f = fake({
      diff: `M\tscripts/safe-merge.mjs\nM\tsrc/index.ts\nA\t${TRACE}\nA\t${ART}\n`,
      shows: { [`${HEAD}:package.json`]: PKG, [`${HEAD}:${TRACE}`]: trace(), [`${HEAD}:${ART}`]: ARTIFACT },
      log: logFor(''),
    });
    await runVerify(input(), f.seams);
    expect(f.gitCalls.some((c) => c.args.join(' ') === `log --format=%H ${TRACE_COMMIT}..${HEAD} -- scripts/safe-merge.mjs`)).toBe(true);
  });

  it('an unreadable trace commit is not a review', async () => {
    const f = fake({
      diff: `M\tscripts/safe-merge.mjs\nA\t${TRACE}\nA\t${ART}\n`,
      shows: { [`${HEAD}:package.json`]: PKG, [`${HEAD}:${TRACE}`]: trace(), [`${HEAD}:${ART}`]: ARTIFACT },
    }); // default git log answers nothing
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.independentReview).toBeUndefined();
  });

  it('no independent review when the trace does not cover a flagged path', async () => {
    const { record, logs } = await run({ shows: { [`${HEAD}:${TRACE}`]: trace({ coveredFiles: ['src/index.ts'] }) } });
    expect(record.protectedPath).toBe(true);
    expect(record.independentReview).toBeUndefined();
    expect(JSON.stringify(logs.find((l) => l.event === 'independent-review-absent'))).toMatch(/not-covered:scripts\/safe-merge\.mjs/);
  });

  it('no independent review without a concurring second pass', async () => {
    for (const over of [{ reviewerConcurred: false }, { secondPass: 'not-required' }, { secondPass: 'true', reviewerConcurred: null }]) {
      const { record } = await run({ shows: { [`${HEAD}:${TRACE}`]: trace(over) } });
      expect(record.independentReview).toBeUndefined();
    }
    // The skill's documented boolean form counts too.
    expect((await run({ shows: { [`${HEAD}:${TRACE}`]: trace({ secondPass: true }) } })).record.independentReview).toBeDefined();
  });

  it('a trace committed after the verified head does not count (it is not in the head tree)', async () => {
    // The diff names the trace, but the head commit does not contain it: show at HEAD fails.
    const f = fake({
      diff: `M\tscripts/safe-merge.mjs\nM\tsrc/index.ts\nA\t${TRACE}\n`,
      shows: { [`${HEAD}:package.json`]: PKG, [`${HEAD}:${ART}`]: ARTIFACT, [`${'9'.repeat(40)}:${TRACE}`]: trace() },
      log: logFor(),
    });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.independentReview).toBeUndefined();
  });

  it('a trace the PR did not change (already on main) does not count', async () => {
    const { record } = await run({ diff: 'M\tscripts/safe-merge.mjs\nM\tsrc/index.ts\n' });
    expect(record.independentReview).toBeUndefined();
  });

  it('an artifact missing from the head tree, or one whose sha the trace pins differently, does not count', async () => {
    const f = fake({
      diff: `M\tscripts/safe-merge.mjs\nA\t${TRACE}\n`,
      shows: { [`${HEAD}:package.json`]: PKG, [`${HEAD}:${TRACE}`]: trace({ coveredFiles: ['scripts/safe-merge.mjs'] }) },
      log: logFor(),
    });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.independentReview).toBeUndefined();
    const { record } = await run({ shows: { [`${HEAD}:${TRACE}`]: trace({ artifactSha256: 'f'.repeat(64) }) } });
    expect(record.independentReview).toBeUndefined();
  });

  it('an unflagged record never carries one', async () => {
    const { record } = await run({ diff: `M\tsrc/index.ts\nA\t${TRACE}\n` });
    expect(record).toMatchObject({ harnessChanging: false, protectedPath: false });
    expect(record.independentReview).toBeUndefined();
  });
});

describe('runVerify — single flight', () => {
  it('a foreign full suite before lane 1 re-queues without running a lane', async () => {
    const f = fake({ holders: [[777]] });
    const r = await runVerify(input(), f.seams);
    expect(r).toMatchObject({ kind: 'requeue', reason: 'foreign-suite-at-start' });
    expect(f.execCalls.some((c) => c.command.endsWith('vitest'))).toBe(false);
    // The worktree is removed (a re-queue starts fresh).
    expect(f.gitCalls.some((c) => c.args.join(' ') === `worktree remove ${P.runDir}`)).toBe(true);
  });
  it('the lanes run inside one held suite slot, released after the lanes', async () => {
    const f = fake();
    const order: string[] = [];
    f.seams.holdSuiteSlot = async () => { order.push('hold'); return () => { order.push('release'); }; };
    const exec = f.seams.exec;
    f.seams.exec = async (c, a, o) => { if (c.endsWith('vitest')) order.push('lane'); return exec(c, a, o); };
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    expect(order).toEqual(['hold', ...Array(LANE_PROCS).fill('lane'), 'release']);
  });
  it('a busy suite slot re-queues without running a lane', async () => {
    const f = fake();
    f.seams.holdSuiteSlot = async () => 'busy';
    const r = await runVerify(input(), f.seams);
    expect(r).toMatchObject({ kind: 'requeue', reason: 'foreign-suite-at-start' });
    expect(f.execCalls.some((c) => c.command.endsWith('vitest'))).toBe(false);
  });
  it('the slot is released when a lane errors', async () => {
    const f = fake({ durations: { integration: LOCAL_VERIFY_DEADLINES.lanes.integration + 1 } });
    let released = 0;
    f.seams.holdSuiteSlot = async () => () => { released++; };
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'error', errorStep: 'deadline:integration-1' });
    expect(released).toBe(1);
  });
  it('a fail-open bound (no slot) still runs the lanes', async () => {
    const f = fake();
    f.seams.holdSuiteSlot = async () => null;
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
  });
  it('a shard killed by a signal (no report) fails the run even though the other shard passed', async () => {
    const f = fake();
    const exec = f.seams.exec;
    f.seams.exec = async (c, a, o) => {
      const res = await exec(c, a, o);
      if (!(isE2e(a) && a.includes(`--shard=1/${E2E_N}`))) return res;
      f.files.delete(a.find((x) => x.startsWith('--outputFile='))!.slice('--outputFile='.length));
      return { ...res, status: null, signal: 'SIGKILL' };
    };
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
  });
});

describe('runVerify — e2e shards', () => {
  const outFile = (a: string[]) => a.find((x) => x.startsWith('--outputFile='))!.slice('--outputFile='.length);
  const E2E = 'tests/e2e/c.test.ts';
  it('a failing test in shard 2 fails the run', async () => {
    const f = fake({ extraTree: ['tests/e2e/d.test.ts'], rerun: { 'tests/e2e/d.test.ts': ['failed'] } });
    const exec = f.seams.exec;
    f.seams.exec = async (c, a, o) => {
      const res = await exec(c, a, o);
      if (!(isE2e(a) && a.includes(`--shard=${E2E_N}/${E2E_N}`))) return res;
      f.files.set(outFile(a), vitestReport('tests/e2e/d.test.ts', ['failed']));
      return { ...res, status: 1 };
    };
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    // Shard 2's own file failed (and failed again alone); not a duplicate or missing report.
    expect(r.kind === 'record' && r.reasons).toContain('file-failed:tests/e2e/d.test.ts:1');
    expect(f.logs.some((l) => l.event === 'file-in-multiple-shards')).toBe(false);
  });
  it('shard 1 killed after its report + shard 2 exiting 1 with passing tests: the non-zero exit is not hidden', async () => {
    const f = fake();
    const exec = f.seams.exec;
    f.seams.exec = async (c, a, o) => {
      const res = await exec(c, a, o);
      if ((isE2e(a) && a.includes(`--shard=1/${E2E_N}`))) return { ...res, status: null, signal: 'SIGKILL' };
      if ((isE2e(a) && a.includes(`--shard=${E2E_N}/${E2E_N}`))) return { ...res, status: 1 };
      return res;
    };
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(r.kind === 'record' && r.reasons.some((x) => x.startsWith('lane-exit-nonzero:e2e:1'))).toBe(true);
  });
  it('a file reported by both shards makes the lane report missing (failure), never a silent overwrite', async () => {
    const f = fake();
    const exec = f.seams.exec;
    f.seams.exec = async (c, a, o) => {
      const res = await exec(c, a, o);
      if ((isE2e(a) && a.includes(`--shard=${E2E_N}/${E2E_N}`))) f.files.set(outFile(a), vitestReport(E2E, ['passed']));
      return res;
    };
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(f.logs.some((l) => l.event === 'file-in-multiple-shards' && l.file === E2E)).toBe(true);
  });
  it('a shard deadline waits for its sibling shard to exit before the slot is released', async () => {
    // Only shard 1 hits its deadline; the last shard is still running when it does. (The fake
    // clock is shared, so giving every shard the over-deadline duration would spend the overall
    // budget before the last shard starts.)
    const f = fake();
    const order: string[] = [];
    f.seams.holdSuiteSlot = async () => () => { order.push('release'); };
    const exec = f.seams.exec;
    f.seams.exec = async (c, a, o) => {
      if (isE2e(a) && a.includes(`--shard=1/${E2E_N}`)) {
        return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', deadlineKilled: true, pid: 999 };
      }
      if (isE2e(a) && a.includes(`--shard=${E2E_N}/${E2E_N}`)) {
        await new Promise((r) => setTimeout(r, 20)); // still running when shard 1 has already failed
        const res = await exec(c, a, o);
        order.push('shard2-exited');
        return res;
      }
      return exec(c, a, o);
    };
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'error' });
    expect(order).toEqual(['shard2-exited', 'release']);
  });

  it('the unit lane is pinned to the parallel worker count; other lanes are not', async () => {
    const f = fake();
    await runVerify(input(), f.seams);
    const lanes = f.execCalls.filter((c) => c.command.endsWith('vitest'));
    expect(lanes[0].env.INSTAR_TEST_WORKERS).toBe(String(LOCAL_VERIFY_LIMITS.unitWorkersParallel));
    for (const l of lanes.slice(1)) expect(l.env.INSTAR_TEST_WORKERS).toBeUndefined();
  });
  it('a per-machine unitWorkers setting sets the unit lane worker count; out of range keeps the default', async () => {
    const f = fake();
    await runVerify(input({ laneShards: { unitWorkers: 8 } }), f.seams);
    expect(f.execCalls.filter((c) => c.command.endsWith('vitest'))[0].env.INSTAR_TEST_WORKERS).toBe('8');
    // The run holds the suite slot; its own unit lane is exempt from the nested clamp, other lanes are not touched.
    const calls = f.execCalls.filter((c) => c.command.endsWith('vitest'));
    expect(calls[0].env.INSTAR_HOST_TEST_OWN_SUITE_HOLDER).toBe(String(process.pid));
    expect(calls[0].env.INSTAR_HOST_TEST_SEMAPHORE).toBeUndefined();
    for (const l of calls.slice(1)) expect(l.env.INSTAR_HOST_TEST_OWN_SUITE_HOLDER).toBeUndefined();
    const g = fake();
    await runVerify(input({ laneShards: { unitWorkers: 99 } }), g.seams);
    expect(g.execCalls.filter((c) => c.command.endsWith('vitest'))[0].env.INSTAR_TEST_WORKERS).toBe(String(LOCAL_VERIFY_LIMITS.unitWorkersParallel));
  });
  it('a busy slot leaves an overlap entry (the evidence a re-queue happened)', async () => {
    const f = fake();
    f.seams.holdSuiteSlot = async () => 'busy';
    const r = await runVerify(input(), f.seams);
    expect(r).toMatchObject({ kind: 'requeue', reason: 'foreign-suite-at-start' });
    expect(r.overlaps).toHaveLength(1);
  });
});

describe('runVerify — retention of failed worktrees', () => {
  it('preserves the failed verdict if evidence capture throws', async () => {
    const spy = vi.spyOn(FailureEvidence.prototype, 'capture').mockImplementation(() => { throw new Error('capture failed'); });
    try {
      const f = fake({ laneStatuses: { unit: ['failed'] } });
      const r = await runVerify(input(), f.seams);
      expect(r.kind === 'record' && r.record.outcome).toBe('failure');
      expect(f.logs).toContainEqual({ event: 'failure-evidence-capture-failed' });
    } finally { spy.mockRestore(); }
  });

  it('keeps assertion details after temporary lane reports are removed', async () => {
    const f = fake({ laneStatuses: { integration: ['failed'] }, rerun: { 'tests/integration/b.test.ts': ['failed'] } });
    const write = f.seams.fs.writeFile;
    const modes: unknown[] = [];
    f.seams.fs.writeFile = (p, data, mode) => { if (p.endsWith('.local-verify-failures.json')) modes.push(mode); write(p, data); };
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    const artifact = f.files.get(path.join(P.runDir, '.local-verify-failures.json'));
    expect(JSON.parse(artifact!).failures).toContainEqual(expect.objectContaining({ file: 'tests/integration/b.test.ts', message: 'boom' }));
    expect(modes).toEqual([{ mode: 0o600, flag: 'wx' }]);
    expect(f.removed).toContain(P.reportsDir);
  });
  it('retains unit process output when the report lists no failed tests', async () => {
    const f = fake();
    const exec = f.seams.exec;
    f.seams.exec = async (command, args, options) => {
      const result = await exec(command, args, options);
      if (!command.endsWith('vitest') || !args.some(a => a.endsWith('/unit.json'))) return result;
      f.files.set(options.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE!, JSON.stringify({
        v: 1, unhandledErrors: 5, messages: Array(5).fill('worker error: ' + '\n'.repeat(380)),
      }));
      return { ...result, status: 1, signal: null, stderr: 'Unhandled Errors: worker unexpectedly exited' };
    };
    const result = await runVerify(input(), f.seams);
    expect(result.kind === 'record' && result.record.outcome).toBe('failure');
    const artifact = f.files.get(path.join(P.runDir, '.local-verify-failures.json'));
    expect(JSON.parse(artifact!)).toMatchObject({
      failures: [],
      processFailures: [{
        step: 'unit', status: 1, signal: null, stderr: 'Unhandled Errors: worker unexpectedly exited',
        unhandled: { count: 5, messages: Array(5).fill('worker error: ' + '\n'.repeat(380)) },
      }],
    });
  });

  it('keeps a failed verdict when diagnostic storage fails', async () => {
    const f = fake({ laneStatuses: { unit: ['failed'] } });
    const write = f.seams.fs.writeFile;
    f.seams.fs.writeFile = (p, data) => { if (p.endsWith('.local-verify-failures.json')) throw new Error('disk full'); write(p, data); };
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'failure-evidence-write-failed' }));
  });
  it('does not retain diagnostic output for a successful run', async () => {
    const f = fake();
    await runVerify(input(), f.seams);
    expect(f.files.has(path.join(P.runDir, '.local-verify-failures.json'))).toBe(false);
  });

  it('keeps at most three failed-run worktrees', async () => {
    const f = fake({ laneStatuses: { unit: ['failed'] } });
    const heads = ['1', '2', '3', '4'].map((c) => c.repeat(40));
    for (const h of heads) await runVerify(input({ headSha: h }), f.seams);
    const kept = JSON.parse(f.files.get(P.keptListFile)!);
    expect(kept).toHaveLength(3);
    expect(kept).not.toContain(verifyPaths(HOME, heads[0]).runDir);
    expect(f.gitCalls.some((c) => c.args.join(' ') === `worktree remove ${verifyPaths(HOME, heads[0]).runDir}`)).toBe(true);
  });
});

describe('runVerify — task-update RPC timeout in the complete unit lane', () => {
  const timeout = '[vitest-worker]: Timeout calling "onTaskUpdate"';
  const retryFile = 'unit-task-update-retry.json';
  const artifact = path.join(P.runDir, '.local-verify-failures.json');

  const completedReport = (file: string, statuses: string[]): string => {
    const failed = statuses.filter(status => status === 'failed').length;
    return JSON.stringify({
      ...JSON.parse(vitestReport(file, statuses)),
      success: failed === 0, numFailedTests: failed, numFailedTestSuites: failed ? 1 : 0, numPendingTestSuites: 0,
      numPassedTests: statuses.filter(status => status === 'passed').length, numPendingTests: 0, numTodoTests: 0,
      numTotalTests: statuses.length,
    });
  };

  const scenario = (options: {
    repeat?: boolean; initialMessages?: string[]; initialErrorCount?: number;
    initialStatuses?: string[]; initialFile?: string; incompleteSummary?: boolean;
    retryStatuses?: string[]; omitRetryErrors?: boolean;
  } = {}) => {
    const f = fake();
    const exec = f.seams.exec;
    f.seams.exec = async (command, args, env) => {
      const result = await exec(command, args, env);
      const reportPath = args.find(a => a.startsWith('--outputFile='))?.slice('--outputFile='.length);
      if (!reportPath) return result;
      const errorPath = env.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE!;
      if (reportPath.endsWith('/unit.json')) {
        const messages = options.initialMessages ?? Array(5).fill(timeout);
        const report = completedReport(options.initialFile ?? TEST_FILES[0], options.initialStatuses ?? ['passed']);
        f.files.set(reportPath, options.incompleteSummary ? JSON.stringify({ ...JSON.parse(report), numTotalTests: 2 }) : report);
        f.files.set(errorPath, JSON.stringify({ v: 1, unhandledErrors: options.initialErrorCount ?? messages.length, messages }));
        return { ...result, status: 1 };
      }
      if (reportPath.endsWith('/' + retryFile)) {
        f.files.set(reportPath, completedReport(TEST_FILES[0], options.retryStatuses ?? ['passed']));
        if (options.omitRetryErrors) f.files.delete(errorPath);
        if (options.repeat) {
          f.files.set(errorPath, JSON.stringify({ v: 1, unhandledErrors: 1, messages: [timeout] }));
          return { ...result, status: 1 };
        }
      }
      return result;
    };
    return f;
  };

  it('retries once within the original unit deadline and records a clean comparable retry', async () => {
    const f = scenario();
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    const init = f.execCalls.find(call => call.args.some(a => a.endsWith('/unit.json')))!;
    const retries = f.execCalls.filter(call => call.args.some(a => a.endsWith('/' + retryFile)));
    expect(retries).toHaveLength(1);
    expect(retries[0].deadlineMs).toBeLessThan(init.deadlineMs);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'unit-task-update-retry', timeouts: 5 }));
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'unit-task-update-retry-result', accepted: true }));
  });

  it('keeps both process receipts when the retry has the same fault', async () => {
    const f = scenario({ repeat: true });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(JSON.parse(f.files.get(artifact)!)).toMatchObject({
      failures: [],
      processFailures: [
        { step: 'unit', unhandled: { count: 5, messages: Array(5).fill(timeout) } },
        { step: 'unit-task-update-retry', unhandled: { count: 1, messages: [timeout] } },
      ],
    });
  });

  it('does not replace failed assertions from a full retry with an isolation pass', async () => {
    const f = scenario({ retryStatuses: ['failed'] });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(r.kind === 'record' && r.record.lanes.find(lane => lane.name === 'unit')?.failed).toBe(1);
    expect(f.logs.some(row => row.event === 'isolation-rerun' && row.lane === 'unit')).toBe(false);
  });

  it.each([
    { initialMessages: [timeout, 'unexpected worker exit'] },
    { initialMessages: Array(5).fill(timeout), initialErrorCount: 6 },
    { initialStatuses: ['failed'] },
    { initialStatuses: ['pending'] },
    { incompleteSummary: true },
    { initialFile: 'tests/unit/other.test.ts' },
  ])('does not retry incomplete or mixed evidence (%j)', async options => {
    const f = scenario(options);
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(f.logs.some(row => row.event === 'unit-task-update-retry')).toBe(false);
  });

  it.each([{ omitRetryErrors: true }, { retryStatuses: ['passed', 'passed'] }])(
    'does not accept a retry with missing or changed evidence (%j)', async options => {
      const f = scenario(options);
      const r = await runVerify(input(), f.seams);
      expect(r.kind === 'record' && r.record.outcome).toBe('failure');
      expect(f.logs).toContainEqual(expect.objectContaining({ event: 'unit-task-update-retry-result', accepted: false }));
    },
  );
});

describe('runVerify — repository pinning and the init-skip check', () => {
  it('every git call pins its repository: the bare clone, or the run worktree admin dir + work tree', async () => {
    const f = fake();
    await runVerify(input(), f.seams);
    for (const c of f.gitCalls) {
      if (c.args[0] === 'status') {
        expect(c).toMatchObject({ gitDir: `${P.bare}/worktrees/${path.basename(P.runDir)}`, workTree: P.runDir, cwd: P.runDir });
      } else {
        expect(c).toMatchObject({ gitDir: P.bare, cwd: P.verifyRoot });
        expect(c.workTree).toBeUndefined();
      }
    }
  });
  it('a damaged clone (only HEAD) is wiped and re-initialised', async () => {
    const f = fake();
    f.dirs.add(P.bare);
    f.files.set(path.join(P.bare, 'HEAD'), 'ref: refs/heads/main');
    await runVerify(input(), f.seams);
    expect(f.removed).toContain(P.bare);
    expect(f.gitCalls.some((c) => c.args[0] === 'init')).toBe(true);
  });
  it('an intact clone (HEAD, objects/, refs/) is reused without init', async () => {
    const f = fake();
    for (const d of [P.bare, path.join(P.bare, 'objects'), path.join(P.bare, 'refs')]) f.dirs.add(d);
    f.files.set(path.join(P.bare, 'HEAD'), 'ref: refs/heads/main');
    await runVerify(input(), f.seams);
    expect(f.removed).not.toContain(P.bare);
    expect(f.gitCalls.some((c) => c.args[0] === 'init')).toBe(false);
  });
});

describe('runVerify — isolation re-run of failed files (evidence-per-run known-flaky)', () => {
  const vitestCalls = (f: ReturnType<typeof fake>) => f.execCalls.filter((c) => c.command.endsWith('vitest'));
  it('one flaky file: re-run once alone with the same lane flags, the lane passes, the record names it', async () => {
    const f = fake({ laneStatuses: { integration: ['passed', 'failed'] } });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    // The shared name fields ride on every entry, whatever the import-related switch says (they are what main evidence is made of).
    expect(r.kind === 'record' && r.record.flakyRetried).toEqual([{
      file: 'tests/integration/b.test.ts', lane: 'integration', firstMessage: expect.stringContaining('boom'),
      failedTests: ['t1'], failedTestsTotal: 1, soloPassedByName: [], testSetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }]);
    const calls = vitestCalls(f);
    expect(calls).toHaveLength(LANE_PROCS + 1);
    // The lane processes start together; the re-run comes after its lane.
    const re = calls[LANE_PROCS];
    expect(re.args).toContain('tests/integration/b.test.ts');
    expect(re.args).toContain('--allowOnly=false');
    expect(re.args[re.args.indexOf('--config') + 1]).toBe('vitest.integration.config.ts');
    expect(r.kind === 'record' && r.keptWorktree).toBeNull();
  });
  it('two failed files, one fails again: a real failure carrying both messages; the other is still recorded flaky', async () => {
    const f = fake({
      laneFiles: { unit: { 'tests/unit/a.test.ts': ['passed'], 'tests/unit/x.test.ts': ['failed'], 'tests/unit/y.test.ts': ['passed', 'failed'] } },
      rerun: { 'tests/unit/x.test.ts': ['failed'] },
    });
    const r = await runVerify(input(), f.seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    expect(r.record.outcome).toBe('failure');
    expect(r.failures).toEqual([expect.objectContaining({ file: 'tests/unit/x.test.ts', message: expect.stringContaining('boom'), rerunMessage: expect.stringContaining('boom again') })]);
    expect(r.record.flakyRetried?.map((x) => x.file)).toEqual(['tests/unit/y.test.ts']);
  });
  it('four failed files: a real break, no re-run', async () => {
    const four = Object.fromEntries(['p', 'q', 'r', 's'].map((n) => [`tests/unit/${n}.test.ts`, ['failed']]));
    const f = fake({ laneFiles: { unit: { 'tests/unit/a.test.ts': ['passed'], ...four } } });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    if (r.kind === 'record') expect(r.record.failedFiles).toBeUndefined();
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS); // unit, the integration shards, the e2e shards
    expect(f.logs.some((l) => l.event === 'isolation-rerun-skipped' && l.reason === 'too-many-failures')).toBe(true);
  });
  it('no re-run when the lane has another failure (a file that collected nothing)', async () => {
    const f = fake({ laneFiles: { unit: { 'tests/unit/a.test.ts': ['passed'], 'tests/unit/x.test.ts': ['failed'], 'tests/unit/z.test.ts': [] } } });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS); // unit, the integration shards, the e2e shards
  });
  it('the re-run respects the lane deadline: a re-run that hits it is a failure, never a pass or an error', async () => {
    const unitBudget = LOCAL_VERIFY_DEADLINES.lanes.unit;
    const f = fake({ laneStatuses: { unit: ['passed', 'failed'] }, durations: { unit: unitBudget - 30_000 }, rerunMs: 60_000, diff: 'M\tsrc/index.ts\n' });
    const r = await runVerify(input(), f.seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    expect(r.record.outcome).toBe('failure');
    expect(r.failures?.[0].rerunMessage).toMatch(/deadline/);
    const re = vitestCalls(f)[LANE_PROCS];
    expect(re.deadlineMs).toBeLessThanOrEqual(30_000);
  });
  it('the cap covers the whole verify: 2 + 2 failed files re-run only the first lane\'s 2', async () => {
    const f = fake({
      laneFiles: {
        unit: { 'tests/unit/a.test.ts': ['passed'], 'tests/unit/x.test.ts': ['failed'], 'tests/unit/y.test.ts': ['failed'] },
        integration: { 'tests/integration/b.test.ts': ['passed'], 'tests/integration/m.test.ts': ['failed'], 'tests/integration/n.test.ts': ['failed'] },
      },
    });
    const r = await runVerify(input(), f.seams);
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS + 2); // the lane processes + 2 re-runs
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(f.logs.some((l) => l.event === 'isolation-rerun-skipped' && l.reason === 'rerun-budget-spent')).toBe(true);
  });
});

describe('runVerify — isolation re-run safety (second pass)', () => {
  const vitestCalls = (f: ReturnType<typeof fake>) => f.execCalls.filter((c) => c.command.endsWith('vitest'));
  const oneFlake = { laneStatuses: { integration: ['passed', 'failed'] } } as const;
  it('a failed file the PR changed is a real failure: no re-run', async () => {
    const f = fake({ ...oneFlake, diff: 'M\ttests/integration/b.test.ts\n' });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS); // unit, the integration shards, the e2e shards
    expect(f.logs.some((l) => l.event === 'isolation-rerun-skipped' && l.reason === 'related-to-change')).toBe(true);
  });
  it('a failed file that imports a file the PR changed is a real failure: no re-run', async () => {
    const f = fake({ ...oneFlake, diff: 'M\tsrc/core/thing.ts\n', imports: { 'tests/integration/b.test.ts': ['tests/helpers/h.ts', 'src/core/thing.ts'] } });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS); // unit, the integration shards, the e2e shards
  });
  it('a PR verify with no green main record on this machine never re-runs', async () => {
    const f = fake(oneFlake);
    const r = await runVerify(input({ isolation: { allowed: false, notCleanOnGreenMain: [] } }), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS); // unit, the integration shards, the e2e shards
  });
  it('a file that was re-run-passed on the last green main is re-run like any other flake (it is flaky on main)', async () => {
    const f = fake(oneFlake);
    const r = await runVerify(input({ isolation: { allowed: true, notCleanOnGreenMain: ['tests/integration/b.test.ts'] } }), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    expect(r.kind === 'record' && r.record.flakyRetried?.map((x) => x.file)).toEqual(['tests/integration/b.test.ts']);
    expect(f.logs.some((l) => l.event === 'isolation-rerun-flaky-on-main')).toBe(true);
  });
  it('a flaky-on-main file the PR changed is still a real failure: no re-run', async () => {
    const f = fake({ ...oneFlake, diff: 'M\ttests/integration/b.test.ts\n' });
    const r = await runVerify(input({ isolation: { allowed: true, notCleanOnGreenMain: ['tests/integration/b.test.ts'] } }), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
  });
  it('a main verify keeps the plain rule (changed-file rule does not apply)', async () => {
    const f = fake({ ...oneFlake, diff: 'M\ttests/integration/b.test.ts\n' });
    const r = await runVerify(input({ kind: 'main', pr: 0, baseSha: HEAD, isolation: undefined }), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    expect(r.kind === 'record' && r.record.flakyRetried?.map((x) => x.file)).toEqual(['tests/integration/b.test.ts']);
  });
  it('an unhandled error in the lane is never hidden: no re-run, the lane fails', async () => {
    const f = fake({ ...oneFlake, unhandled: { integration: 1 } });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS); // unit, the integration shards, the e2e shards
    expect(f.logs.some((l) => l.event === 'isolation-rerun-skipped' && l.reason === 'unhandled-errors')).toBe(true);
  });
  it('an unknown unhandled-error count (no trusted reporter) means no re-run', async () => {
    const f = fake({ ...oneFlake, noReporter: true });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS); // unit, the integration shards, the e2e shards
  });
  it('a re-run that passes its tests but raises an unhandled error does not pass', async () => {
    const f = fake({ ...oneFlake, rerunUnhandled: 2 });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
  });
  it('each re-run gets a fresh TMPDIR and TMUX_TMPDIR, cleaned up afterwards', async () => {
    const f = fake(oneFlake);
    await runVerify(input(), f.seams);
    const [lane, , rerun] = [vitestCalls(f)[1], null, vitestCalls(f)[2]];
    expect(rerun.env.TMPDIR).toMatch(/lv-tmp-/);
    expect(rerun.env.TMPDIR).not.toBe(lane.env.TMPDIR);
    expect(rerun.env.TMUX_TMPDIR).not.toBe(lane.env.TMUX_TMPDIR);
    expect(f.removed).toContain(rerun.env.TMPDIR);
    expect(rerun.args).toContain('--reporter=/opt/instar/dist/localVerify/unhandledErrorsReporter.js');
  });
});

describe('runVerify — a failed file that imports a changed file, on named main evidence (spec local-verify-import-related-rerun.md)', () => {
  const vitestCalls = (f: ReturnType<typeof fake>) => f.execCalls.filter((c) => c.command.endsWith('vitest'));
  const X = 'tests/unit/x.test.ts';
  const Y = 'tests/unit/y.test.ts';
  const A = 'tests/unit/a.test.ts';
  const hashOf = (names: string[]) => { const h = crypto.createHash('sha256'); for (const n of names) h.update(JSON.stringify(n) + '\n'); return h.digest('hex'); };
  const LANE: NamedTest[] = [{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'failed', msg: 'AssertionError: lane boom\n    at x.ts:1:1' }];
  const SOLO_OK: NamedTest[] = [{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'passed' }];
  const HASH = hashOf(['s ok', 's flaky']);
  const RUNLOG = 'ab'.repeat(16) + '.log';
  const ev = (test: string, over: Record<string, unknown> = {}) => ({ test, at: '2026-11-16T10:00:00.000Z', line: 'Error: main boom', setHash: HASH, runLog: RUNLOG, ...over });
  const iso = (on: boolean, list: Array<{ file: string; tests: ReturnType<typeof ev>[]; namesCut?: true }> = [{ file: X, tests: [ev('s flaky')] }]) =>
    ({ allowed: true, notCleanOnGreenMain: [] as string[], importRelatedRerun: on, flakyOnMain: list });
  /** x.test.ts imports src/core/thing.ts, which the PR changed. */
  const related = (over: FakeOpts = {}): FakeOpts => ({
    diff: 'M\tsrc/core/thing.ts\n', imports: { [X]: ['src/core/thing.ts'], [Y]: ['src/core/thing.ts'] },
    laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: LANE } }, rerunNamed: { [X]: [SOLO_OK] }, ...over,
  });
  const rec = (r: Awaited<ReturnType<typeof runVerify>>) => { if (r.kind !== 'record') throw new Error(r.kind); return r; };
  const ineligibleLog = (f: ReturnType<typeof fake>) => f.logs.find((l) => l.event === 'isolation-rerun-ineligible') as Record<string, unknown> | undefined;

  it('switch off: no re-run and the same log events as before, also when the file is listed', async () => {
    for (const isolation of [iso(false), { allowed: true, notCleanOnGreenMain: [] as string[] }]) {
      const f = fake(related());
      const r = rec(await runVerify(input({ isolation }), f.seams));
      expect(r.record.outcome).toBe('failure');
      expect(vitestCalls(f)).toHaveLength(LANE_PROCS);
      expect(ineligibleLog(f)).toEqual({ event: 'isolation-rerun-ineligible', files: [X] });
      expect(f.logs.some((l) => l.event === 'isolation-rerun-skipped' && l.reason === 'related-to-change')).toBe(true);
      expect(r.isolationRefusals).toBeUndefined();
      expect(r.record.flakyRetried).toBeUndefined();
    }
  });

  it('every failed test on the list, three by-name passes: success, with the shared and clearance fields and exactly three extra runs', async () => {
    const f = fake(related());
    const r = rec(await runVerify(input({ isolation: iso(true) }), f.seams));
    expect(r.record.outcome).toBe('success');
    expect(r.record.flakyRetried).toEqual([{
      file: X, lane: 'unit', firstMessage: expect.stringContaining('lane boom'),
      failedTests: ['s flaky'], failedTestsTotal: 1, soloPassedByName: ['s flaky'], testSetHash: HASH,
      importRelated: true, soloPasses: 3, soloSeconds: [1, 1, 1],
      evidence: [{ test: 's flaky', mainAt: '2026-11-16T10:00:00.000Z', mainLine: 'Error: main boom', prLine: 'AssertionError: lane boom', mainRunLog: RUNLOG }],
    }]);
    const solo = vitestCalls(f).slice(LANE_PROCS);
    expect(solo).toHaveLength(3);
    const outs = solo.map((c) => c.args.find((a) => a.startsWith('--outputFile='))!);
    expect(outs.map((o) => path.basename(o))).toEqual(['unit-rerun-0-1.json', 'unit-rerun-0-2.json', 'unit-rerun-0-3.json']);
    expect(new Set(solo.map((c) => c.env.TMPDIR)).size).toBe(3);
    expect(new Set(solo.map((c) => c.env.TMUX_TMPDIR)).size).toBe(3);
    expect(f.logs.filter((l) => l.event === 'isolation-rerun')).toEqual([1, 2, 3].map((run) => ({ event: 'isolation-rerun', lane: 'unit', file: X, outcome: 'passed', importRelated: true, run, of: 3, detailOnly: false, seconds: 1 })));
    expect(f.logs.filter((l) => l.event === 'failure-full')).toEqual([{ event: 'failure-full', lane: 'unit', file: X, test: 's flaky', message: 'AssertionError: lane boom\n    at x.ts:1:1' }]);
    expect(r.isolationRefusals).toBeUndefined();
    expect(r.flakyTestLines).toBeUndefined(); // a PR run hands no lines to the service
  });

  it('a failed test that is not on the list: no re-run, named in the log and in the result with its count', async () => {
    const f = fake(related());
    const r = rec(await runVerify(input({ isolation: iso(true, [{ file: X, tests: [ev('s other')] }]) }), f.seams));
    expect(r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS);
    expect(ineligibleLog(f)).toEqual({ event: 'isolation-rerun-ineligible', files: [X], noMainEvidence: [], noMainEvidenceForTest: [{ file: X, reason: 'noMainEvidenceForTest', test: 's flaky' }], refused: [] });
    expect(r.isolationRefusals).toEqual({
      noMainEvidence: [], noMainEvidenceCount: 0,
      noMainEvidenceForTest: [{ file: X, reason: 'noMainEvidenceForTest', test: 's flaky' }], noMainEvidenceForTestCount: 1,
      importRelatedRefused: [], importRelatedRefusedCount: 0,
    });
  });

  it('two failed tests, one on the list: no re-run; a file that is not listed at all: noMainEvidence; a cut list is marked', async () => {
    const two: NamedTest[] = [{ name: 's flaky', status: 'failed' }, { name: 's new', status: 'failed' }];
    const f1 = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: two } } }));
    const r1 = rec(await runVerify(input({ isolation: iso(true, [{ file: X, tests: [ev('s flaky', { setHash: hashOf(['s flaky', 's new']) })] }]) }), f1.seams));
    expect(r1.record.outcome).toBe('failure');
    expect(vitestCalls(f1)).toHaveLength(LANE_PROCS);
    expect(r1.isolationRefusals?.noMainEvidenceForTest).toEqual([{ file: X, reason: 'noMainEvidenceForTest', test: 's new' }]);

    const f2 = fake(related());
    const r2 = rec(await runVerify(input({ isolation: iso(true, [{ file: 'tests/unit/elsewhere.test.ts', tests: [ev('s flaky')] }]) }), f2.seams));
    expect(vitestCalls(f2)).toHaveLength(LANE_PROCS);
    expect(r2.isolationRefusals).toMatchObject({ noMainEvidence: [{ file: X, reason: 'noMainEvidence' }], noMainEvidenceCount: 1, noMainEvidenceForTestCount: 0 });

    const f3 = fake(related());
    const r3 = rec(await runVerify(input({ isolation: iso(true, [{ file: X, tests: [], namesCut: true }]) }), f3.seams));
    expect(vitestCalls(f3)).toHaveLength(LANE_PROCS);
    expect(r3.isolationRefusals?.noMainEvidenceForTest).toEqual([{ file: X, reason: 'noMainEvidenceForTest', test: 's flaky', namesCut: true }]);
  });

  it('a file-level PR failure is never re-run, also when the file is listed; nor is a file with more than 20 failed tests', async () => {
    const f1 = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: { tests: [], message: 'Cannot find module ./thing', status: 'failed' } } } }));
    const r1 = rec(await runVerify(input({ isolation: iso(true) }), f1.seams));
    expect(r1.record.outcome).toBe('failure');
    expect(vitestCalls(f1)).toHaveLength(LANE_PROCS);
    expect(r1.isolationRefusals?.importRelatedRefused).toEqual([{ file: X, reason: 'fileLevelFailure' }]);

    const many: NamedTest[] = Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, status: 'failed' }));
    const f2 = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: many } } }));
    const r2 = rec(await runVerify(input({ isolation: iso(true, [{ file: X, tests: many.map((t) => ev(t.name, { setHash: hashOf(many.map((m) => m.name)) })) }]) }), f2.seams));
    expect(vitestCalls(f2)).toHaveLength(LANE_PROCS);
    expect(r2.isolationRefusals?.importRelatedRefused).toEqual([{ file: X, reason: 'tooManyFailedTests' }]);
  });

  it('S1: a failed name that occurs twice in the file is refused (duplicateTestName); across two shards the lane report is not trusted at all', async () => {
    const dup: NamedTest[] = [{ name: 's flaky', status: 'failed' }, { name: 's flaky', status: 'passed' }];
    const f1 = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: dup } } }));
    const r1 = rec(await runVerify(input({ isolation: iso(true, [{ file: X, tests: [ev('s flaky', { setHash: hashOf(['s flaky', 's flaky']) })] }]) }), f1.seams));
    expect(r1.record.outcome).toBe('failure');
    expect(vitestCalls(f1)).toHaveLength(LANE_PROCS);
    expect(r1.isolationRefusals?.importRelatedRefused).toEqual([{ file: X, reason: 'duplicateTestName' }]);

    // The same file reported by two integration shards: no name can be borrowed across them, because nothing in that lane re-runs.
    const B = 'tests/integration/b.test.ts';
    const f2 = fake({ diff: 'M\tsrc/core/thing.ts\n', imports: { [B]: ['src/core/thing.ts'] } });
    const exec = f2.seams.exec;
    f2.seams.exec = async (c, a, o) => {
      const res = await exec(c, a, o);
      const out = a.find((x) => x.startsWith('--outputFile='))?.slice('--outputFile='.length);
      if (!out || !a.includes('vitest.integration.config.ts')) return res;
      f2.files.set(out, namedReport({ [B]: a.includes('--shard=1/2') ? [{ name: 's flaky', status: 'failed' }] : [{ name: 's flaky', status: 'passed' }] }));
      return { ...res, status: a.includes('--shard=1/2') ? 1 : 0 };
    };
    const r2 = rec(await runVerify(input({ isolation: iso(true, [{ file: B, tests: [ev('s flaky', { setHash: hashOf(['s flaky']) })] }]) }), f2.seams));
    expect(r2.record.outcome).toBe('failure');
    expect(f2.logs.some((l) => l.event === 'file-in-multiple-shards' && l.file === B)).toBe(true);
    expect(vitestCalls(f2)).toHaveLength(LANE_PROCS);
    expect(r2.record.flakyRetried).toBeUndefined();
  });

  it('S1: a file whose sequence of test names differs from the evidence is refused (testSetChanged): a new name, or two names swapped', async () => {
    for (const mainNames of [['s ok', 's flaky', 's gone'], ['s flaky', 's ok']]) {
      const f = fake(related());
      const r = rec(await runVerify(input({ isolation: iso(true, [{ file: X, tests: [ev('s flaky', { setHash: hashOf(mainNames) })] }]) }), f.seams));
      expect(r.record.outcome).toBe('failure');
      expect(vitestCalls(f)).toHaveLength(LANE_PROCS);
      expect(r.isolationRefusals?.importRelatedRefused).toEqual([{ file: X, reason: 'testSetChanged', test: 's flaky' }]);
    }
  });

  it('S3: a named failure beside a file-level error is refused (fileLevelFailure)', async () => {
    const f = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: { tests: LANE, message: 'afterAll hook threw' } } } }));
    const r = rec(await runVerify(input({ isolation: iso(true) }), f.seams));
    expect(r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS);
    expect(r.isolationRefusals?.importRelatedRefused).toEqual([{ file: X, reason: 'fileLevelFailure' }]);
  });

  it('S4: a failed name over 300 characters, or an empty named set, is refused (namedCountMismatch): no vacuous pass', async () => {
    const long = 'n'.repeat(301);
    const cases: NamedTest[][] = [
      [{ name: 's flaky', status: 'failed' }, { name: long, status: 'failed' }], // the failed count is above the named failures
      [{ name: long, status: 'failed' }],
      [{ name: '', status: 'failed' }],
    ];
    for (const tests of cases) {
      const f = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: tests } } }));
      const r = rec(await runVerify(input({ isolation: iso(true, [{ file: X, tests: [ev('s flaky', { setHash: hashOf(tests.map((t) => t.name)) })] }]) }), f.seams));
      expect(r.record.outcome).toBe('failure');
      expect(vitestCalls(f)).toHaveLength(LANE_PROCS);
      expect(r.isolationRefusals?.importRelatedRefused).toEqual([{ file: X, reason: 'namedCountMismatch' }]);
    }
  });

  it('pass then fail: a failure after two extra runs, the detail names the run, and a long message keeps its end with the cut disclosed', async () => {
    const tail = 'expected 1 to be 2 // THE END';
    const f = fake(related({ rerunNamed: { [X]: [SOLO_OK, [{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'failed', msg: 'AssertionError: ' + 'y'.repeat(5000) + tail }]] } }));
    const r = rec(await runVerify(input({ isolation: iso(true) }), f.seams));
    expect(r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS + 2);
    const d = r.failures!.find((x) => x.file === X)!;
    expect(d.message).toContain('lane boom'); // the lane run's message is kept
    expect(d.rerunMessage!.startsWith('solo run 2 of 3: ')).toBe(true);
    expect(d.rerunMessage).toContain('BOUNDED INPUT');
    expect(d.rerunMessage!.endsWith(tail)).toBe(true);
    expect(d.rerunMessage!.length).toBeLessThanOrEqual('solo run 2 of 3: '.length + 1000);
    expect(r.record.flakyRetried).toBeUndefined();
    expect(f.logs.filter((l) => l.event === 'isolation-rerun').map((l) => [l.run, l.outcome])).toEqual([[1, 'passed'], [2, 'failed']]);
  });

  it('a green solo run that did not pass the failed test by name is not a pass: skipped, missing, or replaced by another passing test', async () => {
    const cases: Array<[NamedTest[], RegExp]> = [
      [[{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'skipped' }], /"s flaky" was skipped/],
      [[{ name: 's ok', status: 'passed' }], /"s flaky" was missing/],
      [[{ name: 's ok', status: 'passed' }, { name: 's flaky v2', status: 'passed' }], /"s flaky" was missing/],
      [[{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'todo' }], /"s flaky" was todo/],
    ];
    for (const [solo, want] of cases) {
      const f = fake(related({ rerunNamed: { [X]: [solo] } }));
      const r = rec(await runVerify(input({ isolation: iso(true) }), f.seams));
      expect(r.record.outcome).toBe('failure');
      expect(vitestCalls(f)).toHaveLength(LANE_PROCS + 1); // the first run that does not pass ends the sequence
      expect(f.logs.find((l) => l.event === 'isolation-rerun')).toMatchObject({ outcome: 'failed-test-not-passed', run: 1, of: 3 });
      expect(r.failures!.find((x) => x.file === X)!.rerunMessage).toMatch(/^solo run 1 of 3: failed-test-not-passed: /);
      expect(r.failures!.find((x) => x.file === X)!.rerunMessage).toMatch(want);
    }
  });

  it('three runs that do not fit the lane deadline: failed with its own outcome, not read as a test failure', async () => {
    const MINUTE = 60_000;
    // Each solo run takes 15 of the unit lane's 40 minutes: the third is killed at the deadline.
    const f = fake(related({ rerunMs: 15 * MINUTE }));
    const r = rec(await runVerify(input({ isolation: iso(true) }), f.seams));
    expect(r.record.outcome).toBe('failure');
    expect(f.logs.filter((l) => l.event === 'isolation-rerun').map((l) => [l.run, l.outcome])).toEqual([[1, 'passed'], [2, 'passed'], [3, 'deadline']]);
    expect(r.failures!.find((x) => x.file === X)!.rerunMessage).toBe('solo run 3 of 3: not finished inside the lane deadline');
    expect(r.record.flakyRetried).toBeUndefined();
    // Each run computed its own deadline from what was left of the lane.
    const solo = vitestCalls(f).slice(LANE_PROCS);
    expect(solo).toHaveLength(3);
    expect(solo[0].deadlineMs).toBeGreaterThan(solo[1].deadlineMs);
    expect(solo[1].deadlineMs).toBeGreaterThan(solo[2].deadlineMs);
    expect(solo[2].deadlineMs).toBeLessThan(15 * MINUTE);

    // The lane deadline passes after the first run: the second cannot start, and that is a deadline too.
    const g = fake(related());
    const exec = g.seams.exec;
    g.seams.exec = async (c, a, o) => {
      const res = await exec(c, a, o);
      if (a.some((x) => x.includes('-rerun-0-1.json'))) await g.seams.sleep(LOCAL_VERIFY_DEADLINES.lanes.unit);
      return res;
    };
    const r2 = rec(await runVerify(input({ isolation: iso(true) }), g.seams));
    expect(g.logs.filter((l) => l.event === 'isolation-rerun').map((l) => [l.run, l.outcome])).toEqual([[1, 'passed'], [2, 'deadline']]);
    expect(vitestCalls(g)).toHaveLength(LANE_PROCS + 1);
    expect(r2.failures!.find((x) => x.file === X)!.rerunMessage).toBe('solo run 2 of 3: not finished inside the lane deadline');
  });

  it('an unhandled error in a solo run, or a stop from another lane, is a failure', async () => {
    const f = fake(related({ rerunUnhandled: 1 }));
    const r = rec(await runVerify(input({ isolation: iso(true) }), f.seams));
    expect(r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS + 1);
    expect(f.logs.find((l) => l.event === 'isolation-rerun')).toMatchObject({ outcome: 'failed', run: 1 });

    const g = fake(related({ rerunHang: [X], laneStatuses: { integration: ['failed'] }, rerun: { 'tests/integration/b.test.ts': ['failed'] } }));
    const r2 = rec(await runVerify(input({ isolation: iso(true), failFast: true }), g.seams));
    expect(r2.record.outcome).toBe('failure');
    expect(r2.record.flakyRetried?.some((x) => x.file === X) ?? false).toBe(false);
    // The stop is what ended it: one solo run of x was started, it was recorded as stopped (not failed, not passed),
    // and runs 2 and 3 never started. Without the stop the hanging run would never return.
    expect(vitestCalls(g).filter((c) => c.args.at(-1) === X)).toHaveLength(1);
    expect(g.logs.filter((l) => l.event === 'isolation-rerun' && l.file === X)).toEqual([{ event: 'isolation-rerun', lane: 'unit', file: X, outcome: 'stopped', importRelated: true, run: 1, of: 3, detailOnly: false }]);
    expect(r2.failures!.find((x) => x.file === X)!.rerunMessage).toBe('isolation re-run stopped: another lane had already failed');
    expect(g.logs.some((l) => l.event === 'lanes-stop' && l.after === 'integration')).toBe(true);
  });

  it('a solo pass also needs the same skipped count as the lane run: tests skipped behind a nested hook that failed under load, and run alone, are not a pass (skipped-count-changed)', async () => {
    // Lane run: the listed flake failed, and a nested beforeAll failed too, which vitest reports as its tests SKIPPED.
    const lane: NamedTest[] = [{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'failed', msg: 'AssertionError: lane boom' }, { name: 'inner one', status: 'skipped' }, { name: 'inner two', status: 'skipped' }];
    const names = lane.map((t) => t.name);
    const listed = [{ file: X, tests: [ev('s flaky', { setHash: hashOf(names) })] }];
    // Alone, the hook passes: its tests run and pass, nothing is skipped.
    const allRan: NamedTest[] = names.map((name) => ({ name, status: 'passed' }));
    const f = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: lane } }, rerunNamed: { [X]: [allRan] } }));
    const r = rec(await runVerify(input({ isolation: iso(true, listed) }), f.seams));
    expect(r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS + 1); // the first run that is not a pass ends the sequence
    expect(f.logs.filter((l) => l.event === 'isolation-rerun')).toEqual([{ event: 'isolation-rerun', lane: 'unit', file: X, outcome: 'skipped-count-changed', importRelated: true, run: 1, of: 3, detailOnly: false, seconds: 1 }]);
    expect(r.failures!.find((x) => x.file === X)!.rerunMessage).toBe('solo run 1 of 3: skipped-count-changed: 2 skipped in the lane run, 0 in the solo run');
    expect(r.record.flakyRetried).toBeUndefined();

    // The same skipped count in every solo run, and the failed test passed by name: cleared as before.
    const same: NamedTest[] = [{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'passed' }, { name: 'inner one', status: 'skipped' }, { name: 'inner two', status: 'skipped' }];
    const g = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: lane } }, rerunNamed: { [X]: [same] } }));
    const r2 = rec(await runVerify(input({ isolation: iso(true, listed) }), g.seams));
    expect(r2.record.outcome).toBe('success');
    expect(vitestCalls(g)).toHaveLength(LANE_PROCS + 3);
    expect(r2.record.flakyRetried![0]).toMatchObject({ file: X, importRelated: true, soloPasses: 3, soloPassedByName: ['s flaky'] });

    // A count that changes on a later run ends the sequence there; more skipped alone than in the lane is a change too.
    const more: NamedTest[] = [{ name: 's ok', status: 'skipped' }, { name: 's flaky', status: 'passed' }, { name: 'inner one', status: 'skipped' }, { name: 'inner two', status: 'skipped' }];
    const h = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: lane } }, rerunNamed: { [X]: [same, more] } }));
    const r3 = rec(await runVerify(input({ isolation: iso(true, listed) }), h.seams));
    expect(r3.record.outcome).toBe('failure');
    expect(h.logs.filter((l) => l.event === 'isolation-rerun').map((l) => [l.run, l.outcome])).toEqual([[1, 'passed'], [2, 'skipped-count-changed']]);
    expect(r3.failures!.find((x) => x.file === X)!.rerunMessage).toBe('solo run 2 of 3: skipped-count-changed: 2 skipped in the lane run, 3 in the solo run');
  });

  it('the skipped-count rule is for import-related files only: a plain file and a main verify keep the one-pass rule whatever was skipped', async () => {
    const lane: NamedTest[] = [{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'failed' }, { name: 'inner one', status: 'skipped' }];
    const allRan: NamedTest[] = lane.map((t) => ({ name: t.name, status: 'passed' }));
    const plain = fake(related({ imports: {}, laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: lane } }, rerunNamed: { [X]: [allRan] } }));
    expect(rec(await runVerify(input({ isolation: iso(true) }), plain.seams)).record.outcome).toBe('success');
    const main = fake({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: lane } }, rerunNamed: { [X]: [allRan] } });
    expect(rec(await runVerify(input({ kind: 'main', pr: 0, baseSha: HEAD, isolation: undefined }), main.seams)).record.outcome).toBe('success');
  });

  it('the whole failure message goes to the run log per named test, bounded with its disclosure', async () => {
    const f = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: [{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'failed', msg: 'Error: head\n' + 'z'.repeat(20_000) + '\nTHE END' }] } } }));
    const r = rec(await runVerify(input({ isolation: iso(true) }), f.seams));
    expect(r.record.outcome).toBe('success');
    const full = f.logs.filter((l) => l.event === 'failure-full');
    expect(full).toHaveLength(1);
    expect((full[0].message as string).length).toBeLessThanOrEqual(8000);
    expect(full[0].message).toContain('BOUNDED INPUT');
    expect((full[0].message as string).endsWith('THE END')).toBe(true);
    expect(r.record.flakyRetried![0].evidence![0].prLine).toBe('Error: head');
  });

  it('detail-only pin: after a final failure in the lane, the next eligible file gets exactly one solo run, clears nothing and is never recorded', async () => {
    const f = fake(related({
      laneNamed: {
        unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: LANE, [Y]: LANE },
        integration: { 'tests/integration/b.test.ts': [{ name: 'b', status: 'passed' }], 'tests/integration/m.test.ts': [{ name: 'm', status: 'failed' }], 'tests/integration/n.test.ts': [{ name: 'n', status: 'failed' }] },
      },
      rerunNamed: { [X]: [[{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'failed', msg: 'AssertionError: again' }]], [Y]: [SOLO_OK] },
    }));
    const r = rec(await runVerify(input({ isolation: iso(true, [{ file: X, tests: [ev('s flaky')] }, { file: Y, tests: [ev('s flaky')] }]) }), f.seams));
    expect(r.record.outcome).toBe('failure');
    const solo = vitestCalls(f).slice(LANE_PROCS);
    expect(solo.map((c) => c.args.at(-1))).toEqual([X, Y]); // one run each: x failed its first, y is detail only
    expect(r.record.flakyRetried).toBeUndefined();
    const y = r.failures!.find((x) => x.file === Y)!;
    expect(y.rerunMessage).toBe('solo run 1 of 1 (detail only, the lane had already failed): passed');
    expect(y.failed).toBe(1); // still failed, with the lane run's counts
    expect(r.reasons).toContain(`file-failed:${Y}:1`);
    expect(f.logs.filter((l) => l.event === 'isolation-rerun' && l.file === Y)).toEqual([{ event: 'isolation-rerun', lane: 'unit', file: Y, outcome: 'passed', importRelated: true, run: 1, of: 1, detailOnly: true, seconds: 1 }]);
    expect(f.logs.some((l) => l.event === 'failure-full')).toBe(false);
    // It counted against the cap of 3 files: the other lane's two failed files no longer fit.
    expect(f.logs.some((l) => l.event === 'isolation-rerun-skipped' && l.lane === 'integration' && l.reason === 'rerun-budget-spent')).toBe(true);
  });

  it('a detail-only run that fails says so, bounded', async () => {
    const bad: NamedTest[] = [{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'failed', msg: 'AssertionError: again' }];
    const f = fake(related({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: LANE, [Y]: LANE } }, rerunNamed: { [X]: [bad], [Y]: [bad] } }));
    const r = rec(await runVerify(input({ isolation: iso(true, [{ file: X, tests: [ev('s flaky')] }, { file: Y, tests: [ev('s flaky')] }]) }), f.seams));
    expect(r.failures!.find((x) => x.file === Y)!.rerunMessage).toBe('solo run 1 of 1 (detail only, the lane had already failed): s flaky: AssertionError: again');
  });

  it('a plain file after a final failure is still re-run and recorded as flaky (unchanged)', async () => {
    const f = fake(related({
      imports: { [X]: ['src/core/thing.ts'] }, // y imports nothing the PR changed
      laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: LANE, [Y]: LANE } },
      rerunNamed: { [X]: [[{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'failed' }]], [Y]: [SOLO_OK] },
    }));
    const r = rec(await runVerify(input({ isolation: iso(true) }), f.seams));
    expect(r.record.outcome).toBe('failure');
    expect(r.record.flakyRetried).toEqual([{ file: Y, lane: 'unit', firstMessage: expect.any(String), failedTests: ['s flaky'], failedTestsTotal: 1, soloPassedByName: ['s flaky'], testSetHash: HASH }]);
    expect(f.logs.filter((l) => l.event === 'isolation-rerun' && l.file === Y)).toEqual([{ event: 'isolation-rerun', lane: 'unit', file: Y, outcome: 'passed' }]);
  });

  it('an edited file, no green main, and a flaky-on-main file that imports a changed file without named evidence get no re-run with either switch value', async () => {
    for (const on of [false, true]) {
      const edited = fake(related({ diff: `M\t${X}\n` }));
      expect(rec(await runVerify(input({ isolation: iso(on) }), edited.seams)).record.outcome).toBe('failure');
      expect(vitestCalls(edited)).toHaveLength(LANE_PROCS);

      const noGreen = fake(related());
      expect(rec(await runVerify(input({ isolation: { ...iso(on), allowed: false } }), noGreen.seams)).record.outcome).toBe('failure');
      expect(vitestCalls(noGreen)).toHaveLength(LANE_PROCS);

      const notClean = fake(related());
      expect(rec(await runVerify(input({ isolation: { ...iso(on, []), notCleanOnGreenMain: [X] } }), notClean.seams)).record.outcome).toBe('failure');
      expect(vitestCalls(notClean)).toHaveLength(LANE_PROCS); // notCleanOnGreenMain is not evidence for an import-related file
      expect(notClean.logs.some((l) => l.event === 'isolation-rerun-flaky-on-main')).toBe(true);

      // No import relation: the plain rule, one pass.
      const plain = fake(related({ imports: {} }));
      const r = rec(await runVerify(input({ isolation: { ...iso(on, []), notCleanOnGreenMain: [X] } }), plain.seams));
      expect(r.record.outcome).toBe('success');
      expect(vitestCalls(plain)).toHaveLength(LANE_PROCS + 1);
      expect(r.record.flakyRetried![0].importRelated).toBeUndefined();
    }
  });

  it('an import scan that throws leaves the file plain (unchanged)', async () => {
    const f = fake(related());
    f.seams.importGraph = () => { throw new Error('scan failed'); };
    const r = rec(await runVerify(input({ isolation: iso(true) }), f.seams));
    expect(r.record.outcome).toBe('success');
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS + 1);
  });

  it('collection: a main solo pass records only the names that failed in the lane and passed by name, with their lines for the service', async () => {
    const lane: NamedTest[] = [{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'failed', msg: 'Error: mac-desktop-host-timeout\n  at y' }, { name: 's other', status: 'failed', msg: 'AssertionError: nope' }];
    const f = fake({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: lane } }, rerunNamed: { [X]: [[{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'passed' }, { name: 's other', status: 'skipped' }]] } });
    const r = rec(await runVerify(input({ kind: 'main', pr: 0, baseSha: HEAD, isolation: undefined }), f.seams));
    expect(r.record.outcome).toBe('success'); // what main accepts is unchanged: the file passed alone, once
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS + 1);
    expect(r.record.flakyRetried).toEqual([{
      file: X, lane: 'unit', firstMessage: expect.any(String),
      failedTests: ['s flaky', 's other'], failedTestsTotal: 2, soloPassedByName: ['s flaky'], testSetHash: hashOf(['s ok', 's flaky', 's other']),
    }]);
    expect(r.flakyTestLines).toEqual({ [X]: [{ test: 's flaky', line: 'Error: mac-desktop-host-timeout' }, { test: 's other', line: 'AssertionError: nope' }] });
    expect(f.logs.filter((l) => l.event === 'failure-full').map((l) => l.test)).toEqual(['s flaky', 's other']);
  });

  it('collection: a main solo pass with the failed test skipped still clears main and records no name; a duplicated name needs as many passes as failures', async () => {
    const f = fake({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: LANE } }, rerunNamed: { [X]: [[{ name: 's ok', status: 'passed' }, { name: 's flaky', status: 'skipped' }]] } });
    const r = rec(await runVerify(input({ kind: 'main', pr: 0, baseSha: HEAD, isolation: undefined }), f.seams));
    expect(r.record.outcome).toBe('success');
    expect(r.record.flakyRetried![0]).toMatchObject({ failedTests: ['s flaky'], soloPassedByName: [] });

    const twice: NamedTest[] = [{ name: 'd', status: 'failed' }, { name: 'd', status: 'failed' }];
    const once = fake({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: twice } }, rerunNamed: { [X]: [[{ name: 'd', status: 'passed' }, { name: 'e', status: 'passed' }]] } });
    expect(rec(await runVerify(input({ kind: 'main', pr: 0, baseSha: HEAD, isolation: undefined }), once.seams)).record.flakyRetried![0]).toMatchObject({ failedTests: ['d', 'd'], failedTestsTotal: 2, soloPassedByName: [] });
    const both = fake({ laneNamed: { unit: { [A]: [{ name: 'a', status: 'passed' }], [X]: twice } }, rerunNamed: { [X]: [[{ name: 'd', status: 'passed' }, { name: 'd', status: 'passed' }]] } });
    expect(rec(await runVerify(input({ kind: 'main', pr: 0, baseSha: HEAD, isolation: undefined }), both.seams)).record.flakyRetried![0]).toMatchObject({ soloPassedByName: ['d', 'd'] });
  });
});

describe('runVerify — fail-fast across lanes (PR verifies)', () => {
  const vitestCalls = (f: ReturnType<typeof fake>) => f.execCalls.filter((c) => c.command.endsWith('vitest'));
  it('a lane that fails for real stops the lanes still running; the first reason is the real failure', async () => {
    const f = fake({ laneStatuses: { unit: ['failed'] }, rerun: { 'tests/unit/a.test.ts': ['failed'] }, hang: ['integration', 'e2e'] });
    const r = await runVerify(input({ failFast: true }), f.seams);
    expect(r.kind).toBe('record');
    if (r.kind !== 'record') return;
    expect(r.record.outcome).toBe('failure');
    expect(r.reasons[0]).toMatch(/^lane-failed:unit/);
    expect(r.reasons).toContain('lane-stopped-early:integration');
    expect(r.reasons).toContain('lane-stopped-early:e2e');
    expect(r.reasons.some((x) => x.startsWith('file-not-run:'))).toBe(false);
    expect(f.logs.some((l) => l.event === 'lanes-stop' && l.after === 'unit')).toBe(true);
  });
  it('a flake cleared by its isolation re-run does not stop the other lanes', async () => {
    const f = fake({ laneStatuses: { integration: ['passed', 'failed'] } });
    const r = await runVerify(input({ failFast: true }), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    expect(f.logs.some((l) => l.event === 'lanes-stop')).toBe(false);
  });
  it('without failFast a real failure stops nothing: every lane runs to the end', async () => {
    const f = fake({ laneStatuses: { unit: ['failed'] }, rerun: { 'tests/unit/a.test.ts': ['failed'] } });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(r.kind === 'record' && r.reasons.some((x) => x.startsWith('lane-stopped-early'))).toBe(false);
    expect(f.logs.some((l) => l.event === 'lanes-stop')).toBe(false);
    expect(vitestCalls(f).length).toBeGreaterThanOrEqual(4);
  });
  it('a lane with a clean report and a null exit (killed by a signal) is not a failure, so nothing stops', async () => {
    const f = fake({ laneExit: { unit: null } });
    const r = await runVerify(input({ failFast: true }), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    expect(f.logs.some((l) => l.event === 'lanes-stop')).toBe(false);
  });
  it('an isolation re-run still running when another lane fails is stopped and counts as failing', async () => {
    const f = fake({
      laneStatuses: { unit: ['failed'], integration: ['passed', 'failed'] },
      rerun: { 'tests/unit/a.test.ts': ['failed'] },
      rerunHang: ['tests/integration/b.test.ts'],
      diff: 'M\tsrc/index.ts\n',
      imports: { 'tests/unit/a.test.ts': ['src/other.ts'] },
      hang: ['e2e'],
    });
    const r = await runVerify(input({ failFast: true }), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(f.logs.some((l) => l.event === 'isolation-rerun' && l.outcome === 'stopped')).toBe(true);
  });
  it('a main verify never stops lanes early for a failure, even with failFast set', async () => {
    const f = fake({ laneStatuses: { unit: ['failed'] }, rerun: { 'tests/unit/a.test.ts': ['failed'] } });
    const r = await runVerify(input({ kind: 'main', pr: 0, baseSha: HEAD, isolation: undefined, failFast: true }), f.seams);
    expect(r.kind === 'record' && r.reasons.some((x) => x.startsWith('lane-stopped-early'))).toBe(false);
    expect(f.logs.some((l) => l.event === 'lanes-stop')).toBe(false);
  });
});

describe('runVerify — a lane deadline (brainstorm 2026-11-12 E2)', () => {
  it('stops the sibling lanes at once, with or without failFast, and the run is a deadline error', async () => {
    for (const failFast of [false, true]) {
      const f = fake({ durations: { integration: LOCAL_VERIFY_DEADLINES.lanes.integration + 1 }, hang: ['e2e'] });
      const r = await runVerify(input({ failFast, laneShards: { integration: 1, e2e: 1 } }), f.seams);
      expect(r.kind === 'record' && r.record.outcome).toBe('error');
      expect(r.kind === 'record' && r.record.errorStep).toBe('deadline:integration');
      expect(f.logs.some((l) => l.event === 'lanes-stop' && l.reason === 'deadline' && l.after === 'integration')).toBe(true);
      expect(f.logs.some((l) => l.event === 'lane-stopped-early' && l.lane === 'e2e')).toBe(true);
    }
  });
  it('names the test files still running at the kill, from the reporter\'s progress file', async () => {
    const f = fake({ durations: { integration: LOCAL_VERIFY_DEADLINES.lanes.integration + 1 } });
    const exec = f.seams.exec;
    f.seams.exec = async (c, a, o) => {
      const progress = o.env.LOCAL_VERIFY_PROGRESS_FILE;
      if (progress && a.some((x) => x.includes('integration'))) {
        f.files.set(progress, JSON.stringify({ v: 1, writtenAt: 0, finishedFiles: 41, running: [
          { file: path.join(P.runDir, 'tests/integration/slow.test.ts'), startedAt: f.now() },
        ] }));
      }
      return exec(c, a, o);
    };
    const r = await runVerify(input({ laneShards: { integration: 1, e2e: 1 } }), f.seams);
    expect(r.kind === 'record' && r.record.errorStep).toBe('deadline:integration');
    const ev = f.logs.find((l) => l.event === 'deadline-in-flight');
    expect(ev).toMatchObject({ step: 'integration', finishedFiles: 41 });
    expect((ev as { running: Array<{ file: string }> }).running[0].file).toBe('tests/integration/slow.test.ts');
    expect(r.kind === 'record' && r.reasons[0]).toMatch(/still running: tests\/integration\/slow\.test\.ts \(\d+s\)/);
  });
  it('an oversized progress file is ignored (unknown)', async () => {
    const f = fake({ durations: { integration: LOCAL_VERIFY_DEADLINES.lanes.integration + 1 } });
    const exec = f.seams.exec;
    f.seams.exec = async (c, a, o) => {
      const progress = o.env.LOCAL_VERIFY_PROGRESS_FILE;
      if (progress && a.some((x) => x.includes('integration'))) f.files.set(progress, ' '.repeat(70 * 1024));
      return exec(c, a, o);
    };
    await runVerify(input({ laneShards: { integration: 1, e2e: 1 } }), f.seams);
    expect(f.logs.find((l) => l.event === 'deadline-in-flight')).toMatchObject({ unknown: true });
  });
  it('an unreadable progress file is recorded as unknown, never as nothing running', async () => {
    const f = fake({ durations: { integration: LOCAL_VERIFY_DEADLINES.lanes.integration + 1 } });
    const r = await runVerify(input({ laneShards: { integration: 1, e2e: 1 } }), f.seams);
    expect(r.kind === 'record' && r.record.errorStep).toBe('deadline:integration');
    expect(f.logs.find((l) => l.event === 'deadline-in-flight')).toMatchObject({ unknown: true });
  });
});

describe('runVerify — balanced shards from duration history', () => {
  const INT = ['tests/integration/b.test.ts', 'tests/integration/b2.test.ts', 'tests/integration/b3.test.ts'];
  const E2E = ['tests/e2e/c.test.ts', 'tests/e2e/c2.test.ts', 'tests/e2e/c3.test.ts', 'tests/e2e/c4.test.ts'];
  const many = (fs: string[]) => Object.fromEntries(fs.map((f) => [f, ['passed']]));
  it('with history covering the lane, each shard gets an explicit file list: every file exactly once, and the run passes', async () => {
    const f = fake({ laneFiles: { integration: many(INT), e2e: many(E2E) } });
    const hist = Object.fromEntries([...INT, ...E2E].map((x, i) => [x, 1000 * (i + 1)]));
    f.files.set(P.durationsPath, JSON.stringify(hist));
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    const byLane = (lane: string) => f.shardLists.filter((s) => s.lane === lane).map((s) => s.files);
    expect(byLane('integration')).toHaveLength(LOCAL_VERIFY_LIMITS.integrationShards);
    expect(byLane('e2e')).toHaveLength(E2E_N);
    expect(byLane('integration').flat().sort()).toEqual([...INT].sort());
    expect(byLane('e2e').flat().sort()).toEqual([...E2E].sort());
    expect(f.logs.filter((l) => l.event === 'shard-plan').every((l) => l.balanced === true)).toBe(true);
  });
  it('without history it falls back to vitest --shard and logs an unbalanced plan', async () => {
    const f = fake();
    await runVerify(input(), f.seams);
    expect(f.shardLists).toHaveLength(0);
    expect(f.logs.some((l) => l.event === 'shard-plan' && l.balanced === false)).toBe(true);
  });
  it('records unit files in the duration history too (borrowed-unit-slices spec, A), and logs the unit wall factor', async () => {
    const f = fake();
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    const hist = JSON.parse(f.files.get(P.durationsPath) as string) as Record<string, number>;
    expect(Object.keys(hist)).toEqual(expect.arrayContaining(['tests/unit/a.test.ts', 'tests/integration/b.test.ts', 'tests/e2e/c.test.ts']));
    const wf = f.logs.find((l) => l.event === 'unit-wall-factor');
    expect(wf).toMatchObject({ workers: LOCAL_VERIFY_LIMITS.unitWorkersParallel });
    expect(typeof wf?.factor).toBe('number');
  });
  it('unit entries in the history never change a slow lane\'s shard plan', async () => {
    const withUnit = fake({ laneFiles: { integration: many(INT), e2e: many(E2E) } });
    const without = fake({ laneFiles: { integration: many(INT), e2e: many(E2E) } });
    const hist = Object.fromEntries([...INT, ...E2E].map((x, i) => [x, 1000 * (i + 1)]));
    without.files.set(P.durationsPath, JSON.stringify(hist));
    withUnit.files.set(P.durationsPath, JSON.stringify({ ...hist, 'tests/unit/a.test.ts': 999_999, 'tests/unit/z.test.ts': 1 }));
    await runVerify(input(), withUnit.seams);
    await runVerify(input(), without.seams);
    const lists = (f: ReturnType<typeof fake>) => f.shardLists.map((s) => `${s.lane}:${s.files.join(',')}`).sort();
    expect(lists(withUnit)).toEqual(lists(without));
  });
  it('an unreadable history file is ignored, never a failure', async () => {
    const f = fake();
    f.files.set(P.durationsPath, '{not json');
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
  });
});

describe('runVerify — lane shard counts from the run input (monitoring.localVerify.laneShards)', () => {
  const vitestCalls = (f: ReturnType<typeof fake>) => f.execCalls.filter((c) => c.command.endsWith('vitest'));
  it('{ integration: 1, e2e: 2 } restores the pre-2026-10-27 split', async () => {
    const f = fake();
    const r = await runVerify(input({ laneShards: { integration: 1, e2e: 2 } }), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    expect(vitestCalls(f)).toHaveLength(4);
    expect(vitestCalls(f).filter((c) => c.args.includes('vitest.integration.config.ts')).every((c) => !c.args.some((a) => a.startsWith('--shard=')))).toBe(true);
  });
  it('runs five integration processes when explicitly configured', async () => {
    const f = fake();
    const r = await runVerify(input({ laneShards: { integration: 5 } }), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    expect(vitestCalls(f).filter((c) => c.args.includes('vitest.integration.config.ts'))).toHaveLength(5);
  });
  it('out-of-range or non-integer counts fall back to the defaults', async () => {
    const f = fake();
    await runVerify(input({ laneShards: { integration: 9, e2e: 1.5 } }), f.seams);
    expect(vitestCalls(f)).toHaveLength(LANE_PROCS);
  });
});

describe('runVerify — balanced shards: overlapping paths and a hostile history', () => {
  it('a file whose path contains another file\'s path shares its shard, so nothing runs twice', async () => {
    const INT = ['tests/integration/a.test.ts', 'tests/integration/nested/tests/integration/a.test.ts', 'tests/integration/b.test.ts', 'tests/integration/c.test.ts'];
    const f = fake({ laneFiles: { integration: Object.fromEntries(INT.map((x) => [x, ['passed']])) } });
    f.files.set(P.durationsPath, JSON.stringify(Object.fromEntries(INT.map((x) => [x, 1000]))));
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    expect(f.logs.some((l) => l.event === 'file-in-multiple-shards')).toBe(false);
  });
  it('an oversized history file is ignored unread (logged), and the lanes fall back to --shard', async () => {
    const f = fake();
    f.files.set(P.durationsPath, 'x'.repeat(2 * 1024 * 1024 + 1));
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('success');
    expect(f.logs.some((l) => l.event === 'durations-ignored')).toBe(true);
    expect(f.shardLists).toHaveLength(0);
  });
});

describe('a main verify\'s per-file counts for the baseline results (spec local-verify-borrowed-slices-count.md, F "Baseline results")', () => {
  const mainInput = (over: Partial<VerifyRunInput> = {}) => input({ kind: 'main', pr: 0, baseSha: HEAD, isolation: undefined, ...over });
  const strip = (r: VerifyRunResult) => { if (r.kind !== 'record') throw new Error(r.kind); const { fileCounts: _fc, ...rest } = r; void _fc; return rest; };

  it('with the option, every clean file gets its four counts and a names-and-outcomes digest; the record and everything else equal a run without it', async () => {
    const without = await runVerify(mainInput(), fake().seams);
    const withCounts = await runVerify(mainInput({ fileCounts: true }), fake().seams);
    expect(without.kind === 'record' && 'fileCounts' in without).toBe(false);
    if (withCounts.kind !== 'record') throw new Error(withCounts.kind);
    expect(Object.keys(withCounts.fileCounts!).sort()).toEqual([...TEST_FILES].sort());
    for (const row of Object.values(withCounts.fileCounts!)) {
      expect(row.slice(0, 4).every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)).toBe(true);
      expect(row[4]).toMatch(/^[0-9a-f]{64}$/);
    }
    // Identical apart from the added field (the fake clock gives both runs the same times).
    expect(strip(withCounts)).toEqual(strip(without));
    expect(withCounts.record.outcome).toBe('success');
  });

  it('the digest is the lane report\'s own outcome digest of that file', async () => {
    const r = await runVerify(mainInput({ fileCounts: true }), fake({ laneStatuses: { unit: ['passed', 'skipped', 'todo'] } }).seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    const row = r.fileCounts!['tests/unit/a.test.ts'];
    expect(row.slice(0, 4)).toEqual([1, 0, 1, 1]);
    expect(row[4]).toBe(parseVitestJson(vitestReport('tests/unit/a.test.ts', ['passed', 'skipped', 'todo']), P.runDir, { outcomeDigest: true }).files.get('tests/unit/a.test.ts')!.outcomeDigest);
  });

  it('a file that failed in its lane has no row, even when it passed alone afterwards and the verify is green', async () => {
    const r = await runVerify(mainInput({ fileCounts: true }), fake({ laneStatuses: { integration: ['passed', 'failed'] } }).seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    expect(r.record.outcome).toBe('success');
    expect(r.record.flakyRetried?.map((x) => x.file)).toEqual(['tests/integration/b.test.ts']);
    expect(Object.keys(r.fileCounts!).sort()).toEqual(['tests/e2e/c.test.ts', 'tests/unit/a.test.ts']);
  });

  it('a verify of a waiting change never reports them, whatever its input says', async () => {
    const r = await runVerify(input({ fileCounts: true }), fake().seams);
    expect(r.kind === 'record' && 'fileCounts' in r).toBe(false);
  });
});

describe('runVerify — first parts on the shared fake (spec local-verify-likely-failing-first.md)', () => {
  const UNIT = { 'tests/unit/a.test.ts': ['passed'], 'tests/unit/b.test.ts': ['passed'], 'tests/unit/c.test.ts': ['passed'] };
  const vitestArgs = (f: ReturnType<typeof fake>) => f.execCalls.filter((c) => c.args.includes('--config')).map((c) => c.args);

  it('the setting off, an unassigned or `without` pull request, and a main verify all run exactly the commands of a verify without the block', async () => {
    const plain = fake({ laneFiles: { unit: UNIT } });
    const base = await runVerify(input(), plain.seams);
    const variants: Array<Partial<VerifyRunInput>> = [
      { likelyFailingFirst: { setting: 'alternate', group: 'without', previous: [], list: ['tests/unit/b.test.ts'] } },
      { likelyFailingFirst: { setting: 'alternate', previous: [], list: ['tests/unit/b.test.ts'] } },
    ];
    for (const v of variants) {
      const f = fake({ laneFiles: { unit: UNIT } });
      const r = await runVerify(input(v), f.seams);
      expect(vitestArgs(f)).toEqual(vitestArgs(plain));
      if (r.kind !== 'record' || base.kind !== 'record') throw new Error('expected records');
      expect(r.record).toEqual({ ...base.record, firstPart: { setting: 'alternate', group: 'without', ran: false } });
      expect(r.reasons).toEqual(base.reasons);
    }
    const mainPlain = fake({ laneFiles: { unit: UNIT } });
    await runVerify(input({ kind: 'main', pr: 0, baseSha: HEAD }), mainPlain.seams);
    const mainWith = fake({ laneFiles: { unit: UNIT } });
    await runVerify(input({ kind: 'main', pr: 0, baseSha: HEAD, likelyFailingFirst: { setting: 'on', previous: [], list: ['tests/unit/b.test.ts'] } }), mainWith.seams);
    expect(vitestArgs(mainWith)).toEqual(vitestArgs(mainPlain));
  });

  it('with the setting on: `<lane>-first` runs the named files, the rest excludes them, and every file is reported once', async () => {
    const f = fake({ laneFiles: { unit: UNIT }, diff: 'M\tsrc/index.ts\n' });
    const r = await runVerify(input({ likelyFailingFirst: { setting: 'on', previous: [], list: ['tests/unit/b.test.ts'] } }), f.seams);
    expect(r.kind).toBe('record');
    if (r.kind !== 'record') return;
    expect(r.record.outcome).toBe('success');
    const unitCalls = vitestArgs(f).filter((a) => a.includes('vitest.config.ts'));
    expect(unitCalls).toHaveLength(2);
    expect(unitCalls[0].some((a) => a.endsWith('/unit-first.json'))).toBe(true);
    expect(unitCalls[0].at(-1)).toBe('tests/unit/b.test.ts');
    expect(unitCalls[1].some((a) => a.endsWith('/unit.json'))).toBe(true);
    expect(unitCalls[1]).toContain('--exclude=tests/unit/b.test.ts');
    expect(r.record.lanes.find((l) => l.name === 'unit')).toMatchObject({ files: 3, failed: 0 });
    const steps = f.logs.filter((l) => l.event === 'step').map((l) => l.step);
    expect(steps).toEqual(expect.arrayContaining(['unit-first', 'unit']));
  });
});


it.each(['collection', 'assembly', 'invalid field', 'inconsistent field', 'throwing field', 'logging'])('evidence failure during %s cannot change completion', async (fault) => {
  const opts = { laneFiles: { unit: { 'tests/unit/a.test.ts': ['failed'] } } };
  const baseline = await runVerify(input(), fake(opts).seams);
  const f = fake(opts); const inp = input();
  let restore = () => {};
  if (fault === 'collection' || fault === 'logging') {
    if (fault === 'logging') {
      const log = f.seams.log;
      f.seams.log = (e) => { if (e.event === 'first-part-evidence-incomplete') throw new Error('audit unavailable'); log(e); };
    }
    const set = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function(this: Map<any, any>, key, value) {
      if (value?.result === 'failed') throw new Error('collection unavailable');
      return set.call(this, key, value);
    }); restore = () => spy.mockRestore();
  } else if (fault === 'assembly') {
    const values = Map.prototype.values;
    const spy = vi.spyOn(Map.prototype, 'values').mockImplementation(function(this: Map<any, any>) {
      if ([...values.call(this)].some((v) => v?.result === 'failed')) throw new Error('assembly unavailable');
      return values.call(this);
    }); restore = () => spy.mockRestore();
  } else if (fault === 'invalid field') inp.firstPartEvidence = { setting: 'bad', group: 'with', ran: false } as any;
  else if (fault === 'inconsistent field') {
    inp.firstPartEvidence = { setting: 'off', group: 'with', ran: false };
    inp.likelyFailingFirst = { setting: 'on', list: ['tests/unit/a.test.ts'], previous: [] };
  }
  else Object.defineProperty(inp, 'firstPartEvidence', { get: () => { throw new Error('unreadable evidence'); } });
  try {
    const result = await runVerify(inp, f.seams);
    expect(result.kind).toBe('record'); expect(baseline.kind).toBe('record');
    if (result.kind !== 'record' || baseline.kind !== 'record') return;
    expect(result.record.outcome).toBe(baseline.record.outcome);
    expect(result.record.lanes).toEqual(baseline.record.lanes);
    expect(result.observation?.incomplete).toBe(true);
    if (fault !== 'logging') expect(f.logs.some((e) => e.event === 'first-part-evidence-incomplete')).toBe(true);
    if (fault.includes('field')) expect(result.record.firstPart).toBeUndefined();
  } finally { restore(); }
});

// ── A borrowed helper in the verify's lane flow (spec local-verify-borrowed-slices-count.md, F) ──

describe('runVerify with a borrowed helper (the lane flow)', () => {
  const UNIT3: Record<string, string[]> = { 'tests/unit/a.test.ts': ['passed'], 'tests/unit/p.test.ts': ['passed'], 'tests/unit/q.test.ts': ['passed'] };
  const DIG = '7'.repeat(64);
  const BLOB = '9'.repeat(40);
  const BORROWED = { port: 4040, token: '1'.repeat(32), baselines: [{ commit: BASE, finishedAt: '2026-11-20T00:00:00.000Z', machineId: 'm_studio', files: { 'tests/unit/p.test.ts': [1, 0, 0, 0, DIG] as [number, number, number, number, string], 'tests/unit/q.test.ts': [1, 0, 0, 0, DIG] as [number, number, number, number, string] } }] };
  // The baseline's commit and the merge tree hold the same content for p and q (same blob ids).
  const gitOverride = (args: string[]): GitResult | null => (args[0] === 'ls-tree' && args[1] === '-r' && args[2] !== '--name-only'
    ? { status: 0, stdout: `100644 blob ${BLOB}\ttests/unit/p.test.ts\n100644 blob ${BLOB}\ttests/unit/q.test.ts\n`, stderr: '', timedOut: false } : null);
  const lane = { state: 'counting', mayCount: true, proven: true, share: 0.5, uncovered: [] as string[] };
  const planBody = (assigned: 'counting' | 'compare-only') => ({
    ok: true, helper: 'm_laptop', mode: 'count', assigned, answered: true, lanes: { unit: { ...lane }, integration: { ...lane, proven: false }, e2e: { ...lane, proven: false } },
    spotOneIn: 1_000_000, learned: [], throughput: 100, prepMs: 0, workersFree: 4,
  });
  const canaryPerFile = BORROWED_CANARY_FILES.map((f) => ({ file: f, tests: 1, ...BORROWED_CANARY[f], ms: 1, digest: DIG, failedTests: [] }));

  /** A fake server proxy; `perFile` answers each non-check slice (null: never answered). The unit lane waits until a counting slice is queued. */
  function harness(o: { assigned?: 'counting' | 'compare-only'; perFile?: (f: string) => Record<string, unknown> | null; throwing?: boolean } = {}) {
    const f = fake({ laneFiles: { unit: UNIT3 }, gitOverride });
    const calls: Array<Record<string, unknown>> = [];
    const slices: Array<{ id: string; files: string[]; use: string }> = [];
    let n = 0;
    let sliceSeen!: () => void;
    const sliceQueued = new Promise<void>((r) => { sliceSeen = r; });
    f.seams.borrowedProxy = () => async (b) => {
      calls.push(b);
      if (o.throwing) throw new Error('proxy down');
      if (b.op === 'plan') return planBody(o.assigned ?? 'counting');
      if (b.op === 'slice') {
        const id = (++n).toString(16).padStart(32, '0');
        slices.push({ id, files: b.files as string[], use: b.use as string });
        if (b.use !== 'check') sliceSeen();
        return { ok: true, attemptId: id, state: 'queued' };
      }
      if (b.op === 'status') {
        const results = slices.flatMap((s, i) => {
          if (s.use === 'check') return [{ seq: i + 1, attemptId: s.id, valid: true, state: 'done', treeHash: TREE, slice: { exitCode: 1, unhandledErrors: 1, collected: true }, perFile: canaryPerFile }];
          const per = s.files.map((x) => o.perFile?.(x) ?? null);
          if (per.some((x) => x === null)) return [];
          return [{ seq: i + 1, attemptId: s.id, valid: true, state: 'done', treeHash: TREE, slice: { exitCode: 0, unhandledErrors: 0, collected: true }, perFile: per }];
        });
        return { ok: true, tree: { state: 'ready', treeHash: TREE }, results };
      }
      return { ok: true };
    };
    f.seams.borrowedSleep = () => new Promise<void>((r) => setImmediate(r));
    const realExec = f.seams.exec;
    f.seams.exec = async (command, args, opts) => {
      // The unit lane's own process runs while the helper works (a real lane takes minutes): it waits for the first counting slice, bounded.
      if (args.includes('vitest.config.ts') && !args.some((a) => a.includes('-back') || a.includes('-rerun-'))) {
        await Promise.race([sliceQueued, new Promise<void>((r) => setTimeout(r, 200))]);
        for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
      }
      return realExec(command, args, opts);
    };
    return { f, calls, slices };
  }
  const unitRuns = (f: ReturnType<typeof fake>) => f.execCalls.filter((c) => c.args.includes('vitest.config.ts')).map((c) => c.args);
  const passOf = (file: string, digest = DIG) => ({ file, tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, ms: 5, digest, failedTests: [] });

  it('a silent or throwing proxy: the record and the commands equal a verify without a helper', async () => {
    const plain = fake({ laneFiles: { unit: UNIT3 }, gitOverride });
    const base = await runVerify(input(), plain.seams);
    for (const throwing of [true, false]) {
      const h = harness({ throwing });
      if (!throwing) h.f.seams.borrowedProxy = () => async () => null;
      const r = await runVerify(input({ borrowed: BORROWED }), h.f.seams);
      if (r.kind !== 'record' || base.kind !== 'record') throw new Error('records expected');
      expect(r.record).toEqual(base.record);
      expect(unitRuns(h.f)).toEqual(unitRuns(plain));
      expect(r.borrowed).toBeUndefined();
    }
  });

  it('counting: an accepted pass is held out of the local process and enters the report; the record names the helper', async () => {
    const h = harness({ perFile: (f) => passOf(f) });
    const r = await runVerify(input({ borrowed: BORROWED }), h.f.seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    expect(r.record.outcome).toBe('success');
    const counted = r.borrowed!.lanes.unit!.counted;
    expect(counted.length).toBeGreaterThan(0);
    // The held-out file was excluded from the unit process and never run here.
    const runs = unitRuns(h.f);
    expect(runs).toHaveLength(1);
    for (const c of counted) expect(runs[0]).toContain(`--exclude=${c}`);
    expect(r.record.lanes.find((l) => l.name === 'unit')!.files).toBe(3);
    expect(r.record.borrowed).toMatchObject({ helper: 'm_laptop', assigned: 'counting', lanes: [{ lane: 'unit', files: counted.length }] });
    expect(h.slices[0].use).toBe('check');
  });

  it('counting with a helper that never answers: the shard takes its portion back and runs it in a second process', async () => {
    const h = harness({ perFile: () => null });
    const r = await runVerify(input({ borrowed: BORROWED }), h.f.seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    expect(r.record.outcome).toBe('success');
    const runs = unitRuns(h.f);
    expect(runs).toHaveLength(2);
    expect(runs[1].some((a) => a.endsWith('/unit-back.json'))).toBe(true);
    expect(r.borrowed!.lanes.unit!.counted).toEqual([]);
    expect(r.borrowed!.lanes.unit!.takenBack).toBeGreaterThan(0);
    expect(r.record.lanes.find((l) => l.name === 'unit')!.files).toBe(3);
    expect(h.calls.some((c) => c.op === 'cancel')).toBe(true);
  });

  it('a pass whose digest differs from the baseline is not a pass: taken back and run here', async () => {
    const h = harness({ perFile: (f) => passOf(f, '8'.repeat(64)) });
    const r = await runVerify(input({ borrowed: BORROWED }), h.f.seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    expect(r.borrowed!.lanes.unit!.counted).toEqual([]);
    expect(unitRuns(h.f)).toHaveLength(2);
  });

  it('compare-only (the one in ten): every file runs here, and the helper\'s results are compared by digest', async () => {
    const local = parseVitestJson(vitestReportMany({ 'tests/unit/p.test.ts': ['passed'] }), P.runDir, { outcomeDigest: true }).files.get('tests/unit/p.test.ts')!.outcomeDigest!;
    const h = harness({ assigned: 'compare-only', perFile: (f) => passOf(f, local) });
    const r = await runVerify(input({ borrowed: BORROWED }), h.f.seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    expect(unitRuns(h.f)).toHaveLength(1);
    expect(unitRuns(h.f)[0].some((a) => a.startsWith('--exclude='))).toBe(false);
    expect(r.borrowed!.assigned).toBe('compare-only');
    expect(r.borrowed!.lanes.unit!.counted).toEqual([]);
    expect(r.borrowed!.lanes.unit!.agreed.length).toBeGreaterThan(0);
    expect(r.record.borrowed?.assigned).toBe('compare-only');
  });

  it('a main verify, and a change that edits the check fixtures, never ask the helper', async () => {
    const m = harness({ perFile: (f) => passOf(f) });
    await runVerify(input({ kind: 'main', pr: 0, baseSha: HEAD, isolation: undefined, borrowed: BORROWED }), m.f.seams);
    expect(m.calls).toEqual([]);
    const h = harness({ perFile: (f) => passOf(f) });
    h.f.seams.git = ((orig) => async (args, opts) => (args[0] === 'diff' ? { status: 0, stdout: 'M\ttests/fixtures/borrowed-canary/canary-pass.test.ts\n', stderr: '', timedOut: false } : orig(args, opts)))(h.f.seams.git);
    await runVerify(input({ borrowed: BORROWED }), h.f.seams);
    expect(h.calls).toEqual([]);
  });
});

describe('runVerify with a borrowed helper: the mass rule is the whole verify\'s', () => {
  it('a counting lane that ended early gives its passes back when a later lane takes the verify past five disagreements', async () => {
    const DIG = '7'.repeat(64);
    const BLOB = '9'.repeat(40);
    const UNIT3: Record<string, string[]> = { 'tests/unit/a.test.ts': ['passed'], 'tests/unit/p.test.ts': ['passed'], 'tests/unit/q.test.ts': ['passed'] };
    const INT: Record<string, string[]> = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`tests/integration/i${i}.test.ts`, ['passed']]));
    const BORROWED = { port: 4040, token: '1'.repeat(32), baselines: [{ commit: BASE, finishedAt: '2026-11-20T00:00:00.000Z', machineId: 'm_studio', files: { 'tests/unit/p.test.ts': [1, 0, 0, 0, DIG] as [number, number, number, number, string], 'tests/unit/q.test.ts': [1, 0, 0, 0, DIG] as [number, number, number, number, string] } }] };
    const gitOverride = (args: string[]): GitResult | null => (args[0] === 'ls-tree' && args[1] === '-r' && args[2] !== '--name-only'
      ? { status: 0, stdout: `100644 blob ${BLOB}\ttests/unit/p.test.ts\n100644 blob ${BLOB}\ttests/unit/q.test.ts\n`, stderr: '', timedOut: false } : null);
    const f = fake({ laneFiles: { unit: UNIT3, integration: INT }, gitOverride });
    const lane = { state: 'counting', mayCount: true, proven: true, share: 0.5, uncovered: [] as string[] };
    const canary = BORROWED_CANARY_FILES.map((x) => ({ file: x, tests: 1, ...BORROWED_CANARY[x], ms: 1, digest: DIG, failedTests: [] }));
    const slices: Array<{ id: string; files: string[]; use: string; lane: string }> = [];
    let n = 0;
    f.seams.borrowedProxy = () => async (b) => {
      if (b.op === 'plan') return { ok: true, helper: 'm_laptop', mode: 'count', assigned: 'counting', answered: true, lanes: { unit: { ...lane }, integration: { ...lane, mayCount: false, state: 'practice' }, e2e: { ...lane, proven: false } }, spotOneIn: 1_000_000, learned: [], throughput: 100, prepMs: 0, workersFree: 4, workersMax: 4 };
      if (b.op === 'slice') { const id = (++n).toString(16).padStart(32, '0'); slices.push({ id, files: b.files as string[], use: b.use as string, lane: b.lane as string }); return { ok: true, attemptId: id, state: 'queued' }; }
      if (b.op === 'status') {
        return { ok: true, tree: { state: 'ready', treeHash: TREE }, results: slices.map((s, i) => ({
          seq: i + 1, attemptId: s.id, valid: true, state: 'done', treeHash: TREE,
          slice: s.use === 'check' ? { exitCode: 1, unhandledErrors: 1, collected: true } : { exitCode: 0, unhandledErrors: 0, collected: true },
          // Unit: a pass with the baseline's digest. Integration (compare): passes whose digest differs from this machine's.
          perFile: s.use === 'check' ? canary : s.files.map((x) => ({ file: x, tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, ms: 5, digest: s.lane === 'unit' ? DIG : '8'.repeat(64), failedTests: [] })),
        })) };
      }
      return { ok: true };
    };
    f.seams.borrowedSleep = () => new Promise<void>((r) => setImmediate(r));
    let counted!: () => void;
    const unitCounted = new Promise<void>((r) => { counted = r; });
    const log = f.seams.log;
    f.seams.log = (e) => { if (e.event === 'borrowed-counted') counted(); log(e); };
    const realExec = f.seams.exec;
    f.seams.exec = async (command, args, opts) => {
      const unit = args.includes('vitest.config.ts');
      const integration = args.some((a) => a.includes('integration')) && !args.some((a) => a.includes('-rerun-'));
      // The unit lane waits for its counting slice; the integration lane ends only after the unit lane admitted its passes.
      if (unit && !args.some((a) => a.includes('-final') || a.includes('-back') || a.includes('-rerun-'))) {
        for (let i = 0; i < 200 && !slices.some((s) => s.use === 'count'); i++) await new Promise<void>((r) => setTimeout(r, 1));
        for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
      }
      if (integration) await Promise.race([unitCounted, new Promise<void>((r) => setTimeout(r, 2_000))]);
      return realExec(command, args, opts);
    };
    const r = await runVerify(input({ borrowed: BORROWED }), f.seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    expect(r.borrowed!.disagreements).toBeGreaterThan(5);
    // The unit lane's passes were taken back after every lane ended, and run here in a final pass.
    expect(f.execCalls.some((c) => c.args.some((a) => a.endsWith('/unit-final.json')))).toBe(true);
    expect(r.borrowed!.lanes.unit!.counted).toEqual([]);
    expect(r.borrowed!.lanes.unit!.finalLocalPass).toBe(true);
    expect(f.logs.some((e) => e.event === 'borrowed-final-local-pass' && e.after === 'all-lanes')).toBe(true);
    expect(r.record.lanes.find((l) => l.name === 'unit')!.files).toBe(3);
  });
});

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
import { describe, it, expect } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {
  runVerify, verifyPaths, splitScript, parseNameStatus, bareConfigTemplate,
  type OrchestratorSeams, type VerifyRunInput, type GitResult, type ExecResult,
} from '../../../src/localVerify/orchestrator.js';
import { LOCAL_VERIFY_DEADLINES, LOCAL_VERIFY_LIMITS } from '../../../src/localVerify/policy.js';

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

interface FakeOpts {
  /** Extra test files in the merge tree (reported by a test's own exec override). */
  extraTree?: string[];
  /** Per-step durations (ms) for exec steps, by step key: npm-ci, build, lint, unit, integration, e2e. */
  durations?: Partial<Record<string, number>>;
  gitTimeout?: string; // a git verb that times out
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
}

function fake(o: FakeOpts = {}) {
  let t = 1_700_000_000_000;
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const removed: string[] = [];
  const gitCalls: Array<{ args: string[]; cwd: string; gitDir: string; workTree?: string }> = [];
  const execCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; deadlineMs: number }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let holderCall = 0;
  let pid = 1000;

  files.set(path.join(P.runDir, 'package.json'), PKG);
  const shows: Record<string, string> = o.shows ?? {
    [`${HEAD}:package.json`]: PKG,
    [`${HEAD}:tests/unit/a.test.ts`]: UNIT_SRC,
    [`${MB}:tests/unit/a.test.ts`]: UNIT_SRC,
  };

  const gitImpl = (args: string[]): GitResult => {
    const ok = (stdout = ''): GitResult => ({ status: 0, stdout, stderr: '', timedOut: false });
    const verb = args[0];
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
        const extra = Object.values(o.laneFiles ?? {}).flatMap((m) => Object.keys(m ?? {}));
        return ok(['package.json', 'src/index.ts', ...TEST_FILES, ...extra, ...(o.extraTree ?? []), 'tests/fixtures/x.test.ts'].join('\n') + '\n');
      }
      case 'merge-base': return ok(`${MB}\n`);
      case 'diff': return ok(o.diff ?? 'M\ttests/unit/a.test.ts\nM\tsrc/index.ts\n');
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
      gitCalls.push({ args, cwd: opts.cwd, gitDir: opts.gitDir, workTree: opts.workTree });
      return gitImpl(args);
    },
    async exec(command, args, opts) {
      execCalls.push({ command, args, env: opts.env, deadlineMs: opts.deadlineMs });
      opts.onPid?.(++pid);
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
      const errFile = opts.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE;
      const isRerun = args.slice(1).some((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--config');
      if (errFile && args.includes('--reporter=/opt/instar/dist/localVerify/unhandledErrorsReporter.js')) {
        files.set(errFile, JSON.stringify({ v: 1, unhandledErrors: isRerun ? (o.rerunUnhandled ?? 0) : (o.unhandled?.[lane] ?? 0), messages: [] }));
      }
      const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--config');
      if (positional.length > 0) {
        // An isolation re-run of one file.
        const file = positional[0];
        const outcome = o.rerun?.[file] ?? ['passed'];
        const rd = o.rerunMs ?? 1000;
        if (outcome === 'deadline' || rd > opts.deadlineMs) { t += opts.deadlineMs; return { ...r(null), signal: 'SIGTERM', deadlineKilled: true }; }
        t += rd - dur; // (dur was already added)
        files.set(out, vitestReport(file, outcome, 'boom again'));
        return r(outcome.includes('failed') ? 1 : 0);
      }
      const shard = args.find((a) => a.startsWith('--shard='));
      if (shard && !shard.startsWith('--shard=1/')) {
        files.set(out, JSON.stringify({ testResults: [] }));
        return r(0);
      }
      const many = o.laneFiles?.[lane];
      if (many) {
        files.set(out, vitestReportMany(many));
        return r(Object.values(many).some((x) => x.includes('failed')) ? 1 : 0);
      }
      const file = TEST_FILES.find((f) => f.includes(`/${lane}/`))!;
      const statuses = o.laneStatuses?.[lane] ?? ['passed'];
      files.set(out, vitestReport(file, statuses));
      return r(statuses.includes('failed') ? 1 : 0);
    },
    fs: {
      exists: (p) => files.has(p) || dirs.has(p),
      mkdirp: (p) => { dirs.add(p); },
      writeFile: (p, d) => { files.set(p, d); },
      readFile: (p) => files.get(p) ?? (p.includes('/runs/') && p.endsWith('/package.json') ? PKG : null),
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
  return { seams, files, dirs, removed, gitCalls, execCalls, logs, now: () => t };
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
    expect(steps.map((s) => s.step)).toEqual(expect.arrayContaining(['npm-ci', 'build-lint', 'unit', 'integration', 'e2e-1', 'e2e-2']));
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
    expect(lanes.length).toBe(4); // unit, integration, e2e shard 1 and 2
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
    expect(lanes).toHaveLength(4);
    // The e2e lane runs as two shards; every lane process has its own TMPDIR and tmux server.
    expect(lanes.filter((l) => l.args.some((a) => a.startsWith('--shard='))).map((l) => l.args.find((a) => a.startsWith('--shard=')))).toEqual(['--shard=1/2', '--shard=2/2']);
    expect(new Set(lanes.map((l) => l.env.TMPDIR)).size).toBe(4);
    expect(new Set(lanes.map((l) => l.env.TMUX_TMPDIR)).size).toBe(4);
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
    expect(f.removed.filter((p) => p.startsWith('/tmp/lv-'))).toHaveLength(10);
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
    ['integration lane', { durations: { integration: LOCAL_VERIFY_DEADLINES.lanes.integration + 1 } }, 'deadline:integration'],
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
  it('a failed test that fails again on its isolation re-run is a failure and the worktree is kept', async () => {
    const r = await runVerify(input(), fake({ laneStatuses: { integration: ['passed', 'failed'] }, rerun: { 'tests/integration/b.test.ts': ['passed', 'failed'] } }).seams);
    expect(r.kind).toBe('record');
    if (r.kind !== 'record') return;
    expect(r.record.outcome).toBe('failure');
    expect(r.reasons).toContain('file-failed:tests/integration/b.test.ts:1');
    expect(r.keptWorktree).toBe(P.runDir);
  });
  it('a dirty tree after the lanes fails the run', async () => {
    const r = await runVerify(input(), fake({ porcelain: '?? tests/unit/leftover.txt\n' }).seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(r.kind === 'record' && r.reasons).toContain('dirty-tree');
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
    expect(order).toEqual(['hold', 'lane', 'lane', 'lane', 'lane', 'release']);
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
    expect(r.kind === 'record' && r.record).toMatchObject({ outcome: 'error', errorStep: 'deadline:integration' });
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
      if (!a.includes('--shard=1/2')) return res;
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
      if (!a.includes('--shard=2/2')) return res;
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
      if (a.includes('--shard=1/2')) return { ...res, status: null, signal: 'SIGKILL' };
      if (a.includes('--shard=2/2')) return { ...res, status: 1 };
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
      if (a.includes('--shard=2/2')) f.files.set(outFile(a), vitestReport(E2E, ['passed']));
      return res;
    };
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(f.logs.some((l) => l.event === 'file-in-multiple-shards' && l.file === E2E)).toBe(true);
  });
  it('a shard deadline waits for its sibling shard to exit before the slot is released', async () => {
    const f = fake({ durations: { e2e: LOCAL_VERIFY_DEADLINES.lanes.e2e + 1 } });
    const order: string[] = [];
    f.seams.holdSuiteSlot = async () => () => { order.push('release'); };
    const exec = f.seams.exec;
    f.seams.exec = async (c, a, o) => {
      if (a.includes('--shard=2/2')) {
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
  it('a busy slot leaves an overlap entry (the evidence a re-queue happened)', async () => {
    const f = fake();
    f.seams.holdSuiteSlot = async () => 'busy';
    const r = await runVerify(input(), f.seams);
    expect(r).toMatchObject({ kind: 'requeue', reason: 'foreign-suite-at-start' });
    expect(r.overlaps).toHaveLength(1);
  });
});

describe('runVerify — retention of failed worktrees', () => {
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
    expect(r.kind === 'record' && r.record.flakyRetried).toEqual([{ file: 'tests/integration/b.test.ts', lane: 'integration', firstMessage: expect.stringContaining('boom') }]);
    const calls = vitestCalls(f);
    expect(calls).toHaveLength(5);
    // The four lane processes start together; the re-run comes after its lane.
    const re = calls[4];
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
    expect(vitestCalls(f)).toHaveLength(4); // unit, integration, two e2e shards
    expect(f.logs.some((l) => l.event === 'isolation-rerun-skipped' && l.reason === 'too-many-failures')).toBe(true);
  });
  it('no re-run when the lane has another failure (a file that collected nothing)', async () => {
    const f = fake({ laneFiles: { unit: { 'tests/unit/a.test.ts': ['passed'], 'tests/unit/x.test.ts': ['failed'], 'tests/unit/z.test.ts': [] } } });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(4); // unit, integration, two e2e shards
  });
  it('the re-run respects the lane deadline: a re-run that hits it is a failure, never a pass or an error', async () => {
    const unitBudget = LOCAL_VERIFY_DEADLINES.lanes.unit;
    const f = fake({ laneStatuses: { unit: ['passed', 'failed'] }, durations: { unit: unitBudget - 30_000 }, rerunMs: 60_000, diff: 'M\tsrc/index.ts\n' });
    const r = await runVerify(input(), f.seams);
    if (r.kind !== 'record') throw new Error(r.kind);
    expect(r.record.outcome).toBe('failure');
    expect(r.failures?.[0].rerunMessage).toMatch(/deadline/);
    const re = vitestCalls(f)[4];
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
    expect(vitestCalls(f)).toHaveLength(6); // 4 lane processes + 2 re-runs
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
    expect(vitestCalls(f)).toHaveLength(4); // unit, integration, two e2e shards
    expect(f.logs.some((l) => l.event === 'isolation-rerun-skipped' && l.reason === 'related-to-change')).toBe(true);
  });
  it('a failed file that imports a file the PR changed is a real failure: no re-run', async () => {
    const f = fake({ ...oneFlake, diff: 'M\tsrc/core/thing.ts\n', imports: { 'tests/integration/b.test.ts': ['tests/helpers/h.ts', 'src/core/thing.ts'] } });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(4); // unit, integration, two e2e shards
  });
  it('a PR verify with no green main record on this machine never re-runs', async () => {
    const f = fake(oneFlake);
    const r = await runVerify(input({ isolation: { allowed: false, notCleanOnGreenMain: [] } }), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(4); // unit, integration, two e2e shards
  });
  it('a file that was not clean on the last green main is not re-run', async () => {
    const f = fake(oneFlake);
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
    expect(vitestCalls(f)).toHaveLength(4); // unit, integration, two e2e shards
    expect(f.logs.some((l) => l.event === 'isolation-rerun-skipped' && l.reason === 'unhandled-errors')).toBe(true);
  });
  it('an unknown unhandled-error count (no trusted reporter) means no re-run', async () => {
    const f = fake({ ...oneFlake, noReporter: true });
    const r = await runVerify(input(), f.seams);
    expect(r.kind === 'record' && r.record.outcome).toBe('failure');
    expect(vitestCalls(f)).toHaveLength(4); // unit, integration, two e2e shards
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

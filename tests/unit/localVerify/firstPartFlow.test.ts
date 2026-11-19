/**
 * The lane flow with first parts (spec docs/specs/local-verify-likely-failing-first.md,
 * sections A, C, D, E and F), driven through the real `runVerify` with fake seams.
 *
 * The fake test runner here models what vitest does with the lane commands: a named file is
 * matched by case-insensitive substring, `--exclude=<path>` removes exactly that path, and
 * `--shard=k/n` splits what is left. Every file has a scripted behaviour (pass, fail, fail in
 * its lane and pass alone, or depend on which other files share its process), so a run's
 * verdict can be compared with and without first parts.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVerify, verifyPaths, type ExecResult, type GitResult, type OrchestratorSeams, type VerifyRunInput, type VerifyRunResult } from '../../../src/localVerify/orchestrator.js';
import { evaluateRun, type LaneRunInput, type ParsedLaneReport } from '../../../src/localVerify/laneReport.js';
import { computeInventory } from '../../../src/localVerify/inventory.js';
import { LOCAL_VERIFY_DEADLINES, LOCAL_VERIFY_LIMITS } from '../../../src/localVerify/policy.js';
import type { FirstPartInput } from '../../../src/localVerify/firstPart.js';
import { compareFirstPartRuns } from '../../../src/localVerify/firstPartTrial.js';

const HOME = '/agents/echo';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MB = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const COMMIT = 'e'.repeat(40);
const MIN = 60_000;
const P = verifyPaths(HOME, HEAD);
const PKG = JSON.stringify({ name: 'instar', scripts: { build: 'tsc', lint: 'tsc --noEmit' }, devDependencies: { vitest: '^2.1.9' } });
const SRC = `import { it } from 'vitest'; it('a', () => {});`;
const REPORTER = '/opt/instar/dist/localVerify/unhandledErrorsReporter.js';

type Lane = 'unit' | 'integration' | 'e2e';
type Behaviour = 'pass' | 'fail' | 'flaky';
const u = (n: number) => `tests/unit/u${n}.test.ts`;
const i = (n: number) => `tests/integration/i${n}.test.ts`;
const e = (n: number) => `tests/e2e/e${n}.test.ts`;
const range = (n: number, f: (k: number) => string) => Array.from({ length: n }, (_, k) => f(k + 1));

interface Sim {
  files?: Partial<Record<Lane, string[]>>;
  /** What each file does (default pass). `flaky`: fails in a lane process, passes alone. */
  behaviour?: Record<string, Behaviour>;
  /** file → another file: it FAILS in any process that also runs that file (and passes otherwise, alone included). */
  failsWith?: Record<string, string>;
  /** file → another file: it passes ONLY in a process that also runs that file. */
  needs?: Record<string, string>;
  /** Paths the change touches (default: one source file). */
  diff?: string[];
  /** The machine's recorded file times (file-durations.json). */
  durations?: Record<string, number>;
  /** How long a process takes, by its report key (default 1 s). */
  ms?: (key: string) => number;
  /** Processes that only end when the run stops them. */
  hang?: (key: string) => boolean;
  /** Processes that write no report. */
  noReport?: (key: string) => boolean;
  /** Files that run but are left out of their process's report. */
  omit?: string[];
  /** A runner that ignores `--exclude=` (to show the verdict's own safety net). */
  ignoreExclude?: boolean;
  npmCiStatus?: number;
}

interface VitestCall { key: string; lane: Lane; ran: string[]; args: string[]; deadlineMs: number; solo: boolean; positional: string[]; excludes: string[]; shard: string | null }

function fake(sim: Sim) {
  let t = 1_700_000_000_000;
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const logs: Array<Record<string, unknown>> = [];
  const calls: VitestCall[] = [];
  const allExec: string[][] = [];
  const worktrees: string[] = [];
  const removedWorktrees: string[] = [];
  let pid = 1000;
  const lanes: Record<Lane, string[]> = { unit: sim.files?.unit ?? [u(1)], integration: sim.files?.integration ?? [i(1)], e2e: sim.files?.e2e ?? [e(1)] };
  files.set(path.join(P.runDir, 'package.json'), PKG);
  if (sim.durations) files.set(P.durationsPath, JSON.stringify(sim.durations));

  const git = (args: string[]): GitResult => {
    const ok = (stdout = ''): GitResult => ({ status: 0, stdout, stderr: '', timedOut: false });
    switch (args[0]) {
      case 'init': dirs.add(P.bare); dirs.add(path.join(P.bare, 'objects')); dirs.add(path.join(P.bare, 'refs')); files.set(path.join(P.bare, 'HEAD'), 'ref: refs/heads/main'); return ok();
      case 'merge-tree': return ok(`${TREE}\n`);
      case 'commit-tree': return ok(`${COMMIT}\n`);
      case 'worktree':
        if (args[1] === 'add') { worktrees.push(args[3]); dirs.add(args[3]); files.set(path.join(args[3], '.git'), `gitdir: ${P.bare}/worktrees/${path.basename(args[3])}\n`); }
        if (args[1] === 'remove') { removedWorktrees.push(args[2]); dirs.delete(args[2]); }
        return ok();
      case 'ls-tree': return ok(['package.json', 'src/index.ts', ...lanes.unit, ...lanes.integration, ...lanes.e2e].join('\n') + '\n');
      case 'merge-base': return ok(`${MB}\n`);
      case 'diff': return ok((sim.diff ?? ['src/index.ts']).map((p) => `M\t${p}`).join('\n') + '\n');
      case 'show': return ok(args[1].endsWith(':package.json') ? PKG : SRC);
      default: return ok();
    }
  };

  const seams: OrchestratorSeams = {
    async git(args) { return git(args); },
    async exec(command, args, opts) {
      allExec.push([command, ...args]);
      opts.onPid?.(++pid);
      const r = (status: number | null): ExecResult => ({ status, signal: null, stdout: '', stderr: '', deadlineKilled: false, pid });
      if (command === 'npm') { t += 1000; return r(sim.npmCiStatus ?? 0); }
      if (command === 'sh') { t += 1000; return r(0); }
      const cfg = args[args.indexOf('--config') + 1];
      const lane: Lane = cfg === 'vitest.config.ts' ? 'unit' : cfg.includes('integration') ? 'integration' : 'e2e';
      const out = args.find((a) => a.startsWith('--outputFile='))!.slice('--outputFile='.length);
      const key = path.basename(out, '.json');
      const excludes = args.filter((a) => a.startsWith('--exclude=')).map((a) => a.slice('--exclude='.length));
      const shard = args.find((a) => a.startsWith('--shard='))?.slice('--shard='.length) ?? null;
      const positional = args.slice(1).filter((a, k, all) => !a.startsWith('--') && all[k - 1] !== '--config');
      // What the test runner would run: named files by case-insensitive substring, minus the excluded paths, then the shard.
      let ran = positional.length > 0
        ? lanes[lane].filter((f) => positional.some((q) => f.toLowerCase().includes(q.toLowerCase())))
        : [...lanes[lane]];
      if (!sim.ignoreExclude) ran = ran.filter((f) => !excludes.includes(f));
      if (shard) { const [k, n] = shard.split('/').map(Number); ran = [...ran].sort().filter((_, idx) => idx % n === k - 1); }
      const solo = key.includes('-rerun-');
      calls.push({ key, lane, ran, args, deadlineMs: opts.deadlineMs, solo, positional, excludes, shard });
      if (sim.hang?.(key) && opts.signal) {
        const sig = opts.signal;
        await new Promise<void>((res) => { if (sig.aborted) res(); else sig.addEventListener('abort', () => res(), { once: true }); });
        return { ...r(null), signal: 'SIGTERM', aborted: true };
      }
      const dur = sim.ms?.(key) ?? 1000;
      if (dur > opts.deadlineMs) { t += opts.deadlineMs; return { ...r(null), signal: 'SIGTERM', deadlineKilled: true }; }
      t += dur;
      const fails = (f: string): boolean => {
        const b = sim.behaviour?.[f] ?? 'pass';
        if (b === 'fail' || (b === 'flaky' && !solo)) return true;
        if (sim.failsWith?.[f] && ran.includes(sim.failsWith[f])) return true;
        if (sim.needs?.[f] && !ran.includes(sim.needs[f])) return true;
        return false;
      };
      const reported = ran.filter((f) => !(sim.omit ?? []).includes(f));
      if (!sim.noReport?.(key)) {
        files.set(out, JSON.stringify({
          testResults: reported.map((f) => ({
            name: path.join(P.runDir, f), status: fails(f) ? 'failed' : 'passed', message: '', startTime: 0, endTime: 1,
            assertionResults: [{ status: fails(f) ? 'failed' : 'passed', title: 't', fullName: `${f} t`, ancestorTitles: [], failureMessages: fails(f) ? ['boom'] : [], meta: {} }],
          })),
        }));
      }
      if (opts.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE) files.set(opts.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE, JSON.stringify({ v: 1, unhandledErrors: 0, messages: [] }));
      return r(reported.some(fails) ? 1 : 0);
    },
    fs: {
      exists: (p) => files.has(p) || dirs.has(p),
      mkdirp: (p) => { dirs.add(p); },
      writeFile: (p, d) => { files.set(p, d); },
      readFile: (p) => files.get(p) ?? (p.includes('/runs/') && p.endsWith('/package.json') ? PKG : null),
      size: (p) => (files.has(p) ? Buffer.byteLength(files.get(p)!) : null),
      mkdtemp: (prefix) => { const d = `/tmp/${prefix}${dirs.size}`; dirs.add(d); return d; },
      removeTree: async (p) => { dirs.delete(p); for (const k of [...files.keys()]) if (k.startsWith(p + '/')) files.delete(k); },
    },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    foreignSuiteHolders: () => [],
    log: (ev) => { logs.push(ev); },
    unhandledErrorsReporter: () => REPORTER,
    importGraph: (fs2) => fs2,
  };
  return { seams, lanes, logs, calls, allExec, worktrees, removedWorktrees, files, now: () => t };
}

function input(over: Partial<VerifyRunInput> = {}): VerifyRunInput {
  return {
    repo: 'JKHeadley/instar', pr: 42, headSha: HEAD, baseSha: BASE, baseRefName: 'main', agentHome: HOME,
    remoteUrl: 'https://github.com/JKHeadley/instar.git', nodeVersion: 'v24.1.0', machineId: 'm_studio',
    verifierVersion: '1.3.1204', policyHash: 'f'.repeat(64), protectedList: ['.github/'],
    baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/x' },
    isolation: { allowed: true, notCleanOnGreenMain: [] }, failFast: true, ...over,
  };
}

const on = (over: Partial<FirstPartInput> = {}): Pick<VerifyRunInput, 'likelyFailingFirst'> => ({ likelyFailingFirst: { setting: 'on', previous: [], list: [], ...over } });

async function run(sim: Sim, over: Partial<VerifyRunInput> = {}) {
  const f = fake(sim);
  const r = await runVerify(input(over), f.seams);
  if (r.kind !== 'record') throw new Error(`expected a record, got ${r.kind}`);
  return { ...f, r };
}

type Recorded = Extract<VerifyRunResult, { kind: 'record' }>;
/** The lane processes (not the solo re-runs). */
const laneCalls = (h: { calls: VitestCall[] }, lane?: Lane) => h.calls.filter((c) => !c.solo && (!lane || c.lane === lane));
const keys = (h: { calls: VitestCall[] }) => h.calls.map((c) => c.key);
/** Every file of every lane ran in exactly one lane process. */
function expectEachFileOnce(h: { calls: VitestCall[]; lanes: Record<Lane, string[]> }, only?: Lane[]): void {
  for (const lane of only ?? (['unit', 'integration', 'e2e'] as Lane[])) {
    const ran = laneCalls(h, lane).flatMap((c) => c.ran).sort();
    expect(ran, `lane ${lane}`).toEqual([...h.lanes[lane]].sort());
  }
}

// ── A, D: composition in the flow, and every file reported once ────────

describe('the three cases of the rest of a lane: each file is reported exactly once', () => {
  it('unit (one process, no file list): the first part is named, the rest excludes it by name', async () => {
    const h = await run({ files: { unit: range(6, u) } }, on({ list: [u(2), u(4)] }));
    expect(h.r.record.outcome).toBe('success');
    const [first, rest] = laneCalls(h, 'unit');
    expect(first.key).toBe('unit-first');
    expect(first.positional).toEqual([u(2), u(4)]);
    expect(first.excludes).toEqual([]);
    expect(rest.key).toBe('unit');
    expect(rest.positional).toEqual([]);
    expect(rest.excludes).toEqual([u(2), u(4)]);
    expect(rest.ran).toEqual([u(1), u(3), u(5), u(6)]);
    expectEachFileOnce(h);
    expect(h.r.record.lanes.find((l) => l.name === 'unit')).toMatchObject({ files: 6, failed: 0 });
  });

  it('a sharded lane with a plan from recorded times: the first part is left out BEFORE the plan is made', async () => {
    const ints = range(7, i);
    const h = await run({ files: { integration: ints }, durations: Object.fromEntries(ints.map((f, k) => [f, 1000 + k])) }, on({ list: [i(3)] }));
    expect(h.r.record.outcome).toBe('success');
    const procs = laneCalls(h, 'integration');
    expect(procs.map((c) => c.key)).toEqual(['integration-first', ...Array.from({ length: LOCAL_VERIFY_LIMITS.integrationShards }, (_, k) => `integration-${k + 1}`)]);
    expect(procs[0].positional).toEqual([i(3)]);
    for (const p of procs.slice(1)) {
      expect(p.shard).toBeNull();
      expect(p.excludes).toEqual([]); // an explicit list needs no exclusion
      expect(p.positional).not.toContain(i(3));
      expect(p.positional.length).toBeGreaterThan(0);
    }
    // Balanced on what remains: the six remaining files are split three and three.
    expect(procs.slice(1).map((p) => p.positional.length)).toEqual([3, 3]);
    expectEachFileOnce(h);
  });

  it('a sharded lane without a plan (too few recorded times): the runner splits, the first part is excluded by name', async () => {
    const es = range(8, e);
    const h = await run({ files: { e2e: es } }, on({ list: [e(3), e(5)] }));
    expect(h.r.record.outcome).toBe('success');
    const procs = laneCalls(h, 'e2e');
    expect(procs.map((c) => c.key)).toEqual(['e2e-first', ...Array.from({ length: LOCAL_VERIFY_LIMITS.e2eShards }, (_, k) => `e2e-${k + 1}`)]);
    expect(procs[0].ran).toEqual([e(3), e(5)]);
    procs.slice(1).forEach((p, k) => {
      expect(p.shard).toBe(`${k + 1}/${LOCAL_VERIFY_LIMITS.e2eShards}`);
      expect(p.excludes).toEqual([e(3), e(5)]);
      expect(p.positional).toEqual([]);
    });
    expectEachFileOnce(h);
  });

  it('all three lanes at once, each with a first part: every file of the run reported once, and the run passes', async () => {
    const ints = range(6, i);
    const sim: Sim = { files: { unit: range(9, u), integration: ints, e2e: range(7, e) }, durations: Object.fromEntries(ints.map((f) => [f, 500])), diff: [u(9), 'src/index.ts'] };
    const h = await run(sim, on({ previous: [i(2)], list: [u(1), e(4), i(5), 'tests/unit/not-in-the-tree.test.ts'] }));
    expect(h.r.record.outcome).toBe('success');
    expect(laneCalls(h).filter((c) => c.key.endsWith('-first')).map((c) => [c.key, c.ran])).toEqual(expect.arrayContaining([
      ['unit-first', [u(1), u(9)]], ['integration-first', [i(2), i(5)]], ['e2e-first', [e(4)]],
    ]));
    expectEachFileOnce(h);
    // What is recorded about them: the sources, per lane.
    expect(h.r.firstPart).toMatchObject({ setting: 'on', active: true, endedInFirstPart: false });
    expect(h.r.firstPart!.lanes).toEqual([
      expect.objectContaining({ lane: 'unit', files: 2, fromChange: 1, fromPrevious: 0, fromList: 1, endedHere: false }),
      expect.objectContaining({ lane: 'integration', files: 2, fromChange: 0, fromPrevious: 1, fromList: 1, endedHere: false }),
      expect.objectContaining({ lane: 'e2e', files: 1, fromChange: 0, fromPrevious: 0, fromList: 1, endedHere: false }),
    ]);
    for (const l of h.r.firstPart!.lanes) expect(typeof l.ms).toBe('number');
  });

  it('an overlap group goes first whole, whichever of its paths was selected, so the rest never runs a first-part file again', async () => {
    const SHORT = 'tests/unit/auth.test.ts';
    const LONG = 'tests/unit/sub/tests/unit/AUTH.test.ts';
    for (const selected of [SHORT, LONG]) {
      const h = await run({ files: { unit: [SHORT, LONG, ...range(3, u)] } }, on({ list: [selected] }));
      const [first, rest] = laneCalls(h, 'unit');
      expect(first.positional).toEqual([SHORT, LONG].sort());
      expect(first.ran.sort()).toEqual([SHORT, LONG].sort());
      expect(rest.excludes).toEqual([SHORT, LONG].sort());
      expectEachFileOnce(h);
      expect(h.r.record.outcome).toBe('success');
    }
  });

  it('a path with a wildcard character is left out of the first part and runs in the rest', async () => {
    const WILD = 'tests/unit/[id].test.ts';
    const h = await run({ files: { unit: [WILD, u(1), u(2)] }, diff: [WILD] }, on({ list: [u(2)] }));
    const [first, rest] = laneCalls(h, 'unit');
    expect(first.positional).toEqual([u(2)]);
    expect(rest.excludes).toEqual([u(2)]);
    expect(rest.ran).toContain(WILD);
    expect(h.r.record.outcome).toBe('success');
  });

  it('a listed path over 300 characters that never reached the run (left out of the request) still runs in its lane', async () => {
    const LONGPATH = `tests/unit/${'x'.repeat(300)}.test.ts`;
    const h = await run({ files: { unit: [LONGPATH, u(1), u(2)] } }, on({ list: [u(1)] }));
    expect(laneCalls(h, 'unit')[1].ran).toContain(LONGPATH);
    expectEachFileOnce(h);
    expect(h.r.record.outcome).toBe('success');
  });

  it('a lane whose files all fit in its first part runs only the first part and is completed from that one report', async () => {
    const h = await run({ files: { unit: [u(1), u(2)], integration: range(4, i) } }, on({ list: [u(1), u(2)] }));
    expect(h.r.record.outcome).toBe('success');
    expect(laneCalls(h, 'unit').map((c) => c.key)).toEqual(['unit-first']);
    expectEachFileOnce(h);
    expect(h.r.record.lanes.find((l) => l.name === 'unit')).toMatchObject({ files: 2, tests: 2, failed: 0 });
    expect(h.r.reasons).toEqual([]);
  });

  it('fewer files left than processes: one process runs them by name', async () => {
    const es = range(3, e);
    const h = await run({ files: { e2e: es }, durations: Object.fromEntries(es.map((f) => [f, 500])) }, on({ list: [e(1), e(2)] }));
    expect(laneCalls(h, 'e2e').map((c) => [c.key, c.positional])).toEqual([['e2e-first', [e(1), e(2)]], ['e2e-1', [e(3)]]]);
    expectEachFileOnce(h);
    expect(h.r.record.outcome).toBe('success');
  });

  it('a runner that ignored the exclusion would report a file twice: the lane report is then untrusted and the run fails, never passes', async () => {
    const h = await run({ files: { unit: range(4, u) }, ignoreExclude: true }, on({ list: [u(2)] }));
    expect(h.r.record.outcome).toBe('failure');
    expect(h.r.reasons).toContain('lane-report-missing:unit');
    expect(h.logs.some((l) => l.event === 'file-in-multiple-shards' && l.file === u(2))).toBe(true);
  });
});

// ── E: where it applies ────────────────────────────────────────────────

describe('where first parts apply', () => {
  const sim: Sim = { files: { unit: range(5, u), integration: range(4, i), e2e: range(4, e) }, diff: [u(2), 'src/index.ts'] };
  const commands = (h: { allExec: string[][] }) => h.allExec;

  it('an empty first part is skipped: the lane starts exactly as it does today', async () => {
    const plain = await run({ ...sim, diff: ['src/index.ts'] }, {});
    const empty = await run({ ...sim, diff: ['src/index.ts'] }, on({ list: ['tests/unit/gone.test.ts'], previous: [] }));
    expect(commands(empty)).toEqual(commands(plain));
    expect(keys(empty).some((k) => k.includes('first'))).toBe(false);
    expect(empty.r.firstPart!.lanes.every((l) => l.files === 0 && l.ms === null)).toBe(true);
  });

  it('the setting off (no block in the run input) gives today’s commands and today’s record exactly', async () => {
    const off = await run(sim, {});
    expect([...keys(off)].sort()).toEqual(['unit', ...Array.from({ length: LOCAL_VERIFY_LIMITS.integrationShards }, (_, k) => `integration-${k + 1}`), ...Array.from({ length: LOCAL_VERIFY_LIMITS.e2eShards }, (_, k) => `e2e-${k + 1}`)].sort());
    for (const c of off.calls) {
      expect(c.excludes).toEqual([]);
      expect(c.key).not.toContain('first');
    }
    expect(off.r.firstPart).toBeUndefined();
    expect(off.r.fileOutcomes).toBeUndefined();
    expect(Object.keys(off.r.record).sort()).toEqual(['baseRefName', 'baseSha', 'finishedAt', 'harnessChanging', 'headSha', 'lanes', 'machineId', 'mergeTree', 'nodeVersion', 'outcome', 'policyHash', 'pr', 'protectedPath', 'repo', 'skipsAdded', 'startedAt', 'testsRemoved', 'verifierVersion']);
    expect(off.logs.some((l) => String(l.event).startsWith('first-part'))).toBe(false);
  });

  it('`alternate` for a pull request assigned `without` runs today’s commands; assigned `with` runs first parts', async () => {
    const off = await run(sim, {});
    const without = await run(sim, { likelyFailingFirst: { setting: 'alternate', group: 'without', previous: [], list: [u(4)] } });
    expect(commands(without)).toEqual(commands(off));
    expect(without.r.firstPart).toEqual({ setting: 'alternate', group: 'without', active: false, lanes: [], endedInFirstPart: false });
    const noGroup = await run(sim, { likelyFailingFirst: { setting: 'alternate', previous: [], list: [u(4)] } });
    expect(commands(noGroup)).toEqual(commands(off));
    const withs = await run(sim, { likelyFailingFirst: { setting: 'alternate', group: 'with', previous: [], list: [u(4)] } });
    expect(keys(withs)).toContain('unit-first');
    expect(withs.r.firstPart).toMatchObject({ setting: 'alternate', group: 'with', active: true });
  });

  it('a main verify is never given a first part, whatever the input says', async () => {
    const mainInput = { kind: 'main' as const, pr: 0, baseSha: HEAD };
    const plain = await run(sim, mainInput);
    const withBlock = await run(sim, { ...mainInput, ...on({ list: [u(4)], previous: [u(1)] }) });
    expect(commands(withBlock)).toEqual(commands(plain));
    expect(withBlock.r.firstPart).toBeUndefined();
    expect(withBlock.logs.some((l) => String(l.event).startsWith('first-part'))).toBe(false);
    expect(withBlock.r.record.outcome).toBe('success');
  });

  it('the assignment and the setting are logged at the start, before any set-up step, so a set-up failure stays in its group', async () => {
    const h = await run({ ...sim, npmCiStatus: 1 }, { likelyFailingFirst: { setting: 'alternate', group: 'with', previous: [], list: [u(4)] } });
    expect(h.r.record.outcome).toBe('error');
    expect(h.r.record.errorStep).toBe('npm-ci');
    expect(h.logs[0]).toEqual({ event: 'first-part-setting', pr: 42, setting: 'alternate', group: 'with', active: true });
    expect(h.r.firstPart).toEqual({ setting: 'alternate', group: 'with', active: true, lanes: [], endedInFirstPart: false });
    const w = await run({ ...sim, npmCiStatus: 1 }, { likelyFailingFirst: { setting: 'alternate', group: 'without', previous: [], list: [] } });
    expect(w.logs[0]).toMatchObject({ event: 'first-part-setting', group: 'without', active: false });
  });

  it("an unreadable list (empty) still leaves the change's own files and its previous failures first", async () => {
    const h = await run(sim, on({ list: [], previous: [u(5)] }));
    expect(laneCalls(h, 'unit')[0]).toMatchObject({ key: 'unit-first', positional: [u(2), u(5)] });
    expect(h.r.firstPart!.lanes[0]).toMatchObject({ fromChange: 1, fromPrevious: 1, fromList: 0 });
  });
});

// ── C: what a failure in the first part does ───────────────────────────

describe('a failure in the first part', () => {
  const files = { unit: range(6, u), integration: range(4, i), e2e: range(4, e) };

  it('that passes alone: recorded as fail-then-pass, and the lane goes on to the rest of its files', async () => {
    const h = await run({ files, behaviour: { [u(2)]: 'flaky' } }, on({ list: [u(2)] }));
    expect(h.r.record.outcome).toBe('success');
    expect(h.r.record.flakyRetried?.map((x) => x.file)).toEqual([u(2)]);
    expect(keys(h)).toEqual(expect.arrayContaining(['unit-first', 'unit-first-rerun-0-1', 'unit']));
    expect(keys(h).indexOf('unit-first-rerun-0-1')).toBeLessThan(keys(h).indexOf('unit'));
    expectEachFileOnce(h);
    expect(h.r.firstPart).toMatchObject({ endedInFirstPart: false });
  });

  it('that still fails: the rest does not start, the other lanes are stopped, the record names the file, unrun files are stopped not missing', async () => {
    // The end-to-end lane is still running when the unit first part fails finally.
    const h = await run({ files, behaviour: { [u(2)]: 'fail' }, hang: (k) => k.startsWith('e2e') }, on({ list: [u(2)] }));
    expect(h.r.record.outcome).toBe('failure');
    expect(h.r.record.errorStep).toBeUndefined();
    expect(keys(h)).not.toContain('unit'); // the rest never started
    expect(h.r.record.failedFiles).toEqual([u(2)]);
    expect(h.r.record.rerunCutOff).toBeUndefined();
    expect(h.r.failures).toEqual([expect.objectContaining({ file: u(2), lane: 'unit' })]);
    expect(h.r.reasons).toEqual(expect.arrayContaining(['lane-failed:unit:1', `file-failed:${u(2)}:1`, 'lane-stopped-early:unit', 'lane-stopped-early:e2e']));
    expect(h.r.reasons[0]).toBe('lane-failed:unit:1');
    expect(h.r.reasons.some((x) => x.startsWith('file-not-run'))).toBe(false);
    expect(h.r.reasons.some((x) => x.startsWith('lane-report-missing'))).toBe(false);
    // The counts a record gives for that lane cover only the files that ran.
    expect(h.r.record.lanes.find((l) => l.name === 'unit')).toMatchObject({ files: 1, tests: 1, failed: 1 });
    expect(h.logs.some((l) => l.event === 'lanes-stop' && l.after === 'unit-first')).toBe(true);
    expect(h.r.firstPart).toMatchObject({ endedInFirstPart: true });
    expect(h.r.firstPart!.lanes.find((l) => l.lane === 'unit')).toMatchObject({ endedHere: true });
  });

  it('all of a first part’s failures are reported together: it runs to its end before its lane decides', async () => {
    const h = await run({ files, behaviour: { [u(2)]: 'fail', [u(4)]: 'fail' } }, on({ list: [u(2), u(4), u(5)] }));
    expect(h.r.record.outcome).toBe('failure');
    expect(h.r.record.failedFiles).toEqual([u(2), u(4)]);
    expect(laneCalls(h, 'unit')[0].ran).toEqual([u(2), u(4), u(5)]);
  });

  it('more than 3 failures in a first part: no re-run alone, the verify ends there', async () => {
    const flaky = Object.fromEntries([1, 2, 3, 4].map((n) => [u(n), 'flaky' as Behaviour]));
    const h = await run({ files, behaviour: flaky }, on({ list: [u(1), u(2), u(3), u(4)] }));
    expect(h.r.record.outcome).toBe('failure');
    expect(h.calls.filter((c) => c.solo)).toEqual([]);
    expect(h.logs).toContainEqual({ event: 'isolation-rerun-skipped', lane: 'unit', reason: 'too-many-failures', part: 'first' });
    expect(keys(h)).not.toContain('unit');
    expect(h.r.record.failedFiles).toBeUndefined(); // four files: a record names at most three
    expect(h.r.firstPart).toMatchObject({ endedInFirstPart: true });
  });

  it('2 in the first part and 2 in the rest: the rest counts the lane’s failures so far, as if the lane had run in one piece', async () => {
    const flaky = Object.fromEntries([1, 2, 3, 4].map((n) => [u(n), 'flaky' as Behaviour]));
    const h = await run({ files, behaviour: flaky }, on({ list: [u(1), u(2)] }));
    expect(h.r.record.outcome).toBe('failure');
    // The first part's two passed alone; the rest's two got no re-run (4 failed files in the lane).
    expect(h.r.record.flakyRetried?.map((x) => x.file).sort()).toEqual([u(1), u(2)]);
    expect(h.calls.filter((c) => c.solo).map((c) => c.ran[0]).sort()).toEqual([u(1), u(2)]);
    expect(h.logs).toContainEqual({ event: 'isolation-rerun-skipped', lane: 'unit', reason: 'too-many-failures' });
    expect(h.r.record.failedFiles).toEqual([u(3), u(4)]);
    // In one piece the same lane fails too (four failed files, no re-run).
    const whole = await run({ files, behaviour: flaky }, {});
    expect(whole.r.record.outcome).toBe('failure');
  });

  it('2 in the first part and 1 in the rest: three in the lane, each gets its re-run and the lane passes', async () => {
    const flaky = Object.fromEntries([1, 2, 3].map((n) => [u(n), 'flaky' as Behaviour]));
    const h = await run({ files, behaviour: flaky }, on({ list: [u(1), u(2)] }));
    expect(h.r.record.outcome).toBe('success');
    expect(h.r.record.flakyRetried?.map((x) => x.file).sort()).toEqual([u(1), u(2), u(3)]);
    // The first part's and the rest's re-runs never share a report file.
    expect(new Set(h.calls.filter((c) => c.solo).map((c) => c.key)).size).toBe(3);
  });

  it('a failure in a file the change touched gets no re-run: the verify ends in the first part', async () => {
    const h = await run({ files, behaviour: { [u(2)]: 'flaky' }, diff: [u(2)] }, on());
    expect(laneCalls(h, 'unit')[0]).toMatchObject({ key: 'unit-first', positional: [u(2)] });
    expect(h.r.record.outcome).toBe('failure');
    expect(h.calls.filter((c) => c.solo)).toEqual([]);
    expect(h.logs).toContainEqual({ event: 'isolation-rerun-skipped', lane: 'unit', reason: 'related-to-change', part: 'first' });
    expect(h.r.record.failedFiles).toEqual([u(2)]);
  });

  it('the re-run budget is one budget for the verify, across first parts and the rest', async () => {
    // Three fail-then-pass files in three different parts: all three get their re-run.
    const three = await run({ files, behaviour: { [u(1)]: 'flaky', [u(3)]: 'flaky', [i(1)]: 'flaky' } }, on({ list: [u(1), i(1)] }));
    expect(three.r.record.outcome).toBe('success');
    expect(three.calls.filter((c) => c.solo)).toHaveLength(3);
    // A fourth anywhere is refused: the budget is spent.
    const four = await run({ files, behaviour: { [u(1)]: 'flaky', [u(3)]: 'flaky', [i(1)]: 'flaky', [e(2)]: 'flaky' } }, on({ list: [u(1), i(1)] }));
    expect(four.r.record.outcome).toBe('failure');
    expect(four.calls.filter((c) => c.solo)).toHaveLength(3);
    expect(four.logs.some((l) => l.event === 'isolation-rerun-skipped' && l.reason === 'rerun-budget-spent')).toBe(true);
    // Two first parts with two each: one is served, the other refused whole.
    const two = await run({ files, behaviour: { [u(1)]: 'flaky', [u(2)]: 'flaky', [i(1)]: 'flaky', [i(2)]: 'flaky' } }, on({ list: [u(1), u(2), i(1), i(2)] }));
    expect(two.r.record.outcome).toBe('failure');
    expect(two.calls.filter((c) => c.solo)).toHaveLength(2);
  });

  it('another lane’s first part that fails finally stops this lane: cut short after a clean first part, it reports only that part', async () => {
    // Unit's first part is clean and its rest is still running when integration's first part fails finally.
    const h = await run({ files, behaviour: { [i(1)]: 'fail' }, hang: (k) => k === 'unit' || k.startsWith('e2e') }, on({ list: [u(2), i(1)] }));
    expect(h.r.record.outcome).toBe('failure');
    expect(h.r.record.failedFiles).toEqual([i(1)]);
    expect(h.r.reasons).toEqual(expect.arrayContaining(['lane-stopped-early:unit', 'lane-stopped-early:integration', 'lane-stopped-early:e2e']));
    expect(h.r.reasons.some((x) => x.startsWith('file-not-run'))).toBe(false);
    expect(h.r.record.lanes.find((l) => l.name === 'unit')).toMatchObject({ files: 1, failed: 0 });
    expect(h.r.firstPart!.lanes.find((l) => l.lane === 'unit')).toMatchObject({ endedHere: false });
    expect(h.r.firstPart!.lanes.find((l) => l.lane === 'integration')).toMatchObject({ endedHere: true });
  });

  it('a first part with no readable report is a missing lane report, as for any lane', async () => {
    const h = await run({ files, noReport: (k) => k === 'unit-first' }, on({ list: [u(2)] }));
    expect(h.r.record.outcome).toBe('failure');
    expect(h.r.reasons).toContain('lane-report-missing:unit');
    expect(keys(h)).not.toContain('unit');
  });
});

describe('with fail-fast switched off, nothing ends early', () => {
  it('both parts run in every lane and the failures of both are kept', async () => {
    const files = { unit: range(6, u), integration: range(4, i), e2e: range(4, e) };
    const h = await run({ files, behaviour: { [u(2)]: 'fail', [u(5)]: 'fail', [i(3)]: 'fail' } }, { ...on({ list: [u(2), i(1), e(1)] }), failFast: false });
    expect(h.r.record.outcome).toBe('failure');
    expectEachFileOnce(h);
    expect(keys(h)).toEqual(expect.arrayContaining(['unit-first', 'unit', 'integration-first', 'integration-1', 'e2e-first', 'e2e-1']));
    expect(h.r.failures!.map((x) => x.file).sort()).toEqual([i(3), u(2), u(5)]);
    expect(h.r.record.failedFiles).toEqual([i(3), u(2), u(5)]);
    expect(h.r.reasons.some((x) => x.startsWith('lane-stopped-early'))).toBe(false);
    expect(h.logs.some((l) => l.event === 'lanes-stop')).toBe(false);
    expect(h.r.firstPart).toMatchObject({ endedInFirstPart: false });
    expect(h.r.record.lanes.find((l) => l.name === 'unit')).toMatchObject({ files: 6, failed: 2 });
  });

  it('a first part that failed finally only changes the order: the rest still runs, and its failures are counted with the first part’s', async () => {
    const files = { unit: range(8, u) };
    // One final failure first, then three fail-then-pass files in the rest: four in the lane, so no re-run for the rest.
    const h = await run({ files, behaviour: { [u(1)]: 'fail', [u(3)]: 'flaky', [u(4)]: 'flaky', [u(5)]: 'flaky' } }, { ...on({ list: [u(1)] }), failFast: false });
    expect(h.r.record.outcome).toBe('failure');
    expect(h.calls.filter((c) => c.solo).map((c) => c.ran[0])).toEqual([u(1)]);
    expect(h.r.failures!.map((x) => x.file).sort()).toEqual([u(1), u(3), u(4), u(5)]);
  });
});

// ── The lane deadline covers both parts ────────────────────────────────

describe('the lane deadline', () => {
  const files = { unit: range(6, u) };

  it('covers both parts: the first part gets the lane deadline, the rest gets what is left', async () => {
    const h = await run({ files, ms: (k) => (k === 'unit-first' ? 10 * MIN : 1000) }, on({ list: [u(2)] }));
    expect(h.r.record.outcome).toBe('success');
    const [first, rest] = laneCalls(h, 'unit');
    expect(first.deadlineMs).toBe(LOCAL_VERIFY_DEADLINES.lanes.unit);
    expect(rest.deadlineMs).toBeLessThanOrEqual(LOCAL_VERIFY_DEADLINES.lanes.unit - 10 * MIN);
    expect(rest.deadlineMs).toBeGreaterThan(LOCAL_VERIFY_DEADLINES.lanes.unit - 11 * MIN);
    // The lane's time counts both parts.
    expect(h.r.record.lanes.find((l) => l.name === 'unit')!.seconds).toBeGreaterThanOrEqual(600);
    // (The fake clock is shared with the other lanes' processes, so a few seconds of theirs are in it.)
    expect(h.r.firstPart!.lanes[0].ms).toBeGreaterThanOrEqual(10 * MIN);
    expect(h.r.firstPart!.lanes[0].ms).toBeLessThan(11 * MIN);
  });

  it('a first part that runs past the lane deadline is an error naming it', async () => {
    const h = await run({ files, ms: (k) => (k === 'unit-first' ? LOCAL_VERIFY_DEADLINES.lanes.unit + MIN : 1000) }, on({ list: [u(2)] }));
    expect(h.r.record.outcome).toBe('error');
    expect(h.r.record.errorStep).toBe('deadline:unit-first');
  });

  it('a first part that uses the whole lane deadline leaves nothing for the rest: an error, the rest never starts', async () => {
    const h = await run({ files, ms: (k) => (k === 'unit-first' ? LOCAL_VERIFY_DEADLINES.lanes.unit : 1000) }, on({ list: [u(2)] }));
    expect(h.r.record.outcome).toBe('error');
    expect(h.r.record.errorStep).toBe('deadline:unit');
    expect(keys(h)).not.toContain('unit');
  });

  it('the rest running past what is left of the lane deadline is the lane’s deadline error', async () => {
    const h = await run({ files, ms: (k) => (k === 'unit-first' ? 30 * MIN : k === 'unit' ? 15 * MIN : 1000) }, on({ list: [u(2)] }));
    expect(h.r.record.outcome).toBe('error');
    expect(h.r.record.errorStep).toBe('deadline:unit');
  });

  it('a failing first part in a lane whose rest would have passed its deadline: recorded as FAILED, never an error (no automatic retry)', async () => {
    const sim: Sim = { files, behaviour: { [u(2)]: 'fail' }, ms: (k) => (k === 'unit' ? LOCAL_VERIFY_DEADLINES.lanes.unit + 5 * MIN : 1000) };
    const h = await run(sim, on({ list: [u(2)] }));
    expect(h.r.record.outcome).toBe('failure');
    expect(h.r.record.errorStep).toBeUndefined();
    expect(h.r.record.failedFiles).toEqual([u(2)]);
    expect(keys(h)).not.toContain('unit');
    // Without first parts the same run ends as a deadline error.
    const whole = await run(sim, {});
    expect(whole.r.record.outcome).toBe('error');
    expect(whole.r.record.errorStep).toBe('deadline:unit');
  });
});

// ── No early pass ──────────────────────────────────────────────────────

describe('no early pass: a pass is declared only after every test in the run has passed', () => {
  const F = u(1); // goes in the first part
  const R = u(2); // stays in the rest
  const files = { unit: [F, R, u(3)], integration: [i(1), i(2)], e2e: [e(1), e(2)] };
  const states: Behaviour[] = ['pass', 'flaky', 'fail'];

  /** Did every file of every lane run in exactly one lane process and end as passed there (or pass alone after failing)? */
  function everyTestPassed(h: { calls: VitestCall[]; lanes: Record<Lane, string[]> }, sim: Sim, finished: (c: VitestCall) => boolean): boolean {
    for (const lane of ['unit', 'integration', 'e2e'] as Lane[]) {
      for (const f of h.lanes[lane]) {
        const procs = laneCalls(h, lane).filter((c) => c.ran.includes(f));
        if (procs.length !== 1 || !finished(procs[0])) return false;
        if ((sim.omit ?? []).includes(f)) return false;
        const b = sim.behaviour?.[f] ?? 'pass';
        if (b === 'fail') return false;
        if (b === 'flaky' && !h.calls.some((c) => c.solo && c.ran[0] === f)) return false;
      }
    }
    return true;
  }

  it('for every combination of first-part and rest outcomes, with and without fail-fast, and with the rest cut short, unreported or missing a file', async () => {
    type RestFate = 'runs' | 'cut-short' | 'no-report' | 'omits-a-file' | 'other-lane-fails';
    const fates: RestFate[] = ['runs', 'cut-short', 'no-report', 'omits-a-file', 'other-lane-fails'];
    let passes = 0;
    let total = 0;
    for (const first of states) for (const rest of states) for (const fate of fates) for (const failFast of [true, false]) {
      const sim: Sim = {
        files,
        behaviour: { [F]: first, [R]: rest, ...(fate === 'cut-short' || fate === 'other-lane-fails' ? { [i(1)]: 'fail' as Behaviour } : {}) },
        // cut-short: the unit rest is still running when the integration lane fails finally and
        // fail-fast stops it. (With fail-fast off nothing stops it: that run is the same as "other-lane-fails".)
        ...(fate === 'cut-short' && failFast ? { hang: (k: string) => k === 'unit' } : {}),
        ...(fate === 'no-report' ? { noReport: (k: string) => k === 'unit' } : {}),
        ...(fate === 'omits-a-file' ? { omit: [u(3)] } : {}),
      };
      const hung = (c: VitestCall) => !!sim.hang?.(c.key);
      const h = await run(sim, { ...on({ list: [F] }), failFast });
      total++;
      const label = `first=${first} rest=${rest} fate=${fate} failFast=${failFast}`;
      const allPassed = everyTestPassed(h, sim, (c) => !hung(c) && !sim.noReport?.(c.key));
      if (h.r.record.outcome === 'success') {
        passes++;
        expect(allPassed, `${label}: recorded as passed without every test having passed`).toBe(true);
        expect(h.r.reasons, label).toEqual([]);
        // The record's own counts agree: every file of every lane is in it, none failed.
        for (const lane of ['unit', 'integration', 'e2e'] as Lane[]) {
          expect(h.r.record.lanes.find((l) => l.name === lane), label).toMatchObject({ files: files[lane].length, failed: 0 });
        }
      } else {
        expect(allPassed, `${label}: every test passed but the run was not recorded as passed`).toBe(false);
      }
    }
    expect(total).toBe(3 * 3 * 5 * 2);
    // Only the runs whose first part and rest both passed (clean or alone) and whose rest ran whole.
    expect(passes).toBe(2 * 2 * 1 * 2);
  });

  it('a clean first part with the rest not yet run is never a pass (evaluateRun, every shape of a lane cut short)', () => {
    const inventory = computeInventory([F, R, u(3), i(1), e(1)]);
    const pass = { passed: 1, failed: 0, skipped: 0, todo: 0 };
    const report = (fs: string[]): ParsedLaneReport => ({ files: new Map(fs.map((f) => [f, { ...pass }])) });
    const whole = (lane: Lane, fs: string[]): LaneRunInput => ({ lane, report: report(fs), seconds: 1, exitCode: 0 });
    const others = [whole('integration', [i(1)]), whole('e2e', [e(1)])];
    // The baseline: every file reported and passed.
    expect(evaluateRun(inventory, [whole('unit', [F, R, u(3)]), ...others]).outcome).toBe('success');
    const shapes: Array<[string, LaneRunInput]> = [
      ['clean first part, marked cut short', { lane: 'unit', report: report([F]), seconds: 1, exitCode: 0, cutShort: true }],
      ['clean first part, NOT marked (a bug upstream)', { lane: 'unit', report: report([F]), seconds: 1, exitCode: 0 }],
      ['clean first part, marked stoppedEarly instead', { lane: 'unit', report: report([F]), seconds: 1, exitCode: 0, stoppedEarly: true }],
      ['first part and rest merged but a file missing', { lane: 'unit', report: report([F, R]), seconds: 1, exitCode: 0 }],
      ['whole report but still marked cut short', { lane: 'unit', report: report([F, R, u(3)]), seconds: 1, exitCode: 0, cutShort: true }],
      ['no report, stopped', { lane: 'unit', report: null, seconds: 1, exitCode: null, stoppedEarly: true }],
      ['no report at all', { lane: 'unit', report: null, seconds: 1, exitCode: null }],
      ['empty first part report, cut short', { lane: 'unit', report: report([]), seconds: 1, exitCode: 0, cutShort: true }],
    ];
    for (const [name, unitRun] of shapes) {
      const ev = evaluateRun(inventory, [unitRun, ...others]);
      expect(ev.outcome, name).toBe('failure');
      expect(ev.reasons.length, name).toBeGreaterThan(0);
    }
    // A lane cut short names itself, and its unrun files are stopped, not missing.
    const cut = evaluateRun(inventory, [{ lane: 'unit', report: report([F]), seconds: 1, exitCode: 0, cutShort: true }, ...others]);
    expect(cut.reasons).toEqual(['lane-stopped-without-failure', 'lane-stopped-early:unit']);
    expect(cut.lanes.find((l) => l.name === 'unit')).toMatchObject({ files: 1, passed: 1, failed: 0 });
    // Every lane cut short after a clean first part: still never a pass.
    const all = evaluateRun(inventory, [
      { lane: 'unit', report: report([F]), seconds: 1, exitCode: 0, cutShort: true },
      { lane: 'integration', report: report([]), seconds: 1, exitCode: 0, cutShort: true },
      { lane: 'e2e', report: report([]), seconds: 1, exitCode: 0, cutShort: true },
    ]);
    expect(all.outcome).toBe('failure');
  });

  it('a lane cut short with a failure in its first part keeps the failure first and the stop last', () => {
    const inventory = computeInventory([F, R, i(1), e(1)]);
    const ev = evaluateRun(inventory, [
      { lane: 'unit', report: { files: new Map([[F, { passed: 0, failed: 1, skipped: 0, todo: 0 }]]) }, seconds: 1, exitCode: 1, cutShort: true },
      { lane: 'integration', report: null, seconds: 1, exitCode: null, stoppedEarly: true },
      { lane: 'e2e', report: null, seconds: 1, exitCode: null, stoppedEarly: true },
    ]);
    expect(ev.reasons).toEqual(['lane-failed:unit:1', `file-failed:${F}:1`, 'lane-stopped-early:unit', 'lane-stopped-early:integration', 'lane-stopped-early:e2e']);
    expect(ev.perFile[F]).toMatchObject({ failed: 1, lane: 'unit' });
  });
});

// ── The same verdict with and without first parts ──────────────────────

describe('equal outcome: for tests that give the same result wherever they run, the verdict with first parts equals the verdict without', () => {
  const states: Behaviour[] = ['pass', 'flaky', 'fail'];

  it('for every combination of passing, failing and fail-then-pass files in the first part and in the rest', async () => {
    const files = { unit: range(8, u), integration: range(3, i), e2e: range(3, e) };
    let n = 0;
    // Two files in the first part (u1, u2), two in the rest (u3, u4), with and without fail-fast.
    for (const a of states) for (const b of states) for (const c of states) for (const d of states) for (const failFast of [true, false]) {
      const sim: Sim = { files, behaviour: { [u(1)]: a, [u(2)]: b, [u(3)]: c, [u(4)]: d } };
      const withParts = await run(sim, { ...on({ list: [u(1), u(2)] }), failFast });
      const whole = await run(sim, { failFast });
      expect(withParts.r.record.outcome, `first=[${a},${b}] rest=[${c},${d}] failFast=${failFast}`).toBe(whole.r.record.outcome);
      n++;
    }
    expect(n).toBe(162);
  });

  it('also when the failures are spread over lanes and the shared re-run budget decides', async () => {
    const files = { unit: range(5, u), integration: range(4, i), e2e: range(4, e) };
    const spots = [u(1), u(3), i(1), i(3), e(2)];
    let n = 0;
    // Every subset of five spots being fail-then-pass (one or two per lane): 32 runs.
    for (let mask = 0; mask < 32; mask++) {
      const behaviour = Object.fromEntries(spots.filter((_, k) => mask & (1 << k)).map((f) => [f, 'flaky' as Behaviour]));
      const sim: Sim = { files, behaviour };
      const withParts = await run(sim, on({ list: [u(1), i(1)] }));
      const whole = await run(sim, {});
      expect(withParts.r.record.outcome, `flaky=${Object.keys(behaviour).join(',')}`).toBe(whole.r.record.outcome);
      // Three or fewer fail-then-pass files in the whole verify pass; four or more do not.
      expect(whole.r.record.outcome).toBe(Object.keys(behaviour).length <= 3 ? 'success' : 'failure');
      n++;
    }
    expect(n).toBe(32);
  });
});

// ── Tests that depend on their neighbours (the accepted risk) ──────────

describe('a test that depends on which files share its process (documentation of the accepted risk)', () => {
  // Scripted files, not real ones: the fake runner applies "fails only if the other ran in the same process".
  const A = u(1);
  const B = u(2);
  const files = { unit: [A, B, u(3)] };

  it('B fails only when A ran before it in the same process: in one piece B fails and passes alone; with A in the first part B never fails', async () => {
    const sim: Sim = { files, failsWith: { [B]: A } };
    const whole = await run(sim, { collectFileOutcomes: true });
    const parts = await run(sim, { ...on({ list: [A] }), collectFileOutcomes: true });
    // The result with and without a first part, recorded:
    expect({ outcome: whole.r.record.outcome, b: whole.r.fileOutcomes![B], flaky: whole.r.record.flakyRetried?.map((x) => x.file) })
      .toEqual({ outcome: 'success', b: 'flaky', flaky: [B] });
    expect({ outcome: parts.r.record.outcome, b: parts.r.fileOutcomes![B], flaky: parts.r.record.flakyRetried })
      .toEqual({ outcome: 'success', b: 'passed', flaky: undefined });
    // The reordering changed what B did. Here both verdicts are a pass; the verdict check records B as unreliable, not as a difference.
    const cmp = compareFirstPartRuns({ outcome: parts.r.record.outcome, files: parts.r.fileOutcomes! }, { outcome: whole.r.record.outcome, files: whole.r.fileOutcomes! }, new Set());
    expect(cmp).toMatchObject({ difference: false, flakyInEither: [B] });
  });

  it('moving X into the first part makes Y fail only in the new order: the verdicts differ, and the comparison detects it', async () => {
    const X = u(1);
    const Y = u(2);
    const sim: Sim = { files, needs: { [Y]: X } }; // Y passes only in a process that also ran X
    const parts = await run(sim, { ...on({ list: [X] }), collectFileOutcomes: true });
    const whole = await run(sim, { collectFileOutcomes: true });
    expect(whole.r.record.outcome).toBe('success');
    expect(parts.r.record.outcome).toBe('failure'); // the one stated way the order can change a verdict
    expect(parts.r.record.failedFiles).toEqual([Y]);
    const cmp = compareFirstPartRuns({ outcome: parts.r.record.outcome, files: parts.r.fileOutcomes! }, { outcome: whole.r.record.outcome, files: whole.r.fileOutcomes! }, new Set());
    expect(cmp.verdictDiffers).toBe(true);
    expect(cmp.differing).toEqual([{ file: Y, first: 'failed', compare: 'passed', known: false }]);
    expect(cmp.difference).toBe(true);
  });

  it('a change with one fault in each part: the run with first parts ends on the first, the full run sees both; not a difference', async () => {
    const sim: Sim = { files: { unit: range(5, u) }, behaviour: { [u(1)]: 'fail', [u(4)]: 'fail' } };
    const parts = await run(sim, { ...on({ list: [u(1)] }), collectFileOutcomes: true });
    const whole = await run(sim, { collectFileOutcomes: true, failFast: true });
    expect(parts.r.record.failedFiles).toEqual([u(1)]);
    expect(whole.r.record.failedFiles).toEqual([u(1), u(4)]);
    const cmp = compareFirstPartRuns({ outcome: parts.r.record.outcome, files: parts.r.fileOutcomes! }, { outcome: whole.r.record.outcome, files: whole.r.fileOutcomes! }, new Set());
    expect(cmp).toMatchObject({ verdictDiffers: false, difference: false, bothFailed: [u(1)], onlyCompareReached: [u(4)] });
  });
});

// ── The comparison run, and what a run hands back ──────────────────────

describe('the comparison run (the verdict check)', () => {
  const files = { unit: range(4, u) };

  it('runs in a FRESH checkout of the same merge commit, in its own folders, and never keeps a failed worktree', async () => {
    const first = await run({ files, behaviour: { [u(2)]: 'fail' } }, on({ list: [u(2)] }));
    expect(first.worktrees).toEqual([P.runDir]);
    expect(first.r.keptWorktree).toBe(P.runDir); // the failed verify keeps its worktree for diagnosis
    const cmp = await run({ files, behaviour: { [u(2)]: 'fail' } }, { variant: 'compare', collectFileOutcomes: true });
    const CP = verifyPaths(HOME, HEAD, 'compare');
    expect(CP.runDir).not.toBe(P.runDir);
    expect(path.basename(CP.runDir)).toMatch(/^[0-9a-f]{12}$/); // still a name the orphan sweep knows
    expect(CP.reportsDir).not.toBe(P.reportsDir);
    expect(cmp.worktrees).toEqual([CP.runDir]);
    expect(cmp.removedWorktrees).not.toContain(P.runDir);
    expect(cmp.r.record.outcome).toBe('failure');
    expect(cmp.r.keptWorktree).toBeNull();
    expect(cmp.removedWorktrees).toContain(CP.runDir);
    // The same merge commit: the worktree is added at the commit made from the same head and base.
    expect(cmp.r.record.mergeTree).toBe(first.r.record.mergeTree);
    // And the lanes exactly as today's verifier runs them: no first part.
    expect(keys(cmp).some((k) => k.includes('first'))).toBe(false);
    expect(cmp.r.firstPart).toBeUndefined();
  });

  it('hands back what every reported file did when asked, and nothing otherwise', async () => {
    const sim: Sim = { files, behaviour: { [u(2)]: 'flaky', [u(3)]: 'fail' } };
    const asked = await run(sim, { collectFileOutcomes: true, failFast: false });
    expect(asked.r.fileOutcomes).toMatchObject({ [u(1)]: 'passed', [u(2)]: 'flaky', [u(3)]: 'failed', [u(4)]: 'passed', [i(1)]: 'passed', [e(1)]: 'passed' });
    expect((await run(sim, { failFast: false })).r.fileOutcomes).toBeUndefined();
    // A verify that ended in a first part reports only the files that ran.
    const ended = await run(sim, { ...on({ list: [u(3)] }), collectFileOutcomes: true });
    expect(ended.r.fileOutcomes![u(3)]).toBe('failed');
    expect(ended.r.fileOutcomes![u(1)]).toBeUndefined();
  });
});

// ── A re-run alone cut off by another lane's failure ───────────────────

describe('a re-run alone cut off by another lane’s failure', () => {
  it('is named on the record (`rerunCutOff`), so the list and the change’s previous failures can leave it out', async () => {
    const files = { unit: range(3, u), integration: range(3, i) };
    // Integration's i1 failed once and its re-run alone is still running when the unit lane fails finally.
    const h = await run({ files, behaviour: { [u(1)]: 'fail', [i(1)]: 'flaky' }, hang: (k) => k.startsWith('integration-rerun') }, {});
    expect(h.r.record.outcome).toBe('failure');
    expect(h.r.record.failedFiles).toEqual([i(1), u(1)]);
    expect(h.r.record.rerunCutOff).toEqual([i(1)]);
    expect(h.r.failures!.find((x) => x.file === i(1))!.rerunMessage).toBe('isolation re-run stopped: another lane had already failed');
  });

  it('a re-run that ran and failed again is not cut off', async () => {
    const h = await run({ files: { unit: range(3, u) }, behaviour: { [u(1)]: 'fail' } }, {});
    expect(h.r.record.failedFiles).toEqual([u(1)]);
    expect(h.r.record.rerunCutOff).toBeUndefined();
  });
});

// ── Unit file durations (docs/specs/local-verify-borrowed-unit-slices.md, A) with first parts ──

describe('unit file durations and the unit wall factor, with a lane run in two parts', () => {
  it('both parts of the unit lane are recorded in the duration history, and the wall factor is written once, marked firstPart', async () => {
    const h = await run({ files: { unit: range(6, u) } }, on({ list: [u(2), u(4)] }));
    expect(h.r.record.outcome).toBe('success');
    const hist = JSON.parse(h.files.get(P.durationsPath) as string) as Record<string, number>;
    expect(Object.keys(hist)).toEqual(expect.arrayContaining(range(6, u)));
    const wf = h.logs.filter((l) => l.event === 'unit-wall-factor');
    expect(wf).toHaveLength(1);
    expect(wf[0]).toMatchObject({ workers: LOCAL_VERIFY_LIMITS.unitWorkersParallel, firstPart: true });
    expect(typeof wf[0].factor).toBe('number');
  });

  it('a unit lane run in one part writes the wall factor without the mark', async () => {
    const h = await run({ files: { unit: range(6, u) } });
    const wf = h.logs.filter((l) => l.event === 'unit-wall-factor');
    expect(wf).toHaveLength(1);
    expect(wf[0]).not.toHaveProperty('firstPart');
    expect(wf[0]).not.toHaveProperty('reran');
  });

  it('a row whose lane re-ran files alone is marked reran (its wall time and file time are not a clean sample)', async () => {
    const h = await run({ files: { unit: range(6, u) }, behaviour: { [u(3)]: 'flaky' } });
    expect(h.r.record.outcome).toBe('success');
    const wf = h.logs.filter((l) => l.event === 'unit-wall-factor');
    expect(wf).toHaveLength(1);
    expect(wf[0]).toMatchObject({ reran: true });
    expect(wf[0]).not.toHaveProperty('firstPart');
    // A flaky file in another lane does not mark the unit row.
    const other = await run({ files: { unit: range(6, u), integration: range(3, i) }, behaviour: { [i(2)]: 'flaky' } });
    expect(other.logs.filter((l) => l.event === 'unit-wall-factor')[0]).not.toHaveProperty('reran');
  });

  it('a unit lane cut short after a failed first part writes no wall factor', async () => {
    const h = await run({ files: { unit: range(6, u) }, behaviour: { [u(2)]: 'fail' } }, on({ list: [u(2)] }));
    expect(h.r.record.outcome).toBe('failure');
    expect(h.logs.some((l) => l.event === 'unit-wall-factor')).toBe(false);
  });

  it('recorded unit times never change which files a unit first part holds', async () => {
    const files = { unit: range(8, u) };
    const list = [u(2), u(4), u(7)];
    const plain = await run({ files }, on({ list }));
    const timed = await run({ files, durations: Object.fromEntries(range(8, u).map((f, k) => [f, 600_000 * (k + 1)])) }, on({ list }));
    const firstOf = (x: { calls: VitestCall[] }) => laneCalls(x, 'unit').find((c) => c.key === 'unit-first')!.positional;
    expect(firstOf(timed)).toEqual(firstOf(plain));
    expect(firstOf(timed)).toEqual(list);
  });
});

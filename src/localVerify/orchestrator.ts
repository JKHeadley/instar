/**
 * The local-verify run orchestrator (spec local-verify-merge-authority.md §2 Run
 * steps 1–5 and 8): one verify of one (head, base) merge, driven entirely through
 * injected seams (git, process, fs, clock, test-runner holders) so it is unit
 * testable without spawning anything. The real seams live in `orchestratorSeams.ts`
 * and run inside the `runVerifyMain` child process, never in the server.
 *
 * This is the TRUSTED side: it always runs from the installed server's copy.
 * From the merge tree it takes only what the run is meant to exercise (the
 * package.json build and lint command lists, the vitest configs, tests/setup).
 *
 * Outcomes: `error` is infrastructure (a deadline, a crash, an install failure,
 * a merge conflict); `failure` is a check that failed (build, lint, a test, a
 * dirty tree). A foreign full suite seen before lane 1, or still present after
 * waiting in place before lane 2/3, returns `requeue` — never an attempt.
 */

import path from 'node:path';
import { computeInventory, isInventoried, LANES, type LaneName } from './inventory.js';
import { readUnhandledErrors } from './unhandledErrorsReporter.js';
import { decideIsolationRerun, evaluateRun, parseVitestJson, type LaneRunInput, type LaneTotals, type ParsedLaneReport } from './laneReport.js';
import { evaluateSkipRatchet, loadTypescript, type ChangedTestFile, type TsModule } from './skipRatchet.js';
import { classifyHarness, harnessReasonPaths, protectedPath as isProtectedPath, protectedPathMatches } from './harnessClassifier.js';
import { independentReviewProblem, isTracePath } from '../../scripts/lib/instar-dev-trace.mjs';
import { FLAKY_RETRIED_MAX, isValidSha, validateRecord, type FlakyRetry, type LocalVerifyRecord } from './record.js';
import { LOCAL_VERIFY_DEADLINES, LOCAL_VERIFY_IDENTITY, LOCAL_VERIFY_LIMITS, type LocalVerifyDeadlines } from './policy.js';
import { DURATIONS_MAX_BYTES, mergeDurations, planShards, type FileDurations } from './shardPlan.js';

/** Upper bound on processes per slow lane (bounded blast radius: at most 4 + 4 + 4 test workers). */
export const MAX_LANE_SHARDS = 4;

// ── Seams ──────────────────────────────────────────────────────────────

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  deadlineKilled: boolean;
  /** Stopped through `opts.signal` (fail-fast: a sibling lane already failed); never set with `deadlineKilled`. */
  aborted?: boolean;
  pid: number | null;
}

export interface GitCallOpts {
  cwd: string;
  operation: string;
  timeoutMs: number;
  gitDir: string;
  workTree?: string;
}

export interface OrchestratorFs {
  exists(p: string): boolean;
  mkdirp(p: string): void;
  writeFile(p: string, data: string): void;
  /** null when absent or unreadable. */
  readFile(p: string): string | null;
  /** Size in bytes, null when absent or unreadable. Absent seam ⇒ the duration history is never read. */
  size?(p: string): number | null;
  /** A fresh private temp directory (outside the worktree). */
  mkdtemp(prefix: string): string;
  /** Recursive delete, scoped to local-verify's own directories by the real seam. */
  removeTree(p: string): Promise<void>;
}

export interface OrchestratorSeams {
  /**
   * Run git with repository discovery closed: `gitDir` (the bare clone, or a run worktree's
   * admin dir under `<bare>/worktrees/`) and, for working-tree steps, `workTree` are pinned
   * explicitly by the real seam (GIT_DIR / GIT_WORK_TREE / GIT_CEILING_DIRECTORIES).
   */
  git(args: string[], opts: GitCallOpts): Promise<GitResult>;
  exec(
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; deadlineMs: number; onPid?: (pid: number) => void; signal?: AbortSignal },
  ): Promise<ExecResult>;
  fs: OrchestratorFs;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Live full-suite holders of the host test-runner bound that are not one of `ours`. */
  foreignSuiteHolders(ours: ReadonlySet<number>): Array<{ pid: number }>;
  /**
   * Take ONE full-suite slot of the host test-runner bound for the lane phase, so the
   * concurrent lane processes (children of this process) nest under it. Returns the
   * release function, 'busy' when the slot is held elsewhere (the run re-queues), or
   * null when the bound admitted without a slot (fail-open). Absent ⇒ no hold.
   */
  holdSuiteSlot?(): Promise<(() => void) | 'busy' | null>;
  log(event: Record<string, unknown>): void;
  /** Every file reachable through relative imports from `files` (absolute paths; roots included). */
  importGraph?(files: string[]): string[];
  /** Absolute path of the trusted unhandled-errors reporter; null/absent ⇒ unknown ⇒ no isolation re-run. */
  unhandledErrorsReporter?(): string | null;
  /**
   * The TypeScript module for the skip ratchet's parser. Absent ⇒ resolved from the
   * run worktree (installed by `npm ci`), then the verifier's own install.
   */
  typescript?(): TsModule;
}

// ── Input / output ─────────────────────────────────────────────────────

export interface VerifyRunInput {
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string;
  baseRefName: string;
  /** 'main' for a post-merge verify of `main` (pr 0, headSha == baseSha); absent for a PR. */
  kind?: 'main';
  /** The agent home; the verifier owns `<agentHome>/.worktrees/.verify/` only. */
  agentHome: string;
  /** Fetch URL for the bare clone's `origin`. */
  remoteUrl: string;
  nodeVersion: string;
  machineId: string;
  verifierVersion: string;
  policyHash: string;
  /** The watcher's protected-path list (prefix semantics). */
  protectedList: readonly string[];
  /**
   * PR verifies only: whether an isolation re-run may treat a failed file as possibly flaky.
   * `allowed` is false when this machine has no green `main` record; `notCleanOnGreenMain`
   * lists files that did not pass cleanly there (they were themselves re-run-passed). Absent
   * on a PR verify ⇒ no re-run. `main` verifies ignore it (the plain rule).
   */
  isolation?: { allowed: boolean; notCleanOnGreenMain: readonly string[] };
  /** A peer verify (spec local-verify-capacity.md Part D): copied onto the record as `attempt`. */
  attempt?: { id: string; coordinatorMachineId: string; leaseEpoch: number | null };
  /**
   * PR verifies only: once a lane ends with a failure the isolation re-run did not clear, stop
   * the other lanes (the verdict is already `failure`). Absent/false ⇒ every lane runs to the end.
   */
  failFast?: boolean;
  /**
   * Processes per slow lane (`monitoring.localVerify.laneShards`, clamped 1..4 by the service).
   * Absent ⇒ `LOCAL_VERIFY_LIMITS.integrationShards` / `e2eShards`.
   */
  laneShards?: { integration?: number; e2e?: number };
  extraHarnessGlobs?: readonly string[];
  /** Already-scrubbed base environment (allowlisted by the service). */
  baseEnv: Record<string, string>;
  deadlines?: LocalVerifyDeadlines;
}

/** The first failing test of a failed file, bounded (spec §2: the full detail lives in the audit, not the status). */
export interface FailureDetail {
  file: string;
  lane: string;
  failed: number;
  message: string;
  /** Set when the file was re-run alone and failed again: the re-run's message. */
  rerunMessage?: string;
}

/** At most this many failure details travel with a result. */
export const FAILURE_DETAILS_MAX = 30;

export interface Overlap {
  at: number;
  beforeLane: LaneName;
  holders: number[];
}

export type VerifyRunResult =
  | { kind: 'record'; record: LocalVerifyRecord; reasons: string[]; overlaps: Overlap[]; keptWorktree: string | null; failures?: FailureDetail[]; flakyRetried?: FlakyRetry[] }
  | { kind: 'requeue'; reason: 'foreign-suite-at-start' | 'foreign-suite-wait-exceeded'; overlaps: Overlap[] }
  | { kind: 'invalid'; errors: string[] };

export interface VerifyPaths {
  verifyRoot: string;
  bare: string;
  runsDir: string;
  runDir: string;
  reportsDir: string;
  keptListFile: string;
  /** Per-file durations of earlier runs on this machine (balanced shards only; never a verdict input). */
  durationsPath: string;
}

export function verifyPaths(agentHome: string, headSha: string): VerifyPaths {
  const verifyRoot = path.join(agentHome, '.worktrees', '.verify');
  const sha12 = headSha.slice(0, 12);
  return {
    verifyRoot,
    bare: path.join(verifyRoot, 'repo.git'),
    runsDir: path.join(verifyRoot, 'runs'),
    runDir: path.join(verifyRoot, 'runs', sha12),
    reportsDir: path.join(verifyRoot, 'reports', sha12),
    keptListFile: path.join(verifyRoot, 'kept-failed.json'),
    durationsPath: path.join(verifyRoot, 'file-durations.json'),
  };
}

/** The fixed bare-clone config, rewritten before every run (a test cannot persist a change). */
export function bareConfigTemplate(remoteUrl: string): string {
  return [
    '[core]',
    '\trepositoryformatversion = 0',
    '\tfilemode = true',
    '\tbare = true',
    '\thooksPath = hooks',
    '[remote "origin"]',
    `\turl = ${remoteUrl}`,
    '[user]',
    `\tname = ${LOCAL_VERIFY_IDENTITY.name}`,
    `\temail = ${LOCAL_VERIFY_IDENTITY.email}`,
    '[gc]',
    '\tauto = 0',
    // GitHub's mergeability check does not guess directory renames. Git's guess
    // misfires on this repo: every release empties upgrades/next/, so a PR that
    // adds a fragment there "conflicts" with a rename that never happened.
    '[merge]',
    '\tdirectoryRenames = false',
    '',
  ].join('\n');
}

/** Split a package.json script on `&&` into its command list. */
export function splitScript(script: string | undefined): string[] {
  if (typeof script !== 'string') return [];
  return script.split('&&').map((s) => s.trim()).filter(Boolean);
}

/** Parse `git diff --name-status --no-renames` output. */
export function parseNameStatus(out: string): Array<{ status: string; path: string }> {
  const rows: Array<{ status: string; path: string }> = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    rows.push({ status: line.slice(0, tab).trim().charAt(0), path: line.slice(tab + 1) });
  }
  return rows;
}

const VERIFY_COMMIT_MESSAGE = 'local-verify merge';

class RunError extends Error {
  constructor(public readonly step: string, detail: string) {
    super(`${step}: ${detail}`);
  }
}

/** The record flags plus the independent review a flagged record may carry. */
type Flags = Pick<LocalVerifyRecord, 'harnessChanging' | 'protectedPath' | 'skipsAdded' | 'testsRemoved' | 'independentReview'>;

class RunFailure extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

class Requeue extends Error {
  constructor(public readonly reason: 'foreign-suite-at-start' | 'foreign-suite-wait-exceeded') {
    super(reason);
  }
}

// ── The run ────────────────────────────────────────────────────────────

export async function runVerify(input: VerifyRunInput, seams: OrchestratorSeams): Promise<VerifyRunResult> {
  const d = input.deadlines ?? LOCAL_VERIFY_DEADLINES;
  const p = verifyPaths(input.agentHome, input.headSha);
  const startedAtMs = seams.now();
  const overlaps: Overlap[] = [];
  const ourPids = new Set<number>();
  const laneRuns: LaneRunInput[] = [];
  const tempDirs: string[] = [];
  let mergeTree = '';
  let mergeCommit = '';
  let worktreeCreated = false;
  let flags: Flags = { harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false };

  const remaining = () => d.totalActiveMs - (seams.now() - startedAtMs);
  /** Deadline for a step: its own budget, capped by what is left of the total. */
  const budget = (stepMs: number) => {
    const left = remaining();
    if (left <= 0) throw new RunError('deadline:total', 'active-work deadline exhausted');
    return { ms: Math.min(stepMs, left), capped: left < stepMs };
  };

  /** A bare-clone git step (cwd = verifyRoot, GIT_DIR = the bare clone) unless `wt` names the run worktree. */
  const git = async (args: string[], step: string, wt?: { gitDir: string; workTree: string }, stepMs = d.gitStepMs) => {
    const b = budget(stepMs);
    const r = await seams.git(args, {
      cwd: wt ? wt.workTree : p.verifyRoot, operation: `local-verify:${step}`, timeoutMs: b.ms,
      gitDir: wt ? wt.gitDir : p.bare, ...(wt ? { workTree: wt.workTree } : {}),
    });
    if (r.timedOut) throw new RunError(b.capped ? 'deadline:total' : `deadline:${step}`, 'git timed out');
    return r;
  };
  const gitOk = async (args: string[], step: string, wt?: { gitDir: string; workTree: string }, stepMs?: number) => {
    const r = await git(args, step, wt, stepMs);
    if (r.status !== 0) throw new RunError(step, (r.stderr || r.stdout).trim().slice(0, 300));
    return r.stdout;
  };

  const tmpDir = seams.fs.mkdtemp('lv-tmp-');
  const tmuxDir = seams.fs.mkdtemp('lv-tmux-');
  tempDirs.push(tmpDir, tmuxDir);
  const binDir = path.join(p.runDir, 'node_modules', '.bin');
  const runEnv: NodeJS.ProcessEnv = { ...input.baseEnv };
  delete runEnv.CI;
  runEnv.TMPDIR = tmpDir;
  runEnv.TMUX_TMPDIR = tmuxDir;
  // A UTF-8 locale, as GitHub's runners have (LANG=C.UTF-8). Without one, tmux
  // fixtures behave differently: found on the first full real run, where
  // dead-job-pane-cleanup failed only because the server had no locale set.
  if (!runEnv.LANG && !runEnv.LC_ALL && !runEnv.LC_CTYPE) runEnv.LANG = 'C.UTF-8';
  runEnv.PATH = [binDir, input.baseEnv.PATH ?? ''].filter(Boolean).join(path.delimiter);

  /** Run one process step; a deadline is an error naming the step. */
  const exec = async (command: string, args: string[], step: string, deadline: { ms: number; capped: boolean }, env = runEnv, signal?: AbortSignal) => {
    const t0 = seams.now();
    const r = await seams.exec(command, args, {
      cwd: p.runDir, env, deadlineMs: deadline.ms,
      onPid: (pid) => { ourPids.add(pid); },
      ...(signal ? { signal } : {}),
    });
    // Per-step timing (metadata only): the Acceptance measurement reads these.
    seams.log({ event: 'step', step, ms: seams.now() - t0, status: r.status ?? null, deadlineKilled: r.deadlineKilled, ...(r.aborted ? { stoppedEarly: true } : {}) });
    if (r.deadlineKilled) throw new RunError(deadline.capped ? 'deadline:total' : `deadline:${step}`, `${command} hit its deadline`);
    return r;
  };

  let failureReason: string | null = null;
  let evaluationReasons: string[] = [];
  let failures: FailureDetail[] = [];
  const flakyRetried: FlakyRetry[] = [];
  const firstMessages = new Map<string, string>();
  const rerunMessages = new Map<string, string>();
  let rerunBudget = LOCAL_VERIFY_LIMITS.isolationRerunMaxFiles;
  const reporter = seams.unhandledErrorsReporter?.() ?? null;
  let changedForIsolation: Set<string> | null = null;
  let outcome: LocalVerifyRecord['outcome'] = 'success';
  let errorStep: string | undefined;

  try {
    // ── 1. Bare clone, fetch, merge commit, worktree ──
    seams.fs.mkdirp(p.verifyRoot);
    seams.fs.mkdirp(p.runsDir);
    if (!bareCloneLooksIntact(seams, p.bare)) {
      // A missing or damaged clone (e.g. a crash mid-init left only HEAD) is wiped and re-made.
      if (seams.fs.exists(p.bare)) await seams.fs.removeTree(p.bare);
      await gitOk(['init', '--bare', '--quiet', p.bare], 'bare-clone');
    }
    seams.fs.writeFile(path.join(p.bare, 'config'), bareConfigTemplate(input.remoteUrl));
    await seams.fs.removeTree(path.join(p.bare, 'hooks'));
    seams.fs.mkdirp(path.join(p.bare, 'hooks'));

    await gitOk(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', input.headSha, input.baseSha], 'fetch', undefined, d.fetchMs);
    await gitOk(['update-ref', 'refs/heads/main', input.baseSha], 'update-ref');
    await gitOk(['update-ref', 'refs/remotes/origin/main', input.baseSha], 'update-ref');

    const mt = await git(['merge-tree', '--write-tree', input.baseSha, input.headSha], 'merge-tree');
    if (mt.status === 1) throw new RunError('conflict', 'merge conflict');
    if (mt.status !== 0) throw new RunError('merge-tree', mt.stderr.trim().slice(0, 300));
    mergeTree = mt.stdout.split('\n')[0].trim();
    mergeCommit = (await gitOk(
      // A `main` verify has head == base: one parent (a duplicate -p is an error line in git).
      input.headSha === input.baseSha
        ? ['commit-tree', mergeTree, '-p', input.baseSha, '-m', VERIFY_COMMIT_MESSAGE]
        : ['commit-tree', mergeTree, '-p', input.baseSha, '-p', input.headSha, '-m', VERIFY_COMMIT_MESSAGE],
      'commit-tree',
    )).trim();

    if (seams.fs.exists(p.runDir)) await removeWorktree(seams, p, p.runDir);
    await gitOk(['worktree', 'add', '--detach', p.runDir, mergeCommit], 'worktree-add');
    worktreeCreated = true;
    await seams.fs.removeTree(p.reportsDir);
    seams.fs.mkdirp(p.reportsDir);

    // ── 2. Install ──
    // HUSKY=0 for the install only: set for the lanes it makes husky's prepare
    // script print "HUSKY=0 skip install" on stdout, which breaks every test that
    // parses `npm pack --json` (found on the first full real runs).
    const ci = await exec('npm', ['ci', '--no-audit', '--no-fund'], 'npm-ci', budget(d.npmCiMs), { ...runEnv, HUSKY: '0' });
    if (ci.status !== 0) throw new RunError('npm-ci', `exit ${ci.status ?? ci.signal}`);

    // ── 3. Build, then the lint command list, then the lanes ──
    const pkgText = seams.fs.readFile(path.join(p.runDir, 'package.json'));
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(pkgText ?? '') as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      throw new RunError('build-config', 'package.json unreadable in the merge tree');
    }
    const buildLintDeadlineAt = seams.now() + d.buildLintMs;
    const shared = () => {
      const b = budget(Math.max(0, buildLintDeadlineAt - seams.now()));
      if (b.ms <= 0) throw new RunError('deadline:build-lint', 'build + lint budget exhausted');
      return b;
    };
    for (const [phase, list] of [['build', splitScript(scripts.build)], ['lint', splitScript(scripts.lint)]] as const) {
      for (const cmd of list) {
        const r = await exec('sh', ['-c', cmd], 'build-lint', shared());
        if (r.status !== 0) throw new RunFailure(`${phase}-failed:${cmd.slice(0, 80)}`);
      }
    }

    // Changed files (merge-base→head) for the isolation re-run's PR rule; null = unreadable.
    if (input.kind !== 'main') {
      try {
        const mb = (await gitOk(['merge-base', input.baseSha, input.headSha], 'merge-base')).trim();
        changedForIsolation = new Set(parseNameStatus(await gitOk(['diff', '--name-status', '--no-renames', mb, input.headSha], 'diff')).map((r) => r.path));
      } catch { changedForIsolation = null; }
    }

    // The inventory comes first: the isolation re-run needs each lane's assigned files.
    const tree = await gitOk(['ls-tree', '-r', '--name-only', mergeCommit], 'inventory');
    const inventory = computeInventory(tree.split('\n').filter(Boolean));

    // ── 4. The lanes, all at once, inside one suite slot ──
    // One foreign-suite check, then this run takes ONE full-suite slot of the host
    // test-runner bound and holds it for every lane; each lane's vitest is a child of
    // this (verify) process, so its own slot request nests under that hold instead of
    // queuing behind its sibling lanes. The e2e lane runs as LOCAL_VERIFY_LIMITS.e2eShards
    // vitest shards. Every lane process gets its own TMPDIR and TMUX_TMPDIR (its own
    // tmux server), which is what made a parallel e2e safe (spec "Parallel lanes").
    await singleFlight(LANES[0].name);
    const releaseSlot = seams.holdSuiteSlot ? await seams.holdSuiteSlot() : null;
    if (releaseSlot === 'busy') {
      const o = { at: seams.now(), beforeLane: LANES[0].name, holders: seams.foreignSuiteHolders(ourPids).map((h) => h.pid) };
      overlaps.push(o);
      seams.log({ event: 'overlap', ...o, slot: 'busy' });
      throw new Requeue('foreign-suite-at-start');
    }
    // Fail-fast (PR verifies, `input.failFast`): the first lane to end with a failure the
    // isolation re-run did not clear stops its siblings; their lanes are reported as stopped.
    const stopLanes = new AbortController();
    const failFast = input.failFast === true && input.kind !== 'main';
    // Per-file durations from earlier runs on this machine (balanced shards); unreadable ⇒ none.
    // Test code runs as the same user and could write this file: it is read only when small,
    // and it can only change which process runs a file (see shardPlan.ts), never a verdict.
    let durations: FileDurations = {};
    try {
      const size = seams.fs.size ? seams.fs.size(p.durationsPath) : null;
      if (size !== null && size <= DURATIONS_MAX_BYTES) durations = mergeDurations(JSON.parse(seams.fs.readFile(p.durationsPath) ?? '{}'), {});
      else if (size !== null) seams.log({ event: 'durations-ignored', bytes: size });
    } catch { durations = {}; }
    const observed: FileDurations = {};
    try {
      const settled = await Promise.allSettled(LANES.map((lane) => runLane(lane)));
      const firstError = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (firstError) throw firstError.reason;
      for (const s of settled) if (s.status === 'fulfilled') laneRuns.push(s.value);
    } finally {
      if (typeof releaseSlot === 'function') releaseSlot();
      // Keep what this run measured for the next run's shard plan (never part of a verdict).
      if (Object.keys(observed).length > 0) {
        try { seams.fs.writeFile(p.durationsPath, JSON.stringify(mergeDurations(durations, observed))); } catch { /* @silent-fallback-ok: a missed update only makes the next plan less balanced */ }
      }
    }

    async function runLane(lane: (typeof LANES)[number]): Promise<LaneRunInput> {
      const shards = lane.name === 'e2e' ? shardCount(input.laneShards?.e2e, LOCAL_VERIFY_LIMITS.e2eShards)
        : lane.name === 'integration' ? shardCount(input.laneShards?.integration, LOCAL_VERIFY_LIMITS.integrationShards) : 1;
      const plan = shards > 1 ? planShards(inventory.byLane[lane.name] ?? [], shards, durations) : null;
      if (shards > 1) seams.log({ event: 'shard-plan', lane: lane.name, shards, balanced: plan !== null });
      const laneEnv: NodeJS.ProcessEnv = { ...runEnv };
      if (lane.name === 'unit') {
        // 4 workers whatever the bound's posture: the nested clamp only applies while it
        // enforces, and the parallel lanes' worker total (4 + 1 + 1 + 1) is the claim.
        laneEnv.INSTAR_TEST_WORKERS = String(LOCAL_VERIFY_LIMITS.unitWorkersParallel);
        laneEnv.AUDIT_CHANGE_KIND = 'pull_request';
        laneEnv.AUDIT_CHANGE_BASE_SHA = input.baseSha;
        laneEnv.AUDIT_CHANGE_HEAD_SHA = input.headSha;
      }
      const t = seams.now();
      // allSettled: every shard's process has exited before the lane settles, even when one
      // shard hits its deadline (nothing is left running outside the slot or the cleanup).
      const settledParts = await Promise.allSettled(Array.from({ length: shards }, async (_, k) => {
        const key = shards > 1 ? `${lane.name}-${k + 1}` : lane.name;
        const reportPath = path.join(p.reportsDir, `${key}.json`);
        const errorsPath = path.join(p.reportsDir, `${key}.errors.json`);
        const pTmp = seams.fs.mkdtemp('lv-tmp-');
        const pTmux = seams.fs.mkdtemp('lv-tmux-');
        tempDirs.push(pTmp, pTmux);
        const env: NodeJS.ProcessEnv = { ...laneEnv, TMPDIR: pTmp, TMUX_TMPDIR: pTmux };
        if (reporter) env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE = errorsPath;
        const r = await exec(
          path.join(binDir, 'vitest'),
          ['run', '--config', lane.config, '--allowOnly=false', '--reporter=json', ...(reporter ? [`--reporter=${reporter}`] : []), `--outputFile=${reportPath}`,
            ...(plan ? plan[k] : shards > 1 ? [`--shard=${k + 1}/${shards}`] : [])],
          key, budget(d.lanes[lane.name]), env, failFast ? stopLanes.signal : undefined,
        );
        if (r.aborted) return { report: null, status: null, unhandled: null, aborted: true };
        let report: ParsedLaneReport | null = null;
        const text = seams.fs.readFile(reportPath);
        if (text != null) {
          try { report = parseVitestJson(text, p.runDir); } catch { report = null; }
        }
        const unhandled = reporter ? readUnhandledErrors(seams.fs.readFile(errorsPath)) : null;
        return { report, status: r.status, unhandled, aborted: false };
      }));
      const shardError = settledParts.find((x): x is PromiseRejectedResult => x.status === 'rejected');
      if (shardError) throw shardError.reason;
      const parts = settledParts.map((x) => (x as PromiseFulfilledResult<{ report: ParsedLaneReport | null; status: number | null; unhandled: number | null; aborted: boolean }>).value);
      if (parts.some((x) => x.aborted)) {
        seams.log({ event: 'lane-stopped-early', lane: lane.name });
        return { lane: lane.name, report: null, seconds: Math.round((seams.now() - t) / 1000), exitCode: null, stoppedEarly: true };
      }
      // A lane's report is the union of its shards' reports; a missing shard report is a
      // missing lane report (the inventory rule then fails the run).
      // A file reported by two shards makes the lane report untrusted (missing): the verdict
      // must not depend on which shard's entry was kept.
      let report: ParsedLaneReport | null = { files: new Map() };
      for (const part of parts) {
        if (!part.report || !report) { report = null; continue; }
        for (const [f, c] of part.report.files) {
          if (lane.name !== 'unit' && typeof c.ms === 'number') observed[f] = c.ms;
          if (report.files.has(f)) {
            seams.log({ event: 'file-in-multiple-shards', lane: lane.name, file: f });
            report = null;
            break;
          }
          report.files.set(f, c);
        }
      }
      // A numeric non-zero exit of any shard wins over a signal exit (null), so a shard killed
      // after writing its report can never hide its sibling's failed exit.
      const nonZero = parts.find((x) => typeof x.status === 'number' && x.status !== 0);
      let exitCode: number | null = nonZero ? nonZero.status : parts.some((x) => x.status === null) ? null : 0;
      const unhandled = parts.some((x) => x.unhandled === null) ? null : parts.reduce((n, x) => n + (x.unhandled as number), 0);
      // Isolation re-run: a lane whose only problem is 1..3 failed files re-runs exactly
      // those files once, one at a time, under what is left of the lane budget.
      const failedHere = report ? [...report.files.entries()].filter(([, c]) => c.failed > 0).map(([f]) => f) : [];
      const ineligible = failedHere.length > 0 ? await ineligibleFor(failedHere) : new Set<string>();
      // Read and spend the shared re-run budget with no await in between: lanes finish concurrently.
      const decision = decideIsolationRerun({
        report, laneFiles: inventory.byLane[lane.name] ?? [],
        maxFiles: LOCAL_VERIFY_LIMITS.isolationRerunMaxFiles, budgetLeft: rerunBudget,
        unhandledErrors: unhandled,
        ineligible,
      });
      if (decision.rerun.length > 0 && report) {
        rerunBudget -= decision.rerun.length;
        const laneDeadlineAt = t + d.lanes[lane.name];
        const allPassed = await isolationRerun(lane.name, lane.config, decision.rerun, report, laneEnv, laneDeadlineAt, failFast ? stopLanes.signal : undefined);
        // The exit code is cleared only when the failed files explain it: they all passed alone
        // AND the lane reported zero unhandled errors (checked before the re-run).
        if (allPassed && unhandled === 0) exitCode = 0;
      } else if (decision.reason !== 'no-failures') {
        seams.log({ event: 'isolation-rerun-skipped', lane: lane.name, reason: decision.reason });
      }
      if (failFast && !stopLanes.signal.aborted && laneFailedFinally(report, exitCode)) {
        seams.log({ event: 'lanes-stop', after: lane.name });
        stopLanes.abort();
      }
      return { lane: lane.name, report, seconds: Math.round((seams.now() - t) / 1000), exitCode };
    }

    /** A shard count from the run input, clamped to 1..MAX_LANE_SHARDS; anything else is the default. */
    function shardCount(v: number | undefined, fallback: number): number {
      return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_LANE_SHARDS ? v : fallback;
    }

    /**
     * A lane that will fail the run whatever its siblings do (counted after any isolation re-run).
     * Mirrors `evaluateRun`'s lane rules exactly: a missing report, a failed file, or a NUMERIC
     * non-zero exit (a null exit with a clean report is not a lane failure there, so not here).
     */
    function laneFailedFinally(report: ParsedLaneReport | null, exitCode: number | null): boolean {
      if (!report) return true;
      for (const c of report.files.values()) if (c.failed > 0) return true;
      return exitCode != null && exitCode !== 0;
    }

    // ── 5. Tree must be clean, then the inventory rule ──
    const wtGitDir = worktreeGitDir(seams, p);
    if (!wtGitDir) throw new RunError('porcelain', 'run worktree admin dir unreadable');
    const st = await git(['status', '--porcelain'], 'porcelain', { gitDir: wtGitDir, workTree: p.runDir });
    if (st.status !== 0) throw new RunError('porcelain', st.stderr.trim().slice(0, 200));
    const dirty = st.stdout.trim().length > 0;

    const ev = evaluateRun(inventory, laneRuns);
    evaluationReasons = ev.reasons;
    failures = Object.entries(ev.perFile)
      .filter(([, c]) => c.failed > 0)
      .slice(0, FAILURE_DETAILS_MAX)
      .map(([file, c]) => ({ file, lane: c.lane, failed: c.failed, message: firstMessages.get(file) ?? c.message ?? '', ...(rerunMessages.has(file) ? { rerunMessage: rerunMessages.get(file)! } : {}) }));
    if (dirty) evaluationReasons = [...evaluationReasons, 'dirty-tree'];
    if (evaluationReasons.length > 0) {
      outcome = 'failure';
      failureReason = evaluationReasons[0];
    }
    flags = await classify();
  } catch (e) {
    if (e instanceof Requeue) {
      await cleanup(false);
      return { kind: 'requeue', reason: e.reason, overlaps };
    }
    if (e instanceof RunFailure) {
      outcome = 'failure';
      failureReason = e.reason;
      evaluationReasons = [e.reason];
      flags = await classify().catch(() => ({ ...flags, harnessChanging: true }));
    } else {
      outcome = 'error';
      errorStep = e instanceof RunError ? e.step : 'crash';
      evaluationReasons = [e instanceof Error ? e.message : String(e)];
    }
  }

  const lanes = laneTotals(laneRuns);
  const record: LocalVerifyRecord = {
    repo: input.repo, pr: input.pr, headSha: input.headSha, baseSha: input.baseSha, baseRefName: input.baseRefName,
    mergeTree, lanes, nodeVersion: input.nodeVersion, machineId: input.machineId,
    startedAt: new Date(startedAtMs).toISOString(), finishedAt: new Date(seams.now()).toISOString(),
    outcome, ...flags, verifierVersion: input.verifierVersion, policyHash: input.policyHash,
  };
  if (errorStep) record.errorStep = errorStep;
  if (input.kind === 'main') record.kind = 'main';
  if (input.attempt && input.kind !== 'main') record.attempt = { id: input.attempt.id, coordinatorMachineId: input.attempt.coordinatorMachineId, leaseEpoch: input.attempt.leaseEpoch };
  if (flakyRetried.length > 0) record.flakyRetried = flakyRetried.slice(0, FLAKY_RETRIED_MAX);
  const kept = await cleanup(outcome !== 'success');
  const v = validateRecord(record);
  if (!v.ok) return { kind: 'invalid', errors: v.errors };
  seams.log({ event: 'run-finished', pr: input.pr, headSha: input.headSha, outcome, errorStep, failureReason, reasons: evaluationReasons.slice(0, 20) });
  return { kind: 'record', record, reasons: evaluationReasons, overlaps, keptWorktree: kept, failures, ...(flakyRetried.length ? { flakyRetried } : {}) };

  // ── helpers (closures over the run) ──

  /**
   * Failed files that must NOT be treated as possibly flaky (PR verifies): every one when the
   * PR rule cannot be applied (no green `main` record, no isolation input, unreadable diff);
   * otherwise files the PR changed and files importing a changed file (static relative-import
   * scan). A file that was itself re-run-passed on the last green `main` stays eligible: it is
   * flaky on `main` already, so refusing its re-run failed every PR that hit the flake. A `main`
   * verify uses the plain rule (nothing is ineligible).
   */
  async function ineligibleFor(failed: readonly string[]): Promise<Set<string>> {
    if (input.kind === 'main') return new Set();
    const iso = input.isolation;
    if (!iso || !iso.allowed || changedForIsolation === null) return new Set(failed);
    const out = new Set<string>();
    const notClean = new Set(iso.notCleanOnGreenMain);
    for (const f of failed) {
      if (changedForIsolation.has(f)) { out.add(f); continue; }
      if (notClean.has(f)) seams.log({ event: 'isolation-rerun-flaky-on-main', file: f });
      let graph: string[] = [];
      try { graph = seams.importGraph ? seams.importGraph([path.join(p.runDir, f)]) : []; } catch { graph = []; }
      if (!seams.importGraph) { out.add(f); continue; } // no import scan available ⇒ cannot rule a change out
      const rel = graph.map((g) => path.relative(p.runDir, g).split(path.sep).join('/'));
      if (rel.some((g) => changedForIsolation!.has(g))) out.add(f);
    }
    if (out.size) seams.log({ event: 'isolation-rerun-ineligible', files: [...out].slice(0, 10) });
    return out;
  }

  /* @self-action-controller: local-verify-flake-rerun */
  /**
   * Re-run each failed file alone, once, with the lane's own config, env and flags. A file
   * that passes replaces its counts in the lane report and is recorded as flaky; one that
   * fails again keeps the first run's counts and both messages. A re-run that would start
   * past the lane deadline, or hits it, counts as failing again (never an infrastructure
   * error: the lane itself finished in time). Returns true when every re-run passed.
   */
  async function isolationRerun(
    lane: LaneName, config: string, files: readonly string[], report: ParsedLaneReport, env: NodeJS.ProcessEnv, laneDeadlineAt: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let all = true;
    for (let k = 0; k < files.length; k++) {
      const file = files[k];
      const first = report.files.get(file)!;
      firstMessages.set(file, first.message ?? '');
      const ms = Math.min(laneDeadlineAt - seams.now(), remaining());
      if (ms <= 0) {
        rerunMessages.set(file, 'isolation re-run not started: lane budget spent');
        seams.log({ event: 'isolation-rerun', lane, file, outcome: 'no-budget' });
        all = false;
        continue;
      }
      const out = path.join(p.reportsDir, `${lane}-rerun-${k}.json`);
      const errs = path.join(p.reportsDir, `${lane}-rerun-${k}.errors.json`);
      // A fresh TMPDIR and TMUX_TMPDIR for each re-run (nothing from the lane run leaks in).
      const rTmp = seams.fs.mkdtemp('lv-tmp-');
      const rTmux = seams.fs.mkdtemp('lv-tmux-');
      tempDirs.push(rTmp, rTmux);
      const rEnv: NodeJS.ProcessEnv = { ...env, TMPDIR: rTmp, TMUX_TMPDIR: rTmux, ...(reporter ? { LOCAL_VERIFY_UNHANDLED_ERRORS_FILE: errs } : {}) };
      const r = await seams.exec(
        path.join(binDir, 'vitest'),
        ['run', '--config', config, '--allowOnly=false', '--reporter=json', ...(reporter ? [`--reporter=${reporter}`] : []), `--outputFile=${out}`, file],
        { cwd: p.runDir, env: rEnv, deadlineMs: ms, onPid: (pid) => { ourPids.add(pid); }, ...(signal ? { signal } : {}) },
      );
      if (r.aborted) {
        // The run already failed in another lane: the re-run's answer no longer matters.
        rerunMessages.set(file, 'isolation re-run stopped: another lane had already failed');
        seams.log({ event: 'isolation-rerun', lane, file, outcome: 'stopped' });
        all = false;
        continue;
      }
      let again: ParsedLaneReport | null = null;
      const text = r.deadlineKilled ? null : seams.fs.readFile(out);
      if (text != null) { try { again = parseVitestJson(text, p.runDir); } catch { again = null; } }
      const c = again?.files.get(file);
      const rerunUnhandled = r.deadlineKilled ? null : readUnhandledErrors(seams.fs.readFile(errs));
      const passed = !!c && c.failed === 0 && c.passed > 0 && r.status === 0 && rerunUnhandled === 0;
      seams.log({ event: 'isolation-rerun', lane, file, outcome: passed ? 'passed' : r.deadlineKilled ? 'deadline' : 'failed' });
      if (passed) {
        report.files.set(file, { ...c!, message: '' });
        flakyRetried.push({ file, lane, firstMessage: (first.message ?? '').slice(0, 400) });
      } else {
        all = false;
        rerunMessages.set(file, r.deadlineKilled ? 'isolation re-run hit the lane deadline' : (c?.message || `isolation re-run exit ${r.status ?? r.signal}`));
      }
    }
    return all;
  }

  /** A live foreign full suite before the lanes start re-queues the run (never an attempt). */
  async function singleFlight(lane: LaneName): Promise<void> {
    const holders = seams.foreignSuiteHolders(ourPids);
    if (holders.length === 0) return;
    const o = { at: seams.now(), beforeLane: lane, holders: holders.map((h) => h.pid) };
    overlaps.push(o);
    seams.log({ event: 'overlap', ...o });
    throw new Requeue('foreign-suite-at-start');
  }

  async function classify(): Promise<Flags> {
    const out: Flags = { harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false };
    let rows: Array<{ status: string; path: string }> | null = null;
    try {
      const mb = (await gitOk(['merge-base', input.baseSha, input.headSha], 'merge-base')).trim();
      const diff = await gitOk(['diff', '--name-status', '--no-renames', mb, input.headSha], 'diff');
      rows = parseNameStatus(diff);
      const show = async (rev: string, file: string): Promise<string | null> => {
        const r = await git(['show', `${rev}:${file}`], 'show');
        if (r.status !== 0) throw new Error(`show ${rev}:${file} failed`);
        return r.stdout;
      };
      const pair = async (file: string, status: string) => ({
        base: status === 'A' ? null : await show(mb, file),
        head: status === 'D' ? null : await show(input.headSha, file),
      });
      const changedPaths = rows.map((r) => r.path);
      const pj = rows.find((r) => r.path === 'package.json');
      const pl = rows.find((r) => r.path === 'package-lock.json');
      const verdict = classifyHarness({
        changedPaths,
        packageJson: pj ? await pair(pj.path, pj.status) : { base: null, head: await show(input.headSha, 'package.json').catch(() => null) },
        packageLock: pl ? await pair(pl.path, pl.status) : undefined,
        extraGlobs: input.extraHarnessGlobs,
      });
      out.harnessChanging = verdict.harnessChanging;
      out.protectedPath = isProtectedPath(changedPaths, input.protectedList);
      const tests: ChangedTestFile[] = [];
      for (const r of rows) {
        if (!r.path.endsWith('.test.ts')) continue;
        const t = await pair(r.path, r.status);
        tests.push({ path: r.path, base: t.base, head: t.head });
      }
      // The ratchet cannot be measured without the parser. That is not a harness
      // change: the record says what it could not rule out (skips added, tests
      // removed), and the changed test files are the paths a review must cover.
      let ratchetPaths: string[];
      try {
        const ratchet = evaluateSkipRatchet(tests, seams.typescript ? seams.typescript() : loadTypescript([p.runDir]));
        out.skipsAdded = ratchet.skipsAdded;
        out.testsRemoved = ratchet.testsRemoved;
        ratchetPaths = ratchet.perFile.map((f) => f.path);
      } catch (e) {
        ratchetPaths = tests.map((t) => t.path).filter((f) => isInventoried(f));
        // Always logged (the 2026-10-23 misclassification went unseen for lack of a signal); flagged only when it matters.
        seams.log({ event: 'skip-ratchet-failure', inventoriedChanged: ratchetPaths.length, detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        if (ratchetPaths.length > 0) {
          out.skipsAdded = true;
          out.testsRemoved = true;
        }
      }
      if (out.harnessChanging || out.protectedPath || out.skipsAdded || out.testsRemoved) {
        // The paths that flagged the record; an independent second-pass review must cover them all.
        const harnessPaths = out.harnessChanging ? harnessReasonPaths(verdict.reasons) : [];
        const flaggedPaths = harnessPaths === null ? null : [...new Set([
          ...harnessPaths,
          ...protectedPathMatches(changedPaths, input.protectedList),
          ...(out.skipsAdded || out.testsRemoved ? ratchetPaths : []),
        ])].sort();
        const review = await findIndependentReview(rows, flaggedPaths, show, mb);
        if (review) out.independentReview = review;
      }
    } catch (e) {
      // Any read failure classifies the PR as harness-changing (routes it to the operator).
      seams.log({ event: 'classify-read-failure', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      out.harnessChanging = true;
      if (rows) out.protectedPath = isProtectedPath(rows.map((r) => r.path), input.protectedList);
      else out.protectedPath = true;
    }
    return out;
  }

  /**
   * An instar-dev trace this PR added or changed, read from the head's tree (so
   * nothing committed after the head counts), whose second pass concurred and
   * whose coveredFiles include every flagged path. One judge, shared with the
   * pre-commit gate (scripts/lib/instar-dev-trace.mjs).
   *
   * Bound to the head (replaces the head-binding the operator approval had, i.e.
   * dismiss-stale-reviews-on-push): no flagged path may have changed after the
   * trace's last commit — `git log <traceLast>..<head> -- <flagged>` must be empty,
   * so the last commit touching any flagged path is the trace's commit or an
   * ancestor of it. A later push that edits a flagged file needs a new review.
   */
  async function findIndependentReview(
    rows: Array<{ status: string; path: string }>,
    flaggedPaths: string[] | null,
    show: (rev: string, file: string) => Promise<string | null>,
    mergeBase: string,
  ): Promise<{ trace: string; concurred: true } | null> {
    const problems: string[] = [];
    for (const r of rows) {
      if (r.status === 'D' || !isTracePath(r.path)) continue;
      let trace: unknown = null;
      try { trace = JSON.parse((await show(input.headSha, r.path)) ?? ''); } catch { /* @silent-fallback-ok: an unreadable trace counts as no review; the absence is logged below */ trace = null; }
      const artifactPath = trace && typeof trace === 'object' ? (trace as { artifactPath?: unknown }).artifactPath : undefined;
      const artifactText = typeof artifactPath === 'string' && artifactPath
        ? await show(input.headSha, artifactPath).catch(() => null)
        : null;
      const problem = independentReviewProblem({ trace, flaggedPaths, artifactText }) ?? await staleAfterTrace(r.path, flaggedPaths ?? [], mergeBase);
      if (problem === null) return { trace: r.path, concurred: true };
      problems.push(`${r.path}: ${problem}`);
    }
    seams.log({ event: 'independent-review-absent', flaggedPaths: flaggedPaths ?? 'unknown', problems: problems.slice(0, 10) });
    return null;
  }

  /** null when no flagged path changed after the trace's last commit; otherwise the reason. */
  async function staleAfterTrace(tracePath: string, flaggedPaths: string[], mergeBase: string): Promise<string | null> {
    const t = await git(['log', '-1', '--format=%H', `${mergeBase}..${input.headSha}`, '--', tracePath], 'review-binding');
    const traceLast = t.status === 0 ? t.stdout.trim() : '';
    if (!isValidSha(traceLast)) return 'trace-commit-unreadable';
    const later = await git(['log', '--format=%H', `${traceLast}..${input.headSha}`, '--', ...flaggedPaths], 'review-binding');
    if (later.status !== 0) return 'review-binding-unreadable';
    const after = later.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
    return after.length ? `flagged-changed-after-trace:${after[0].slice(0, 12)}` : null;
  }

  async function cleanup(failed: boolean): Promise<string | null> {
    let kept: string | null = null;
    try {
      if (worktreeCreated) {
        if (failed) {
          kept = p.runDir;
          await keepFailed(seams, p);
        } else {
          await removeWorktree(seams, p, p.runDir);
        }
      }
    } catch (e) {
      seams.log({ event: 'cleanup-failed', detail: e instanceof Error ? e.message : String(e) });
    }
    for (const dir of [...tempDirs, p.reportsDir]) {
      await seams.fs.removeTree(dir).catch(() => { /* @silent-fallback-ok: temp cleanup is best-effort; logged by the seam */ });
    }
    return kept;
  }
}

function laneTotals(runs: readonly LaneRunInput[]): LaneTotals[] {
  // Totals for lanes that actually ran (a run stopped early records fewer lanes).
  if (runs.length === 0) return [];
  const ev = evaluateRun({ files: [], errors: [], byLane: { unit: [], integration: [], e2e: [] } }, runs);
  const ran = new Set(runs.map((r) => r.lane));
  return ev.lanes.filter((l) => ran.has(l.name));
}

/** A usable bare clone has HEAD, objects/ and refs/ (init is skipped only then). */
export function bareCloneLooksIntact(seams: OrchestratorSeams, bare: string): boolean {
  return ['HEAD', 'objects', 'refs'].every((x) => seams.fs.exists(path.join(bare, x)));
}

/**
 * The run worktree's admin dir, read from its `.git` file (`gitdir: <bare>/worktrees/<name>`);
 * null when unreadable or not under the bare clone's worktrees/ (the seam refuses anything else too).
 */
export function worktreeGitDir(seams: OrchestratorSeams, p: VerifyPaths): string | null {
  const text = seams.fs.readFile(path.join(p.runDir, '.git'));
  const m = text?.match(/^gitdir:\s*(.+)\s*$/m);
  if (!m) return null;
  const dir = path.resolve(p.runDir, m[1].trim());
  // The admin dir is `<bare>/worktrees/<name>`; git writes it realpath'd, so compare the shape
  // here and leave the scope check (realpath inside verifyRoot) to the SafeGitExecutor carve-out.
  return path.basename(path.dirname(dir)) === 'worktrees' && path.basename(path.dirname(path.dirname(dir))) === path.basename(p.bare)
    ? dir : null;
}

/** `worktree remove`, falling back to deleting the directory and `worktree prune`. */
export async function removeWorktree(seams: OrchestratorSeams, p: VerifyPaths, dir: string): Promise<void> {
  const r = await seams.git(['worktree', 'remove', dir], {
    cwd: p.verifyRoot, gitDir: p.bare, operation: 'local-verify:worktree-remove', timeoutMs: LOCAL_VERIFY_DEADLINES.gitStepMs,
  });
  if (r.status === 0 && !seams.fs.exists(dir)) return;
  await seams.fs.removeTree(dir);
  await seams.git(['worktree', 'prune'], {
    cwd: p.verifyRoot, gitDir: p.bare, operation: 'local-verify:worktree-prune', timeoutMs: LOCAL_VERIFY_DEADLINES.gitStepMs,
  });
}

/** Record a kept failed-run worktree; drop the oldest beyond the cap. */
async function keepFailed(seams: OrchestratorSeams, p: VerifyPaths): Promise<void> {
  let list: string[] = [];
  try {
    const raw = seams.fs.readFile(p.keptListFile);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === 'string');
  } catch { list = []; }
  list = list.filter((d) => d !== p.runDir);
  list.push(p.runDir);
  while (list.length > LOCAL_VERIFY_LIMITS.keepFailedWorktrees) {
    const oldest = list.shift()!;
    if (seams.fs.exists(oldest)) await removeWorktree(seams, p, oldest);
  }
  seams.fs.writeFile(p.keptListFile, JSON.stringify(list));
}

/**
 * Focused preflight may shorten a stable red, but a green still requires every full lane.
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

import crypto from 'node:crypto';
import path from 'node:path';
import { computeInventory, isInventoried, LANES, type LaneName } from './inventory.js';
import { readProgress, readUnhandledErrors } from './unhandledErrorsReporter.js';

/** A progress snapshot larger than this is ignored (it is at most ~10 short paths). */
const PROGRESS_MAX_BYTES = 64 * 1024;
import {
  decideIsolationRerun, evaluateRun, importRelatedEligibility, parseVitestJson, passedByName, withoutNames,
  type FileCounts, type FlakyOnMainFile, type FlakyOnMainTest, type ImportRelatedRefusal, type LaneRunInput, type LaneTotals, type ParsedLaneReport,
} from './laneReport.js';
import { boundedTail } from '../core/boundedInput.js';
import { evaluateSkipRatchet, loadTypescript, type ChangedTestFile, type TsModule } from './skipRatchet.js';
import { classifyHarness, harnessReasonPaths, protectedPath as isProtectedPath, protectedPathMatches } from './harnessClassifier.js';
import { independentReviewProblem, isTracePath } from '../../scripts/lib/instar-dev-trace.mjs';
import { FLAKY_RETRIED_MAX, isValidSha, validateRecord, type FlakyRetry, type LocalVerifyRecord, type PreflightEvidence } from './record.js';
import { effectivePreflightMode, PREFLIGHT_LIMITS } from './preflight.js';
import { PreflightCleanupError, runFocusedPreflight } from './runFocusedPreflight.js';
import { IMPORT_RELATED_RERUN, LOCAL_VERIFY_DEADLINES, LOCAL_VERIFY_IDENTITY, LOCAL_VERIFY_LIMITS, type LocalVerifyDeadlines } from './policy.js';
export type { FlakyOnMainFile, FlakyOnMainTest, ImportRelatedRefusal } from './laneReport.js';
import { DURATIONS_MAX_BYTES, mergeDurations, planShards, type FileDurations } from './shardPlan.js';
import type { LeftoverPrefix, ReapOptions, ReapResult } from './leftoverReaper.js';
import { firstPartActive, selectFirstPart, type FirstPartInput, type FirstPartLaneSummary, type FirstPartSelection, type FirstPartSummary } from './firstPart.js';
import type { FileOutcome } from './firstPartTrial.js';

/** Upper bound on processes per slow lane (bounded blast radius: at most 4 + 4 + 4 test workers). */
export const MAX_LANE_SHARDS = 4;
/** Upper bound for the per-machine unit-lane worker setting (`laneShards.unitWorkers`). */
export const MAX_UNIT_WORKERS = 12;

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
  /** For isolated preflight commands, every process in the dedicated group exited. */
  quiescent?: boolean;
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
  /** Entry names of a directory; null when unreadable. Absent seam ⇒ the orphan sweep is skipped. */
  list?(p: string): string[] | null;
  /** Resolved path; null when it cannot be resolved. */
  realpath?(p: string): string | null;
  /**
   * Whether any running process uses `dir` (its working folder is inside it, or
   * its command line names it). null when that cannot be read. Absent seam ⇒
   * the orphan sweep is skipped.
   */
  inUse?(dir: string): boolean | null;
  /** Bytes under `dir` (every file, recursively); null when that cannot be read. Absent seam ⇒ kept entries are listed without a size. */
  treeSize?(dir: string): number | null;
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
    opts: { cwd: string; env: NodeJS.ProcessEnv; deadlineMs: number; onPid?: (pid: number) => void; signal?: AbortSignal; isolatedGroup?: boolean },
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
  /**
   * Record a degradation beyond the run log, so a problem that silently stops a safety
   * behaviour (an unreadable kept-failed.json stopping all sweeping) is seen without
   * reading a run's log. The run child collects these into its result; the server's
   * DegradationReporter records them (the child must not write the server's file). Absent ⇒ log only.
   */
  degrade?(event: RunDegradation): void;
  /** Every file reachable through relative imports from `files` (absolute paths; roots included). */
  importGraph?(files: string[]): string[];
  /** Absolute path of the trusted unhandled-errors reporter; null/absent ⇒ unknown ⇒ no isolation re-run. */
  unhandledErrorsReporter?(): string | null;
  /**
   * The TypeScript module for the skip ratchet's parser. Absent ⇒ resolved from the
   * run worktree (installed by `npm ci`), then the verifier's own install.
   */
  typescript?(): TsModule;
  /**
   * End this machine's leftover processes under the given path prefixes (leftoverReaper.ts:
   * own user only, never this process or its ancestors; SIGCONT then SIGKILL). Absent ⇒ no reap.
   */
  reapLeftovers?(prefixes: LeftoverPrefix[], opts?: ReapOptions): Promise<ReapResult>;
}

/**
 * The run's own folders as reaper prefixes: its run worktree and every temp folder it made,
 * in both spellings macOS shows for `/private/tmp` (commands print either).
 */
export function runLeftoverPrefixes(runDir: string, tempDirs: readonly string[]): LeftoverPrefix[] {
  const out = new Set<string>();
  for (const d of [runDir, ...tempDirs]) {
    const bare = d.replace(/\/+$/, '');
    if (bare.length < 6) continue;
    out.add(bare);
    if (bare.startsWith('/private/')) out.add(bare.slice('/private'.length));
  }
  return [...out].map((prefix) => ({ prefix, minAgeS: 0 }));
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
   * `importRelatedRerun` (the coordinator's switch, absent ⇒ off) and `flakyOnMain` (its list
   * of tests a `main` verify saw fail and pass alone) let a failed file that imports a changed
   * file be re-run three times when every one of its failed tests is on that list (spec
   * local-verify-import-related-rerun.md). This child reads neither config nor the history.
   */
  isolation?: IsolationInput;
  /** A peer verify (spec local-verify-capacity.md Part D): copied onto the record as `attempt`. */
  attempt?: { id: string; coordinatorMachineId: string; leaseEpoch: number | null };
  /**
   * PR verifies only: once a lane ends with a failure the isolation re-run did not clear, stop
   * the other lanes (the verdict is already `failure`). Absent/false ⇒ every lane runs to the end.
   */
  failFast?: boolean;
  /** Host-local focused preflight posture, read once when this attempt starts. */
  preflightMode?: 'off' | 'observe' | 'enforce';
  /** True only for an automatic watcher candidate that can be rediscovered after a lease move. */
  preflightRediscoverable?: boolean;
  /**
   * Processes per slow lane (`monitoring.localVerify.laneShards`, clamped 1..4 by the service),
   * and the per-machine unit-lane worker count `unitWorkers` (1..MAX_UNIT_WORKERS).
   * Absent ⇒ `LOCAL_VERIFY_LIMITS.integrationShards` / `e2eShards` / `unitWorkersParallel`.
   */
  laneShards?: { integration?: number; e2e?: number; unitWorkers?: number };
  extraHarnessGlobs?: readonly string[];
  /**
   * PR verifies only (spec local-verify-likely-failing-first.md): this machine's setting is `on`
   * or `alternate`, with the coordinator's assignment of the pull request, the change's previous
   * failures and the likely-failing list in use. Absent ⇒ the setting is off here and the verify
   * runs exactly as it did before first parts existed. `main` verifies ignore it.
   */
  likelyFailingFirst?: FirstPartInput;
  /** Return what every reported file did (`fileOutcomes`): asked for only around the verdict check. */
  collectFileOutcomes?: boolean;
  /**
   * `compare`: the verdict check's comparison run. It gets its own fresh checkout and report
   * folder (so the verify it follows keeps its kept worktree), and never keeps a failed worktree.
   */
  variant?: 'compare';
  /** Already-scrubbed base environment (allowlisted by the service). */
  baseEnv: Record<string, string>;
  deadlines?: LocalVerifyDeadlines;
}

/** The isolation block of a run input (built by the service; sent whole to a peer). */
export interface IsolationInput {
  allowed: boolean;
  notCleanOnGreenMain: readonly string[];
  importRelatedRerun?: boolean;
  flakyOnMain?: readonly FlakyOnMainFile[];
}

/**
 * Import-related failed files that got no re-run, by kind, each list bounded with its true
 * count beside it (the PR `run-detail` audit line carries them: the review reads the audit log).
 */
export interface IsolationRefusals {
  noMainEvidence: ImportRelatedRefusal[];
  noMainEvidenceCount: number;
  noMainEvidenceForTest: ImportRelatedRefusal[];
  noMainEvidenceForTestCount: number;
  importRelatedRefused: ImportRelatedRefusal[];
  importRelatedRefusedCount: number;
}

/** The first failing test of a failed file, bounded (spec §2: the full detail lives in the audit, not the status). */
export interface FailureDetail {
  file: string;
  lane: string;
  failed: number;
  message: string;
  /**
   * Set when the file was re-run alone and failed again: the re-run's message. For an
   * import-related file it starts `solo run n of 3: ` (or names a detail-only run) and the text
   * after it keeps the END of the failure, with a cut disclosed.
   */
  rerunMessage?: string;
}

/** At most this many failure details travel with a result. */
export const FAILURE_DETAILS_MAX = 30;

export interface Overlap {
  at: number;
  beforeLane: LaneName;
  holders: number[];
}

/** A degradation the run child noticed (disk-steward §5); the server's reporter records it. */
export interface RunDegradation { feature: string; primary: string; fallback: string; reason: string; impact: string }

export type VerifyRunResult = (
  | {
    kind: 'record'; record: LocalVerifyRecord; reasons: string[]; overlaps: Overlap[]; keptWorktree: string | null; failures?: FailureDetail[]; flakyRetried?: FlakyRetry[];
    /** PR verifies with the import-related rule on: the import-related files that got no re-run. */
    isolationRefusals?: IsolationRefusals;
    /**
     * `main` verifies: for each `flakyRetried` file, the distinguishing failure line of each test
     * the record names (the same names, nothing more). The service stores it with the evidence.
     */
    flakyTestLines?: Record<string, Array<{ test: string; line: string; lineCut?: true }>>;
    /** Present when the run input carried `likelyFailingFirst`: the assignment, the setting, and each lane's first part as numbers. */
    firstPart?: FirstPartSummary;
    /** Present when asked for (`collectFileOutcomes`) and the lanes were evaluated: what every reported file did. */
    fileOutcomes?: Record<string, FileOutcome>;
  }
  | { kind: 'requeue'; reason: 'foreign-suite-at-start' | 'foreign-suite-wait-exceeded'; overlaps: Overlap[] }
  | { kind: 'invalid'; errors: string[] }
) & {
  /** Carried from the run child to the server, which has the only DegradationReporter that reaches /health. */
  degradations?: RunDegradation[];
};

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

export function verifyPaths(agentHome: string, headSha: string, variant?: 'compare'): VerifyPaths {
  const verifyRoot = path.join(agentHome, '.worktrees', '.verify');
  // The comparison run's folders have their own 12-hex name, so the orphan sweep still knows them
  // and they never collide with the verify they follow (same head, same merge commit).
  const sha12 = variant === 'compare' ? crypto.createHash('sha256').update(`compare:${headSha}`).digest('hex').slice(0, 12) : headSha.slice(0, 12);
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
  const p = verifyPaths(input.agentHome, input.headSha, input.variant);
  const startedAtMs = seams.now();
  // Written at the start, so a set-up failure and a verify with empty first parts stay in their group.
  const firstPartInput = input.kind === 'main' ? undefined : input.likelyFailingFirst;
  const firstPartOn = firstPartActive(firstPartInput, input.kind);
  const firstParts = new Map<LaneName, FirstPartSelection>();
  const firstPartNotes = new Map<LaneName, FirstPartLaneSummary>();
  if (firstPartInput) seams.log({ event: 'first-part-setting', pr: input.pr, setting: firstPartInput.setting, group: firstPartInput.group ?? null, active: firstPartOn });
  /** Failed files whose re-run alone was cut off by another lane's failure (never shown to fail again). */
  const rerunCutOff = new Set<string>();
  let fileOutcomes: Record<string, FileOutcome> | null = null;
  const overlaps: Overlap[] = [];
  const ourPids = new Set<number>();
  const laneRuns: LaneRunInput[] = [];
  const tempDirs: string[] = [];
  let mergeTree = '';
  let mergeCommit = '';
  let worktreeCreated = false;
  let flags: Flags = { harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false };
  let enteredPreflight = false;
  let preflight: PreflightEvidence | undefined;
  let preflightStartedAt: number | null = null;
  let preflightEnded = false;

  const remaining = () => d.totalActiveMs + (enteredPreflight ? PREFLIGHT_LIMITS.totalMs : 0) - (seams.now() - startedAtMs);
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
  let boundedFailedFiles: string[] | null = null;
  const flakyRetried: FlakyRetry[] = [];
  const importRelatedRefusals: ImportRelatedRefusal[] = [];
  const flakyTestLines: Record<string, Array<{ test: string; line: string; lineCut?: true }>> = {};
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
    // Checkouts left by runs cut short (restart, update, crash) are never cleaned by
    // their own run; sweep them now, while this run is the only one (disk-steward §5).
    await sweepOrphanVerifyRuns(seams, p);

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

    // Charge the optional preflight for its exact-base changed-file scan too.
    // The scan remains necessary for isolation re-runs when preflight is off.
    const mode = effectivePreflightMode(input.preflightMode, input.kind === 'main' ? 'main' : 'pr', input.preflightRediscoverable === true);
    preflightStartedAt = mode === 'off' ? null : seams.now();
    if (preflightStartedAt !== null) enteredPreflight = true;
    const preflightGitBudget = (reserveMs: number = PREFLIGHT_LIMITS.teardownReserveMs) => {
      if (preflightStartedAt === null) return d.gitStepMs;
      const left = PREFLIGHT_LIMITS.totalMs - (seams.now() - preflightStartedAt) - reserveMs;
      if (left <= 0) throw new RunError('deadline:preflight', 'preflight budget exhausted');
      return Math.min(d.gitStepMs, left);
    };
    // Changed files (merge-base→head) for the isolation re-run's PR rule; null = unreadable.
    if (input.kind !== 'main') {
      try {
        const mb = (await gitOk(['merge-base', input.baseSha, input.headSha], 'merge-base', undefined, preflightGitBudget())).trim();
        changedForIsolation = new Set(parseNameStatus(await gitOk(['diff', '--name-status', '--no-renames', mb, input.headSha], 'diff', undefined, preflightGitBudget())).map((r) => r.path));
      } catch { changedForIsolation = null; }
    }

    // The installed verifier, not the PR's test code, decides whether this
    // synthetic merge may spend the bounded diagnostic preflight budget.
    if (mode !== 'off') {
      // Full classification reads every changed test and remains on the ordinary
      // record path below. The early check needs only a conservative harness
      // veto; package changes without both revisions are deliberately skipped.
      const harnessChanging = changedForIsolation !== null && classifyHarness({
        changedPaths: [...changedForIsolation], packageJson: { base: null, head: pkgText },
        extraGlobs: input.extraHarnessGlobs,
      }).harnessChanging;
      if (harnessChanging || changedForIsolation === null) {
        preflight = {
          mode, outcome: 'skip', reason: harnessChanging ? 'harness-changing' : 'changed-files-unreadable',
          elapsedMs: Math.min(PREFLIGHT_LIMITS.totalMs, Math.max(0, seams.now() - preflightStartedAt!)), changedFiles: Math.min(changedForIsolation?.size ?? 0, 10_000), selectedFiles: [], selectedCases: 0,
          headSha: input.headSha, baseSha: input.baseSha,
        };
      } else {
        preflight = await runFocusedPreflight({
          seams, runDir: p.runDir, reportsDir: p.reportsDir, binDir, baseEnv: runEnv,
          baseSha: input.baseSha, headSha: input.headSha, mode,
          startedAtMs: preflightStartedAt!,
          changedFiles: changedForIsolation.size, reporter,
          activeRemainingMs: remaining, onPid: (pid) => { ourPids.add(pid); },
        });
        const wtGitDir = worktreeGitDir(seams, p);
        if (!wtGitDir) throw new RunError('preflight-porcelain', 'run worktree admin dir unreadable');
        const clean = await git(['status', '--porcelain'], 'preflight-porcelain', { gitDir: wtGitDir, workTree: p.runDir }, preflightGitBudget(0));
        if (clean.status !== 0 || clean.stdout.trim()) throw new RunError('preflight-dirty-tree', 'preflight changed the merge worktree');
      }
      preflight.elapsedMs = Math.min(PREFLIGHT_LIMITS.totalMs, Math.max(0, seams.now() - preflightStartedAt!));
      preflightEnded = true;
      seams.log({ event: 'preflight', mode, outcome: preflight.outcome, reason: preflight.reason, elapsedMs: preflight.elapsedMs,
        changedFiles: preflight.changedFiles, selectedFiles: preflight.selectedFiles.length, selectedCases: preflight.selectedCases,
        headSha: input.headSha, baseSha: input.baseSha, baseRefName: input.baseRefName });
      if (mode === 'enforce' && preflight.outcome === 'red') throw new RunFailure('preflight-red');
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
    // The first parts (PR verifies with the setting on for this pull request): chosen once, before
    // any lane starts, from the changed paths, the change's previous failures and the list.
    if (firstPartOn && firstPartInput) {
      for (const lane of LANES) {
        const sel = selectFirstPart({
          lane: lane.name, laneFiles: inventory.byLane[lane.name] ?? [], changed: changedForIsolation,
          previous: firstPartInput.previous, list: firstPartInput.list, durations,
        });
        firstPartNotes.set(lane.name, { lane: lane.name, files: sel.files.length, fromChange: sel.fromChange, fromPrevious: sel.fromPrevious, fromList: sel.fromList, partners: sel.partners, ms: null, endedHere: false });
        // An empty first part is skipped: the lane starts as it does without this feature.
        if (sel.files.length > 0) firstParts.set(lane.name, sel);
        seams.log({ event: 'first-part-plan', lane: lane.name, files: sel.files, fromChange: sel.fromChange, fromPrevious: sel.fromPrevious, fromList: sel.fromList, partners: sel.partners, recordedMs: sel.ms });
      }
    }
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
      const laneFiles = inventory.byLane[lane.name] ?? [];
      // The rest of the lane (spec local-verify-likely-failing-first.md D): every file that is not
      // in the first part. Without a first part it is the whole lane, planned exactly as before.
      const first = firstParts.get(lane.name) ?? null;
      const firstSet = first ? new Set(first.files) : null;
      const restFiles = firstSet ? laneFiles.filter((f) => !firstSet.has(f)) : laneFiles;
      // A sharded lane with a plan from recorded times: the first part's files are left out before
      // the plan is made, so the shards are balanced on what remains.
      let plan = shards > 1 ? planShards(restFiles, shards, durations) : null;
      // Fewer files left than processes: one process runs them by name (a first part is closed
      // under path overlap, so a named rest file can never match a first-part file).
      if (first && shards > 1 && plan === null && restFiles.length > 0 && restFiles.length < shards) plan = [[...restFiles].sort()];
      const procs = plan ? plan.length : shards;
      // The unit lane (one process, no file list) and a sharded lane without a plan: the first
      // part's files are excluded by name.
      const excludes = first ? first.files.map((f) => `--exclude=${f}`) : [];
      if (shards > 1) seams.log({ event: 'shard-plan', lane: lane.name, shards, balanced: plan !== null });
      const laneEnv: NodeJS.ProcessEnv = { ...runEnv };
      let unitWorkers: number | null = null;
      if (lane.name === 'unit') {
        // 4 workers whatever the bound's posture: the nested clamp only applies while it
        // enforces, and the parallel lanes' worker total (4 + 1 + 1 + 1) is the claim.
        const uw = input.laneShards?.unitWorkers;
        const workers = typeof uw === 'number' && Number.isInteger(uw) && uw >= 1 && uw <= MAX_UNIT_WORKERS ? uw : LOCAL_VERIFY_LIMITS.unitWorkersParallel;
        laneEnv.INSTAR_TEST_WORKERS = String(workers);
        unitWorkers = workers;
        // This run already holds the host suite slot. Its own unit lane is a child of that
        // holder, so the host test-runner bound's nested clamp capped it at 4 workers whatever
        // was asked (2026-11-12: 8 workers ran no faster, 1159 s). Declare the lane as the
        // holder's own suite: the bound then skips only the clamp (the kill switch would also
        // log a disabled bound on every run and trip the self-disable detector).
        laneEnv.INSTAR_HOST_TEST_OWN_SUITE_HOLDER = String(process.pid);
        seams.log({ event: 'unit-workers', workers, source: workers === uw ? 'machine-setting' : 'policy-default' });
        laneEnv.AUDIT_CHANGE_KIND = 'pull_request';
        laneEnv.AUDIT_CHANGE_BASE_SHA = input.baseSha;
        laneEnv.AUDIT_CHANGE_HEAD_SHA = input.headSha;
      }
      const t = seams.now();
      const laneDeadlineAt = t + d.lanes[lane.name];
      type Part = { report: ParsedLaneReport | null; status: number | null; unhandled: number | null; aborted: boolean };
      /**
       * One vitest process of this lane. `afterFirst`: it runs the rest of a lane whose first part
       * already ran, so it gets what is left of the lane's deadline (the deadline covers both parts).
       */
      const runPart = async (key: string, fileArgs: readonly string[], afterFirst: boolean): Promise<Part> => {
        const reportPath = path.join(p.reportsDir, `${key}.json`);
        const errorsPath = path.join(p.reportsDir, `${key}.errors.json`);
        const pTmp = seams.fs.mkdtemp('lv-tmp-');
        const pTmux = seams.fs.mkdtemp('lv-tmux-');
        tempDirs.push(pTmp, pTmux);
        const progressPath = path.join(p.reportsDir, `${key}.progress.json`);
        const env: NodeJS.ProcessEnv = { ...laneEnv, TMPDIR: pTmp, TMUX_TMPDIR: pTmux };
        if (reporter) {
          env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE = errorsPath;
          env.LOCAL_VERIFY_PROGRESS_FILE = progressPath;
        }
        const stepBudget = () => {
          if (!afterFirst) return budget(d.lanes[lane.name]);
          const left = laneDeadlineAt - seams.now();
          if (left <= 0) throw new RunError(`deadline:${key}`, 'the lane deadline was spent before the rest of the lane started');
          return budget(left);
        };
        let r: Awaited<ReturnType<typeof exec>>;
        try {
          // The signal is always passed: a deadline anywhere ends the run as an error, so the
          // sibling lanes stop then too (fail-fast or not); before, they ran on for up to
          // ~11 min holding the suite slot for a run already lost (brainstorm 2026-11-12 E2).
          r = await exec(
            path.join(binDir, 'vitest'),
            ['run', '--config', lane.config, '--allowOnly=false', '--reporter=json', ...(reporter ? [`--reporter=${reporter}`] : []), `--outputFile=${reportPath}`,
              ...fileArgs],
            key, stepBudget(), env, stopLanes.signal,
          );
        } catch (e) {
          if (e instanceof RunError && e.step.startsWith('deadline:')) {
            // Deadline forensics: which files were still running at the kill.
            // Written by test-side code: read only when small (like the durations file).
            const progressSize = seams.fs.size ? seams.fs.size(progressPath) : null;
            const progress = reporter && (progressSize === null || progressSize <= PROGRESS_MAX_BYTES)
              ? readProgress(seams.fs.readFile(progressPath), p.runDir, seams.now()) : null;
            seams.log({ event: 'deadline-in-flight', step: key, ...(progress ?? { unknown: true }) });
            if (!stopLanes.signal.aborted) {
              seams.log({ event: 'lanes-stop', after: key, reason: 'deadline' });
              stopLanes.abort();
            }
            if (progress && progress.running.length > 0) {
              throw new RunError(e.step, `vitest hit its deadline; ${progress.finishedFiles} files finished; still running: ${progress.running.map((x) => `${x.file} (${x.seconds}s)`).join(', ')}`.slice(0, 1500));
            }
          }
          throw e;
        }
        if (r.aborted) return { report: null, status: null, unhandled: null, aborted: true };
        let report: ParsedLaneReport | null = null;
        const text = seams.fs.readFile(reportPath);
        if (text != null) {
          try { report = parseVitestJson(text, p.runDir); } catch { report = null; }
        }
        const unhandled = reporter ? readUnhandledErrors(seams.fs.readFile(errorsPath)) : null;
        return { report, status: r.status, unhandled, aborted: false };
      };
      /** The lane's usual processes, side by side. allSettled: every process has exited before the lane settles, even when one hits its deadline (nothing is left running outside the slot or the cleanup). */
      const runProcs = async (afterFirst: boolean): Promise<Part[]> => {
        const settledParts = await Promise.allSettled(Array.from({ length: procs }, (_, k) => runPart(
          shards > 1 ? `${lane.name}-${k + 1}` : lane.name,
          [...(plan ? plan[k] : shards > 1 ? [`--shard=${k + 1}/${shards}`] : []), ...(plan ? [] : excludes)],
          afterFirst,
        )));
        const shardError = settledParts.find((x): x is PromiseRejectedResult => x.status === 'rejected');
        if (shardError) throw shardError.reason;
        return settledParts.map((x) => (x as PromiseFulfilledResult<Part>).value);
      };
      // A lane's report is the union of its shards' reports; a missing shard report is a
      // missing lane report (the inventory rule then fails the run).
      // A file reported by two shards makes the lane report untrusted (missing): the verdict
      // must not depend on which shard's entry was kept.
      const mergeParts = (parts: readonly Part[]): ParsedLaneReport | null => {
        let report: ParsedLaneReport | null = { files: new Map() };
        for (const part of parts) {
          if (!part.report || !report) { report = null; continue; }
          for (const [f, c] of part.report.files) {
            // Every lane's files are recorded, unit included (docs/specs/local-verify-borrowed-unit-slices.md, A):
            // planShards only ever reads a lane's own files, and a unit first part is sized by file count
            // alone (firstPart.ts: unit is not a timed lane), so unit entries change no plan and no first part
            // while the history stays under its caps (20,000 files, 2 MB: about 5,600 files and 0.3 MB with
            // the unit lane in, 2026-11-19). Past 20,000 files the oldest-inserted entries go first, whatever
            // their lane; a history file over 2 MB is not read at all for that run (`durations-ignored`).
            if (typeof c.ms === 'number') observed[f] = c.ms;
            if (report.files.has(f)) {
              seams.log({ event: 'file-in-multiple-shards', lane: lane.name, file: f });
              report = null;
              break;
            }
            report.files.set(f, c);
          }
        }
        return report;
      };
      // A numeric non-zero exit of any shard wins over a signal exit (null), so a shard killed
      // after writing its report can never hide its sibling's failed exit.
      const combineExit = (codes: ReadonlyArray<number | null>): number | null => {
        const nonZero = codes.find((x) => typeof x === 'number' && x !== 0);
        return nonZero !== undefined ? nonZero : codes.some((x) => x === null) ? null : 0;
      };
      /** Whether any file of this lane was re-run alone (marks the unit wall-factor row, below). */
      let reran = false;
      const combineUnhandled = (counts: ReadonlyArray<number | null>): number | null => (counts.some((x) => x === null) ? null : counts.reduce<number>((n, x) => n + (x as number), 0));
      /**
       * Isolation re-run: a lane (or one part of it) whose only problem is 1..3 failed files re-runs
       * exactly those files, one at a time, under what is left of the lane budget: once, or three
       * times for an import-related file whose failed tests main has all shown flaky. `files` are
       * the files the report must cover; `priorFailed` counts the lane's earlier failures (its
       * first part). Returns the exit code after the re-runs.
       */
      const rerunPhase = async (report: ParsedLaneReport | null, files: readonly string[], unhandled: number | null, exit: number | null, priorFailed: number, part?: 'first'): Promise<number | null> => {
        let exitCode = exit;
        const failedHere = report ? [...report.files.entries()].filter(([, c]) => c.failed > 0).map(([f]) => f) : [];
        const classed = failedHere.length > 0 && report ? await ineligibleFor(failedHere, report) : { ineligible: new Set<string>(), importRelated: new Map<string, FlakyOnMainTest[]>() };
        // Read and spend the shared re-run budget with no await in between: lanes finish concurrently.
        const decision = decideIsolationRerun({
          report, laneFiles: files,
          maxFiles: LOCAL_VERIFY_LIMITS.isolationRerunMaxFiles, budgetLeft: rerunBudget,
          unhandledErrors: unhandled,
          ineligible: classed.ineligible,
          importRelated: new Set(classed.importRelated.keys()),
          ...(priorFailed > 0 ? { priorFailed } : {}),
        });
        if (decision.reason === 'eligible' && decision.rerun.length > 0 && report) {
          rerunBudget -= decision.rerun.length; // an import-related file counts as one file, whatever its number of runs
          reran = true;
          const threePass = new Map(decision.threePass.map((f) => [f, classed.importRelated.get(f)!]));
          const allPassed = await isolationRerun(lane.name, lane.config, decision.rerun, report, laneEnv, laneDeadlineAt, stopLanes.signal, threePass, part ? `${lane.name}-${part}` : lane.name);
          // The exit code is cleared only when the failed files explain it: they all passed alone
          // AND the lane reported zero unhandled errors (checked before the re-run).
          if (allPassed && unhandled === 0) exitCode = 0;
        } else if (decision.reason !== 'no-failures') {
          seams.log({ event: 'isolation-rerun-skipped', lane: lane.name, reason: decision.reason, ...(part ? { part } : {}) });
        }
        return exitCode;
      };
      const seconds = () => Math.round((seams.now() - t) / 1000);
      /**
       * Same spec, A: how far the unit lane's wall time is from its file time spread over the workers
       * (1.22 on the Studio, 11-18). Later slice and lane projections scale by it. Written once, for a
       * unit lane that ran to its end with a readable report. Two marks say when a row is not a clean
       * sample, so a reader can leave it out: `firstPart` (the lane used a first part, whose own run is
       * inside the wall time) and `reran` (files were re-run alone: the wall time holds those re-runs,
       * and the report holds a re-run file's solo time in place of its time in the lane).
       */
      const noteUnitWallFactor = (report: ParsedLaneReport | null, firstPartUsed: boolean): void => {
        if (lane.name !== 'unit' || !report || unitWorkers === null) return;
        const laneMs = seams.now() - t;
        let fileMs = 0;
        for (const c of report.files.values()) if (typeof c.ms === 'number') fileMs += c.ms;
        const ideal = fileMs / unitWorkers;
        if (ideal > 0) seams.log({ event: 'unit-wall-factor', workers: unitWorkers, fileSeconds: Math.round(fileMs / 1000), laneSeconds: Math.round(laneMs / 1000), factor: Math.round((laneMs / ideal) * 100) / 100, ...(firstPartUsed ? { firstPart: true } : {}), ...(reran ? { reran: true } : {}) });
      };

      if (!first) {
        const parts = await runProcs(false);
        if (parts.some((x) => x.aborted)) {
          seams.log({ event: 'lane-stopped-early', lane: lane.name });
          return { lane: lane.name, report: null, seconds: seconds(), exitCode: null, stoppedEarly: true };
        }
        const report = mergeParts(parts);
        const unhandled = combineUnhandled(parts.map((x) => x.unhandled));
        const exitCode = await rerunPhase(report, laneFiles, unhandled, combineExit(parts.map((x) => x.status)), 0);
        if (failFast && !stopLanes.signal.aborted && laneFailedFinally(report, exitCode)) {
          seams.log({ event: 'lanes-stop', after: lane.name });
          stopLanes.abort();
        }
        noteUnitWallFactor(report, false);
        return { lane: lane.name, report, seconds: seconds(), exitCode };
      }

      // ── A lane in two parts (spec local-verify-likely-failing-first.md A, C, D) ──
      // The first part runs to its end before its lane decides anything. The existing rules are
      // then applied to it: the re-run alone on the first part's own files, and, if the lane has
      // failed finally, fail-fast. A clean first part only lets the rest start: it is never a pass.
      const note = firstPartNotes.get(lane.name)!;
      const t1 = seams.now();
      const fp = await runPart(`${lane.name}-first`, first.files, false);
      note.ms = seams.now() - t1;
      if (fp.aborted) {
        seams.log({ event: 'lane-stopped-early', lane: lane.name, part: 'first' });
        return { lane: lane.name, report: null, seconds: seconds(), exitCode: null, stoppedEarly: true };
      }
      const firstReport = mergeParts([fp]);
      const firstFailed = firstReport ? [...firstReport.files.values()].filter((c) => c.failed > 0).length : 0;
      const firstExit = await rerunPhase(firstReport, first.files, fp.unhandled, combineExit([fp.status]), 0, 'first');
      /** The lane as it stands when it is cut short after its first part: only the first part's report. */
      const cutShort = (): LaneRunInput => ({ lane: lane.name, report: firstReport, seconds: seconds(), exitCode: firstExit, ...(firstReport ? { cutShort: true } : { stoppedEarly: true }) });
      const firstFinal = laneFailedFinally(firstReport, firstExit);
      if (firstFinal && failFast) {
        // The lane has failed finally: the rest does not start, and fail-fast stops the other lanes.
        note.endedHere = true;
        seams.log({ event: 'first-part', lane: lane.name, files: first.files.length, ms: note.ms, failedFinally: true, endedHere: true });
        if (!stopLanes.signal.aborted) {
          seams.log({ event: 'lanes-stop', after: `${lane.name}-first` });
          stopLanes.abort();
        }
        // A first part with no readable report is a missing lane report, as for any lane.
        return firstReport ? cutShort() : { lane: lane.name, report: null, seconds: seconds(), exitCode: firstExit };
      }
      seams.log({ event: 'first-part', lane: lane.name, files: first.files.length, ms: note.ms, failedFinally: firstFinal, endedHere: false });
      // The whole lane fitted in its first part: the lane is completed from that one report.
      if (restFiles.length === 0) { noteUnitWallFactor(firstReport, true); return { lane: lane.name, report: firstReport, seconds: seconds(), exitCode: firstExit }; }
      if (stopLanes.signal.aborted) {
        seams.log({ event: 'lane-stopped-early', lane: lane.name, part: 'rest' });
        return cutShort();
      }
      const rest = await runProcs(true);
      if (rest.some((x) => x.aborted)) {
        seams.log({ event: 'lane-stopped-early', lane: lane.name, part: 'rest' });
        return cutShort();
      }
      const restReport = mergeParts(rest);
      // Unhandled errors and exit codes are combined across the two parts as they are across shards.
      const laneUnhandled = combineUnhandled([fp.unhandled, ...rest.map((x) => x.unhandled)]);
      const restExit = await rerunPhase(restReport, restFiles, laneUnhandled, combineExit(rest.map((x) => x.status)), firstFailed);
      let report: ParsedLaneReport | null = null;
      if (firstReport && restReport) {
        report = { files: new Map(firstReport.files) };
        for (const [f, c] of restReport.files) {
          if (report.files.has(f)) {
            // A file the first part ran was run again by the rest: the lane report is untrusted (missing).
            seams.log({ event: 'file-in-multiple-shards', lane: lane.name, file: f, part: 'first' });
            report = null;
            break;
          }
          report.files.set(f, c);
        }
      }
      const exitCode = combineExit([firstExit, restExit]);
      if (failFast && !stopLanes.signal.aborted && laneFailedFinally(report, exitCode)) {
        seams.log({ event: 'lanes-stop', after: lane.name });
        stopLanes.abort();
      }
      noteUnitWallFactor(report, true);
      return { lane: lane.name, report, seconds: seconds(), exitCode };
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
    const allFailedFiles = Object.entries(ev.perFile)
      .filter(([, c]) => c.failed > 0)
      .map(([file]) => file).sort();
    const onlyAssertionFailureReasons = ev.reasons.every((r) => /^file-failed:|^lane-failed:|^lane-zero-passed:|^lane-stopped-early:/.test(r));
    if (!dirty && onlyAssertionFailureReasons && allFailedFiles.length >= 1 && allFailedFiles.length <= 3
      && allFailedFiles.every((file) => isInventoried(file)
        && (ev.perFile[file]?.assertionFailures ?? 0) > 0 && !ev.perFile[file]?.nonAssertionFailure)) boundedFailedFiles = allFailedFiles;
    if (input.collectFileOutcomes === true) {
      const flaky = new Set(flakyRetried.map((x) => x.file));
      fileOutcomes = {};
      for (const [file, c] of Object.entries(ev.perFile)) fileOutcomes[file] = c.failed > 0 ? 'failed' : flaky.has(file) ? 'flaky' : 'passed';
    }
    if (dirty) evaluationReasons = [...evaluationReasons, 'dirty-tree'];
    if (evaluationReasons.length > 0) {
      outcome = 'failure';
      failureReason = evaluationReasons[0];
    }
    flags = await classify();
  } catch (e) {
    if (preflight && preflightStartedAt !== null && !preflightEnded) {
      preflight.elapsedMs = Math.min(PREFLIGHT_LIMITS.totalMs, Math.max(0, seams.now() - preflightStartedAt));
      preflightEnded = true;
    }
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
      errorStep = e instanceof RunError ? e.step : e instanceof PreflightCleanupError ? 'preflight-cleanup' : 'crash';
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
  if (input.attempt) record.attempt = { id: input.attempt.id, coordinatorMachineId: input.attempt.coordinatorMachineId, leaseEpoch: input.attempt.leaseEpoch };
  if (flakyRetried.length > 0) record.flakyRetried = flakyRetried.slice(0, FLAKY_RETRIED_MAX);
  if (preflight) record.preflight = preflight;
  if (outcome === 'failure' && input.kind !== 'main' && boundedFailedFiles) {
    record.failedFiles = boundedFailedFiles;
    const cut = boundedFailedFiles.filter((f) => rerunCutOff.has(f));
    if (cut.length > 0) record.rerunCutOff = cut;
  }
  const firstPartSummary: FirstPartSummary | null = firstPartInput ? {
    setting: firstPartInput.setting, ...(firstPartInput.group ? { group: firstPartInput.group } : {}), active: firstPartOn,
    lanes: LANES.map((l) => firstPartNotes.get(l.name)).filter((x): x is FirstPartLaneSummary => !!x),
    endedInFirstPart: outcome === 'failure' && [...firstPartNotes.values()].some((x) => x.endedHere),
  } : null;
  if (firstPartSummary) seams.log({ event: 'first-part-summary', pr: input.pr, ...firstPartSummary, outcome });
  // The comparison run never keeps a worktree: the verify it follows already kept its own.
  const kept = await cleanup(outcome !== 'success' && input.variant !== 'compare');
  const v = validateRecord(record);
  if (!v.ok) return { kind: 'invalid', errors: v.errors };
  seams.log({ event: 'run-finished', pr: input.pr, headSha: input.headSha, outcome, errorStep, failureReason, reasons: evaluationReasons.slice(0, 20) });
  const cap = IMPORT_RELATED_RERUN.auditRefusals;
  const of = (...reasons: string[]) => importRelatedRefusals.filter((x) => reasons.includes(x.reason));
  const others = importRelatedRefusals.filter((x) => x.reason !== 'noMainEvidence' && x.reason !== 'noMainEvidenceForTest');
  const isolationRefusals: IsolationRefusals | null = importRelatedRefusals.length === 0 ? null : {
    noMainEvidence: of('noMainEvidence').slice(0, cap), noMainEvidenceCount: of('noMainEvidence').length,
    noMainEvidenceForTest: of('noMainEvidenceForTest').slice(0, cap), noMainEvidenceForTestCount: of('noMainEvidenceForTest').length,
    importRelatedRefused: others.slice(0, cap), importRelatedRefusedCount: others.length,
  };
  return {
    kind: 'record', record, reasons: evaluationReasons, overlaps, keptWorktree: kept, failures, ...(flakyRetried.length ? { flakyRetried } : {}),
    ...(isolationRefusals ? { isolationRefusals } : {}),
    ...(input.kind === 'main' && Object.keys(flakyTestLines).length > 0 ? { flakyTestLines } : {}),
    ...(firstPartSummary ? { firstPart: firstPartSummary } : {}),
    ...(fileOutcomes ? { fileOutcomes } : {}),
  };

  // ── helpers (closures over the run) ──

  /**
   * Class each failed file of a PR verify (spec local-verify-import-related-rerun.md "Rule
   * proposed"), in this order: unavailable (no green `main` record, no isolation input,
   * unreadable diff, no import scan) and edited (the PR changed the test file) are ineligible, as
   * before; a file whose import graph reaches a changed file is ineligible too, UNLESS the
   * import-related rule is on and every one of its failed tests is on main's list
   * (`importRelatedEligibility`): then it is returned in `importRelated` with its evidence and
   * needs three passes. Everything else is plain (one solo run). A file re-run-passed on the last
   * green `main` gets no exemption from the import check. With the switch off, or no list, the
   * second set is empty and the first is the old result exactly. A `main` verify uses the plain
   * rule (nothing is ineligible).
   */
  async function ineligibleFor(failed: readonly string[], report: ParsedLaneReport): Promise<{ ineligible: Set<string>; importRelated: Map<string, FlakyOnMainTest[]> }> {
    const importRelated = new Map<string, FlakyOnMainTest[]>();
    if (input.kind === 'main') return { ineligible: new Set(), importRelated };
    const iso = input.isolation;
    if (!iso || !iso.allowed || changedForIsolation === null) return { ineligible: new Set(failed), importRelated };
    const out = new Set<string>();
    const notClean = new Set(iso.notCleanOnGreenMain);
    const ruleOn = iso.importRelatedRerun === true;
    const listed = new Map((ruleOn && Array.isArray(iso.flakyOnMain) ? iso.flakyOnMain : []).filter((e) => e && typeof e.file === 'string').map((e) => [e.file, e]));
    const refused: ImportRelatedRefusal[] = [];
    for (const f of failed) {
      if (changedForIsolation.has(f)) { out.add(f); continue; }
      if (notClean.has(f)) seams.log({ event: 'isolation-rerun-flaky-on-main', file: f });
      let graph: string[] = [];
      try { graph = seams.importGraph ? seams.importGraph([path.join(p.runDir, f)]) : []; } catch { graph = []; }
      if (!seams.importGraph) { out.add(f); continue; } // no import scan available ⇒ cannot rule a change out
      const rel = graph.map((g) => path.relative(p.runDir, g).split(path.sep).join('/'));
      if (!rel.some((g) => changedForIsolation!.has(g))) continue; // plain
      if (!ruleOn) { out.add(f); continue; }
      const verdict = importRelatedEligibility(report.files.get(f), listed.get(f));
      if (verdict.eligible) { importRelated.set(f, verdict.evidence); continue; }
      out.add(f);
      refused.push({ file: f, reason: verdict.reason, ...(verdict.test !== undefined ? { test: verdict.test } : {}), ...(verdict.namesCut ? { namesCut: true as const } : {}) });
    }
    if (out.size) {
      const kind = (r: string) => refused.filter((x) => x.reason === r).slice(0, 10);
      seams.log({
        event: 'isolation-rerun-ineligible', files: [...out].slice(0, 10),
        ...(ruleOn ? {
          noMainEvidence: kind('noMainEvidence'), noMainEvidenceForTest: kind('noMainEvidenceForTest'),
          refused: refused.filter((x) => x.reason !== 'noMainEvidence' && x.reason !== 'noMainEvidenceForTest').slice(0, 10),
        } : {}),
      });
    }
    importRelatedRefusals.push(...refused);
    return { ineligible: out, importRelated };
  }

  /* @self-action-controller: local-verify-flake-rerun */
  /**
   * Re-run each failed file alone with the lane's own config, env and flags: once, or three
   * times in a row for a file in `threePass` (import-related, every failed test shown flaky on
   * `main`). A file that passes replaces its counts in the lane report and is recorded as flaky;
   * one that fails keeps the lane run's counts and both messages. A three-pass file is cleared
   * only when all three runs pass AND each reports every lane-failed test `passed` by full name
   * AND skips exactly as many tests as the lane run did (`skipped-count-changed` otherwise);
   * its first run that does not pass ends the sequence. Once a file in this lane has failed
   * finally the lane cannot clear: a three-pass file after it gets ONE detail-only run, whose
   * pass is written into the failure detail and nowhere else. Each run computes its own
   * deadline (what is left of the lane's, or of the total), gets a fresh TMPDIR and TMUX_TMPDIR
   * and writes its own report files. A run that would start past the lane deadline, or hits it,
   * counts as failing (never an infrastructure error: the lane itself finished in time).
   * Returns true when every file was cleared.
   */
  async function isolationRerun(
    lane: LaneName, config: string, files: readonly string[], report: ParsedLaneReport, env: NodeJS.ProcessEnv, laneDeadlineAt: number,
    signal?: AbortSignal, threePass: ReadonlyMap<string, readonly FlakyOnMainTest[]> = new Map(),
    /** Report-file prefix: the lane, or `<lane>-first` for a first part's re-runs (so the two never share a file). */
    namePrefix: string = lane,
  ): Promise<boolean> {
    let all = true;
    const L = IMPORT_RELATED_RERUN;
    for (let k = 0; k < files.length; k++) {
      const file = files[k];
      const first = report.files.get(file)!;
      firstMessages.set(file, first.message ?? '');
      const evidence = threePass.get(file);
      const ir = evidence !== undefined;
      // The lane already holds a final failure: this file cannot clear it. One run, for the detail only.
      const detailOnly = ir && !all;
      const runs = ir && !detailOnly ? LOCAL_VERIFY_LIMITS.isolationRerunImportRelatedPasses : 1;
      const named = first.failedTests ?? [];
      const failedNames = named.map((x) => x.name);
      const label = (n: number) => (detailOnly ? 'solo run 1 of 1 (detail only, the lane had already failed): ' : `solo run ${n} of ${runs}: `);
      let cleared = true;
      let last: FileCounts | undefined;
      let stillPassed: string[] = failedNames;
      const soloSeconds: number[] = [];
      for (let n = 1; n <= runs; n++) {
        const irLog = ir ? { importRelated: true, run: n, of: runs, detailOnly } : {};
        const ms = Math.min(laneDeadlineAt - seams.now(), remaining());
        if (ms <= 0) {
          rerunMessages.set(file, ir ? `${label(n)}not finished inside the lane deadline` : 'isolation re-run not started: lane budget spent');
          seams.log({ event: 'isolation-rerun', lane, file, outcome: ir ? 'deadline' : 'no-budget', ...irLog, ...(ir ? { seconds: 0 } : {}) });
          cleared = false;
          break;
        }
        const out = path.join(p.reportsDir, `${namePrefix}-rerun-${k}-${n}.json`);
        const errs = path.join(p.reportsDir, `${namePrefix}-rerun-${k}-${n}.errors.json`);
        // A fresh TMPDIR and TMUX_TMPDIR for each re-run (nothing from the lane run, or an earlier solo run, leaks in).
        const rTmp = seams.fs.mkdtemp('lv-tmp-');
        const rTmux = seams.fs.mkdtemp('lv-tmux-');
        tempDirs.push(rTmp, rTmux);
        const rEnv: NodeJS.ProcessEnv = { ...env, TMPDIR: rTmp, TMUX_TMPDIR: rTmux, ...(reporter ? { LOCAL_VERIFY_UNHANDLED_ERRORS_FILE: errs } : {}) };
        const t0 = seams.now();
        const r = await seams.exec(
          path.join(binDir, 'vitest'),
          ['run', '--config', config, '--allowOnly=false', '--reporter=json', ...(reporter ? [`--reporter=${reporter}`] : []), `--outputFile=${out}`, file],
          { cwd: p.runDir, env: rEnv, deadlineMs: ms, onPid: (pid) => { ourPids.add(pid); }, ...(signal ? { signal } : {}) },
        );
        if (r.aborted) {
          // The run already failed in another lane: the re-run's answer no longer matters.
          rerunMessages.set(file, 'isolation re-run stopped: another lane had already failed');
          rerunCutOff.add(file);
          seams.log({ event: 'isolation-rerun', lane, file, outcome: 'stopped', ...irLog });
          cleared = false;
          break;
        }
        let again: ParsedLaneReport | null = null;
        const text = r.deadlineKilled ? null : seams.fs.readFile(out);
        if (text != null) { try { again = parseVitestJson(text, p.runDir, { solo: true }); } catch { again = null; } }
        const c = again?.files.get(file);
        const rerunUnhandled = r.deadlineKilled ? null : readUnhandledErrors(seams.fs.readFile(errs));
        // The pass rule every solo run has always had: nothing failed, something passed, exit 0, no unhandled error.
        const ranClean = !!c && c.failed === 0 && c.passed > 0 && r.status === 0 && rerunUnhandled === 0;
        // By name: which of the lane-failed tests this run reported `passed`. A three-pass run needs all of them.
        const byName = passedByName(failedNames, c?.passedTests ?? []);
        // A three-pass run must also skip exactly as many tests as the lane run did. A failed nested
        // hook (a beforeAll inside a describe) is reported only as its tests being SKIPPED, so a hook
        // that failed under load and passes alone shows up as a different skipped count: not a pass.
        const sameSkipped = !!c && c.skipped === first.skipped;
        const passed = ranClean && (!ir || (byName.notPassed.length === 0 && sameSkipped));
        const seconds = Math.round((seams.now() - t0) / 1000);
        const outcome = passed ? 'passed' : r.deadlineKilled ? 'deadline' : !ranClean ? 'failed' : byName.notPassed.length > 0 ? 'failed-test-not-passed' : 'skipped-count-changed';
        seams.log({ event: 'isolation-rerun', lane, file, outcome, ...irLog, ...(ir ? { seconds } : {}) });
        if (!passed) {
          cleared = false;
          if (!ir) {
            rerunMessages.set(file, r.deadlineKilled ? 'isolation re-run hit the lane deadline' : (c?.message || `isolation re-run exit ${r.status ?? r.signal}`));
          } else if (r.deadlineKilled) {
            rerunMessages.set(file, `${label(n)}not finished inside the lane deadline`);
          } else if (ranClean && byName.notPassed.length === 0) {
            rerunMessages.set(file, `${label(n)}skipped-count-changed: ${first.skipped} skipped in the lane run, ${c!.skipped} in the solo run`);
          } else if (ranClean) {
            const miss = byName.notPassed[0];
            const was = c!.notPassedTests?.find((x) => x.name === miss)?.status ?? ((c!.passedTests ?? []).includes(miss) ? 'passed fewer times than it failed' : 'missing');
            rerunMessages.set(file, `${label(n)}failed-test-not-passed: "${miss}" was ${was} in the solo run`);
          } else {
            // The END of the failure is where the assertion is: bounded keeping it, the cut disclosed, the prefix added after.
            const f0 = c?.failedTests?.[0];
            const whole = f0 ? `${f0.name}: ${f0.full}` : (c?.message || `isolation re-run exit ${r.status ?? r.signal}`);
            rerunMessages.set(file, `${label(n)}${boundedTail(whole, L.rerunMessageChars)}`);
          }
          break;
        }
        last = c;
        soloSeconds.push(seconds);
        stillPassed = stillPassed.filter((x) => byName.passed.includes(x));
      }
      if (!cleared) { all = false; continue; }
      if (detailOnly) {
        // Never a flaky record, never a clear: the file stays failed and only its detail says it passed alone.
        rerunMessages.set(file, `${label(1)}passed`);
        continue;
      }
      report.files.set(file, { ...withoutNames(last!), message: '' });
      const recordNames = failedNames.slice(0, L.recordNames);
      const entry: FlakyRetry = {
        file, lane, firstMessage: (first.message ?? '').slice(0, 400),
        // Shared name fields, written whatever the switch says (they are what `main` evidence is made of).
        ...(first.failedTests !== undefined ? {
          failedTests: recordNames, failedTestsTotal: first.failed,
          soloPassedByName: stillPassed.filter((x) => recordNames.includes(x)).slice(0, recordNames.length),
        } : {}),
        ...(typeof first.testSetHash === 'string' ? { testSetHash: first.testSetHash } : {}),
        ...(ir ? {
          importRelated: true as const, soloPasses: 3 as const, soloSeconds,
          evidence: named.map((x, i) => ({
            test: x.name, mainAt: evidence![i].at, mainLine: evidence![i].line, prLine: x.line,
            ...(evidence![i].lineCut ? { mainLineCut: true as const } : {}), ...(x.lineCut ? { prLineCut: true as const } : {}),
            mainRunLog: evidence![i].runLog,
          })),
        } : {}),
      };
      flakyRetried.push(entry);
      // The pointer to the full output: one event per named failed test of the entry, whole (bounded keeping the end).
      for (const x of named.slice(0, L.recordNames)) seams.log({ event: 'failure-full', lane, file, test: x.name, message: x.full });
      if (input.kind === 'main') flakyTestLines[file] = named.slice(0, L.recordNames).map((x) => ({ test: x.name, line: x.line, ...(x.lineCut ? { lineCut: true as const } : {}) }));
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
    // First, end whatever the run's tests left running (a detached tmux server, a stopped
    // helper): every lane is over, so a process still pointing into this run's own folders
    // is a leftover. Before the folders go, so nothing still holds them open.
    if (seams.reapLeftovers) {
      try {
        const r = await seams.reapLeftovers(runLeftoverPrefixes(p.runDir, tempDirs), { startedBeforeMs: seams.now() });
        if (r.matched > 0) seams.log({ event: 'leftovers-reaped', where: 'run-end', matched: r.matched, killed: r.killed, sample: r.sample });
      } catch (e) {
        seams.log({ event: 'leftovers-reap-failed', where: 'run-end', detail: e instanceof Error ? e.message : String(e) });
      }
    }
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

/**
 * The kept failed-run list. `ok: false` when the file exists but cannot be parsed:
 * then nothing may be swept (any run could be a kept one) and the file is left as
 * it is for a person to repair (disk-steward §5).
 */
export function readKeptList(seams: OrchestratorSeams, p: VerifyPaths): { ok: true; list: string[] } | { ok: false } {
  const raw = seams.fs.readFile(p.keptListFile);
  if (raw === null) return seams.fs.exists(p.keptListFile) ? { ok: false } : { ok: true, list: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false };
    return { ok: true, list: parsed.filter((x): x is string => typeof x === 'string') };
  } catch {
    return { ok: false }; // @silent-fallback-ok — reported by the callers (sweep stops, keepFailed leaves the file)
  }
}

/**
 * Remove run checkouts under `runs/` that no run owns: not the current run, not a
 * kept failed run. Only a non-forced `git worktree remove` is used, so git keeps
 * anything it considers dirty, locked or unregistered; those are listed, never
 * forced. Never throws: a sweep problem must not fail a verify.
 */
export async function sweepOrphanVerifyRuns(seams: OrchestratorSeams, p: VerifyPaths): Promise<{ removed: string[]; kept: string[]; skipped?: string }> {
  const removed: string[] = [];
  const kept: string[] = [];
  try {
    if (!seams.fs.list || !seams.fs.inUse) return { removed, kept, skipped: 'no-list-seam' };
    const kl = readKeptList(seams, p);
    if (!kl.ok) {
      seams.log({ event: 'orphan-sweep-skipped', detail: 'kept-failed.json unreadable; nothing swept until it parses again' });
      degradeKeptList(seams, p, 'the orphan sweep removes nothing until it parses again, so run checkouts cut short accumulate');
      return { removed, kept, skipped: 'kept-list-unreadable' };
    }
    const real = (x: string) => seams.fs.realpath?.(x) ?? null;
    const protectedPaths = new Set<string>();
    for (const k of [...kl.list, p.runDir]) {
      protectedPaths.add(path.resolve(k));
      const r = real(k);
      if (r) protectedPaths.add(r);
    }
    // Only checkouts the verifier itself made: its 12-hex run-id name AND
    // registered in its own clone. Anything else in runs/ (a hand-made copy,
    // an entry orphaned by a re-made clone) is left alone and listed.
    const listed = await seams.git(['worktree', 'list', '--porcelain'], {
      cwd: p.verifyRoot, gitDir: p.bare, operation: 'local-verify:worktree-list', timeoutMs: LOCAL_VERIFY_DEADLINES.gitStepMs,
    });
    if (listed.status !== 0) {
      seams.log({ event: 'orphan-sweep-skipped', detail: `git worktree list failed (${listed.status}); nothing swept this run`, stderr: listed.stderr.slice(0, 500) });
      return { removed, kept, skipped: 'worktree-list-failed' };
    }
    const registered = new Set<string>();
    for (const line of listed.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const w = line.slice('worktree '.length).trim();
      registered.add(path.resolve(w));
      const r = real(w);
      if (r) registered.add(r);
    }
    const names = seams.fs.list(p.runsDir) ?? [];
    for (const name of names) {
      const dir = path.join(p.runsDir, name);
      const r = real(dir);
      if (protectedPaths.has(path.resolve(dir)) || (r && protectedPaths.has(r))) continue;
      if (!/^[0-9a-f]{12}$/.test(name) || !(registered.has(path.resolve(dir)) || (r && registered.has(r)))) { kept.push(dir); continue; }
      if (seams.fs.inUse(dir) !== false) { kept.push(dir); continue; }
      const res = await seams.git(['worktree', 'remove', dir], {
        cwd: p.verifyRoot, gitDir: p.bare, operation: 'local-verify:orphan-sweep', timeoutMs: LOCAL_VERIFY_DEADLINES.gitStepMs,
      });
      if (res.status === 0 && !seams.fs.exists(dir)) removed.push(dir);
      else kept.push(dir);
    }
    if (removed.length > 0) {
      await seams.git(['worktree', 'prune'], {
        cwd: p.verifyRoot, gitDir: p.bare, operation: 'local-verify:worktree-prune', timeoutMs: LOCAL_VERIFY_DEADLINES.gitStepMs,
      });
    }
    // Kept entries are listed with their size (disk-steward §5), so a person can see what
    // the sweep is leaving behind and how much it costs without a du of their own.
    const keptEntries = kept.slice(0, 20).map((dir) => ({ dir, bytes: seams.fs.treeSize?.(dir) ?? null }));
    seams.log({ event: 'orphan-sweep', removed: removed.length, kept: kept.length, keptEntries });
  } catch (e) {
    seams.log({ event: 'orphan-sweep-failed', detail: e instanceof Error ? e.message : String(e) });
  }
  return { removed, kept };
}

/** The one degradation both readers of an unparseable kept-failed.json record (disk-steward §5). */
function degradeKeptList(seams: OrchestratorSeams, p: VerifyPaths, impact: string): void {
  seams.degrade?.({
    feature: 'LocalVerify.keptList',
    primary: 'the kept-failed list (kept-failed.json in the verify root) names the failed runs kept for diagnosis',
    fallback: 'the unreadable list exactly as it is, untouched, until a person repairs or removes it',
    reason: 'kept-failed.json exists but is not a JSON array of paths',
    impact,
  });
}

/** Record a kept failed-run worktree; drop the oldest beyond the cap. Exported for its tests. */
export async function keepFailed(seams: OrchestratorSeams, p: VerifyPaths): Promise<void> {
  const kl = readKeptList(seams, p);
  if (!kl.ok) {
    // Never overwrite a list we cannot read: it may name runs someone is keeping.
    seams.log({ event: 'kept-list-unreadable', detail: 'kept-failed.json left as is; this run is kept but not listed' });
    // The run folder's absolute path stays in the run log; the degradation text reaches /health.
    seams.log({ event: 'kept-list-unreadable-run', detail: p.runDir });
    degradeKeptList(seams, p, 'this failed run is kept but not listed; the next sweep removes it once the list parses again');
    return;
  }
  let list = kl.list;
  list = list.filter((d) => d !== p.runDir);
  list.push(p.runDir);
  while (list.length > LOCAL_VERIFY_LIMITS.keepFailedWorktrees) {
    const oldest = list.shift()!;
    if (seams.fs.exists(oldest)) await removeWorktree(seams, p, oldest);
  }
  seams.fs.writeFile(p.keptListFile, JSON.stringify(list));
}

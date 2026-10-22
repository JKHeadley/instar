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
import { computeInventory, LANES, type LaneName } from './inventory.js';
import { evaluateRun, parseVitestJson, type LaneRunInput, type LaneTotals, type ParsedLaneReport } from './laneReport.js';
import { evaluateSkipRatchet, type ChangedTestFile } from './skipRatchet.js';
import { classifyHarness, protectedPath as isProtectedPath } from './harnessClassifier.js';
import { validateRecord, type LocalVerifyRecord } from './record.js';
import { LOCAL_VERIFY_DEADLINES, LOCAL_VERIFY_IDENTITY, LOCAL_VERIFY_LIMITS, type LocalVerifyDeadlines } from './policy.js';

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
    opts: { cwd: string; env: NodeJS.ProcessEnv; deadlineMs: number; onPid?: (pid: number) => void },
  ): Promise<ExecResult>;
  fs: OrchestratorFs;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Live full-suite holders of the host test-runner bound that are not one of `ours`. */
  foreignSuiteHolders(ours: ReadonlySet<number>): Array<{ pid: number }>;
  log(event: Record<string, unknown>): void;
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
}

/** At most this many failure details travel with a result. */
export const FAILURE_DETAILS_MAX = 30;

export interface Overlap {
  at: number;
  beforeLane: LaneName;
  holders: number[];
}

export type VerifyRunResult =
  | { kind: 'record'; record: LocalVerifyRecord; reasons: string[]; overlaps: Overlap[]; keptWorktree: string | null; failures?: FailureDetail[] }
  | { kind: 'requeue'; reason: 'foreign-suite-at-start' | 'foreign-suite-wait-exceeded'; overlaps: Overlap[] }
  | { kind: 'invalid'; errors: string[] };

export interface VerifyPaths {
  verifyRoot: string;
  bare: string;
  runsDir: string;
  runDir: string;
  reportsDir: string;
  keptListFile: string;
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
  let waitedMs = 0;
  const overlaps: Overlap[] = [];
  const ourPids = new Set<number>();
  const laneRuns: LaneRunInput[] = [];
  const tempDirs: string[] = [];
  let mergeTree = '';
  let mergeCommit = '';
  let worktreeCreated = false;
  let flags = { harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false };

  const remaining = () => d.totalActiveMs - (seams.now() - startedAtMs - waitedMs);
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
  const exec = async (command: string, args: string[], step: string, deadline: { ms: number; capped: boolean }, env = runEnv) => {
    const t0 = seams.now();
    const r = await seams.exec(command, args, {
      cwd: p.runDir, env, deadlineMs: deadline.ms,
      onPid: (pid) => { ourPids.add(pid); },
    });
    // Per-step timing (metadata only): the Acceptance measurement reads these.
    seams.log({ event: 'step', step, ms: seams.now() - t0, status: r.status ?? null, deadlineKilled: r.deadlineKilled });
    if (r.deadlineKilled) throw new RunError(deadline.capped ? 'deadline:total' : `deadline:${step}`, `${command} hit its deadline`);
    return r;
  };

  let failureReason: string | null = null;
  let evaluationReasons: string[] = [];
  let failures: FailureDetail[] = [];
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

    for (let i = 0; i < LANES.length; i++) {
      const lane = LANES[i];
      await singleFlight(lane.name, i === 0);
      const reportPath = path.join(p.reportsDir, `${lane.name}.json`);
      const env: NodeJS.ProcessEnv = { ...runEnv };
      if (lane.name === 'unit') {
        env.AUDIT_CHANGE_KIND = 'pull_request';
        env.AUDIT_CHANGE_BASE_SHA = input.baseSha;
        env.AUDIT_CHANGE_HEAD_SHA = input.headSha;
      }
      const t = seams.now();
      const r = await exec(
        path.join(binDir, 'vitest'),
        ['run', '--config', lane.config, '--allowOnly=false', '--reporter=json', `--outputFile=${reportPath}`],
        lane.name, budget(d.lanes[lane.name]), env,
      );
      let report: ParsedLaneReport | null = null;
      const text = seams.fs.readFile(reportPath);
      if (text != null) {
        try { report = parseVitestJson(text, p.runDir); } catch { report = null; }
      }
      laneRuns.push({ lane: lane.name, report, seconds: Math.round((seams.now() - t) / 1000), exitCode: r.status });
    }

    // ── 5. Tree must be clean, then the inventory rule ──
    const wtGitDir = worktreeGitDir(seams, p);
    if (!wtGitDir) throw new RunError('porcelain', 'run worktree admin dir unreadable');
    const st = await git(['status', '--porcelain'], 'porcelain', { gitDir: wtGitDir, workTree: p.runDir });
    if (st.status !== 0) throw new RunError('porcelain', st.stderr.trim().slice(0, 200));
    const dirty = st.stdout.trim().length > 0;

    const tree = await gitOk(['ls-tree', '-r', '--name-only', mergeCommit], 'inventory');
    const inventory = computeInventory(tree.split('\n').filter(Boolean));
    const ev = evaluateRun(inventory, laneRuns);
    evaluationReasons = ev.reasons;
    failures = Object.entries(ev.perFile)
      .filter(([, c]) => c.failed > 0)
      .slice(0, FAILURE_DETAILS_MAX)
      .map(([file, c]) => ({ file, lane: c.lane, failed: c.failed, message: c.message ?? '' }));
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
  const kept = await cleanup(outcome !== 'success');
  const v = validateRecord(record);
  if (!v.ok) return { kind: 'invalid', errors: v.errors };
  seams.log({ event: 'run-finished', pr: input.pr, headSha: input.headSha, outcome, errorStep, failureReason, reasons: evaluationReasons.slice(0, 20) });
  return { kind: 'record', record, reasons: evaluationReasons, overlaps, keptWorktree: kept, failures };

  // ── helpers (closures over the run) ──

  async function singleFlight(lane: LaneName, first: boolean): Promise<void> {
    let holders = seams.foreignSuiteHolders(ourPids);
    if (holders.length === 0) return;
    const note = () => {
      const o = { at: seams.now(), beforeLane: lane, holders: holders.map((h) => h.pid) };
      overlaps.push(o);
      seams.log({ event: 'overlap', ...o });
    };
    note();
    if (first) throw new Requeue('foreign-suite-at-start');
    const waitStart = seams.now();
    while (holders.length > 0) {
      if (seams.now() - waitStart >= LOCAL_VERIFY_LIMITS.waitInPlaceMs) {
        waitedMs += seams.now() - waitStart;
        throw new Requeue('foreign-suite-wait-exceeded');
      }
      await seams.sleep(LOCAL_VERIFY_LIMITS.holderPollMs);
      holders = seams.foreignSuiteHolders(ourPids);
      if (holders.length > 0) note();
    }
    waitedMs += seams.now() - waitStart;
  }

  async function classify(): Promise<typeof flags> {
    const out = { harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false };
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
      const ratchet = evaluateSkipRatchet(tests);
      out.skipsAdded = ratchet.skipsAdded;
      out.testsRemoved = ratchet.testsRemoved;
    } catch (e) {
      // Any read failure classifies the PR as harness-changing (routes it to the operator).
      seams.log({ event: 'classify-read-failure', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      out.harnessChanging = true;
      if (rows) out.protectedPath = isProtectedPath(rows.map((r) => r.path), input.protectedList);
      else out.protectedPath = true;
    }
    return out;
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

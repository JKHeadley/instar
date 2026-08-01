/**
 * ProjectRoundExecution — the autonomous run loop for a project round.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md § Phase 1.5 ("Run loop", steps 1-11).
 *
 * What this module is responsible for:
 *   1. Acquiring the round-runner lock (delegated to ProjectRoundLock).
 *   2. Spawning the autonomous child process in a detached process
 *      group, so SIGTERM/SIGKILL of the group never reaps the runner.
 *   3. Polling the project record every `pollIntervalMs` to detect
 *      mid-round mutations to the round's itemIds (e.g., a user
 *      manually skips an item) — when detected, SIGTERM the group
 *      (5s grace, then SIGKILL) and relaunch with a recomputed stop
 *      condition.
 *   4. On the autonomous child's NATURAL exit, verify per-item
 *      artifacts and set round.status = complete | partially-complete.
 *   5. Cleanup: `git worktree prune` for the round namespace.
 *   6. Release the lock.
 *
 * What this module is NOT responsible for:
 *   - The preflight gate. That's `ProjectRoundRunner.preflight`. The
 *     caller (the auto-advance poller, the /project run-round skill,
 *     a future HTTP endpoint) is expected to preflight before calling
 *     `runRound(input)`.
 *   - Drift checking. Same — preflight handles it.
 *   - Choosing the autonomous command. The `spawnCommand` is injected,
 *     defaulting to `claude` (which invokes the local /autonomous skill).
 *     Tests pass a custom command so they don't depend on the skill.
 *
 * Process group safety:
 *   The child is spawned with `detached: true` so it gets its own
 *   process group. `kill(-pgid, signal)` (Node passes negative PIDs
 *   for group signals) targets only the child's group — never reaps
 *   the runner.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';

import type { Initiative, InitiativeTracker, RoundStatus } from './InitiativeTracker.js';
import { ProjectRoundLock } from './ProjectRoundLock.js';
import { ProjectRoundWorktrees } from './ProjectRoundWorktrees.js';
import { detectClaudePath } from './Config.js';
import { SafeGitExecutor } from './SafeGitExecutor.js';
import { withSyncOp } from './InFlightSyncOpMarker.js';
import { hasCompleteMergedEvidence } from './ProjectRoundDerivation.js';

/** Per-spec defaults. Tests dial both down to keep the suite fast. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_SIGTERM_GRACE_MS = 5_000;
/** Resume cap from spec § Phase 1.5 step 11. */
export const DEFAULT_MAX_RESUME_ATTEMPTS = 3;

export interface RunRoundInput {
  tracker: InitiativeTracker;
  projectId: string;
  roundIndex: number;
  /**
   * Absolute target repo path; required (the spec's `targetRepoPath`).
   * The caller must have verified it points at a git repo (preflight does this).
   */
  targetRepoPath: string;

  /**
   * `process.cwd()` for the spawned autonomous child. Defaults to the
   * first item's worktree path. The autonomous child opens additional
   * worktrees as it works through items.
   */
  initialWorkdir?: string;

  /**
   * Command + args to spawn. Default is the production invocation:
   * `claude --skill autonomous` (resolved via PATH). Tests pass a
   * harmless command (`bash -c "exit 0"`) so the test doesn't actually
   * invoke claude.
   *
   * Stop condition + project/round identifiers are passed via env:
   *   INSTAR_PROJECT_ID, INSTAR_ROUND_INDEX, INSTAR_STOP_CONDITION
   *   INSTAR_ROUND_ITEM_IDS (JSON-encoded array)
   */
  spawnCommand?: string;
  spawnArgs?: string[];

  /** Poll cadence; defaults to 60s. */
  pollIntervalMs?: number;
  /** SIGTERM→SIGKILL grace; defaults to 5s. */
  sigtermGraceMs?: number;
  /** Max resume attempts on transient failures; defaults to 3. */
  maxResumeAttempts?: number;

  /**
   * Seam for verifying per-item artifacts. Defaults to the REAL git-backed
   * `verifyMergedItemsViaGit`; tests inject a stub.
   *
   * It returns the three-state verdict deliberately — `verified` /
   * `regressed` / `unverifiable`. A flat `Set<string>` cannot express "I
   * could not check", so every item merely absent from it reads as
   * not-merged, and this runner would respawn a child to redo work that may
   * already be done. See the verdict handling in `runRound` below.
   *
   * HISTORY: this defaulted to a no-op that returned an EMPTY SET
   * unconditionally, documented in place as "production callers should pass
   * a real one". No production caller ever did. The consequence was that the
   * all-items-merged stop condition could never fire, `outcome: 'complete'`
   * was unreachable, and a round whose items were all merged still spawned a
   * child to redo them. The default is now the real verifier precisely so a
   * caller cannot forget: a seam whose default silently reports "nothing
   * verified" is indistinguishable, to its caller, from "nothing is merged".
   */
  verifyMergedItems?: (childIds: string[]) => Promise<MergedVerificationResult>;

  /**
   * Canonical-main ref for the merge-base check. Defaults to the resolved
   * canonical ref (see `resolveCanonicalMainRef`), which matters on a
   * fork-origin agent home where `origin/main` does not contain the merge
   * commit and every healthy item would otherwise read as regressed.
   */
  mergeBaseBranch?: string;
}

/**
 * `unverifiable` is NOT a soft `partially-complete`. It means the runner could
 * not establish whether the round's work is done, so it has no verdict to
 * record and no basis to redo the work either.
 */
export type RoundOutcome =
  | 'complete'
  | 'partially-complete'
  | 'failed'
  | 'halted'
  | 'unverifiable';

export interface RunRoundResult {
  outcome: RoundOutcome;
  /** Verified-merged itemIds. */
  mergedItemIds: string[];
  /** itemIds that did NOT verify (only populated for partially-complete / halted). */
  unmergedItemIds: string[];
  /** Number of times the runner relaunched the child due to dynamic-stop changes. */
  relaunchCount: number;
  /** Number of times the round resumed after a transient child failure. */
  resumeAttempts: number;
  /** Human-readable reason — useful for halted / failed outcomes. */
  reason?: string;
}

/**
 * Lock that the runner needs but is too high-level to require here as
 * a positional parameter. Wires through the standard
 * `.instar/local/round-runner.lock` location.
 */
export interface RunRoundDeps {
  stateDir: string;
}

/**
 * Run one round to completion. Caller is expected to preflight first.
 */
export async function runRound(input: RunRoundInput, deps: RunRoundDeps): Promise<RunRoundResult> {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sigtermGraceMs = input.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
  const maxResumeAttempts = input.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS;
  /**
   * The items that are GENUINELY uncheckable: absent from `verified` for a
   * reason the runner could not establish, AND whose structured state says
   * work may already have landed (a merge commit, or a `merged` claim whose
   * evidence is incomplete).
   *
   * An ordinary pre-build item with no `mergeCommitOid` is also reported
   * `unverifiable` by the git verifier, but that means nothing has landed yet.
   * Splitting on structured state rather than the reason text keeps a reworded
   * message from silently changing control flow.
   *
   * Defined once and used at BOTH decision points. The first draft of this
   * change inlined it at the pre-spawn check only, and the post-exit check
   * kept the old conflation — caught by the test that asserts a fresh round
   * still spawns.
   */
  const uncheckable = (ids: string[], v: MergedVerificationResult): string[] =>
    ids.filter((id) => {
      const item = input.tracker.get(id);
      if (!item) return false;
      // A plain pre-build item with no merge commit is ordinary unfinished
      // work. A row that already CLAIMS `merged` without the evidence behind
      // that claim is different: rerunning it could duplicate completed work.
      if (item.pipelineStage === 'merged' && !hasCompleteMergedEvidence(item)) return true;
      return v.unverifiable.has(id) && Boolean(item.mergeCommitOid);
    });

  const mergeBaseBranch = input.mergeBaseBranch ?? resolveCanonicalMainRef(input.targetRepoPath);
  const verifyMergedItems =
    input.verifyMergedItems ??
    ((ids: string[]) =>
      verifyMergedItemsViaGit(input.targetRepoPath, ids, input.tracker, mergeBaseBranch));

  const lock = new ProjectRoundLock({ stateDir: deps.stateDir });

  // Step 1: acquire lock.
  const acquired = lock.acquire(input.projectId, input.roundIndex);
  if (!acquired.ok) {
    return {
      outcome: 'failed',
      mergedItemIds: [],
      unmergedItemIds: [],
      relaunchCount: 0,
      resumeAttempts: 0,
      reason: `lock held by pid ${acquired.currentHolder.pid}`,
    };
  }

  let relaunchCount = 0;
  let resumeAttempts = 0;

  try {
    let snapshot = await readRound(input.tracker, input.projectId, input.roundIndex);
    if (!snapshot) {
      return {
        outcome: 'failed',
        mergedItemIds: [],
        unmergedItemIds: [],
        relaunchCount,
        resumeAttempts,
        reason: 'project or round disappeared',
      };
    }
    let lastItemIds = [...snapshot.itemIds];

    // Step 3: lazy worktree allocation for round items. The autonomous
    // child opens more as it reaches them; we kick off only the first
    // here to give the child a starting cwd.
    if (lastItemIds.length > 0) {
      try {
        ProjectRoundWorktrees.allocate(
          {
            targetRepoPath: input.targetRepoPath,
            projectId: input.projectId,
            roundIndex: input.roundIndex,
            itemId: lastItemIds[0],
          },
          { refuseExisting: false }
        );
      } catch {
        // First-item worktree may pre-exist if a previous attempt
        // crashed mid-way. Continue.
      }
    }

    // Inner relaunch loop: steps 4-5.
    // We loop until either the child exits naturally or we detect a
    // halt / stop-condition-met.
    let outcome: RoundOutcome = 'failed';
    let mergedItemIds: string[] = [];
    let unmergedItemIds: string[] = [];
    let reason: string | undefined;

    for (;;) {
      // Per-step halt checkpoint.
      const halted = await readHaltedAt(input.tracker, input.projectId, input.roundIndex);
      if (halted) {
        outcome = 'halted';
        reason = `round halted at ${halted}`;
        unmergedItemIds = [...lastItemIds];
        break;
      }

      // Compute current stop condition: itemIds verified-merged.
      const verdict = await verifyMergedItems(lastItemIds);
      // "I could not check" is not "not done" — but neither is it a reason to
      // stall a round that has simply not been worked yet.
      //
      // `verifyMergedItemsViaGit` reports `unverifiable` for BOTH of these:
      //   (a) the item records no mergeCommitOid at all — nothing has landed
      //       yet, which is the ordinary state of a fresh round. Spawning is
      //       exactly right here.
      //   (b) the item records a merge commit but git could not answer, OR the
      //       item already claims `merged` while its evidence is incomplete.
      //       Here the work may already be done, and spawning would redo it.
      //
      // They are told apart by STRUCTURED RECORD STATE, not by matching the
      // reason text, which would make a reworded message silently change the
      // control flow.
      const uncheckableWithEvidence = uncheckable(lastItemIds, verdict);
      if (uncheckableWithEvidence.length > 0) {
        outcome = 'unverifiable';
        unmergedItemIds = lastItemIds.filter((id) => !verdict.verified.has(id));
        reason =
          `could not verify ${uncheckableWithEvidence.length} item(s) whose records say work may ` +
          `already be merged (${uncheckableWithEvidence.join(', ')}); refusing to respawn work that ` +
          'may already be done, and recording no round verdict';
        break;
      }
      if (lastItemIds.every((id) => verdict.verified.has(id))) {
        outcome = 'complete';
        mergedItemIds = [...lastItemIds];
        break;
      }

      // Spawn the autonomous child with stop condition + ids in env.
      const child = spawnAutonomousChild(input, lastItemIds);
      const exit = await waitForExitOrPollChange(
        child,
        input.tracker,
        input.projectId,
        input.roundIndex,
        lastItemIds,
        pollIntervalMs,
        sigtermGraceMs
      );

      if (exit.kind === 'set-changed') {
        relaunchCount++;
        const fresh = await readRound(input.tracker, input.projectId, input.roundIndex);
        if (!fresh) {
          outcome = 'failed';
          reason = 'project disappeared during round';
          break;
        }
        lastItemIds = [...fresh.itemIds];
        // Loop continues; next iteration re-checks stop condition then
        // either spawns again or proceeds to step 6.
        continue;
      }

      if (exit.kind === 'halted') {
        outcome = 'halted';
        reason = 'round halted via API during run';
        unmergedItemIds = [...lastItemIds];
        break;
      }

      // The child never started. Record it as a round failure that NAMES the
      // cause, and do NOT spend a resume attempt: a binary that cannot be
      // resolved or executed will not resolve on a retry, so relaunching would
      // burn the attempt budget and report the wrong reason ("attempts
      // exhausted") for a condition that is not about attempts at all.
      // "Could not start" and "started and failed" are different facts and the
      // round record must not render them the same.
      if (exit.kind === 'spawn-failed') {
        outcome = 'failed';
        // Node's spawn errors already name the binary ("spawn claude ENOENT"),
        // so the message alone is enough to diagnose without plumbing the
        // resolved path — which would risk leaking an absolute home path.
        reason = `could not start the autonomous child: ${exit.spawnError ?? 'unknown spawn error'}`;
        unmergedItemIds = [...lastItemIds];
        break;
      }

      // Natural exit.
      if (exit.kind === 'exited' && exit.code === 0) {
        // Step 6: verify per-item artifacts.
        const final = await verifyMergedItems(lastItemIds);
        const finalUncheckable = uncheckable(lastItemIds, final);
        mergedItemIds = lastItemIds.filter(
          (id) => final.verified.has(id) && !finalUncheckable.includes(id),
        );
        unmergedItemIds = lastItemIds.filter((id) => !mergedItemIds.includes(id));
        if (finalUncheckable.length > 0) {
          // At least one item records a merge commit the runner could not
          // check, or claims merged without the full evidence contract.
          // `partially-complete` asserts "this genuinely did not land",
          // which that item cannot support — so no verdict is recorded.
          //
          // An item with no merge commit at all, by contrast, genuinely did
          // not land after a clean child exit, and falls through to
          // partially-complete below where it belongs.
          outcome = 'unverifiable';
          reason =
            `child exited 0 but ${finalUncheckable.length} item(s) lacked complete, ` +
            `checkable merge evidence (${finalUncheckable.join(', ')}); no round verdict recorded`;
        } else if (unmergedItemIds.length === 0) {
          outcome = 'complete';
        } else {
          outcome = 'partially-complete';
        }
        break;
      }

      // Non-zero exit → resume attempt.
      resumeAttempts++;
      if (resumeAttempts >= maxResumeAttempts) {
        outcome = 'failed';
        reason = `${resumeAttempts} resume attempts exhausted (last exit code: ${exit.kind === 'exited' ? exit.code : exit.kind})`;
        unmergedItemIds = [...lastItemIds];
        break;
      }
      // Backoff before relaunch.
      await sleep(1000 * resumeAttempts);
    }

    // Step 7: cleanup worktrees.
    try { ProjectRoundWorktrees.prune(input.targetRepoPath); } catch { /* best-effort */ }

    // Step 9-11: record round status. We DO NOT touch
    // unacknowledgedAdvanceCount here — that's the auto-advance poller's
    // job. We just record the round status.
    if (outcome !== 'halted') {
      await recordOutcome(input.tracker, input.projectId, input.roundIndex, outcome);
    }

    return { outcome, mergedItemIds, unmergedItemIds, relaunchCount, resumeAttempts, reason };
  } finally {
    // Step 8: release lock.
    lock.release();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

interface RoundSnapshot {
  itemIds: string[];
  status: RoundStatus;
}

async function readRound(
  tracker: InitiativeTracker,
  projectId: string,
  roundIndex: number
): Promise<RoundSnapshot | null> {
  const proj = tracker.get(projectId);
  if (!proj) return null;
  const round = (proj.rounds ?? [])[roundIndex];
  if (!round) return null;
  return { itemIds: round.itemIds ?? [], status: (round.status ?? 'pending') };
}

async function readHaltedAt(
  tracker: InitiativeTracker,
  projectId: string,
  roundIndex: number
): Promise<string | null> {
  const proj = tracker.get(projectId);
  if (!proj) return null;
  const round = (proj.rounds ?? [])[roundIndex];
  return round?.haltedAt ?? null;
}

async function recordOutcome(
  tracker: InitiativeTracker,
  projectId: string,
  roundIndex: number,
  outcome: RoundOutcome
): Promise<void> {
  const proj = tracker.get(projectId);
  if (!proj) return;
  // `unverifiable` has NO status. Every other outcome is a verdict the runner
  // actually reached; this one is the absence of one, so the round keeps the
  // status it had and gets asked again later. Mapping it onto `failed` or
  // `partially-complete` would record a conclusion nothing established — the
  // precise move that made a no-op verifier look like a healthy answer.
  const map: Record<Exclude<RoundOutcome, 'unverifiable'>, RoundStatus> = {
    complete: 'complete',
    'partially-complete': 'partially-complete',
    failed: 'failed',
    halted: 'failed',
  };
  if (outcome === 'unverifiable') return;
  const newStatus = map[outcome];
  const completedAt = new Date().toISOString();
  const rounds = (proj.rounds ?? []).map((r, i) =>
    i === roundIndex ? { ...r, status: newStatus, completedAt } : r
  );
  try {
    await tracker.update(projectId, { rounds, ifMatch: proj.version });
  } catch {
    // OCC race — caller (or next reconcile) will retry.
  }
}

interface ExitResult {
  kind: 'exited' | 'set-changed' | 'halted' | 'spawn-failed';
  code?: number | null;
  signal?: NodeJS.Signals | null;
  /** Sanitized reason, present only when kind === 'spawn-failed'. */
  spawnError?: string;
}

/**
 * Spawn errors captured at the spawn site.
 *
 * `child_process.spawn` reports a failure to START (ENOENT, EACCES) by
 * emitting `'error'` — NOT by emitting `'exit'`. Two consequences, and the
 * second is the one that bites:
 *
 *   1. An unhandled `'error'` becomes a process-level uncaught exception.
 *      `uncaughtExceptionPolicy` crashes by default on anything it does not
 *      recognise — correctly, since an unknown exception is not safe to
 *      swallow. So an unstartable child took the WHOLE agent server down.
 *   2. Even with the crash averted, `'exit'` never fires, so a waiter that
 *      listens only for `'exit'` waits forever for an event that cannot come.
 *
 * Capturing here — at the spawn site, in the same tick as the spawn — means
 * the "a spawn failure never crashes the process" property does not depend on
 * any caller remembering to attach a listener. The waiter separately consumes
 * the error to turn it into a recorded round failure.
 */
const spawnFailures = new WeakMap<ChildProcess, Error>();

function spawnAutonomousChild(input: RunRoundInput, itemIds: string[]): ChildProcess {
  // Resolve the binary rather than trusting the server's PATH. The server runs
  // under launchd, whose PATH routinely excludes the nvm/asdf/npm-global bin dir
  // that actually holds `claude` — so a bare 'claude' resolves in the operator's
  // terminal and ENOENTs in the server. `detectFrameworkBinary` already scans
  // exactly those locations (its own comment records the 2026-05-31 session-spawn
  // crash from this same cause); this callsite simply was not using it.
  // Falls back to the bare name so a host where detection legitimately finds
  // nothing behaves as before rather than failing earlier than it used to.
  const cmd = input.spawnCommand ?? detectClaudePath() ?? 'claude';
  const args = input.spawnArgs ?? ['--skill', 'autonomous'];
  const workdir =
    input.initialWorkdir ??
    (itemIds.length > 0
      ? ProjectRoundWorktrees.pathFor({
          targetRepoPath: input.targetRepoPath,
          projectId: input.projectId,
          roundIndex: input.roundIndex,
          itemId: itemIds[0],
        })
      : input.targetRepoPath);
  const child = spawn(cmd, args, {
    cwd: workdir,
    detached: true, // critical — makes the child its own process group leader
    stdio: 'ignore',
    env: {
      ...process.env,
      INSTAR_PROJECT_ID: input.projectId,
      INSTAR_ROUND_INDEX: String(input.roundIndex),
      INSTAR_ROUND_ITEM_IDS: JSON.stringify(itemIds),
      INSTAR_STOP_CONDITION: 'all-items-merged-on-main',
    },
  });
  // Attach IMMEDIATELY — see spawnFailures above. Without a listener a failure
  // to START is an unhandled 'error' event, which is a process-level uncaught
  // exception, which kills the agent server. This listener exists so that
  // property holds no matter what the caller does with the returned child.
  child.on('error', (err: Error) => {
    spawnFailures.set(child, err);
  });
  return child;
}

async function waitForExitOrPollChange(
  child: ChildProcess,
  tracker: InitiativeTracker,
  projectId: string,
  roundIndex: number,
  initialItemIds: string[],
  pollIntervalMs: number,
  sigtermGraceMs: number
): Promise<ExitResult> {
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });

  // A child that never STARTED emits 'error' and never emits 'exit', so the
  // loop below would otherwise wait forever for an event that cannot arrive.
  // Check the spawn-site capture first (the error may already have fired before
  // this function attached anything), then listen for a later one.
  // An error that ALREADY fired (captured at the spawn site) is answered before
  // any waiting at all — read into its own local so the check below is not
  // narrowed by this one.
  const alreadyFailed = spawnFailures.get(child);
  if (alreadyFailed) {
    return { kind: 'spawn-failed', spawnError: alreadyFailed.message };
  }
  // Holder object rather than a bare `let`: the assignment happens inside a
  // callback, which TypeScript's control-flow analysis cannot see.
  const failure: { err?: Error } = {};
  const spawnFailurePromise = new Promise<void>((resolve) => {
    child.once('error', (err: Error) => {
      failure.err = err;
      resolve();
    });
  });

  while (!exited) {
    // Wait for exit, a spawn failure, OR the poll interval — whichever is first.
    await Promise.race([exitPromise, spawnFailurePromise, sleep(pollIntervalMs)]);
    const failedToStart = failure.err;
    if (failedToStart) {
      return { kind: 'spawn-failed', spawnError: failedToStart.message };
    }
    if (exited) break;

    // Halt check.
    const halted = await readHaltedAt(tracker, projectId, roundIndex);
    if (halted) {
      await killProcessGroup(child, sigtermGraceMs);
      return { kind: 'halted' };
    }

    // Stop-condition revalidation: did itemIds change?
    const snap = await readRound(tracker, projectId, roundIndex);
    if (!snap) {
      await killProcessGroup(child, sigtermGraceMs);
      return { kind: 'halted' };
    }
    if (!arraysEqual(snap.itemIds, initialItemIds)) {
      await killProcessGroup(child, sigtermGraceMs);
      return { kind: 'set-changed' };
    }
  }
  return { kind: 'exited', code: exitCode, signal: exitSignal };
}

async function killProcessGroup(child: ChildProcess, graceMs: number): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    // Negative PID targets the process group. child is its own group
    // leader because we spawned with detached:true.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return; // Already dead.
  }
  const start = Date.now();
  while (child.exitCode === null && Date.now() - start < graceMs) {
    await sleep(100);
  }
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch { /* already dead */ }
    // Brief wait for the OS to register the kill.
    await sleep(100);
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the ref that actually holds canonical `main` for this checkout.
 *
 * On a fork-origin agent home `origin/main` does NOT contain the canonical
 * merge commit, so a merge-base check against it reports every healthy item
 * as regressed. Falls back to the documented `origin/main` when `gh` or the
 * remote mapping is unavailable (canonical-origin installs).
 *
 * Lives here rather than in the server layer because BOTH consumers — the
 * lazy reconciler in `routes.ts` and this round runner — need the same
 * resolution, and a core module must not import from `server/`.
 *
 * READ-ONLY: `gh repo view` + `git remote -v` (the latter via
 * SafeGitExecutor.readSync — `remote` is a READONLY_GIT_VERB, shape-checked
 * to list/get-url only).
 */
export function resolveCanonicalMainRef(repoPath: string): string {
  const FALLBACK = 'origin/main';
  try {
    // `gh repo view` is a BLOCKING spawn and this runs inside the server
    // process (the auto-advance poller calls runRound). It funnels through
    // withSyncOp so the in-flight marker sees the stall instead of it looking
    // like an unexplained event-loop freeze.
    //
    // In `routes.ts` this callsite sat on the chokepoint lint's frozen
    // baseline — grandfathered, not blessed. Moving it into core made it a NEW
    // violation, and the lint refused it. That refusal is the useful part: it
    // stopped a pre-existing blocking hazard from spreading into a module the
    // round runner calls on every pass.
    const GH_ARGS = ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'];
    const GH_OPTS = {
      cwd: repoPath,
      encoding: 'utf-8' as const,
      stdio: ['ignore', 'pipe', 'ignore'] as ('ignore' | 'pipe')[],
    };
    // The wrap must sit on the SAME LINE as the spawn: the chokepoint lint is a
    // deliberately lexical, same-line matcher (it documents that it cannot prove
    // runtime wrapping — that is the marker's own unit test's job). A cheap
    // signal, not an authority, so it is satisfied literally.
    const ghRepo = withSyncOp(() => execFileSync('gh', GH_ARGS, GH_OPTS)).trim();
    if (!ghRepo) return FALLBACK;
    const remotesOut = SafeGitExecutor.readSync(['remote', '-v'], {
      cwd: repoPath,
      operation: 'ProjectRoundExecution.resolveCanonicalMainRef',
      encoding: 'utf-8',
    });
    for (const line of remotesOut.split('\n')) {
      // format: "<name>\t<url> (fetch)"
      const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line.trim());
      if (!m) continue;
      const [, name, url] = m;
      if (url.includes(ghRepo) || url.includes(`${ghRepo}.git`)) {
        return `${name}/main`;
      }
    }
    return FALLBACK;
  } catch { /* @silent-fallback-ok: resolving the canonical-main ref is best-effort — gh missing / not-a-gh-repo / git error falls back to the documented `origin/main` default (the prior behavior), which the merge-base gate then re-validates. Not a degradation: it's the conservative default this resolver exists to refine, not replace. */
    return FALLBACK;
  }
}

/**
 * Three-state outcome. `unverifiable` is NOT a soft `regressed`: it means the
 * check could not be run at all, and collapsing the two is how a refusal becomes
 * a fabricated factual claim (the defect `/projects/:id/advance` had fixed for
 * itself in #1643 while this sibling kept it).
 */
export interface MergedVerificationResult {
  /** Proven reachable from the canonical-main ref. */
  verified: Set<string>;
  /** git exited 1 — the documented, genuine "not an ancestor". */
  regressed: Set<string>;
  /** The question could not be answered; the caller must NOT infer either way. */
  unverifiable: Map<string, string>;
}

/**
 * Helper exported so callers can wire a SafeGit-backed verifier.
 *
 * This function was dead code in practice until 2026-07-26: it selects on
 * `child.mergeCommitOid`, and the only path that could have written that field
 * (`/projects/:id/advance`) validated the merge commit and then discarded it. So
 * every child hit the `continue` and the caller saw an empty set — a regression
 * detector that scanned nothing and reported nothing, which reads exactly like a
 * clean bill of health. Three defects therefore sat here unexercised, all three
 * already fixed in the advance path a few hundred lines away:
 *
 *   1. no `sourceTreeReadOk`, so SourceTreeGuard REFUSES this read against an
 *      instar source tree (the #1641 defect);
 *   2. a hardcoded `origin/main`, which on a dev-agent home is the agent's FORK,
 *      not where merges land — so the correct answer is "unreachable";
 *   3. a bodyless catch swallowing every error → not verified → the caller marks
 *      the item `regressed`, i.e. "I could not check" rendered as "it was
 *      reverted". (Described in words rather than shown as a literal: the
 *      empty-catch ratchet counts occurrences in comments too, so quoting the
 *      forbidden shape here fails the lint — a text matcher fooled by prose
 *      describing the thing it forbids. Same trap is documented in
 *      tests/unit/projects-advance-mergebase-wiring.test.ts.)
 *
 * Any one of those would have turned healthy merged items into false regressions
 * the moment the evidence started being written. Fixed together, because writing
 * the evidence is what arms this code path.
 */
export async function verifyMergedItemsViaGit(
  targetRepoPath: string,
  childIds: string[],
  tracker: InitiativeTracker,
  /** Canonical-main ref. Callers on a fork-origin install MUST resolve and pass
   *  the real one; the default preserves behaviour for canonical-origin installs. */
  mergeBaseBranch: string = 'origin/main'
): Promise<MergedVerificationResult> {
  const verified = new Set<string>();
  const regressed = new Set<string>();
  const unverifiable = new Map<string, string>();
  for (const id of childIds) {
    const child = tracker.get(id);
    if (!child) continue;
    if (!child.mergeCommitOid) {
      // No evidence on the record — that is not a regression, it is an item we
      // cannot speak about. Naming it keeps the gap visible instead of silently
      // folding it into a clean result.
      unverifiable.set(id, 'no mergeCommitOid recorded on the item');
      continue;
    }
    try {
      SafeGitExecutor.readSync(
        ['merge-base', '--is-ancestor', child.mergeCommitOid, mergeBaseBranch],
        {
          cwd: targetRepoPath,
          operation: 'ProjectRoundExecution.verifyMergedItemsViaGit',
          stdio: ['ignore', 'ignore', 'ignore'],
          sourceTreeReadOk: true,
        }
      );
      verified.add(id);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (status === 1) {
        regressed.add(id); // git's documented exit 1 — the ONLY genuine negative
      } else {
        unverifiable.set(id, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return { verified, regressed, unverifiable };
}

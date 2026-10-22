# Side-Effects Review — local-verify service (server-run verification of a PR's merge tree)

**Version / slug:** `local-verify-service`
**Date:** `2026-10-21`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent, two rounds — concur (see "Second-pass review" below)`

## Summary of the change

Second piece of `docs/specs/local-verify-merge-authority.md` (§2, approved 2026-10-21). New `src/localVerify/`: pure modules (test inventory and lanes, vitest JSON report evaluation, a parser-based skip/removal ratchet, the harness-changing classifier, the record and its 140-character status description), the run orchestrator (a private bare clone under `<agentHome>/.worktrees/.verify/`, `merge-tree` + `commit-tree` of base and head, `npm ci`, build, the `npm run lint` list, the three lanes with `--allowOnly=false`, per-step deadlines, a clean-tree check, cleanup), a child-process entry, `LocalVerifyService` (FIFO queue capped at 10, dedupe, cancel on a moved head, the retry table, single flight against foreign suites with wait-in-place, the two-phase in-flight protocol, the completion journal and its boot rebuild), and three routes (`POST /local-verify`, `GET /local-verify`, `GET /local-verify/record`). `SafeGitExecutor` gains the `localVerifyCloneOk` carve-out and `SafeFsExecutor` the `localVerifyScopeOk` carve-out, both admitting only paths inside `.worktrees/.verify/`. `server.ts` constructs the service only when `monitoring.localVerify.enabled` is true and the server runs from an instar source checkout. The template and the update migrator gain a short Local Verify section; the state registry gains the journal, in-flight record and audit log.

Nothing consumes a record yet: no status is posted and safe-merge and the watcher are unchanged. Those are the next pieces.

## Decision-point inventory

- `checkEligibility` — add — which PRs may be verified (agent or operator login, same repository). Deterministic invariant.
- `evaluateRun` — add — whether a run succeeded (every inventoried file in exactly one gating lane, zero failures, at least one collected test). Deterministic invariant.
- `classifyHarness` / `evaluateSkipRatchet` — add — flags that will later route a PR to operator approval. Deterministic; a read failure classifies harness-changing (fails toward human review).
- `SafeGitExecutor` / `SafeFsExecutor` carve-outs — add — admit an enumerated verb set only when every target is inside `.worktrees/.verify/`.

---

## 1. Over-block

The verifier can refuse or fail a PR that would really pass: (a) a merge that git reports as conflicting but GitHub merges. Found on the first real run (PR 2247): every release empties `upgrades/next/`, and git's directory-rename guess moved a PR's new fragment; fixed with `merge.directoryRenames = false` in the clone template, with a real-git regression test. Other heuristic merge differences between local git and GitHub remain possible and would show as `error:conflict`, never as a pass. (b) A flaky test fails the run; the integration lane already runs one file at a time. (c) A build that rewrites a checked-in file fails the clean-tree check. (d) An environment that differs from CI: the first full real run (PR 2285, 42 minutes) failed tmux pane tests because the verifier's scrubbed environment carried no locale and the server itself has none; every run now gets `LANG=C.UTF-8` when no locale is set (as GitHub's runners have), with tests. Three packaging tests failed in that run and passed on rerun, so they look flaky under load; a rerun is the evidence either way. Today all of these only produce a record; nothing blocks on it yet.

---

## 2. Under-block

- Tests registered through custom wrapper functions are invisible to the skip ratchet (stated in the spec).
- The run's code is the PR's code running as the agent user; a malicious test could write anywhere the agent can (the threat model limits verification to trusted logins; forks and other authors are refused as `untrusted-head`).
- Only the direct process of a step is killed at its deadline; the rest of the group is killed when the child exits.
- **Found by the second pass and fixed before commit — git repository discovery.** The first version of the carve-out trusted the working directory's path, but git finds its repository by searching upward. With a damaged `repo.git` (only `HEAD`, e.g. after a crash mid-init) git resolved to the agent's own checkout (`~/.instar/agents/<agent>` is itself an instar checkout), so `update-ref refs/heads/main`, `checkout` and `worktree prune` would have acted on it with SourceTreeGuard bypassed. Now: every verifier git call sets `GIT_DIR` (and `GIT_WORK_TREE` for run worktrees) and `GIT_CEILING_DIRECTORIES=<agentHome>/.worktrees`; the carve-out runs `git rev-parse --absolute-git-dir` with the same cwd and env and bypasses the guard only when the answer is inside this agent's `.worktrees/.verify/` (realpath); `init` is skipped only when `HEAD`, `objects/` and `refs/` exist (otherwise the damaged clone is wiped and re-made); worktree path arguments are resolved against the cwd and realpath'd; `worktree remove --force` is denied. The match is anchored to this agent's root, not any `.worktrees/.verify` pair. Real-git tests cover the repro and the lookalike paths. A re-review then asked for the root itself to be checked: the carve-out now applies only when the root is `<…>/.worktrees/.verify` and `.verify` is a real directory, not a symlink (a symlink to the agent home would otherwise exempt the whole tree), with a test. The three env keys the carve-out sets itself (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CEILING_DIRECTORIES`) are a deliberate, narrow exception to SafeGitExecutor's env denylist; nothing comes from the caller's environment.

---

## 3. Level-of-abstraction fit

The trusted logic (inventory, evaluation, classification, the journal) runs from the installed server, never from the merge tree; only the PR's own test configs run inside it, as the spec requires. Git and deletes go through the existing funnels with path-scoped carve-outs modelled on `feedbackAttemptCloneOk`, rather than new direct calls. The service reuses the in-flight protocol shape of `MergeRunner` (see Interactions for one difference).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface yet.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

This piece only produces records. When a later piece makes a record a merge input, it is a deterministic test outcome on the exact merge tree, the same kind of authority GitHub's own required checks are today, not a brittle detector over prose (spec: Supervision, tier0).

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Every rule here is an enumerable invariant over a test report or a diff.

---

## 5. Interactions

- **Host test-runner bound:** each lane acquires its suite slot through the lane configs' existing `withTestRunnerBound`. Before each lane the service checks the holders file and waits in place up to 30 minutes for a foreign full suite, then re-queues. The bound is watch-only, so overlap is measured, not prevented (stated in the spec).
- **MergeRunner:** the helper found that `MergeRunner.reapOrphan` clears its record even when it cannot confirm the orphan's identity, and its identity check reads `/proc`, so on macOS it never kills an orphan. This service implements the spec's stricter rule (keep the record, audit `orphan-reap-incomplete`, block new runs until the group is gone; identity read with `ps -o args=`). The MergeRunner gap is reported separately and is not changed here.
- **Agent-home checkout:** the verifier never touches it; the bare clone avoids `index.lock` contention with auto-update.
- **SessionReaper / watchdog:** a verify runs as a detached process group under `nice`, not in a tmux session; the command watchdog's test-runner floor applies to its vitest children.

---

## 6. External surfaces

Three new authenticated routes (503 unless enabled on a source checkout; 409 on a standby). GitHub is read through the agent's explicit `gh` identity (`pr view`); the clone fetches the public repository anonymously. No messages are sent; the starvation signal is a seam with no consumer yet.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable — no dashboard or approval surface touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the journal and index live on the machine that ran the verify, and only the lease holder accepts requests (standbys answer 409 naming the holder). The spec's multi-machine rules (a different machine taking the lease starts with an empty index; pool-wide config) belong to the status-posting piece.

---

## 8. Rollback cost

Off by default. `monitoring.localVerify.enabled: false` (or absent) means the service is never constructed. Reverting the commit removes it; the journal and `.worktrees/.verify/` are inert files that can be deleted.

---

## Conclusion

The core of the checker, off by default and consumed by nothing yet. The first real run already caught and fixed one false conflict.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (two rounds)
**Independent read of the artifact: concur (after fixes)**

Round 1 raised the repository-discovery escape and the unanchored path match (blocking); both fixed. Round 2 confirmed the repro now fails closed, every verifier git call pins `GIT_DIR`, the env override is limited to three keys the executor sets itself, and raised one hardening point (a symlinked or misshapen root); fixed in `isWellFormedLocalVerifyRoot` with a test. No remaining concern.

## Evidence pointers

- `tests/unit/localVerify/*.test.ts` (inventory, lane report, skip ratchet, harness classifier, record, orchestrator, service, carve-out against real git, routes)
- `tests/integration/local-verify-routes.test.ts`
- `tests/e2e/local-verify-lifecycle.test.ts`
- Real runs on PR 2247 (see the PR body).

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `gap`, tracked as **ACT-147** (register the retry/requeue controller in `src/testing/selfActionRegistry.ts` with a convergence model).
- **Why it settles today:** an errored verify is re-run at most once per (pr, head); a failure re-runs only on a head move or an explicit request (at most once per new base); the queue is capped at 10 with one entry per PR; a capacity requeue is not an attempt, and the starved signal fires once per entry after 3 hours; the tick is 30 seconds. ACT-147 adds the registry model that proves this under sustained pressure.

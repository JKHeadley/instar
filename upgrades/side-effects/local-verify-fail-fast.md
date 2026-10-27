# Side-Effects Review — Local Verify fail-fast lanes and flaky-on-`main` re-runs

**Version / slug:** `local-verify-fail-fast`
**Date:** `2026-10-27`
**Author:** `Echo`
**Second-pass reviewer:** `independent cross-model reviewer (see below)`

## Summary of the change

Tier 1 (small, reversible; the fail-fast half has a live switch). Amendment to `docs/specs/local-verify-merge-authority.md` ("Fail-fast lanes and flaky-on-`main` re-runs", built 2026-10-27). Operator request (Telegram topic 130715, 2026-10-26 17:51): merge throughput is top priority.

- `src/localVerify/orchestratorSeams.ts` `realExec`: optional `opts.signal`; on abort the result carries `aborted: true` (never `deadlineKilled`; the deadline timer ignores an already-aborted child; an already-aborted signal spawns nothing). A stop (abort or deadline) signals the process AND its descendants (`descendantPids`, one `ps -A -o pid=,ppid=` snapshot taken before the parent is signalled), SIGTERM then SIGKILL after the grace; the SIGKILL escalation is not cancelled when the parent settles and goes only to pids whose `lstart` start second and `comm` command are unchanged (a reused pid is signalled only if it matches both; implausible with sequential pid allocation); after a stop, once the process has exited, the wait for its pipes is bounded at 5 s (`CLOSE_AFTER_EXIT_MS`). This also applies to deadlines: before, a deadline signalled only the direct child, and a descendant holding the pipes could keep the step waiting indefinitely. A step that exits on its own is waited for exactly as before.
- `src/localVerify/orchestrator.ts`: `VerifyRunInput.failFast`; PR verifies with it set share one `AbortController` across the lanes; a lane that ends with a failure its isolation re-run did not clear (`laneFailedFinally`: missing report, a failed file, or a non-zero exit) aborts the others; an aborted lane returns `stoppedEarly`; an isolation re-run stopped mid-flight counts as failing. `ineligibleFor` no longer refuses a file because the last green `main` showed it re-run-passed (logs `isolation-rerun-flaky-on-main`); the changed-file and import rules and the no-green-main rule are unchanged.
- `src/localVerify/laneReport.ts` `evaluateRun`: a `stoppedEarly` lane gives `lane-stopped-early:<lane>` appended AFTER every real reason, its files are not `file-not-run`, and a stopped lane alone can never make a run succeed or be the only reason.
- `src/localVerify/LocalVerifyService.ts`: `setFailFastEnabled` live switch (absent ⇒ on; unreadable ⇒ off), PR inputs carry `failFast: true` when on. `src/localVerify/localVerifyWiring.ts`: `wireLocalVerifySwitches` (the main-red hold switch moved here from `server.ts` unchanged, plus the new one); `server.ts` calls it.
- Agent awareness: `templates.ts` bullet; `PostUpdateMigrator` content-sniffed line (`monitoring.localVerify.failFast`).

**Proportion:** 9 source/doc files, ~170 LOC runtime, 5 test files. One session, measured first (121 journal rows, 48 failed-run logs) before building.

## Decision-point inventory

- `laneFailedFinally` → `stopLanes.abort()` — add — stop the remaining lanes of a PR verify that has already failed. Deterministic.
- `ineligibleFor` — modify — a flaky-on-`main` file is now eligible for its one isolation re-run.
- `evaluateRun` — modify — stopped lanes are reported, not counted as missing.
- Merge decisions (§3 predicate, safe-merge, policy hash) — pass-through, unchanged.

## 1. Over-block

- None new. Fail-fast only fires when the run is already a failure; the flaky change only admits a re-run.

## 2. Under-block

- **Fail-fast hides the stopped lanes' own failures** from that record (the author sees them on the next verify). Accepted: the verdict is the same, the slot frees 8-10 minutes sooner on a unit-lane failure.
- **A flaky-on-`main` file that a PR breaks through a path the static import scan cannot see** (shared global state, a fixture read by path) and whose failure then passes alone would pass as a flake. This is the same residual risk the isolation re-run already accepts for every other file; the per-file `local-verify:flaky:<file>` attention item and its 3-in-7-days re-raise still make the file a tracked fix. Bounded by the cap of 3 re-runs per verify.
- **Main verifies** never stop early, so a red `main` still yields the complete failing-file list the main-red hold depends on.

## 3. Level-of-abstraction fit

Both changes live where the decision is already made: the lane loop in the verifier child and the isolation-eligibility helper. The abort travels through the existing exec seam (no new process management); the stop uses the kill path deadlines already use.

## 4. Signal vs authority compliance

The verifier remains the authority for a verify's outcome; neither change can turn a failing run into a passing one except through the pre-existing isolation re-run, whose pass rule (all re-run files pass alone with zero unhandled errors) is unchanged. Fail-fast only shortens a run whose outcome is already `failure`.

## 4b. Judgment-point check

No judgment points added; both decisions are deterministic over the run's own data.

## 5. Interactions

- **Stopped or deadline-killed steps:** after the stop, a process that has exited while a descendant still holds its pipes settles 5 s after exiting; the descendant was already signalled (SIGTERM, then SIGKILL after the grace even if the parent settled first) and is otherwise removed by the service's process-group sweep at the end of the run. A step that exits on its own is unchanged (known, pre-existing: a descendant it leaves holding its pipes keeps it waiting until its deadline, now bounded after that deadline).

- **Test-runner bound:** stopped lanes release their processes sooner; the suite slot is released at the same point as before (after `Promise.allSettled`).
- **Temp dirs / tmux servers:** an aborted lane's per-lane TMPDIR and TMUX_TMPDIR are already in `tempDirs` and removed by the existing cleanup.
- **Merge line, main-red hold, error auto-retry:** a fail-fast run is an ordinary `failure` record; nothing downstream sees a new outcome.
- **Flaky-file signal:** more files can now be recorded as `flakyRetried` (and raise their attention item) on PR verifies — intended: those are real flakes now being tracked instead of failing PRs.

## 6. External surfaces

No route, record-schema, or policy-hash change. New audit events in the run log: `lanes-stop`, `lane-stopped-early`, `isolation-rerun-flaky-on-main`, `step.stoppedEarly`, isolation re-run outcome `stopped`. New reasons in run-detail: `lane-stopped-early:<lane>`.

## 6b. Operator-surface quality

Nothing new for the operator to read or tap; the PR author sees the real failure first.

## 7. Multi-machine posture

Machine-local like the rest of local-verify; the switch is read from that machine's config.

## 8. Rollback cost

Fail-fast: `monitoring.localVerify.failFast: false` (read at each start, no restart). Flaky rule: revert the change. No state migration either way.

## Conclusion

Safe to ship: no merge decision changes, the stop only shortens already-failed runs, and the re-run relaxation removes a rule that converted known flakes into PR failures while keeping every protection against a PR's own breakage.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action` — closure `n/a`: one-shot per verify run, not a self-triggered loop. The stop fires at most once per run, only after a lane has already failed the run, and signals only that run's own lane processes (the child and its descendants found under it); nothing re-triggers it.

## Second-pass review

**Reviewer:** Independent cross-model reviewer (Codex read-only; five rounds, final concurrence).

Concurred after five rounds; see below.
Independent cross-model reviewer (Codex `codex exec --sandbox read-only`, a different model family from the author), five rounds over the staged change:
- Round 1 BLOCKED: (1) `laneFailedFinally` treated a null exit as failure while `evaluateRun` accepts a clean report with a null exit (fail-fast could turn a success into a failure) — fixed to mirror `evaluateRun`; (2) a stop signalled only the direct child, so a descendant holding the pipes could keep a lane waiting forever — fixed with a descendant-tree stop and a bounded close; (3) interleaving tests missing — added.
- Round 2 BLOCKED: (1) settling cancelled the SIGKILL escalation for a TERM-ignoring descendant with its own stdio — the escalation is no longer cancelled; (2) the bounded close also applied to natural exits and abandoned live descendants — now applies only after a stop.
- Round 3 BLOCKED: the uncancelled escalation could hit a reused descendant pid — SIGKILL now re-checks each pid's start time.
- Round 4 BLOCKED: `lstart` has one-second precision — the identity is now start second plus command name.
- Round 5 **CLEAN** ("No blocking defect found in the round 5 identity guard or the staged fail-fast integration"); its minor note (comments said "never") is fixed in wording.
The reviewer confirmed in rounds 1-5 that the shared re-run budget stays atomic, that a stopped lane can never produce success, and that the re-run relaxation adds no eligibility bypass beyond the documented static-import blind spot.

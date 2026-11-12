# Side effects: deadline forensics and a sibling stop at a lane deadline

**Tier:** 1 (verifier diagnostics plus slot release; no verdict rule changes) · **Author:** Echo · **Source:** daily throughput brainstorm 2026-11-12, experiment E2 (Fable 5.2 and GPT-6 Astra both ranked it first).

## What changes

1. `src/localVerify/unhandledErrorsReporter.ts` (the trusted reporter the verifier already loads into every lane from its own dist): adds `onInit`/`onTaskUpdate`. When `LOCAL_VERIFY_PROGRESS_FILE` is set, it keeps the set of test files started and not yet finished and writes a bounded snapshot (oldest 10, throttled to one write per 5 s, atomic rename) to that file. New `readProgress()` parses it, makes paths relative to the run dir, caps each path at 200 chars, and returns null for anything malformed.
2. `src/localVerify/orchestrator.ts`, `runLane`:
   - each lane shard gets `LOCAL_VERIFY_PROGRESS_FILE=<reportsDir>/<key>.progress.json` when the reporter is present;
   - on a `deadline:<lane>` RunError it logs `deadline-in-flight` (files still running, seconds each, files finished, or `unknown: true`), aborts the run's lane controller (`lanes-stop`, `reason: 'deadline'`), and rethrows the same step with the running files in the detail (so they reach `run-finished.reasons`);
   - the lane controller's signal is now passed to every lane and isolation re-run, not only under fail-fast. It is still aborted for a real failure only under fail-fast and never for a `main` verify; the new abort is only on a deadline, after which the run is an error whatever the siblings do.

## Side effects

- **Verdicts:** none change. A deadline was already a run error (`firstError` is rethrown after `allSettled`); stopping siblings only ends work whose result could not be used. A `main` verify that hits a deadline now also stops its other lanes; it was already an error.
- **Lost by stopping early:** the sibling lanes' per-file durations (`observed`) for that run are not written, so the next balanced shard plan has slightly older history. Their reports were never used for an errored run.
- **Slot:** released up to the remaining sibling time sooner (11 min on PR 3090, 2026-11-12 15:07Z→15:19Z).
- **Trust:** the progress file is written by test-side code (the reporter runs in the vitest process, like the existing unhandled-errors file) and could be forged by a PR's tests. It only names files in a log line and an error reason; it never decides an outcome. Length and count are bounded.
- **Signal vs authority:** no decision point is added; the progress snapshot is a signal recorded for a human/agent reader.
- **Performance:** one small JSON write at most every 5 s per lane process.
- **Multi-machine:** both machines run the same orchestrator from their installed dist; a peer run writes the same events to its own run log. No replicated state.
- **Rollback:** revert the commit; no state or config migration.

## Not in this change

The second half of E2, holding a timed-out head instead of re-running it unchanged at the front of the queue, needs a choice about where the re-run goes (the other machine, or after a config change). It is tracked in `.instar/state/throughput-brainstorm/2026-11-12/decision.md` and the run state for topic 130715.

## Part 2: re-arm the `main` verify after a green PR run

- `src/localVerify/mainHealth.ts`: new pure `decideMainRearmAfterGreen` (true only when `main` is neither healthy nor red, nothing `main` is queued or running, and that head's error retries are spent).
- `src/localVerify/LocalVerifyService.ts`: after a PR run completes `success` on this machine, `rearmMainAfterGreen` resets the current head's error-retry count (the release alias resolved) and queues one `main` verify (`main-retry-rearmed-after-green` audit).
- **Why:** `decideMainErrorRetry` stops after 3 retries per head; nothing else re-queues that head, so `main` stayed unverified, main health went `main-suspect`, and `GreenPrAutoMerger` requests no verify while main is not healthy. Live: four `deadline:*` errors on main `51d2c432` ended at 12:34Z on 2026-11-12, after which no PR was offered automatically and waiters (3085, 3088, 3094, 3110) were never re-offered.
- **Bound (No Unbounded Loops):** each green PR run re-arms at most one `main` verify; the always-erroring model in `local-verify-main-schedule` (no PR successes) still emits 1 + 3 verifies, horizon-independent. The convergence ratchet passes unchanged.
- **Cost:** one extra `main` run per green PR run while `main` is wedged (main runs at priority 100, ahead of PRs). Once `main` goes green the condition is false.
- **Trigger reach:** the trigger is a green PR run on this machine (peer-imported results do not count). While `main` is unhealthy the watcher offers nothing, so the chain starts only from PRs already queued or requested explicitly; on 2026-11-12 13 PRs were queued, so it fires. A fully idle wedged queue still needs one explicit request or a restart.
- **Signal vs authority:** no gate changes; the watcher still requires a healthy `main` before offering PRs.
- **Rollback:** revert; in-memory counters only, no state migration.

## Part 3: a per-machine unit-lane worker count

- `monitoring.localVerify.laneShards.unitWorkers` (integer 1..12, read at each start like the shard counts; anything else is ignored) sets `INSTAR_TEST_WORKERS` for the unit lane. Absent ⇒ `LOCAL_VERIFY_LIMITS.unitWorkersParallel` (4), as before.
- **Why:** throughput brainstorm 2026-11-12 E3. The M5 sampler showed 45–90 % idle with no swapping while its 4-worker unit lane hit 1200 s; its two latest attempts for PR 3093 both ended `deadline:unit`.
- **Verdicts:** unchanged. The worker count never changes which files run; the inventory rule still requires every file. Like the shard counts, it is a machine setting outside `policyHash` (both shard and worker counts are scheduling, not policy).
- **Peer runs:** a peer builds its run input from its own config (`peerRun` → `start`), so each machine's setting applies to the runs it executes.
- **Risk:** more parallel unit workers can expose load-sensitive tests (five such first-try failures on 2026-11-11). It is opt-in per machine and will be tried on the M5 first, one variable at a time.
- **Agent awareness:** the CLAUDE.md laneShards line is not rewritten for existing agents (its migration inserts only when absent); the upgrade note carries the key.

## Second-pass review

**Reviewer:** independent Claude Sonnet subagent (fresh context, given the staged diff and the files, not the author's conclusion), 2026-11-12 07:51 PST

**Verdict: CONCUR.** No must-fix items.
- No verdict changes: the abort fires only on a fail-fast failure (never for `main`) or a `deadline:` RunError; the deadline rejection still decides the run as `error`.
- vitest 2.1.9 reporter API use is correct (packs `[id, result, meta]`, file tasks in `state.idMap` carry `filepath`); every callback path is guarded. A file finished in the last 5 s may still show as running (throttle); accepted.
- No hung processes or promises: shards are `allSettled`, the slot is released in `finally`.
- It suggested a size cap before parsing the test-written progress file; applied (64 KiB, like the durations file) with a test.

**Part 2 reviewer:** independent Claude Sonnet subagent (fresh context, given the diff and the code paths, not the author's conclusion), 2026-11-12 08:18 PST

**Verdict: CONCUR.** No must-fix items.
- No self-trigger (main runs are excluded), no duplicate main entries (pending/in-flight checked, `decideMainEnqueue` dedupes); the release alias key matches what `completeMain` records.
- `main-red` and `healthy` excluded, so the red hold keeps the red case; peer results do not trigger.
- Notes taken: the bound is per green PR run (now stated in the `local-verify-main-schedule` model comment); the trigger needs a queued or explicit PR while main is unhealthy (stated above).

**Part 3 reviewer:** independent Claude Sonnet subagent (fresh context), 2026-11-12 08:27 PST. **Verdict: CONCUR.** Worker count reaches only `resolveUnitLaneWorkers`/`maxWorkers`, never file selection; keeping it out of `policyHash` is right (a hardware tunable, not policy); peer input comes from the executing machine's config. Notes applied: the effective count is logged per run (`unit-workers` event), and the `laneShards` doc comment names the new key. Noted: a nested test-runner clamp (pool max 4) applies only under an ancestor semaphore holder, which verify lanes do not set.

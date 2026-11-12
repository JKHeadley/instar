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

## Second-pass review

**Reviewer:** independent Claude Sonnet subagent (fresh context, given the staged diff and the files, not the author's conclusion), 2026-11-12 07:51 PST

**Verdict: CONCUR.** No must-fix items.
- No verdict changes: the abort fires only on a fail-fast failure (never for `main`) or a `deadline:` RunError; the deadline rejection still decides the run as `error`.
- vitest 2.1.9 reporter API use is correct (packs `[id, result, meta]`, file tasks in `state.idMap` carry `filepath`); every callback path is guarded. A file finished in the last 5 s may still show as running (throttle); accepted.
- No hung processes or promises: shards are `allSettled`, the slot is released in `finally`.
- It suggested a size cap before parsing the test-written progress file; applied (64 KiB, like the durations file) with a test.

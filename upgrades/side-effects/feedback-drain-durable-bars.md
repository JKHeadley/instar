# Side-Effects Review — feedback drain: durable fleet bars and a busy-server skip (CMT-1613)

**Version / slug:** `feedback-drain-durable-bars`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1 (a revert fully undoes it; no data migration; the drain stays dev-agent only). Size: about 10 source/test files, ~300 lines. Effort: one design pass, no spec review rounds.

The feedback drain's fleet rung (`src/data/feature-ladders.json`) replaces the trivially passable `completed-drain-runs` bar (≥1 run, 1 sample, 1 day, read from the last run only) with: `finished-drain-runs` (ran, ≥200 finished runs in 7 days, projection `feedback-factory.finished-runs-7d`), `drain-run-success-share` (quality, ≥0.97 over ≥200 finished runs, projection `feedback-factory.run-success-share-7d`; both read the durable `drain_runs` table via `FeedbackDrainStore.runOutcomes`), and `merged-feedback-prs` (quality, ≥3 `execute:merged` rows with `elsewhere:false` in 30 days from `.instar/logs/feedback-triage.jsonl`, samples = PRs opened). The `readiness-error-rate` harm bar is unchanged.

The job `feedback-factory-process` (both the Python body that runs under the session runner and the `.mjs` script port) now retries its first status read on timeout (10 s, 20 s, 30 s with 5 s and 10 s pauses). Three timeouts end the run as **skipped** (`status-busy`), not failed. For session-run jobs, a new per-run `$INSTAR_JOB_SKIP_FILE` (sibling of `$INSTAR_JOB_FAILURE_FILE`, set by `SessionManager`, read by `JobScheduler.notifyJobComplete` via `readJobDeclaredSkip`) records the run `skipped`; a declared failure wins. `scriptTimeoutMinutes` 4 → 5 to fit the longer worst case.

## Decision-point inventory

- `feedbackFactory.drain` fleet-rung readiness (MaturationLadder) — modify — stricter bars; the ladder remains a signal feeding a code-kind advance (`advance.kind: code`), nobody's authority changes.
- `feedback-factory-process` job outcome classification — modify — a status timeout ×3 becomes `skipped` instead of `failed`.
- `JobScheduler.notifyJobComplete` result — modify — honours a declared skip.

---

## 1. Over-block

No block/allow surface on messages or actions. On the ladder, the new bars can hold the drain at its current rung longer than before: no fix PR has merged at its approved head yet, so `merged-feedback-prs` reads 0 and the drain will hold. That is the intended effect (both reviewers refused the move on exactly this ground).

## 2. Under-block

- A server that is busy for minutes still skips rather than fails. The skip cannot inflate the bar: no drain run starts, so it adds nothing to the 200-run minimum (336 cadence slots per 7 days at 30-minute intervals), and a mostly-busy server keeps the drain below the minimum.
- A spec PR merged by the executor counts toward `merged-feedback-prs` alongside fix PRs: the merged audit row carries no kind, and the execution state at merge time (`merge-armed`) is shared. Accepted: a merged spec from a drained cluster is still a cluster reaching merged work, and the threshold is small.
- The "still in flight after 180 s" job failure is unchanged (one run on Nov 11); it is a real slow run, not a reachability fault.

## 3. Level-of-abstraction fit

The success share is read where the truth lives (the drain's own durable run table), not from job history (whose `.instar/ledger` path is outside the ladder's allowed evidence folders, and which mixes in job-level reachability). The skip file reuses the existing declared-failure pattern one level down rather than adding a new channel. The retry is in the job, the only caller that sees its own server's timeouts.

## 4. Signal vs authority compliance

Complies. The ladder metrics are signals evaluated by the maturation service; the move itself stays `advance.kind: code`. The job's skip/fail classification is bookkeeping of its own run, with no authority over other components.

## 4b. Judgment-point check

No competing-signals decision point is added. The retry schedule is a fixed bound on waiting for a reply, not a judgment.

## 5. Interactions

- `JobRunHistory` already supports `skipped` and excludes it from success-rate stats; `JobState.lastResult` already allows `skipped`.
- Consecutive-failure alerts read `consecutiveFailures`: a skip leaves it unchanged (neither resets nor increments) and keeps `lastError`, so a busy spell between two real failures cannot hide the streak.
- A skip on the session path does not clear a pending failure alert, does not write the silence-watch success marker (`noteContinuitySuccess`), and is not sent to the Jev completion audit — the same rules as the script runner's skip. The claim is released as `success` (as the script runner does), and the run summary says "Skipped".
- `JobResultTriage` bare-skip list for the script port gains `status-busy`.
- The old `feedback-factory.completed-runs` projection stays registered and on the allowlist; no ladder entry uses it any more. Harmless.
- Shared job-script harness: `sharedContractCases` gains an optional `timeoutExitCode`; other scripts' defaults are unchanged.

## 6. External surfaces

`GET /maturation/ladder` shows the new bars for `feedbackFactory.drain`. Job history shows `skipped` with "Declared skip: server too busy…" instead of failure rows. Every session-run job's tmux env gains `INSTAR_JOB_SKIP_FILE`; only this job's body writes it. Not added to the CLAUDE.md awareness bullet: it is an internal hook for shipped job bodies, not an agent-facing capability.

## 6b. Operator-surface quality

No operator surface touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. The drain runs on its owner machine (ticks on other machines are proxied, and the job already reports `proxied` as success there); `drain_runs` lives in that machine's drain database and the ladder reads it there. The triage audit log is written where the executor runs, which is the same owner machine. Skip files are per-run, per-machine, like failure files.

**Status surfaces:** `GET /maturation/ladder` (changed bars); `GET /jobs/feedback-factory-process/history` (new `skipped` rows). No new route.

## 8. Rollback cost

Revert the PR. No data migration: `runOutcomes` only reads; the skip file is consumed per run; reverted job bodies are reinstalled by the normal built-in job refresh on update.

## Conclusion

Ships. The bar is stricter and durable, the job's record is honest, and the drain's posture (dev agent only) does not change.

## Second-pass review (if required)

Not strictly required (no message gate, session lifecycle or guard), but run because the scheduler outcome path changed.

**Reviewer:** independent general-purpose subagent (read the diff and this artifact cold).
**Independent read of the artifact: concern** — two findings, both fixed before commit:
1. A skipped session-run job still cleared the failure alert, fed the silence watch, went to the Jev audit as a success, and wiped `lastError`. Fixed: gated on `!failed && !skipped`, Jev capture skipped, `lastError` kept; test `a declared skip keeps the last error and never clears failure alerts or feeds the silence watch` (fails without the gate, verified by mutation).
2. The share was a `ran` metric, so a real 0% share read as "no data" instead of "hold". Fixed: `ran` is now the finished-run count; the share is `quality`; the share projection returns null with no finished runs. Test runs `computeLadderState` on the real registry entry: 0% over 250 runs → hold; 120 runs → hold; no merges → hold; good numbers → ready.
Other areas the reviewer checked and found sound: Python retry/for-else and timeout classification, script port parity, failure-over-skip precedence, the JSONL merged-PR reader, worst-case durations (~275 s against 300 s).

## Evidence pointers

- `tests/unit/feedback-drain-fleet-bars.test.ts` — registry bars, real audit-row shape counted through the real JSONL reader, projection wiring.
- `tests/unit/feedback-drain-store.test.ts` — `runOutcomes` window, success states, in-flight excluded.
- `tests/unit/job-declared-failure.test.ts` — skip file path, read-once, independent of the failure file.
- `tests/unit/job-scripts/feedback-factory-process.test.ts` — three timeouts → `skipped status-busy` with no tick; one timeout then answer → normal run; refused connection still fails.
- `tests/integration/feedback-factory-process-job-body.test.ts` — the installed Python body against a hanging server: skip file written, no failure, no tick; one hang then success.
- Live numbers (Echo, Nov 11): `drain_runs` last 7 days = 253 succeeded, 2 no-op, 2 abandoned; job history Nov 11 = 9 of 38 failed, all but one "drain status unreadable: HTTP unreachable (timeout)"; `GET /feedback-factory/drain/status` took 2.5 s at a quiet moment.

**Re-check after the fixes (same reviewer, code read):** Concur with the review. Both fixes hold; the claim released as `success` and reflection receiving `failed=false` on a skip match the script runner and are harmless. No new findings.

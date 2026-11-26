# Side-Effects Review — local-verify flake isolation, main run-detail, fair share

**Version / slug:** `local-verify-flake-isolation`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent, two rounds — concur (see below)`

## Summary of the change

Live runs on 2026-10-22: the server's first two `main` verifies (916b3a8, 312d175) each failed exactly one file (`tests/e2e/stop-gate-breaker-restart-lifecycle.test.ts`, `tests/integration/account-follow-me-submit-code-route.test.ts`) that passes 3/3 alone and passed in every PR verify; because `main` moves often, each new head's first failure re-entered `main-suspect`, so one flake per run kept `main` suspect and the watcher requested no PR verifies. A `main` verify also logged only `main-record outcome:failure` (ACT-151). Separately, `main` verifies (every merge and every release) were starving PR verifies of the single slot.

Changes:
- `src/localVerify/orchestrator.ts` — the inventory is computed before the lanes; after each lane, `decideIsolationRerun` (pure, `laneReport.ts`) picks 1–3 failed files when that is the lane's only problem, and `isolationRerun` re-runs each once, alone, with the lane's config/env/flags, under the remaining lane budget (cap 3 per verify, `LOCAL_VERIFY_LIMITS.isolationRerunMaxFiles`). Passing files replace their counts and go into `record.flakyRetried`; failing ones keep the first counts and carry `rerunMessage`.
- `src/localVerify/record.ts` — optional `flakyRetried` (validated, bounded).
- `src/localVerify/LocalVerifyService.ts` — `runDetail()` for PR and main verifies; `noteFlaky()` (one signal per file per process, `local-verify:flaky:<file>`; counts seeded from the journal at boot without signalling); `flakyFiles()`; fair share in `decideStart` (`fairShare` input, `MAIN_FAIR_SHARE_MS` = 2 h) fed by `lastMainFinishedAt` / `lastStartWasMain`; release collapse via a new `commitInfo` seam and `releaseCollapsesInto` (`mainHealth.ts`).
- `src/localVerify/mainHealth.ts` — `onVerify` takes the run-detail and puts it on `local-verify:main-red`; `releaseCollapsesInto`.
- `src/localVerify/localVerifyRoutes.ts` — `flakyFiles` on `GET /local-verify/status`; `serviceSeams.ts` — `commitInfo` via `gh api repos/<repo>/commits/<sha>`.
- `src/testing/selfActionRegistry.ts` — models `local-verify-flake-rerun`, `local-verify-main-fair-share`.
- Spec Throughput budget section records both rules.

## Second-pass fixes (round 1)

Each has a test that fails without it (checked by removing each guard):

1. **Order-dependent failures stay failures.** On a PR verify a failed file is never isolation-re-run (reason `related-to-change`) when the PR changed it, when it imports a file the PR changed (static relative-import scan through `localImportGraph`, the verifier-version helper), when this machine has no green `main` record, or when that record shows the file was not clean there. The changed-file list is computed before the lanes (merge-base→head); unreadable ⇒ no re-run. The last green `main` record (head, finish, files not clean) is kept in `state/local-verify/flaky-history.json` and passed to PR verifies as `input.isolation`. `main` verifies keep the plain rule. Limit, stated: "passed on the last green main" is inferred from the record (a green main means every inventoried file passed, minus its `flakyRetried`), not a per-file list; a test file added to `main` after that green verify and not changed by the PR is treated as having passed.
2. **Unhandled errors are never hidden.** vitest's JSON reporter carries no unhandled errors and vitest exits 1 for both cases, so a trusted reporter (`src/localVerify/unhandledErrorsReporter.ts`, loaded by absolute path from the installed dist, part of the verifier-version graph) writes each lane's and each re-run's unhandled-error count. Any unhandled error, or an unknown count (no reporter), means no re-run; the lane's exit code is cleared only when its failed files all passed alone AND the lane had zero unhandled errors; a re-run passes only with zero unhandled errors of its own.
3. **Fresh `TMPDIR`/`TMUX_TMPDIR` per re-run** (the short `/tmp` root via the existing `mkdtemp` seam), cleaned up with the run's temp dirs.
4. **Fair share by unverified age.** Healthy `main` goes ahead of waiting PRs once its oldest unverified merge is ≥ 90 min old (`MAIN_FAIR_SHARE_MS`); before that PRs go first. The convergence model asserts the oldest unverified merge never waits past 3 h. Suspect/red alternation unchanged.
5. **Release skip is narrower.** The release commit's diff against its parent must touch only `package-lock.json`, `pnpm-lock.yaml`, `CHANGELOG*`, `upgrades/**`, and a root or workspace `package.json` whose GitHub `patch` changes nothing but its `"version"` line (a missing patch, which GitHub omits for large diffs, is not release-only); the parent must be a head this machine holds a `main` record for (or has queued/running); an unknown or ≥ 300-file list ⇒ verify. Deviation, stated: the file list comes from GitHub's commit API (already read for subject and parents), not from the bare clone, because the server process does no synchronous git and the bare clone is not guaranteed to hold the new commit yet.
6. **Repeat flakes escalate.** A file re-run-passed ≥ 3 times within 7 days re-raises its item as a new episode (`local-verify:flaky:<file>:repeat-<date>`, with the count), at most once per 7-day window per file (`decideFlakyEscalation`, history in `flaky-history.json`, registered as `local-verify-flaky`).

## Decision-point inventory

- `decideIsolationRerun` — add — whether a lane's failed files are re-run (1..3, only problem, budget left).
- `isolationRerun` outcome → lane pass/fail — add — a re-run pass replaces the file's counts.
- `decideStart` — modify — optional fair-share inputs; without them the order is unchanged (existing models still drive it that way).
- `releaseCollapsesInto` — add — a release commit of a covered parent enqueues no `main` verify.
- `decideIsolationRerun` ineligible / unhandled-error inputs — add — related-to-change and unhandled-errors refusals.
- `decideFlakyEscalation` — add — repeat-flake episode.
- `MainHealth.onVerify` — pass-through — semantics unchanged; it only receives post-re-run outcomes and now a detail payload.

---

## 1. Over-block

No new refusal: the re-run can only turn a failing lane into a passing one, or leave it failing; fair share reorders starts, it never drops one; release collapse skips a verify of a commit whose parent is covered.

## 2. Under-block

- **A genuinely intermittent product bug can pass on its re-run.** That is the trade the spec's known-flaky lane already made; here every such pass is recorded in the record, audited, and raises one tracked attention item per file, so it is visible rather than silently quarantined. A file flaky in 2 of 3 runs still has a 1-in-3 chance per verify of being recorded flaky instead of failing.
- More than 3 failed files is treated as a real break; 3 coincident flakes plus a real failure (4 files) fails — the safe direction.
- A dirty tree, a file-not-run or a zero-collected file disables the re-run for that lane; the dirty-tree check still runs after all lanes.
- Release collapse trusts GitHub's commit subject, parents and file list; an unreadable commit, a non-release file, or a parent with no record here verifies as usual.
- Flaky signal dedupe is per process; across restarts the attention item id (the key) dedupes.

## 3. Level-of-abstraction fit

The re-run sits in the orchestrator, where the lane's config, env, worktree and budget already are, and it reuses vitest's own report parsing; it is the per-run form of the spec's advisory known-flaky lane rather than a parallel mechanism. Fair share lives in the existing pure start decision, not in a new scheduler.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The verdict authority (evaluateRun + the §3 predicate) is unchanged; the re-run supplies evidence it judges. Flaky items are signals into the attention queue.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The re-run rule is enumerable (count of failed files, presence of other failure reasons, budget). The fair-share window (2 h) and the every-other rule are deterministic scheduling bounds declared in the spec and proven by the convergence model.

## 5. Interactions

- **Main health:** unchanged state machine; a pure flake no longer reaches it. Its own one-re-run-before-red rule still applies to failures that survive the isolation re-run (so a red `main` now means two full runs each with a failure that also failed alone).
- **Single-flight / test-runner bound:** re-runs are 1-file vitest runs inside the same lane window; they acquire the targeted lane of the host bound, not a second suite slot.
- **Self-action:** both new loops are bounded and modelled (`local-verify-flake-rerun`: ≤ 3 per verify, each file once; `local-verify-main-fair-share`: main starts ≥ 2 h apart while PRs wait, never twice in a row).
- **Restart hold:** a re-run extends a verify by at most its remaining lane budget, inside the existing hold ceiling.

## 6. External surfaces

- New attention items `local-verify:flaky:<file>` (MEDIUM), one per flaky file.
- `GET /local-verify/status` and `GET /local-verify` gain `flakyFiles`.
- New read-only GitHub call per new `main` head (`gh api repos/<repo>/commits/<sha>`).
- Records gain optional `flakyRetried`; `verifierVersion` changes (verifier code changed), so existing records re-verify once.
- No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design, like the rest of local-verify: the verify, its records and the flaky counts belong to the lease holder's own runs; attention items are raised by the machine that ran the verify. No URLs.

## 8. Rollback cost

Pure code change. Reverting removes the re-run (a flake again fails the lane), the fair share (main first again) and the release collapse. Records carrying `flakyRetried` validate as optional under both versions. No migration.

## Conclusion

Each requested behaviour has a test that fails without it (checked by removing each guard: fair share, the re-run, its deadline cap, its per-verify cap, flaky dedupe, main run-detail, release collapse). Clear to ship after the second-pass review.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (two rounds)
**Independent read of the artifact: concur (after fixes)**

Round 1 raised: an order-dependent failure a PR introduces could pass its isolation re-run and merge (now a PR verify never re-runs a file the PR changed or that imports a changed file, nor without a green main record on which the file was clean); an unhandled error could be hidden by the forced exit-code reset (now counted by a trusted reporter and blocking); re-runs reused the lane's TMPDIR (now fresh); the 2-hour fair-share window could push healthy main past the 3-hour unverified threshold (now decided from the oldest unverified merge's age, ≥90 min); the release skip trusted the subject line (now requires a release-only diff and a parent with a record; a root/workspace package.json counts only if just the "version" line changed); repeat flakes were silent after the first item (now a new episode at ≥3 in 7 days). Round 2 verified every fix and concurred; residual: a leak through a module the failing file does not import is still invisible to the import check, and main verifies have no exclusion — that would show as a repeat-flake episode.

## Evidence pointers

`tests/unit/localVerify/orchestrator.test.ts` (describe `isolation re-run of failed files`), `tests/unit/localVerify/mainHealth.test.ts` (describes `flaky files, main run-detail`, `fair share`, `release commits collapse`), `tests/unit/self-action-convergence.test.ts`, `tests/integration/local-verify-routes.test.ts` (`flakyFiles`).

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (two new self-triggered loops: the isolation re-run and the fair-share start order).
- **`closure`** — `guard`
- **`guardEvidence`** — `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (local-verify-flake-rerun, local-verify-main-fair-share), howCaught: the models drive the same decideIsolationRerun / decideStart functions under worst-case pressure — every lane failing two files with every re-run failing (≤ 3 re-runs per verify, perTarget 1), and a new main head before every start with PRs always waiting (main starts floored at 2 h, never two in a row) — so an unbounded re-run or a main-only slot fails the ratchet}`.

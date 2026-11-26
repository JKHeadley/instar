# Side-Effects Review — pre-push smoke listing timeout + host-tunable test wait budget

**Version / slug:** `pre-push-smoke-list-timeout`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see bottom)`

## Summary of the change

Four small changes to the test-runner bound and the pre-push smoke tier, all found by the 24h run on the Mama PC after the bound was switched to enforcing:

1. `tests/setup/build-dist.globalSetup.ts` returns early for `vitest list` (no test executes, so no `dist/` is needed). This removed a full `tsc` from every affected-test listing.
2. `scripts/pre-push-smoke.mjs` lists file names first (`vitest list --filesOnly`, parsed by the new `summarizeVitestFilesOnlyJson` in `scripts/lib/pre-push-scope.mjs`), applies the existing 80-file cap, and only then runs the full listing that collects test cases. The listing-failure handling (timeout → indeterminate skip, non-zero → fail, unparseable → refuse) is shared by both stages unchanged.
3. `tests/setup/test-runner-semaphore.globalSetup.ts` routes the `push` config to the targeted lane when its RESOLVED pool bound is ≤4 and no pool-shaping argv is present (same state check the unit-config targeted route uses).
4. `src/core/hostTestRunnerSemaphore.ts`: `resolveAcquireBudgetMs` takes the tuning file; suite-lane budget resolves env → tuning `acquireMs` / `acquireMsInteractive` (range 10 s..4 h) → default 45 min (was 2 min; interactive was 5×). The template and an idempotent in-place migration update the one CLAUDE.md line that stated the old 10-min budget.

## Decision-point inventory

- Host test-runner bound, lane selection — modify — the push config moves from the cap-1 suite lane to the cap-6 targeted lane when it runs one worker.
- Host test-runner bound, wait budget — modify — longer default, new host-wide tuning source.
- Pre-push smoke "too broad / run / skip" selection — modify — breadth now decided from a files-only listing before the full listing.

---

## 1. Over-block

The longer wait budget blocks nothing new; it turns a fail-after-2-min into a wait. The only new "block" shape: a run now waits up to 45 min where it used to fail at 2 min (10 interactive). A caller with a shorter outer timeout kills its own waiting run; the template line says so. No legitimate input is newly rejected.

---

## 2. Under-block

- A push run of the whole push tier (`npm run test:push`, one worker, many files) now also takes the targeted lane. It is still one worker, so the bound's resource purpose (worker count) holds: at most 6 such single-worker runs plus their ≤4-worker peers. It no longer serializes against full suites. Accepted: the 2026-07-02 storm was hundreds of workers, which this cannot produce.
- A change reaching more than 80 test files still skips the local smoke tier ("too broad"). That is the existing design and is reported separately, not changed here.
- Nested test runs remain admitted without a ticket (`nested-skip`, queue item 11). Unchanged; filed to the feedback queue.

---

## 3. Level-of-abstraction fit

Each fix sits where its cause is: the dist build belongs to running tests, so the list exemption is in the build setup; breadth is a smoke-script decision, so the two-stage listing is in the smoke script; lane choice is the chokepoint's job and uses the same resolved-pool-bound state check it already uses. The budget lives with the other host-uniform levers in the tuning file.

---

## 4. Signal vs authority compliance

The bound is a capacity limiter, not a judgment gate; its decisions are mechanical (counts, worker bounds) and fail open on internal error. This change keeps that: lane choice is by measured state, never by name alone, and the budget only changes how long a waiter waits. No brittle check gains blocking authority. Reference: `docs/signal-vs-authority.md`.

---

## 5. Interactions

- The re-entrancy check is lane-scoped. A push run in the targeted lane nested under a process holding a targeted slot skips as nested, which was already true for unit targeted runs.
- `INSTAR_HOST_TEST_ACQUIRE_MS*` env values still win over the tuning file, so existing exports keep their meaning except that interactive no longer defaults to 5× the env background value (it defaults to the background value). No in-repo caller sets these.
- The tuning-baseline hash will report a "tuning changed" WARN once if an operator adds the new fields; that is intended visibility.
- The watchdog test-runner floor is unaffected (it keys on process shape, not lane).

---

## 6. External surfaces

Developer-machine behavior only: `git push` in the instar repo, and any vitest run under the bound. No user-facing runtime, route, or message changes. The tuning-file field set grows by two optional fields; older readers ignore unknown fields (tolerant-reader rule, spec §2.9). `GET /test-runner-limiter` shape unchanged.

---

## 7. Multi-machine posture

Machine-local by design: the bound and its tuning file are per host (`~/.instar/`), as the spec already states. Each of the four machines resolves its own budget; the new fields can be set per host or left at the default.

---

## 8. Rollback cost

Revert the commit; no state migration. A host can restore the old timing immediately with `INSTAR_HOST_TEST_ACQUIRE_MS=120000` or `acquireMs: 120000` in its tuning file. The CLAUDE.md line replacement is text only.

## Second-pass review

**Reviewer:** independent second-pass (instar-dev Phase 5), 2026-10-22.

**Verdict: Concur with the review.**

Checked:
- **Smoke control flow.** Every exit 0 is a skip (breadth cap, indeterminate listing) or a genuine empty affected set; stage 1 reports 0 files only when the files-only listing parsed cleanly, and stage 2 still runs the full listing + `evaluateAffectedSmokeSelection` before any run. No path reports a pass without running tests that were selected. Listing failures keep the shared fail / indeterminate-skip / refuse-on-unparseable handling.
- **`--filesOnly` honors `--changed`.** Measured on vitest 2.1.9 in this worktree: `list --filesOnly --config vitest.push.config.ts --changed HEAD~1` → 876 files vs 3495 unfiltered, in ~34 s. Output entries are `{ "file": <absolute path> }` only, which `summarizeVitestFilesOnlyJson` accepts (extra keys such as a project name would also pass).
- **build-dist list skip.** `analyzeVitestArgv` sets `isList` only when `list` is the first token after the vitest script; `vitest run`/bare `vitest` stay false, and an unrecognised argv shape (script token not found) also yields false, so the build still runs. Same classifier the semaphore setup already uses for its list no-op.
- **Push → targeted lane.** Gated on resolved pool bound ≤4 (push config's `fileParallelism:false` → 1) and no pool-shaping argv, so worker count per holder stays 1; re-entrancy is lane-scoped as before. Holder TTL (1 h default) is lane-independent, unchanged.
- **Migration.** Append path writes the new line; replace path fires only while the exact stale line is present. Idempotent.

Non-blocking notes:
1. A push now waits at most the targeted budget (60 s) and then fails loud if all 6 targeted slots are held, where it previously waited up to 10 min in the suite lane. The hook reports that as "Tests failed". Low likelihood (smoke runs are ≤80 files, 1 worker), and the CLAUDE.md line states the one-minute wait, but worth watching in `recentEvents`.
2. `INSTAR_PRE_PUSH_FULL=1` / `npm run test:push` (whole push tier, one worker, long hold) also takes a targeted slot, which can occupy targeted capacity for many minutes — already acknowledged in the review.
3. Interactive budget no longer defaults to 5× background: a host that exports only `INSTAR_HOST_TEST_ACQUIRE_MS` (e.g. 120000) now gives interactive runs that same value instead of 5×. Intentional given the 45 min default, but a silent semantic change for anyone relying on the env.

# Side-Effects Review — a red main is re-verified within minutes; the main-red hold covers a failing lint script

## Summary of the change

`decideMainHeadEnqueue` (`src/localVerify/mainHealth.ts`) gains `opts.healthy`; when it is `false` a newly observed `main` head is ready for its verify after 2 unchanged minutes, capped at 10 from the first unverified head (new `MAIN_VERIFY_LIMITS.unhealthyDebounceMs` / `unhealthyDebounceCapMs`), instead of 10 and 30. `LocalVerifyService.noteMainHead` passes `this.health.isHealthy()`. `mainFailureFromRunDetail` (`src/localVerify/mainRedHold.ts`) adds the repo script of a failed lint step (`lint-failed:node scripts/<path>`) to the failing files the main-red hold matches against, through a new pure helper `lintScriptFromReason`. Tests extended in `tests/unit/localVerify/mainHealth.test.ts`, `mainRedHold.test.ts` and `mainRedHoldService.test.ts`. One text string in `src/testing/selfActionRegistry.ts` (the `models` description of `local-verify-main-debounce`) is updated to describe the unhealthy path.

## Decision-point inventory

Two existing decision points get a wider input; none is added.

1. When a `main` verify is enqueued (timing only).
2. Which queued PR may take the next verify slot while `main` is suspect or red (the main-red hold, CMT-1033). It decides run order, never whether anything merges.

## 1. Over-block

The hold now also holds PRs while `main` fails a lint script. A PR that would repair it without touching the script or naming it in its title or body is held. The same limit already exists for failing test files; the ways out are unchanged: name the check in the PR text (re-read when the verify is requested again), a revert (always a candidate), or the kill switch `monitoring.localVerify.mainRedHold: false`. PR 3182, the real repair on 2026-11-15, named the script in its body and would have run.

No over-block on the timing change: it starts a verify sooner, it refuses nothing.

## 2. Under-block

- A lint failure whose reason is not `node scripts/<file>.{js,mjs,cjs}` (the type check, a shell pipeline, a command cut at the reason's 80-character limit before its extension) still holds nothing, so doomed runs continue for those. Deliberate: there is no name to match a repair against, and holding everything would leave no PR able to run as the repair.
- A stale read of an old head can still start one wasted verify of it in two narrow cases, both through the cap and both present before this change with the 30-minute cap: heads changing on every read for 10 minutes with a stale read at the moment the cap matures; or two stale reads of the same old head 10 or more minutes apart while `main` stays unhealthy (the first leaves `firstUnverifiedAt` set). A single stale read never does it (tests cover the single-read sequences). Cost: one verify of a superseded head.
- A red episode recorded before this release keeps `files: []` in its persisted detail; the hold engages at the next failed `main` verify, not retroactively.
- A repair that edits only a lint's baseline or data file and does not name the script in its title or body is held until its text names it (re-read on re-request), or a revert, or the kill switch.
- Neither change stops the merge that breaks `main`. That needs a re-check on the merge result before merging, which changes merge authority and has its own spec in progress. <!-- tracked: CMT-1793 -->

## 3. Level-of-abstraction fit

Both changes are inside the pure decision functions that already own these rules, with the service passing one more fact. No new component, route, config or state.

## 4. Signal vs authority compliance

No brittle detector gains authority. The hold is an existing deterministic rule over data the server already holds (the run's own reasons, the PR's file list and text); it orders runs and cannot block a merge. The timing rule reads the existing health state.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is added. Both are deterministic by design: the inputs are an enumerable health state and an exact string shape, and a wrong answer costs run order or one early verify, both self-correcting on the next pass.

## 5. Interactions

- `handled` still limits `decideMainHeadEnqueue` to one enqueue per head, so a head that failed is not re-enqueued by the new branch; the existing re-run-once and error-retry rules are untouched.
- `decideMainEnqueue` still keeps one pending `main` entry, lets a newer head replace it and never cancels a running one.
- An unknown-state suspect at boot or after a lease move was already verified at once through `mainObs.immediate`; that path is unchanged and still wins.
- The self-action model `local-verify-main-debounce` (`src/testing/selfActionRegistry.ts`) declares one head-changed verify per 10 minutes for a head that never settles. That model passes no health, so it does not exercise the new path, and its `models` text now says so: while `main` is suspect or red the floor between head-changed verifies is 2 minutes (a head that settles for 2 minutes and then moves), and a head that changes on every read is paced by the 10-minute cap (pure test: enqueues at minutes 11 and 22). Exposure is bounded by the single verify slot, one pending `main` entry, the every-other-start rule, and the fact that merging is closed while `main` is unhealthy, so heads move only when a repair or a release commit lands.
- With a short wait a repair and its release commit can both be seen before the repair is enqueued. The repair is then not in `covered`, so the release commit is verified itself: still one verify, and its tree contains the repair. If the repair's verify is already enqueued when the release commit appears, the existing collapse covers it (`covered` includes the pending or running head).
- While `main` is not healthy the fair-share rule in `decideStart` already alternates `main` and repair candidates; an earlier `main` verify takes the slot only when ordinary PR runs could not merge anyway.
- A script path joins `files` after the failing test files and under the same `maxFiles` cap; `messages` gets one fixed line for it. `failingFileNames` already strips `.mjs`/`.js` to form the stem and ignores stems shorter than six characters.

## 6. External surfaces

`GET /local-verify` `mainRedHold.failingFiles`, the hold reason text, and the `local-verify:main-red` signal detail can now list a `scripts/...` path beside test files. No route, schema or config key changes.

## 6b. Operator-surface quality

The existing hold notice reads "main is red on <files>; PR #N is already fixing it" and now names the lint script when that is what failed. No new surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, unchanged: the main-health watermark, the hold and the `main` verify schedule live on the machine that holds the serving lease (`local-verify-merge-authority`). A lease move enters `main-suspect` as before; its first head was already verified at once (`mainObs.immediate`), and later heads while it stays suspect now wait 2 minutes instead of 10. Nothing is replicated, no notice is added, no URL is generated.

## 8. Rollback cost

Revert the commit. No state or config to repair. The hold half can also be switched off live with the existing kill switch.

## Conclusion

Low risk and reversible. It shortens how long a broken `main` keeps merging closed (by 8 to 20 minutes per episode on shipped values) and stops doomed runs for the commonest unmatched failure shape, using rules that already exist.

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude), given the diff and the working tree, not the author's conclusions; read-only (no test run)

First read (the first version skipped the debounce entirely while `main` was unhealthy): "Concern raised": a single stale or flipped read of the previous head would immediately re-verify an already-failed head and could displace the pending repair verify; and the self-action model's declared 10-minute floor no longer held on that path. It also noted: a baseline-only repair is held until it names the script; a red episode recorded by the old code is not re-derived; no service-level test of the lint hold; no stale-read test.

Changes made in response: the unhealthy path now waits `unhealthyDebounceMs` (2 minutes unchanged) capped at `unhealthyDebounceCapMs` (10 minutes) instead of not waiting; pure tests added for the 2-minute wait, the repair / stale / repair read sequence, the cap under a never-settling head, and limits that are already shorter; service tests added for the repair head through a stale read and for the lint hold through the real service.

Second read: the stale-read claim holds for every interleaving on the debounce path; the cap arithmetic and all new tests are correct; nothing new is broken; the temporary local cadence patch (45/90) composes (`min` gives 2 and 10). "Concern raised": my revised texts claimed the 10-minute floor still held while unhealthy, but a head that settles for 2 minutes is enqueued each time, so the real floor there is 2 minutes. It also noted two narrow cap-path cases where a stale old head can still be enqueued (both pre-existing with the 30-minute cap) and one test name looser than its body.

Changes made in response: the constant's comment and the self-action model's `models` text now state the 2-minute floor on the unhealthy path and that the model does not exercise it; the test is renamed to say what it asserts; the two cap-path cases, the baseline-only repair and the old-episode limit are recorded under "Under-block" above. No code logic changed after the second read, only comments, one registry text string and a test name, so the reviewer's verdict on the logic stands: "the healthy path is unchanged", "(e) New breakage: none found".

Third read (the corrected texts): "My concern is resolved." It confirmed the source differs from the second-read version only in one comment, that the three corrected texts are true and that this section reports both earlier rounds accurately, and listed five wording notes (the release-commit sentence in section 5, a leftover "at once" in section 7, an unverified "re-read on each push" in section 1, "two passes a minute apart" in the constant's comment, the summary's file list), all corrected here. Final line: "Concur with the change".

## Evidence pointers

- Incident: `logs/local-verify.jsonl` 2026-11-15: `main-health` to `main-red` at 00:55:45Z with `reasons: ["lint-failed:node scripts/lint-framework-name-ratchet.mjs"]`; repair merged 01:12:59Z; `main-record` success 03:04:23Z only after a restart at 02:24Z; 21 PR records failed on that lint step between 00:31Z and 01:07Z.
- Tests: 78 pass in `tests/unit/localVerify/mainHealth.test.ts`, `mainRedHold.test.ts`, `mainRedHoldService.test.ts` (run 2026-11-15T04:04Z in the setup window between two Studio verifies; afterwards only comments, one text string and a test name changed).

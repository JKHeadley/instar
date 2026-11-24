# Side-Effects Review — Local Verify: run the test files most likely to fail first

**Version / slug:** `local-verify-likely-failing-first`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `pending`

## Summary of the change

For a verify of a pull request, each lane (unit, integration, end-to-end) can run a small first part before the rest: the change's own test files, the files it failed on in its previous verify, and the lane's files from a likely-failing list the coordinator keeps. The existing re-run-alone and fail-fast rules are then applied to that first part, so a failure in it ends the verify a couple of minutes after the lanes start. No test is removed and no verdict rule changes. It is off by default per machine (`monitoring.localVerify.likelyFailingFirst`: `off`, `on`, `alternate`).

Files: `src/localVerify/firstPart.ts` (selection, limits, the request field), `likelyFailingList.ts` (the list and its file), `firstPartTrial.ts` (assignment, comparison, counts, minutes per change), `orchestrator.ts` (the lane flow in two parts), `laneReport.ts` (a lane cut short; the cumulative failed-file count), `record.ts` (`rerunCutOff`), `peer.ts` (two request fields), `LocalVerifyService.ts` (list update in the completion path, run input, hand-off, the comparison run), `localVerifyWiring.ts` (the live setting), the state registry, the ladder registry, the self-action registry, one awareness entry.

## Decision-point inventory

- `Whether a verify fails` (`evaluateRun`, `decideIsolationRerun`, fail-fast in `runLane`) — modify — the same rules, consulted after a lane's first part as well as after the whole lane. `decideIsolationRerun` gains `priorFailed` so "more than 3 failed files" counts the lane's first-part failures when it judges the rest. `evaluateRun` gains a lane that is cut short with a report: its unrun files are stopped, not missing, and it can never be part of a pass.
- `Which files go in a first part` (`selectFirstPart`) — add — ordering only. Floor: only files of that lane that the verify runs anyway, inside the per-lane limit.
- `Whether the rest of a lane runs` (`runLane`) — add — it runs unless the lane has failed finally by the existing rules and fail-fast is on.
- `Whether a comparison run starts` (`startCompareIfDue`, `mayStartCompare`) — add — in `alternate` only, at most 5 finished and 10 started per kind per machine.
- `Whether the setting switches itself off` (`compareFirstPartRuns`, `switchFirstPartsOff`) — add — a brake, toward today's behaviour.
- `Peer request parsing` (`parsePeerRunRequest`) — modify — two optional fields; a malformed one refuses the whole request, as every other field does.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A change with two separate faults, the first in a first part, is recorded as failed on the first only and needs a second verify to show the second. That is the stated cost of ending early, the same as fail-fast between lanes today, and measure 5 of the trial watches it.
- A test that passes only when another file ran before it in the same process can fail when that other file is moved into the first part. The test `moving X into the first part makes Y fail only in the new order` shows it. It is a defect in the test, and the comparison run is there to find it; but until it is found, such a change is refused where it used to pass.
- A passing verify near a lane deadline can be pushed over it by the extra process start, and becomes an error. The lane deadline covers both parts.
- A peer request whose `likelyFailing` field is malformed is refused whole. The coordinator bounds the field before sending and leaves overlength paths out, so its own requests cannot be refused for it.
- The verdict check treats a verdict that differs with no file to explain it as a difference and switches the setting off. A dirty tree or an unhandled error in one run only would do that. The cost is the trial stopping on that machine until someone looks.

---

## 2. Under-block

**What failure modes does this still miss?**

- The list leans toward files it already holds: a verify that ends in a first part names only that part's failed files. The change's own files and its previous failures are the counterweight.
- The comparison run samples 15 verifies per machine, once. An order-dependent test that first appears later is not caught by it.
- A comparison run that ends as an infrastructure error concludes nothing and is not counted. If every comparison errors, 10 starts per kind are spent and the check ends without a verdict; the `first-part-compare` rows say so.
- If the real test runner ever stopped honouring `--exclude=<path>`, a first-part file would run twice. The lane report is then untrusted and the verify fails (tested), so this cannot produce a wrong pass, but every verify with first parts would fail until the switch is turned off.
- `rerunCutOff` marks only a re-run stopped by the run's stop signal. A re-run that hit the lane deadline is still counted as a failure, as today.
- A first part's re-run decision uses the first part's own unhandled-error count, as the spec states. So a rest that reported an unhandled error yet exited cleanly with no failed file would not cancel a re-run the first part already had; in one piece that lane would have had no re-run. It needs a broken reporter to occur (an unhandled error normally makes the process exit non-zero, which fails the lane either way).

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The choice of files is a cheap, deterministic ordering inside the run child, where the lane's file list, the changed paths and the recorded times already are. The verdict stays with the existing evaluator and the existing re-run rule; this change feeds them earlier and does not run beside them. The list is kept by the completion path, the single writer of records, so both machines' failures reach one list without a second writer. The focused preflight (which chose tests by asking the test runner what a change affects) is left as it is and is not reused.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The list and the selection decide order only. What fails a verify is the existing evaluator over real test results, with the existing re-run alone before anything is stopped. A wrong list means the old timing. The one new automatic action with authority, switching the setting off, moves toward today's behaviour and never toward a pass.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point?**

"Which files go in a first part" is declared in the spec's `## Decision points touched` as a judgment candidate with a floor (only files of that lane that the verify would run anyway, within the per-lane limit; a file left out still runs) and an arbiter (the change's own files, its previous failures, then the count of different pull requests a file failed for in 7 days). "Whether a verify fails" and "whether the rest of a lane runs" are invariants over an enumerable domain, tested over every combination of first-part and rest outcomes.

---

## 5. Interactions

- **Shadowing:** the first part runs before the lane's usual processes. Its failure, with fail-fast on, means the rest never runs, so a deadline the rest would have hit is never reached: the verify is recorded as failed, not as an error, and gets no automatic error retry. This is intended and tested.
- **Double-fire:** the re-run budget is one budget for the verify; first parts and the rest spend from the same counter with no await between reading and spending. The first part's and the rest's re-runs write differently named report files. The likely-failing list is updated once per recorded verify; a derived record (a copy for another pull request with the same head and base) is not counted.
- **Races:** the three lanes' first parts start together and share the stop signal, as lanes do today. A lane whose first part is clean checks the stop signal before starting its rest. The comparison run takes its own slot beside the in-flight slot: the pump starts nothing while it runs, and a peer answers `peer-busy`.
- **Feedback loops:** a file in the list goes first, fails early, and is counted again, so the list reinforces itself. That is the design's known bias. The bound is 7 days and 500 files, and ranking by different pull requests means one change cannot lift its own file.
- **Self-triggered actions and their brakes.** Three things here act on their own:
  - *The comparison run* (`startCompareIfDue`, controller `local-verify-first-part-compare`). It starts only in `alternate`, only after a verify that used first parts is recorded, one at a time. The count is written to `state/local-verify/first-part-trial.json` before the start: at most 5 finished and at most 10 started per kind, so at most 15 finished and 30 started per machine, once, across restarts. If the count cannot be written, nothing starts. A comparison that could not start within 30 minutes is dropped. It has its own kill bound (the run's total deadline plus 10 minutes), is ended by a server stop, and a marker file lets the next boot end one a dead server left behind.
  - *The setting switching itself off* (`switchFirstPartsOff`). Once: it is latched in the trial state file, writes `off` to the config when a writer is wired, and raises one notice. While latched, `alternate` reads as `off` on that machine whatever the config says, until the file is removed.
  - *The list update* (in `complete()`). Once per recorded verify of a pull request that failed with named files; never for a main verify or a derived record. It writes one file, bounded at 500 files of 40 entries (one per pull request per file).
  - *The group assignment* (in `request()`). Once per pull request, when it is first queued, whatever the setting: one small file write and one audit row. Bounded at 5000 remembered pull requests.
- **Busy while comparing:** a running comparison counts as busy everywhere a verify does: the leftover sweep does not treat this agent's run folders as idle (`localIdle`), the peer status reports `slotBusy`, and a failed-file diagnosis does not start beside it (`isDiagnosisCapacityBusy`). Without the first of these the sweep could end processes the comparison's tests started, fail a test only in the comparison, and switch the trial off with a false notice; found by the second-pass review and fixed in this change.
- **The comparison marker** is written before the child is spawned (without a group) and patched with the group right after, so a crash in between cannot leave an unreaped child; a marker that cannot be written means no child.
- **Restart holds:** a comparison run is not a verify in flight. It does not hold a planned restart; a restart ends it and it is not counted as compared.
- **Kept worktrees:** the comparison run uses its own checkout folder (a different 12-hex name from the same head) and never keeps a failed worktree, so the verify it follows keeps its own for diagnosis.

---

## 6. External surfaces

- **Other agents / install base:** off by default. With it off, the run input, the commands and the reports are what they were. Three things happen whatever the setting, stated together in the upgrade note:
  - the coordinator keeps the likely-failing list up to date (`likely-failing.json`, one `likely-failing-updated` audit row per change);
  - a record may carry `rerunCutOff`, in the rare case a re-run was cut off by another lane's failure;
  - the coordinator assigns each new pull request to a group when it is first queued, writing `first-part-groups.json` and one `first-part-assigned` audit row. Nothing reads the assignment while every machine's setting is off.
- **Two machines:** the verifier's version changes, so a coordinator and its peer must install together; until then the coordinator dispatches nothing to the peer (the existing version check). The peer request gains two optional fields; a peer on the old build would refuse a request that carries them, which the version check already prevents.
- **GitHub:** nothing new is posted. A verify that ends in a first part posts the same failed status as any failed verify.
- **Persistent state:** four files under `state/local-verify/` (the list, the assignments, the trial counts, the comparison marker), registered as one category in the state registry.
- **Timing:** a passing verify pays one more process start per lane and, on the two slower lanes, up to a minute of files run one at a time. Not measured yet; the trial's stop condition is one minute at the median.
- **Operator surface:** no operator-facing action is added. The setting is a config key the operating session sets conversationally; the notice on a difference is an attention item with plain words. `GET /local-verify` is a read surface.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard, approval page or form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- **`likely-failing.json`: machine-local BY DESIGN, unified by placement.** One list on the coordinator, built from every verify it records (its own and its peers'), sent to a peer with each hand-off. A peer never writes one (tested end to end). If the coordinator role moves, the new coordinator starts with its own list and rebuilds it.
- **`first-part-groups.json`: on the coordinator.** The assignment travels with each verify, so a pull request has one assignment on both machines. A new coordinator without the file draws again; each draw is an audit row.
- **`first-part-trial.json` and the setting: machine-local BY DESIGN.** Each run machine reads its own setting and counts its own comparisons, like `failFast` (operator-ratified exception in the Local Verify capacity spec, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17). The two machines may differ during the trial.
- **Notices:** one, on the machine where the difference was found, deduplicated by key. **URLs:** none. **Durable state on topic transfer:** none of it is topic-bound.
- **The trial's end report** is made by hand: the owner computes measure 5 with `minutesPerChange` (a tested pure function; no route or script calls it) over the coordinator's journal and `first-part-groups.json`. The owner registers a commitment for that report when the switch is turned on, so it cannot be forgotten.
- **Status surfaces:** `GET /local-verify` gains `likelyFailingFirst`. It answers for this machine: its setting, the list this machine holds (empty on a peer), and its own trial counts. No `/status`, `/health`, `/capabilities` or `/channels` answer changes.

---

## 8. Rollback cost

- **Switch:** set `monitoring.localVerify.likelyFailingFirst` to `off` (or remove it). It is read at each run start; no restart. Every verify that starts afterwards runs as before.
- **Hot-fix release:** revert the change and ship. The verifier's version changes again, so both machines install together.
- **Data:** the four state files can be deleted at any time; none is read by older code. A journal record that carries `rerunCutOff` is accepted by older code (the record check ignores unknown fields).
- **User visibility:** none while it is off.

---

## Conclusion

The review confirmed the design keeps its one promise structurally: the evaluator cannot return a pass for a lane that reported only its first part, whether the lane is marked cut short or not, and a test covers every combination. Two things were changed while building. A lane cut short got its own flag (`cutShort`) instead of reusing `stoppedEarly`, because an existing test pins that `stoppedEarly` with a report is ignored. And the comparison run is scheduled by the service after the child has exited and its record is written, in its own slot and its own checkout, so the first verify's record, end time and kept worktree are untouched. Open for the reviewer: the comparison run does not hold a planned restart; the verdict check concludes nothing from a comparison that errors; and the "two real test files" cases are scripted files in a fake runner, not files run by the real test runner.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, read-only), run by the scaling session on 2026-11-19 at about 02:45 PST against the uncommitted change
**Independent read of the artifact: concur**

The reviewer read the whole change against the approved spec and returned **CONCUR**. What it confirmed, with its own runs (two commands, 643 unit tests passed):

- With the setting off a verify's commands, reports and record are as on `main`; main verifies are untouched.
- A pass is only ever declared after every test has passed: a lane cut short always carries a stopped reason, the check that every file is reported once still runs over both parts, and the named test drives the real functions over 90 combinations.
- The verdict was the same with and without first parts for every case it enumerated (0 to 4 failing files across the two parts, each final, fail-then-pass or not eligible for a re-run).
- Paths from the list reach the test command only after being checked against the lane's own files, so a doctored list cannot inject a path.
- The comparison run cannot change a record, the journal, the list, a status or a merge, and is bounded.

One defect, fixed in this commit: a running comparison was not counted as busy, so the periodic clean-up of leftover processes could have killed processes of the comparison's tests and produced a false difference. A comparison now counts as busy in the three places that ask.

Its notes, also applied in this commit: one list entry per pull request per file; a list file with a failure time in the future is rejected; the comparison's marker is written before its child starts; the comparison row carries a full count for each capped list; and the notes name the third thing that happens with the setting off (the group assignment written at enqueue). Left as written and recorded under Under-block: a first part's re-run decision uses its own unhandled-error count.

These last edits were tested (the five requested unit files, 1,131 passed, and a further five lane and peer files) but were not re-read by the reviewer. Not checked by the reviewer: the integration and e2e files were read but not run; `tsc` and lint were run by the builder (both clean).

**Second read, of the merge with `main` (commit 3f9c6585b), 2026-11-19 about 04:30 PST: concur.** After the build was committed, `main` gained queue controls (#3495) and was merged in. The same reviewer read that merge: the three conflict resolutions (`feature-ladders.json` keeps both entries; in `LocalVerifyService.ts` the constructor builds both sets of stores, `snapshot()` carries both sections, and in `request()` the group assignment sits after the entry is inserted with `main`'s over-cap block and audit row unchanged; `localVerifyWiring.ts` wires both setters) and the new test file `tests/unit/localVerify/firstPartQueueControls.test.ts`. It confirmed that a group cannot be assigned twice, that the over-cap accounting cannot be skipped, that a comparison run blocks a fronted change from starting, that the operator sweep cannot touch comparison state, and that with both settings off the service differs from `main` only by the first-part changes already reviewed. Its run: five unit files, 276 passed. Not checked in that read: the rest of `main`'s side of the merge, and the integration and e2e files.

---

## Evidence pointers

- `tests/unit/localVerify/firstPartFlow.test.ts` — the lane flow, no early pass, equal outcome.
- `tests/unit/localVerify/firstPartService.test.ts` — the list in the completion path, the hand-off, the comparison run.
- `tests/unit/self-action-convergence.test.ts` — the comparison controller's bound.

---

## Class-Closure Declaration (display-only mirror)

This change adds a self-triggered controller (`local-verify-first-part-compare`): the service starts a comparison run on its own.

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `guard`
- **`guardEvidence`** — ratchet, `tests/unit/self-action-convergence.test.ts` over `localVerifyFirstPartCompare` in `src/testing/selfActionRegistry.ts`. Control-loop edge: a finished verify with first parts in `alternate` → a comparison run. Steady-state bound: `mayStartCompare` allows a start only while fewer than 5 are finished and fewer than 10 are started for that kind, counted durably before the start, so at most 30 starts per machine however many verifies qualify and however many comparisons are killed. Settling brake: a difference latches the trial off; a count that cannot be written starts nothing. The model drives the same `mayStartCompare` the service calls, under the pinned worst case where no comparison ever finishes.

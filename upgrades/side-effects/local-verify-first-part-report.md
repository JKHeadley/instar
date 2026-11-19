# Side-Effects Review — Local Verify: the verdict check of "likely-failing files first", amended

**Version / slug:** `local-verify-first-part-report`
**Date:** `2026-11-19`
**Author:** `echo (scaling session, topic 145097); built by a Codex builder to the approved spec, reviewed by an independent reviewer`
**Second-pass reviewer:** `independent reviewer subagent (not the builder)`

## Summary of the change

The first trial of "likely-failing files first" ran for 36 minutes on the M5 on 2026-11-19 and switched itself off. Its safety check ran the same change a second time after a verify (a comparison run). That took the machine out of the test line for 18.3 minutes while 15 changes waited, and it ended the trial because one unreliable test failed in one run and passed in the other.

This change removes the comparison runs and everything that depended on them, and replaces them with records and a report that cost no extra test runs (spec `docs/specs/local-verify-likely-failing-first.md`, section "The verdict check, amended (2026-11-19)", approved by the Chief of Staff on 2026-11-19 06:36 PT):

- **Removed:** queueing, starting, counting and judging of comparison runs; the automatic switch-off on a difference; the state files `first-part-compare-inflight.json` and `first-part-trial.json` (no longer read; the pull request assignments in `first-part-groups.json` stay); the comparison's audit rows, limits, run variant, collection of every file's outcome, its part in the busy checks, its self-action and state registry entries, the `trial` block of the status, and their tests. About 1,100 lines deleted.
- **Added:** one observation row per verify of a change on the machine that ran it (`logs/local-verify-first-part-observations.jsonl`); three fields in the verify record (the setting at the start, the group, whether first parts ran) so that a peer's signed record carries them; a report on every run machine (`GET /local-verify/first-part-report`) with the two groups' counts, a per-file table, red-main episodes (coordinator), open suspects with their age and OVERDUE after 3 days; findings recorded with `POST /local-verify/first-part-finding`; a marker for the start of a trial (`POST /local-verify/first-part-report/new-trial`); two automatic limits on cost that switch the setting off on that machine through the existing config writer; the awareness entry rewritten.

Files: `src/localVerify/firstPartReport.ts` (new), `LocalVerifyService.ts`, `firstPartTrial.ts`, `firstPart.ts`, `orchestrator.ts`, `record.ts`, `localVerifyRoutes.ts`, `localVerifyWiring.ts`, `src/testing/selfActionRegistry.ts`, `src/data/state-coherence-registry.json`, `src/data/feature-ladders.json`, `src/data/awareness/local-verify-likely-failing-first.md`, tests in all three tiers.

## Decision-point inventory

- **Whether a verify passes or fails:** unchanged. `src/localVerify/laneReport.ts` has no diff. The "no early pass" tests are byte-for-byte unchanged. The orchestrator gains only collection of evidence, and that collection is guarded so that a failure in it cannot change an outcome or throw into a verify's completion.
- **Whether the trial setting is switched off by a cost limit (new, automatic):** two numeric limits, each with a minimum count, each needing two daily evaluations in a row with new observations.
- **Whether a suspect ends the trial (new, a person's finding):** nothing is switched off by a red main or by a count; a recorded finding is required, and the switch-off after a confirmed finding is the operating session's action.
- **Removed decision:** the automatic switch-off on a difference between two runs.

## 1. Over-block

What could this stop that should go on?

- **A cost limit met by ordinary variation** ends a trial that was doing no harm. Named in the spec as the limits' own cost. Guard: two daily evaluations in a row, each with new observations; minimum counts (8 passes per group; 20 verifies per group and 3 deadline errors). The limit switches off only the trial setting on that machine; no verify, merge or queue is blocked.
- **A finding owed on a chance pattern.** A file whose failures split unevenly by chance becomes a suspect and owes a finding within 3 days. That is a person's time (a look at the failure messages), not a block: an overdue finding shows as OVERDUE and stops nothing by itself. Two unresolved file suspects pause the trial by the operating session's decision.
- Nothing in this change refuses, delays or fails a verify or a merge.

## 2. Under-block

What could get through that should not?

- **A false pass caused by the order of files is no longer looked for run by run.** This is the stated cost of the amendment. What remains: the built-in rule that a pass needs every file of every lane to pass; main verifies, which do not use first parts; the report listing each red-main episode with the changes merged before it and whether each passed with first parts; a finding duty with an owner. A false pass whose failure does not show on main is noticed by nothing, with or without this change, and the spec says so.
- **A false failure confined to one pull request** does not stand out in the per-file table. Its cost is that change's extra verifies; its author sees a file that passes elsewhere.
- **A failed write of the setting at a cost limit.** The live config's writer does not report a failed write, so the code reads the setting back; if it is not `off`, the attention item says the write failed, no marker ends the trial, and the limit is judged again at the next daily evaluation. There is no second hold file: a failed write leaves the trial running one more day (stated in the spec).

## 3. Level-of-abstraction fit

The pure logic (observations, trials, markers, the report, suspects, findings, episodes, the limits) is in its own module, `firstPartReport.ts`, tested without the service. The service keeps only the connections: where a verify completes, where main turns red or green, the status, the config writer. The routes are registered beside the other Local Verify routes. The three record fields live in the record, which is the signed and strictly validated part of a peer's answer, instead of a parallel field outside the signature.

## 4. Signal vs authority compliance

- The report, the per-file table, the suspects and the OVERDUE mark are signals. They decide nothing.
- The two cost limits are an authority over one thing only: the trial setting on the machine that measured them. They are numeric, bounded by minimum counts and by the second evaluation, and they raise one attention item naming the limit and the numbers.
- A confirmed finding ends the trial through the operating session, not through code.
- No signal introduced here can fail a verify, block a merge or change a record's outcome.

## 4b. Judgment-point check (Judgment Within Floors standard)

- Suspect numbers (4 final failures from 3 pull requests, at most a third as many in the other group; reopen after 4 more pull requests): they decide only what a person looks at. Floor: a suspect switches nothing off. Arbiter: the operating session's finding, on the evidence the feature's owner supplies.
- Cost limits: invariant, numeric, stated in the spec with the reason for each number.
- 3 days to a finding, 30 days of rows, 24 hours without an observation: fixed values for a label, a retention and a notice.

## 5. Interactions

- **The verify's completion path.** One row is appended per verify. A damaged line is skipped and counted; a read error leads to an append without a rewrite; a write error is caught. Nothing here can throw into the completion.
- **Main health.** A confirmed red reserves an episode and asks for the commit history without waiting for it; main-health handling is not delayed. A green ends the episode.
- **The status (`GET /local-verify`).** The open and overdue counts come from memory; the observation log is not read on that path.
- **Queue, holds, peers, merge line, restarts.** The comparison no longer counts as busy anywhere, because it no longer exists. Nothing else in those paths changes.
- **Verifier version.** This changes the verifier, like any change to the lane flow: both machines install together, and machines on different verifier versions do not accept each other's records, as today. A record without the new optional field is valid; an old validator does not refuse the new field.
- **The first trial's leftovers.** `first-part-trial.json` with its switched-off mark is on the M5. It is no longer read; no hand step is needed.

## 6. External surfaces

- Three routes behind the server's bearer authentication, on the same router as the other Local Verify routes, answered by every run machine (not only the coordinator): `GET /local-verify/first-part-report` (`?evaluate=1` opens suspects up to now; it judges no limit and does not move the daily evaluation), `POST /local-verify/first-part-report/new-trial`, `POST /local-verify/first-part-finding` (a suspect named by file path or red head, one of three words, a reason of at most 300 characters; anything else is refused). A suspect's name is never used as a path on disk.
- `GET /local-verify`: the `trial` block is gone; open and overdue suspect counts are added.
- One attention item per trial when a cost limit is met.
- Audit rows: the comparison's rows are gone; `first-part-cost-limit` is added.
- No call to GitHub is added. The commit history of an episode is read from the machine's own copy of the repository.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The report is read by two sessions, not by the owner of the installation. It says in plain words when it has no new observation for 24 hours, when the trial it shows has ended, and which suspects are overdue. The attention item names the limit and the numbers that met it.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Observations, markers, the report, the limits and the findings on file suspects: machine-local by design. Each run machine records and judges the verifies it ran under its own setting (the setting is per machine by the approved Local Verify capacity spec). The two sessions read each machine's report.
- Red-main episodes: on the coordinator, which keeps main's health. The three record fields let the coordinator know how a change verified on the peer was verified.
- If the coordinator role moves, episodes and findings stay on the machine that wrote them; the new coordinator starts with none and says from when it has kept them.

## 8. Rollback cost

- Switch: `monitoring.localVerify.likelyFailingFirst` is `off` on both machines and stays off until the operating session turns it on. With it off, a verify writes its observation row and runs exactly as before this feature.
- Reverting the change restores the comparison runs. The new files (`first-part-observations.jsonl`, `first-part-findings.json`) are then simply unread; no data needs converting back.
- The record's new field is optional; records with and without it are both valid before and after a revert.

## Conclusion

The change removes a safeguard that cost a machine's place in the line and could not tell an unreliable test from an effect of the feature, and replaces it with records, a report and a finding duty that cost no test time. What it gives up (proof for each verify that the verdict is unchanged) is stated in the spec and in its plain overview, and was approved on that basis. The rule that a pass needs every file to pass is untouched, with its tests.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context; not the builder, which was a Codex builder), run by the scaling session on 2026-11-19 at about 07:45 and 08:00 PST against the uncommitted change
**Independent read of the artifact: concur**

Two rounds.

- **Round 1: objected, three must-fix, ten should-fix.** (1) A failed write of the setting at a cost limit went unnoticed, because the live config's writer does not report a failure; the attention item would have said "switched off" when it was not. Fixed: the setting is read back after the write, and a write that did not take is reported and judged again the next day. (2) One damaged line, or one read error, would have emptied the observation log on the next write. Fixed: lines are parsed one by one, a bad line is skipped and counted, and after a read error the new row is appended without rewriting the file. (3) The ladder's harm measure read an audit row this change removes. Fixed: a cost-limit stop writes its own row and the ladder reads that. The ten should-fix items were all taken, among them: the status no longer reads the whole log; the evidence collection in the orchestrator is guarded so that it cannot change an outcome or throw into a verify's completion; reading an episode's commit history no longer delays main-health handling; tests no longer write into the repository.
- **Round 2: concur.** All thirteen findings closed, each with a test that asserts the behaviour. No new must-fix. Two one-line items were fixed after the round: only a made-up error record takes the evidence known at the start (a real record without the field reads as unknown, never as "no first parts"); the awareness entry's example command quotes its address.

What the reviewer confirmed in both rounds: `src/localVerify/laneReport.ts` has no diff; the "no early pass" tests are byte-for-byte those on `main`; every change in the orchestrator only collects evidence beside the verdict logic; the removal is complete and nothing that should stay was removed (the pull request assignments, the likely-failing list, the writer that sets the setting to off, the focused preflight); the switched-off mark the first trial left on disk is no longer read, and that is tested; the three routes sit behind the same authentication as the other Local Verify routes and a suspect's name is never used as a path.

Tests run on the authoring machine (by the builder and by the scaling session, at most five files per command): the unit files `firstPartReport`, `firstPartFlow`, `firstPartService`, `firstPartTrial`, `firstPartQueueControls`, `firstPartNeighbours`, `orchestrator`, `record`, `firstPart`, `peerVerifier`, `LocalVerifyService`, `self-action-convergence`, `awareness-entry-registry`, `lint-state-registry`, `feature-ladders-coverage`; the two integration files and the two lifecycle files named under Evidence pointers. All passed. Type check clean. Not run: the rest of the suite (run by Local Verify).

**The merge with `main` (restart exit gap, #3500), read by a second reviewer (Codex, read-only) on 2026-11-19 at about 08:15 PST: concur.** One textual conflict, in `shutdown()`: `main`'s new code began by cancelling a pending or running comparison; the resolution keeps `main`'s block and drops those two lines, because the comparison no longer exists. The reviewer confirmed that everything `main`'s version does at a stop still happens (the row naming interrupted runs, settling or discarding a finished result, cancelling without a kill timer, counting the interruption, the entry going back first, persisting the queue), and that nothing `main` added refers to anything this change removed. What the two changes do together, stated as limits and not changed: a verify whose finished result is settled at a stop writes its observation row; one that is discarded or cancelled by the stop writes none, so the report counts accepted completions; the daily evaluation can run during a stop, since it runs when a verify finishes; a red-main episode written just before the process ends may keep "unknown" for its commit history, because that read is not waited for and is not tried again at the next start. After the merge: type check clean; the unit files `LocalVerifyService`, `firstPartService`, `firstPartReport`, `firstPartFlow` and `orchestrator` pass (416 tests).

## Evidence pointers

- Spec and approval: `docs/specs/local-verify-likely-failing-first.md` (frontmatter `approved-by`, section "The verdict check, amended"); convergence report `docs/specs/reports/local-verify-likely-failing-first-convergence.md`, section "Amendment review".
- The first trial's record: the scaling project's state file `state/scaling/trial3-result-1119.md` on the authoring agent (not in the repository).
- Tests: `tests/unit/localVerify/firstPartReport.test.ts`, `firstPartService.test.ts`, `firstPartFlow.test.ts`, `firstPartTrial.test.ts`, `firstPartNeighbours.test.ts`, `orchestrator.test.ts`; `tests/integration/local-verify-first-part-report-routes.test.ts`; `tests/e2e/local-verify-first-part-report-lifecycle.test.ts`.

## Class-Closure Declaration (display-only mirror)

Not a defect fix in the code's sense: the removed check worked as specified. The class it belonged to is "a safeguard whose cost was not measured before it shipped": the comparison's cost to the line and its false-stop rate were estimated, not tried. The amendment's remaining automatic limits each state their own cost in the spec, and the trial's report now shows what the feature costs the line.

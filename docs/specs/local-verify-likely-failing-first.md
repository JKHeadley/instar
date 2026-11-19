---
title: "Local Verify: run the test files most likely to fail first"
slug: "local-verify-likely-failing-first"
author: "echo"
parent-principle: "Structure beats Willpower"
parent-spec: "docs/specs/local-verify-merge-authority.md"
eli16-overview: "docs/specs/local-verify-likely-failing-first.eli16.md"
tier: 2
supervision: tier0
topic: 145097
approved: true
approved-by: "Amendment of 2026-11-19 (the verdict check): Chief of Staff (echo-chief-of-staff), 2026-11-19 06:36 PT (agent message a2cef9bf): comparison runs removed; one row per verify; a daily suspect report with a 3-day finding duty; one confirmed changed-verdict case ends the trial on both machines; the two automatic cost limits stay. Conditions, all in the text: the tested pass rule stays untouched; the finding duty is owned by the session that operates the line (accepted, agent message c99b215a) and an overdue finding shows in the report; formal rounds and the constitution check before building. The first approval is recorded below."
first-approved-by: "Chief of Staff (echo-chief-of-staff), 2026-11-19 01:44 PT (agent message 9afb9152), by name: the merge gate's run may end as failed after a group's small first part, by the existing second-chance and stop-on-failure rules applied earlier; no test removed; off by default per machine; a randomised trial decides. Conditions: constitution check on the final text folded in; a pass is only ever declared after every test in the run has passed, as a tested property; the trial reports its verdict to the Chief of Staff and the throughput session at its stated end, including when the numbers say keep it off"
amended: "2026-11-19: the verdict check (measure 6) was replaced after the first trial switched itself off; see the section The verdict check, amended."
review-convergence: "2026-11-19T15:05:02.058Z"
review-iterations: 6
review-completed-at: "2026-11-19T15:05:02.058Z"
review-report: "docs/specs/reports/local-verify-likely-failing-first-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 2
contested-then-cleared: 2
---

# Local Verify: run the test files most likely to fail first

## Words used here

- **Change:** a pull request waiting to be merged.
- **Local Verify, "the line":** the system that tests every change before it may merge. It runs on two of our computers: the Studio (the **coordinator**, which owns the queue) and the M5 (a **peer** the coordinator hands changes to).
- **Verify:** one test run of one change. After about 5 minutes of set-up (fetching, installing, building, lint), three **lanes** of tests run side by side: unit, integration and end-to-end. Each lane is one or more test processes.
- **Fail-fast:** the existing rule that when one lane has failed, the other lanes are stopped and the verify ends.
- **Re-run alone:** the existing rule that a failed test file is run once more by itself, for at most 3 files per verify, and under conditions that exclude files the change touches. A file that then passes is recorded as "fail then pass" and does not fail the verify.
- **Main verify:** a test run of the shared code itself, after changes merge.

## Problem

**A failing verify is found out late.** A lane's failure is known only when that lane's whole test process has ended. Nothing looks at results while a lane runs. So a unit test that fails in the second minute ends the verify only when the unit lane finishes.

**Measured on the Studio** (its run logs, verifies of changes since 2026-11-14; 204 verifies, 4,970 minutes):

| Outcome | Verifies | Share of minutes | Median minutes |
|---|---|---|---|
| Passed | 77 | 59% | 37.6 |
| Failed in the unit lane | 37 | 20% | 24.9 |
| Failed in the end-to-end lane | 19 | 13% | 31.9 |
| Failed in the integration lane | 9 | 7% | 39.6 |
| Other (deadline, lint, merge conflict) | 62 | 2% | under 2, except deadlines |

Four of every ten test minutes on the Studio go to verifies that fail, and each of those takes 25 to 40 minutes to say so.

**Most failures are one file, and the same files keep failing.** Across both machines since 2026-11-12, 192 failed verifies named their failed files. Two thirds named exactly one file. They are mostly small checks that pin a count or a piece of text and break when a change forgets to update them.

**Can the past predict the next failure? Tested, not assumed.** For each of the 122 failed verifies from 2026-11-15 on (both machines), I rebuilt the list as this design would have had it at that moment: only failures from the 7 days before, only from other changes, only from verifies with 1 to 3 failed files (the only ones a record names), with this design's per-lane limits, plus the files the same change failed on in its own previous verify. Then I asked whether a first part would have contained a file that failed:

| Rule replayed | Failed verifies whose failing file was in a first part | Share of their minutes |
|---|---|---|
| List of 60, a file needs failures from 2 different changes | 32% | 34% |
| List of 60, no minimum | 45% | 46% |
| **List of 90, no minimum (this design)** | **53%** | **54%** |
| List of 120 | 54% | 56% |

This is the share of the replayed verifies whose failing file was included in a first part, for the list size chosen on this same replay; the trial is the independent test. It is not a forecast of how many verifies will end early, nor of time saved. The failure history starts on 2026-11-12, so the earliest replayed verifies had 3 days of history behind them, not 7; only those from 2026-11-19 had the full window. Three things it leaves out: the test files a change itself adds or edits (the logs do not hold them; they may add hits, or take places from listed files); the 60-second limit on the two slower lanes' first parts (A), which will remove some; and that a file which is unreliable on our machines may pass on its second try and so not end the verify.

**What was tried before.** A "fast focused preflight" was built in October to catch failures early. It chooses tests by asking the test runner which tests a change affects. In a trial on 2026-11-16 and 17 it never ran a test in 36 verifies: the question alone took over 80 seconds, it compared against the wrong starting point, and real changes exceeded its file limit. It is switched off. This design does not choose tests that way.

## Proposed design

**In one sentence:** each lane runs a small first part before the rest, made of the test files the change touches and the files that failed most often lately, so that a failure in one of those files shows within a couple of minutes of the lanes starting; the rules that decide the verdict are unchanged. How many failing verifies that covers is what the trial measures.

**A pass is declared only after every test file of every lane has a passing result, by the lane's existing acceptance rules** (which accept a file whose tests are all marked skipped, as today). A first part can end a verify early as failed. It can never end one early as passed: a clean first part only lets the rest of the lane start. This is a tested property (Tests).

It is ordering only. Every test file still runs in its own lane, with its own lane's settings, unless the verify has already failed. No file is chosen out of the run, so no verdict can go wrong by choosing badly: a poor list means the failure shows as late as today, and the verify carries the small cost of the first parts (a process start per lane, and some files run one at a time); how large that is, the trial measures.

### A. The first part

For each lane, before its usual processes start, one process runs that lane's **first part**, filled in this order:

1. **The change's own test files** in that lane: files it adds or edits. The verify already computes the changed paths before the lanes start; they are intersected with the lane's file list, so deleted files and non-test files drop out. If the changed paths cannot be read, there are none.
2. **The files this same change failed on in its previous verify,** from the coordinator's record of that verify (at most 3).
3. **The lane's files from the likely-failing list** (B), in the list's order.

**Limits per lane.** Unit: 80 files. Integration: 20 files and end-to-end: 12 files, and for these two lanes also at most 60 seconds of recorded file time in total, because their files run one at a time and the first part's files lose the lane's side-by-side processes. A file with no recorded time counts as 10 seconds. A lane whose first part would be empty skips it and starts as it does today. A lane whose files all fit in its first part runs only the first part, and the lane is completed from that one report.

**Path filters.** A first part names its files to the test runner, which matches names by substring, ignoring case. The existing shard planning already groups files whose paths overlap in either direction (one path contained in another). Such a group is never divided: it goes into the first part whole, counting toward the limit, or stays in the rest whole. A group that would exceed the limit, or that contains a path with a wildcard character, stays in the rest.

The three lanes' first parts start together, as the lanes do today. The first part is part of its lane: its time is counted in the lane's time, its report is merged into the lane's report the way shard reports are merged today, its file times are recorded like any other, and the lane's deadline covers both parts (the rest gets what is left). It is not a fourth lane. Its report and step are named `<lane>-first`.

### B. The likely-failing list

- **What counts.** A file is counted when a verify of a change **failed finally** on it: after the re-run alone, in a verify with 1 to 3 failed files, all of them real test failures. That is exactly what a verify's record already stores as `failedFiles`. A file that failed and then passed alone is not counted. A file whose re-run alone was cut off because another lane had failed is not counted either, here or as one of a change's previous failures: a cut-off re-run is no evidence that the file fails. Main verifies are not counted.
- **A known bias, accepted.** When a verify ends in a first part, its record names only the first part's failed files; a file that would have failed later is not counted that time. The list therefore leans toward files it already holds. The change's own files and its previous failures (A.1 and A.2) are the counterweight. What can be seen of the cost is in measure 5: a later verify of the same change failing on a file that had not run, and machine-minutes per change. Neither shows what a file that never ran would have done.
- **Where it comes from.** The coordinator updates the list whenever it records a verify of a change, its own or one the peer ran, so both machines' failures feed one list. The list is one file, `state/local-verify/likely-failing.json`, written whole and replaced; it is read only if it is at most 1 MB.
- **Bounded and dated.** Each file keeps the pull request number and time of each of its failures in the last 7 days. The list keeps at most 500 files; when a 501st arrives, the file whose most recent failure is oldest is dropped. (The replay never reached 500 files, so this rule did not affect it.) For each verify, the coordinator takes the 90 that failed for the most different pull requests other than the one being verified (ties: most recent first), which is the rule the replay tested; that change's own previous failures enter through A.2 instead. Ranking by different pull requests, not by count, means one change verified ten times cannot lift its own file. There is no minimum: in the replay above, requiring two different changes lowered coverage from 45% to 32% (measured at 60 files). The file states when it was last updated and the oldest failure it holds. A list not updated for 7 days is treated as empty.
- **Both machines use the same list.** The coordinator sends the 90 paths in use, and the change's previous failures, with each verify it hands to the peer, in one new field of the request (at most 100 paths, each at most 300 characters; a malformed field refuses the whole request, as every other malformed field does). The coordinator leaves out any path longer than that before sending and writes an audit row naming it, so a legitimate long path can never refuse a request and is not dropped silently; such a file simply runs in its lane as usual. The field is sent only when it is not empty. A peer never builds its own list.
- **Lost or unreadable file.** The list is empty, and the first parts hold the change's own files and its previous failures, which come from its verify records and not from the list. One audit row says so. The list rebuilds as verifies are recorded.

### C. What a failure in the first part does

When a lane's first part has ended, the existing rules are applied to it, earlier than they are today:

1. **Re-run alone,** under the existing conditions and the existing budget shared across the verify. A file that passes alone is recorded as "fail then pass", and its lane goes on to the rest of its files. So a file known to fail and then pass cannot end a verify early by itself.
2. **If the lane has failed finally** (a file still fails, or the failure is not eligible for a re-run), the lane does not start the rest of its files, and the existing fail-fast stops the other lanes. The verify ends as failed.

**How the existing rules are applied to a lane in two parts.** Today each rule looks at a whole lane at once. For a lane with a first part:

- The re-run decision for the first part is made on the first part's own files: its report must cover exactly those files, and "more than 3 failed files" counts the first part's failures.
- The re-run decision for the rest is made on the rest's files, and "more than 3 failed files" counts the lane's failures so far, first part included, as it would have if the lane had run in one piece.
- The budget is the same single budget for the verify, in whatever order it is spent.
- Unhandled errors and exit codes are combined across the two parts the way they are combined across shards today.
- **A lane cut short after its first part** has a report that covers only the first part. The files that did not run are marked "not run: the lane was stopped", as the files of a lane stopped by fail-fast are today, and are not reported as missing. So the verify's record names the failed files, and the list can learn from them. The counts a record gives for that lane cover only the files that ran.

**All of a first part's failures are reported together** for its own lane: it runs to its end before its lane decides. Another lane's first part that fails finally stops it through fail-fast, as lanes stop each other today.

**A failure that ends the verify takes precedence over what the rest would have done.** If the rest of that lane would have run past its deadline, that is never reached: the verify is recorded as failed, not as an error, and so gets no automatic retry for a deadline. Fail-fast between lanes has the same effect today.

**With fail-fast switched off** (`monitoring.localVerify.failFast`), nothing ends early: every lane runs both parts, and the failures of both are kept. The first part then only changes the order.

### D. The rest of the lane

The lane's usual processes then run every file that was not in the first part. There are three cases, and each file is reported exactly once in all of them, which the existing check requires:

- **The unit lane** (one process, no file list): the first part's files are excluded by name (`--exclude=<path>`).
- **A sharded lane with a plan from recorded times:** the first part's files are left out before the plan is made, so the shards are balanced on what remains.
- **A sharded lane without a plan** (too few recorded times): the test runner splits the files, and the first part's files are excluded by name.

### E. Where it applies

- **Verifies of changes only.** A main verify always runs everything and never stops early, so a first part would only add a process start. Main verifies are unchanged.
- **Off by default, set per machine.** `monitoring.localVerify.likelyFailingFirst` is `off`, `on` or `alternate`; absent means `off`. `alternate` is the trial setting: a machine set to it uses first parts for half of the pull requests. The coordinator assigns each pull request to "with" or "without" once, at random, when it first queues it, keeps the assignment for every later verify of that pull request, and sends it with each verify, including to the peer. So a change's retries are measured under the same rule as its first attempt. Each run machine reads its own value at the start of each verify it runs, as it does for fail-fast, so the trial can turn it on for one machine first. With it off, a verify runs exactly as today. The coordinator keeps the list up to date and sends it whether or not either switch is on, so it is ready when one is turned on.

### F. What is recorded

- In the verify's log on the machine that runs it, written at the start of the verify so that set-up failures and verifies with empty first parts stay in their group: the pull request's assignment (`with` or `without`) and the machine's setting. Then the first part's files per lane, how many came from the change, from its previous failures and from the list, the first part's time, and whether the verify ended there.
- `GET /local-verify` shows the setting, the list's size, age and top files, and the number of open and overdue suspects; `GET /local-verify/first-part-report` on each run machine shows the report of measure 6 (groups, files, red-main episodes, open suspects with their age).
- The awareness entry `src/data/awareness/local-verify-likely-failing-first.md` (short title) tells the agent the feature exists, how to read a verify that ended in a first part, and where the list is shown. It is rewritten with this amendment: the comparison runs and the switched-off file go out, the report, the suspects and the findings come in (an awareness entry is rebuilt for every agent on update, so no migration step is needed).
- One observation row per verify of a change, on the machine that ran it (measure 6, part B), and the findings recorded on suspects (part F).
- Audit rows: `likely-failing-updated` (when the list changes), `likely-failing-unreadable`, and on each verify `first-part` with the numbers above.

## Expected benefit, and how it is measured

**The inputs, with their sources.** From the two machines' run logs since 2026-11-14: the Studio had 65 verifies that failed in a lane in 4.6 days (about 14 a day), at a median of 25 to 40 minutes depending on the lane; the M5 had 77 (about 17 a day), at about 17 minutes. Set-up before the lanes takes about 5 minutes on either machine, so a first-part failure would show at about minute 7. The line has merged 0.48 changes per verify (2026-11-16 to 11-18).

**The projection.** If first parts end 40% to 50% of lane failures at about minute 7 (the replay's historical hit rate was 53%; the share that actually ends early is for the trial to measure):

- Studio: about 14 a day, about 23 minutes saved on each one ended early: 130 to 160 minutes a day.
- M5: about 17 a day, about 10 minutes saved on each: 70 to 85 minutes a day.
- Together 200 to 245 machine-minutes a day, 8 to 9 more verifies, **about 4 more merges a day**.

This is a projection from one week of history, not a measurement.

**The cost on verifies that pass.** One more process start per lane, and, on the two slower lanes, up to 60 seconds of files run one at a time that the lane's side-by-side processes would otherwise have shared. Neither is measured in this codebase yet. A passing verify that was already close to a lane's deadline could be pushed over it, which would change its outcome from pass to error; this is one of the three stated ways the design can change an outcome (the others: a test that depends on its neighbours, and a first-part failure ending a verify that would otherwise have hit a deadline and been retried), and deadline errors are counted below.

**The measures.** Each run machine is set to `alternate` for two weeks, so pull requests fall into two groups of about equal size that cover the same days and the same suite. From the verify logs:

1. Machine-minutes per verify across all outcomes, with and without. This is the main measure.
2. Median minutes from the start of a verify to its failed verdict, for verifies that fail in a lane (now: unit 24.9, end-to-end 31.9, integration 39.6 on the Studio).
3. Median total minutes of verifies that pass (now 37.6 on the Studio, 19.3 on the M5), and the number of lane-deadline errors, in each group. The two automatic limits on these are stated in measure 6, part E.
4. The share of failed verifies that ended in a first part.
5. **Machine-minutes per change, from its first verify to its first passing verify,** grouped by the pull request's assignment, counting every verify of it on either machine. This measure is taken only over a period in which both machines are set to `alternate`: while one machine is still `off`, a change assigned to first parts may be verified without them, and the comparison would measure the staging, not the feature. The first stage (one machine) is a pilot that gives measures 1 to 4 and the two cost limits. A pass that the coordinator derives from an earlier verify of the same merge inputs, without a new run, ends a change's follow-up with no minutes added; a change whose first result is such a derived one is not enrolled. Only changes whose first verify of all starts inside that period are enrolled: a change that was already verified during the pilot is left out, because its entry would depend on how the pilot went. Pull requests are enrolled by their first verify during the two weeks, and each is followed for the same 7 days from that verify, so late entrants are not cut short. Two numbers are compared between the groups: machine-minutes per enrolled pull request over its 7 days, and the share that reached a first pass within them. This is the measure that catches the real risk of ending early: a change with two separate faults needs two verifies, so minutes per verify can fall while minutes per change rise. Also reported: how often the next verify of the same change failed on a file that had not run (between lanes today: 3 of 19 later verifies of the same change on the Studio).
6. **The verdict check** is described in the next section. As first approved it was a second full run after some verifies; the first trial showed that this could not work on this line, and it was replaced on 2026-11-19.

## The verdict check, amended (2026-11-19)

### What the first trial showed (the M5, 36 minutes)

A **comparison run** was a second run of the same commit without first parts, made after a verify, to see whether the verdict was the same. As first approved, each machine made one after the first 5 verifies of each of three kinds, and a difference on a file not known to be unreliable switched the setting off.

- One verify ran with first parts (pull request 3500). The first parts took 0.5 minutes. The verify failed at 17.8 minutes on `tests/unit/job-portable-bundle.test.ts`, which was not in a first part. That file had failed before on this machine with a python3 start timing out, and had passed when run again.
- The comparison run took 18.3 minutes and passed. 5,557 files ran in both runs; that one file differed. Neither run had marked it unreliable and the machine's list of unreliable files was empty, so the difference counted and the check switched the setting off, as written.
- While the comparison ran, the M5 tested no change. 15 changes were queued and one had been moved to the front by the operator.

Two defects in the check itself (whether first parts played any part in that one failure is not known):

1. **One disagreement between two runs ended the trial, and its cause is unresolved.** A second passing run does not show whether load or file order made the first one fail. Files that fail once and pass when run again are common on this line (how common between two full runs of the same inputs has not been measured), so the check can stop a trial at the first such file without saying anything about first parts.
2. **A comparison took a machine out of the line for a whole verify** (18 minutes on the M5, about 38 on the Studio), up to 15 completed and 30 started per machine, and started when the machine was free without looking at what waited. The line's operator set a condition (echo-increasing-throughput, agent message 39700557, 2026-11-19 14:04Z): "a comparison run must not delay a fronted change and must not run when the queue holds more than a few waiting changes". The queue has held 15 changes or more for days; under that condition almost no comparison would finish.

### What the check was for, and what cannot be had cheaply

First parts change which files share a process, in what order, and under what load. A test whose result depends on that could fail a good change (a false failure) or pass a bad one (a false pass).

Telling such an effect from ordinary unreliability takes repeated full runs of both arrangements (about 36 machine-minutes a pair on the M5), on a line that has no spare minutes. So the check no longer claims proof for each verify. It rests on one property that is built in and tested, and on reports that cost no extra test runs.

**The property that holds by construction, unchanged by this amendment:** a verify is recorded as passed only when every file of every lane has a passing result in its report, by the lane's existing acceptance rules. A first part can end a verify early only as failed. This is the "no early pass" test in the Tests section (`tests/unit/localVerify/firstPartFlow.test.ts`), and nothing in this amendment touches the code it covers. The Chief of Staff approved the amendment on this basis (agent message a2cef9bf, 2026-11-19 06:36 PT): "the property I care most about still holds structurally: a pass is only declared after every test passed, and reordering can only end a run early as failed", with the condition "that tested property stays in the build untouched".

**One difference in outcome that is not about order, stated here because the check is about outcomes:** if a file fails in a first part and another file of the same lane would have hung in the rest, the verify with first parts ends as failed, while without them the lane would have reached its deadline and ended as an error, which is retried automatically. The failure is real in both cases; what is lost is the automatic retry. A test records this pair.

### The check as amended

**A. No comparison runs.** No verify is followed by a comparison. The code that queues, starts, counts and judges comparison runs, and the switch-off that depends on them, is removed (the writer that sets the machine's own setting to `off` stays, for part E), all of it: the state file `first-part-compare-inflight.json`; the file `first-part-trial.json` with its comparison counts and its switched-off mark (the pull request assignments are in another file, `first-part-groups.json`, and stay; the mark the first trial left on the M5 is no longer read, so the M5 needs no hand step); every `first-part-compare-*` audit row, `first-part-switched-off` and the two `first-part-trial-*` rows about that file; the comparison's limits; the comparison variant of a run and its collection of every file's outcome; the comparison's part in the checks of whether a machine is busy; its entry in the self-action registry and in the state registry; the `trial` block of the status; and their tests. The setting is off on both machines, so no comparison can be running when this is installed. A suspect is investigated on a machine that is not in the line (the throwaway rig). On the Studio or the M5 only when the session that operates the line allows it, at a moment when no change waits, for a failure that shows only on that machine. That costs owner time and rig time, not line time.

**B. Each run machine writes one observation per verify of a change** (a row in its own log `logs/local-verify-first-part-observations.jsonl`, rows older than 30 days dropped, marker rows kept; about 40 rows a day), in both groups. It reuses what the verify already has (its identity on that machine: the run token of a local run or the attempt reference of a run done for the coordinator; time, pull request, head, base, outcome, the step an error happened in, minutes) and adds: the setting read when the run started, the group assigned, whether first parts actually ran, and for every file that failed at any point: its lane, whether it was in a first part, whether it was one of the change's own test files, and whether it ended failed, passed on its re-run, or its re-run was interrupted (at most 50 files named, with the total count). A verify whose report is incomplete says so in its row, and each row notes which lanes ran all their files and which files were in a first part (the first-part summary already lists them). Every record of a change's verify, local or from a peer, carries three of these fields (the setting at the start, the group, whether first parts ran) as one optional field; a peer's travels in the record it sends back, which is the signed and strictly checked part of its answer, so that the coordinator knows how every change it merged was verified. A record that the coordinator derives from an earlier verify of the same merge inputs, without a new run, takes the three fields of that earlier verify. Today the basic record and a first-part summary exist for both groups; this per-file detail does not.

**C. False passes: main is where one would show, and a person decides what it means.** A change that passes wrongly is merged, and a later main verify may fail. The existing handling of a failed main (run it again; if it fails again the line stops) is unchanged. The code does not know which merge caused a red main, and this amendment does not build that. It adds one thing to the report of part D, on the coordinator: for each red-main episode, the commits on main between the last green head and the red one, each with its pull request number where the commit message gives one, and whether that change's passing verify used first parts. An episode begins when main is confirmed red (the re-run failed too; a single failure that passes when run again is not one) and ends at the next green. It is written down once, when it begins, with both heads and the list of commits, read then from the machine's own copy of the repository (no call to GitHub, and nothing is read from the repository when the report is asked for). A commit with no number, a change whose passing verify is not known, or a history that cannot be read is shown as unknown, never as "without first parts". An episode is a **suspect** when a change in it is known to have passed with first parts. An unknown is shown and owes no finding. Nothing is switched off automatically on a red main: ordinary unreliable tests make main red too, and an automatic stop here would repeat the first trial's defect.

**D. The report.** From the observations of the current trial (verifies that started under `alternate` since the setting was last set to it on that machine; verifies started under `off` or `on` are left out). A verify is counted in the group it was assigned to, also when its first parts were empty or it failed before they could run. The start of the current trial is marked: whenever a machine reads a setting that differs from the last one it read (kept in the findings file), it writes one marker row in the observation log with the old value, the new value and the time. The session that operates the line can also ask a machine for a marker without changing the setting (`POST /local-verify/first-part-report/new-trial`, answered by every run machine), which it does on the M5 when the Studio joins, so that both machines count the joint trial from the same day. The current trial is every verify started under `alternate` after the newest marker of any kind. While no verify has started under `alternate` after the newest marker, the report and an evaluation on request cover the trial that ended at that marker, and the report says that it has ended. So a trial that was paused, or switched off by a limit, and switched on again starts its counts from zero; the rows of the earlier trial stay in the log for the verdict report, and suspects and their findings are kept across trials. The period in which both machines are set to `alternate` (measure 5) is read from the two machines' markers. The report is computed when asked for (`GET /local-verify/first-part-report`, answered by every run machine whether or not it is the coordinator, like `GET /local-verify/status`), and is evaluated for suspects and for the limits of part E once a day: at the first verify that finishes more than 24 hours after the last evaluation, whose time and result are kept in a file so that a restart loses nothing. Per machine:
- per group: verifies, passes, failures, errors;
- per file with 4 or more final failures in the two groups together: failures with and without, different pull requests with and without, how often it was in a first part, and for each group how many of its verifies actually ran that file (it was in a first part, or its lane ran to the end; a verify where neither is known counts as unknown), so that a file that seldom ran in one group is not read as failing less there;
- the red-main episodes of part C (coordinator only);
- the open suspects, each with its age in days, and the word OVERDUE on any that has had no finding for more than 3 days.
A **file suspect** is a file, not one of the failing change's own test files, with at least 4 final failures with first parts from at least 3 different pull requests and at most a third as many without; the same numbers the other way round (failures without, hardly any with) also make one, because a first part could hide a failure. These numbers only decide what gets looked at. They are not evidence: groups can be of unequal size, one pull request verified many times repeats its own failures, a verify that ended early never reached its later files, and with about 280 verifies per group in two weeks one file's failures split unevenly by chance often (a file with 5 failures splits 4 to 1 or 5 to 0 three times in eight). The cost of that is named: a few findings in two weeks that say "chance", each a look at the failure messages. If the setting is `alternate` and no observation has been written for 24 hours, the report says that in plain words, so that "nothing listed" is not read as "nothing wrong". The coordinator's `GET /local-verify` also shows, under `likelyFailingFirst`, how many suspects are open and how many are overdue on that machine.

**E. Two automatic limits on cost remain** (per machine, over the current trial, each verify counted once; when one is met at two daily reports in a row, each with new observations, the setting is switched off on that machine and one attention item is raised that names the limit and the numbers, which is how the two sessions are told; the switch-off writes `off` to the machine's own config with the existing writer and writes the marker row of part D itself; if the config cannot be written, the attention item says so and the limit is judged again at the next daily report. There is no second hold file: a failed write leaves the trial running one more day, and in exchange the setting has one source and switching back on needs no file removed by hand):
- the median duration of passing verifies with first parts is more than one minute above the median without, with at least 8 passes in each group;
- lane-deadline errors (the record's error step is a lane deadline or the total deadline): at least 3 verifies with first parts ended that way, and their rate is more than twice the rate without, with at least 20 verifies in each group.
These are limits on what the feature may cost the line, not evidence of a cause. Their own cost: ordinary variation can meet them and end a trial that was doing no harm; asking for two reports in a row is the guard against that.

**F. Findings, with an owner and dates.** Every suspect gets a finding within 3 days: **confirmed** (the test passes or fails depending on the arrangement, shown on the rig with the code and settings of that verify, more than once or with a clear technical reason), **explained** (a real conflict between changes, a test already unreliable in both groups, a chance split), or **unknown**. The finding is owed by the session that operates the line (named by the Chief of Staff); the feature's owner (echo, scaling session, topic 145097) investigates, runs the rig and supplies the evidence. A finding is recorded on the machine whose report lists the suspect, with `POST /local-verify/first-part-finding` (answered by every run machine; the suspect is named by its file path, or by the red head of its episode, and belongs to the trial it arose in; the finding is one of the three words; a reason of at most 300 characters), and shows in that report. Suspects, findings, red-main episodes and the last evaluation are kept in `state/local-verify/first-part-findings.json` on that machine. A finding of confirmed or explained closes that suspect in that trial, with the counts at that moment recorded beside it. It is opened again, shown with the earlier finding, when the file has since failed finally for 4 more different pull requests in the same group within the same trial, or when it meets the numbers in a later trial. A suspect past 3 days without a finding shows as OVERDUE in the report, so it cannot lapse silently.
- One **confirmed** case, of either kind, ends the trial: the operating session switches the setting off on both machines the same hour.
- A suspect recorded as **unknown** that was a red main, or is a file still failing changes: the two sessions decide together, that day, whether the trial continues, and the decision and its reason are recorded with the finding.
- A finding of unknown means investigated and not resolved. The suspect stays in the report as unresolved, and a later finding of confirmed or explained replaces it. Two file suspects unresolved at the same time, counted over both machines' reports, pause the trial: the operating session, which reads both reports, sets both machines to `off` and switches them on again when one of the two is resolved.

**G. What the trial's verdict report adds:** the tables of part D, every suspect with its finding, the machine time the limits of part E measured, and its conclusion, written from the recorded findings and not from a fixed sentence: if a case was confirmed, the report says so first and names it; if none was, it says that main verifies reported no failure traced to first parts and that this is not proof that no verdict changed. The report is sent when the trial ends early as well as at its scheduled end. Before it is written, one evaluation is run on both machines up to the end time (asking for the report with `?evaluate=1` does it; it opens suspects only, does not judge the limits of part E and does not move the time of the daily evaluation), so that a suspect that arose in the last day is not missed; a suspect opened by it is reported as pending, and graduation waits for its finding.

### What this gives up, said plainly

- Proof for each verify that the verdict is the same with and without first parts. The first trial showed that the comparison could not give that proof either: its one disagreement could not be attributed to anything.
- A false pass is noticed after the merge, through a red main (the line stops until it is fixed or reverted), and only if a person traces it. That is how any wrongly passed change is noticed today. One whose failure does not show on main either is not noticed, with or without this amendment.
- A false failure that does not recur across pull requests will not stand out in the report. Because a pull request keeps its group, it may recur on every verify of that one change; the author sees a file failing that passes elsewhere, which is how unreliable tests are met today, and can ask the feature's owner to look.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Whether a verify fails | invariant; basis: enumerable-domain; evidence: the rules are unchanged: the same files, the same re-run-alone rule and the same fail-fast decide; this design changes when they are consulted. A test asserts that, for tests that give the same result wherever they run and for runs that finish inside their deadlines, a verify's outcome with first parts equals its outcome without, for every combination of passing, failing and fail-then-pass files in the first part and in the rest. What is not guaranteed is stated under Risks: a test whose result depends on which other files share its process can change with any reordering, this one included. | |
| Which files go in a first part | judgment-candidate; floor: only files of that lane that the verify would run anyway, within the per-lane limit; a file left out still runs. Arbiter: the change's own test files, its previous failures, then the number of different pull requests a file failed finally for in the last 7 days. Conservative default: an empty first part, which is today's behaviour. Symbol: a file's count in the list. State claimed: "this file is more likely than others to fail on the next change". Corroboration: the historical replay above (each ranking used only earlier failures; the list size was chosen on the same period, so the randomised trial is the independent check). Unmeasurable (list unreadable or stale): empty. | |
| Whether the trial setting is switched off by a cost limit (measure 6, part E) | invariant; basis: enumerable-domain; evidence: two numeric limits over the observation rows of the current trial, each with a minimum count and met at two daily reports in a row; tests at each boundary. Symbol: medians and deadline-error rates per group. State claimed: "the feature costs the line more than the design allows", not a cause. Corroboration: the second daily report with new observations. Unmeasurable (too few verifies, no new observations): no switch-off, and the report says so. | |
| Whether a suspect ends the trial (measure 6, part F) | judgment-candidate; floor: nothing is switched off by a red main or by a count; a recorded finding is required. Arbiter: the session that operates the line, on the evidence the feature's owner supplies from the rig. Conservative default while a finding is missing: the trial continues, the suspect shows as OVERDUE after 3 days, and two unknown file suspects pause it. Symbol: a file's failures by group, or a red-main episode after a change that passed with first parts. State claimed: "worth a look", nothing more. Corroboration: reproduction in both arrangements on the rig. | |
| Whether the rest of a lane runs after its first part | invariant; basis: enumerable-domain; evidence: it runs unless the lane has failed finally by the existing rules. | |

## Fixed limits

| Limit | Value | Reason |
|---|---|---|
| First-part size | unit 80 files; integration 20 and end-to-end 12 files, each also at most 60 s of recorded time | Unit files are quick and many run at once; integration and end-to-end files run one at a time, so their first parts are held to about a minute. Starting values, revised from the measured first-part times. cheap-to-change-after |
| List used | 90 files | The replay: 60 gave 45%, 90 gave 53%, 120 gave 54%; little is gained past 90. cheap-to-change-after |
| Failures kept | 7 days, 500 files | The test used a 7-day window; 500 bounds the file |
| Ranking | by different pull requests, no minimum | A minimum of 2 lowered the replay's coverage from 45% to 32% (measured at 60 files); ranking by different pull requests already stops one change lifting its own file |
| Stale list | 7 days without an update | Matches the window; an old list predicts nothing |
| Passing verifies may slow by | at most 1 minute at the median, compared within the same trial, at two daily reports in a row | The cost is a process start per lane and up to a minute of serial files on two lanes; more than a minute means the cost exceeds the design, and the switch goes off |

## Multi-machine posture

- `likely-failing.json` (on the coordinator): unified by placement. One list, built by the coordinator from every verify it records, sent to the peer with each verify. The peer never writes one.
- `monitoring.localVerify.likelyFailingFirst`: machine-local, read by each run machine for the verifies it runs, like `failFast`. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (the approved Local Verify capacity spec: run-machine settings are set per machine by the operator). The two machines may differ during the trial; the setting changes a verify's timing, and its outcome only in the three stated ways (a lane pushed past its deadline, a test that depends on its neighbours, or a failure in a first part ending a verify that would otherwise have hit a deadline and been retried).
- The observation log, the report and the two cost limits: machine-local by design. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (run-machine settings are set per machine by the operator; each run machine records and judges the verifies it ran itself under its own setting). The two sessions read the report of each machine. The red-main episodes are listed on the coordinator only, because only the coordinator keeps main's health. Each machine keeps the findings on its own suspects.
- If the coordinator role moves, the episodes and findings stay on the machine that wrote them; the new coordinator starts with none, and its report says from when it has been keeping them.
- If the coordinator role moves, the new coordinator starts with its own list, empty if it has none, and rebuilds it.

## Maturation plan

- **ladder:** local-verify-likely-failing-first
- **test-agent-live:** a throwaway agent with a fake change source and real test files: a change that breaks a listed file fails in the first part and the verify ends there; a fail-then-pass file in the first part does not end it; a change whose first part is clean runs the rest and passes, each file reported once; the list is built from recorded failures and sent to a peer.
- **dev-agent-live:** the development agent's line, set by the session that operates the line. First a pilot on the M5 alone (measures 1 to 4 and the two cost limits); then both machines set to `alternate` together: two weeks in which changes are enrolled, and 7 more days in which both machines stay on `alternate` so that a late entrant's later verifies run as assigned (a stop by a limit or a confirmed case ends it earlier). Measure 5 and the graduation numbers count enrolled changes only; changes first verified in the third week are verified as assigned but not counted there. The report's tables of part D cover every verify since the marker, and say so. A pull request keeps the group it was assigned on both machines.
- **graduation criterion:** for pull requests enrolled over two weeks and each followed for 7 days: machine-minutes per enrolled pull request do not rise and the share reaching a first pass does not fall; machine-minutes per verify fall; the median time to a failed verdict falls on both machines; the passing median is no more than one minute higher with first parts than without and deadline errors are no more frequent; no confirmed suspect of either kind; no suspect left unknown that was a red main or is a file still failing changes; no finding overdue; and the two cost limits of measure 6 not met.
- **fleet:** off by default until the two-week report; the fleet default is then proposed with the evidence and recorded on the ladder.
- **dark-window:** from merge until the operating session turns the switch on.
- **the trial's verdict:** at its stated end (two weeks of enrolment plus the 7 days each change is followed for) the owner sends the Chief of Staff and the session that operates the line one report with the measures and a recommendation, including when the numbers say to keep it off.
- **owner:** echo (scaling session, topic 145097). Review two weeks after the switch is turned on. If it has not been turned on 30 days after merge, the owner raises that with the session that operates the line, so the feature cannot stay dark unnoticed.

## Tests

- **Unit, the lane flow** (the existing fake-run harness, taught to honour `--exclude=`):
  - first-part composition: the change's files, then its previous failures, then the list; per-lane limits by count and by recorded time; lane membership; substring partners entering together; wildcard paths left out; an empty first part skipped;
  - every file reported once, in each of the three cases of D;
  - a first-part failure that passes alone (the lane continues; recorded as fail-then-pass);
  - one that still fails (the rest does not start; other lanes stopped; the record names the files; unrun files marked stopped, not missing);
  - more than 3 failures in a first part; 2 in the first part and 2 in the rest;
  - a failure in a file the change touched (no re-run);
  - the shared re-run budget across first parts and the rest;
  - the lane deadline covering both parts, and the rest getting what is left;
  - fail-fast off: both parts run in every lane and all failures are kept;
  - **no early pass:** for every combination of first-part and rest outcomes, a verify is recorded as passed only when every file of every lane has a passing result in its report; a clean first part with the rest not yet run, cut short, or missing a file is never a pass;
  - the equal-outcome test over every combination of passing, failing and fail-then-pass files, with a file whose tests are all skipped beside a passing file, and with a first part made only of such files while the lane's passing tests are in the rest (the rule that a lane needs at least one passed test is applied to the lane as a whole, never to a first part alone); and the stated pair where it does not hold: a first-part failure in a lane whose rest would have hung past the deadline is a failure with first parts and a retried error without;
  - two real test files where the second fails only if the first ran before it in the same process: the result with and without a first part is recorded, as documentation of the accepted risk;
  - main verifies unchanged; the switch off giving today's commands exactly;
  - a failing first part in a lane whose rest would have passed its deadline (recorded as failed, no error retry); a lane whose files all fit in its first part (completed from the one report, every file reported once);
  - `alternate`: a pull request keeps one assignment across retries, head moves and both machines; it is logged at the start; a set-up failure stays in its group; no comparison run is queued after any outcome, and no comparison state is read at boot;
  - a re-run alone cut off by another lane's failure is not counted in the list or in the change's previous failures; an unreadable list still leaves the change's own files and previous failures first;
  - minutes per change to first pass are computed by the first verify's draw; eviction at 501 files drops the oldest most-recent failure; an overlength path writes an audit row;
  - the list for a verify excludes that pull request's own failures; a path over 300 characters is left out of the request and still runs in its lane;
  - an overlap group selected from its longer path, and one from its shorter path: the group is not divided.
- **Unit, the amended verdict check:** the observation row (both groups; on the coordinator and on a peer; re-run outcomes, first-part membership, the error step, the setting at the start; an incomplete report marked; rows older than 30 days dropped; survives a restart); the report from a fixed set of observations (only the current trial; a verify assigned to first parts whose first parts were empty counts in that group; one started under `off` is left out; a file suspect at its numbers and not below them, in both directions, never a change's own test file; a red-main episode lists the commits since the last green head with their group and shows unknown for a commit without a number, a missing observation and an unreadable history; an episode begins only at a confirmed red and is written once; an unknown owes no finding; the stale-data sentence after 24 hours; OVERDUE after 3 days and not before; a recorded finding clears it; the daily evaluation runs at the first verify finished more than 24 hours after the last one and survives a restart; the start of the trial is taken from the rows; a peer's record carries the three fields, a malformed field makes the record refused as today, and a derived record takes them from the verify it was derived from, and in measure 5 a derived pass ends a change's follow-up with no minutes added while a change first verified in the pilot is not enrolled; after a switch-off the report and the evaluation on request cover the ended trial; an evaluation on request judges no limit and does not move the daily time; the file table shows how many verifies of each group ran the file's lane to the end; a marker row is written when the setting read changes, when a limit switches the setting off and when one is asked for; marker rows are not dropped; the pilot-to-joint step with the M5 continuously on `alternate` counts from the asked-for marker; a failed config write at a limit is named in the attention item and judged again; a finding in one trial does not close the same file in the next, and an explained file is opened again after 4 more different pull requests fail on it in the same group; a change that enters on day 14 and is verified again on day 20 runs as assigned and is counted, and one first seen on day 20 is not counted in measure 5; the verdict conclusion with and without a confirmed case; the final evaluation on request opens a suspect that arose since the last daily one; an unknown stays listed as unresolved and is replaced by a later finding; re-enabling after a limit switched the setting off starts the counts again; and the counts start again after it while suspects and findings stay; a switched-off mark left by the first trial is ignored); each cost limit at its boundary, below its minimum counts, with unequal group sizes (5 of 100 against 2 of 20 does not stop), and met once but not twice in a row; nothing is switched off by a red main or by a suspect.
- **Unit, the list:** counting only final failures from records; ranking by different pull requests; the 7-day window; the 500-file bound; ties; the stale, oversized and unreadable cases; the field sent with a peer verify, bounded, refused whole if malformed, omitted when empty.
- **Integration:** `GET /local-verify` fields; `GET /local-verify/first-part-report`, `POST /local-verify/first-part-report/new-trial` and `POST /local-verify/first-part-finding` on a machine that is not the coordinator (answered, not refused for want of the lease; a finding is recorded and shown; an unknown suspect, an unknown finding word and an overlong reason are refused); a recorded failure appearing in the list.
- **E2E lifecycle:** on the production wiring: the setting read live per machine, the list file written where the service reads it, an observation row written by a real verify and read back by the report, a verify handed to a peer carrying the list. A wiring test checks the list store is real and shared by the recorder and the run input.

## Risks

- **A change with two separate faults needs two verifies** when the first fault is in a first part. Measured after shipping (measure 5). Today's fail-fast has the same cost between lanes.
- **Tests that depend on their neighbours.** The test runner gives each file its own module state, but files in one process still share the machine: temporary files, ports, environment. A test that passes or fails depending on which files ran before it in the same process can change its result when the order changes. That is already true today whenever the shard plan changes with recorded times, and such a test is a defect in the test. This design does not make it worse in kind, but it is a reordering, and no cheap check can prove it absent; measure 6 says what is watched instead (the report, the suspects and their findings) and what is given up.
- **Passing verifies slow down** by the extra process starts and the serial minute on two lanes, and one near a lane deadline could go over. Bounded by the two cost limits of measure 6.
- **The list predicts worse than in the test.** Then fewer failures end early and nothing else changes.
- **The verifier's version changes** with this build, as with any change to the lane flow: both machines install together.
- **Open work in the same code.** The borrowed-machines rework (draft PR 3474) also changes the lane flow; its remaining stage is built on top of this change, not beside it.

## Frontloaded Decisions

1. Ordering only: no file is removed from a verify, and the verdict rules are the existing ones, applied to a lane in two parts as section C states.
2. The first part is part of its lane, for all three lanes, and is not a new lane.
3. The list counts final failures from verify records only, from both machines, ranks by different pull requests with no minimum, uses 90 files, and is built by the coordinator alone. A change's own previous failures also go first.
4. A first-part failure goes through the existing re-run alone before anything is stopped.
5. Main verifies are unchanged.
6. Off by default; each run machine reads its own setting, like fail-fast. With fail-fast off, nothing ends early.
8. The trial setting is `alternate`: the coordinator assigns each pull request once to with or without and carries that through every verify of it; the machine logs the assignment at the start and writes one observation row per verify; there are no comparison runs (amended 2026-11-19); the report, the suspects, the findings and the two cost limits are as measure 6 states.
7. The focused preflight is left as it is, switched off. Its code is not reused or removed here.

## Open questions

*(none)*

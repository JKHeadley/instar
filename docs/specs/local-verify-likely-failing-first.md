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
review-convergence: "2026-11-19T09:41:21.181Z"
review-iterations: 6
review-completed-at: "2026-11-19T09:41:21.181Z"
review-report: "docs/specs/reports/local-verify-likely-failing-first-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
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

It is ordering only. Every test file still runs in its own lane, with its own lane's settings, unless the verify has already failed. No file is chosen out of the run, so there is nothing to get wrong by choosing badly: a poor list only means the old timing.

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
- **A known bias, accepted.** When a verify ends in a first part, its record names only the first part's failed files; a file that would have failed later is not counted that time. The list therefore leans toward files it already holds. The change's own files and its previous failures (A.1 and A.2) are the counterweight, and measure 4 below watches for the cost.
- **Where it comes from.** The coordinator updates the list whenever it records a verify of a change, its own or one the peer ran, so both machines' failures feed one list. The list is one file, `state/local-verify/likely-failing.json`, written whole and replaced; it is read only if it is at most 1 MB.
- **Bounded and dated.** Each file keeps the pull request number and time of each of its failures in the last 7 days. The list keeps at most 500 files; when a 501st arrives, the file whose most recent failure is oldest is dropped. (The replay never reached 500 files, so this rule did not affect it.) For each verify, the coordinator takes the 90 that failed for the most different pull requests other than the one being verified (ties: most recent first), which is the rule the replay tested; that change's own previous failures enter through A.2 instead. Ranking by different pull requests, not by count, means one change verified ten times cannot lift its own file. There is no minimum: the replay above showed that requiring two different changes loses a third of the benefit. The file states when it was last updated and the oldest failure it holds. A list not updated for 7 days is treated as empty.
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
- `GET /local-verify` shows the setting, the list's size, age and top files.
- The awareness entry `src/data/awareness/local-verify-likely-failing-first.md` (short title) tells the agent the feature exists, how to read a verify that ended in a first part, and where the list is shown.
- Audit rows: `likely-failing-updated` (when the list changes), `likely-failing-unreadable`, and on each verify `first-part` with the numbers above.

## Expected benefit, and how it is measured

**The inputs, with their sources.** From the two machines' run logs since 2026-11-14: the Studio had 65 verifies that failed in a lane in 4.6 days (about 14 a day), at a median of 25 to 40 minutes depending on the lane; the M5 had 77 (about 17 a day), at about 17 minutes. Set-up before the lanes takes about 5 minutes on either machine, so a first-part failure would show at about minute 7. The line has merged 0.48 changes per verify (2026-11-16 to 11-18).

**The projection.** If first parts end 40% to 50% of lane failures at about minute 7 (the replay's historical hit rate was 53%; the share that actually ends early is for the trial to measure):

- Studio: about 14 a day, about 23 minutes saved on each one ended early: 130 to 160 minutes a day.
- M5: about 17 a day, about 10 minutes saved on each: 70 to 85 minutes a day.
- Together 200 to 245 machine-minutes a day, 8 to 9 more verifies, **about 4 more merges a day**.

This is a projection from one week of history, not a measurement.

**The cost on verifies that pass.** One more process start per lane, and, on the two slower lanes, up to 60 seconds of files run one at a time that the lane's side-by-side processes would otherwise have shared. Neither is measured in this codebase yet. A passing verify that was already close to a lane's deadline could be pushed over it, which would change its outcome from pass to error; this is the one way the design can change an outcome other than through a test that depends on its neighbours, and deadline errors are counted below.

**The measures.** Each run machine is set to `alternate` for two weeks, so pull requests fall into two groups of about equal size that cover the same days and the same suite. From the verify logs:

1. Machine-minutes per verify across all outcomes, with and without. This is the main measure.
2. Median minutes from the start of a verify to its failed verdict, for verifies that fail in a lane (now: unit 24.9, end-to-end 31.9, integration 39.6 on the Studio).
3. Median total minutes of verifies that pass (now 37.6 on the Studio, 19.3 on the M5), and the number of lane-deadline errors, in each group. Stop and switch off if the passing median is more than one minute higher with first parts than without, or if deadline errors are more frequent.
4. The share of failed verifies that ended in a first part.
5. **Machine-minutes per change, from its first verify to its first passing verify,** grouped by the pull request's assignment, counting every verify of it on either machine. Pull requests are enrolled by their first verify during the two weeks, and each is followed for the same 7 days from that verify, so late entrants are not cut short. Two numbers are compared between the groups: machine-minutes per enrolled pull request over its 7 days, and the share that reached a first pass within them. This is the measure that catches the real risk of ending early: a change with two separate faults needs two verifies, so minutes per verify can fall while minutes per change rise. Also reported: how often the next verify of the same change failed on a file that had not run (between lanes today: 3 of 19 follow-up verifies on the Studio).
6. **The verdict check, done by the verify itself.** In `alternate`, on each machine, the first 5 verifies that end in a first part, the first 5 that fail later (after their first parts were clean) and the first 5 that pass with first parts are followed by a comparison:
   - The verify is finished first: its checks, its verdict and its end time are final and are what is recorded, acted on and measured.
   - Then, in a fresh checkout of the same merge commit (so exactly the same code, in a clean state), the lanes are run once exactly as today's verifier runs them: no first part, and fail-fast as the machine has it set. So the only thing that differs between the two runs is the first parts. It has its own timing and deadlines.
   - The audit row `first-part-compare` records both verdicts, the outcome of every file that ran in both, and, separately, failures that only one of the two runs reached because the other had already stopped. Those are expected when a change has two faults, and are not a difference.
   - A difference in the verdict, or in the outcome of a file that ran in both, on a file not already known to be unreliable, switches the setting to `off` on that machine and tells the session that operates the line.
   - The comparison's machine time is reported separately and is not part of measures 1 to 3. It is one extra set of lanes for 15 verifies per machine, once.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Whether a verify fails | invariant; basis: enumerable-domain; evidence: the rules are unchanged: the same files, the same re-run-alone rule and the same fail-fast decide; this design changes when they are consulted. A test asserts that, for tests that give the same result wherever they run and for runs that finish inside their deadlines, a verify's outcome with first parts equals its outcome without, for every combination of passing, failing and fail-then-pass files in the first part and in the rest. What is not guaranteed is stated under Risks: a test whose result depends on which other files share its process can change with any reordering, this one included. | |
| Which files go in a first part | judgment-candidate; floor: only files of that lane that the verify would run anyway, within the per-lane limit; a file left out still runs. Arbiter: the change's own test files, its previous failures, then the number of different pull requests a file failed finally for in the last 7 days. Conservative default: an empty first part, which is today's behaviour. Symbol: a file's count in the list. State claimed: "this file is more likely than others to fail on the next change". Corroboration: the out-of-sample test above, repeated in the review. Unmeasurable (list unreadable or stale): empty. | |
| Whether the rest of a lane runs after its first part | invariant; basis: enumerable-domain; evidence: it runs unless the lane has failed finally by the existing rules. | |

## Fixed limits

| Limit | Value | Reason |
|---|---|---|
| First-part size | unit 80 files; integration 20 and end-to-end 12 files, each also at most 60 s of recorded time | Unit files are quick and many run at once; integration and end-to-end files run one at a time, so their first parts are held to about a minute. Starting values, revised from the measured first-part times. cheap-to-change-after |
| List used | 90 files | The replay: 60 gave 45%, 90 gave 53%, 120 gave 54%; little is gained past 90. cheap-to-change-after |
| Failures kept | 7 days, 500 files | The test used a 7-day window; 500 bounds the file |
| Ranking | by different pull requests, no minimum | A minimum of 2 lost a third of the benefit in the replay; ranking by different pull requests already stops one change lifting its own file |
| Stale list | 7 days without an update | Matches the window; an old list predicts nothing |
| Passing verifies may slow by | at most 1 minute at the median, compared within the same two weeks | The cost is a process start per lane and up to a minute of serial files on two lanes; more than a minute means the cost exceeds the design, and the switch goes off |

## Multi-machine posture

- `likely-failing.json` (on the coordinator): unified by placement. One list, built by the coordinator from every verify it records, sent to the peer with each verify. The peer never writes one.
- `monitoring.localVerify.likelyFailingFirst`: machine-local, read by each run machine for the verifies it runs, like `failFast`. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (the approved Local Verify capacity spec: run-machine settings are set per machine by the operator). The two machines may differ during the trial; the setting changes a verify's timing, and its outcome only in the two stated ways (a lane pushed past its deadline, or a test that depends on its neighbours).
- If the coordinator role moves, the new coordinator starts with its own list, empty if it has none, and rebuilds it.

## Maturation plan

- **ladder:** local-verify-likely-failing-first
- **test-agent-live:** a throwaway agent with a fake change source and real test files: a change that breaks a listed file fails in the first part and the verify ends there; a fail-then-pass file in the first part does not end it; a change whose first part is clean runs the rest and passes, each file reported once; the list is built from recorded failures and sent to a peer.
- **dev-agent-live:** the development agent's line. One trial at a time, set by the session that operates the line: on the M5 first, then the Studio, each alternating verify by verify as the measures describe.
- **graduation criterion:** for pull requests enrolled over two weeks and each followed for 7 days: machine-minutes per enrolled pull request do not rise and the share reaching a first pass does not fall; machine-minutes per verify fall; the median time to a failed verdict falls on both machines; the passing median is no more than one minute higher with first parts than without and deadline errors are no more frequent; and the verdict check (measure 6) finds no difference that is not explained by a test already known to be unreliable. Stop and switch off on the stop conditions in the measures.
- **fleet:** off by default until the two-week report; the fleet default is then proposed with the evidence and recorded on the ladder.
- **dark-window:** from merge until the operating session turns the switch on.
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
  - the equal-outcome test over every combination of passing, failing and fail-then-pass files;
  - two real test files where the second fails only if the first ran before it in the same process: the result with and without a first part is recorded, as documentation of the accepted risk;
  - main verifies unchanged; the switch off giving today's commands exactly;
  - a failing first part in a lane whose rest would have passed its deadline (recorded as failed, no error retry); a lane whose files all fit in its first part (completed from the one report, every file reported once);
  - `alternate`: a pull request keeps one assignment across retries, head moves and both machines; it is logged at the start; a set-up failure stays in its group; the verdict check runs after the verify is final, in a fresh checkout, for the first 5 of each of the three kinds (two real files where moving one into the first part makes the other fail only in the new order: the comparison detects it), never changes the recorded verdict or end time, and a difference switches the setting off; a change with one fault in each part (the full run sees both; that is not a difference);
  - a re-run alone cut off by another lane's failure is not counted in the list or in the change's previous failures; an unreadable list still leaves the change's own files and previous failures first;
  - the comparison run uses the machine's own fail-fast setting; minutes per change to first pass are computed by the first verify's draw; eviction at 501 files drops the oldest most-recent failure; an overlength path writes an audit row;
  - the list for a verify excludes that pull request's own failures; a path over 300 characters is left out of the request and still runs in its lane;
  - an overlap group selected from its longer path, and one from its shorter path: the group is not divided.
- **Unit, the list:** counting only final failures from records; ranking by different pull requests; the 7-day window; the 500-file bound; ties; the stale, oversized and unreadable cases; the field sent with a peer verify, bounded, refused whole if malformed, omitted when empty.
- **Integration:** `GET /local-verify` fields; a recorded failure appearing in the list.
- **E2E lifecycle:** on the production wiring: the setting read live per machine, the list file written where the service reads it, a verify handed to a peer carrying the list. A wiring test checks the list store is real and shared by the recorder and the run input.

## Risks

- **A change with two separate faults needs two verifies** when the first fault is in a first part. Measured after shipping (measure 5). Today's fail-fast has the same cost between lanes.
- **Tests that depend on their neighbours.** The test runner gives each file its own module state, but files in one process still share the machine: temporary files, ports, environment. A test that passes or fails depending on which files ran before it in the same process can change its result when the order changes. That is already true today whenever the shard plan changes with recorded times, and such a test is a defect in the test. This design does not make it worse in kind, but it is a reordering, so the verdict check (measure 6) samples both verifies that ended early and verifies that passed.
- **Passing verifies slow down** by the extra process starts and the serial minute on two lanes, and one near a lane deadline could go over. Bounded by the stop conditions.
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
8. The trial setting is `alternate`: the coordinator assigns each pull request once to with or without and carries that through every verify of it; the machine logs the assignment at the start, and runs the verdict check itself, after the verify is final and in a fresh checkout, on the first 5 of each kind.
7. The focused preflight is left as it is, switched off. Its code is not reused or removed here.

## Open questions

*(none)*

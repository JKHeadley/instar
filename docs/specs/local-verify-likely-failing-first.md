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

**Can the past predict the next failure? Tested, not assumed.** For each failed verify from 2026-11-15 on, I built a list from only the 7 days before it, using only other changes' failures, and asked whether the list contained a file that then failed:

| List size | Failed verifies it would have flagged | Share of those verifies' minutes |
|---|---|---|
| 40 files | 34% | 35% |
| 60 files | 42% | 44% |
| 80 files | 45% | 47% |

This leaves out one more signal that the design uses: the test files a change itself adds or edits, which are often the ones that fail.

**What was tried before.** A "fast focused preflight" was built in October to catch failures early. It chooses tests by asking the test runner which tests a change affects. In a trial on 2026-11-16 and 17 it never ran a test in 36 verifies: the question alone took over 80 seconds, it compared against the wrong starting point, and real changes exceeded its file limit. It is switched off. This design does not choose tests that way.

## Proposed design

**In one sentence:** each lane runs a small first part before the rest, made of the test files the change touches and the files that failed most often lately, so that most failures show within a couple of minutes; everything else about the verify, including its verdict, is unchanged.

It is ordering only. Every test file still runs in its own lane, with its own lane's settings, unless the verify has already failed. No file is chosen out of the run, so there is nothing to get wrong by choosing badly: a poor list only means the old timing.

### A. The first part

For each lane, before its usual processes start, one process runs that lane's **first part**:

1. **The change's own test files** in that lane: files it adds or edits, from the list of changed paths the verify already computes before the lanes start.
2. **The lane's files from the likely-failing list** (B).

Limits per lane: unit 80 files, integration 12, end-to-end 8, with the change's own files taking places first. Files that the test runner's path filter would confuse with one another stay together, as the existing shard planning already ensures. A lane whose first part would be empty skips it and starts as it does today.

The three lanes' first parts start together, as the lanes do today. The first part is part of its lane: its time is counted in the lane's time, its reports are merged into the lane's report the way shard reports are merged today, and the lane's deadline covers both parts. It is not a fourth lane.

### B. The likely-failing list

- **What counts.** A file is counted when a verify of a change **failed finally** on it: after the re-run alone, in a verify with 1 to 3 failed files, all of them real test failures. That is exactly what a verify's record already stores as `failedFiles`. A file that failed and then passed alone is not counted. Main verifies are not counted.
- **Where it comes from.** The coordinator updates the list when it records a verify, its own or one the peer ran, so both machines' failures feed one list. The list is one file, `state/local-verify/likely-failing.json`.
- **Bounded and dated.** Each file keeps the times of its failures in the last 7 days. The list keeps at most 500 files and uses the 60 with the most failures (ties: most recent first), each needing failures from at least 2 different changes, so one change failing repeatedly cannot put its own file on the list. The file states when it was last updated and the oldest failure it holds. A list not updated for 7 days is treated as empty.
- **Both machines use the same list.** The coordinator sends the current list to the peer with each verify it hands over, as the baseline for re-running failed files already travels. A peer never builds its own.
- **Lost or unreadable file.** The list is empty and the first parts hold only the change's own test files. One audit row says so. The list rebuilds as verifies are recorded.

### C. What a failure in the first part does

The first part ends, and then exactly the existing rules run, earlier than they do today:

1. **Re-run alone,** under the existing conditions and the existing budget of 3 files shared across the verify. A file that passes alone is recorded as "fail then pass", and its lane goes on to the rest of its files. So a file known to fail and then pass cannot end a verify early by itself.
2. **If the lane has failed finally** (a file still fails, or the failure is not eligible for a re-run), the lane does not start the rest of its files, and the existing fail-fast stops the other lanes. The verify ends as failed.

The verify's record names the first part's failed files, and marks the lane as stopped early, in the way a lane stopped by fail-fast is marked today, so the files that did not run are not reported as missing.

**All of a first part's failures are reported together.** The first part runs to its end before anything is stopped.

### D. The rest of the lane

The lane's usual processes then run every file that was not in the first part. Where a lane's files are given to its processes as lists, the first part's files are left out of the lists; where a lane lets the test runner split the files, the first part's files are excluded by name. Either way each file is reported once, which the existing check requires.

### E. Where it applies

- **Verifies of changes only.** A main verify always runs everything and never stops early, so a first part would only add a process start. Main verifies are unchanged.
- **Off by default.** `monitoring.localVerify.likelyFailingFirst` is `off` or `on`; absent means `off`. It is read at the start of each verify. With it off, a verify runs exactly as today and the list is still kept up to date, so it is ready when the switch is turned on.
- **Peer runs** use the coordinator's setting, sent with the verify, so the two machines never disagree about one verify.

### F. What is recorded

- In the verify's log: the first part's files per lane, how many came from the change and how many from the list, the first part's time, and whether the verify ended there.
- `GET /local-verify` shows the setting, the list's size, age and top files.
- Audit rows: `likely-failing-updated` (when the list changes), `likely-failing-unreadable`, and on each verify `first-part` with the numbers above.

## Expected benefit, and how it is measured

**The projection.** If the first parts surface 42% of lane failures (the out-of-sample figure for a 60-file list, before counting the change's own test files) at about minute 7 instead of the present 25 to 40 on the Studio and about 17 on the M5:

- Studio: about 14 lane failures a day, about 23 minutes saved on each one caught: about 135 minutes a day.
- M5: about 17 a day, about 10 minutes saved on each one caught: about 70 minutes a day.
- Together about 205 machine-minutes a day, about 8 more verifies, **about 4 more merges a day** at the measured 0.48 merges per verify.

This is a projection from one week of history. The change's own test files should add to it; a list that predicts worse than it did in the test would subtract.

**The cost.** One extra test-process start per lane on every verify of a change. Its size is not measured in this codebase; it is the first thing the trial measures.

**The measures**, taken from the verify logs for two weeks with the switch on, against the two weeks before:

1. Median minutes from the start of a verify to its failed verdict, for verifies that fail in a lane (now: unit 24.9, end-to-end 31.9, integration 39.6 on the Studio).
2. Median total minutes of verifies that pass (now 37.6 on the Studio, 19.3 on the M5). This must not rise by more than one minute.
3. The share of failed verifies that ended in a first part.
4. How often the next verify of the same change failed on a file that had not run. This is the cost of ending early: a change with two separate faults needs two verifies.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Whether a verify fails | invariant; basis: enumerable-domain; evidence: unchanged. The same files, the same re-run-alone rule and the same fail-fast decide; this design changes only when they are consulted. A test asserts that a verify's outcome with the switch on equals its outcome with the switch off for every combination of passing, failing and fail-then-pass files in the first part and in the rest. | |
| Which files go in a first part | judgment-candidate; floor: only files of that lane that the verify would run anyway, within the per-lane limit; a file left out still runs. Arbiter: the change's own test files, then the count of final failures from at least 2 changes in the last 7 days. Conservative default: an empty first part, which is today's behaviour. Symbol: a file's count in the list. State claimed: "this file is more likely than others to fail on the next change". Corroboration: the out-of-sample test above, repeated in the review. Unmeasurable (list unreadable or stale): empty. | |
| Whether the rest of a lane runs after its first part | invariant; basis: enumerable-domain; evidence: it runs unless the lane has failed finally by the existing rules. | |

## Fixed limits

| Limit | Value | Reason |
|---|---|---|
| First-part size | unit 80, integration 12, end-to-end 8 | Unit files are quick and many run at once; integration and end-to-end files run one at a time, so their first parts are kept to about a minute. Starting values, revised from the measured first-part times. cheap-to-change-after |
| List used | 60 files | The out-of-sample test: 60 flagged 42%, 80 flagged 45%; little is gained past 60. cheap-to-change-after |
| Failures kept | 7 days, 500 files | The test used a 7-day window; 500 bounds the file |
| Different changes needed | 2 | One change failing repeatedly on its own file is not evidence about other changes |
| Stale list | 7 days without an update | Matches the window; an old list predicts nothing |
| Passing verifies may slow by | at most 1 minute at the median | The cost is a process start per lane; more than a minute means something else is wrong, and the switch goes off |

## Multi-machine posture

- `likely-failing.json` (on the coordinator): unified by placement. One list, built by the coordinator from every verify it records, sent to the peer with each verify. The peer never writes one.
- `monitoring.localVerify.likelyFailingFirst`: read by the coordinator and carried with each verify, so it is one setting in effect for the line. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (run-machine dispatch settings are set per machine by the operator); only the coordinator's value is used.
- If the coordinator role moves, the new coordinator starts with its own list, empty if it has none, and rebuilds it.

## Maturation plan

- **ladder:** local-verify-likely-failing-first
- **test-agent-live:** a throwaway agent with a fake change source and real test files: a change that breaks a listed file fails in the first part and the verify ends there; a fail-then-pass file in the first part does not end it; a change whose first part is clean runs the rest and passes, each file reported once; the list is built from recorded failures and sent to a peer.
- **dev-agent-live:** the development agent's line. One trial at a time, set by the session that operates the line: on for verifies the M5 runs first, then both.
- **graduation criterion:** over two weeks: the median time to a failed verdict falls on both machines; the median passing verify rises by no more than one minute; no verify's outcome differs from what the full run would have given (checked on a sample of failed-early verifies re-run in full). Stop and switch off if passing verifies slow by more than a minute, or if any outcome differs.
- **fleet:** off by default until the two-week report; the fleet default is then proposed with the evidence and recorded on the ladder.
- **dark-window:** from merge until the operating session turns the switch on.
- **owner:** echo (scaling session, topic 145097). Review two weeks after the switch is turned on.

## Tests

- **Unit** (the existing fake-run harness for the lane flow): the first part's composition (the change's files first, the per-lane limits, lane membership, path-filter groups kept together, an empty first part skipped); each lane's reports merged with every file reported once, for lanes run from lists and for lanes the runner splits; a first-part failure that is re-run alone and passes (the lane continues, the file is recorded as fail-then-pass); one that still fails (the rest does not start, the other lanes are stopped, the record names the files and marks the lane stopped early); more than 3 failures in a first part; a failure in a file the change touched (not eligible for a re-run); the shared re-run budget across first parts and the rest; the lane deadline covering both parts; the equal-outcome test over every combination; main verifies unchanged; the switch off giving today's commands exactly.
- **Unit** (the list): counting only final failures from records; the 2-changes rule; the 7-day window; the 500-file bound; ties; the stale and unreadable cases; the list sent with a peer verify and refused if malformed.
- **Integration:** `GET /local-verify` fields; a recorded failure appearing in the list.
- **E2E lifecycle:** on the production wiring: the setting read live, the list file written where the service reads it, a verify handed to a peer carrying the list. A wiring test checks the list store is real and shared by the recorder and the run input.

## Risks

- **A change with two separate faults needs two verifies** when the first fault is in a first part. Measured after shipping (measure 4). Today's fail-fast has the same cost between lanes; the measured rate there is 3 of 19 follow-up verifies.
- **Passing verifies slow down** by the extra process starts. Bounded by the one-minute stop condition.
- **The list predicts worse than in the test.** Then fewer failures end early and nothing else changes.
- **The verifier's version changes** with this build, as with any change to the lane flow: both machines install together.
- **Open work in the same code.** The borrowed-machines rework (draft PR 3474) also changes the lane flow; its remaining stage is built on top of this change, not beside it.

## Frontloaded Decisions

1. Ordering only: no file is removed from a verify, and the verdict rules are untouched.
2. The first part is part of its lane, for all three lanes, and is not a new lane.
3. The list counts final failures from verify records only, from both machines, needs 2 different changes per file, and is built by the coordinator alone.
4. A first-part failure goes through the existing re-run alone before anything is stopped.
5. Main verifies are unchanged.
6. Off by default; the coordinator's setting is carried with each verify.
7. The focused preflight is left as it is, switched off. Its code is not reused or removed here.

## Open questions

*(none)*

# Convergence Report — Local Verify: run the test files most likely to fail first

**Spec:** [docs/specs/local-verify-likely-failing-first.md](../local-verify-likely-failing-first.md)
**Slug:** `local-verify-likely-failing-first`
**Converged at:** 2026-11-19 (round cap, Tier 2: 6 rounds)
**Iterations:** 6
**Final-round design findings:** 3, all from the outside-model reviewer, each applied in one edit at the cap and not re-reviewed. None concerns safety, security or data loss (see Convergence Verdict).

## Cross-model review: codex-cli:gpt-6.2-astra

The GPT-tier pass ran through the codex CLI in all six rounds. The six internal lenses ran as one combined Claude subagent on the authoring session's model, Claude Fable 5.2, in rounds 1 and 2 (4 design findings, then 1). Rounds 3 to 6 were outside-model rounds on small edits. The Standards-Conformance Gate ran in rounds 1, 2 and 4, and was not run in rounds 5 and 6.

---

## ELI10 Overview

Every change to Instar is tested on our two computers before it can be merged, and a full test run takes 20 to 40 minutes. When a change fails its tests we only find out when a whole group of tests has finished. Measured on the Studio, four of every ten test minutes go to runs that fail, and each takes 25 to 40 minutes to say so. Yet two thirds of failing runs fail on a single test file, and the same few dozen files fail again and again.

This design makes each group of tests start with a small first part: the test files the change itself touches, the files that same change failed on last time, and the files that failed most often for other changes in the last week. If one of them fails, and still fails when run again by itself, the run ends there. Otherwise the rest runs as usual. Nothing is left out of a run, and the rules that decide pass or fail are the existing ones. Only the order changes, so a bad guess about which files go first costs nothing.

An earlier attempt at the same goal tried to work out which tests a change affects, and never managed to run a test in its trial. This design does not choose tests that way.

The expected gain is about 4 more merged changes a day, a projection from one week of history. The trial is built to check it honestly: half of the changes get the first part and half do not, at random, and the deciding numbers are the machine time each change needs to reach its first pass and how many reach it.

## Original vs Converged

- **The list rules were chosen by replaying history, and changed.**
  - Originally: a 60-file list, a file needing failures from two different changes.
  - After review and a replay of the exact rules on both machines' logs: 90 files, ranked by how many different changes a file failed for, no minimum, and the same change's previous failures added. Why: the two-changes minimum cut the hit rate from 45% to 32%; the final rule reached 53% on the replay.
- **The existing rules are now spelled out for a group that runs in two parts.**
  - Originally: "exactly the existing rules run".
  - After review: applied literally, the existing code would have refused every second chance in a first part and failed to name the failed files of a run cut short. The spec now says how each rule applies per part.
- **"The verdict cannot change" was narrowed to what is true.**
  - The rules do not change. Two things can still differ: a test whose result depends on which other tests share its process, and a run pushed past or stopped before a deadline. Both are stated, and the trial checks a sample of runs the old way.
- **The cost on passing runs is stated and bounded.**
  - The two slower groups' first parts are capped at 60 seconds of recorded time, and the trial stops if passing runs slow by more than a minute or deadline errors rise.
- **The trial measures the right thing.**
  - Originally: minutes per failing run, before and after.
  - After review: changes are assigned once, at random, to with or without the first part; each is followed for the same 7 days; the deciding numbers are machine-minutes per change and the share that reach a first pass. Why: a change with two faults could fail twice quickly, so minutes per run can fall while the real cost rises.
- **The comparison of verdicts is done by the system itself,** after a run is final, in a fresh checkout of the same code, for the first runs of three kinds, with the only difference being the first part.

## Experience fit

- **The goal, from the operator of the line.** The throughput session's reply to the idea (agent message 0834ae7b, 2026-11-19 01:35 PST): "yes, spec it. Ordering keeps the full run as the only verdict, so none of the preflight defects apply", with four points: a known fail-then-pass file must not end a run early by itself; count the first part inside the unit lane; the list comes from both machines' records, is bounded and says its age; measure minutes to the first failure and total minutes on passing verifies.
- **The ordinary journey.** Nothing changes for an author. A failing change learns of its failure in minutes. The operator turns one switch on per machine and reads one report.
- **Contrasting cases checked.** An unreliable test in the first part (it gets its second chance first); a change with two faults (measured per change, not per run); fail-fast switched off (nothing ends early); the peer machine (uses the coordinator's list and assignment).
- **Evidence and limits.** The 41% figure and the lane medians are measured from run logs. The 53% is historical coverage on a replay whose list size was chosen on the same data. The extra start-up cost per group is not measured yet. The projection of about 4 merges a day is a projection.
- **Disposition.** All four of the operator's points are in the text.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | internal (combined), codex | 4 internal, 3 codex | 15 | A to E rewritten, benefit, measures, tests |
| 2 | internal (combined), codex | 1 internal, 3 codex | 7 | Setting values, draw, verdict check, path groups |
| 3 | codex | 4 | 1 | Verdict check, list per pull request, request bounds |
| 4 | codex | 3 | 1 | Comparison rule, measure per change, eviction |
| 5 | codex | 3 | 1 | Assignment per pull request, failure precedence, whole-lane first part |
| 6 | codex | 3 | 2 | Sampling of the comparison, cut-off re-runs, follow-up period |

Standards-Conformance Gate: ran in round 1, round 2 (8 flags) and round 4 (9 flags); not run in rounds 3, 5 and 6. Its remaining flags are fixed starting values (answered as starting values revised from the trial), the dark window (answered: the owner raises it at 30 days), and the visibility of trial results (the two-week report).

## Full Findings Catalog

Full texts are in the agent home under `.instar/state/scaling/converge-lff/` (`r1-review.md`, `r2-review.md`, `r1..r6-codex.json`, `r1/r2/r4-gate.json`). Design findings by round:

- **Round 1.** The existing rules were not defined per part and the run evaluation needed a change; the cost on the two sharded groups was understated; "the verdict cannot change" was too strong; the setting contradicted the trial plan (internal). Process-local state changing a verdict; single-process first parts and deadlines; fail-fast off (codex). Resolved.
- **Round 2.** No setting turned the alternating trial on and its draw was not recorded (internal). Path overlap could run a file twice; the verdict check had no way to get an independent verdict; trial assignment ambiguous (codex). Resolved.
- **Round 3.** The comparison would flag a two-fault change; it would be charged to the optimised runs and could disturb their checks; the replayed ranking differed from the specified one; overlength paths (codex). Resolved.
- **Round 4.** The comparison changed two things at once; minutes per run could reward a regression; eviction unspecified (codex). Resolved.
- **Round 5.** A failure hiding a later deadline; assignment per verify not per change; a lane wholly inside its first part (codex). Resolved.
- **Round 6 (cap).** The comparison did not sample runs that fail after a clean first part; cut-off re-runs should not feed the list; unequal follow-up periods (codex). All three applied; not re-reviewed.

## Proportion

Tier 2 (changes the order and early-end behaviour of the merge gate's test run); the spec is about 230 lines. Six rounds used of a cap of six. As with the two designs before it, the internal reviewer was nearly done by round 2 and the later rounds were one reviewer tightening the trial's method, which is where this design's risk lies.

## Left behind

- The first-part sizes, the 90-file list, the 7-day window and the one-minute slowdown line are starting values, revised from the trial.
- The start-up cost of an extra test process per group is unmeasured until the trial.
- A test that depends on its neighbours can change result under any reordering; accepted and sampled.
- The list leans toward files it already holds after early ends; the change's own files and previous failures are the counterweight.
- A legitimate path over 300 characters is left out of the peer's list (with an audit row) and runs in its group as usual.
- Rounds 3 to 6 were not seen by the internal reviewer; rounds 5 and 6 were not seen by the gate.

## Convergence Verdict

Converged at the round cap (round 6). The outside-model reviewer raised three design-class points in the final round; none is about safety, security or data loss (all three concern how the trial samples and counts), and all three are in the text. `## Open questions` is empty.

The spec is ready for the Chief of Staff's review. What needs approval by name: the merge gate's test run may end as failed after a group's first part, by the existing second-chance and stop-on-failure rules applied earlier, on machines where the operator turns it on.

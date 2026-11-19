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

## After approval (2026-11-19 01:44 PT)

The Chief of Staff approved with three conditions, all applied: the constitution check was run on the final text (7 flags: the fixed starting values and stop lines, the read and path-length bounds, the number of comparison runs, and the trial's place on the maturation path; each is a starting value revised from the trial or is answered in the spec; one flag claimed the equal-outcome property fails when three first-part files and one later file all fail and then pass alone, which was checked: both orders fail that verify, because more than three files failed); "a pass is declared only after every test in the run has passed" is now a stated and tested property; and the trial's verdict goes to the Chief of Staff and the throughput session at its stated end, including when the numbers say keep it off.

---

# Amendment review (2026-11-19): the verdict check, amended

**What was reviewed:** only the amendment: the section "The verdict check, amended (2026-11-19)" and the lines changed to match it. The rest of the spec was converged and approved earlier the same day and its code is merged.
**Converged at:** 2026-11-19, at the round cap (Tier 2: 6 rounds).
**Final-round design findings:** 0 from the internal reviewer, 3 from the outside-model reviewer, each applied in one edit at the cap and not re-reviewed. None concerns safety, security or data loss; all three are about how well the trial measures.

## Cross-model review: codex-cli:gpt-6.2-astra

The GPT-tier pass ran through the codex CLI in all six rounds, on the whole spec each time. Before the formal rounds, the same outside model analysed the two defects from the code and reviewed four drafts of the amendment (three objections, then a concur). The six internal lenses ran as one combined Claude subagent in every round. The Standards-Conformance Gate ran in rounds 1 to 6 (8, 8, 5, 8, 7 and 5 flags).

## ELI10 Overview

The first trial of "likely-failing files first" ran for 36 minutes on one machine and switched itself off. The idea did not fail; its safety check did. That check ran the same change a second time, the old way, to see whether the answer matched. It took the machine out of the test line for 18 minutes while 15 changes waited, and it ended the trial because one unreliable test failed in one run and passed in the other.

The amendment removes those second runs. What stays is the rule that a run is only recorded as passed after every test file passed, which is built in and tested. What is added costs no test time: each machine writes one line per run, lists each day anything that looks lopsided between the runs with and without the new order, and lists every time the main branch went red after a change that had passed with the new order. Each such "suspect" must get a written finding within 3 days from the session that runs the test line, with the investigation done by the feature's owner away from the line. One confirmed case ends the trial on both machines. Two automatic limits on cost remain.

What is given up, and said in the spec: proof, run by run, that the answer is the same. The first trial showed the second runs could not give that proof either.

## Experience fit

The request behind this is the operator's condition, in its words: "a comparison run must not delay a fronted change and must not run when the queue holds more than a few waiting changes" (echo-increasing-throughput, 2026-11-19 14:04Z), and the Chief of Staff's choice of "no cost to the line" over "proof per verify" (2026-11-19 06:36 PT). The ordinary case after the amendment: a two-week trial in which no machine leaves the line and nobody is asked anything unless a suspect appears. The reviewers found the fit good from round 2 on.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Sections changed |
|-----------|-------------------------------------|-----------------|---------------------|------------------|
| 1 | internal (combined), codex | 6 internal, 3 codex | 7 | Report route on every machine, findings kept per machine, red-main episodes defined and stored, removal list completed, awareness entry, overview |
| 2 | internal (combined), codex | 3 internal, 3 codex | 5 | The three fields travel in the signed record, derived records, trial marker, pilot then both machines |
| 3 | internal (combined), codex | 1 internal, 3 codex | 3 | How a cost limit switches off, marker kept, joint-trial marker, findings per trial, verdict conclusion from findings |
| 4 | internal (combined), codex | 1 internal, 3 codex | 2 | Counts after any marker, derived pass in measure 5, final evaluation, meaning of unknown |
| 5 | internal (combined), codex | 2 internal, 3 codex | 2 | Report of an ended trial, evaluation on request judges no limit, how often a file ran, enrolment |
| 6 | codex | 3 | 6 | A closed suspect opens again on new failures, enrolment and follow-up dates, how often a file ran (from first-part lists), wording of the first trial's defect |

Standards-Conformance Gate: ran (8 flags), ran (8 flags), ran (5 flags), ran (8 flags), ran (7 flags), ran (5 flags). In round 1 two flags concerned the amendment and were taken: investigation on a line machine is now allowed when the operating session permits it and nothing waits; the two attributed statements now carry the speaker's words and message reference. Every other flag, in every round, is about limits of the design converged before the amendment (list size, lane ceilings, history window, path length, the staging by machine); they were answered in the first convergence as starting values that the trial revises, and the amendment does not change them.

## Full Findings Catalog

Each round's files are kept outside the repository, in the authoring agent's state folder `state/scaling/converge-lff-amend/` (`r1` to `r6`: spec text, internal review, outside review, gate result), with the four pre-round drafts and their reviews.

- **Round 1.** Internal: the report could not be read on a machine that is not the coordinator; findings and suspects lived on different machines; nearly every red main would have been a suspect; eight points a builder would have had to ask; the removal list was incomplete and the awareness text would have described a removed check; the overview contradicted itself. Outside: a deadline case where the outcome differs with first parts (failed, against a retried error) was not stated; a suspect on the helper machine had no way to a finding; measure 5 under a staged start; the wording of the pass rule. All taken.
- **Round 2.** Internal: the three fields needed a named carrier (the signed record); the maturation plan contradicted measure 5; what a restart of the trial does to the counts. Outside: the lane rule for a first part with only skipped tests (checked in the code: the shipped code applies it to the whole lane; a test is added); a durable start of the trial; records derived without a run. All taken.
- **Round 3.** Internal: how a cost limit switches the setting off, with the cost of having no second hold file stated. Outside: an explicit start for the joint trial; a finding per trial; the verdict's conclusion written from the findings. All taken.
- **Round 4.** Internal: counts start after a marker of any kind. Outside: a derived pass in measure 5; a final evaluation before the verdict; what "unknown" means and who pauses the trial over two machines. All taken.
- **Round 5.** Internal: the report after a switch-off covers the ended trial; an evaluation on request judges no limit. Outside: the same first point; how often a file ran in each group; enrolment only of changes first verified in the joint period. All taken.
- **Round 6.** Internal: converged, no material finding. Outside: three design findings, applied at the cap (below).

## Proportion

Tier 2; the amendment adds about 50 lines to the spec and removes more machinery than it adds (the comparison runs, their state, their limits and their switch). 6 rounds used of 6. ⚠ The outside reviewer read the whole spec each round and raised about three new points every round, so the count of rounds reflects the reviewer's reach more than the size of the change.

## Left behind

- **Applied at the cap without a further round (design, accepted):** a closed file suspect is opened again after 4 more different pull requests fail on it in the same group (reason: a finding must not outlive its evidence; the number is a starting value); both machines stay on `alternate` through the 7-day follow-up and only enrolled changes count in measure 5 (reason: otherwise late entrants are verified differently); how often a file actually ran is taken from the first-part lists and lane completion already recorded, with unknown shown as unknown (reason: full per-file run records for every verify would be a large new data set for a reading aid).
- **Precision, not iterated:** part D defines the current trial twice in slightly different words; "the trial that ended at that marker" is loosely worded for the minutes after a switch back on; one test clause uses "it" without a noun.
- **Not taken, stated limit:** counting how often a file ran is approximate when a verify's report is incomplete.
- **Gate flags on the first design** (list size, lane ceilings, history window, path limits, staging by machine): unchanged by the amendment; they remain starting values the trial revises.

## Convergence Verdict

Converged at round 6, at the cap. The internal reviewer's final round found nothing that changes what gets built. The outside reviewer's final round had three design findings about the trial's measurement, each applied in one edit; none concerns safety, security or data loss. Approved in substance by the Chief of Staff before the rounds (agent message a2cef9bf, 2026-11-19 06:36 PT) with three conditions, all in the text: the tested pass rule stays untouched; the 3-day finding has a named owner (the session that operates the line, which accepted it in agent message c99b215a) and an overdue finding shows in the report; the formal rounds and the constitution check ran before any build.

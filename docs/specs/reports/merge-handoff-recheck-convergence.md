# Convergence Report — Merge hand-off: look again when GitHub was not ready

**Spec:** [docs/specs/merge-handoff-recheck.md](../merge-handoff-recheck.md)
**Slug:** `merge-handoff-recheck`
**Converged at:** 2026-11-19 (round cap, Tier 2: 6 rounds)
**Iterations:** 6
**Final-round design findings:** 0 from the internal reviewer, 3 from the outside-model reviewer, each applied in one edit at the cap and not re-reviewed. None concerns safety, security or data loss: they are about one breaker's count and about how the result is measured.

## Cross-model review: codex-cli:gpt-6.2-astra

The GPT-tier pass ran through the codex CLI in all six rounds. The six internal lenses ran as one combined Claude subagent in rounds 1, 2, 3 and 6. The Standards-Conformance Gate ran in rounds 1 to 6.

## ELI10 Overview

When a change passes its tests, the system tries to merge it at once so that the next change is tested on top of it. One time in five that does not happen. The largest group of those cases got the answer "not mergeable" and was merged a little later, unchanged, some of them by hand. The likely reason is that GitHub had not yet worked out whether the change could be merged.

The change: in exactly that case, the merger asks GitHub about that one change again after 5, 10 and 15 seconds, and goes ahead with the merge as soon as GitHub says yes. Every safety check runs as before. A change that really conflicts is never asked about again.

Because the reason is likely but not proven, the first step only records GitHub's exact answer with the waiting switched off. The waiting is switched on only if the record confirms the reason; otherwise the change is removed.

## Original vs Converged

The first draft repeated the whole merge pass up to three times within a minute, for three kinds of miss. Review showed that a whole pass does much more than look at one change (it would have held the test queue for two to three minutes and moved other changes' bookkeeping), and that two of the three kinds had unproven causes. The converged design covers one kind only, re-reads one change inside the same pass, and keeps the merger's single ownership while it waits, so no other merge round can run underneath it.

## Experience fit

The request is the line operator's: "a retry for merge hand-offs that did not act", after five hand merges on 2026-11-19, and its later words that the retry is "a small PR worth doing soon". The ordinary case after the change: a green change whose merge GitHub was not ready for merges by itself within half a minute and nobody is told. Nothing new is asked of anyone, except one switch flipped by the operator after the baseline.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Sections changed |
|-----------|-------------------------------------|-----------------|---------------------|------------------|
| 1 | internal (combined), codex | 7 internal, 3 codex | 10 | The whole design narrowed: one reason, one re-read inside the same pass |
| 2 | internal (combined), codex | 3 internal, 3 codex | 7 | Checks applied to a change that becomes eligible late; what "recovered" means; cost figures |
| 3 | internal (combined), codex | 0 internal, 3 codex | 5 | The read the pass already makes is used first; first value recorded; overview |
| 4 | codex | 3 | 1 | One rule for every read; a hold put on during the waits; missing first value; minimum count for graduation |
| 5 | codex | 3 | 1 | The pass keeps single ownership through the waits (replaces save and reload); baseline decision |
| 6 | codex | 3 | 8 | Marker handed to the merge attempt; busy breaker wording; who counts as having met UNKNOWN; start time on every row |

Standards-Conformance Gate: ran (6 flags), ran (3 flags), ran (4 flags), ran (5 flags), ran, ran. Flags taken: the cause is stated as likely and recorded before the switch goes on; the graduation result needs a minimum count; an unswitched feature is raised every 30 days. Flags answered and left: the exact waits and counts are starting values revised from the recorded rows at the review; there is no chart of the counts, only the status and the audit rows (a chart for one counter is out of proportion).

## Full Findings Catalog

Each round's files are kept outside the repository, in the authoring agent's state folder `state/scaling/converge-recheck/` (`r1` to `r6`: spec text, internal review where one ran, outside review, gate result).

- **Round 1.** Internal: each further ask would have been a whole pass (cost understated, other changes' hold bookkeeping advanced, longer holds causing more skipped hand-offs); nothing ended the asks once the queue's hold was gone; "not listed" has causes a re-ask cannot fix; the place of the loop left its interface undecided; one sentence about the breaker was wrong. Outside: 60 seconds was not the real hold time; a re-ask of a failed list could open the breaker; counting final misses could credit the feature wrongly. Taken by narrowing the design.
- **Round 2.** Internal: the lease is not read again by a merge attempt; the pass's state copy across a wait; the checks that only eligible changes get had been skipped for this change. Outside: what 30 seconds bounds; the cost of a recovered hand-off; a late merge is not a recovery. All taken.
- **Round 3.** Internal: converged. Outside: reuse the read the pass already makes; record GitHub's first value; state the measured facts without attributing them. All taken.
- **Round 4.** Outside: a hold put on during the waits; one rule for every read; an absent first value. All taken.
- **Round 5.** Outside: state ownership on immediate endings; a regular round starting between checks; the baseline had no decision. Taken by keeping single ownership through the waits and by the baseline rule.
- **Round 6.** Internal: converged, wording only. Outside: three design findings, applied at the cap (below).

## Proportion

Tier 2 (it changes when a merge is attempted). The change itself is small: one branch in the merger's hand-off pass, one switch, three counts. 6 rounds used of 6. ⚠ The rounds were spent on a first design that was too wide; the lesson (measure what one more whole pass does before proposing to repeat it) is recorded in the scaling project's notes.

## Left behind

- **Applied at the cap without a further round (design, accepted):** a round skipped during the waits leaves the busy breaker's count unchanged, and the spec now says so (reason: the breaker exists to notice a stuck attempt, and this wait ends within a minute by itself); only hand-offs refused as not mergeable with GitHub's value `UNKNOWN` count as having met it (reason: the measure must cover only what the feature can recover); the hand-off's start time is passed to the merger and written on every row (reason: the counts must be rebuildable from the log).
- **Precision, not iterated:** the exact name of the field that carries the number of reads; whether "half" in the baseline rule should be a different share (a starting value, stated as such).
- **Out of scope, in the scaling project's list:** the other kinds of miss (status pending, missing from the list, failed list).

## Convergence Verdict

Converged at round 6, at the cap. The internal reviewer's final round found nothing that changes what gets built. The outside reviewer's final round had three design findings, each applied in one edit; none concerns safety, security or data loss. The spec is ready for approval.

## After approval (2026-11-19 07:52 PT)

Approved by the Chief of Staff with two conditions. (1) The constitution check ran on the final text (4 flags): the exact waits and thresholds are starting values (answered in the spec: revised from the recorded rows); the baseline's "half" was a mandate and is now the default of a decision the operating session takes on the reported counts (taken); "unknown" was described as "still computing" and now claims only that GitHub has not supplied its answer (taken); there is no chart or recurring review after graduation (left: the 7-day review and the status counts are the instrument for a change of this size). (2) The re-read change goes on through the same checked merge path as every hand-off: part A step 3 and part B state it, and a test asserts it.


# Convergence Report — Local Verify: the oldest waiter takes the next free place

**Spec:** [docs/specs/local-verify-oldest-waiter-first.md](../local-verify-oldest-waiter-first.md)
**Slug:** `local-verify-oldest-waiter-first`
**Converged at:** 2026-11-19 (round cap, Tier 2: 6 rounds)
**Iterations:** 6
**Final-round design findings:** 0 from the internal reviewer (its last round, round 5, found none), 3 from the outside-model reviewer in round 6: two applied in one edit each at the cap, one recorded below as outside this change. None concerns safety, security or data loss.

## Cross-model review: codex-cli:gpt-6.2-astra

The GPT-tier pass ran through the codex CLI in all six rounds. The six internal lenses ran as one combined Claude subagent in rounds 1 to 5. The Standards-Conformance Gate ran in rounds 1 to 6.

## ELI10 Overview

The line of changes waiting to be tested holds 10, plus 5 extra places for changes with a priority label. When it is full, a change is turned away and must ask again. On 19 November, 15 changes had been turned away for between 4 and 26 hours, while in the same day 96 changes were let into the extra places, every one of them labelled and none of them a change that had been waiting. A rule meant to prevent this exists, but it only lets an old waiter compete for a free place, and the waiter lost every time.

The change adds one count at the door: a change is let in only if room is still left for every change that has waited longer than it and for more than 90 minutes. The label still puts a change ahead of ordinary recent work and opens the extra places; it no longer takes the last place an older waiter is due. Putting a change at the front by hand still works.

It is off until the person running the line turns it on. From the day it is installed it records, for every change let in or turned away, what is needed to check the picture above and to compare before and after.

## Original vs Converged

The first draft kept the whole door for the oldest waiter (any older waiter blocked every newcomer) and added a second topic, the order of several changes put at the front by hand. Review showed that the first would have cut admissions to one per round and could idle a machine, and that the second was growing into its own design. The converged rule counts older waiters against the room that is left, is set aside when a machine would otherwise have nothing to do, leaves today's reservation below 10 exactly as it is, and the front-order topic is a separate later change.

## Experience fit

The request is the line operator's, in its words: "I do not want to run fairness from memory", and its suggested rule, "each free queue place goes to the oldest live waiter before any new request, with fronts as the only exception". The ordinary case after the change: nobody is asked anything; old waiters are admitted as places come free; the operator's front is still there for what must go now. What the operator meets that is new: labelled changes wait while old waiters are admitted, which is the intent.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Sections changed |
|-----------|-------------------------------------|-----------------|---------------------|------------------|
| 1 | internal (combined), codex | 7 internal, 4 codex | 7 | The rule counts waiters against free places; idle rule; re-run after green exempt; route and status keys; what is recorded |
| 2 | internal (combined), codex | 2 internal, 4 codex | 9 | Capacity checked first; the count replaces the old test for aged waiters; what "out of order" means; idle test and peer eligibility |
| 3 | internal (combined), codex | 1 internal, 4 codex | 8 | One formula; the front-order part taken out; the uncovered idle sequence stated |
| 4 | internal (combined), codex | 1 internal, 4 codex | 9 | Examples and tests made to follow from the steps; when the idle mark is set; class recorded on refusals |
| 5 | internal (combined), codex | 0 internal, 3 codex | 5 | The cap comes before the idle exception; idle time read from the operator's count |
| 6 | codex | 3 | 1 | The idle guarantee narrowed to the new count; the switch and the would-refuse answer on every row |

Standards-Conformance Gate: ran (4 flags), ran (5 flags), ran (5 flags), ran (10 flags), ran (6 flags), ran (7 flags). Taken from the last run: the risks section claimed more than part B about idle machines (made exact); the fix could stay switched off without end (now a 3-day baseline, then the ask for the switch, then the Chief of Staff at 14 days). Left, as existing limits this change does not set: the 90 minutes, the 30 minutes, the cap of 10 and the 5 extra places, the two attempts on the peer.

## Full Findings Catalog

Each round's files are kept outside the repository, in the authoring agent's state folder `state/scaling/converge-door/` (`r1` to `r6`: spec text, internal review, outside review, gate result).

- **Round 1.** Internal: the rule reserved the whole door for one waiter; the re-run after `main` turns green was not exempt; "empty for up to 10 minutes" was 30; the front flag could not be a lower number; the route was misnamed; the status fields had no place; the graduation measure was not computable. Outside: a verifier idling behind a reservation; a released change's promise; the front route; what is recorded. All taken.
- **Round 2.** Internal: the old test for an aged waiter would still refuse the younger of two with two places free; "out of order" counted permitted admissions. Outside: a refusal naming a blocker that does not exist; the same point on "out of order"; the idle test and peer eligibility; a deferred release. Taken.
- **Round 3.** Internal: a released change "counting as older without ageing" had no carrier. Outside: surplus places left unused; an idle verifier after a refusal; `main`'s health in the measure and a week with no contested place; the front list. Taken; the front-order part was taken out of this spec.
- **Round 4.** Internal: one example and one test contradicted the kept reservation. Outside: the same; the released change; when the idle mark is set; request class on refusals. Taken, except the released change (below).
- **Round 5.** Internal: converged. Outside: the cap against the idle exception; measuring idle time; the released change. The first two taken.
- **Round 6.** Outside: the idle guarantee against today's reservation below 10 (narrowed to the new count, in one edit); what the before-and-after comparison is read from (the switch and the would-refuse answer are now on every row; idle minutes come from the operator's own count, in one edit); the released change (below).

## Proportion

Tier 2 (it changes which change is admitted to the test queue). The change itself is one count in the request path, a switch, and fields on audit rows. 6 rounds used of 6. ⚠ The rounds were spent because the first draft was too broad and carried a second topic; both were corrected by round 3.

## Left behind

- **Design, outside this change (raised in rounds 2 to 6):** queue controls promises a change the operator released while the operator's extra places were full "the next free place". As an ordinary change it is entitled only to the places under 10, so with 14 queued a labelled newcomer can take place 15 while it waits. This is so today, with this change switched on or off, and this spec does not alter it in either direction. It is a question about queue controls' promise and goes to the scaling project's list with the front-order change.
- **Applied at the cap without a further round:** the idle guarantee is stated for the new count only; every row records the switch and whether the new count refused or would have refused.
- **Precision, not iterated:** the overview is worded a little more strongly than the spec in two sentences; the cause of the labelled changes always arriving first is stated as unproven, and the rows now recorded are what would show it.
- **Separate later change, in the scaling project's list:** the order of several changes put at the front by hand; a hold by file ("protect these paths until a named change merges").

## Convergence Verdict

Converged at round 6, at the cap. The internal reviewer's last round found nothing that changes what gets built. Of the outside reviewer's three final findings, two were applied in one edit each and one is a standing question about another feature's promise that this change neither worsens nor improves. The spec is ready for approval.

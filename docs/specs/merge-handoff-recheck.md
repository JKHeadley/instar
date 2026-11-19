---
title: "Merge hand-off: look again when GitHub was not ready"
slug: "merge-handoff-recheck"
author: "echo"
parent-principle: "Structure beats Willpower"
parent-spec: "docs/specs/local-verify-merge-authority.md"
eli16-overview: "docs/specs/merge-handoff-recheck.eli16.md"
tier: 2
supervision: tier0
topic: 145097
---

# Merge hand-off: look again when GitHub was not ready

## Words used here

- **Verify:** one run of the whole test suite against one change, on one of the line's machines.
- **Hand-off:** right after a change passes its verify, the verifier asks the merge watcher to merge exactly that change at that head, and holds its queue until the watcher answers, so the next change is tested on top of the merge.
- **Merge watcher:** the part that merges green changes (`GreenPrAutoMerger`). It also looks at every open change by itself every 10 minutes (a **tick**).
- **Miss:** a hand-off that ends without a merge.
- **Pass:** one run of the merge watcher over the open changes. A hand-off is one pass that may merge only the handed-over change.

## Problem statement

One hand-off in five ends without a merge, and the largest group of those is merged minutes later, unchanged.

Measured on the coordinator from its own log (`merge-handoff-result` rows, 2026-11-16 16:16Z to 2026-11-19 13:35Z, 2.9 days) and from GitHub's record of when each change merged:

- 154 hand-offs: 122 merged, 32 missed.
- 15 of the misses (about 5 refusals a day) answered "not mergeable". **All 15 merged later at the same head**: 9 within 2 minutes, 13 within 8, the slowest after 13. How many of the 15 were merged by hand was not counted; the session that operates the line reported five hand merges of this kind on 2026-11-19 by 14:51Z.
- The likely cause, not yet proven: after main moves, GitHub's list of open changes answers "unknown" for whether each change can be merged until something reads the change itself, and the watcher treats anything but "mergeable" as not mergeable. The code already knows this for its 10-minute rounds (it makes one direct read so that the next round sees the answer). The log does not record whether GitHub said "unknown" or "conflicting" in those 15 cases; a later merge at the same head shows only that the change could be merged in the end. Part D records the value from now on, with the switch on or off, so the first days show whether the cause is the one assumed.
- The other 17 misses are of other kinds (a status still pending, the change missing from the list, a failed list call, a body check, and others). They are out of scope: their causes are several or unproven, and for 6 of the 7 "status pending" cases a new head was needed.

Today the code says "a hand-off never retries: a refused merge waits for the watcher's tick", up to 10 minutes later.

**What it costs today:** about 5 such refusals a day, each of which either takes an operator's hand merge (how many do was not counted) or waits for the 10-minute round; and each time, the next verify starts before the merge, so the purpose of the hand-off (the next change is tested on top of the merge) is lost for that change.

## Proposed design

**In one sentence:** when the handed-over change is not mergeable only because GitHub has not yet said whether it can be merged, the same pass reads that one change again after a few seconds, at most three times within 30 seconds, and goes on to the merge when GitHub says "mergeable"; everything that decides whether a change may merge is unchanged.

### A. What happens

In the hand-off pass, at the point where the watcher finds that the handed-over change is not eligible:

1. If the reason is "not mergeable" and GitHub's value for the change in the list just read is `UNKNOWN`, the watcher first looks at the direct read it has already made for this change earlier in the same pass (it makes that read today, for any such change, to make GitHub start computing, and throws the answer away; the read already asks GitHub for the `mergeable` value, and its result now carries it and is kept). If that answer is already `MERGEABLE`, step 2 follows at once, with no wait. Otherwise the watcher saves its state, waits 5 seconds and reads that one change directly again.
2. If the read says `MERGEABLE` and the head is still the handed-over head, the watcher first does again what a pass does at its start, because up to half a minute has gone by: it loads its state again (a regular round may have run and saved meanwhile), and checks again that this machine still holds the lease, that merging is still allowed and that the breaker is still closed. If a regular round has a merge attempt of its own under way at that moment, the hand-off ends as the code already ends it in that case (`skipped:busy-in-act`), with no attempt of its own; it counts as not recovered. Then it puts the fresh value on the change's row, judges the row again with the same rule as before, and applies to it the three checks that a pass applies only to eligible changes and that this change therefore skipped earlier in the pass: whether a hold on it was only just released (using the result already worked out earlier in this pass, never working it out a second time, since doing so twice would release a hold in one pass where two are required); whether this head was already refused for want of an independent review; and the code-owner rule. Only a change that passes all of these continues exactly as a hand-off does today, to the merge attempt with its own checks.
3. If the read still says `UNKNOWN`, it waits 10 seconds and reads again, then 15 seconds and reads a third time. After the third delayed read, or if a read fails, or says `CONFLICTING`, or shows another head, a closed or merged change, the hand-off ends with today's answer and does not save its state again (it saved before the first wait, and a regular round may have saved since). The 30 seconds bound the waiting; each read has the time limit the direct read has today, and a read that has not answered within 10 seconds ends the re-check, so the whole of it is over within 60 seconds.

Nothing else is repeated: the list is not read again, no other change is looked at again, and the pass's other steps run once, as today.

### B. What does not change

- **Who may merge, and what.** The change must pass the same eligibility rule on its row, then everything a hand-off does today before and during a merge attempt: the lease and the merge-allowed switch (read at the start of the pass, and read again after the waits), the breaker, holds, code owners, the independent review, the read of the change immediately before acting, and safe-merge with its own checks. The target is still exactly the verified change at the verified head.
- **A real conflict.** `CONFLICTING` is never read again.
- **The watcher's own rounds**, the hold and its 30-minute limit, and a planned restart's wait for the hold.

### C. What it costs

- Up to 30 seconds of waiting plus three small reads, inside a pass that is already holding the queue, and only on a hand-off that would otherwise have missed. Those 15 misses held the queue 12 to 37 seconds each as it was. At 15 such cases in 154 hand-offs the waiting averages at most about 3 seconds per hand-off (up to 6 with slow reads). A hand-off that the re-read rescues then holds the queue through its merge, as every successful hand-off does today; that time is the purpose of the hand-off, not a cost of this change, and it is reported separately.
- While the queue is held longer, a second green change that finishes in the same seconds gets no hand-off of its own (`hold-active`, as today) and waits for the 10-minute round. This happened once in the 154 hand-offs. It is counted (part D).

### D. Switch, and what is recorded

- `monitoring.greenPrAutoMerge.handoffRecheck`: off when absent. Read live at each hand-off through a function the server passes to the watcher (the watcher's own settings are fixed at start, so the switch cannot live there). Off means today's behaviour exactly. No migration: absent is off.
- **With the switch on or off**, the hand-off's answer for a change that is not mergeable now says which it was: `handoff-not-eligible:not-mergeable-unknown` or `handoff-not-eligible:not-mergeable-conflicting` (in the audit row and in the answer the verifier logs). Nothing reads the old string to decide anything: it is only logged and counted.
- Each further read writes an audit row `handoff-recheck` (change, head, which read, GitHub's answer, seconds waited, seconds the read took). The watcher's answer to the verifier carries GitHub's first value for the change (`UNKNOWN`, `CONFLICTING` or `MERGEABLE`, whatever the hand-off's final answer turns out to be), the number of reads and the seconds spent on them, and the verifier writes them in its `merge-handoff-result` row and keeps the counts below.
- `GET /local-verify`, under `mergeLine`, since start: hand-offs that met `UNKNOWN`, how many of those were recovered, and hand-offs skipped as `hold-active`. A hand-off counts as having met `UNKNOWN` by GitHub's first value, whatever its final answer (a change that turns out `CONFLICTING` on a later read, or a merge reported late, is one such hand-off and no recovery). The rows of one hand-off are linked by the change, the head and the hand-off's start time, which the verifier's rows already carry. **Recovered** means the merge was confirmed before the verifier released that hand-off's hold; a merge that is reported after the hold timed out counts as not recovered, because the next verify may already have started without it.
- The awareness entry `src/data/awareness/merge-handoff-recheck.md` says the switch exists, what the rows mean and where the counts are.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Whether a change is merged | invariant; basis: enumerable-domain; evidence: unchanged. The same eligibility rule and the same checks decide; the only new input is a fresher value of GitHub's own `mergeable` field for the same change and head, read from GitHub. A test asserts that a re-read change still passes through every check a hand-off passes through today, and that `CONFLICTING`, another head, a closed change and a failed read all end with no merge attempt. | |
| Whether the hand-off reads the change again | invariant; basis: enumerable-domain; evidence: one named condition (not mergeable, GitHub's value `UNKNOWN`), fixed waits, a fixed count, one switch; tests on each. Symbol: the `mergeable` value in the list row. State claimed: "GitHub has not computed it yet". Corroboration: the direct read itself, which returns GitHub's computed value; a wrong guess costs at most 30 seconds and merges nothing. | |

## Fixed limits

| Limit | Value | Why this value |
|---|---|---|
| Waits | 5, 10, 15 seconds | On 2026-11-19 one such change was refused 34 seconds after its verify passed and merged by hand 45 seconds after that; hand merges give only an upper bound on when GitHub was ready. The reads fall 5, 15 and 30 seconds after the refusal. Starting values: the `handoff-recheck` rows show at which read GitHub answers, and the values are revised from them at the 7-day review. |
| Further reads | 3 | Bounds the added wait at 30 seconds. |

## Multi-machine posture

- The hand-off and the merge watcher run only on the machine that holds the coordinator lease; a peer never merges. The switch is read on that machine. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (the approved Local Verify capacity spec: the merge line is the coordinator's). The lease is checked at the start of the pass, as today, and again after the waits; a machine that lost the lease during them ends the hand-off without a merge attempt.
- The counts in `GET /local-verify` are the coordinator's, since start, like the other merge-line counts.

## Maturation plan

- **ladder:** merge-handoff-recheck
- **test-agent-live:** a throwaway agent with the real watcher and a fake GitHub command that answers `UNKNOWN` in the list and `MERGEABLE` on the second direct read: the hand-off waits, reads twice, and reaches the merge attempt; the same with `CONFLICTING` ends at once.
- **dev-agent-live:** the development agent's line. First with the switch off for 3 days (about 15 such refusals at the measured rate), to read the new `unknown` or `conflicting` values; then switched on by the session that operates the line.
- **graduation criterion:** over 7 days with the switch on, from the audit rows: of the hand-offs that met `UNKNOWN`, at least 8 in 10 were recovered (every other ending counts as not recovered, whatever its name, including a merge reported after the hold timed out); no merge attempt on a change whose read said anything but `MERGEABLE`; the seconds spent on waits and reads, averaged over all hand-offs, stay under 5 (the baseline with the switch off is zero); `hold-active` skips do not rise above 1 in 50 hand-offs. Reported beside it, as the operator's workload and not as the criterion: hand merges per day.
- **fleet:** off by default until the 7-day report; then proposed as the default with the numbers.
- **dark-window:** from merge until the operating session turns it on.
- **owner:** echo (scaling session, topic 145097). Review 7 days after it is switched on. If it is not switched on 30 days after merge, the owner raises that with the session that operates the line.

## Tests

- **Unit (the watcher, with its existing fake dependencies and a timer seam):** the read already made in the pass saying `MERGEABLE` reaches the merge attempt with no wait; `UNKNOWN` then `MERGEABLE` on the first, second and third delayed read reaches the merge attempt through the same checks; `UNKNOWN` then `CONFLICTING` is one hand-off that met `UNKNOWN` and no recovery; a regular round with a merge under way after the waits ends the hand-off as `skipped:busy-in-act`; the ending path does not save state again; three `UNKNOWN` reads end with `not-mergeable-unknown`; `CONFLICTING` in the list is never read again; a read that fails, shows another head, a closed or a merged change ends with no attempt; the waits are 5, 10 and 15 seconds; the list is read once; no other change is judged again; the switch off gives no read and the old flow, with the new answer strings; a change the re-read makes eligible but which a hold, the code-owner rule or the independent-review rule stops is still stopped; a hold released in this same pass is not treated as released twice; the lease lost or merging switched off during the waits ends with no attempt; the state saved by a regular round that ran during the waits is not overwritten; a read that takes longer than 10 seconds ends the re-check; a merge reported after the verifier's hold timed out is counted once, as not recovered.
- **Integration:** `GET /local-verify` shows the three counts.
- **E2E lifecycle:** on the production wiring, the switch is read live from the real config (off, then on, without a restart), and a hand-off that meets `UNKNOWN` writes the `handoff-recheck` row.

## Risks

- **The line waits 30 seconds for nothing** when GitHub stays unready. Bounded, counted, judged at the review.
- **The cause is not the one assumed** (GitHub said `CONFLICTING`, and the later merges had another reason). Then the switch does nothing, the rows say so within days, and the change is removed.
- **A second green change loses its hand-off** while the hold is longer. Counted; it waits for the 10-minute round as today.

## Frontloaded Decisions

1. One reason only: not mergeable with GitHub's value `UNKNOWN`. Every other miss is out of scope.
2. The re-read happens inside the watcher's hand-off pass, for the handed-over change only; no second pass, no second list.
3. Waits 5, 10, 15 seconds; at most three reads.
4. Off by default; one live switch passed in by the server; no migration.
5. The answer strings `not-mergeable-unknown` and `not-mergeable-conflicting` are written with the switch on or off.
6. The sentence "a hand-off never retries" in the code's comments is replaced by this rule.

## Open questions

*(none)*

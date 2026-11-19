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

## Problem statement

One hand-off in five ends without a merge, and most of those changes are merged minutes later, unchanged, by hand.

Measured on the coordinator from its own log (`merge-handoff-result` rows, 2026-11-16 16:16Z to 2026-11-19 13:35Z) and from GitHub's record of when each change merged:

- 154 hand-offs: 122 merged, 32 missed.
- 15 misses answered "not mergeable". **All 15 merged later at the same head**, 9 within 2 minutes, 13 within 8, the slowest after 13. None was a real conflict. After main moves, GitHub takes some seconds to work out again whether each open change can be merged, and until then it answers "unknown"; the hand-off reads that as "not mergeable" and gives up.
- 3 misses answered "not listed" (the change was not in the list of open changes the watcher had just read) and merged at the same head 1, 10 and 16 minutes later. 1 answered "list failed" (the list call itself failed) and merged 1 minute later.
- The other 13 are of other kinds (a status still pending, a body check, and others); 6 of the 7 "status pending" cases needed a new head, so looking again would not have helped them. They are out of scope.

So 19 of 32 misses (about 5 a day) are GitHub not being ready at the moment the hand-off asked. Today the code says "a hand-off never retries: a refused merge waits for the watcher's tick", up to 10 minutes later. In practice the session that operates the line merges them by hand (five times on 2026-11-19 by 14:51Z), because a green change left unmerged while the line goes on risks main moving under it.

**What it costs today:** an operator's attention about 5 times a day; and each time the next verify starts before the merge, the purpose of the hand-off (testing the next change on top of the merge) is lost for that change.

## Proposed design

**In one sentence:** when a hand-off misses for one of three reasons that mean "GitHub was not ready", the hand-off asks again after a short wait, at most three times within one minute, while the queue is still held; everything that decides whether a change may merge is unchanged.

### A. When it looks again

After the watcher's answer to a hand-off, the hand-off asks once more when the answer is one of:

1. `handoff-not-eligible:not-mergeable`, **and** GitHub's own answer for that change was "unknown" (not "conflicting"). The watcher already makes one direct read of the change in that case, which is what makes GitHub compute the answer; the hand-off's answer now says which of the two it was (`not-mergeable-unknown` or `not-mergeable-conflicting`), so that a real conflict is never asked about again.
2. `handoff-not-eligible:not-listed`.
3. `list-failed`, once only (a failed list call counts toward the watcher's circuit breaker, which opens at three in a row; one more try cannot open it by itself, three could).

It waits 10 seconds before the second ask, 20 before the third and 30 before the fourth: at most three more asks and 60 seconds. Each ask is the watcher's normal hand-off pass for the same change and the same head: it lists the open changes again and applies every check again. The first ask that merges, or that answers anything outside the three reasons, ends it.

### B. What does not change

- **Who may merge, and what.** Every ask goes through the same pass: the lease, the breaker, holds, code owners, the independent review, the required status on GitHub for that head, and safe-merge. The target is still exactly the verified change at the verified head; a head that moved answers `head-moved` and ends it.
- **The watcher's own ticks.** A change still missed after the last ask is left to the 10-minute tick, as today.
- **The hold.** The queue is held during the asks, as it is during the first. The hold's own limit (30 minutes) is unchanged. A planned restart waits for the hold as today.

### C. What it costs

- Up to 60 more seconds of held queue on a hand-off that still misses. At today's rates (19 such misses in 154 hand-offs) that is at most about 7 seconds per hand-off on average, and less when the second ask succeeds. A machine that has just finished a verify waits those seconds before starting the next one.
- Up to three more list calls to GitHub per such hand-off (about 15 a day).

### D. Switch, and what is recorded

- `monitoring.greenPrAutoMerge.handoffRecheck`: `false` when absent. Read live at each hand-off. Off means today's behaviour exactly. (No migration: absent is off.)
- Each further ask writes an audit row `merge-handoff-recheck` (change, head, which ask, the reason that caused it, seconds waited). The final `merge-handoff-result` row is written once, as today, with the last answer and the total time held, plus the number of asks.
- `GET /local-verify`, under `mergeLine`: whether the switch is on, and since start how many hand-offs looked again and how many of those merged.
- The awareness entry `src/data/awareness/merge-handoff-recheck.md` says the switch exists, what a `merge-handoff-recheck` row means, and where the counts are.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Whether a change is merged | invariant; basis: enumerable-domain; evidence: unchanged. The same pass with the same checks decides each time; this design only changes how many times, within one minute, the pass is asked for the same change and head. A test asserts that every further ask calls the same pass with the same target and that no answer outside the three reasons is asked about again. | |
| Whether the hand-off asks again | invariant; basis: enumerable-domain; evidence: three named answers, fixed waits, a fixed count, one switch; tests on each answer, on a conflicting change (never asked again), on a moved head, and on the count. Symbol: the watcher's answer string and GitHub's `mergeable` value for the change. State claimed: "GitHub had not finished computing, or its list was behind". Corroboration: the next ask itself; a wrong guess costs at most 60 seconds of hold and merges nothing. | |

## Fixed limits

| Limit | Value | Why this value |
|---|---|---|
| Waits | 10, 20, 30 seconds | On 2026-11-19 a change answered "not mergeable" 34 seconds after its verify passed and was merged by hand 45 seconds later; 9 of 15 such changes were merged by hand within 2 minutes. The waits reach 10, 30 and 60 seconds after the first answer. Starting values: the audit rows show at which ask merges happen, and the values are revised from them at the 7-day review. |
| Further asks | 3 (1 for a failed list) | Bounds the hold at one minute; one for a failed list so that this cannot open the watcher's breaker by itself. |

## Multi-machine posture

- The hand-off and the merge watcher run only on the machine that holds the coordinator lease; a peer never merges. The switch is read on that machine. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (the approved Local Verify capacity spec: the merge line is the coordinator's). If the lease moves during the asks, the next ask answers `not-lease-holder`, which is outside the three reasons, and it ends.
- The counts in `GET /local-verify` are the coordinator's, since start, like the other merge-line counts.

## Maturation plan

- **ladder:** merge-handoff-recheck
- **test-agent-live:** a throwaway agent with a fake watcher that answers not-mergeable (unknown) twice and then merges: the hand-off holds, asks three times, merges, and writes the rows.
- **dev-agent-live:** the development agent's line, switched on by the session that operates the line.
- **graduation criterion:** over 7 days with the switch on: misses of the three kinds fall from about 5 a day to at most 1 a day; no merge of a change that the checks would have refused (there is no path for one, and the audit rows are read for it); the average time a hand-off holds the queue does not rise by more than 10 seconds.
- **fleet:** off by default until the 7-day report; then proposed as the default with the numbers.
- **dark-window:** from merge until the operating session turns it on.
- **owner:** echo (scaling session, topic 145097). Review 7 days after it is switched on. If it is not switched on 30 days after merge, the owner raises that with the session that operates the line.

## Tests

- **Unit:** each of the three answers leads to another ask after the stated wait; `not-mergeable-conflicting`, `head-moved`, `status-pending`, `not-lease-holder`, `disabled`, `dry-run` and a merge do not; at most three further asks, one for a failed list; the waits are 10, 20, 30 seconds (through the timer seam); every ask passes the same change and head; the switch off gives exactly one ask; the watcher's answer distinguishes unknown from conflicting; the result row is written once with the last answer and the count; the hold is released once.
- **Integration:** `GET /local-verify` shows the switch and the two counts.
- **E2E lifecycle:** on the production wiring, with the switch on, a hand-off whose first answer is not-mergeable (unknown) is asked again and merges; with the switch absent it is asked once. A wiring test checks the switch is read live from the real config.

## Risks

- **The line waits a minute for nothing** when GitHub stays unready. Bounded at 60 seconds, counted in the audit rows, judged at the review.
- **More calls to GitHub.** About 15 list calls a day at today's rates; the list call's failure already feeds the breaker, and a failed list is asked again once only.
- **A change that should not merge is asked about more often.** Asking is not merging: each ask runs every check, and a refusal that is not one of the three reasons ends it.

## Frontloaded Decisions

1. Three reasons only: not-mergeable with GitHub's answer unknown, not-listed, list-failed. Status-pending and all other misses are out of scope.
2. The asks happen inside the hand-off, in the wiring that calls the watcher, while the queue is held; the watcher's pass is called again unchanged, except that its not-mergeable answer says unknown or conflicting.
3. Waits 10, 20, 30 seconds; at most three further asks; one for a failed list.
4. Off by default, one live switch, no migration.
5. The sentence "a hand-off never retries" in the code's comment is replaced by this rule.

## Open questions

*(none)*

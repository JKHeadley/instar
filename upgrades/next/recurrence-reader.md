# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Instar notices problems in three separate stores — the attention queue, the evolution action queue,
and the sentinel log — and nothing has ever read across them. The same problem is therefore noticed
dozens of times and closed zero times (measured filing-to-completion ≈ 30:1).

`src/core/RecurrenceReader.ts` groups OPEN observations from all three into recurrence clusters,
carrying a `coverage` block that names every store it could NOT read. Pure module, read-only, no
route, no authority.

## Evidence

Live data, 2026-07-27: **2,068 open observations → 836 distinct problems** (ratio 2.47). **69
problems account for 1,242 noticings and none is tracked.** Largest clusters: 278x idle-timeout
detection, 238x escalation-suppressed, 177x credential rebalancer (48% of the attention queue).

Refusal, on real data with the action store made unreadable: reported the 59 clusters it could see
and left `verdict` **absent** rather than claiming `no-recurrence`. Unit suite 11/11; `tsc` exit 0.

## Known limits

Title-only keying will not merge the same problem worded differently; semantic matching would mean an
LLM and a judgment point, deliberately avoided. The blunt key can occasionally over-merge — `exemplar`
and `sources` are carried so a reader spots it. Read-only: it reports, it does not act. Driving
action through existing gated paths is the next increment, not this one.

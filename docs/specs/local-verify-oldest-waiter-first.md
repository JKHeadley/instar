---
title: "Local Verify: the oldest waiter takes the next free place"
slug: "local-verify-oldest-waiter-first"
author: "echo"
parent-principle: "Structure beats Willpower"
parent-spec: "docs/specs/local-verify-capacity.md"
eli16-overview: "docs/specs/local-verify-oldest-waiter-first.eli16.md"
tier: 2
supervision: tier0
topic: 145097
---

# Local Verify: the oldest waiter takes the next free place

## Words used here

- **Verify:** one run of the whole test suite against one change.
- **The queue:** the changes admitted to be verified, in order. It holds at most 10 changes, plus 5 more places (the **overflow**) for changes that carry the `merge-throughput` label.
- **The label:** `merge-throughput`, put on a change by the session that operates the line to move it ahead of ordinary changes.
- **Waiting list:** the changes that asked for a place and were refused because the queue was full. Each keeps the time of its first refusal. A waiter is **live** while something keeps offering it (within the last 30 minutes), and **aged** once 90 minutes have passed since its first refusal.
- **Front:** the operator's control that admits a named change over the cap (queue controls, PR 3495).

## Problem statement

Changes wait outside a full queue for a day while newer changes are admitted.

Measured by the session that operates the line at 2026-11-19 15:40Z: 15 live waiters, refused for 4 to 26 hours (two for 26 hours with more than 120 refusals each; a security fix refused 146 times since 2026-11-17 and never run). It admitted three by hand.

Why, from the code (`LocalVerifyService.ts`, the request path, and `waiterAged`):

- An aged ordinary waiter may use the same 5 overflow places as labelled changes, but only if the queue holds fewer than 15 at the moment it is offered.
- A labelled change is admitted into the overflow whenever there is room, and below the cap it does not wait behind the waiting list at all.
- Nothing orders a labelled request against an aged waiter. Whichever is offered first after a place frees takes it.

Measured from the coordinator's log, 2026-11-18 13:40Z to 2026-11-19 15:40Z: 4,593 refusals for a full queue; 96 admissions into the overflow, all 96 labelled, none as an aged waiter; 9 fronts. At 14:00Z all 15 queued changes carried the label's priority. The likely picture, which these counts do not prove (they show who entered, not how often each kind asked): the queue stays near 15, labelled requests are offered more often than a waiter is, so they reach each freed place first, and the queue seldom falls below 10, where the waiting list would have its turn. Part D records what is needed to confirm it.

The rule that exists was written to prevent exactly this (its comment: "without it a steady stream of labelled PRs keeps every ordinary waiter out for good"). It bounds the label inside the queue. At the door it only gives an aged waiter the right to compete, and the waiter loses every time because labelled requests are offered more often.

**What it costs today:** changes that are a day old and never tested, their authors asking why, and an operator admitting them by hand from memory.

## Proposed design

**In one sentence:** a change is let into the queue only if room is left for every change that has waited longer than it and for more than 90 minutes, whether or not the newcomer carries the label; the operator's front is the only way past.

### A. The rule

When a change asks for a place and is not one of the kinds admitted as today (below):

1. If there is no place under the cap this change is admitted under (10, or 15 for a labelled or aged change), it is refused as today, with today's reason (the queue is full). The new rule is not consulted.
2. Otherwise the service counts the **older aged live waiters**: live waiters, aged, whose first refusal is earlier than this change's own first refusal (a change asking for the first time has none, so every aged live waiter is older). The change is admitted only if, after it has taken its place, there is still room under the cap of 15 for every one of them: `15 - (queue length + 1)` is at least the number of older aged live waiters (queue length counts the changes queued; verifies of `main` are not counted, as for the cap today). If not, it is refused and joins or stays in the waiting list, with the reason `waiting-behind-aged` and the oldest waiter it waits behind.
3. For an aged waiter, step 2 replaces the two tests the code makes today (that no older aged live waiter exists at all, and the reservation below the cap). For a change that is not aged, today's reservation below the cap stays exactly as the code has it: it counts all older live waiters, aged or not, against the free places under 10. Step 2 is applied in addition, and is the only new count.

What the rule gives: a place is always left for every older aged waiter. It does not promise strict order: while there is room for them all, a younger request may enter first. Examples: with 9 queued and one aged waiter, a labelled newcomer is admitted (10 queued, 5 places left for the one waiter), while an ordinary newcomer is refused by today's reservation, exactly as it is today (the one place under 10 is kept for the live waiter). With 14 queued and one aged waiter, a labelled newcomer is refused (it would take the last place). With 13 queued and two aged waiters, either waiter is admitted in whichever order they are offered, and a labelled newcomer is refused.

**Admitted as today, whatever waits:** an operator's front or release; a pushed head that keeps its place; a replay after a restart; a repair of a red `main`; and the one re-run of a failed change after `main` turns green (nothing would offer that re-run again). A change the operator released while the overflow was full is put at the head of the waiting list by queue controls, as today: its stored first refusal is earlier than every other waiter's, so once it has aged it is the oldest, and until then it is first in today's reservation under the cap of 10. What queue controls promises such a change, and how far that promise reaches into the overflow, is not changed by this spec in either direction.

### B. What keeps a machine from standing idle, and a place from standing empty

- **Nothing is reserved when a machine would otherwise idle.** If a verifier is free, could start the incoming change, and can start none of the queued ones (the queue is empty; or everything in it is already running or reserved for the peer; or what waits may not run on that verifier, as a change that has used its two attempts on the peer may not run there again), the request is admitted whatever waits, and its row is marked `admitted-to-avoid-idle` only when step 2 would otherwise have refused it (an admission nobody contested is not marked). The test uses the same eligibility rules the service uses when it picks the next change for itself and for the peer. A reservation must never leave a verifier with nothing to do at the moment a change asks. One sequence is not covered and is accepted: a change is refused while both verifiers are busy, then a verifier finishes with nothing it may start before that change is offered again. The verifier then waits for the next offer, at most one round of the merge watcher (about 10 minutes); the admission that ends the wait is marked, so the review sees how often this happens.
- **Nothing is reserved while `main` is not healthy**, as today.
- **Only a live waiter reserves** (offered within the last 30 minutes), as for the existing reservation. The merge watcher offers every open green change of its own on each round (about every 10 minutes), so a kept place is normally taken within one round; a waiter that stops being offered holds its place for at most 30 minutes and then reserves nothing. That is the cost of this rule in the worst case: one queue place unused for up to 30 minutes per waiter that went quiet, while the machines keep working through the changes already queued.

### C. What does not change

- The order inside the queue (it already ranks an aged change with labelled ones).
- The cap, the overflow's size, the 90 minutes, the 30 minutes.
- Fronts, releases and holds by the operator; repairs of a red main; replays after a restart.
- What a verify does, and what may merge.

### D. Switch, and what is recorded

- `monitoring.localVerify.oldestWaiterFirst`: off when absent, read live at each request. Off means today's behaviour exactly. No migration: absent is off.
- **With the switch on or off**, every admission's audit row (`queued`) gains: the kind of admission (ordinary, labelled, aged waiter, front, release, kept place, replay, repair, re-run after green), the queue's length before it, the places the change could take, the number of older aged live waiters and the age of the oldest, the admitted change's own waiting time, and whether the admission was made to avoid an idle machine. Each row also says whether the reservation applied at that moment and, if not, why (`main` not healthy; a machine would idle; one of the kinds admitted as today). An **out-of-order admission** is one that took a place step 2 keeps for an older waiter while the reservation applied. An admission that leaves room for every older aged waiter is not one. The same test is applied to rows written with the switch off and on. With the switch off these rows are the baseline and confirm or correct the picture in the problem statement.
- Every refusal's audit row gains the class of the request (labelled or not; a waiter or not; aged or not), with the switch on or off, so that how often each class asks can be counted beside who was admitted. A refusal by step 2 has the reason `waiting-behind-aged` and names the oldest waiter it waits behind.
- `GET /local-verify`, two new keys beside the existing ones: `waitingSummary` (live waiters, aged waiters, the age of the oldest live waiter) and `admissions` (since start, by kind, and out-of-order admissions). The existing `waiting` and `queue` lists are unchanged.
- The awareness entry `src/data/awareness/local-verify-oldest-waiter-first.md`.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Whether a change is admitted to the queue now or waits | invariant; basis: enumerable-domain; evidence: one added count (older aged live waiters against the room left under 15 after this admission), applied after today's capacity check; tests over each kind of request (ordinary, labelled, aged, front, release, kept place, replay, repair) with and without an older aged live waiter, at, over and below the cap. Symbol: a waiter's first-refusal time and last-offered time. State claimed: "this change has waited longer and is still wanted". Corroboration: the watcher's own repeated offers keep a waiter live; a waiter no longer offered stops reserving after 30 minutes. | |

## Fixed limits

None added. The 90 minutes, the 30 minutes, the cap of 10 and the overflow of 5 are the existing values.

## Multi-machine posture

The queue and the waiting list are the coordinator's; a peer runs what it is handed. The switch is read on the coordinator. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (the approved Local Verify capacity spec: the queue is the coordinator's). If the coordinator role moves, the new coordinator starts with its own waiting list, as today.

## Maturation plan

- **ladder:** local-verify-oldest-waiter-first
- **test-agent-live:** a throwaway agent with a fake change source: a full queue, one aged waiter and a stream of labelled requests; the next free place goes to the waiter; with the waiter no longer offered, labelled requests are admitted again after 30 minutes.
- **dev-agent-live:** the development agent's line, switched on by the session that operates the line.
- **graduation criterion:** from the audit rows (which survive restarts), over 7 days with the switch on, against the days with it off before: no out-of-order admission (with the switch off, a labelled admission that takes an aged waiter's last place is one), and the rule seen at work at least once (a request refused as `waiting-behind-aged`, followed by the admission of the waiter it waited behind); a week in which no place was contested proves nothing and the count goes on; merges per day not lower than the 7 days before; fewer than 1 admission in 50 marked `admitted-to-avoid-idle` (the mark is set only when the reservation would otherwise have refused; more means the reservation is fighting the line). Reported beside it, not as the criterion, because it depends on capacity as much as on this rule: the oldest live waiter's age, daily maximum (26 hours when measured).
- **fleet:** off by default until the 7-day report; then proposed as the default with the numbers.
- **dark-window:** from merge until the operating session turns it on.
- **owner:** echo (scaling session, topic 145097). Review 7 days after it is switched on. If it is not switched on 30 days after merge, the owner raises that with the session that operates the line, and again every 30 days.

## Tests

- **Unit:** step 2 at its boundary: with 9 queued and one aged waiter a labelled newcomer is admitted and an ordinary newcomer is refused by today's reservation with today's reason; with 14 queued and one aged waiter a labelled newcomer is refused and the waiter then admitted; with 13 queued and two aged waiters either waiter is admitted and a labelled newcomer refused; with 8 queued, one aged and one unaged live waiter, an ordinary newcomer is refused by today's reservation as it is today; at 15 with no aged waiter a labelled newcomer gets today's full-queue reason, not the new one; two free places and two aged ordinary waiters: either is admitted, in both offer orders; a released change at the head of the waiting list is the oldest waiter once aged; an idle peer, a busy coordinator and only changes that may no longer run on the peer waiting: an incoming change the peer can run is admitted and marked; an admission into an empty, uncontested queue is not marked; a surplus admission is not marked out of order; refusal rows carry the request's class; a request is admitted whatever waits when no queued change is waiting to start (everything queued is running or reserved for the peer); the re-run after `main` turns green is admitted as today; with `main` not healthy nothing is reserved and the row says why; the admission row's kind and out-of-order mark for each kind; the rule for each kind of request as the decision row lists; first-refused order among several aged waiters; a labelled change that has itself aged takes its turn by its own first refusal; a stale waiter reserves nothing; nothing reserved while `main` is not healthy or the queue is empty; the switch off gives today's admissions exactly (the existing tests unchanged).
- **Integration:** `GET /local-verify` fields.
- **E2E lifecycle:** on the production wiring, the switch read live; a labelled request refused behind an aged waiter, then the waiter admitted when offered.

## Risks

- **Labelled changes wait longer** while there is a backlog of aged waiters. That is the intent; the operator's front remains for a change that must go now (5 places).
- **A place stands unused for up to 30 minutes** when its waiter has gone quiet (normally one watcher round, about 10 minutes). No machine idles for it: with nothing waiting to start, nothing is reserved.
- **A waiter that can never pass** (it fails every time) takes its turn each time it ages. It is admitted once per head: a failed head is recorded and not offered again, as today.

## Frontloaded Decisions

1. The comparison is by first-refusal time, among live aged waiters only.
2. It applies to labelled and ordinary requests alike, at, over and below the cap.
3. Fronts, releases, kept places, replays and repairs are admitted as today.
4. No new limit; no service-initiated admission (the waiter is admitted when next offered). A change is admitted only if room is left under 15 for every older aged live waiter; nothing is reserved when a machine would otherwise idle at that moment.
5. Off by default, one live switch, no migration.
6. The order of several fronted changes (the operator's report of 2026-11-19) is not part of this change; it is a separate small change to queue controls, in the scaling project's list.

## Open questions

*(none)*

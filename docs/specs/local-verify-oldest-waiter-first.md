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

Measured from the coordinator's log, 2026-11-18 13:40Z to 2026-11-19 15:40Z: 4,593 refusals for a full queue; 96 admissions into the overflow, all 96 labelled, none as an aged waiter; 9 fronts. At 14:00Z all 15 queued changes carried the label's priority. So the queue stays at 15, every freed place goes to a labelled request, and the queue never falls below 10, where the waiting list would have its turn.

The rule that exists was written to prevent exactly this (its comment: "without it a steady stream of labelled PRs keeps every ordinary waiter out for good"). It bounds the label inside the queue. At the door it only gives an aged waiter the right to compete, and the waiter loses every time because labelled requests are offered more often.

**What it costs today:** changes that are a day old and never tested, their authors asking why, and an operator admitting them by hand from memory.

## Proposed design

**In one sentence:** a free place in a full queue, and a free place below the cap, goes to the oldest aged live waiter before any request that started waiting after it, labelled or not; the operator's front is the only way past.

### A. The rule

When a change asks for a place and is not a front, a release, a kept place, a replay or a repair of a red main (all of which are admitted exactly as today):

1. If there is a live aged waiter whose first refusal is earlier than this change's own first refusal (a change asking for the first time has none, so every aged waiter is earlier), this change is refused and joins or stays in the waiting list, with the reason `waiting-behind-aged`. This holds whether or not the change carries the label, at or over the cap and below it.
2. Otherwise the change is admitted or refused exactly as today (an ordinary change under the cap behind the live waiting list; a labelled or aged change into the overflow while it has room).

So among changes that have waited 90 minutes, the order is first refused, first admitted. The label still moves a change ahead of ordinary changes that have waited less than 90 minutes, and it still gives access to the 5 overflow places; it no longer lets a change pass one that has waited longer than 90 minutes.

### B. What keeps a place from standing empty

A place kept for an aged waiter is taken when that waiter is next offered, which the merge watcher does for every open green change on each of its rounds (every 10 minutes). Three bounds:

- Only a **live** waiter reserves (offered within the last 30 minutes), as for the existing reservation below the cap. A waiter that stops being offered reserves nothing.
- Nothing is reserved while `main` is not healthy or the queue is empty, as today: a machine never sits idle for a reservation.
- A queue place is not a machine. While a place waits up to 10 minutes for its waiter, the machines keep working through the 10 or more changes already queued.

### C. What does not change

- The order inside the queue (it already ranks an aged change with labelled ones).
- The cap, the overflow's size, the 90 minutes, the 30 minutes.
- Fronts, releases and holds by the operator; repairs of a red main; replays after a restart.
- What a verify does, and what may merge.

### E. Fronting several changes: say the order, and allow "behind the others"

The queue-controls spec says: "The named change is the next change to start. If several are fronted, the most recently fronted goes first." That is right when the operator means "this one now". It is a trap when the operator fronts several starved changes one after another and expects them to run in that order: on 2026-11-19 the session that operates the line fronted a security fix first and four changes after it; each later one started before it, the fix waited 50 minutes "at the front", and the route answered rank 1 for every one of them.

Two small changes, both in the route's answer and options; the order rule itself stays:

1. **The answer says the order.** A front answers with the list of fronted changes in the order they will start, and this change's place in it, counted among changes that are fronted and not yet started.
2. **A front can join behind.** `POST /local-verify/front {pr, behind: true}` puts the change after the changes already fronted instead of before them. Without `behind` the meaning is as today: next to start.

Neither passes any gate a front does not pass today, and the 5 places over the cap are unchanged.

### D. Switch, and what is recorded

- `monitoring.localVerify.oldestWaiterFirst`: off when absent, read live at each request. Off means today's behaviour exactly. No migration: absent is off.
- The refusal's audit row (`queue-full` or `queue-full-waiting`, as today) gains the reason `waiting-behind-aged` and the waiter it waits behind.
- `GET /local-verify`, under `waiting`: for each waiter its age and whether it is aged; and at the top, the age of the oldest live waiter. Under `queue`: since start, admissions by kind (labelled into the overflow, aged waiter, front, ordinary).
- The awareness entry `src/data/awareness/local-verify-oldest-waiter-first.md`.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Whether a change is admitted to the queue now or waits | invariant; basis: enumerable-domain; evidence: one added comparison of first-refusal times, applied before the existing rules; tests over each kind of request (ordinary, labelled, aged, front, release, kept place, replay, repair) with and without an older aged live waiter, at, over and below the cap. Symbol: a waiter's first-refusal time and last-offered time. State claimed: "this change has waited longer and is still wanted". Corroboration: the watcher's own repeated offers keep a waiter live; a waiter no longer offered stops reserving after 30 minutes. | |

## Fixed limits

None added. The 90 minutes, the 30 minutes, the cap of 10 and the overflow of 5 are the existing values.

## Multi-machine posture

The queue and the waiting list are the coordinator's; a peer runs what it is handed. The switch is read on the coordinator. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (the approved Local Verify capacity spec: the queue is the coordinator's). If the coordinator role moves, the new coordinator starts with its own waiting list, as today.

## Maturation plan

- **ladder:** local-verify-oldest-waiter-first
- **test-agent-live:** a throwaway agent with a fake change source: a full queue, one aged waiter and a stream of labelled requests; the next free place goes to the waiter; with the waiter no longer offered, labelled requests are admitted again after 30 minutes.
- **dev-agent-live:** the development agent's line, switched on by the session that operates the line.
- **graduation criterion:** over 7 days with the switch on: the oldest live waiter's age, daily maximum, stays under 6 hours (26 hours when measured); at least one admission in ten into a full queue is an aged waiter while aged waiters exist (0 of 96 when measured); merges per day do not fall; no day on which a machine was idle while changes waited because of a reservation.
- **fleet:** off by default until the 7-day report; then proposed as the default with the numbers.
- **dark-window:** from merge until the operating session turns it on.
- **owner:** echo (scaling session, topic 145097). Review 7 days after it is switched on. If it is not switched on 30 days after merge, the owner raises that with the session that operates the line, and again every 30 days.

## Tests

- **Unit:** a front with `behind` starts after the changes already fronted and before everything else; the answer lists the fronted changes in start order with the right place for each; the rule for each kind of request as the decision row lists; first-refused order among several aged waiters; a labelled change that has itself aged takes its turn by its own first refusal; a stale waiter reserves nothing; nothing reserved while `main` is not healthy or the queue is empty; the switch off gives today's admissions exactly (the existing tests unchanged).
- **Integration:** `GET /local-verify` fields.
- **E2E lifecycle:** on the production wiring, the switch read live; a labelled request refused behind an aged waiter, then the waiter admitted when offered.

## Risks

- **Labelled changes wait longer** while there is a backlog of aged waiters. That is the intent; the operator's front remains for a change that must go now (5 places).
- **A place stands empty for up to 10 minutes** until its waiter is offered. No machine idles for it; counted in the status.
- **A waiter that can never pass** (it fails every time) takes its turn each time it ages. It is admitted once per head: a failed head is recorded and not offered again, as today.

## Frontloaded Decisions

1. The comparison is by first-refusal time, among live aged waiters only.
2. It applies to labelled and ordinary requests alike, at, over and below the cap.
3. Fronts, releases, kept places, replays and repairs are admitted as today.
4. No new limit; no service-initiated admission (the waiter is admitted when next offered).
5. Off by default, one live switch, no migration.
6. Fronts keep their meaning (next to start); the answer states the order, and `behind: true` joins after the fronted changes. These two are part of queue controls and follow its switch, not the new one.

## Open questions

*(none)*

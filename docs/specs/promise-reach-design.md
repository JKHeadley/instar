---
title: "The promise half of Close the Loop: why it does NOT generalise from the action half"
slug: "promise-reach-design"
author: "echo"
status: "design — not converged, not approved, no code"
companion: "docs/specs/undated-action-resurfacer.md (the ACTION half, merged as a draft)"
---

# The promise half of Close the Loop

> **Status: design only.** No code, no convergence tag, no approval.
>
> It answers two questions. **(1)** *Does the action-half design extend to promises?* No — for a
> constitutional reason rather than a technical one. **(2)** *Is 287 a backlog to drain?* No — it
> grows at +314 net per 28 days, so a per-run resurfacer is a treadmill at any plausible rate
> (Addendum). The second was raised as an open question here and then measured rather than left
> open; both answers are the deliverable.

## Why this document exists

Goal B of the 2026-07-28 session was "give Close the Loop a mechanism." Measurement showed the
mechanism already existed and its reach was 2%, so the deliverable became a design for
re-surfacing the invisible 98% — merged as `undated-action-resurfacer`, a draft covering
**actions**.

Re-reading that draft: `commitment|beacon|promise` appears in it **zero times**. It designs the
action half only. The promise half had a measurement and no design, while Goal B was being
scored as answered.

## What is measured (2026-07-28 19:30Z, live)

Three mechanisms exist to stop a loop rotting. All three run. All three report success.

| mechanism | population | enrolled | reach |
|---|---|---|---|
| `evolution-overdue-check` (actions) | 912 pending | 18 carry `dueBy` | **2.0%** |
| `PromiseBeacon` (commitments) | 307 pending | 10 have `beaconEnabled` | **3.3%** |
| dated check-in reconciler | 307 pending | **0** carry `checkInAt` | **0.0%** |

The third is the sharpest: `GET /commitments/check-in-reminder` returns
`{enabled: true, dryRun: true, datedCount: 0}`. It is enabled, it runs, it reports success, and
it has **never had a single input**. A mechanism whose entire population is empty is
indistinguishable, from its own status surface, from one that is working perfectly.

Age of the 307 pending promises:

| bucket | count |
|---|---|
| > 30 days | 15 |
| 8–30 days | 159 |
| 2–7 days | 106 |
| < 2 days | 27 |

**174 of 307 (57%) are more than a week old.** The oldest is 52 days: *"I will ship a gated PR:
bounded backoff on live-tail cross-machine…"*

## The finding: it does not generalise, and the reason is constitutional

The action-half design re-surfaces one forgotten item per run **to the operator's attention
queue**. Applying that to promises is not merely inadvisable — it is **forbidden by the standard
this work exists to serve.**

*The Agent Carries the Loop* states:

> **owner:agent** → I drive it to closure; the user is **NEVER** status-pinged (the beacon
> suppresses my status sends). They hear from me only on a result.

And the population is almost entirely that:

| | count | share |
|---|---|---|
| `owner: agent` AND `blockedOn: none` | **287** | **93.5%** |
| `owner: user` (legitimately theirs) | 3 | 1.0% |
| `blockedOn: external` (a real wait to monitor) | 12 | 3.9% |

So for **93.5% of the population, surfacing to the operator is the one thing the standard
prohibits.** These are the agent's own unblocked work. A design that re-surfaces them to Justin
would convert a follow-through mechanism into exactly the nagging stream the standard forbids —
and would do it at a volume (287) that the notification ceiling exists to prevent.

**That is why the two halves need different mechanisms, and it is not a technical difference.**
An action is an advisory self-improvement item; surfacing it to the operator is appropriate. A
promise with `owner: agent` is work the agent owes and the operator must never be chased about.
Same word — "re-surface" — opposite correct destination.

## Where an agent-owned promise must re-surface instead

**Into the agent's own working context, not the operator's notification surface.**

The measured basis for that, from this same session: a stored note failed to prevent a repeat
three times; a re-injected note caught the fourth; a running check went 9/9. And the one
re-derivation avoided tonight was avoided because the finding lived in a document the agent was
made to read — not because it was filed.

Applied here, the shape is: a bounded number of the oldest agent-owned unblocked promises are
injected into session-start context, the same way preferences and operator bindings already are.
The agent then either drives one to closure or transitions it honestly. The operator sees a
**result**, which is precisely what the standard promises them.

This document deliberately stops at the shape. Three things must be decided before any of it is
built, and none of them is decidable from the numbers above:

1. **How many per session, and chosen how.** Oldest-first is the obvious rule and probably wrong
   — 15 promises over 30 days old would monopolise the slot for a fortnight while the 159 in the
   8–30 day band aged past them. The action half solved the analogous problem with weighted lanes
   plus an age override; whether that transfers is a real question, not a copy.
2. **What a session-start injection costs.** It is prime context, every session, forever. The
   preferences block earned that by being small and by being *about the operator*. A promise
   backlog is neither. An honest budget has to be argued, not assumed.
3. ~~**Whether 287 is a backlog to drain or a signal to fix upstream.**~~ **ANSWERED — see the
   Addendum.** Measured after this section was written: promises accrue at **+314 net over 28
   days** (9.5:1 creation-to-resolution), so no per-run resurfacer at any plausible rate catches
   up. 287 is a growing pile, not a backlog, and the fix belongs at the creation chokepoint.
   Left visible with its original wording rather than deleted, because the sequence — asked as
   open, then measured — is the point.

## What this is NOT

- **Not a proposal to enrol all 291 retroactively.** 287 unblocked promises heartbeating at once
  is the flood the ceiling exists to prevent, and the beacon's own suppression rules were tuned
  against a much smaller population.
- **Not a claim that the beacon is broken.** It is not. It heartbeats exactly the commitments it
  is told to. The defect is that being told is optional.
- **Not converged, not approved, no code.** The action half shipped as a draft for the same
  reason: the design question is worth recording before the build, and the build is worth
  refusing until the question is answered.

## The generalisation worth keeping

Three mechanisms, three populations, reaches of 2.0%, 3.3% and 0.0%. None broken; all
near-empty; all reporting success. The common cause is that **enrolment in the loop-closing
mechanism is an optional field that nothing requires** — a `dueBy` nobody sets, a
`beaconEnabled` nobody sets, a `checkInAt` nobody has ever set.

That is one defect with three faces, and it is the same shape as the seven-instance class this
session catalogued elsewhere: **a mechanism whose coverage is far narrower than what its name
implies, reporting success over the fraction it can see.**

The fix for all three is more likely to be at the **creation** chokepoint — make enrolment a
decision that must be made rather than a field that may be omitted — than in three separate
re-surfacing engines. That is a bigger claim than this document can establish, and it is
recorded as the question the next design should answer first.

<!-- tracked: ACT-1513 -->
<!-- tracked: ACT-1510 -->

---

## Addendum — open question 3 is ANSWERED, and it invalidates the resurfacer shape

Question 3 above asked whether 287 is *a backlog to drain or a signal to fix upstream.*
Measured rather than left open, because the data was already held.

**Promises, last 28 days:**

| week | created | resolved | net |
|---|---|---|---|
| 0–7 days | 145 | 13 | **+132** |
| 7–14 days | 82 | 11 | +71 |
| 14–21 days | 50 | 10 | +40 |
| 21–28 days | 74 | 3 | +71 |
| **28-day total** | **351** | **37** | **+314** |

Creation outpaces resolution roughly **9.5 : 1**, and the most recent week is the worst.

**Measurement honesty.** `deliveredAt` and `updatedAt` do not exist on these records;
`resolvedAt` is present on 610 of 698 terminal rows. A first pass fell back to `createdAt`
when `resolvedAt` was absent, which silently **misdates** a resolution into its creation
week. Redone using `resolvedAt` only, with the 124 unattributable terminal rows **excluded
rather than misdated**.

**Robustness bound.** Assume the worst case for this conclusion — that *every one* of the
124 excluded rows resolved inside the window: resolved becomes 161 against 351 created, so
the net is still **+190**. The conclusion does not depend on the exclusion.

### What that does to the design

A resurfacer that brings back one promise per run cannot work at any plausible rate:

| rate | per week | vs +132/week accumulation |
|---|---|---|
| 4/day | 28 | never catches up |
| 6/day | 42 | never catches up |
| 12/day | 84 | never catches up |

**287 is not a backlog. It is a growing pile**, and a per-run resurfacer against it is a
treadmill — the exact failure the main document warned about as a possibility and can now
state as measured fact. **The fix belongs at the CREATION chokepoint**: enrolment must be a
decision made when a promise is recorded, not a field that may be omitted and compensated
for afterwards.

### Reconciling the two proposals — they are stock and flow, not alternatives

This document now contains two answers to "what should be built", and a reader is owed the
relationship between them rather than left to guess.

| | what it addresses | what it fixes |
|---|---|---|
| **Creation chokepoint** (Addendum) | the **FLOW** — promises being recorded without enrolment | stops the pile *growing*: +132/week does not become +264/week |
| **Agent-context injection** (main body) | the **STOCK** — the 287 already recorded and unenrolled | nothing, on its own — the arithmetic above says it cannot drain them |

They are not competing designs. The chokepoint is necessary and insufficient: it makes every
*future* promise reachable, and does nothing whatever for the 287 that already exist. Nothing
in this document makes a new promise disappear from the existing pile.

**And that leaves a third thing, which is NOT designed here.** If a per-run resurfacer cannot
drain 287, and a creation-time fix does not reach them, then the stock needs its own answer —
most plausibly a **one-time triage** rather than a drip: bulk-classify the existing 307 and
retire what is genuinely moot. 15 of them are more than 30 days old, and a promise made 52
days ago about a specific PR may simply no longer be a live commitment. That is a judgement
call per row, it is a different shape of work from either proposal above, and guessing at it
here would be the third design in a document that already has two.

Stated rather than resolved, because the honest position is that this document establishes
what will NOT work and one thing that will help — and the stock question is genuinely open.

### And this reaches the ACTION half too

The same measurement on actions, which the merged `undated-action-resurfacer` draft covers:

| | created (28d) | closed | net | worst case* |
|---|---|---|---|---|
| **actions** | 1014 | 45 | **+969** | **+416** |
| promises | 351 | 37 | +314 | +190 |

\* worst case assumes every terminal row lacking a close-date (553 for actions, 124 for
promises) resolved inside the window. Actions carry far more of that uncertainty — all 553
cancelled rows lack a close timestamp — so the action figure is the weaker measurement of
the two and is stated as a range rather than a number.

**Even at its most generous, the action backlog grows by ~+416 in 28 days.** So the merged
action-half draft is subject to the same arithmetic: one item per run cannot drain a pile
growing at that rate either.

That does **not** make the action design worthless — re-surfacing guarantees no single item
sits invisible forever, which was its stated and honest scope ("it does not clear the pile…
and it isn't meant to"). But the case for the creation chokepoint is now stronger than that
draft assumed, and this measurement should be weighed before either half is built.

Recorded here rather than as a new action: it answers a question this document asked, and
filing an eleventh row about a backlog measured at 0.74% closure would be the behaviour the
measurement is about.

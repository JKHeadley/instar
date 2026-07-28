# Side-Effects Review — RecurrenceActuator (Tier 2 item 4, plan-only)

**Version / slug:** `recurrence-actuator`
**Date:** `2026-07-27`
**Author:** `Echo (instar-dev agent)`

## Summary

`RecurrenceReader` makes recurrence visible. Visibility was never the goal — the project's diagnosis
is that instar notices constantly and closes almost nothing (≈30:1). A reader nobody acts on is that
ratio with better typography.

Operator directive 2026-07-26 20:08Z: *"the synthesis itself must lead to ACTION and a fully closed
loop"*, minimal user dependence.

`planActuation()` returns a PLAN: for clusters that genuinely recur AND are untracked, propose work on
the EXISTING evolution action queue. Pure — the caller performs the write, so the write path and its
gating stay exactly where they already are.

**Live dry-run, 2026-07-27:** 836 clusters considered → **3 proposed, 17 deferred by cap**
(278x idle-timeout, 238x escalation-suppressed, 177x credential rebalancer — all `high`).

## Refusal evidence (constraint 2)

```
REFUSAL 1 — actions store unreadable  ⇒  propose NOTHING
  refused.reason : actions-store-unreadable
  detail         : "…so 'has anyone already committed to this?' is unanswerable for every
                    cluster. Proposing work now would duplicate whatever is already tracked."
  propose        : []          consideredClusters: 1   ← still honest about scope

DELIBERATELY NOT SYMMETRIC — attention/sentinel unreadable ⇒ it DOES act
  Those only UNDERSTATE counts, so a cluster still clearing the bar genuinely clears it.
  Treating all partial reads alike would be lazy symmetry that blocks safe action.

REFUSAL 2 — per-run cap: 10 qualifying clusters ⇒ propose 3, deferredByCap 7
REFUSAL 3 — below threshold: seen 3x with minCount 10 ⇒ no-qualifying-clusters
REFUSAL 4 — already tracked: a member from the action queue ⇒ propose nothing
```

Tests **10 passed (10)**; combined with the reader **21 passed (21)**; `tsc --noEmit` exit 0.

## A test caught the documented over-merge risk, live

My first cap test built clusters titled `problem 0`…`problem 9` and asserted 3 proposals. It got 1:
the recurrence key normalizes digits to `N`, so all ten collapsed to one cluster. **The fixture was
naive, not the code** — and it is a live demonstration of the over-merge trade the reader's
side-effects review names as its weakest point. Fixed with word-titles and the reason recorded in
the test.

## Decision-point inventory

| point | classification |
|---|---|
| actions-unreadable ⇒ refuse | `invariant` — the load-bearing rule |
| untracked + minCount filter | `invariant` — deterministic thresholds |
| per-run cap, densest-first | `invariant` |
| priority from volume | `invariant` — fixed bands, no model |
| `externalKey` from cluster key | `invariant` — stable, idempotent |

No judgment points, no LLM.

## 1. Over-block

Refuses entirely when the actions store is unreadable — deliberately, since acting blind creates
duplicates. Cost: on a broken actions store, nothing is proposed until it is fixed. Correct trade.

The `minCount` default of 10 will skip genuine problems seen 4–9 times. Accepted: a work item per
seen-twice observation is how the queue got to 371 open in the first place.

## 2. Under-block

**Nothing prevents the CALLER from ignoring the plan or writing it badly.** This module returns data;
the write is the caller's. That is the right seam (the write path keeps its own gating) but it means
"the loop closes" is only true once a caller is wired. No caller ships here — that is the next step
and is not claimed.

**Cancelled actions are not re-proposed-proof.** If a human cancels a proposed action, the cluster
remains untracked, so a later run could propose it again. The `externalKey` makes it the same row
rather than a new one, but a "dismissed, stop asking" state belongs to the action store, not here.
Named as a real gap. <!-- tracked: ACT-1311 -->

## 3. Level-of-abstraction fit

Plan-only, pure over the report. It cannot flood, cannot notify, cannot write. The one thing it
must never become — a fourth place that notices things — is structurally impossible: it has no
output channel.

## 4. Signal vs authority compliance

It proposes; it holds no authority. Creating a tracked action QUEUES work for a human or agent to
judge — it does not close, prioritise beyond a fixed volume rule, escalate, or act.

## 5. Interactions

Consumes `RecurrenceReport` only. No writes, no schema change, no existing caller. Depends on
`RecurrenceReader` (same branch, PR #1662) — this is stacked on it.

## 6. External surfaces

**None.** No route, no config, no persisted state, no user-visible behaviour in this increment.

## 7. Multi-machine posture

**Posture: `machine-local`.** `machine-local-justification: physical-credential-locality` — it plans
over one machine's stores, whose observation titles carry that machine's ids, topics and account
emails. Cross-machine synthesis would mean replicating those records; the correct route is the
existing pool-scope fan-out, serving each machine's data from that machine.

## 8. Rollback cost

**Zero.** One module, one test file, no callers. Delete removes the feature.

## Phase 5 — Second-pass review

No gate/sentinel/watchdog, no block/allow authority, no session lifecycle, no LLM. Author lenses:

**Adversarial — "how would I make this useless?"** Let it propose blind when the actions store is
down (duplicates existing work), or let it propose for everything at once (new backlog). Both are
asserted refusals.

**"Would it have caught the incident?"** The incident is 69 untracked recurrers. It selects exactly
that class and would open the top three today.

**"Symptom or cause?"** Cause for the never-gets-picked-up half. NOT for the recurrence itself —
proposing work does not fix the 278x idle-timeout; it makes someone decide about it. Claiming
otherwise would be filing-as-progress.

**Weakest point:** no caller is wired, so "the loop closes" is a designed property, not yet a
demonstrated one. The dry-run shows what it WOULD propose; nothing has been written.

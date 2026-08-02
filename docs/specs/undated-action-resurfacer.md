---
title: "Re-surfacing the 98%: what brings back an action nobody gave a date to"
slug: "undated-action-resurfacer"
author: "echo"
status: "draft"
created: 2026-07-28
parent-principle: "Close the Loop"
sibling-principles: "Deferral = Deletion; Bounded Blast Radius; Signal vs. Authority; Observability; No Unbounded Loops"
origin: "Measured 2026-07-28 while working the standing 'give Close the Loop a mechanism' goal. The premise was wrong — a mechanism exists. Its reach is 2%."
eli16-overview: "undated-action-resurfacer.eli16.md"
---

# Re-surfacing the 98%

> **The rule.** An action that no one gave a due date to must still come back. Today it cannot: the
> only re-surfacing path keys on `dueBy`, and 98% of the pending backlog has none.

**How to read this document.** It states rules, not their history. Why each rule is shaped as it is
lives in the convergence report.

## 0. The measurement this exists for

Taken on the live agent, 2026-07-28:

| | count |
|---|---|
| pending actions | 912 |
| carrying a `dueBy` | **18** |
| carrying none | **894** |
| of those, HIGH or CRITICAL | **581** |
| oldest undated high-priority | **24 days** |
| **reach of the existing mechanism** | **2.0%** |

**The existing mechanism is not broken.** `evolution-overdue-check` runs every 4 hours, its gate
passes, and it does exactly what it was built to do — surface actions past their due date. The gap is
that nothing requires a due date at filing, so the overwhelming majority of the backlog is not
*neglected* by it, it is **unreachable** by it.

**Two confirming cases, traced independently before the measurement:**

- An action verified 2026-07-13 was **rediscovered five times in fifteen days** by separate
  investigations. No `dueBy`. It could never once have been raised.
- A CRITICAL action filed 2026-07-26 sat while its underlying error rate climbed across three
  measurements (81.0% → 84.8% → 86.5%). No `dueBy`. Same.

Neither was a prioritisation failure. Both were reachability failures.

## 1. What this is NOT

**Not a second overdue checker.** Building one keyed on a different field reproduces the defect with a
new blind spot. The existing checker keeps its job unchanged.

**Not a notifier over a collection.** 581 high/critical undated actions exist right now. A component
that surfaces per-element over that set is precisely the shape the notification-flood ceiling was
built to stop — and it would poison the very surface it is meant to repair. **The bound is the
feature**, not a safeguard bolted to it.

**Not an authority.** It re-surfaces; it never completes, cancels, re-prioritises, or edits an action.

## 2. The rule

**Exactly ONE undated action is re-surfaced per run, or none.**

| element | rule |
|---|---|
| eligible | `status: pending`, no `dueBy`, priority `high` or `critical`, **including rows carrying an explicit `followThroughOptOutReason`** |
| selection | **weighted lanes, not strict tiers**: 3 of every 4 runs draw the oldest eligible `critical`; the 4th draws the oldest eligible `high`. A lane with nothing eligible yields to the other. **Plus a max-age override**: any `high` older than 30 days enters the critical lane. Ties by action id. Excludes anything inside its cooldown. |
| volume | **ONE per run. Never a digest, never a batch.** |
| cooldown | an action re-surfaced is ineligible for 14 days, recorded durably |
| destination | the attention queue, at the action's own priority — never a new topic |
| effect | informational. It states the action id, age, priority, and title. It proposes nothing. |
| terminal | after 3 re-surfacings with no status change, it stops and says so once |

**Why ONE.** At six runs a day the 581-item backlog is not drained, and draining it is not the goal.
One-per-run makes a flood **arithmetically impossible** — that part is unconditional, and it is the
property the bound exists for. A bound that depends on a threshold being tuned correctly fails the
first time the backlog grows; a bound of one does not.

**The creation-time opt-out is not a resurfacing opt-out.** A recorded
`followThroughOptOutReason` explains why the author deliberately chose not to assign a due date. It
does not authorize permanent invisibility, and excluding those rows would create a first-class escape
hatch around this component. Eligibility therefore ignores that field. This distinction matters for
NEW actions as much as for the measured stock: the creation gate makes omission explicit, while this
component keeps the resulting undated row reachable.

**The cadence is durable, not merely a process timer.** The ledger records each run and refuses a new
one until the four-hour interval has elapsed. Startup, a manual pass, and an overlapping invocation all
share that same floor. Otherwise a restart loop or a repeatedly called pass endpoint could emit one
item per process start while still claiming “one per run,” turning a syntactic bound into a flood.

**What it guarantees, stated at the strength it actually has.** Eventual surfacing is NOT
unconditional. It holds only while: the eligible set is finite and not growing faster than one per
run; `createdAt` is stable (a backfill or import that stamps old rows with new dates reorders the
queue); and the scheduler is actually running. **Under sustained inflow above six per day, oldest-first
means the newest eligible rows are never reached** — the queue is not starved of attention, but the
tail of it is. Saying "nothing can sit forever" without those conditions would be the overclaim this
project keeps catching, so: **bounded flood unconditionally; eventual surfacing under the stated
assumptions.** The `eligible` metric (§2.1) is what makes a violated assumption visible — if it climbs,
the guarantee is not holding.

**Why weighted lanes — and this rule was wrong TWICE before it was right.**

Draft 1 said "oldest among high or critical". That lets a newly-filed CRITICAL wait behind hundreds
of older HIGH rows — age outranking severity.

Draft 2 said "all critical before any high". That fixes the first defect and **introduces its mirror
image**: with non-trivial critical inflow, HIGH rows are never reached at all. And a HIGH row is the
motivating failure of this entire spec — the 24-day-old one nothing had looked at. A rule that
structurally starves the case you wrote the component for is worse than the rule it replaced.

**Both drafts made the same mistake in opposite directions: letting one dimension dominate
absolutely.** The fix is a fixed ratio, so neither lane can starve the other, plus an age override so
a HIGH row cannot be indefinitely outranked no matter what the critical inflow does. Still fully
deterministic, still no scoring model — a run's lane is a function of its index.

**Why the terminal rung — and why "stop reminding" is NOT what it does.** An action re-surfaced three
times without moving is not being ignored by accident; something is wrong with the row itself. But a
rung that merely stops reminding would **replace silent rot with acknowledged rot** — the same
abandonment, now with a receipt. That is a worse outcome than the problem, because it launders the
failure as a handled state.

**Rule: the terminal rung DEMANDS A DISPOSITION, it does not end the loop.** On the third raise the
component records the row as `needs-disposition` and stops raising it — and that state is itself
surfaced, in aggregate, as a standing count. Exactly one of four things then closes it: the action is
**worked**, **cancelled with a reason**, **given a `dueBy`** (moving it to the existing overdue path),
or **split** because it was too large to move. All four are human or agent decisions this component
never makes.

**The aggregate needs a CONSUMER, or it is rot at a higher altitude.** "Countable rot" is better than
invisible rot and is not closure — an aggregate nobody reads is the same abandonment one level up, and
saying so is the point of the standard this serves.

So the count is not merely published: **when `needs-disposition` exceeds 10, that itself becomes a
single attention item at HIGH, subject to the same one-per-run bound and its own 14-day cooldown.**
That is the consumer. It is deliberately one threshold and one item — a second flood surface built to
watch the first would be absurd.

**Concurrency, designed rather than asserted.** The stable-state-owner + serving-lease conjunction
(§4) prevents a lease handoff from changing ledger authority; it does not prevent two overlapping
scheduler processes on that SAME owner. Every reconcile, retry claim, cadence check, selection, and
`pending-emit` append therefore runs under one inter-process ledger lock. Delivery happens only after
the lock is released, against the durable claim, and state ownership + serving lease are re-checked
immediately before the external emit. A losing invocation exits; it does not fall through to the next
candidate, because a run that emits two rows is no longer one-per-run.

## 2.1 What it meters — the whole loop, not the raise

*Observability* is this spec's parent principle, and that standard is explicit that a **capture-only
metering set is a half-measure**: it cannot tell you whether what you captured ever changed anything.
A component that counted its own raises would be exactly that — it would prove it fired, and prove
nothing about whether firing helped.

**Recorded per run:**

| metric | why it is not optional |
|---|---|
| `eligible` | the size of the undated high/critical pool. **This is the number the component exists to reduce.** If it does not fall over months, the component is decorative. |
| `raised` | 0 or 1, and WHICH action id |
| `skipped-cooldown` | how many eligible rows were held back. A large number beside a small pool means the cooldown is mis-set. |
| `terminal` | actions that hit the 3-raise stop |

**Recorded per raised action, which is the half that makes this a loop:**

| metric | why |
|---|---|
| `statusAtRaise` → `statusAt+14d` | **did re-surfacing change anything?** The one question that decides whether this component earns its place. |
| `raiseCount` | 1, 2, or 3 — the distribution says whether one raise is usually enough |
| `ageAtFirstRaise` | how long a row waited before anything reached it. Should trend DOWN once running. |

**The success test is stated in advance so it cannot be rationalised later:** if, after a soak, raised
actions change status at no better a rate than unraised ones of comparable age and priority, this
component is **not working** and its removal is the correct response — not a tuning pass. A
re-surfacer that is ignored is a notifier, and this project has enough of those.

**Where it lands:** fired/no-op/error events use the existing per-feature metrics surface. The health
read exposes the control ledger's own projection — owner/lease block reason, last attempt, run,
unexpected run error, pool/cooldown counts, pending/failed/abandoned claims, disposition-alert state,
per-action raise and age state, and delayed outcomes by status. There is no second observation-only
store: the same ledger that enforces cooldown is the evidence source.

## 2.2 The ledger — a state model, not "recorded durably"

"Recorded durably" is not a specification. The cooldown and the raise-count live in one append-only
ledger keyed by action id:

| field | meaning |
|---|---|
| `actionId` | key |
| `firstRaisedAt`, `lastRaisedAt` | timing |
| `raiseCount` | 1-3 |
| `observedStatus`, `observedPriority`, `observedDueBy` | the row's state AS SEEN at the last raise |
| `disposition` | unset, or `needs-disposition` after the third |

**What RESETS the count, and this is the part a naive ledger gets wrong:** "3 raises with no status
change" must not ignore meaningful edits that are not status. If `priority`, `dueBy`, or the action's
content changed since `lastRaisedAt`, **somebody engaged with the row** — the count resets and the
cooldown restarts. Comparing only `status` would keep escalating a row that a human had actively
worked on, which is the fastest way to make this component hated.

**What RETIRES the entry:** the action leaving `pending`, or gaining a `dueBy` (it becomes the existing
mechanism's problem, and two paths must never both own one row).

**Append-only events, derived state — because the table above mixes them.** `raiseCount`,
`disposition` and retirement are field-LIKE, which an append-only log cannot hold directly. The store
is an event stream (`run`, `pending-emit`, `emitted`, `claim-abandoned`, `reset`, `retired`,
`disposition-set`, outcome and disposition-alert claim events); the table above is
the PROJECTION derived by folding those events per action id. The projection may be cached, and it is
always reconstructible from the events — so a corrupt cache is a rebuild rather than a data loss.

**Atomicity — and an earlier draft had this exactly backwards.** It said "write the ledger before the
raise" and claimed a crash would cost a duplicate. It would cost the opposite: the ledger records the
raise, the cooldown then excludes the row for 14 days, and **the attention item is never emitted.** A
silent miss — the precise failure this component exists to prevent, produced by its own bookkeeping.

**Rule: two-phase, emit-then-confirm.**
1. Append `{actionId, raisedAt, state: pending-emit}`.
2. Emit the attention item.
3. Atomically mark the entry `emitted`.

A crash between 1 and 2, or 2 and 3, leaves a `pending-emit` row. **On start, any `pending-emit` older
than one run interval is REPLAYED.** When the two failure directions are "says something twice" and
"silently says nothing", a component about not-forgetting must choose the first — and must not confuse
itself about which one it chose.

**"A duplicate is harmless" is an assertion, so it is replaced by a mechanism.** Each raise carries a
stable idempotency key — `resurface:{actionId}:s{series}:{raiseCount}` — and the attention queue's
existing dedupe consumes it, so a replay of an item the queue already accepted collapses rather than
appearing twice. A meaningful edit durably increments `series`: its first new raise therefore cannot
be swallowed by the permanent Attention id from an earlier series. That matters because the
destination is the surface this component exists to protect: an
attention queue that amplifies duplicates is the flood failure arriving through the back door.
**Replay is bounded**: three attempts, then the entry is marked `emit-failed` and counted in the §2.1
metrics — a poison row must not retry forever, and it must not vanish either. The aggregate
disposition alert uses the same three-attempt terminal and consumes its 14-day cooldown on terminal
failure; clearing a failed claim must not immediately mint another retry budget for the same unchanged
aggregate.

**Storage is bounded too.** The active ledger has a hard 4 MiB ceiling, below the repository's
whole-file synchronous-read limit. The writer refuses before crossing it; it does not truncate an
un-acted row or rewrite the append-only history. Capacity refusal emits one stable-id HIGH Attention
item and the health read exposes the byte count, ceiling, and exceeded state. This is deliberately a
loud stop: silently deleting old cooldown/disposition evidence would let forgotten rows re-enter as
new, while an unbounded ledger would turn a long-running agent into a slow storage failure.

## 2.3 Why not `nextReviewAt` on the action itself

The industry-standard shape for this is a review-date field on the record — `nextReviewAt`, snooze-
until, a workflow timer — rather than an external ledger and a second selection path. That would unify
dated and undated review into one mechanism, which is genuinely more elegant.

**It is rejected for one reason, and it is the reason this spec exists:** a review date is a field
someone has to set. `dueBy` is already exactly that field, nothing requires it, and the measured
result is 2% coverage. Adding a second optional date field would reproduce the defect under a new
name — the 894 rows that have no `dueBy` today would have no `nextReviewAt` tomorrow, for the same
reason.

**The property that matters here is that eligibility requires NOTHING to have been filled in.** An
external ledger over "everything pending, undated, important, oldest first" cannot be under-populated
by an author who was in a hurry. That is worth the second path.

**The strongest counter, which the rejection above does not answer.** Review raised it: the industry
pattern is not an *optional human-entered* review date but a **system-assigned default** written at
creation — every action gets a `nextReviewAt` automatically, so under-population is impossible by
construction and dated and undated review collapse into one path. That is a better argument than the
one this section originally rebutted, and it may well be the right long-term shape.

**Why this component is still proposed, stated as a trade rather than a refutation:**

| | system-default `nextReviewAt` | this component |
|---|---|---|
| covers new actions | yes, by construction | yes |
| **covers the existing 894** | **only via a backfill that invents a review date for every one** | yes, immediately, without touching a single row |
| changes the action schema | yes | no |
| failure mode | a default that is wrong for a whole class is invisible until the class comes due | a bad selection is visible in the next run's output |

**The deciding factor is the backfill.** Assigning a review date to 894 existing rows means choosing
one for each, and the only information available to choose from is age and priority — which is exactly
what this component reads directly, without writing anything. Where a migration would have to *invent*
data to make the mechanism work, reading it live is the smaller move.

**This is a preference under uncertainty, not a proof.** If a system-default review date is
implemented, **this component becomes redundant and should be DELETED rather than kept** — recorded
here so that outcome reads as success rather than as loss, and so nobody later defends this design out
of ownership.

## 3. Decision points touched

| Decision point | classification |
|---|---|
| which actions are eligible | `invariant` — a field test over recorded values, no judgment |
| which one is selected | `invariant` — the fixed 3:1 critical/high lane schedule plus the 30-day high max-age override, then oldest `createdAt`, with a deterministic tie-break by id |
| how many per run | `invariant` — exactly one, not tunable |
| when it stops | `invariant` — 3 re-surfacings, counted durably |

None is a competing-signals point. Nothing here weighs, scores, or infers; every rule is a comparison
over data already recorded. A judgment-candidate would be the wrong shape: the value of this component
is that its behaviour is completely predictable, so a flood cannot arise from a misjudgement.

## 4. Multi-machine posture

**Posture: stable-owner machine-local.**

machine-local-justification: hardware-bound-resource — the ledger is keyed by that machine's local
action ids and describes its local EvolutionManager queue; the queue and its cooldown history are one
owner-bound resource and cannot be moved independently without changing identity.

The controller is allowed to act only when that SAME stable owner also holds the serving lease.

**Lease ownership alone is insufficient.** An earlier draft said the current lease holder could own a
machine-local ledger. After a handoff the new holder has an empty ledger, so its first run can repeat a
row still cooling down on the old holder and reset the three-raise terminal. Stable Attention ids do
not repair that: the Attention store is also owner-local, and suppressing one visible duplicate would
still leave split outcome and terminal state.

**DECIDED: pool-agreed stable ledger owner AND serving lease.** On a multi-machine agent each machine
advertises its explicit `stateOwnerMachineId` proposal in its authenticated capacity heartbeat. The
local value is never authority by itself. A pass requires all three predicates:

1. every registered pool member's latest authenticated advert carries the same non-empty owner id;
2. this machine is that stable ledger owner; and
3. this machine currently holds the serving lease.

A handoff away from the ledger owner therefore PAUSES resurfacing. A handback resumes from the same
cooldown, retry, outcome, and disposition history. A non-owner does not create a run event, claim, or
Attention item. If an advert is missing or two local configs disagree, every machine remains readable
but refuses with `state-owner-unconfigured`; the health projection includes the agreement posture and
disagreeing participants. That is an honest coverage gap, not a fresh local ledger. Offline registered
peers remain in the check through their last authenticated advert: otherwise each side of a partition
could call its one-member local view "agreement." After a process restart with no last-known peer
advert, resurfacing pauses until authenticated presence restores it.

**The cost, stated:** this is safe under handoff but not highly available. If the stable owner is
offline or the lease sits elsewhere, nothing re-surfaces. Reassigning the state owner requires moving
the ledger with it; automatic owner migration is deliberately not claimed. Replicating this ledger is
the future path if uninterrupted multi-machine cadence becomes worth the additional protocol.

## 5. Frontloaded decisions

| # | decision | resolution |
|---|---|---|
| 1 | Volume | **One per run.** Not configurable — a tunable bound is a bound that fails when the backlog grows. |
| 2 | Eligibility | `high`/`critical` only for the first application. `medium`/`low` undated actions are the larger population and the smaller loss; widening later is additive. |
| 3 | Destination | The existing attention queue at the action's own priority. No new topic, no new surface. |
| 4 | Cooldown | 14 days, durable. Short enough that a genuinely stuck item returns; long enough that one run cannot chase the same row. |
| 5 | Stop condition | 3 re-surfacings without a status change, then a single terminal note. |
| 6 | Authority | Deterministic delivery-policy authority over eligibility, cadence, and Attention delivery; **no semantic authority** to mutate or dispose an action. |
| 7 | Rollout | Ships **dark**, then dry-run (logs the row it WOULD raise), then live. The dry-run stage is the real test: it proves the selection is sane against a 581-row backlog before anything is raised. |
| 8 | Explicit follow-through opt-out | Does **not** affect eligibility. It records why no due date was chosen; it never grants invisibility from the undated-action path. |

## 6. Open questions

*(none)*

> §4's multi-machine choice was described in an earlier draft as "lease-holder only." Adversarial
> review overturned it because a lease chooses an actor but does not move local cooldown state. The
> stable-owner + lease conjunction is now the decided v1 posture.

## 7. Deferred work

- **Widening to `medium`/`low`** <!-- tracked: ACT-1510 --> — deliberately not in the first
  application. The high/critical set is where the measured damage is.
- **Draining the existing 581-row backlog** <!-- tracked: ACT-1510 --> — **this component is NOT
  sufficient remediation for the measured harm, and must not be presented as such.** The live problem
  IS that pile; at one per run, reaching all 581 takes roughly three months, by which time the oldest
  rows are four months old. What this component guarantees is that the pile cannot grow *silently* and
  that its oldest important rows are continuously surfaced — which is prevention, not a cure.
  **Disposing of the existing 581 requires a bounded one-off review**, which is separate work with a
  separate flood profile. Shipping this and declaring Close the Loop solved would be exactly the
  overclaim this project keeps catching.

## 8. What "done" means

**BOTH are required. Neither substitutes for the other.**

**1. All THREE test tiers, per the Testing Integrity Standard — not "some deterministic tests".**

| tier | what it must cover here |
|---|---|
| **Unit** | the pure selection rule with real inputs: priority-tier-before-age, tie-break by id, cooldown exclusion, count-reset on a non-status edit, terminal transition at the third raise, retirement when a row gains a `dueBy`. |
| **Integration** | the ledger + emit path end to end: two-phase `pending-emit` → emit → confirm, replay of a `pending-emit` left by a simulated crash, the conditional-write claim under two overlapping runs, the `needs-disposition` threshold raising exactly one item, a reset through the real `TelegramAdapter` dedupe store, and a growth burst proving the file refuses at its byte ceiling without truncation. |
| **E2E lifecycle** | the production initialization path — the component is CONSTRUCTED, wired to the real action-store implementation and the production Attention delegation seam, and a run selects and delegates a raise. The external Telegram transport is deliberately replaced by a capture adapter in this tier; real Attention persistence/dedupe semantics are covered by integration, while live transport evidence remains a rollout gate. **This is the tier that would have caught a reaper reporting "0 reclaimable" beside 39GB**, because it proves the thing is reachable rather than merely correct. |

**Wiring integrity is required explicitly**, per the same standard: assert the injected action-store
reader and attention emitter are neither null nor no-ops and delegate to the real implementations. A
component whose emitter is a stub passes every unit and integration test above while raising nothing —
the exact shape this whole spec exists to prevent, reproduced inside its own test suite.

**2. Live evidence — required for rollout completion, not claimed by a draft code PR.** A command and
its output must show a specific, real, previously-invisible action raised. The two cases in §0 are the
natural candidates: both undated, both old, both demonstrably unreachable before. Until the dark →
dry-run → live maturation reaches that observation, the implementation may be code-complete and under
draft review, but the feature is not "done" under this section.

**Why both, stated because picking one is the tempting shortcut:** a fixture test proves the logic is
what I wrote down; it cannot prove the component is reachable, wired, and pointed at the real store —
which is exactly the failure class that produced a reaper reporting "0 reclaimable" beside 39GB of
worktrees. Conversely a live raise proves it is wired and cannot prove the cooldown or the terminal
rung behave under conditions that will not occur during a demo. **Each covers the other's blind
spot**, and this project has a long record of shipping one and calling it verified.

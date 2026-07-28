---
title: "A commitment with a date produces a reminder when the reconciler is live (ACT-724 step 1 of 2)"
slug: "dated-commitment-reminder"
author: "echo"
status: "draft"
created: 2026-07-25
parent-principle: "Structure beats Willpower"
sibling-principles: "Close the Loop (Untracked = Abandoned); The Agent Carries the Loop; Deferral = Deletion <!-- tracked: ACT-724 --> (step 2, the creation-time gate, is owned by ACT-724 which stays OPEN until it lands); No Silent Degradation to Brittle Fallback; Testing Integrity"
lessons-engaged: "the 2026-07-17 hand-built benchmark-checkin-reminder and its three named defects (ACT-724); the 2026-07-25 scheduler never-run-window fix (defect (a), landed separately as its prerequisite)"
origin: "ACT-724, priority critical, pinned — operator directive (Justin, topic 33368, 2026-07-17): 'make date-bearing commitments structurally reliable'. Built during the 2026-07-25 autonomous run, topic 33368, task 4."
eli16-overview: "dated-commitment-reminder.eli16.md"
review-convergence: "2026-07-25T11:54:54.769Z"
review-iterations: 2
review-completed-at: "2026-07-25T11:54:54.769Z"
review-report: "docs/specs/reports/dated-commitment-reminder-convergence.md"
approved: true
approved-by: "Autonomous run 2026-07-25, topic 33368 — task 4 of the operator-authored run plan ('dated-commitment auto-reminder standard (ACT-724)', completion condition: shipped as merged code), under the run's standing instruction that decisions are reversible and dark-shipped: 'make the call, state it, keep going.' ACT-724 itself is an operator directive (Justin, topic 33368, 2026-07-17), priority critical, pinned."
approval-scope-note: "NOT a quoted per-design approval — the directive authorized the OUTCOME and I chose the mechanism. Two deviations are on the record rather than assumed. (1) ACT-724 sketches one one-shot scheduler entry PER commitment; I built a single recurring reconciler instead, because the sketch as written reproduces two of the three defects the action itself lists (the two-file job dance, and self-disable by file edit). Argued in section 2.1. (2) The directive asks that a dated commitment without a reminder be STRUCTURALLY IMPOSSIBLE; this ship does not achieve that, because it lands dark and a disabled watcher guarantees nothing. The honest split (true now vs true at graduation) is written into the title and the maturation plan, and was surfaced to Justin in topic 33368 on 2026-07-25 with the rendered ELI16 before shipping — not disclosed afterwards. Reversible: disable the flag or the job; no migration, no durable cleanup."
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# A commitment with a date reminds you on that date

## 1. The problem

When I tell you "I'll check in on this by Friday", that date currently lives in
one of two places: my intention, or a soft field on the commitment record that
only the PromiseBeacon reads. The beacon is a cadence heuristic — it decides how
often to nudge, not that a specific date has arrived. So a date-bearing promise
depends on a session still existing on Friday and still caring.

ACT-724 states the requirement directly: opening a date-bearing commitment
WITHOUT its reminder materialized should be **structurally impossible** — a gate
in code, not a line in a prompt.

The hand-built version (`benchmark-checkin-reminder`, 2026-07-17) proved the
shape of the problem by failing three ways, all recorded in the action:

- **(a)** the scheduler's startup missed-job sweep fired the brand-new,
  future-dated job immediately;
- **(b)** a user job silently does not load without BOTH a `jobs/user/*.md` and
  a schedule manifest entry — a two-file dance, restart required;
- **(c)** self-disable by editing its own file is fragile.

**(a) is already fixed** and shipped separately (`scheduler-never-run-window`) —
it was a real scheduler defect independent of this feature, and building on top
of it would have produced reminders that discharge themselves at boot. This spec
addresses (b) and (c) by construction, below.

## 2. Design

### 2.1 One recurring reconciler, not one job per commitment

**Frontloaded decision 1 — this deliberately departs from the action's design
sketch, and the reason is (b) and (c).**

ACT-724 sketches: "materializes exactly ONE one-shot scheduler entry that fires
at that date". That is a faithful description of the *requirement* but, taken
literally as the *mechanism*, it reproduces the two defects it lists:

- a per-commitment scheduler entry needs a job file + a manifest entry
  (defect (b)), created programmatically at commitment time and requiring the
  scheduler to notice it;
- retiring it after delivery means deleting or disabling that entry — a
  self-disable by file edit (defect (c));
- and it needs genuine one-shot semantics, which the scheduler does not have.

Instead: **one built-in recurring job** (`commitment-checkin-reminder`) drives a
server-side reconciler that scans the commitment store for open commitments
whose `checkInAt` has arrived and posts one reminder each.

This satisfies the requirement more strongly than per-commitment entries:

| requirement | how the reconciler satisfies it |
|---|---|
| one reminder per dated commitment (see §2.3 for the precise guarantee) | an idempotency stamp on the commitment (`checkInReminderSentAt`), written through the existing single-writer CAS `mutate()`, plus delivery-layer dedup |
| materialization cannot be forgotten | there is no per-commitment wiring to forget — the reconciler scans the store, so EVERY dated commitment is covered the moment it exists |
| torn down on deliver/withdraw | terminal status makes the commitment ineligible; nothing to tear down, nothing to delete |
| survives restarts | the durable state is the commitment record, which already survives; the job is a normal built-in |
| deduped per commitment | the stamp is the dedupe key |
| rides the proven scheduler layer | it is an ordinary recurring built-in job, the most-exercised path in the scheduler |

**The structural guarantee is stronger by being negative:** rather than adding a
step that must happen at creation time (which can fail, be skipped, or race), we
remove the step entirely. A dated commitment is covered because coverage is a
property of the scan, not of a registration that might not have run.

### 2.2 `checkInAt` is a first-class field

`Commitment` gains `checkInAt?: string` (ISO). It is distinct from the three
existing date fields, and the distinction is the point:

| field | who reads it | meaning |
|---|---|---|
| `nextUpdateDueAt` | PromiseBeacon | soft "I said I'd update by here" — nudges cadence |
| `softDeadlineAt` | PromiseBeacon | past it, cadence doubles |
| `hardDeadlineAt` | CommitmentTracker | past it, the commitment expires |
| **`checkInAt`** | **this reconciler** | **a specific promised moment; produces exactly one reminder** |

**Frontloaded decision 2 — do NOT overload `nextUpdateDueAt`.** It is beacon
cadence input with existing semantics (it moves as the beacon nudges). A field
that both drives cadence and pins a one-time reminder would make each behaviour
a side effect of the other.

### 2.3 Firing, and what a reminder is allowed to be

**The full eligibility predicate** (all clauses must hold — stated completely
because an incomplete one would re-select a commitment forever after its retries
were exhausted):

    checkInAt is present AND parseable
      AND topicId is a finite number
      AND status is OPEN (only `pending`; an unknown status is NOT open)
      AND checkInReminderSentAt is absent      (not already delivered)
      AND checkInReminderAttempts < CHECK_IN_MAX_ATTEMPTS   (retries remain)
      AND checkInAt <= now

For each commitment satisfying it:

1. **Send FIRST; stamp `checkInReminderSentAt` only on success.**

   **Frontloaded decision 3, and this spec's first draft got it backwards.** The
   draft stamped before sending, reasoning that a duplicate cannot be recalled
   while a miss is recoverable. External review named the consequence: that
   makes ZERO deliveries a *designed* outcome. A failed send left the commitment
   marked `checkInReminderSentAt` — a field asserting a delivery that never
   happened — and permanently ineligible. The feature whose purpose is that
   promises are not silently dropped would have silently dropped them, and
   recorded the drop as a success.

   Sending first restores at-least-once. The duplicate it risks — a crash
   between send and stamp — is absorbed by the relay's **existing content
   dedup** (`outboundContentDedup.isDuplicate` / `tryReserve`: identical text to
   the same topic inside its window). The platform already solves the problem
   the wrong ordering was invented to solve; the draft reached for a novel
   trade-off instead of the capability sitting one layer down.

   Attempts are counted (`checkInReminderAttempts`) and bounded at
   `CHECK_IN_MAX_ATTEMPTS = 5`: a transient failure gets another pass, and a
   permanently broken transport is given up on LOUDLY via
   `checkInReminderFailedAt` — an undelivered reminder recorded as undelivered.

   **The dedup contract, stated because relying on it unstated was nearly a
   false claim.** `TelegramAdapter.sendToTopic` does NOT dedup — the content
   dedup lives in the `/telegram/reply` route. So the reminder's send is routed
   through the same `OutboundContentDedup` instance explicitly. Its semantics
   here:

   - a duplicate is **success-equivalent**: the user already has this exact
     text, the send is complete, and the caller MAY stamp. Treating it as a
     failure would retry-loop until the window expired and then genuinely
     double-send;
   - the reservation is **released on a transport error**, so a real failure
     retries instead of being suppressed as a "duplicate" next pass;
   - the store is **durable (SQLite, per stateDir)**, so it survives the restart
     the crash window implies — which is what makes it a real mitigation rather
     than an in-memory nicety.

   **The honest guarantee is therefore AT-LEAST-ONCE, deduped at the delivery
   layer — not exactly-once.** Two windows remain: a crash between send and
   stamp re-sends and is absorbed only while the dedup window holds; and two
   DISTINCT commitments with byte-identical text to the same topic inside that
   window would suppress each other (the text embeds the promise and its date,
   so this needs two identical promises with identical dates). Both are stated
   rather than designed away; a durable per-commitment idempotency key at the
   delivery layer is the upgrade if either is ever observed.
2. Post to the commitment's `topicId` via the deterministic delivery path, not
   the LLM tone-gated path. Rationale: this message must not be capable of being
   held by a gate that fails closed — a reminder that does not arrive is the
   whole defect. The text is fixed-template and carries no agent prose, so there
   is nothing for a tone gate to judge.
3. The reminder states the promise and its date. It does NOT claim work was
   done, and it does NOT mark the commitment delivered — closing the loop
   remains a deliberate act.

### 2.4 Dark-first

Ships behind `commitments.checkInReminder` (dev-agent gated, `dryRun: true`
first — the reconciler logs what it WOULD send). The built-in job manifest ships
`enabled: false`.

**What "structurally impossible" does and does not yet mean.** ACT-724 asks that
opening a date-bearing commitment without a materialized reminder be
structurally impossible. Reviewers correctly noted that a feature behind a
disableable flag cannot claim that today. The honest split:

- **Now (dark launch):** coverage is structural *given the reconciler runs* —
  there is no per-commitment registration to forget, so no dated commitment can
  be individually missed. But the reconciler itself can be off, so a dated
  commitment CAN exist with no active delivery.
- **At graduation:** the invariant becomes real via a boot check that refuses to
  accept a `checkInAt` on a new commitment when the reconciler is not live —
  failing the creation loudly rather than accepting a date nothing will honour.
  That check is deliberately NOT shipped dark, because a gate that is itself
  disabled guarantees nothing.

This is recorded as the graduation step rather than asserted as today's
property.

### 2.5 Time semantics

`checkInAt` is an **absolute instant**, stored as an ISO-8601 string with an
explicit offset (`Z` preferred). It is never a bare date.

This is specified rather than assumed because "Friday" is not a time: a date
without an instant has to invent an hour, and inventing it in the server's local
zone means the same commitment fires at different moments on different machines.
Normalization from natural language happens at the CREATION boundary (the caller
resolves "Friday" to an instant, in the operator's timezone, before the value is
stored) — so the reconciler never interprets human dates, and there is exactly
one place where the ambiguity is resolved.

Consequences, stated:

- **DST / clock changes:** an absolute instant is immune. A commitment set for
  09:00 local on a day the clock shifts fires at the instant that was computed
  at creation; it does not silently move.
- **Clock jumps:** the predicate is a comparison against `Date.now()`. A large
  backwards jump delays a reminder; a forward jump fires it early but exactly
  once. Neither can double-send (the stamp) nor permanently suppress (no stamp
  is written without a delivery).
- **Unparseable values fail closed** — no reminder, reason recorded — rather
  than coercing to epoch 0 and reading as infinitely overdue, which is precisely
  the boot-fire shape fixed in `scheduler-never-run-window`.

### 2.6 Cadence, scale and lateness

- **Cadence:** the built-in job runs every 5 minutes. That sets the worst-case
  lateness of a reminder to ~5 minutes past its instant, which is the accuracy
  a "check in by Friday" promise needs; it does not attempt second-accuracy.
- **Scale:** the pass reads the commitment store, which is already fully loaded
  in memory by `CommitmentTracker` and is bounded by the number of live
  commitments (tens, not millions). No new index is required *at this size*, and
  claiming one would be false precision. If the store ever grows to where a
  linear scan matters, the predicate's clauses (`status`, `checkInAt`,
  `checkInReminderSentAt`) are exactly the index that would be needed.
- **Backpressure:** each pass is capped (`maxPerPass`, default 25). A cap that
  drops work says so in the log and the pass report; the remainder is picked up
  next pass, which is safe because the stamp prevents re-sending what already
  went. An overdue backlog therefore drains at 25 per 5 minutes rather than
  flooding a topic in one burst.

### 2.7 Alternatives considered

| alternative | why not |
|---|---|
| **One-shot scheduler entry per commitment** (the action's sketch) | Reproduces defects (b) and (c) it lists: needs a job file + manifest entry, and retiring it after delivery is a self-disabling file edit. Also needs one-shot semantics the scheduler does not have. |
| **Transactional outbox** (a durable `reminder_deliveries` table with pending/sent/failed) | The textbook answer, and genuinely more robust for high-volume multi-consumer delivery. Rejected as over-built *here*: the commitment record already IS durable state with a single-writer CAS, so an outbox would add a second store to keep consistent with it — a new class of divergence bug to guard a volume (tens of commitments) that does not need it. The fields on the commitment are a degenerate outbox with one row per commitment. |
| **Durable queue / workflow engine** | Same reasoning, larger. It would introduce an external dependency and its own failure modes to schedule a message every few days. |
| **Recurring scan (chosen)** | Coverage is a property of the scan, so no registration step can be skipped; teardown is a status check; it rides the most-exercised path in the scheduler. |

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| "is this commitment due for its check-in reminder?" | `invariant` | A closed arithmetic question over durable state: open status AND `checkInAt <= now` AND no stamp. No competing signals, no context to weigh, no prose to interpret. The failure being fixed was an ABSENT mechanism, not a bad judgment. |
| The reminder's text | `invariant` | Fixed template. Deliberately not model-authored: a reminder is a fact ("you said X by Y"), and generating it would introduce a judgment where none is wanted — plus a failure mode (provider down) on a path that must not fail. |

## Multi-machine posture

- **`checkInAt` / `checkInReminderSentAt` on the commitment — unified.** They
  live on the commitment record and inherit whatever posture the commitment
  store has; no new surface.
- **The reconciler — LEASE-GATED, single-writer.** On a multi-machine pool the
  pass runs on the serving-lease holder ONLY (the same rule the
  benchmark-divergence analysis pass uses), so two machines cannot both send.
  Belt-and-braces: even if two ran, the CAS stamp makes the second a no-op —
  the lease gate prevents the wasted work, the CAS prevents the duplicate.
  `machine-local-justification` is NOT claimed; this is unified behaviour with a
  single-executor rule.
- **The built-in job — per-machine by nature** (each machine runs its own
  scheduler), which is exactly why the lease gate is required rather than
  optional.

## Open questions

*(none)*

> Whether a fired reminder should also bump the beacon cadence is a real
> question but not a blocking one: the beacon already has its own inputs, and
> coupling them would re-entangle the two mechanisms §2.2 separates.

## Maturation plan

- **test-agent-live:** the reconciler runs in `dryRun` on a development agent,
  logging would-send decisions against real commitments.
- **dev-agent-live:** flip `dryRun:false` on the dev agent after a soak in which
  the would-send set matches hand-checked expectations.
- **dark-window:** fleet-dark throughout (`enabled` omitted → dev-agent gate;
  job manifest `enabled:false`).
- **graduation criterion:** on a development agent, a commitment created with a
  `checkInAt` in the near future receives ONE reminder in its topic at that
  time; a second reconciler pass sends nothing; delivering the commitment before
  the date results in no reminder at all; and a forced send failure leaves
  `checkInReminderSentAt` ABSENT (never a false delivery). All four observed on
  the live agent, not only in tests.
- **step 2 (the invariant):** the creation-time gate that refuses a `checkInAt`
  when the reconciler is not live. It CANNOT ship dark — a gate that is itself
  disabled guarantees nothing — so it lands only once the reconciler has
  graduated. Until then this spec's title says "when the reconciler is live",
  which is the true claim.
- **fleet:** a separate, later decision — not implied by this ship.

## Testing

- **Tier 1** — the due-predicate on both sides of EVERY clause above (open vs
  terminal, before vs after `checkInAt`, delivered vs not, retries remaining vs
  exhausted, routed vs unrouted, parseable vs not); idempotency under repeated
  passes; **send-before-stamp ordering**, asserting that a FAILED send leaves
  `checkInReminderSentAt` ABSENT (the regression test for the round-1 finding);
  bounded retry reaching a loud terminal `checkInReminderFailedAt`; a transient
  failure followed by success delivering and only then stamping; the per-pass
  cap deferring rather than dropping.
- **Tier 2** — the reconciler through the real route: a due commitment produces
  one post, a second pass produces none, a delivered commitment produces none,
  and the route 503s when the feature is dark.
- **Tier 3** — the real `AgentServer` boot with the feature live: a commitment
  with a past `checkInAt` is reminded exactly once through the production
  initialization path.

## Rollback

Disable `commitments.checkInReminder` (or the job manifest). The reconciler is
the only reader of `checkInAt`; commitments keep the field harmlessly. No
migration, no durable cleanup — an un-fired stamp is inert.

---
title: "Periodic Goal Re-Alignment (automatic topic-goal resync)"
slug: "periodic-goal-realignment"
author: "Echo"
eli16-overview: "periodic-goal-realignment.eli16.md"
status: draft
phases: 3
review-convergence: "2026-07-27T17:53:01.828Z"
review-iterations: 7
review-completed-at: "2026-07-27T17:53:01.828Z"
review-report: "../../.worktrees/goal-realignment-spec/docs/specs/reports/periodic-goal-realignment-convergence.md"
---

# Periodic Goal Re-Alignment (automatic topic-goal resync)

## Problem statement

Long-running work drifts. On 2026-07-23 the operator issued a course-correction to a
14-hour autonomous drive: the session's queue had accumulated locally-sensible next
steps whose sum no longer matched the topic's top-level goals, and the operator had
to manually direct "review all the messages in this topic from the last week to see
the priorities in our top level goals." His directive, verbatim: "it's feeling like
that needs to be something you do automatically regularly otherwise it feels like
the goals get misdirected or start working towards solutions [that] don't have
alignment with a holistic view."

Today the only defenses are willpower-class: the agent remembering to re-read the
topic, or the operator noticing drift and intervening. Both failed silently for
hours. Per the constitution's foundational standard, if the behavior matters it must
be enforced structurally — a re-alignment the agent must remember to run is a wish.

## CLASS review (before design)

### What standard is missing or needs upgrading?

A **Goal-Anchored Autonomy** standard: any session doing multi-hour autonomous work
in a topic must be periodically re-grounded against the operator's actual stated
goals in that topic — from durable, sender-verified message history, not from the
session's own summary of itself (a drifted session summarizing its own goals
re-inhales its drift). The anchor is the operator's words; the session's state file
is the *subject* being checked, never the source of truth for the check.

### What development-process gap allowed the class?

Autonomous-run machinery (stop-hook re-feed, completion judge, progress heartbeat)
all evaluate the run against the run's OWN goal statement, captured once at setup.
Nothing compares that goal statement — or the evolving queue derived from it —
against the operator's messages as they accumulate. The gap: setup-time intent was
treated as immutable ground truth for the entire run lifetime.

## Goals

1. At session start for a topic with an active autonomous run, and on a cadence
   during the run (default 60 min), produce a **goal digest**: a compact, bounded
   summary derived exclusively from the operator's sender-verified messages in that
   topic.

   **A goal persists until it is superseded, not until it is old.** A recency window
   alone is disqualifying: on 2026-07-27 the operative directives in this very topic
   were 2–4 days old, and a 7-day window would have begun dropping them precisely as
   they became load-bearing. The digest set is therefore the UNION of (a) a recency
   window (default 7 days), (b) the run's creation context, and (c) every operator
   priority not yet marked addressed or explicitly superseded by a later operator
   message — regardless of age. The injected brief states its own coverage dates, so
   a reader can see what the digest could and could not have seen.

2. Compare the run's current focus (state-file goal + recent task additions) against
   the digest with one LLM pass, yielding `aligned` | `drifting` | `diverged` plus a
   one-paragraph reason naming the specific unaddressed operator priority.

   **The digest is an evidence bundle before it is a summary.** The deterministic
   layer assembles message ids, timestamps, and verbatim quotes; the LLM pass may
   only summarize over that preserved set, never replace it. The reviewer receives
   both, so a compressed nuance is recoverable rather than silently lost — the
   summary is a convenience layer over evidence, never the authority itself.
3. Inject the digest + verdict into the working session as a signal-only
   re-alignment brief (session-start hook context at boot; a nudge line into the
   session at cadence ticks). Never block, never rewrite, never halt work.
4. Record every verdict durably so drift-over-time is auditable per topic.
5. Bounded cost: ride the LlmQueue, register in the per-feature metrics surface,
   route off-Claude by the provider-fallback default policy.

## Non-goals

- Not a gate. A `diverged` verdict changes what the agent SEES, never what it CAN
  do. The agent (and ultimately the operator) decides whether to re-steer.
- Not a replacement for the completion judge or scope-accretion discipline — those
  hold the exit bar; this holds the *direction* during the run.
- Not cross-topic. Each topic's digest is built from that topic's history only
  (parallel-work awareness already covers cross-topic overlap).
- Not retroactive interpretation authority: the digest QUOTES operator priorities
  with message timestamps; it never asserts new obligations the operator didn't
  state.

## Alternatives considered

Periodic LLM review is not obviously the right primary mechanism, and the cross-model
review was right to ask. Three alternatives, and why this design lands where it does:

**A durable goal ledger updated at operator-message intake.** Each verified operator
message appends/updates a structured goal row at the moment it arrives; drift becomes a
deterministic query (open rows with no linked work) rather than a periodic judgement.
Strictly better where goals are cleanly extractable — no cadence, no LLM in the steady
state, no window to tune. Rejected as the *whole* answer because extraction at intake is
itself a judgement call ("continue to lean on Codey" is a priority; "checking in here" is
not), so it relocates the LLM rather than removing it. **Adopted in part:** the digest is
cached and updated on intake rather than rebuilt per tick, which is the ledger's cheap half.

**Provenance links on queue items.** Every task carries a link back to the operator
priority it serves; anything unlinked is drift by construction. This is the strongest
version and it composes with — rather than replaces — this spec. Deferred deliberately:
it requires touching the task-creation path everywhere, which is a larger change than
the compass check, and the compass check is what the operator has now asked for four
times. Recorded here so it is a known better end-state, not an unconsidered one.
<!-- tracked: ACT-1387 -->

**This spec is built forward-compatible with it rather than merely deferring to it.**
The PriorityLedger's stable per-priority id IS the provenance anchor, and queue/plan
updates following a brief already carry `servesPriorityId` / `rejectsPriorityId`. So the
full pattern — event-sourced operator intent plus work-item provenance — is reachable by
adding links at the task-creation path, with no re-modelling of what a priority is. The
second cross-model round argued this deferral was premature; the schema commitment is the
answer, and it means the ledger is the shared substrate rather than a throwaway.

**Do nothing; rely on the operator to re-ground.** This is the status quo, and it is
what has actually been happening: the operator has manually re-grounded this topic on
2026-07-23, 2026-07-26 and 2026-07-27. His stated position — "I'm going to continue to
ask you to do this periodically until the infra is robust enough that I DON'T HAVE TO" —
makes the status quo the thing being replaced, not a candidate.

## Phasing (this is not one run)

Convergence grew this spec from a compass check into intake, a durable outbox, an
event-sourced ledger, materialized views, injection hooks, queue annotations, metrics,
health alerts and sampled audits. Round 7 was right that `single-run-completable: true` was
no longer honest. It ships in three phases, each independently useful and independently
shippable — and each small enough to be one bounded work unit.

**Phase 1 — see it (no behaviour change).** PriorityLedger with the checkpointed intake
outbox, the candidate-priority inbox, and the AlignmentReviewer running in `dryRun`.
Verdicts computed and logged; nothing injected anywhere. Deliverable: the log plus
`GET /goal-realignment` showing the ledger and recent verdicts. This alone answers "is the
compass right?" before it is allowed to speak, and its soak produces the false-`diverged`
rate that tunes everything downstream.

**Phase 2 — say it.** RealignmentInjector: session-start brief and the cadence nudge, the
idle-boundary rule, the sustained-drift attention item. Graduation from Phase 1 is gated on
a measured false-`diverged` rate, not on elapsed time.

**Phase 3 — check it.** The deterministic canary, missed-extraction audit, model-diverse
sampled audit, the unacknowledged-brief escalation, and the `servesPriorityId` /
`rejectsPriorityId` planner contract. Deliberately last: these audit a mechanism that must
first exist and be trusted enough to be worth auditing.

A phase may not begin before its predecessor has soaked. The whole point of this spec is
that unreviewed momentum produces drift; shipping all three at once would be that failure
wearing this spec's clothes.

## Design

### Components

**PriorityLedger** (durable, NEVER recency-trimmed). The authority for "what has the
operator asked for", modelled as an **append-only event log plus a materialized priority
view** — the solved pattern for this shape, named here rather than gestured at.

*Keying.* Each priority has a **stable `priorityId` minted once at first extraction**,
plus **source-event lineage** (the ordered list of message ids that stated, restated or
escalated it). A content fingerprint is used ONLY to *suggest* that a new statement
belongs to an existing priority; it never silently merges. A restatement is lineage, not
a duplicate — and an escalation ("this is now MISSION CRITICAL") is a distinct event on
the same priority, so repeated asking is visible instead of collapsing into one row.

*Events.* `priority-stated`, `priority-restated`, `priority-superseded`,
`priority-transitioned`, each carrying the source message id. The view is a fold over the
log. Ordering is by source message timestamp then arrival seq; application is **idempotent
on (event type, source message id, priorityId)**, so a replay after a crash, a duplicate
intake, or a cadence tick racing a message arrival converges to the same view. Ledger
mutation happens only at intake and at explicit transitions — a cadence tick and a resume
injection are pure READS of the materialized view, which removes the intake/tick race
entirely rather than locking around it.

*Crash-safety across the LLM step.* Idempotence on `(event type, source message id,
priorityId)` only helps once events exist; a crash BETWEEN intake, extraction and the
ledger write would let a re-run produce different ids or scopes for the same message. So
intake uses a **checkpointed outbox**: the message-processing cursor, the raw extraction
result, and the `promptId`/model version are persisted under an idempotency key derived
from the source message id BEFORE any event is applied. A replay re-uses the persisted
extraction rather than re-invoking the model, so recovery is deterministic even though
extraction itself is not.

*Extraction is a judgement, and is labelled as one.* Priority creation and supersession
depend on an LLM read at intake; calling the ledger "deterministic" would be the same
false-confidence this spec exists to fight. Each row therefore carries
`extraction: {confidence, model, promptId}` and a `review` field. Low-confidence rows are
included in the digest but marked provisional. A missed extraction is the dangerous case
(invisible drift), so the deterministic canary below is the backstop that does not depend
on extraction quality. Correction is first-class: an operator message can restate, and a
`priority-corrected` event may re-key or re-scope a row with its lineage preserved — the
ledger is append-only, so a correction is added, never overwritten.

Each materialized row carries: `priorityId`, lineage, source message id + timestamp,
verbatim quote, lifecycle state, extraction confidence, and evidence links. **Recency never removes a row** — only an explicit supersession or a
confirmed-addressed transition does. This is the correction to a contradiction the first
convergence round introduced: Goals-1 promised age-independent persistence while the
builder was still described as lookback-bounded, which would have re-created the exact
failure the spec exists to prevent.

**GoalDigestBuilder** (deterministic assembly + one LLM summarize pass). Input: the
ledger's OPEN rows plus a recency window of recent operator messages **for reconciliation
and coverage-reporting only — never for inline extraction**, filtered to the topic's VERIFIED operator (Know Your Principal —
sender-authenticated uid match, never content names). Output: a digest over the preserved
evidence set.

**The builder never mutates the ledger.** Round 4 flagged that "recent operator messages
for new-priority extraction" implied a second write path. It is not one: extraction happens
exclusively at intake. If the builder observes a message with no corresponding ledger row
(a crash between intake and extraction), it does not extract inline — it emits a
reconciliation request through the SAME idempotent intake path and builds this tick's
digest without it. One write path, one extraction semantics. **Clamping applies to the PROMPT PROJECTION only, never to the ledger**: if
open priorities exceed the projection budget, the brief says so explicitly
(`truncated: {omitted: N}`) and prefers oldest-unaddressed first, so an overflow is a
reported condition rather than a silent drop. Cached per topic. The **LLM summary** reruns only when the ledger changed (zero LLM spend
on quiet topics), but the **cache key includes the topic's message + classification
cursor**, not just ledger state — otherwise messages classified `no-priority` advance the
conversation without advancing the ledger, and the brief would report stale coverage dates
while claiming freshness. Coverage metadata refreshes whenever the cursor moves; only the
expensive summarize step is gated on ledger change.

**AlignmentReviewer** (one LLM pass per tick). Input: the digest + the run's state file
frontmatter goal + the tail of its task list (bounded) + **active queue item ids with any
`servesPriorityId` links, artifacts produced this run (merged PRs / commits), and any
unacknowledged prior briefs**. The tail alone is too narrow: drift lives in older queued
work and, most often, in *repeated non-response to the same priority* — which is invisible
unless the reviewer can see that a priority has gone unreferenced across several ticks. Output:
`{verdict: aligned|drifting|diverged, reason, unaddressed: [..]}`. Fails toward
silence: provider error, empty digest, or no active run ⇒ no injection, counter
incremented, never a fabricated verdict.

**RealignmentInjector** (existing surfaces, no new channels). Session-start: rides
the same hook-context path as preferences/self-knowledge, wrapped in an
`<auto-goal-realignment>` envelope marked advisory. Cadence tick: one bounded
plain-text nudge line into the session (the AutonomousProgressHeartbeat delivery
pattern), rate-limited to one per cadence period, suppressed while the session is
mid-turn (inject at the next idle boundary, per the send-keys interruption lesson).

### Authority & safety

- Signal-only end to end. Every failure path fails toward silence, never toward a
  blocked or rewritten message, never toward a halted run.
- Digest sources are quoted untrusted-adjacent data: operator messages are
  authoritative for PRIORITIES, but the digest text injected into context carries
  its provenance envelope so a poisoned/mistaken summary is inspectable.
- The verdict LLM call is a non-gating internal call (category: reflector): it rides
  the provider-fallback default (off-Claude), the non-gating failure-swap, the
  spawn-cap funnel, and per-feature metrics under feature key `goal-realignment`.
- No new notification surface: a `diverged` verdict that persists N consecutive
  ticks (default 3) raises ONE deduped attention item per episode — the operator
  hears about sustained drift exactly once, on the existing queue.


### Priority lifecycle (resolves what "addressed" means)

The persistence rule is only as good as the definition of when a priority stops being
open, so this is specified here rather than left to convergence.

| State | Meaning | Who may transition into it | Required evidence |
|---|---|---|---|
| `open` | Stated by the verified operator, not yet resolved | Extraction at intake | source message id + quote |
| `superseded` | A later operator message replaces it | Extraction at intake | BOTH message ids recorded |
| `addressed_pending_operator` | The agent believes it is done | Agent | a linked artifact: merged PR, commit SHA, or route//artifact ref |
| `addressed_confirmed` | The operator agreed, OR the priority is *mechanically checkable* and its completion predicate holds | Operator message, OR a deterministic predicate check | the operator's acknowledgement, or the named predicate evaluating true |
| `needs-operator-confirmation` | Derivable only from quoted/pasted content, or extracted below the confidence floor | Extraction at intake | source message id + the quoted region |
| `possibly_superseded` | A later message *may* replace it, but the two only partially conflict | Extraction at intake | BOTH message ids + the conflict |

**An ambiguous acknowledgement is not a confirmation.** Real operator confirmations are
frequently "ok", "sounds good", "ship it" — or silence after a PR link, which is not
evidence at all. Reaching `addressed_confirmed` therefore requires the confirmation to cite
the exact operator message id and clear a confidence floor; anything below it, and silence
always, routes to `addressed_pending_operator`. The asymmetry is deliberate: wrongly
confirming deletes a live priority, wrongly leaving it pending merely keeps a resolved item
visible one cycle longer.

`needs-operator-confirmation` **appears in the digest, clearly marked as unconfirmed**, and
never blocks injection — it is a question surfaced to the agent, not a directive. It leaves
only via an operator message (→ `open`) or supersession.

`possibly_superseded` exists because operator goals evolve without cleanly replacing each
other: "lean on Codey" and "move the majority of work to Codey" are an escalation, not a
replacement, while a genuine reversal is rare. A mistaken supersession silently deletes a
live priority, which is the worst failure this ledger can have — so **both priorities stay
visible** until either extraction confidence is high or the operator confirms. Ambiguity
resolves toward keeping too much, never toward dropping.

**The agent cannot self-close a priority.** `addressed_pending_operator` still appears in
the digest — dimmed, not removed — because self-assessed completion is precisely the
failure class this spec exists to catch. `addressed_confirmed` is the only state that
leaves the digest.

**A merged PR is not a satisfied priority.** Round 4 of convergence caught this: an
artifact proves work *happened*, not that the operator's intent was *met*. Treating
artifact-presence as closure would hand the agent exactly the self-close it must not have —
link a PR, the PR objectively exists, the priority silently leaves the digest. So the
deterministic path is available ONLY to a priority whose **completion predicate is drawn
from an allowlisted checker catalog** (e.g. `route-returns-200`, `config-flag-enabled`,
`pr-merged-touching-path`) or from an operator-confirmed structured form. A
model-authored free-form predicate is NOT accepted: letting extraction invent the
completion test would re-create self-closure through a side door — the model narrows
"make recall actually work" into "route returns 200", satisfies the narrow version, and
the real priority leaves the digest. Unrecognised or absent predicate ⇒
`addressed_pending_operator`, always. Anything semantic ("keep leaning on Codey", "stay grounded")
has no predicate, and for those a merged PR moves the row to `addressed_pending_operator`
and no further. Most real priorities are semantic; the deterministic path is the narrow
exception, not the norm.

### Operator-authored vs quoted content (prompt-injection boundary)

A verified operator message is authoritative about *the operator's priorities*. It is NOT
automatically trustworthy *content* — operators paste logs, error text, third-party
messages and web excerpts. Treating every verified byte as priority evidence would let
adversarial pasted text promote itself into an injected brief, and a provenance envelope
makes that inspectable without making it safe.

So: the extractor distinguishes operator-authored prose from quoted/pasted regions (fenced
blocks, quote markers, pasted-artifact envelopes, forwarded content) and derives priorities
ONLY from the authored portion. Quoted regions are retained in the evidence bundle as
context, never as a source of directives. What gets injected is the **normalized priority
record** (a short structured statement plus its source id), not a verbatim snippet —
verbatim quotes stay in the ledger for audit, reachable but not injected. A priority that
can only be derived from a quoted region is recorded as `needs-operator-confirmation`
rather than treated as stated.

### Failure visibility (the silence must not hide a dead compass)

"Fails toward silence" is correct for not blocking work and wrong as the whole story: a
feature whose only job is to notice drift, and which has silently stopped noticing, is
indistinguishable from one reporting no drift. Both look like quiet.

So silence is bounded. Consecutive failures of the digest build or the reviewer call
(provider error, empty digest, malformed verdict) increment a durable counter; at
`maxConsecutiveFailures` (default 3) the feature raises ONE health signal on the existing
attention surface, **distinct in kind from a drift verdict** — "the compass is not
reporting" is a different sentence from "you have drifted", and conflating them would let
an outage read as alignment. The counter resets on the first successful verdict. This is
*No Silent Degradation to Brittle Fallback* applied to the checker itself.

### False alignment (the compass that always says north)

Failure visibility above covers the compass being *broken*. It does not cover the compass
being *wrong in the reassuring direction* — a steady stream of `aligned` verdicts is
indistinguishable from genuine alignment, and it is the cheapest verdict for a model to
produce. Silence and "all fine" fail identically: nothing happens.

Two backstops, one of which does not involve an LLM at all:

- **Candidate-priority inbox (deterministic, always on).** Sampling catches missed
  extraction *eventually*; this makes it visible *immediately*. Every operator message
  matching broad linguistic signals (imperative mood, "I need", "from now on", "make sure",
  "critical", a question about status) lands in a candidate inbox and STAYS there, visible
  in observability, until intake has explicitly classified it as a priority or as
  not-a-priority. A non-empty aging inbox is itself the alarm. It is a cheap string-level
  check with no model in the loop, which is the point: the deterministic layer must be able
  to see what the judgement layer missed.
- **Missed-extraction audit.** The canary below can only fire for a priority that EXISTS;
  a message classified "not a priority" at intake is otherwise invisible forever. So
  `no-priority` decisions are persisted too, with their source message ids and confidence.
  A sample is re-checked by a different model, and a deterministic heuristic flags
  candidates the classifier passed over: imperative mood, a repeated ask matching an
  earlier message's shape, or priority phrasing ("mission critical", "I need you to",
  "from now on"). This is the one blind spot the canary structurally cannot cover, so it
  gets its own check rather than an assumption.
- **Deterministic canary (primary).** An `open` priority that no queue item, commit or
  artifact has referenced for `unreferencedTicks` (default 5) is surfaced regardless of
  what the reviewer said. This cannot be talked out of firing by a model, and it also
  covers the missed-extraction case only insofar as the priority WAS extracted — which is
  why it is a backstop rather than the whole answer.
- **Sampled audit, deliberately model-diverse.** A small random fraction of `aligned`
  verdicts (default 5%) is re-reviewed against the same evidence **by a different model
  family and a different prompt**. Re-reviewing with the same model and prompt measures
  variance, not correctness — a shared bias agrees with itself. Disagreement rate is
  recorded; a rising rate is the signal that the reviewer is rubber-stamping. Audit results
  are stored separately from cadence verdicts so they never contaminate the drift record
  they are auditing.

The reviewer also emits `confidence` alongside its verdict, and a low-confidence `aligned`
is treated as `unknown` for canary purposes rather than as reassurance.

### Cost and alert budget (four checks must not become four alarms)

Failure counters, the candidate inbox, the deterministic canary, the missed-extraction
audit and the sampled cross-model audit are individually cheap and collectively capable of
producing more noise than the drift they watch for — which would make this feature an
instance of the notification-volume problem it was written to help with.

So: all of them raise through ONE health channel, deduped per episode, at most one item per
topic per `healthAlertCooldown` (default 6h). The canary and inbox are string/DB-level and
cost nothing per tick. The only metered spend is the 5% sampled audit and the missed-
extraction sample, both bounded by the existing per-feature LLM budget under feature key
`goal-realignment` and visible in `/metrics/features` — if the checks cost more than they
catch, that is measurable rather than assumed. Alert quality is itself reviewed at the
dryRun soak: an alert class firing with a low action rate gets thinned before graduation,
not after.

### Log hygiene

`logs/goal-realignment.jsonl` records verdicts and reasons, and a reason names operator
priorities — so the log is an intent record, not a metrics file. It is machine-local,
never replicated and never attached to a feedback report; free text passes the existing
durable secret scrub; entries carry source message IDs and timestamps in preference to
re-quoting message bodies, so the evidence is reconstructable from the message store
rather than duplicated into a second store with a second retention story. Retention is
declared with the store (per the retention lint) rather than unbounded.

### Where the verdict goes (operator directive, 2026-07-27)

The audience for a drift verdict is **the agent, not the operator** — verbatim: *"the
focus should always be BACK TO YOU, not me."* A verdict is injected into the working
session and recorded. The operator hears about it only when drift is *sustained*
(`diverged` on `escalateAfterConsecutive` ticks, default 3), as ONE deduped attention
item per episode. A compass that pings the operator every hour is the notification noise
this whole topic is trying to remove.

### Rollout ladder

Ships dark on the fleet (`monitoring.goalRealignment.enabled` omitted ⇒
resolveDevAgentGate), dryRun-first even on dev (`dryRun: true`: verdicts computed +
logged to `logs/goal-realignment.jsonl`, nothing injected). Graduation to live
injection on the dev agent after a measured soak (false-`diverged` rate reviewed
from the log); fleet flip is a separate deliberate step. Off-switch read live.

### Observability

- `GET /goal-realignment` → per-topic last digest age, last verdict, tick counters,
  suppression counters, breaker state (503 when dark).
- `logs/goal-realignment.jsonl` → one row per tick: topic, verdict, reason,
  digest-message-count, injected|suppressed|dry-run.
- Per-feature LLM metrics row (`goal-realignment`) for cost accountability
  (Token-Audit Completeness).

## Maturation plan

Each rung is entered only on evidence, never on elapsed time alone. The rungs map onto the
three phases: Phase 1 is what soaks here, Phases 2 and 3 each re-enter this ladder.

- **test-agent-live:** Phase 1 on a throwaway agent against a seeded topic with known
  planted drift — the reviewer must catch drift it was not told about, and must NOT flag a
  deliberately-deferred item as drift. Both directions, because a checker that flags
  everything is as useless as one that flags nothing.
- **dev-agent-live:** Phase 1 in `dryRun` on this maintainer agent, against the real topic
  history that produced this spec. Verdicts computed and logged; nothing injected anywhere.
  The 2026-07-23 / 07-26 / 07-27 re-groundings are the natural regression set: a correct
  reviewer would have said `diverged` before each of them.
- **graduation criterion:** measured false-`diverged` rate below 20% across at least 50
  verdicts spanning at least 3 distinct topics, AND the candidate-priority inbox draining
  (no operator message sitting unclassified beyond one cadence), AND zero credential-shaped
  strings reaching the log. A rate, not a duration — a quiet week proves nothing.
- **dark-window:** minimum 7 days in `dryRun` on the dev agent before injection is enabled,
  and injection soaks a further 7 days before Phase 3's audits are armed. The window is a
  floor beneath the graduation criterion, not an alternative to it.
- **fleet:** deliberate operator flip, per-agent, after dev-agent injection has run without
  a false-`diverged` complaint for a full dark-window. Fleet default remains off; this spec
  does not propose a fleet-wide enable.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| **Alignment verdict** (`aligned` / `drifting` / `diverged`) | judgment-candidate | Genuinely competing signals — a static rule cannot tell "deliberately deferred" from "drifted". Bounded action space: three verdicts plus `confidence`. Conservative default: a low-confidence `aligned` is treated as `unknown`, never as reassurance. Fallback ladder ends deterministically at the canary + candidate inbox, which need no model. Arbiter: AlignmentReviewer; authority: none (signal-only). |
| **Is this operator message a priority?** (extraction) | judgment-candidate | The load-bearing judgement, and the one whose miss is invisible. Conservative default is KEEP: anything matching broad linguistic signals enters the candidate inbox and stays visible until explicitly classified, so a miss is an aging queue rather than silence. Deterministic rung: the inbox itself (string-level, no model). |
| **Does message B supersede priority A?** | judgment-candidate | Partial conflicts are the norm (escalation vs replacement). Conservative default: `possibly_superseded` with BOTH kept visible. Ambiguity resolves toward retaining, never dropping — a wrong supersession silently deletes a live priority. |
| **Has a priority been addressed?** | judgment-candidate | Deterministic rung available only via an allowlisted completion-predicate catalog; everything else, and every ambiguous acknowledgement, falls to `addressed_pending_operator`. The agent can never reach `addressed_confirmed` alone. |
| **Inject now, or defer to idle?** | invariant | Deterministic mid-turn detection; no judgement. Deferring is always safe. |
| **Fire a health signal / canary** | invariant | Counters and thresholds only (`maxConsecutiveFailures`, `unreferencedTicks`). Deliberately model-free so it still fires when the judgement layer is exactly what has failed. |
| **Whether to act on a verdict** | judgment-candidate | The arbiter is the AGENT, and this feature holds no authority over it — that is the floor, not an absence of one. Bounded action space: act, explicitly reject with a reason, or defer. Conservative default: the agent's existing plan stands unless it chooses otherwise. Fallback ladder terminates deterministically at "the feature does nothing" — a verdict never gates, blocks, refuses or rewrites, and the strongest escalation available is louder placement in a continuation prompt. |

## Multi-machine posture

Default is `unified`; both surfaces here are declared unified, and neither claims
machine-local.

**PriorityLedger — `unified` (replicated).** Replication path: the existing WS2
memory-family replicated-store foundation (`multiMachine.stateSync.*`), same machinery as
learnings — content-fingerprint identity (`priorityId` + source lineage) rather than a
local row id, type-clamped fields on receive, tombstones on supersession so a superseded
priority stays superseded on a machine that was offline. This is not optional: a topic can
MOVE between machines, and a machine-local ledger would mean a moved topic silently loses
the operator's goals — recreating precisely the drift this spec exists to prevent, and at
the worst possible moment. A replicated priority from a peer is advisory evidence rendered
in the untrusted-data envelope; it never establishes an operator, per Know Your Principal.

**Verdict log + counters — `proxied-on-read`.** Each machine writes its own verdicts
(they describe what THAT machine's session saw, so they are genuinely per-machine facts),
and `GET /goal-realignment?scope=pool` merges across machines, tagging each row with its
machine and tolerating a dark peer as a classified `pool.failed` entry rather than a
silent omission. Reading only the local half would make "has this priority been
unreferenced for N ticks?" answerable wrongly on a multi-machine setup — the canary needs
the pool view, since the work may have happened on the other machine.

**Generated URLs / notices.** No new notification surface and no generated links. The
sustained-drift attention item rides the existing attention queue, which already carries
its own pool semantics.

## Acceptance matrix (minimum)

| Scenario | Expected |
|---|---|
| Active run, new operator msgs, drifted queue | `drifting`/`diverged` verdict logged; dryRun ⇒ no injection; live ⇒ brief injected at idle boundary |
| Active run, no new operator msgs since last digest | Zero LLM spend for digest; reviewer may still run on cadence against cached digest |
| No active autonomous run in topic | No-op, counter only |
| Provider down / empty digest | Silence + counter; never a fabricated verdict |
| 3 consecutive `diverged` | Exactly ONE attention item per episode (deduped) |
| Session mid-turn at tick | Injection deferred to idle boundary, never mid-work |
| Feature dark / single verdict surface off | Routes 503; session-start hook injects nothing |
| Operator message from unverified sender | Excluded from digest (verified-operator filter) |
| **A `diverged` brief is injected and the run continues** | **The next queue/plan update carries `servesPriorityId` or `rejectsPriorityId` for the named priority. This is a MONITORED INVARIANT, not a gate: nothing blocks if it is absent — instead the unacknowledged-brief counter increments, and repeated non-acknowledgement raises the same health signal as a dead compass. A signal that changes nothing is indistinguishable from no signal, so it is measured; it is never enforced by refusal.** |
| A brief is outstanding when a queue/plan update is written | The update carries `servesPriorityId` or `rejectsPriorityId` as STRUCTURED fields. Omission is machine-detectable and recorded — the interface makes ignoring a brief explicit rather than invisible. Still non-gating: nothing refuses the write. |
| Brief unacknowledged for `escalateUnacknowledgedAfter` ticks (default 3) | The next autonomous continuation prompt carries an explicit "address or reject priority `<id>`" instruction. Still no halt, still no refusal — the escalation is *louder placement*, not enforcement. Repeatedly ignoring briefs while counters accumulate is the predicted failure mode, so it gets a response short of a gate. |
| Ledger open-priorities exceed the projection budget | Brief reports `truncated: {omitted: N}`, oldest-unaddressed retained first; ledger itself never trimmed |
| Priority derivable only from a quoted/pasted region | Recorded `needs-operator-confirmation`, never injected as a stated priority |
| Agent marks a priority done | Reaches `addressed_pending_operator` only, with a linked artifact; still appears (dimmed) in the digest |
| Standing goal older than the recency window, not yet addressed | Present in the digest (persists until superseded, not until old) |
| Operator priority explicitly superseded by a later operator message | Absent from the digest; supersession recorded with both message IDs |
| Injected brief | States its own coverage dates, so a reader can see what it could not have seen |
| Digest built | Evidence bundle (ids + timestamps + verbatim quotes) retained alongside the summary; reviewer receives both |
| 3 consecutive digest/reviewer FAILURES | ONE health signal, distinct in kind from a drift verdict; counter resets on first success |
| Verdict reason contains a credential-shaped string | Scrubbed before the log write (durable secret scrub) |


## Glossary (for readers outside this codebase)

- **topic** — a conversation thread with the operator (a Telegram forum topic); the unit
  this feature scopes to.
- **sender-verified / verified operator** — the message's sender was authenticated by the
  platform to a known uid, as opposed to a name appearing in message text. Only
  sender-verified messages may establish a priority.
- **state file** — the durable per-run markdown file holding an autonomous run's goal and
  task list; the *subject* being checked, never the source of truth for the check.
- **attention surface** — the existing operator-facing queue for items needing a human;
  this spec adds no new notification channel.
- **resolveDevAgentGate** — the standard rollout gate: a feature with its flag omitted is
  live on the maintainer's development agent and dark for every deployed agent.
- **dryRun** — verdicts are computed and logged but nothing is injected; the first rung of
  the rollout ladder.

## Frontloaded Decisions

Every open question is decided here rather than left to interrupt the build. All six are
cheap-to-change-after on the same basis: the feature ships behind a dark flag in `dryRun`,
each decision below is a config default or internal behaviour, and none touches durable
external side-effects, money, identity, or a published interface. Phase 1 exists to replace
these guesses with measurements.

1. **Cadence: 60 minutes.** A guess, and named as one. It is a config default
   (`goalRealignment.cadenceMinutes`) read live, and Phase 1's soak produces the
   false-`diverged` rate that retunes it. Reversible by editing a number.

2. **What "addressed" means: decided in round 2** — the four-state lifecycle, with
   `addressed_confirmed` reachable only by operator acknowledgement or an allowlisted
   completion predicate. Not deferred; see *Priority lifecycle*.

3. **The reviewer sees prior verdicts — as evidence, not as prior probability.** Seeing
   "this is the fourth consecutive `drifting` on the same priority" is exactly the signal
   that matters, and withholding it to avoid anchoring would blind the reviewer to
   repetition, which is the strongest drift indicator available. The anchoring risk is real
   and is *measured* rather than assumed: verdict flip-rate is tracked during the soak, and
   a collapse in flip-rate is the anchoring signature. If it collapses, prior verdicts are
   withheld and the reviewer keeps only the unreferenced-tick count.

4. **A cadence tick always re-reads live state; only the digest summarize step is cached.**
   Drift frequently grows queue-side with no new operator message, so a tick that skipped
   the state read would miss the most common case entirely. The expensive half (the LLM
   summarize) stays gated on ledger change; the cheap half always runs.

5. **CONTINUATION resumes inject age-gated, not every resume.** A resume is not evidence of
   drift, and a compaction-heavy hour would otherwise produce a brief per resume — the
   notification-volume failure this feature must not commit. Inject only if the last
   injection is older than the cadence.

6. **`diverged` does NOT annotate the run's state file in Phases 1–2.** It is the stronger
   loop-closure and it writes to a file the session owns, which needs a single-writer story
   this spec does not have. Deferred to Phase 3, where the planner contract
   (`servesPriorityId` / `rejectsPriorityId`) provides the write path with defined
   ownership. Recorded as a decision, not an open question: the answer for now is "no".
   <!-- tracked: ACT-1389 -->

## Open questions for convergence

*(none)*

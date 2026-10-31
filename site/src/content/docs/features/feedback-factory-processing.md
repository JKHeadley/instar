---
title: Feedback-Factory Processing
description: Wires the feedback-factory clustering/triage pass into a scheduled job plus a read-only stats route, so ingested reports are actually sorted — not just caught.
---

The feedback factory **catches** reports into a canonical store and is supposed to **sort**
them — figure out which reports are really the same problem and track each problem's life
story. The catching side runs continuously (the inbox drainer), but the sorting pass
(`processUnprocessed`) was only ever invoked by tests: it was built and parity-tested, but
nothing ran it in production. Reports piled up `unprocessed` and were never clustered.

Feedback-Factory Processing closes that gap. It is **additive, dark-shipped, and dev-gated**:
it runs live on a development agent (the dogfooding ground) and stays dark on the fleet until
deliberately enabled.

## What it adds

- **`GET /feedback-factory/stats`** — a read-only view of the canonical store: total feedback,
  counts by status, cluster count, dispatch count, and the last-write timestamp. Returns `503`
  when the feature is dark.
- **`POST /feedback-factory/process`** — runs one clustering/triage pass against the canonical
  store and returns the result. Read-fresh-from-disk first, so it always sees rows other
  processes appended since boot. Returns `503` when dark.
- **The `feedback-factory-process` job** — a built-in `supervision: tier1` job on a recurring
  schedule that calls the process trigger and validates the pass against the post-pass stats.
  It ships `enabled: false` (fleet-dark) and is installed for every agent on update.
- **The `feedback-factory-triage` job** — every 15 minutes it triggers one
  `POST /feedback-factory/triage/tick`: the operator-approved triage authority decides
  work / hold / ignore for feedback work items within deterministic floors. Inert until
  the operator approves that authority; development-agent live, fleet dark.
- **The `feedback-factory-action-list` job** — once a day it triggers
  `POST /feedback-factory/triage/action-list`, which sends the operator only new items
  that need them, each with a direct link, outside the 23:00–07:30 quiet window.

## Operating drain and readiness API

The operated drain extends processing into durable development work. These authenticated
routes expose the bounded operator and agent surfaces:

- **`GET /feedback-inbox/status`** — reports whether intake is available and making progress.
- **`GET /feedback-factory/drain/status`** — returns drain posture, backlog stages, progress
  ages, owner state, and consumer mode without exposing raw report bodies.
- **`POST /feedback-factory/drain/tick`** — asks the canonical owner to run one bounded drain
  tick; non-owners use the authenticated, replay-protected owner proxy.
- **`POST /feedback-factory/drain/runs/:runId/cancel`** — records a fenced cancellation that
  takes effect at the next safe stage boundary.
- **`GET /feedback-factory/backlog/analysis`** — returns metadata-only age and stage analysis.
- **`POST /feedback-factory/drain/failover/finalize`** — completes an operator-authorized,
  checksum-bound restore only after quiescence or explicit split-brain recovery evidence.
- **`POST /feedback-factory/readiness-authorities`** — creates or changes the bounded registry
  of agents allowed to make readiness decisions; this is an operator-rooted action.
- **`POST /feedback-factory/readiness/hold`** and **`POST /feedback-factory/readiness/release`** —
  apply or clear integrity holds under their deterministic and operator authority rules.
- **`POST /feedback-factory/consumer/promote`** and **`POST /feedback-factory/consumer/revoke`** —
  switch a proposal-set-bound consumer batch between simulation and live handoff.

Development agents construct the drain by default while fleet agents remain dark. Work
creation starts in simulation. Readiness decisions come from a registered frontier-model
Instar agent under deterministic safety floors; human approval is reserved for escalation
and break-glass cases. Every accepted work item has a stable key, so retries, crashes, and
concurrent ticks converge on one Initiative link.

## Which component owns each stage

These components have distinct responsibilities when tracing a report from intake to a
reviewed fix. The names below are useful when a stage is stalled: the upstream stage can
be healthy while the next stage is paused or at capacity.

| Component | Responsibility |
|---|---|
| `InboxDrainer` | Brings durable incoming reports into the canonical local store, deduplicating by feedback ID. |
| `FeedbackProcessingService` | Reloads that store and runs a bounded clustering pass. |
| `FeedbackDrainService` | Advances operated readiness work through bounded owner-run ticks. |
| `FeedbackReadinessArbiter` | Gets the registered model's readiness decision within the approved floors. |
| `FeedbackDrainStore` | Persists work, owner fences, authority and call accounting across restarts. |
| `FeedbackDrainTickProxy` | Forwards a non-owner's tick request to the canonical owner. |
| `FeedbackInitiativeConsumer` | Hands accepted work to its linked Initiative. |
| `FeedbackConsumerPromotionStore` | Records which consumer proposal set may hand off live work. |
| `FeedbackDrainBackupCadence` | Schedules and records backups for the operated drain. |
| `FeedbackTriageStore` | Holds triage decisions separately from report and cluster state. |
| `FeedbackTriageArbiter` | Calls the registered model and checks the response contract. |
| `FeedbackTriageService` | Runs the triage tick, applies decisions and quota pauses. |
| `FeedbackExecutorService` | Starts bounded confined fix attempts and reconciles open PRs through review and merge. |

Triage account selection must bind a verified subscription and a fresh quota reading to
the model call before `FeedbackTriageArbiter` can return a disposition. A paused sorter
does not imply that intake or clustering stopped; check each stage's status separately.

## Capacity and queue diagnostics

The feedback pipeline also depends on shared account, model, and queue services. These
names identify the code responsible for each observation when a stage stops advancing:

| Component | What to inspect |
|---|---|
| `SubscriptionPoolAuthority` | Whether a subscription pool record is valid and can be trusted. |
| `SubscriptionLoginLedger` | The durable record of login and refresh outcomes. |
| `SubscriptionReloginStore` | State held while a subscription login needs repair. |
| `SubscriptionReloginService` | The supervised repair path for a subscription login. |
| `IntelligenceRouter` | Which provider a component's model call actually uses. |
| `SpawnCapIntelligenceProvider` | The per-call host capacity bound before a model process starts. |
| `QueuePace` | The measured arrival and completion rates, and the resulting pace verdict. |
| `QueuePaceAdapters` | How each queue's raw events become bounded pace observations. |
| `QueuePaceLedger` | Durable cursors and evaluations for those observations. |
| `QueuePaceTuner` | Optional extra triage ticks, subject to fresh quota and owner checks. |
| `AutonomousThroughputFloor` | Whether autonomous work produced actual deliverables during its window. |
| `CiFailurePoller` | CI failures that keep a fix PR from being accepted. |
| `GreenPrAutoMerger` | The normal green-PR merge path; executor PRs have their own review path. |

A healthy intake count only proves reports arrived. For an end-to-end pace claim, inspect
the triage decisions, reviewed fixes merged, and their rate against new high-priority work.

## How it is gated

Resolution goes through the standard development-agent gate
(`resolveDevAgentGate(config.feedbackFactory?.processing?.enabled, config)`): the config
default **omits** `enabled` so the gate decides — live on a `developmentAgent`, dark on the
fleet. An explicit `enabled` in config always wins (force-dark `false`, fleet-flip `true`).

## Safety posture

The processor is a **signal producer**: its similarity logic emits grouping signals and it
never force-closes a cluster — terminal lifecycle transitions stay evidence-gated. Its only
side effect is local JSONL appends (no network egress, no external API, no messages). Every
pass is forward-only and idempotent (an item already flipped to `processing` is never
re-picked), so the `feedback-factory-process` job is safe to re-run.

## Why a reload happens every pass

The processing service is long-lived (constructed once at boot), but the inbox drainer that
ingests new reports is a **separate process**. So the service re-folds the canonical store
from disk at the start of every `stats()` and `processNow()` — otherwise its in-memory view
would freeze at boot and the `feedback-factory-process` job would silently stop clustering
anything ingested after a restart.

Driven by the approved migration spec (`docs/specs/feedback-factory-migration.md`).

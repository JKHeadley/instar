---
title: Feedback Delivery Checks
description: Follow a report from automated sorting to a reviewed fix, and see why a pull request is waiting.
---

Receiving a report is the first step. The feedback factory groups reports, ranks work, and
starts bounded fix attempts. A fix reaches users only after its pull request passes review,
local verification, and GitHub checks, then merges and ships in an update.

## Where to look when delivery stops

| Component | What it does | What a waiting state means |
|---|---|---|
| `TriageOrigin` | Attaches the producing agent and observed session to automated triage messages. | A message can be traced to the decision that produced it. |
| `IntelligenceRouter` | Selects the configured model provider for a feedback decision. | A provider pause can delay decisions without stopping report intake. |
| `SpawnCapIntelligenceProvider` | Bounds model process starts against available host capacity. | A delayed model call can be capacity backpressure rather than a missing report. |
| `CiFailurePoller` | Watches pull-request checks and surfaces failures that need repair. | A red check is a concrete repair task; a queued check is still pending. |
| `GreenPrAutoMerger` | Watches ordinary agent-authored pull requests and invokes the guarded merge path once they qualify. | Feedback executor pull requests use their own independent-review and merge path. |

For live counts and ages, use `GET /feedback-factory/drain/status` and
`GET /feedback-factory/triage/summary`. For a fix attempt, use
`GET /feedback-factory/execute/status` and inspect the linked pull request's exact head.
The guarded merge path checks the full set of GitHub results before it merges; a queued
or missing result keeps the pull request open. The [processing overview](./feedback-factory-processing/)
describes the stages and their controls in more detail.

## Read the pipeline from arrival to delivery

| Stage | Route | What the result proves |
|---|---|---|
| Arrival | `GET /feedback-inbox/status` | Reports reached the inbox and its drainer; it does not prove that a fix was built. |
| Grouping | `GET /feedback-factory/stats` | Reports and clusters are present in the canonical store. |
| Readiness | `GET /feedback-factory/readiness-authorities/proposal` | Shows the proposed decision bounds before an owner registers a readiness authority; reading it grants nothing. |
| Priority | `GET /feedback-factory/triage/queue` | Shows ranked work items, priority scores, and each item's execution state. |
| Triage authority | `GET /feedback-factory/triage/authority/proposal` | Shows proposed triage bounds; reading it does not approve them. |
| Execution | `GET /feedback-factory/execute/status` | Shows whether the executor is available and how many attempts are running, held, or waiting on a pull request. |

The built-in job calls `POST /feedback-factory/execute/tick` to advance eligible work.
Its admission and review gates can leave a high-priority item queued while a worker,
reviewer, or exact-head check is unavailable. Count a delivered fix only after the
linked pull request has merged and its release is live; a triage decision or an open
pull request is progress, but not delivery.

If independent review is waiting on a Claude login, `SubscriptionPoolAuthority`
establishes which account records are trusted, `SubscriptionLoginLedger` records
sign-in outcomes, and `SubscriptionReloginStore` plus `SubscriptionReloginService`
track a repair in progress. `ClaudeCliIntelligenceProvider` makes the actual
reviewer call. A pool record marked active is a selection signal; the reviewer
call itself must succeed before the merge gate can record a pass.

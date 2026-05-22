---
title: Self-Healing Remediator
description: Tier-1 orchestrator that detects, diagnoses, and resolves known failure patterns automatically.
---

The Self-Healing Remediator (v2) is the subsystem that closes detected failure patterns automatically. When the homeostasis monitor or a sentinel raises a degradation, the remediator picks it up, looks for a matching runbook, executes it with verification, and reports the outcome. It's how a long-running agent recovers from known failures without waking up the operator.

Spec: `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md`.

## Components

- **`Remediator`** — the Tier-1 orchestrator. Receives degradation signals, matches them against runbooks, executes the chosen runbook, verifies the result, and emits an outcome.
- **`RemediatorBootstrap`** — handles the cold-start sequence so the remediator is up before any other subsystem starts emitting degradations it would want to handle.
- **`RemediationContext`** — the per-incident envelope that flows through a remediation attempt. Holds the originating signal, the chosen runbook, intermediate state, and the verification results.
- **`IntentJournal`** — a structured ledger of every remediation decision (degradation detected, runbook chosen, why, what happened). The journal is queryable and audit-tracked.
- **`NovelFailureReviewer`** — runs against degradations that don't match any known runbook. Generates a one-line summary plus a candidate runbook draft for human review.
- **`MachineLock`** — coordinates remediations across a multi-machine cluster. Only one machine attempts a given remediation at a time; others wait.
- **`PrimaryAggregatorLease`** — for clustered remediations where one machine acts as aggregator. Time-bounded lease prevents split-brain.
- **`RemediationKeyVault`** — manages credentials remediations need (e.g. restarting a service that requires a secret).
- **`TrustElevationSource`** — the source-of-truth for trust elevation events that some runbooks gate on.

## Runbooks

Each runbook lives under `src/remediation/runbooks/`. A runbook is a structured procedure: detect preconditions, take action, verify outcome, escalate if verification fails. Runbooks declare their own scope (which degradation class they handle), their model tier (most are tier1 Haiku), and any required credentials.

Runbooks marked `__proposalDerivedFrom = '<proposalId>'` track back to an evolution proposal that argued for adding them. The pre-commit gate (per spec §A11/§A22/§A32) verifies the proposal exists, was approved, and the runbook hasn't drifted from what the proposal specified.

## Trust elevation

A remediation that needs to take an action above the running autonomy profile's threshold can declare itself a candidate for trust elevation. The `TrustElevationSource` records the elevation request; the autonomy framework decides whether to grant it; the remediator either proceeds with the elevated authority or escalates to the user.

This is what lets the remediator handle increasingly impactful failure classes safely as it accumulates a track record on the cheaper ones.

## Audit channel

`src/remediation/audit/` holds the structured audit log for every remediation attempt. Entries are append-only, signed, and include enough detail to reconstruct a post-mortem without needing to query other state. Operators can stream the audit log via the dashboard or pull it as JSON via the remediation API.

## How it differs from sentinels

Sentinels detect; the remediator resolves. A sentinel like `CompactionSentinel` or `SessionWatchdog` raises a signal when it sees something wrong. The remediator's job is to do something about it. The two-layer split keeps detection lightweight and remediation focused — and lets a new sentinel be wired in without the remediator needing to know about it (it just consumes the degradation stream).

## Status of v2

The v2 spec is implemented as a skeleton plus the runbook scaffolding. Runbooks land incrementally as the failure classes that warrant them get identified and characterized. The pre-commit gate ensures every runbook ships with its proposal trace and verification evidence.

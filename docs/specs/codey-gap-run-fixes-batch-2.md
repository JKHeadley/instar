---
title: Codey gap-run fixes, batch 2 — script jobs run directly (F005) + disabled-manifest shadowing (F009)
date: 2026-05-31
author: echo
status: in-flight
review-convergence: codey-gap-run-2026-05-31
approved: true
approved-by: Justin
approved-via: Telegram topic 17481 ("Yes, please continue", 2026-05-31, approving the second-wave landing of Codey's verified gap-run fixes)
eli16-overview: codey-gap-run-fixes-batch-2.eli16.md
companion-spec: codey-gap-run-fixes-batch-1.md
---

# Spec — Codey gap-run fixes, batch 2

**Date:** 2026-05-31 · **Author:** echo · **Status:** in-flight

## Context

Two more fixes from Codey's Codex-on-Instar autonomous gap run, ported and re-verified
against current main by Echo (Codey's base was v1.3.78). Batch 1 (#656, F007 + F003) is
already merged. F006 (`retryOnGateSkip` gate-noise flag) is held for a separate batch
because it requires a `PostUpdateMigrator` migration to reach existing agents'
already-installed jobs — Codey's diff did not include one. <!-- tracked: codex-stranded-draft-marker-not-restart-durable -->

## F005 — script jobs were dispatched by spawning a model session

### Symptom

Two `dashboard-link-refresh` script jobs (`expectedDurationMinutes: 1`) ran for ~9h and
~16h holding live session slots, with run-history stuck at `pending`. The scheduler had
spawned a model session with a prompt beginning `Run this script: ...` for what is
zero-token shell work.

### Root cause

`JobScheduler.triggerJob` routed ALL execute types — including `script` — through
`spawnJobSession`, which calls `buildPrompt` (whose `case 'script'` produces
`"Run this script: ${value}"`) and spawns a model session. Script jobs also passed
through the session-capacity gate, so at the cap they could queue and later dequeue
into a model spawn as well.

### Fix

A new `runScriptJob()` executes `execute.type: 'script'` jobs directly in a bounded
subprocess (`/bin/sh -c <script>`, timeout = 2× expected duration, `INSTAR_AUTH_TOKEN`
injected, output captured), mirroring `spawnJobSession`'s run-history / job-state /
claim bookkeeping. `triggerJob` branches to it **before the session-capacity check** —
so a script job never spawns a model, never consumes a session slot, and never queues
on capacity. (This is stronger than the staged fix, which branched after the capacity
check and left the queue/dequeue path spawning a model.) The `buildPrompt` `case
'script'` remains for switch-exhaustiveness but is no longer reached on the normal path.

## F009 — disabled/retired manifests dropped when their body was deleted

### Symptom

`instar status` warned that `guardian-pulse` was missing its markdown body while still
reporting a high-priority `guardian-pulse` job from legacy `jobs.json`. The disabled,
retired per-slug manifest could not shadow the stale legacy entry.

### Root cause

`loadAgentMdJobs` tried to hydrate every surviving manifest's `agentmd` body before
adding it to the in-memory job list. A disabled/retired manifest whose body file was
deleted hit the missing-body path and was dropped — so it could not shadow the stale
legacy job (the per-slug precedence rule), and the zombie legacy job ran.

### Fix

Disabled manifests load as disabled `JobDefinition`s without requiring a markdown body
(the `if (!manifest.enabled)` short-circuit pushes `manifestToJobDefinition(manifest)`
and continues). Enabled `agentmd` jobs keep the stricter hydrated-body path. A disabled
manifest now shadows a stale legacy entry instead of being dropped as a missing-body
problem.

## Safeguards

**No new authority.** F005 changes the dispatch mechanism for an existing job class (a
subprocess instead of a model session); the script command is operator-defined and was
already executed (just via a model prompt before). F009 only stops dropping a disabled
job; a disabled job never runs, it only shadows.

**No regression.** Non-script jobs are dispatched exactly as before (only `script` is
re-routed). Enabled agentmd jobs still require their body. Both covered by tests.

## Out of scope

F006 (`retryOnGateSkip`) is held for a batch with its required `PostUpdateMigrator`
migration so existing agents' installed jobs receive the flag, not just new agents.

## Testing

- `tests/unit/JobScheduler-script-job.test.ts` (new) — a script job triggers WITHOUT
  spawning a session, runs the script directly, records success, and runs even at the
  session cap.
- `tests/unit/scheduler/JobLoader.agentmd.test.ts` — a disabled manifest with no body
  loads as a disabled job and is not a missing-body problem.
- `tsc --noEmit` clean; the full JobScheduler unit suite passes unchanged.

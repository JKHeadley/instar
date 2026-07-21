# Autonomous Throughput Floor

## What Changed

Adds a fleet-dark, pull/audit-only view for active autonomous runs. It measures bounded project PR
movement and manager outbound silence, persists a restart-safe per-run read breaker, and exposes the
scrubbed result at `GET /autonomous/throughput-floor` for the dashboard and operator.

It does not notify, create attention, dispatch, restart, remediate, or mutate a repository or run.
Missing or uncertain evidence is reported as unknown/ineligible. Proactive attention is explicitly
follow-on work gated on a separately converged SelfHealGate.

## Evidence

- Unit coverage for deliverable semantics, dual-clock flatline, fresh baseline, and restart breaker.
- Authenticated route integration coverage.
- Lifecycle ratchet proving there is no self-action/governor or action-bearing source seam.

## What to Tell Your User

There is now a read-only dashboard observation for autonomous runs that have shown neither project PR
movement nor manager communication. It does not send alerts or change the run.

## Summary of New Capabilities

- Pull scrubbed per-run throughput observations from the Machines dashboard or authenticated API.
- Retain the observation baseline and bounded-read breaker across server restarts.

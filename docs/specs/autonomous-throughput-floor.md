---
title: "Autonomous Throughput Floor — bounded pull/audit visibility"
slug: "autonomous-throughput-floor"
author: "echo + codey"
status: converged
approved: true
ships-staged: true
rollout-disposition: active
rollout-source-pr: 1533
rollout-flag-path: monitoring.throughputFloor.enabled
rollout-criteria: "At least one eligible pull/audit observation completes in the evidence window with its bounded audit record preserved."
rollout-evidence-type: endpoint
rollout-evidence-ref: /autonomous/throughput-floor
rollout-metrics-json: '{"cadenceHours":6,"evidenceMaxAgeHours":12,"metrics":[{"id":"observed-throughput-runs","source":"feature-summary","sourceRef":"autonomous-throughput.observed-runs","direction":"at-least","threshold":1,"minSamples":1}]}'
review-convergence: "2026-07-21 — re-converged at PULL/AUDIT-ONLY v1; action-bearing WIP removed; see reports/autonomous-throughput-floor-convergence.md"
scope: "PULL/AUDIT-ONLY v1"
parent-principle: "Observation Needs Structure"
---

# Autonomous Throughput Floor — PULL/AUDIT-ONLY v1

## Binding scope

V1 is a read and audit surface. It performs bounded project-PR and Telegram-history reads, persists a
machine-local observation baseline plus read breaker, appends scrubbed audit rows, and exposes an
authenticated dashboard/API status. It has no notification, attention, A2A, dispatch, restart,
remediation, scheduling, or other autonomous-action seam.

The measured incident shape is deliberately narrow:

1. a direct GitHub PR sweep found no new merged PR and no descendant, tree-changing open-PR head; and
2. the manager sent no outbound message for the active Telegram autonomous run.

When both clocks exceed 75 minutes, status becomes `flatline-observed`. Nothing is pushed to the user.
An operator or dashboard pulls the result. Proactive attention is follow-on work and requires its own
converged design plus a separately converged SelfHealGate. No dormant switch in v1 can enable it.

## Evidence and authority

The run identity is `hash(topic, startedAt)` from the active autonomous registry. Eligibility requires
a valid Telegram topic, exactly one registered machine, no move marker, and a project directory whose
realpath stays inside the configured project root. Invalid or missing evidence is `ineligible` or
`unknown`, never a flatline.

The deliverable sweep reads the configured GitHub origin with fixed-argv Git/`gh` calls. It caps PRs at
32 (hard maximum 64), applies a shared 10-second timeout (hard maximum 20 seconds), and never fetches,
checks out, or mutates refs. Results contain:

- merged PR number and merge commit SHA; and
- open PR number, head SHA, and head tree SHA.

A deliverable delta is only a newly observed merged identity or a descendant open-head advance whose
tree also changed. Rewinds, replacements, empty commits, timer wakes, ACKs, and status prose do not
count. Compare uncertainty yields `unknown`. Project-wide movement may conservatively mask a run-specific
flatline because v1 has no authoritative run-to-PR mapping; the status names this limitation.

Manager silence uses a bounded 100-row Telegram topic history and the newest `fromUser:false` timestamp.
Coverage must reach run start or the prior cursor. A full page without that boundary is `unknown`. Any
outbound resets the silence clock because main has no authoritative “substantive progress” message kind.
This may conservatively mask silence; it cannot fabricate it.

## Durable state and breaker

Each run owns one adjacent machine-local sidecar:

`<stateDir>/autonomous/<sha256(signalRunId)[0:20]>.throughput-floor.local.json`

The file is versioned, mode 0600, and written temp → fsync → rename. It stores only bounded structural
state: run identity, last snapshot, both clocks, history cursor, failure count, next sweep time, breaker
deadline, and first flatline-observed time. Missing state establishes a baseline at the first successful
observation and never infers historical pressure. Corrupt, mismatched, or future-dated state is
`unknown` and cannot trigger anything.

Reads use one in-flight tick and a persisted backoff of 15m, 30m, 60m, then a six-hour open breaker.
Restart retains that pressure. The half-open read resets failures only on success. Sweep errors are
reduced to `timeout`, `rate-limited`, `auth`, `invalid-scope`, `git-read`, or `github-read`; raw stderr,
URLs, refs, messages, and repository paths never enter status or audit.

## Read surfaces

`GET /autonomous/throughput-floor` is authenticated and returns:

- `enabled`, `mode: "pull-audit-only"`, tick state, and threshold;
- per-run `baseline`, `healthy`, `flatline-observed`, `unknown`, `ineligible`, or `breaker-open`;
- scrubbed durations, reason class, and failure class.

The dashboard consumes the same endpoint. It must label the feature “observed” rather than “stalled” or
“needs attention,” because v1 does not diagnose a mentee or create a user-facing intervention.

## HOLD invariant

Passive HOLD remains permitted only if an authoritative open operator approval gate exists and every
non-gated lane is authoritatively live-reconciled saturated. V1 builds neither lane truth nor a HOLD
authority, so its production result is always unavailable/false. Agent-authored prose never grants HOLD.
The deterministic helper remains tested as an invariant but cannot suppress the read surface.

## Multi-machine posture

V1 is single-machine only. Any registered-machine count other than one or any move ambiguity makes the
run ineligible. The sidecar is machine-local by operator-ratified exception; it is not copied or merged.
Cross-machine one-voice behavior is unnecessary because v1 sends nothing.

machine-local-justification: operator-ratified-exception

## Rollout and rollback

The feature ships fleet-dark behind `monitoring.throughputFloor.enabled`. Config supports only
`enabled`, `flatlineMs`, and `tickMs`. There is no `dryRun` because all behavior is intrinsically read/audit
only. Rollback sets `enabled:false`; sidecars and audit records remain inert. Personal repositories,
branches, PRs, conversations, sessions, attention items, and A2A state are never mutated.

## Acceptance criteria

1. First successful observation establishes a baseline and cannot infer historical flatline.
2. A new merge or descendant tree-changing open head resets the deliverable clock; empty/non-descendant
   changes do not.
3. Any manager outbound resets the silence clock; inbound messages and ticks do not.
4. Only both clocks beyond threshold produce `flatline-observed` in pull/audit status.
5. Unknown history or sweep evidence produces `unknown` and never flatline.
6. State survives restart; a four-failure sequence opens the persisted six-hour breaker.
7. Corrupt, mismatched, future-dated, moved, or multi-machine state fails closed.
8. Source and lifecycle tests prove no notification, attention, dispatch, governor, or remediation seam.
9. The authenticated route and dashboard show the same scrubbed pull posture.
10. Full build, focused unit/integration/E2E tests, side-effects review, and independent code review pass.

## Follow-on boundary

Proactive attention is outside v1. It may be designed only after a separately converged
SelfHealGate supplies authority, dedupe, delivery semantics, resource limits, and one-voice behavior.
Auto-refeed, redispatch, peer classification, lane inference, restart, and remediation also require
separate convergence. V1 contains none of them.

## Decision points touched

- Deliverable delta: deterministic invariant over bounded PR identities and verified ancestry/tree change.
- Manager outbound: invariant consumer of covered Telegram history.
- Flatline posture: deterministic conjunction of the two clocks.
- HOLD: deterministic two-fact invariant; unavailable because v1 lacks lane authority.
- Action admission: not touched; v1 has no action.

## Open questions

*(none)*

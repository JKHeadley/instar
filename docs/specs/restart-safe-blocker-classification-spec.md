---
title: "Restart-safe blocker classification (Step 1 of restart-safe sessions)"
date: 2026-06-01
author: echo
review-convergence: internal-plus-conformance-2026-06-01
approved: true
approved-by: Justin
approved-via: "Standing autonomous directive for the codex-parity run (goal: 'Fix gaps as proper fleet PRs (full ship-gate)') + the #60 mentorship loop. This is the Codey-scoped Step 1 (observability-only). NOTE: because it is a forward-looking enhancement rather than a regression fix, the PR is opened for Justin's explicit merge review — it is NOT auto-merged. The approved tag authorizes the autonomous COMMIT under the standing directive; the merge decision is reserved for Justin."
eli16-overview: restart-safe-blocker-classification-spec.eli16.md
---

# Restart-safe blocker classification (Step 1 of restart-safe sessions)

## Origin

This is the first shippable slice of an idea **Codey (the codex agent) proposed
and scoped** during the 2026-06-01 mentorship loop. Asked for the single
highest-impact gap in running codex-on-Instar, Codey independently identified
the exact problem `restartImmediately` (#641) addresses only for the developer
agent: **restart-deferral behind active sessions leaves the live server running
stale code** — a published+installed update can sit unapplied for hours because
any healthy session blocks the restart. Codey's generalization: make a session
*restart-safe* (carry its goal/thread/pending-state across the bounce) so the
updater can restart through it without losing work — for **any** agent, not just
the developer agent in `restartImmediately` mode.

Codey then scoped the smallest first PR (verbatim): *"the updater implementation
only … classify active blockers into restart-safe vs hard blocker … Step 1
should only expose this classification in updater status; it should not restart
through those sessions yet."* This spec implements exactly that slice.

## Problem

`UpdateGate.canRestart()` classifies running sessions into active (blocking),
unresponsive, and non-blocking idle-job sessions. The *active* set defers the
restart. But not all active blockers are equal: a session whose topic resumes
cleanly across a restart (a resumable autonomous topic, which re-injects its
context via CONTINUATION on the next turn) costs only a brief re-read if
restarted through, whereas an interactive session with unsaved in-flight work
genuinely should not be interrupted. Today the gate cannot tell them apart, so a
later "restart through the safe ones" capability has nothing to build on.

## Decision

Add an **observability-only** classification of the blocking set into
`restartSafeSessions` vs `hardBlockingSessions`, surfaced through
`UpdateGate.getStatus()` → `AutoUpdater.getStatus()` → `GET /updates/status`.

**The restart DECISION is unchanged.** A restart-safe blocker still defers
exactly as today — even when *every* blocker is restart-safe, the gate still
defers (it does not yet restart through them). This PR only establishes the
classification primitive; acting on it is a deliberately deferred later step.

## Design

- **`UpdateGate`** (pure logic): a new optional `restartSafetyResolver?:
  (session: SessionInfo) => boolean` config predicate. `classifyRunningSessions`
  splits each blocker into `restartSafeSessions` (resolver returns true) or
  `hardBlockingSessions` (otherwise). Stored on the instance (like
  `blockingSessions`), cleared in `reset()`, and exposed in `getStatus()` +
  `GateResult`. With no resolver, every blocker is "hard" and the restart-safe
  list is empty — **byte-for-byte the pre-change behavior**. A throwing resolver
  fails safe to "hard" so a faulty check can never make the gate restart through
  a session it shouldn't.
- **`AutoUpdater`**: wires a resolver that treats a blocker as restart-safe when
  its topic has a per-topic autonomous state file
  (`.instar/autonomous/<topicId>.local.md`) — those sessions are driven by the
  autonomous loop and resume via CONTINUATION. Maps the two new fields into
  `AutoUpdaterStatus`. Fails safe to `false` on missing topic id or any fs error.
- **Route**: `GET /updates/status` adds the two fields to its hand-picked
  response object (same pattern as the #59 `restartImmediately` fix).

## Safety / blast radius

Pure additive observability. No restart decision changes; the deferral clock,
warnings, and `alwaysRestartImmediately` short-circuit are untouched. The only
new runtime work is one `fs.existsSync` per blocking session during an update
check (infrequent), guarded by try/catch. Default/no-resolver and error paths
all collapse to today's exact behavior.

## Testing

- **Unit (`tests/unit/UpdateGate.test.ts`, +5):** mixed blockers (1 interactive
  + 1 resumable autonomous) still DEFER but split correctly in result + status;
  all-restart-safe still defers with zero hard blockers (the key no-behavior-
  change invariant); no-resolver back-compat (all hard, restart-safe empty);
  throwing resolver fails safe to hard; reset clears the split.
- **Integration (`tests/integration/updates-status-restart-safe-sessions-route.test.ts`,
  +2):** `GET /updates/status` surfaces both fields (populated and empty),
  pinning the route pick-list against the #59-class omission.

## Deferred to later steps (explicitly out of scope)

Forcing the restart through restart-safe sessions; any "restart capsule" format;
pre/post-restart Telegram notices; post-restart version validation; and policy
knobs for non-dev agents. Per Codey's scoping.

## Migration parity

None — no agent-installed files change (no hook/config/skill/CLAUDE.md template).
Read-only API fields; existing agents gain them automatically on update.

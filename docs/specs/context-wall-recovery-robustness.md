---
title: "Context-wall recovery robustness"
slug: "context-wall-recovery-robustness"
author: "Instar Agent (instar-codey)"
parent-principle: "Structure beats Willpower"
status: "approved"
approved: true
approved-by: "Justin-directed priority via Echo dispatch, 2026-07-23"
review-convergence: "2026-07-23T17:35:00Z"
review-iterations: 1
review-completed-at: "2026-07-23T17:35:00Z"
cross-model-review: "Codex incident trace and boundary review"
eli16-overview: "context-wall-recovery-robustness.eli16.md"
single-run-completable: true
machine-local-justification: process-observer
self-heal:
  class: high
  max-attempts: 3
  max-wall-clock: 30m
  backoff: 15m
  dedupe-key: "context:<sessionName>"
  breaker: "force fresh recovery after 30m persistent latch"
  max-notification-latency: 30m
  audit-location: ".instar/recovery-state.json and recovery:* runtime events"
  remediation-actions:
    - "compact in place at a verified static context wall"
    - "kill and respawn fresh when compaction cannot clear the wall"
---

# Context-wall recovery robustness

## Problem

A context-exhausted session can keep MCP, browser, or SSH child processes alive
while producing no transcript output. The recovery path currently interprets
child-process existence as work, records each postponed check as an attempt, exhausts
its three-attempt budget, and leaves the durable context latch wedged. A later
ordinary respawn can then reuse the same overfull transcript.

## Contract

1. Persist the first-seen time of each context-exhaustion latch.
2. A context-wall evidence wait does not increment the recovery-attempt counter or
   start its cooldown.
3. For context exhaustion, work means growth of the session's own transcript
   across observations. Child-process existence alone is not work.
4. An unresolved first transcript observation may defer safely, but a latch
   persisting for 30 minutes bypasses ambiguity and forces bounded recovery.
5. Try in-place compaction before destructive recovery when the transcript is
   static. If compaction cannot clear the wall, kill and respawn fresh.
6. While a topic's latch is set, every Telegram or Slack spawn path must ignore
   and remove its saved resume UUID. Successful fresh spawn clears the latch.
7. Existing stall, crash, and error-loop child-process veto behavior remains
   unchanged.
8. Presence/standby messaging must name a latched context-exhaustion state even
   after the original banner scrolls out of the pane tail.
9. State migration accepts the previous true-only latch representation without
   crashing or silently clearing the episode.

## Multi-machine posture

The latch, transcript probe, and recovery attempts are machine-local because
they describe one local tmux process and its local transcript. Ownership gates
still run before recovery, so a non-owner cannot use this local evidence to
double-dispatch a peer-owned conversation.

## Rollback

Revert the additive timestamp/probe and spawn guards. The persisted timestamped
latch remains backward-readable as a truthy object; no destructive migration is
required.

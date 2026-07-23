---
title: "Proactive autonomous compaction"
slug: "proactive-autonomous-compaction"
author: "Instar Agent (instar-codey)"
parent-principle: "Structure beats Willpower"
status: "approved"
approved: true
approved-by: "Justin-directed context-wall robustness dispatch via Echo, 2026-07-23"
review-convergence: "2026-07-23T18:39:00Z"
review-iterations: 1
review-completed-at: "2026-07-23T18:39:00Z"
cross-model-review: "Echo incident specification plus Codex boundary review"
eli16-overview: "proactive-autonomous-compaction.eli16.md"
single-run-completable: true
---

# Proactive Autonomous Compaction

Status: implemented, dark by default, dry-run first

## Problem

Long autonomous Claude sessions can reach the context wall while unattended. Recovery after the wall is necessarily more disruptive than compacting before it, but compaction must never interrupt a live turn or affect ordinary interactive sessions.

## Contract

The server may request `/compact` only when every condition is true:

1. `monitoring.proactiveAutonomousCompaction.enabled` is explicitly `true`.
2. The session is registered to a currently autonomous topic.
3. The framework is `claude-code`.
4. Claude's own live pane reports `Context left until auto-compact: N%`.
5. Used context (`100 - N`) is at or above `thresholdUsedPercent` (default 85).
6. `SessionManager.checkSessionWorkState` affirmatively returns `idle`.
7. The per-session cooldown has elapsed.

`working`, `indeterminate`, missing telemetry, non-Claude, non-autonomous, and unregistered sessions are no-ops.

## Rollout

- Absent/false `enabled`: no polling and no behavior change.
- Enabled with omitted/true `dryRun`: log `would-compact`; do not inject.
- Enabled with `dryRun:false`: inject the native `/compact` command through the trusted internal recovery channel.
- Rollback: set `enabled:false`.

## Configuration

```json
{
  "monitoring": {
    "proactiveAutonomousCompaction": {
      "enabled": true,
      "dryRun": true,
      "thresholdUsedPercent": 85,
      "tickIntervalMs": 60000,
      "cooldownMs": 1800000
    }
  }
}
```

## Verification

`tests/unit/ProactiveCompactionSentinel.test.ts` pins the dark default, 85% threshold, dry-run posture, autonomous/framework/idle gates, and cooldown.

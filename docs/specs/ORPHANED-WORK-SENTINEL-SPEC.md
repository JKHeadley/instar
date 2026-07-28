---
title: OrphanedWorkSentinel — the silent-uncommitted-death backstop
status: implemented
tier: 1
origin: 2026-06-12 topic 22367 (operator directive — "fix the class of failures at a more fundamental level")
relates: ["#1093", "#1097 (PromiseBeacon escalation ladder)"]
---

# OrphanedWorkSentinel

## Problem

A decoupled build/autonomous session spawned to do work in an agent worktree can die mid-task with its work **uncommitted** and no PR opened (e.g. a `claude -p` session that launches tests in the background and "stands by" — the turn ends, the session exits). The work sits on disk, invisible.

The PromiseBeacon escalation ladder (#1093/#1097) rescues **registered** commitments whose owning session dies. But when nothing is registered for the code itself, it has nothing to act on. This is the gap: stranded work that no obligation represents.

## Design

A signal-only sentinel that reads stranded work straight off disk — no registration required. The pure classifier (`evaluate`) gates, cheapest-and-most-protective first:

1. owner alive (live process cwd inside, or a session/index lock) → **SKIP** (in flight)
2. no uncommitted work → **SKIP** (nothing stranded)
3. not settled (file activity within `settleMs`) → **SKIP** (paused, not abandoned)
4. else → **ORPHANED** (uncommitted + owner-dead + settled)

On an orphaned worktree the scan pass: records a durable event (`state/orphaned-work.jsonl`), raises ONE deduped agent-health attention item (dedupe key = path + content-signature; the agent-health lane routes to the calm "🩺 Agent Health" topic), and — only behind the off-by-default `preserveWork` sub-flag — writes a NON-destructive preservation patch (`git diff HEAD` + untracked list to a state-dir file; never mutates the worktree/index/ref).

It is the inverse of `AgentWorktreeReaper` (which reclaims clean + merged + idle worktrees and KEEPS anything dirty); they share `agentWorktreeGit` signal sources.

## Posture

Signal-only: records + surfaces, never deletes, never blocks. developmentAgent dark-feature gate — `enabled` OMITTED from the default, resolved by `resolveDevAgentGate` (LIVE on a dev agent, DARK on the fleet). Registered in `DEV_GATED_FEATURES`. Read surface: `GET /orphaned-work` (503 when dark).

## Tests

Unit (classifier both sides of every gate; dedupe; preserve-gating; real-git deps), integration (`GET /orphaned-work` 503-dark / 200-live), e2e (feature-alive from a booted server reflecting the live sentinel).

## Hardening note (the partner fix)

This is the structural backstop for the *recovery* side of the "follow-through dies with its session" class. The *prevention* side — a build/autonomous session must run its tests in the FOREGROUND and commit before yielding, never "stand by" for a background run — is enforced through the build/autonomous skill discipline and the autonomous completion-condition (which judges surfaced evidence, so a session that yields without committing does not satisfy "PR open + green"). The sentinel guarantees that even when prevention fails, the loss is detected and surfaced rather than silent.

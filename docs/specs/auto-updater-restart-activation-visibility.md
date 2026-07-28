---
slug: auto-updater-restart-activation-visibility
title: AutoUpdater restart activation visibility and safe background-job restart blockers
date: 2026-05-29
author: instar-codey
review-convergence: telegram-scope-review-2026-05-29-topic-458
approved: true
approved-by: Justin
approved-via: Telegram topic 458 at 2026-05-29 01:46 PDT
eli16-overview: auto-updater-restart-activation-visibility.eli16.md
---

# Spec — AutoUpdater Restart Activation Visibility

## Problem

AutoUpdater can install new bytes into an agent's shadow install while the running server stays on the old version indefinitely. The install path is healthy, but activation waits because restart gating counts long-lived recurring/background sessions as active blockers. The state file and health surfaces do not make the active restart wait obvious, and the log line frames the old-running/new-installed state as a binary resolution mismatch even when the wait is intentional.

## Scope

1. Keep interactive user sessions conservative. Do not add forced interruption, checkpointing, or parking for interactive work.
2. Do not count recurring/background job sessions as restart blockers when they are safe to ignore: the session has a `jobSlug`, a tmux session name, and the existing `SessionManager.hasActiveProcesses(tmuxSession)` ground truth says no non-baseline work is running.
3. Continue blocking while a background job is actively executing, or when process-tree activity cannot be checked.
4. Persist restart-wait state in `state/auto-updater.json`: target version, first wait time, reason, current blockers, next retry, and update timestamp.
5. Surface the persisted restart-wait state via AutoUpdater status and authenticated `/health`, and include it in `/updates/status`.
6. Replace the misleading intentional-wait log wording with activation-pending wording.

## Non-Goals

- No bounded restart policy for interactive sessions.
- No faster npm polling cadence.
- No change to the supervisor restart request file shape.
- No failed-files-only retry or unrelated dev-gate behavior.

## Acceptance Criteria

- Unit tests prove idle background job sessions do not block, actively executing background job sessions still block, and interactive sessions remain conservative.
- AutoUpdater tests prove restart-wait details are persisted and loaded.
- Server route tests prove authenticated health includes restart-wait details.
- `npm run lint`, focused tests, build, upgrade-guide validation, and instar-dev precommit gate pass.

## Rollback

Revert the UpdateGate, AutoUpdater, route, and test changes and ship a patch. The only new persistent state is additive JSON under the AutoUpdater restart-wait status object; older versions ignore it, and rollback does not require data cleanup.

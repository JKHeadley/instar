# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Closes three independent gaps that all let an agent silently stop working without anyone noticing — diagnosed jointly with the gsd-side echo agent on 2026-05-22 (topic 5447).

**A — WorktreeManager clone-default for cross-project worktrees.** The legacy git-worktree flow keeps per-worktree metadata inside the SOURCE repo's hidden git folder. When Claude Code's sandbox EPERM-blocks paths under the shared projects directory, every git command from the worktree dies (confirmed 2026-05-22, recovery cost ~20m). WorktreeManager now uses `git clone` for cross-project work — self-contained git directory under agent home, no shared-path dependency. Existing in-tree worktrees still use the cheaper worktree path; the `INSTAR_WORKTREE_FORCE_WORKTREE` env var is the rollback escape hatch.

**B — SocketDisconnectSentinel.** Mirrors the RateLimitSentinel pattern shipped earlier this week. Watches tracked sessions for Claude Code's "socket connection closed unexpectedly" message and related disconnect strings every 15 seconds. On detection: immediate plain-English Telegram notice, four-attempt staircase recovery (Ctrl+C + Enter + verify), escalation if recovery fails. No existing detector covered this case; the repo had detectors for hundreds of patterns but zero for this string.

**C — ActiveWorkSilenceSentinel.** Independent of topic binding. Walks the SessionRegistry every 60s looking for "had output recently, hasn't for N minutes" (default 15 min). On match: one gentle nudge to wake the pane, 30-second verify, escalate via the tone-gated attention path if the session doesn't unstick. Covers the gsd-style sub-spawned worktree session pattern that slipped through SessionWatchdog (requires running child), SessionMonitor (only topic-bound), and PresenceProxy (requires user message).

All three sentinel/decision paths route user-facing alerts through the existing MessagingToneGate B12-B14 ruleset — no jargon, always ends in a yes/no CTA.

## What to Tell Your User

- If an agent's Claude Code connection drops, you'll now get a Telegram heads-up within 15 seconds, automatic recovery attempts, and a yes-or-no escalation question if it can't reconnect. No more silent freezes from connection drops.
- If an agent that was actively working stops producing output for 15 minutes — for any reason — you'll get an alert within that window whether or not the agent is topic-bound or has a long-running child. No more silent black holes from frozen sub-sessions.
- Cross-project worktrees now use a self-contained checkout pattern instead of git worktrees, so the macOS sandbox cannot kill your editing session mid-flight by revoking access to the shared repository's metadata folder.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| WorktreeManager clone-default | Automatic for cross-project work; rollback via INSTAR_WORKTREE_FORCE_WORKTREE=1 |
| SocketDisconnectSentinel | Wired into server startup; configurable via config.monitoring.socketDisconnectSentinel |
| ActiveWorkSilenceSentinel | Wired into server startup; threshold configurable via config.monitoring.activeWorkSilenceSentinel.silenceThresholdMs |

## Evidence

- Spec: `docs/specs/silently-stopped-trio.md` (with ELI16 companion). Side-effects: `upgrades/side-effects/silently-stopped-trio.md`.
- Tests: 34 new tests (15 socket + 12 silence + 7 worktree decision).
- Incident reference: topic 5447, 2026-05-22. My session lost ~20m to sandbox EPERM on the shared repo's git-worktrees metadata path; the gsd-side echo session went silent for 1h16m through all three existing watchdogs.

## Rollback

Each layer is independently revertable. WorktreeManager: `INSTAR_WORKTREE_FORCE_WORKTREE=1` forces legacy path; revert the source file otherwise. Sentinels: new files; remove + revert the server-side wire-up.

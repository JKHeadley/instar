# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Closes the failure class that produced the b2lead-insights regression on 2026-05-22 — a recurrence of the 2026-05-20 incident two days after PR #284 shipped four of five fixes and explicitly deferred the fifth. The deferral was *"lifeline auto-restart on server upgrade — out of scope today."* This release ships that missing fifth fix, plus a structural rule that prevents future PRs from leaving similar gaps.

The mechanic: when the AutoUpdater applies a server update that crosses a major.minor boundary, the running lifeline process is on the OLD major.minor and will be rejected by the new server's `/internal/telegram-forward` with HTTP 426 on every forward. Until now, only the lifeline-internal handler reacted to that 426 — but only if the lifeline was already running the post-PR-#284 code. Lifelines started before PR #284 had no such handler and crashed silently into the rate-limit cooldown.

This release adds three independent channels that all write the same coordinated-restart signal at `state/lifeline-restart-requested.json`:

1. **AutoUpdater** — when `crossesBreaking(previousVersion, targetVersion)` is true, writes the signal alongside the existing `restart-requested.json` server-restart flag.
2. **Server `/internal/telegram-forward` 426 handler** — writes the same signal directly. Belt-and-suspenders: covers the case where AutoUpdater is in a deferred / weird state but the server has direct evidence of skew.
3. **PostUpdateMigrator one-time bootstrap** — on first update post-this-release, any agent whose `lifeline-started-at.json` records a major.minor older than the installed version gets the signal written once. Unsticks every currently-stuck agent without manual SIGKILL.

The signal is read by THREE independent consumers (also for redundancy):

- **TelegramLifeline tick** — primary consumer; checks every 30s and calls `initiateRestart('plannedUpgrade', ...)`. New `plannedUpgrade` bucket in `rateLimitState.decide` bypasses the watchdog cooldown identically to `versionSkew`, and counts toward the shared 3-per-24h hard-skew cap.
- **Fleet watchdog (out-of-process)** — checks every 5 min for signals older than 60s. If the lifeline's own tick failed to act, the watchdog force-restarts via `launchctl bootout/bootstrap`. This is the only channel that can break a wedged event loop (the supervisor lives inside the lifeline and shares the loop).
- **(Future) v3 Remediator Tier-3 probe** — explicitly designed to absorb this signal-file orchestration when Tier 3 lands. <!-- tracked: topic-3079-v3-remediator -->

A separate, structural fix ships alongside: the `instar-dev` pre-commit hook (`scripts/instar-dev-precommit.js`) now scans staged specs for orphan deferral language (`deferred / out of scope today / not in this PR / preemptive fix / follow-up`) and blocks the commit unless each occurrence is linked to a tracked marker (`<!-- tracked: <id> -->`) or the spec's frontmatter explicitly waves it through via `deferrals-tracked: <affirmation>`. The override `INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1` is logged + audited.

CLAUDE.md template gains a "Version-Skew Self-Recovery" section so future agents understand the "Heads up: my server auto-updated…" alert as a non-action-needed event.

## What to Tell Your User

- "If your agent's server auto-updates across a breaking version boundary, the lifeline now restarts automatically to match. You may see a one-time *'Heads up: my server auto-updated… ingress is paused…'* Telegram message — no action needed; recovery is automatic within 30s to 5 min. Queued messages replay on recovery."
- "Anything currently stuck on a pre-PR-#284 lifeline self-recovers on the next update without manual intervention."
- "Future PRs cannot ship 'tactical fix + deferred follow-ups' without explicit tracking — the pre-commit hook blocks it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Coordinated lifeline restart on major.minor server bump | Automatic; AutoUpdater writes the signal, lifeline consumes it within 30s |
| Server-side 426 belt-and-suspenders | Automatic; server writes the same signal on its own evidence of skew |
| PostUpdateMigrator stale-lifeline bootstrap | Automatic; one-time nudge per agent on first update post-release |
| Fleet watchdog force-restart on wedged lifeline | Automatic; signals >60s old trigger out-of-process restart |
| Structural no-deferrals enforcement | Automatic; pre-commit blocks unlinked deferral language in specs |
| Version-Skew Self-Recovery awareness in CLAUDE.md | Automatic via PostUpdateMigrator on next update |

## Evidence

- Spec: `docs/specs/auto-updater-lifeline-coordination.md` (with ELI16 companion).
- Side-effects review: `upgrades/side-effects/auto-updater-lifeline-coordination.md`.
- Incident reference: b2lead-insights regression 2026-05-22, ~46h silent Telegram ingress drop. Lifeline pinned at v1.1.0 while server auto-updated through 27 minor releases to v1.2.28.
- Tests: 43 new tests across 5 files (17 unit on version-skew module, 5 unit on rate-limit plannedUpgrade bucket, 5 unit on PostUpdateMigrator nudge, 9 unit on deferrals-check, 7 integration on the full coordinated-restart pipeline).

## Rollback

Every layer is independently revertable. The signal-file format is additive (writers + readers; no existing format changes). New `plannedUpgrade` bucket adds a string union member; revert renames it out. The deferrals-check defaults to mandatory in this release; reverting drops the gate without affecting any other commit path. PostUpdateMigrator's nudge writes a signal that's harmless if left behind (24h cleanup already covers it).

# AgentWorktreeReaper: one-time initial pass after boot (the reaper-never-fires fix)

<!-- bump: patch -->

## What Changed

`AgentWorktreeReaper.start()` scheduled ONLY a 24h `setInterval` — no initial
pass. Agent servers restart far more often than daily (auto-updates, sleep/wake
supervisor bounces), so the interval timer reset on every restart and an
**enabled + armed** reaper never ran a single pass. Measured live on 2026-07-02:
86 worktrees / 25GB accumulated on a machine with `enabled: true, dryRun: false`
and `lastPassAt: 0` — the feature was on and structurally inert (root cause of
that day's fseventsd/reboot resource incident).

The fix:

- New `initialPassDelayMs` config (default 15 min; `<= 0` disables — the exact
  legacy behavior as a no-release rollback lever) on
  `monitoring.agentWorktreeReaper`.
- `start()` now schedules a ONE-TIME initial pass after that delay (unref'd
  timer, cleared by `stop()`), then the unchanged 24h cadence. The delay keeps
  the pass off the busy post-boot window.
- The pass runs through the same `reap()` as always: same KEEP gates (in-use /
  dirty / unmerged / detached), same dry-run gating, same `maxReapsPerPass`
  blast-radius cap, same per-path reclaim-failure breaker. Nothing about WHAT
  may be deleted changed — only WHEN passes run.
- `GET /worktrees/agent-reaper` snapshot additively reports
  `initialPassPending`.
- CLAUDE.md template + PostUpdateMigrator addendum so deployed agents learn the
  new behavior (idempotent, content-sniffed on `initialPassDelayMs`).

## Evidence

- `tests/unit/agent-worktree-reaper.test.ts`: 47/47 green — 7 new tests (initial
  pass fires exactly once at the configured delay and before the interval;
  respects dry-run; disabled reaper sets no timers; `<= 0` restores
  interval-only; `stop()` cancels the pending pass; 24h cadence unchanged after
  the initial pass; snapshot reports `initialPassPending` honestly).
- Live incident data (2026-07-02, topic 30379): reaper enabled+armed with 25
  reap-eligible worktrees and `lastPassAt: 0`; server uptime history shows no
  24h-continuous window for weeks.

## What to Tell Your User

<!-- audience: user, maturity: stable -->

If you switched on the stale-worktree auto-cleaner, it now genuinely runs: one
cleaning pass about 15 minutes after each server start, then daily as designed.
Previously a quirk meant frequent server restarts kept pushing its first run
into the future forever, so leftover work folders could quietly pile up into
tens of gigabytes even with the cleaner enabled. Its safety rules are untouched:
it still only removes folders whose work is fully merged and saved, still does
dry-run first, and it stays entirely off unless you enabled it.

## Summary of New Capabilities

- The stale-worktree reaper actually fires on real deployments: a one-time
  cleaning pass ~15 minutes after boot (tunable/disableable via
  `monitoring.agentWorktreeReaper.initialPassDelayMs`), unchanged daily cadence
  thereafter, and `initialPassPending` visibility on the existing report route.

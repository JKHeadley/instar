<!-- bump: minor -->

## What Changed

Update **mechanics** are now housekeeping — they go to the logs, not the user's
Agent Updates topic. The Updates topic had been flooding with raw version churn
and restart plumbing ("Just updated to v1.3.217. Restarting…", "vX applied but
I'm still running vY — the next restart should pick it up", cascade-batch
"rolling into the pending restart at 02:42"), none of which is user-relevant.
`mature-update-announcements` (#698) silenced the *feature-announcement* path;
this silences the *mechanics* path.

A pure policy module (`src/core/updateNotifyPolicy.ts`) classifies every update
notification into `mechanics | interruption | actionable | failure-escalated`,
and `AutoUpdater.notify()` (plus the restart-handshake emit in `server.ts`)
gates on it at the single notify funnel. **Default kind is `mechanics`** so any
future un-audited callsite is silent rather than spammy. The user now hears about
an update ONLY when: a genuinely new capability ships (the maturity layer), a
restart is actually interrupting their active work right now (a plain,
**version-free** "back in a few seconds" — never "v1.3.X"), or an update is
genuinely stuck after retries. All restart/interruption copy was rewritten
version-free. Opt into a single quiet "just refreshed in the background"
heartbeat with `updates.backgroundRefreshHeartbeat: true` (default false = full
silence); it can never re-introduce version churn.

Code-only behavior change (ships on npm update; no config migration needed —
absence of the new flag = full silence). Agent awareness is added to the
CLAUDE.md template and backfilled to existing agents via `PostUpdateMigrator`
under its own content-sniff guard. Spec: `docs/specs/quiet-update-mechanics.md`.

## What to Tell Your User

- audience: user — maturity: stable
- **Quieter, more relevant updates**: "I'll stop pinging you with version
  numbers and restart plumbing — that all goes to the logs now. You'll only hear
  about an update when there's genuinely something new for you, or when a restart
  is actually about to interrupt you (and even then, plainly — no version jargon)."

## Summary of New Capabilities

- Update **mechanics** (version churn, restart coordination, self-healing skew)
  are now silent — they go to the logs, never the user's Updates topic. The user
  hears about an update only for a new capability, a real interruption
  (version-free), or a genuinely stuck update.
- `updates.backgroundRefreshHeartbeat` (default `false`): opt into a single quiet
  "just refreshed in the background" note instead of full silence. Cannot
  re-introduce version churn.
- Behavioral self-narration rule (CLAUDE.md): when narrating my OWN
  restart/update, no version numbers or restart plumbing — a human "back now"
  only if it actually mattered to the user.

## Evidence

- New: `vitest run tests/unit/update-notify-policy.test.ts tests/unit/update-notify-routing.test.ts` → **16/16 green** (policy both-sides + funnel wiring integrity: `mechanics` never calls `sendToTopic`, `interruption`/`actionable`/`failure-escalated` do, option-B gating, unknown-kind → silent fail-safe).
- Updated to the new contract and green: `notification-spam-prevention`, `auto-updater-failures`, `graceful-updates-phase2`, `update-notification-topic-lock` (mechanics now silent; interruption/actionable now version-free — asserted no `\d+\.\d+\.\d+` leaks).
- Regression-safe: `AutoUpdater`, `AutoUpdater-cascade-dampener`, `restart-window`, `tests/e2e/self-heal-cascade-and-drift`, `tests/integration/updates-status-restart-immediately-route`, `stall-recovery-e2e` all green.
- `tsc --noEmit` clean.

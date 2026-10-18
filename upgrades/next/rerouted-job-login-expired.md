# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

On 2026-10-18 the Mac Studio ran no scheduled jobs from 08:35Z to 16:35Z and again from 16:35Z onward. Rerouted-interactive job sessions (`launchLane: rerouted-interactive`, `completionMode: 'pattern'`) were launched under the `gearfinity3d` pool login, whose interactive sign-in had expired on 2026-10-16. Claude Code printed `⏺ Login expired · Please run /login` and idled. The rerouted branch of the SessionManager monitor tick only checks (a) the completion sentinel and (b) the hard lifetime cap (`maxReroutedLifetimeMinutes`, 480), so each dead session held a scheduler slot (`maxParallelJobs: 2`) for 8 hours. With both slots held, every other job (feedback-factory-triage/-process/-execute, health-check, …) queued with `nextScheduled` in the past while `schedulerRunning` stayed true.

- **New `src/core/LoginExpiredSignature.ts`** (`classifyLoginExpired`): a pure, tail-gated (last 12 non-empty lines), frame-discriminated classifier. A line counts only if it is glyph-led (Claude Code's rendered message) and, after the lead is stripped, begins with `Login expired`, `OAuth token has expired`, `Invalid API key … /login` or `Please run /login`. Prose containing the phrase mid-line, and non-glyph-led lines, never match. Reuses `paneTail.liveTail` / `stripLineLead` / `wasGlyphLed`.
- **SessionManager rerouted branch, new step (c):** after the sentinel and lifetime checks, for a non-protected, non-standing session, `endIfLoginExpired` captures 40 lines; the first sighting is recorded in `loginExpiredFirstSeen`; a sighting still present after `LOGIN_EXPIRED_DWELL_MS` (60 s) terminates the session with reason `rerouted-login-expired`, `finalStatus: 'killed'` (the job records a failure and reruns on its next trigger), and reports the `SessionManager.monitorTick.reroutedLoginExpired` degradation naming the live `CLAUDE_CONFIG_DIR`. A sighting that disappears is cleared; entries for sessions no longer running are evicted each tick.
- Pool/account state is not touched: `needs-reauth` stays with the QuotaPoller's corroborated path.
- CLAUDE.md template and `migrateClaudeMd` gain the "A job session stuck at an expired login is ended in minutes" bullet after the standing-sessions bullet.

## What to Tell Your User

If one of my sign-ins expires, scheduled jobs that happen to start under it used to sit stuck for up to eight hours, and while they sat there no other scheduled job could run. Now such a job is stopped about a minute after it starts, so the rest of the schedule keeps running, and the server log says which sign-in needs renewing.

## Summary of New Capabilities

- A scheduled job that starts under an expired sign-in is ended within about a minute instead of blocking the job queue for eight hours.

## Evidence

- Reproduction (live, Mac Studio, 2026-10-18): `GET /jobs` showed feedback-factory-triage/-process/-execute and health-check with `lastRun` 08:35Z, `lastError: Session killed`, `nextScheduled` 16:40–17:00Z while the time was 20:47Z; the held sessions `job-overseer-maintenance-mve1qxb5` and `job-evolution-overdue-check-mve1qxag` (started 16:35Z) had `CLAUDE_CONFIG_DIR=…/.claude-followme-gearfinity3d` and the pane showed `⏺ Login expired · Please run /login`; `server-stderr.log` shows `job-health-check-mvdkle5n` killed at `480m > 480m`. Ending those two sessions by hand let `feedback-factory-action-list` and `relationship-maintenance` start within two minutes on a signed-in login.
- Unit: `tests/unit/LoginExpiredSignature.test.ts` (the real captured frame; three other CLI frames; prose mention, non-glyph-led line and stale scrolled-up frame do not match; empty capture), `tests/unit/headless-spawn-reroute.test.ts` (dwell elapsed → killed with `rerouted-login-expired` + degradation; inside the dwell → running; frame gone → sighting cleared; a session discussing the error → never ended), `tests/unit/rerouted-login-expired-awareness.test.ts` (template placement, migration once + idempotent). The two dwell-path tests fail with the new step disabled.

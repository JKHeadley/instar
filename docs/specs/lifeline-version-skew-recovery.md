---
title: Lifeline version-skew recovery — close the silent-drop class
date: 2026-05-20
author: echo
review-convergence: tactical-hotfix-2026-05-20
approved: true
approved-by: Justin
approved-via: Telegram topic 11013 ("Yes, please" at 2026-05-20 23:55 UTC, in response to my audit of the b2lead-insights post-incident report)
eli16-overview: lifeline-version-skew-recovery.eli16.md
---

# Spec — Lifeline version-skew recovery

**Date:** 2026-05-20
**Author:** echo
**Status:** in-flight (approved 2026-05-20 in topic 11013)
**Triggering incident:** b2lead-insights, 2026-05-19 → 2026-05-20, ~21h silent
Telegram ingress drop. Post-incident report filed by that agent's operator
and shared via Telegram on 2026-05-20.

## Background

After the agent's server auto-updated from v1.0.13 → v1.1.0, the
lifeline process kept running v1.0.13. The server's
`/internal/telegram-forward` endpoint enforces a major/minor handshake
and rejected the older lifeline's forwards with HTTP 426. The lifeline
did the right thing on detection (raised `ForwardVersionSkewError`,
requested a restart), but FIVE compounding bugs prevented the
auto-recovery loop from closing:

1. **Cooldown swallowed every restart attempt.** `rateLimitState.decide`
   gated the `versionSkew` bucket through the same `WATCHDOG_COOLDOWN_MS`
   check as the watchdog bucket. A hard incompatibility cannot be cured
   by waiting; the cooldown turned a recoverable outage into a permanent
   wedge.

2. **Replay-after-3-failures-then-drop silently lost user messages.**
   `TelegramLifeline.replayQueue` treats every forward failure as a
   transient retry candidate. Three failures in a row (which a
   version-skew episode produces on the first three replay ticks) →
   the message is dropped with only a degradation event, not a
   user-visible notification.

3. **`instar lifeline restart` used the wrong service label.** The CLI
   hardcoded `com.instar.<projectName>.lifeline`; the plist generated
   by `installMacOSLaunchAgent` uses `ai.instar.<projectName>`.
   `launchctl kickstart` always failed with "Could not find service"
   and silently fell back to pkill, which triggered failure #4.

4. **pkill fallback left a wedged process holding the lifeline.lock.**
   The fallback sent SIGTERM, then walked off. The old lifeline
   transitioned to sleeping ('S') state but didn't actually exit,
   holding `.instar/lifeline.lock`. New launchd-respawned lifelines
   couldn't take the lock and exited in a loop ("Another lifeline
   instance is already running"). Recovery required manual SIGKILL.

5. **better-sqlite3 rebuild reported success against the SAME wrong
   ABI.** Observed in the same b2lead logs: `npm rebuild better-sqlite3`
   exits 0 but `require()` still throws NODE_MODULE_VERSION. Without
   `--build-from-source`, npm can pull a cached prebuilt with the
   wrong ABI and call that "rebuilt". The healer logs "rebuild
   succeeded but module still fails to load" and gives up.

## Goal

Make a server/lifeline version skew auto-recover within one supervisor
cycle. Make a stuck-lifeline lock auto-recover within one restart
cycle. Make a native-module rebuild produce a binary that actually
loads. Make the user-visible alert path fire when ingress is paused
so the agent does not appear asleep.

## Scope (must-haves)

### Change 1 — Rate-limit bypass for `versionSkew` bucket

**File:** `src/lifeline/rateLimitState.ts` (`decide`)

`versionSkew` skips the `WATCHDOG_COOLDOWN_MS` check. The
`VERSION_SKEW_DAILY_CAP` of 3-per-24h remains as the loop-safety
backstop so a misconfigured handshake can't infinitely restart-cycle.
Watchdog and storm-detection paths are unchanged.

### Change 2 — Drop policy branches on version-skew episode state

**File:** `src/lifeline/TelegramLifeline.ts` (instance state +
`handleVersionSkew` + `forwardToServer` success path + `replayQueue`)

- Add `versionSkewActive: boolean` + `versionSkewAlertSentAt: number`
  fields.
- On `ForwardVersionSkewError`, set `versionSkewActive = true`, fire
  one user-visible Telegram alert to the originating topic explaining
  ingress is paused (dedupe via `versionSkewAlertSentAt`, 24h window),
  then continue requesting the restart through the orchestrator.
- On any successful forward, clear `versionSkewActive` and the alert
  dedupe timestamp.
- In `replayQueue`, BEFORE the drop check, if `versionSkewActive` is
  set, re-queue the message WITHOUT incrementing `replayFailures`.

### Change 3 — CLI service label

**File:** `src/cli.ts` (`lifelineCmd.command('restart')`)

Replace `com.instar.${projectName}.lifeline` with
`ai.instar.${projectName}` so `launchctl kickstart gui/<uid>/<label>`
matches the plist label written by `installMacOSLaunchAgent`.

### Change 4 — pkill fallback escalation + stuck-lock recovery

**Files:** `src/cli.ts` (lifeline restart fallback path),
`src/lifeline/TelegramLifeline.ts` (`acquireLockFile`)

- CLI fallback: SIGTERM, 3s grace, then SIGKILL by name pattern.
- Lock-acquire: if the lock-holder PID is in 'S' (sleeping) state with
  the lock written >5 minutes ago, send SIGTERM, poll for exit up to
  3s, then SIGKILL. Take the lock.

### Change 5 — `--build-from-source` on native rebuild

**Files:** `src/lifeline/ServerSupervisor.ts:751` (`rebuildArgs`),
`src/memory/NativeModuleHealer.ts:397` (in-line `healBetterSqlite3Sync`)

Add `--build-from-source` and `--ignore-scripts` to the npm rebuild
argv. Forces compilation against the current Node ABI instead of
installing a cached prebuilt.

## Non-goals

- Not changing the Remediator architecture (Tier 1 still in rollout
  per v3 spec). The in-line healer is the steady-state path on
  current ships.
- Not changing the auto-update flow itself — only the version-skew
  HANDLING path that fires after an auto-update produced the skew.
- Not changing message-queue persistence semantics — the existing
  `MessageQueue.enqueue` is the durable surface; the fix only
  changes the drop-vs-re-queue decision around it.

## Acceptance criteria

1. **Cooldown bypass:** `decide(state, 'versionSkew', now)` allows
   even when `now - lastRestartAt < WATCHDOG_COOLDOWN_MS`; same state
   blocks the `'watchdog'` bucket. (Unit-tested.)
2. **CLI label correctness:** the lifeline-restart command builds the
   label `ai.instar.${projectName}`; never `com.instar.…`.
3. **Rebuild flag presence:** every `npm rebuild ... better-sqlite3`
   call in the supervisor preflight and the in-line healer includes
   `--build-from-source`.
4. **Replay drop guard:** `TelegramLifeline.replayQueue` checks
   `versionSkewActive` BEFORE the `MAX_REPLAY_FAILURES` drop branch.
5. **handleVersionSkew alert:** the handler sets `versionSkewActive`
   and sends a user-visible alert with the dedupe timestamp set.
6. **Stuck-lock recovery:** `acquireLockFile` recognizes sleeping ('S')
   processes older than 5 min as candidates for SIGTERM-then-SIGKILL
   escalation.

## Signal-vs-authority compliance

| Component | Signal or Authority | Reason |
|-----------|--------------------|--------|
| `rateLimitState.decide` | Signal (returns decision) | Caller decides. |
| `handleVersionSkew` setting flag | Signal | The replay loop is the consumer; orchestrator is the restart authority. |
| Replay loop drop guard | Authority (decides re-queue vs. drop) | Deterministic — branch on a typed flag. |
| CLI pkill escalation | Bounded recovery primitive | Single SIGTERM, fixed 3s grace, single SIGKILL. |
| Lock-acquire stuck-S detection | Bounded recovery primitive | Probes ps state, SIGTERM, 3s poll, SIGKILL. |
| Rebuild flag | Mechanical change | No judgment — always pass the flag. |

No new judgmental gates. The new authorities are bounded mechanics.

## Rollback

Pure code change. Every fix is independently revertable. No persistent
state schema changes; the new lifeline instance fields are not
serialized.

## Forward note (NOT in this PR)

- The full Remediator v3 architecture (`src/remediation/*`) supersedes
  the ad-hoc rate-limit + replay-loop coordination once Tier 1 ships.
  That work is tracked separately. This PR is the steady-state
  hardening for in-the-wild agents on current main.
- A "lifeline auto-restart on server upgrade" would close this class
  preemptively (so a skew can't happen in the first place). Out of
  scope today.

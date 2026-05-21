# Side-Effects Review — Lifeline version-skew recovery

**Version / slug:** `lifeline-version-skew-recovery`
**Date:** `2026-05-20`
**Author:** Echo (instar developer agent)
**Trigger:** 2026-05-19 → 2026-05-20 b2lead-insights field incident (21h silent
Telegram ingress drop after server auto-update from v1.0.13 → v1.1.0;
lifeline stayed on v1.0.13; HTTP 426 from `/internal/telegram-forward`
went to 3-attempts-then-drop replay policy; restart attempts blocked by
cooldown; manual operator recovery required).

## Summary of the change

Five interlocking fixes that together close the silent-drop failure
class. All independently revertable.

1. **Rate-limit cooldown bypass for `versionSkew` bucket.** A
   no-op-against-mismatch wait is replaced with allow-but-rate-limit
   (daily cap still applies). One-line condition change in
   `decide()`.

2. **Drop policy guards on `versionSkewActive` instance flag.** Three
   new state operations:
   - `handleVersionSkew` sets `versionSkewActive = true` and fires
     one user-visible alert (dedupe via `versionSkewAlertSentAt`).
   - `forwardToServer` success clears the flag + dedupe timestamp.
   - `replayQueue` re-queues without incrementing failures while
     the flag is set.

3. **CLI service label fix.** `com.instar.<name>.lifeline` →
   `ai.instar.<name>`. Matches the plist label written by
   `installMacOSLaunchAgent`. Stops the always-fall-back-to-pkill path.

4. **pkill fallback escalates + lock-acquire recognizes wedged-S.**
   CLI: SIGTERM, 3s grace, SIGKILL by pattern. Lock-acquire: detects
   sleeping ('S') state with lock-write age > 5 min as a wedged
   lifeline, sends its own SIGTERM → 3s poll → SIGKILL sequence.

5. **`--build-from-source` + `--ignore-scripts` on every native
   rebuild.** Two call sites: ServerSupervisor preflight rebuild
   (line 751) and NativeModuleHealer.healBetterSqlite3Sync
   (line 397). The Remediator-orchestrated path already had these
   flags (NativeModuleHealer.healBetterSqlite3FromRemediator).

Files touched (excluding tests / docs):
- `src/lifeline/rateLimitState.ts` — `decide()` cooldown bypass
- `src/lifeline/TelegramLifeline.ts` — instance state, `handleVersionSkew`,
  `forwardToServer`, `replayQueue`, `acquireLockFile`
- `src/cli.ts` — label fix + pkill escalation
- `src/lifeline/ServerSupervisor.ts` — rebuild flags
- `src/memory/NativeModuleHealer.ts` — rebuild flags

## Decision matrix

### Over-block

| Scenario | Outcome |
|----------|---------|
| Lifeline at SAME version as server (no skew) | No change — `versionSkewActive` stays false |
| Lifeline at OLD version, server unchanged (no auto-update) | No change — no 426, no skew |
| Genuine transient 5xx | Drop-after-3 still fires (versionSkewActive is false) |
| `ForwardServerBootError` (server starting) | Drop-after-3 still fires — known limitation; this PR doesn't try to also branch on serverBoot. Out of scope. Justified: serverBoot is short-lived (seconds), version skew is steady-state until restart. |
| Lifeline restart loop after fix | Daily cap (3-per-24h) plus storm detection bound the loop |

No over-block. The new authority only fires when ALL of:
1. The forward threw `ForwardVersionSkewError`,
2. The server version in the body differs from the lifeline's,
3. The body's `upgradeRequired === true`.

That's the same gate that already triggers the restart request, so we
haven't widened the surface — just made the consequences during the
window correct.

### Under-block

| Scenario | Outcome |
|----------|---------|
| Lifeline version "skews" because of a malformed 426 body | Guarded by existing `body.upgradeRequired !== true` and `serverVersion === this.lifelineVersion` checks — they were already in `handleVersionSkew` |
| Lifeline tries to forge a skew to bypass cooldown | The 426 must come from the SERVER (loopback addr only on a privileged port); the lifeline cannot self-trigger the body shape |
| Two version-skew episodes in <24h (daily cap reached) | Falls through to existing `version-skew-daily-cap` denial — observability path remains intact |
| Stuck-lock detection: live healthy lifeline misidentified as wedged | Requires lock-age > 5 min AND 'S' state — a healthy lifeline writes the lock, immediately starts polling Telegram (lots of 'R' time), and answers heartbeats. Misidentification window is narrow but possible during long Telegram long-poll waits. Acceptable: false positive triggers SIGTERM → 3s grace → SIGKILL of a healthy lifeline → launchd respawns it within seconds. Worst case: ~5s downtime + a fresh boot. Far better than the 21h+ silent drop the current code permits. |
| Forced rebuild with `--build-from-source` fails because node-gyp toolchain absent | Already-existing failure path: spawnSync returns non-zero, healer logs error, falls back to existing escalation. No new silent failure. |

### Level of abstraction fit

- Rate-limit bypass — at the decision-point that already knows about
  buckets. Right layer.
- Drop policy — at the replay loop that already has the failure-counter
  state. Right layer. Could have lived in `forwardToServer` instead,
  but the queue is what owns "should this message be dropped" — the
  forward path only owns "did this single attempt succeed".
- CLI label — at the kickstart callsite. One source of truth.
- pkill escalation — at the CLI fallback. The CLI is the place where
  "user typed `instar lifeline restart`" gets translated to a system
  action.
- Lock-acquire — at the lock-acquire function. The detector and the
  recovery primitive are both bounded mechanics in the same scope.
- Rebuild flags — at the rebuild callsites. No new abstraction.

No over-engineering. Each change is at the layer that already owns
the concern.

### Signal-vs-authority compliance

- `rateLimitState.decide` — returns signal. No authority change.
- `versionSkewActive` flag — pure state signal. Replay loop is the
  authority that decides re-queue vs drop.
- `handleVersionSkew` — already had authority over "request a restart".
  Now also: sets the flag and sends an alert. Both are bounded
  mechanics with clear preconditions, not judgmental gates.
- CLI label — mechanical change.
- pkill escalation — bounded recovery (fixed 3s grace, single SIGKILL).
- Lock-acquire stuck-S — bounded recovery (fixed 5min threshold for
  age, 3s SIGTERM grace, single SIGKILL).
- Rebuild flags — mechanical change.

Compliant. No new judgmental gates; new authorities are bounded
recovery primitives.

### Interactions with adjacent systems

| System | Interaction | Risk |
|--------|-------------|------|
| `MessageQueue` | Replay loop re-queues messages during skew (same enqueue path used for transient failures) | None — queue persistence semantics unchanged |
| `notifyMessageDropped` | NOT called during version-skew episodes (drop is suppressed) | Strictly improves — these messages will deliver |
| `DegradationReporter` | Still fires for non-skew drops; version-skew episode itself emits a degradation via the existing path | None |
| `RestartOrchestrator` | Receives a `versionSkew` request that's now more likely to be granted (cooldown bypass) | Storm detection + daily cap remain as backstops |
| `ServerSupervisor.preflightSelfHeal` | Rebuild flag change is a strict improvement | None |
| Remediator (Tier 1+) | Not yet shipped; in-line healer is the steady-state path. When Remediator ships, its rebuild already used `--build-from-source` — no conflict | None |
| `NativeModuleHealer.invokeFromRemediator` | Unchanged (already had the flag) | None |
| `LifelineHealthWatchdog` | Tracks `consecutiveForwardFailures`; this PR clears it on success (existing behavior). No change to the watchdog's trip conditions | None |
| `WatchdogTriggers.versionSkew` | The flag-set + alert-send happens BEFORE `initiateRestart`. If the restart is rate-limited, the alert still fires — good (user knows ingress is paused even while the lifeline is being patient about restarts) | None |
| `acquireLockFile` callers | The added SIGTERM-then-SIGKILL path runs in the boot-startup window. New lifelines that find a wedged old one will spend up to 3s waiting for graceful exit. Acceptable | None |
| Existing tests | All 18 `rateLimitState.test.ts` + 14 `lifeline-shadow-install-self-heal.test.ts` + 9 `NativeModuleHealer.test.ts` tests pass unchanged | Verified |

### Rollback cost

- Each fix is independently revertable.
- No persistent state schema changes; the new lifeline instance
  fields (`versionSkewActive`, `versionSkewAlertSentAt`) are not
  serialized to disk.
- No migration entry; existing in-the-wild agents pick up the fix on
  their next `npx instar` update like any other patch.
- Reverting the rebuild flag returns to the pre-existing flaky
  rebuild behavior — agents that had drifted to "rebuild succeeded
  but still fails" on the old code path continue exactly as they
  did.

## Acceptance criteria (test-mapped)

1. `tests/unit/lifeline/rateLimitState.test.ts > versionSkew bucket
   BYPASSES the cooldown` — asserts the new bypass.
2. `tests/unit/lifeline/version-skew-recovery.test.ts > CLI service
   label` — asserts `ai.instar.${...}` is in source and
   `com.instar.${...}.lifeline` is gone.
3. `tests/unit/lifeline/version-skew-recovery.test.ts > pkill
   fallback escalates to SIGKILL` — asserts both signal calls
   present in the restart command source.
4. `tests/unit/lifeline/version-skew-recovery.test.ts >
   ServerSupervisor preflight rebuild passes --build-from-source` —
   asserts the rebuild argv on the supervisor side.
5. `tests/unit/lifeline/version-skew-recovery.test.ts >
   NativeModuleHealer in-line rebuild passes --build-from-source` —
   asserts EVERY rebuild call in the healer source has the flag.
6. `tests/unit/lifeline/version-skew-recovery.test.ts > lifeline
   source guards drop with versionSkewActive` — asserts the source
   order (skew bypass before drop check).
7. `tests/unit/lifeline/version-skew-recovery.test.ts >
   handleVersionSkew sets the active flag + alert dedupe`.
8. `tests/unit/lifeline/version-skew-recovery.test.ts >
   forwardToServer success clears the version-skew episode flag`.
9. `tests/unit/lifeline/version-skew-recovery.test.ts > lock-acquire
   treats sleeping (S) state > 5 min as recoverable`.

## Forward note

If the auto-update flow eventually grows a "tell the lifeline to
restart" step, the failure class this PR addresses becomes
impossible-by-construction. Until then, this is the steady-state
recovery for the window between server-update and lifeline-restart.

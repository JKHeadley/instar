# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**fix(lifeline): close the silent-drop version-skew failure class.**

Five interlocking fixes that together address the 2026-05-19 →
2026-05-20 b2lead-insights field incident (21h silent Telegram ingress
drop after a server auto-update from v1.0.13 → v1.1.0 left the
lifeline on v1.0.13; server's `/internal/telegram-forward` rejected
the lifeline with HTTP 426 and the lifeline's drop-after-3-failures
replay policy silently lost user messages).

1. **`rateLimitState.decide` — `versionSkew` bucket bypasses
   cooldown.** A hard incompatibility cannot be cured by waiting; the
   per-minute cooldown wedged every restart attempt. The daily cap
   (3 per 24h) and storm detection remain as backstops.

2. **Replay-loop drop policy is gated on a version-skew episode
   flag.** When `forwardToServer` raises `ForwardVersionSkewError`,
   the lifeline sets `versionSkewActive = true` and sends one
   user-visible Telegram alert ("ingress paused: version skew
   detected, your messages are not lost"). The replay loop checks
   the flag BEFORE the `MAX_REPLAY_FAILURES` drop check and re-queues
   without incrementing the failure counter. Cleared on the next
   successful forward.

3. **`instar lifeline restart` CLI uses the correct service label.**
   Was `com.instar.<projectName>.lifeline` — different domain AND
   different suffix from what `installMacOSLaunchAgent` writes
   (`ai.instar.<projectName>`). `launchctl kickstart` always failed,
   silently fell back to pkill.

4. **pkill fallback escalates to SIGKILL; lock-acquire recognizes
   wedged sleeping processes.** SIGTERM, 3s grace, SIGKILL by name
   pattern in the CLI. In `acquireLockFile`, 'S' (sleeping) state
   with lock-write age > 5 min is treated as a wedged lifeline:
   SIGTERM → 3s poll → SIGKILL → take the lock.

5. **`npm rebuild` for better-sqlite3 uses `--build-from-source` and
   `--ignore-scripts`.** Two call sites: `ServerSupervisor`
   preflight rebuild and `NativeModuleHealer.healBetterSqlite3Sync`.
   Without `--build-from-source`, npm can install a cached prebuilt
   with the same wrong ABI and exit 0 — producing the "rebuild
   succeeded but module still fails to load" pattern in the b2lead
   logs.

Files touched (excluding tests / docs / upgrade notes):
- `src/lifeline/rateLimitState.ts` — `decide()`
- `src/lifeline/TelegramLifeline.ts` — instance state,
  `handleVersionSkew`, `forwardToServer`, `replayQueue`,
  `acquireLockFile`
- `src/cli.ts` — `lifelineCmd.command('restart')`
- `src/lifeline/ServerSupervisor.ts` — preflight rebuild argv
- `src/memory/NativeModuleHealer.ts` — in-line rebuild argv

## Evidence

**Repro of the original failure** (b2lead-insights, 2026-05-19 evening
→ 2026-05-20 ~17:50 UTC):

1. Server auto-updated v1.0.13 → v1.1.0.
2. Lifeline kept running v1.0.13.
3. User Telegram messages → lifeline forwards to server → server
   returns HTTP 426 with `{ok: false, upgradeRequired: true,
   serverVersion: '1.1.0', action: 'restart', reason: 'major-minor-mismatch'}`.
4. Lifeline catches `ForwardVersionSkewError`, calls
   `handleVersionSkew` → `initiateRestart('versionSkew', ...)`.
5. `RestartOrchestrator.maybeRestart` consults `rateLimitState.decide`.
   `elapsed < WATCHDOG_COOLDOWN_MS` → returns `{allowed: false, reason:
   'cooldown-active'}`. No restart.
6. Lifeline returns false from `forwardToServer`. Replay loop
   increments `replayFailures`. After 3 attempts → drop.
7. 40+ "server-down" notifications + at least 2 explicitly-logged
   dropped messages (`tg-6577`, `tg-6580`). No user-visible alert.

**Observed before:** `rateLimitState.ts:112` had no special-case for
`versionSkew` — the cooldown check fired for all buckets. The replay
loop at `TelegramLifeline.ts:1394` checked `failures >=
MAX_REPLAY_FAILURES` unconditionally. The CLI restart command at
`cli.ts:1639` hardcoded `com.instar.${projectName}.lifeline`.
`ServerSupervisor.ts:751` and `NativeModuleHealer.ts:397` both ran
`npm rebuild better-sqlite3` without `--build-from-source`.

**Observed after:**
- 26 new + extended unit tests (8 new in
  `tests/unit/lifeline/version-skew-recovery.test.ts`, 1 new in
  `tests/unit/lifeline/rateLimitState.test.ts`) cover all five paths.
- Source assertions verify the supervisor rebuild argv includes
  `--build-from-source` AND `--ignore-scripts`, the healer in-line
  rebuild includes both flags, the CLI restart command builds
  `ai.instar.${...}` and never `com.instar.${...}.lifeline`, the
  pkill fallback contains both `-TERM` and `-KILL`, the
  `versionSkewActive` flag is set in `handleVersionSkew`, cleared in
  `forwardToServer` success, checked in `replayQueue` BEFORE the
  drop branch, and the lock-acquire path recognizes wedged-S.

Spec: `docs/specs/lifeline-version-skew-recovery.md`
ELI16: `docs/specs/lifeline-version-skew-recovery.eli16.md`
Side-effects review: `upgrades/side-effects/lifeline-version-skew-recovery.md`

## What to Tell Your User

- **You will never silently lose a message during an auto-update
  again**: if my server and my Telegram lifeline temporarily get out
  of sync after an update, I'll send you one clear note that ingress
  is paused, keep all your messages safely in the queue, and replay
  them as soon as the lifeline catches up.
- **Recovery is automatic**: the bug class that needed a manual
  restart to clear is now self-healing. No operator intervention.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Version-skew cooldown bypass | automatic |
| Version-skew user alert (one per episode) | automatic |
| No-drop policy during version-skew episodes | automatic |
| CLI lifeline restart resolves correct service | automatic via `instar lifeline restart` |
| Wedged-lifeline lock recovery | automatic |
| Force-from-source native rebuilds | automatic |

# Side-Effects Review — a key put in during a usage limit goes into use

**Version / slug:** `usage-limit-key-pickup`
**Date:** `2026-11-07`
**Author:** `echo (builder echo-usage-pickup, for hub 136110)`
**Second-pass reviewer:** `independent subagent (recovery path touched)`

## Summary of the change

The running server read a key saved by `instar set-claude-key` only from `ClaudeKeyHealth.tick()` / `handle()`. Its timer runs only while the key is `dead` or recovery work is pending, and `handle()` runs only for a session at the login screen. A usage limit is neither, so on 2026-11-07 (B2Lead live proof on nimbus, 1.3.1719-local.5052a841) the saved keys were never used: `/health` still said the key was `ok` after a random bad key went in, the sessions and the usage probe stayed on nimbus's original walled key, `UsageLimitWatch` stayed `limited` from 22:03:08Z to the end of the run, and no conversation answered (818 s and 1008 s). The nimbus log has no "the configured key changed" line in 43,908 lines.

Fix, six files (two causes; the second was found by the live re-run on nimbus at 15:45 with the first fix installed):
- `src/core/ClaudeKeyHealth.ts`: public `refreshKeyFromDisk()` (the existing `syncKeyFromDisk` + `ensureTimer`, never throws) and a key watch started in `boot()` that runs it every `KEY_WATCH_MS` (60 s) whatever the key's state; cleared in `stop()`.
- `src/core/UsageLimitWatch.ts`: optional `syncKey` dep, called at the start of each limited tick before the fingerprint is read, so a new key is probed on the very next pass; one log line per probe result.
- `src/commands/server.ts`: `syncKey: () => claudeKeyHealth.refreshKeyFromDisk()`.
- `src/core/Config.ts`: `readConfiguredAnthropicKey` returns `undefined` (keep the key in use) when the saved key is not a string, for example a secret-store placeholder that is only filled in at boot. The watch now reads every minute, so reading that as "no key" would wipe a working key (second-pass finding 1).

Second cause (live re-run 2, nimbus 1.3.1719-local.f6315e14, 15:40-16:01 PST): with the key now picked up ("configured key changed" 3 s after it was saved, probe `ok`, "Claude usage is back" 26 s after), neither conversation restarted. Both sessions had `claudeSessionId` None: instar learns the transcript id only from hook events (PostToolUse, Stop, ...), and a session whose first turn is refused for usage runs no tool and fires no Stop. `confirmSessionUsageLimit` returned false before reading anything, so the sessions were never recorded as walled, the recovery sweep skipped them, and the watchdog's later wall signal fell inside the post-recovery cooldown. The transcripts themselves held the `rate_limit` row (the evidence function returns true on them). Fix:
- `src/monitoring/sessionUsageLimitEvidence.ts`: `claudeSessionIdFromPidFiles(configHome, tmuxSession)` reads Claude Code's own `<configHome>/sessions/<pid>.json`. Only a file whose `tmux` field names exactly this session, whose pid matches its file name and is alive, and whose id passes `isSafeSessionRef` counts; the newest wins.
- `src/core/SessionManager.ts` `confirmSessionUsageLimit`: when no id is known, use that record and bind it with `setClaudeSessionId` (what the next hook event would do).

Tier 1: 6 source files, ~110 added lines, one new test file; revert undoes it fully. One commit attempt planned, no spec review rounds.

## Decision-point inventory

- `ClaudeKeyHealth.syncKeyFromDisk` (existing): applies the disk key into the live config and SessionManager. Unchanged logic; it now also runs on a steady timer.
- `UsageLimitWatch.tick` (existing): fingerprint change → probe now. Unchanged logic; it now sees the fresh key.

## 1. Over-block

No issue identified. Nothing new is refused or held.

## 2. Under-block

A key saved between watch passes is used up to 60 s later (UsageLimitWatch's own tick syncs first, so under a limit the delay is at most one usage tick). Claude Code versions that write no `sessions/<pid>.json` behave as before (id unknown until a hook reports it). A config written by hand with a broken JSON shape reads as `undefined` (unreadable), which keeps the last key, as before. Agents with key health off (`sessions.claudeChildAuth.enabled: false`) read nothing from disk, as before.

## 3. Level-of-abstraction fit

Right layer: ClaudeKeyHealth already owns "what disk says vs what is in use" (`readKeyFromDisk`/`applyKey`). The fix makes that sync run when it should, rather than adding a second reader in UsageLimitWatch.

## 4. Signal vs authority compliance

No new authority. Applying the saved key is the operator's own instruction (`set-claude-key` says "Your agent picks it up by itself"); the probe still decides whether usage is back.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- Binding the id from the pid record: every later hook event carries the same id (last-writer-wins, so no conflict). Consumers that read `claudeSessionId` (resume, compaction checks, the `claudeSessionId rotated` attempt matching) now see the true id sooner. A record from another tmux session is never used, because the exact `<name>:` prefix is required.

- ClaudeKeyHealth `dead`: `syncKeyFromDisk` already calls `startTestingNewKey()`; now it happens within 60 s even if the dead timer were between ticks. Same path as before.
- ClaudeKeyHealth `suspect`: a changed key resets suspect, as `tick()` already did.
- SessionManager: `applyKey` → `setAnthropicKey`, so new spawns (including UsageLimitWatch's restarts) launch on the new key. Running sessions keep their launch key; the existing login-screen and usage-wall recovery paths own them.
- Key removed from disk while healthy: the key is cleared in memory with no notice and no kill. That is what the operator asked for, and `tick()` already behaved this way when it ran.
- A secret-store placeholder in the saved key reads as unreadable, so the key in use is kept (Config.ts guard, tested).
- The 60 s watch reads `.instar/config.json` once a minute: negligible.

## 6. External surfaces

A key saved with `set-claude-key` now takes effect without a restart in every state, which is what the command already tells the operator. One more log line per usage probe while limited.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine reads its own config file and runs its own sessions and probe. Nothing replicated changes.

## 8. Rollback cost

Revert the commit. No state format change; no migration.

## Conclusion

The pickup failure is fully explained by the key never reaching the running server, and the fix is the smallest change that makes the existing sync run on its own. Clear to ship after the second-pass read.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the artifact: concur**

Concurred, and confirmed the server wiring order, that a probe running during a key change is corrected on the next pass, that nothing new restarts or notifies in ok, suspect or dead, and that timer cleanup works. Non-blocking finding 1 (a placeholder value would wipe a working key every 60 s) is fixed in this change. Finding 2 (shutdown never calls `stop()` on either monitor) was already true and both timers are `unref`'d, so nothing changes. Finding 3 (artifact §5 additions) is done.

## Evidence pointers

- `tests/unit/usage-limit-key-pickup.test.ts`: real ClaudeKeyHealth + real UsageLimitWatch wired as server.ts does. With the sync: a working key on disk clears `limited` on the next pass, both waiting conversations restart on the new key and are answered, an equally walled new key keeps the limit and restarts nothing, no new key keeps probing the key in use. Without it: the 2026-11-07 failure reproduced. 8 of 9 fail on main, all pass with the fix.
- Live re-run 2 on nimbus (15:40-16:01 PST): key picked up and limit ended as designed. Restart missing because of the second cause; panes and transcripts read, `sessions/2326605.json` names `4ae633ea…` for `nimbus-interactive-1794095060111`.
- Same test file: the pid-record reader (exact match only; dead pid, prefix-only name, unsafe id and renamed file refused; newest wins) and the real `SessionManager.confirmSessionUsageLimit` proving a first-turn wall with no hook-reported id and binding it.
- Nimbus evidence: `.instar/vm-test/tools/liveproof-b2lead.txt` and the echo-land-four 14:53 ledger entry.

## Class-Closure Declaration (display-only mirror)

- `defectClass`: `unbounded-self-action`
- `closure`: `guard`
- `guardEvidence`: ratchet, `tests/unit/self-action-convergence.test.ts` (controller `usage-limit-session-refresh` in `src/testing/selfActionRegistry.ts`). No new controller: the change only lets the existing usage-limit restart controller recognise sessions that were walled on their first turn. Its brakes are unchanged: `decideLimitRefresh` allows at most `REFRESH_MAX_PER_DAY` = 3 restarts per conversation per rolling day, `REFRESH_BATCH` = 10 per pass, it acts only after a real probe says usage is back, and a session that walls again stops at the cap with one resend ask. The key watch applies config only; it never restarts, notifies or kills.

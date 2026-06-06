# Side Effects — lifecycle-narration-silencing

## Files touched

- `src/monitoring/SessionRecovery.ts` — `RecoveryResult` gains optional `deferred?: boolean`; the four work-check deferral returns (stall / context_exhaustion / crash / error_loop) now set `deferred: true`. No behavior change inside SessionRecovery itself (same returns, one new field).
- `src/monitoring/SessionMonitor.ts` — context-exhaustion path: (a) a deferred recovery is now SILENT to the user (log + new `monitor:recovery-deferred` event only); (b) genuine-failure notification dedups per session instance via a new `ctxNotifiedSessions` map (topicId → sessionName), cleared on successful recovery. New event added to `SessionMonitorEvents`.
- `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` — the restart-resume note is no longer delivered to the user topic (marker `RESTART_NOTE_SILENT`); the RECOVERY_AUDIT JSONL write and stderr log remain. `deliver_recovery_note()` retained for future user-actionable notes.
- `src/core/PostUpdateMigrator.ts` — stop-hook migration marker bumped `CLOCK_SEG` → `RESTART_NOTE_SILENT` so existing agents receive the silenced hook (customized hooks still untouched).
- `docs/STANDARDS-REGISTRY.md` — Near-Silent Notifications sharpened with the self-lifecycle clause + the 2026-06-06 earned-from instance (no new article; extension of the existing one, per no-bloat).

## Behavioral side effects

1. **Users stop receiving** "Session hit conversation too long…" messages when the session is actually alive (recovery deferred). This was 29+ false death reports in one day. A genuinely dead, unrecoverable session still notifies — once per death, not once per cooldown window.
2. **Users stop receiving** "my session restarted mid-run… no action needed" notes entirely. The durable record moves to `*-recovery-audit.jsonl` + stderr only.
3. **Fewer triage/respawn confusions:** sessions falsely marked `dead` by the monitor (snap.status) on deferrals stay in their true state.
4. **Migration:** every existing agent's stop-hook is overwritten at next migration run (marker bump); agents with customized hooks are skipped (existing fingerprint guard).

## Risks / blast radius

- If `hasActiveProcesses` ever returns a false positive (claims children for a dead session), the deferral-silence would suppress a legitimate death notice. Mitigation: that read already gated the kill itself (a false positive there already deferred recovery before this PR); the per-episode dedup map also resets on session-name change, so a respawned session's real death still announces.
- The `ctxNotifiedSessions` map is in-memory; a server restart clears it, so one duplicate death notice is possible across a restart. Accepted: bounded to one per restart, vs. unbounded repeats before.
- Stop-hook silencing removes the only push signal that a respawn happened; operators who relied on it must use the recovery-audit JSONL (documented in the eli16 + fragment).

## Tests

- `tests/unit/SessionRecovery.test.ts` — deferral carries `deferred: true` + does not kill; genuine recovery carries no `deferred` (2 new).
- `tests/unit/SessionMonitor.test.ts` — deferred → no sendToTopic + `monitor:recovery-deferred` emitted; genuine failure notifies once per session instance across cooldown windows; successful recovery clears the episode (3 new).
- `tests/unit/autonomous-stop-hook-notify.test.ts` — marker assertion updated to `RESTART_NOTE_SILENT`; new test asserts the restart-resume block keeps the audit write but has no user delivery and the old note text is gone.
- Existing suites: `autonomous-stop-hook-topic-keyed` (audit semantics) and `autonomous-restart-resume-lifecycle` e2e (audit count) pass unchanged — the audit behavior they assert is preserved.

# Lifecycle narration silencing — no more false death notices or restart spam

## What Changed

Two noise sources flooded user topics on 2026-06-06 (walls of messages across three
topics in one night):

1. **False "conversation too long" death notices.** SessionMonitor asks
   SessionRecovery to fix a context-exhausted session; SessionRecovery's work-check
   finds active child processes — the session is ALIVE and producing work — and
   correctly defers the kill. But it reported that deferral as a plain
   `recovered: false`, indistinguishable from a genuine failed recovery, so
   SessionMonitor posted "Session hit conversation too long… start a fresh session"
   about live sessions, once per cooldown window, indefinitely (one day's log:
   68 detections / 29+ deferrals / 0 real recoveries). `RecoveryResult` now carries
   `deferred: true` on every work-check veto; SessionMonitor says NOTHING on a
   deferral (log + internal `monitor:recovery-deferred` event only), and a genuine
   death notifies once per session instance — not once per cooldown window.

2. **Restart-resume self-narration.** The autonomous stop-hook posted "Heads up —
   my session restarted mid-run… No action needed" to the user's topic on every
   respawn — by its own text, housekeeping. It now writes only its recovery-audit
   JSONL record + stderr line. Existing agents receive the silenced hook via a
   PostUpdateMigrator marker bump (`CLOCK_SEG` → `RESTART_NOTE_SILENT`).

The Near-Silent Notifications standard gains the self-lifecycle clause: an agent
narrating its own restart/respawn, or a monitor reporting a non-actionable internal
verdict, is default-silent. Litmus test: if the message has to say "no action
needed," it must not be sent.

## What to Tell Your User

You'll stop seeing "session restarted" notes and repeated "conversation too long"
messages about sessions that were actually fine. A session that genuinely dies and
can't be recovered still tells you — once. Restart history lives in the recovery
audit log if you ever want it.

## Summary of New Capabilities

- `RecoveryResult.deferred` — recovery results now distinguish "deferred (session
  alive, work-check vetoed the kill)" from "failed (session dead)".
- New `monitor:recovery-deferred` event on SessionMonitor for observability of
  suppressed false-death paths.
- Context-exhaustion death notices dedup per session instance (episode-scoped),
  clearing on successful recovery.
- The autonomous stop-hook's restart-resume note is audit-only; existing agents
  get the updated hook automatically via the migration marker bump.
- Standards registry: Near-Silent Notifications sharpened with the self-lifecycle
  narration clause (2026-06-06 earned-from).

## Evidence

- Tier-1 unit: deferral carries `deferred:true` and does not kill; genuine recovery
  carries no flag — `tests/unit/SessionRecovery.test.ts` (11 passing). Deferred →
  silent + event; once-per-instance dedup across cooldown windows; recovery clears
  the episode — `tests/unit/SessionMonitor.test.ts` (24 passing).
- Stop-hook: marker bump asserted + restart-resume block keeps audit, loses user
  delivery — `tests/unit/autonomous-stop-hook-notify.test.ts` (11 passing).
- Audit semantics preserved: `autonomous-stop-hook-topic-keyed` unit +
  `autonomous-restart-resume-lifecycle` e2e pass unchanged.
- Full typecheck clean.

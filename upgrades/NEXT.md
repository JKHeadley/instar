# Upgrade Guide — NEXT (topic-keyed autonomous-mode session identity)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: autonomous mode no longer dies silently when a long run restarts.**

Autonomous mode keeps a session working until its job is done, enforced by the
`autonomous-stop-hook.sh` Stop hook. The hook decided "is THIS session the autonomous
worker?" by the Claude **session UUID**. A long run hits the memory limit and restarts
with a **new** UUID, but the state file still held the old one — so the hook saw a
mismatch, failed open, and let the (still-running) restarted session exit. Autonomy was
silently dead for hours until the user poked it.

The hook now keys ownership on the **topic** the session serves — a stable "address"
that survives restarts — resolved from the tmux session name via
`.instar/topic-session-registry.json` (`topicToSession`). Because `SessionRecovery`
respawns a restarted session into the **same** tmux name, the restarted session is
still recognized as the job's owner. Session-UUID matching is demoted to a
**liveness-gated backstop** for the rare case where topic resolution is unavailable
(no tmux, or the topic isn't in the registry): a UUID mismatch is resolved by checking
whether the recorded owner's transcript is still growing — a dead owner's job is
adopted, a live one is left alone.

**New: one-line recovery note on restart-resume.** When a real restart-and-resume
happens (topic verified, UUID changed), the hook writes one audit record to
`.instar/autonomous-recovery.jsonl` and best-effort delivers a single Telegram line to
the job's topic — *"Heads up — my session restarted mid-run and I've picked the
autonomous job back up. No action needed."* — exactly once per restart. A silent
self-heal would have left "recovered cleanly" indistinguishable from "died unnoticed";
the note closes that blind spot.

**Collateral fixes in the same hook:**

- **Timezone bug:** `date -j -f "...Z"` parsed UTC timestamps as local time, skewing
  duration and report-interval math by the local offset. Added `-u` to the three BSD
  date-parse callsites.
- **Pipefail fragility:** under `set -uo pipefail`, a `grep` for an absent optional
  frontmatter key (`last_report_at`) aborted the whole hook. Frontmatter reads now use a
  pipefail-safe `fm_get` helper.
- **Fail-safe expiry:** an unparseable `started_at` would inflate elapsed time and
  prematurely expire the run. The duration-expiry check now only fires when `started_at`
  parsed to a positive epoch; otherwise it logs and keeps running.

## Migration Notes

Existing agents receive the updated hook automatically. `installAutonomousSkill()` is
install-if-missing, so a dedicated idempotent migration
(`PostUpdateMigrator.migrateAutonomousStopHookTopicKeyed`) re-copies the bundled hook on
update — content-sniff guarded (skips if already topic-keyed) and stock-fingerprint
guarded (leaves customized hooks untouched). No action required.

New tuning knobs (env, optional): `INSTAR_AUTONOMOUS_LIVENESS_SECS` (backstop liveness
threshold, default 120) and `INSTAR_HOOK_TMUX_SESSION` (test/override seam for the
session's tmux name).

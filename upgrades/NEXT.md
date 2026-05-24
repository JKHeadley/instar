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
`.instar/autonomous-recovery.jsonl` and best-effort delivers a single line to the job's
owner — *"Heads up — my session restarted mid-run and I've picked the autonomous job
back up. No action needed."* — exactly once per restart. A silent self-heal would have
left "recovered cleanly" indistinguishable from "died unnoticed"; the note closes that
blind spot.

**Channel-neutral delivery.** The recovery note routes to whichever channel owns the job
(`report_channel` in the autonomous state, default `telegram`) via a `deliver_recovery_note`
seam — the hook makes no Telegram assumption. Telegram is wired now; Slack/WhatsApp/iMessage
delivery is owned by the Channel Parity initiative and is recorded to the channel-neutral
audit trail until that lands (never a silent Telegram misfire). `setup-autonomous.sh` accepts
`--report-channel`.

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

## What to Tell Your User

Autonomous mode used to go silently dead if a long run restarted mid-job — it would
just stop working and you'd only notice when you poked it. That's fixed: a restarted
session now keeps going on its own, and you get one short heads-up ("I restarted
mid-run and picked the job back up — no action needed") only when it actually happens.
Nothing to do; it's automatic, and existing agents get the fix on their next update.

## Summary of New Capabilities

- Autonomous-mode ownership is keyed on the job's **topic** (stable across restarts),
  not the session UUID — restarts no longer silently kill autonomy.
- Liveness-gated **backstop** for the rare case where topic resolution is unavailable.
- One **channel-neutral recovery note** per restart (audit trail + best-effort delivery
  to whatever channel owns the job; Telegram wired, others via the Channel Parity
  initiative).
- Idempotent migration so existing agents receive the new hook.
- Collateral: timezone fix, pipefail-safe frontmatter parsing, fail-safe duration expiry.

## Evidence

**Reproduced before fixing (RED).** A behavioral test drives the *old* hook with a
simulated memory-limit restart — state recorded under session UUID `04db2de7…`, hook
fires with a new UUID `a13495fb…` while still serving the same topic (registry maps the
topic to the session's tmux name). Observed: the old hook sees the UUID mismatch, fails
open, and returns no block decision (exit 0) — i.e. it **allows the restarted autonomous
session to exit**. That is the silent death, reproduced deterministically.

**After the fix (GREEN).** Same inputs: the hook resolves the topic from the tmux name,
matches it against the job's `report_topic`, and returns `{"decision":"block"}` — autonomy
survives. The end-to-end lifecycle test (`tests/e2e/autonomous-restart-resume-lifecycle`)
runs the real hook through bootstrap → restart (rotated UUID) → exactly one recovery note
→ dedup → completion, asserting the audit trail has exactly one restart-resume entry.

**Timezone bug** verified directly: `date -j -f "%Y-%m-%dT%H:%M:%SZ" "2026-05-23T23:44:25Z"`
returned `1779605065` (parsed as local), vs `date -u -j -f …` → `1779579865`, matching
Python's UTC epoch — a 7-hour (local-offset) skew, now corrected with `-u`.

Test tiers: 14 unit (incl. the RED→GREEN restart case + channel-seam cases), 5 migrator
integration (incl. a wiring/anti-dead-code guard), 1 e2e lifecycle — all green; 36
PostUpdateMigrator-related tests green (no regression).

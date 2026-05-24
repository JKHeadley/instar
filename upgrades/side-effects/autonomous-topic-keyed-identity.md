# Side-Effects Review — Topic-keyed autonomous-mode session identity

**Version / slug:** `autonomous-topic-keyed-identity`
**Date:** 2026-05-23
**Author:** echo
**Second-pass reviewer:** two Explore review agents (correctness + edge/race) — findings folded in below

## Summary of the change

Rewrites `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` to key autonomous-job
ownership on the **topic** the session serves (resolved from the tmux session name via
`.instar/topic-session-registry.json`) instead of the volatile Claude session UUID, so a
memory-limit restart no longer mismatches the state file and silently lets autonomy die.
Session-id matching is demoted to a liveness-gated backstop. A one-line recovery note
(durable audit + best-effort Telegram) fires exactly once per restart. Also fixes a
timezone bug, a pipefail-on-absent-field fragility, and adds a fail-safe so an unparseable
`started_at` cannot cause a premature exit. The only `src/` file touched is
`src/core/PostUpdateMigrator.ts`, which gains an idempotent migration so existing agents
receive the new hook (`installAutonomousSkill()` is install-if-missing).

## Decision-point inventory

- `autonomous-stop-hook.sh` — ownership decision (block vs allow exit) — **modify**: primary
  key changed from session-UUID to topic; liveness-gated session backstop added.
- `autonomous-stop-hook.sh` — recovery-note emission — **add**: once-per-restart side effect
  (audit write + best-effort message).
- `PostUpdateMigrator.migrateAutonomousStopHookTopicKeyed` — **add**: idempotent content
  migration, no decision/gating logic.

## 1. Over-block (trapping a session that should be allowed to exit)

- A foreign session (different topic) is explicitly allowed to exit when topic resolution is
  conclusive — covered by test T2.
- In the backstop, a session whose UUID mismatches a **live** recorded owner is allowed to
  exit (no steal) — covered by T3.
- Residual: if the registry maps `report_topic` to a tmux name that is NOT the current
  session, the current session exits — correct (it's not the owner). The only way to wrongly
  over-block is a stale registry pointing the topic at *this* session after the job moved;
  that requires the registry itself to be wrong, which is outside this hook's authority.

## 2. Under-block (allowing the real autonomous session to exit — the original bug)

- The core regression is closed: a restarted session (new UUID, same topic) blocks — T1 + the
  e2e lifecycle.
- Fail-safe added so an unparseable `started_at` no longer inflates elapsed time into a false
  duration-expiry exit (review finding; test added).
- Backstop adopts a job whose recorded owner is provably stale (dead) rather than allowing
  exit on a bare UUID mismatch (the old fail-open behavior).
- Residual: in the no-tmux backstop, a genuinely busy live owner that has not written its
  transcript for `>120s` could be judged stale and its job adopted by another fired session.
  This only matters when topic resolution is unavailable (rare for instar-spawned autonomous
  sessions, which always run in tmux), and the threshold is configurable
  (`INSTAR_AUTONOMOUS_LIVENESS_SECS`). Accepted.

## 3. Level-of-abstraction fit

Correct. Ownership resolution reads the same `topic-session-registry.json` that
`SessionManager.getTopicBinding` already uses, and the same per-session transcript that the
completion-promise check already reads. No new state store, no new service dependency — the
hook stays a self-contained bash Stop hook.

## 4. Blocking authority

- [x] Consumer of existing detectors (topic registry + transcript liveness), not a new brittle
  check with blocking authority. The hook's blocking authority is exactly the pre-existing
  autonomous-mode authority — unchanged in scope, only made restart-correct. No new gate.

## 5. Interactions

- **SessionRecovery / respawn:** relies on respawn reusing the same tmux session name (verified
  in `respawnSession(topicId, sessionName, …)`). If that contract ever changed, topic resolution
  would fail and the hook would fall back to the liveness backstop — degraded, not broken.
- **Progress-report path:** unchanged; still injects the report directive. The recovery-note
  write is independent and additive.
- **State-file mutations:** all use the existing temp-file + `mv` atomic pattern; the new
  `record_session_id` follows suit. Concurrent fires use distinct `$$`-suffixed temp files.
- **Other migrations:** `migrateAutonomousStopHookTopicKeyed` is order-independent (content-sniff
  guarded) and idempotent; it neither reads nor writes state other migrations touch.

## 6. External surfaces

- **Channel-neutral delivery:** one best-effort outbound message per restart, routed to the
  channel that owns the job (`report_channel`, default `telegram`) via a `deliver_recovery_note`
  seam. Telegram wired via `telegram-reply.sh`; other channels (slack/whatsapp/imessage) are
  owned by the Channel Parity initiative (Telegram topic 12270) and are recorded to the audit
  trail without a silent Telegram misfire. No new endpoint, no new credential use. Failure is
  swallowed (the audit record is the durable signal). The design deliberately makes no Telegram
  assumption (user caveat, 2026-05-23).
- **Filesystem:** new append-only `.instar/autonomous-recovery.jsonl` audit file (created on
  first restart-resume), carrying a channel-neutral `channel` field. No reads outside the
  project dir.

## 7. Rollback cost

Low. The hook is a single self-contained file; reverting the commit restores the prior
behavior. The migration is content-sniff guarded, so a rollback that re-ships the old bundled
hook would (on the next update) detect the topic-keyed marker absent and re-deploy the old hook
— clean. No schema, no persisted state migration, no irreversible side effect. The audit file
is additive and harmless if left behind.

## 8. Test evidence

RED reproduced first (restart-survives fails on the old hook). All three tiers green:
12 unit behavioral cases, 5 migrator integration cases (incl. wiring/anti-dead-code), 1 e2e
lifecycle. 36 PostUpdateMigrator-related tests green (no regression in the touched module).

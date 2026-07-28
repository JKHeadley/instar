# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Mentor retirement migrations.** Two idempotent `PostUpdateMigrator` methods that retire
the artifacts of the file-based mentor delivery design Justin's substrate correction
replaced (spec MENTOR-LIVE-READINESS §Migration parity):

- `migrateRetireDeadMentorConfig` removes `mentor.dailySpendCapUsd` — the dead config
  field (decorative; Echo runs on a Claude subscription, no per-token charge to cap). The
  removal is silent when the value was the default `0.5`, but LOUDLY surfaces a `REVIEW:`
  entry in the upgrade output when the operator had set a non-default value (don't repeat
  the original silent-dead-config bug at migration time).
- `migrateRetireMentorOutbox` sweeps `{stateDir}/mentor-outbox/` via
  `SafeFsExecutor.safeRmSync` — the legacy file-based mentor delivery is now dead state.

Both registered in the main migration list after `migrateLegacyMaxSessions`. Both
idempotent via the `_instar_migrations` marker.

## What to Tell Your User

- On upgrade I'll quietly sweep two leftovers from the earlier file-based mentor design — the unused dailySpendCapUsd setting and the unused mentor-outbox directory. If you had ever set the cap to a non-default value, you'll see a one-time REVIEW line in the upgrade output explaining the setting was never actually enforced (and what the real replacement is).

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Mentor retirement migrations | Automatic on update — `migrateRetireDeadMentorConfig` removes the decorative `mentor.dailySpendCapUsd` (LOUD `REVIEW:` if non-default); `migrateRetireMentorOutbox` sweeps the legacy `{stateDir}/mentor-outbox/` |

## Evidence

**Net-new groundwork, not a bug fix.** 7 new unit tests, all green: absent → skip +
marker; default `0.5` → silent delete + non-LOUD entry; non-default → LOUD `REVIEW:`
with the decorative/never-enforced/subscription explanation (proves the "non-silent
removal" invariant from the round-2 adversarial finding); idempotency; outbox-present
remove + file-count; outbox-absent graceful; outbox idempotency. `tsc --noEmit` clean.
Combined mentor-stack tests across the staged build now 57, all green.

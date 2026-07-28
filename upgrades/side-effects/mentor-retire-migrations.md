# Side-Effects Review — mentor migrations (retire dead config + outbox) (PR 3c-3)

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Migration parity (the
"dailySpendCapUsd silent removal is a quiet config break" round-2 adversarial finding +
the legacy file-outbox cleanup). PR 3 of the staged build, part c-3.
**Change:** Two new `PostUpdateMigrator` methods that retire the artifacts of the
file-based mentor delivery design Justin's substrate correction replaced. Both
**idempotent** via the `_instar_migrations` marker. Registered in the main migration
list right after `migrateLegacyMaxSessions`.
**Files:** `src/core/PostUpdateMigrator.ts` (+2 methods + 2 registrations),
`tests/unit/PostUpdateMigrator-mentor-retire.test.ts` (new, 7).

## What changed

1. **`migrateRetireDeadMentorConfig`** — removes `mentor.dailySpendCapUsd`:
   - field absent → silent skip (mark set so we don't re-check).
   - field present at the default `0.5` → silent delete (operator never changed it).
   - field present at a NON-default value → delete + LOUD `result.upgraded` entry with
     `REVIEW:` prefix explaining the field was decorative (never enforced — Echo runs on
     a Claude subscription) and the future replacement is `mentor.stageBTokenCeiling`.
     This is exactly the "non-silent removal" the spec's round-2 adversarial finding
     required: don't repeat the silent-dead-config bug at migration time.
2. **`migrateRetireMentorOutbox`** — removes `{stateDir}/mentor-outbox/` via
   `SafeFsExecutor.safeRmSync`:
   - present → recursive remove + record file-count in `result.upgraded`.
   - absent → mark + skip (so subsequent runs are no-ops).
   - failure → log to `result.errors` + do NOT mark (retry on next run).

## The seven questions

1. **Over-block.** N/A — both are removal-only migrations; nothing is over-blocked.
2. **Under-block.** Both are idempotent via the `_instar_migrations` marker; corrupt or
   missing config.json early-exits with a `result.errors`/`result.skipped` entry rather
   than crashing the migration pass.
3. **Level-of-abstraction fit.** Each method does ONE thing, modeled exactly on
   `migrateLegacyMaxSessions` (the established pattern for value-patching migrations) +
   uses `SafeFsExecutor.safeRmSync` for the destructive filesystem op (the project's
   established funnel for that). No new infrastructure.
4. **Signal vs authority.** N/A.
5. **Interactions.** Both run during the normal `PostUpdateMigrator.migrate()` pass
   (between `migrateLegacyMaxSessions` and `migratePrPipelineArtifacts`). They touch
   `config.json` and `{stateDir}/mentor-outbox/` only — both project-owned paths. The
   `_instar_migrations` marker pattern is unchanged. Existing tests for other
   migrations are unaffected.
6. **External surfaces.** None new. Both surface their actions via the standard
   `result.upgraded` / `result.skipped` / `result.errors` arrays the migrator already
   uses (visible in the post-update output the operator sees).
7. **Rollback cost.** Trivial — revert removes the two methods + their registration.
   The retired data is forward-only; restoring an old `dailySpendCapUsd` or an old
   `mentor-outbox/` directory by hand is possible if absolutely needed (but unlikely —
   neither was actually working).

## Testing

7 new unit tests, all green:
- **dailySpendCapUsd retirement**: field-absent silent skip + marker; default `0.5`
  silent delete + non-LOUD upgraded entry; **non-default value LOUD `REVIEW:` upgraded
  entry** with the "decorative / never enforced / subscription / token-ceiling
  replacement" explanation (proves the "non-silent removal" invariant); IDEMPOTENT
  (second run is no-op skip).
- **outbox retirement**: present-directory removed + file-count recorded; IDEMPOTENT
  marker means subsequent runs skip; directory-absent handled gracefully (no error,
  marker set).

`tsc --noEmit` clean. Combined mentor-stack tests across the staged build (PRs 1, 2a,
2b, 3a, 3b, 3c-1, 3c-2, 3c-3) = **57 tests, all green**.

## Migration parity

These ARE the migrations from the spec's §Migration parity. The new MentorConfig fields
(`botToken`, `menteeBotId`, `menteeChatId`, `menteeTopicId`) added in PR 3c-1 are
optional + default undefined, so no additive migration is needed for them — they appear
only when the operator (or PR 3c-4's `/mentor/bot-setup` flow) sets them.

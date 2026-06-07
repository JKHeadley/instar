<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

instar now manages Claude Code's transcript retention (`cleanupPeriodDays`), setting it to
14 days for new agents (init) and existing agents (migration, set-if-unset). Claude writes a
transcript per session — including every fleet background `claude -p` one-shot — and the
unset default of 30 days let them accumulate (observed ~322k files / 18 GB on one box). This
caps the pile-up fleet-wide.

## What to Tell Your User

Nothing required — internal disk hygiene. Chat transcripts older than 14 days are pruned by
Claude automatically; recent ones (and the ability to resume them) are unaffected. If you set
your own retention period, it is left as-is.

## Summary of New Capabilities

- `.claude/settings.json` `cleanupPeriodDays` is now instar-managed (default 14; set-if-unset).

## Scope (honest)

Pure disk/file-count hygiene, NOT a CPU fix — transcripts were already Spotlight-excluded.
Tunable per-agent; reversible.

## Evidence

`tests/unit/PostUpdateMigrator-cleanupPeriodDays.test.ts` 4/4; adjacent migrateSettings suites
27/27; `tsc` clean.

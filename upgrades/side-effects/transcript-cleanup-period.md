# Side effects — transcript cleanup-period (cleanupPeriodDays)

## Change

Sets `cleanupPeriodDays: 14` in `.claude/settings.json` — for new agents (init.ts) and
existing agents (`PostUpdateMigrator.migrateSettings()`, set-if-unset).

## Behavioral surface

- **New behavior**: Claude Code now prunes chat transcripts under `~/.claude/projects`
  older than 14 days (was the unset default of 30). Caps the per-fleet transcript pile-up.
- **What does NOT change**: nothing about runtime sessions, hooks, MCP, or the server. This
  is a Claude Code client setting only. Recent transcripts (≤14d) are untouched, so active
  and recently-idle sessions keep full `--resume` support.

## Migration / compatibility

- Migration is **set-if-unset** (`settings.cleanupPeriodDays === undefined`) — an operator's
  explicit value (including `0` = no cleanup) is never overwritten. Idempotent.
- No config-schema change, no API, no state. Reversible by editing settings.json.

## Risk

Low. Worst case: a conversation left idle 14–30 days loses its Claude `--resume` transcript;
instar's CONTINUATION mechanism reconstructs context across such gaps, so the conversation
still resumes. Tunable up per-agent if any agent needs longer retention.

## Tests

`tests/unit/PostUpdateMigrator-cleanupPeriodDays.test.ts` (4/4): set-when-absent, no-override-7,
respect-explicit-0, idempotent. Adjacent migrateSettings suites green (27/27). `tsc` clean.

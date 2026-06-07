# Transcript cleanup-period — ELI16

> One line: Claude Code keeps a log file for every session it ever runs, and on a
> machine running a whole fleet of agents those logs pile up into hundreds of thousands
> of files. Claude already deletes ones older than 30 days — this just tells it to keep
> 14 days instead, so the pile stays small. One setting, fleet-wide.

## The problem (2026-06-07)

Claude Code writes a transcript (`~/.claude/projects/<proj>/<session>.jsonl`) for every
session — including every background `claude -p` one-shot a fleet agent fires (sentinels,
gates, extractors). It auto-deletes transcripts older than `cleanupPeriodDays` (default 30
when unset). On one dogfooding box this reached **~322,000 files / 18 GB**, of which ~289k
were 7–30 days old — i.e. within the default retention window, just sheer volume from the
fleet's background activity.

instar did not manage `cleanupPeriodDays` at all, so every agent silently ran the 30-day
default.

## What this changes

Sets `cleanupPeriodDays: 14` in `.claude/settings.json`:
- **New agents** — written into the initial settings.json at `init`.
- **Existing fleet** — `PostUpdateMigrator.migrateSettings()` sets it on update, **only when
  the key is unset** (an operator's hand-tuned value is never overwritten; a nullish guard
  means an explicit `0` — Claude's "don't clean" value — is also respected).

14 days keeps ample `--resume` headroom (and instar's CONTINUATION mechanism reconstructs
context across longer gaps), while halving the worst-case pile-up.

## Why it's safe / honest scope

- It is NOT a CPU fix. The transcripts were already excluded from Spotlight, and the box had
  no Time Machine — so they were never a macOS-activity trigger. This is pure disk/file-count
  hygiene.
- Set-if-unset + nullish guard → idempotent, and never clobbers an operator's choice.
- Tunable per-agent (just edit settings.json). Reversible.

## Evidence

`tests/unit/PostUpdateMigrator-cleanupPeriodDays.test.ts` — sets 14 when absent; does NOT
override 7; respects explicit 0; idempotent (no re-report on second pass). 4/4 green. Adjacent
migrateSettings tests (autonomous-hook-path, migration-parity ×2) still green (27/27). `tsc` clean.

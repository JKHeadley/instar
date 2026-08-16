# Side-effects review — PostUpdateMigrator bracket close fix

**Version / slug:** `post-update-migrator-bracket-fix`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — single-syntax-fix; no behavior change.
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (Rule 2 — provider-portability v1.0.0 migration recording).

## Summary

The `migrateProviderPortability` method shipped with an unclosed try/catch + missing method-close `}` between the `result.errors.push(...)` line and the next `// ── Fleet watchdog` comment. Local typecheck happened to clear during merge-resolution because of a stale dist/, but the source file's CI Type Check (`tsc --noEmit` from clean) failed at `src/core/PostUpdateMigrator.ts#238` with `TS1128: Declaration or statement expected.` and cascaded into every unit-test shard via ts-jest compilation.

Fix: add the missing `}` (close catch) + `}` (close method) before the fleet-watchdog comment block. No behavior change.

## Decision-point inventory

- **Bracket close** — `change`. Pure syntax repair; restores the v1.0.0 migration's intended structure.

## Signal vs authority

CI Type Check is structural authority. Fix unblocks the gate; no new gates introduced.

## Over-block / under-block analysis

**Over-block:** None. The previous broken syntax aborted compile; nothing else was affected by it semantically.
**Under-block:** None. The migration's intended guard (try/catch on config write) is now actually a try/catch.

## Rollback cost

Zero — reverting the two braces would re-introduce the syntax error.

## Verification

- `npx tsc --noEmit` — exit 0 locally.
- CI Type Check re-runs on push.
- Unit-test shards expected to pass once tsc compiles.

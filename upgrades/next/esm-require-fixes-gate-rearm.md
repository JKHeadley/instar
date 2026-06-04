# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Fixed three latent ESM `require()` bugs and re-armed the two standards-gates that
should have caught them.** Instar ships as ESM (`"type":"module"`, tsconfig Node16),
where a bare CommonJS `require(...)` is undefined and throws `ReferenceError` the
moment that line runs. Three runtime files had one on a live path:
`reflect.ts` (hit by `instar reflect run`), `SessionWatchdog.ts` (the stuck-session
watchdog's child-detection), and `PostUpdateMigrator.ts` (Codex-path detection — it
silently returned null instead of throwing).

The fix uses the repo's existing `createRequire(import.meta.url)` idiom for the first
two (same lazy load, now ESM-legal), and for `PostUpdateMigrator.ts` simply calls the
`detectCodexPath` it was already statically importing (the lazy require was redundant).

These bugs reached `main` because the `esm-compliance` and `no-silent-fallbacks`
gates — whose entire job is catching this class of issue — had been parked in
`vitest.push.config.ts`'s flaky-exclude list, so CI stopped running them. This change
re-arms both (taught `esm-compliance` to recognize the one legitimate ESM use of
`require` — `createRequire`, needed to re-load a native module after a rebuild) and
corrects the `no-silent-fallbacks` baseline to the true count.

## What to Tell Your User

A few features that could have thrown a runtime error on a rarely-hit path — job
reflection, the stuck-session watchdog, and Codex detection during updates — are now
fixed. Two safety checks that had been accidentally switched off in CI are switched
back on, so this class of bug can't quietly return. Nothing for you to configure.

## Summary of New Capabilities

- Three latent ESM require() ReferenceErrors repaired (reflect, SessionWatchdog,
  PostUpdateMigrator) using the established createRequire idiom or an existing static import.
- The esm-compliance and no-silent-fallbacks CI gates are re-armed (removed from
  FLAKY_TESTS), restoring enforcement of two standards that had silently stopped gating.

## Evidence

- `tsc --noEmit` clean across the three source edits.
- Re-armed gates verified green under the REAL CI config:
  `vitest run --config vitest.push.config.ts tests/unit/esm-compliance.test.ts tests/unit/no-silent-fallbacks.test.ts`
  → 2 files / 7 tests passed.
- Baseline correction is evidence-backed: the heuristic count at d0fe838 (the
  `[skip ci]` release that set 186) was already 431; at HEAD it is 437; a set-diff of
  the two match-lists shows the +6 are the same catch blocks at shifted line numbers,
  not new silent fallbacks.

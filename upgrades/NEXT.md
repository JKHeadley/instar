# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fleet-wide guardrail outage fix: 8 of `PostUpdateMigrator`'s `get*Hook()` methods were emitting `.js` content with bare top-level `require(...)`, which throws `ReferenceError: require is not defined in ES module scope` in every `"type":"module"` agent home (most agents). The crashes exited non-blocking, so the failures were invisible — guardrails looked installed but did nothing. One of the affected was the UnjustifiedStopGate router itself — the very mechanism designed to prevent silent stalls was silently broken.

This release rewrites all 8 affected generators to emit ESM-safe content (async IIFE + dynamic `await import('node:...')`, mirroring the documented pattern in `getHookEventReporterScript`), and adds a one-shot regression test that bans bare top-level `require(...)` from any future generated hook — CI will fail before the bug class can re-ship.

`migrateHooks` always-overwrites `instar/` hooks, so the fix ships to every agent automatically on next update — no separate migration step needed.

## What to Tell Your User

- Eight quiet guardrails (the silent-stall preventer, the slop-package nudger, the post-commit reflection capture, the response-review pipeline, and four others) come back to life on this update — they were silently crashing on every fire and we just learned about it.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| ESM-safe instar hooks (8 generators rewritten) | Automatic on update; no action needed |
| Regression test banning bare top-level `require(...)` in any generated hook | Runs in CI; new hook PRs fail if they reintroduce the pattern |

## Evidence

- Source rewrites in `src/core/PostUpdateMigrator.ts`; regression test in `tests/unit/no-bare-require-in-generated-hooks.test.ts` (18 cases, all green; initially 8 failed, one per broken generator).
- Side-effects review: `upgrades/side-effects/esm-safe-instar-hooks.md`
- Spec: `docs/specs/ESM-SAFE-INSTAR-HOOKS-SPEC.md` (approved, converged)
- ELI16: `docs/specs/ESM-SAFE-INSTAR-HOOKS-SPEC.eli16.md`
- Postmortem context: surfaced by the 2026-05-27 silent-stall incident.

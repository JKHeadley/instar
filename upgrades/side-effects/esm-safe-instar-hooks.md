# Side-Effects Review — ESM-Safe Instar Hook Generators + Structural Prevention

**Spec:** docs/specs/ESM-SAFE-INSTAR-HOOKS-SPEC.md (pending Justin's approval)

Fixes the fleet-wide silent-guardrail outage discovered 2026-05-27: 8 of `PostUpdateMigrator`'s `get*Hook()` methods emit `.js` content with bare top-level `require(...)`, which crashes on every fire in `"type":"module"` agent homes (most agents). The crashes are invisible (non-blocking exit), so the guardrails *look* installed but do nothing. One of the affected guardrails is the UnjustifiedStopGate router itself — the very mechanism meant to prevent silent stalls was itself silently broken.

## What changed
- `src/core/PostUpdateMigrator.ts` — rewrote 8 `get*Hook()` generators to emit ESM-safe content (async IIFE + dynamic `await import('node:...')`, mirroring the documented pattern in `getHookEventReporterScript`): `getStopGateRouterHook`, `getSlopcheckGuardHook`, `getPostActionReflectionHook`, `getScopeCoherenceCollectorHook`, `getScopeCoherenceCheckpointHook`, `getClaimInterceptHook`, `getResponseReviewHook`, `getClaimInterceptResponseHook`.
- `tests/unit/no-bare-require-in-generated-hooks.test.ts` — NEW. Source-scans `PostUpdateMigrator.ts`, extracts each `get*Hook()` body's backtick-template, and asserts no forbidden top-level `require(...)` pattern. One test per generator (18 cases total). Structurally bans the bug class from re-shipping.

## Over-block / under-block
- UNDER (a real `.js` script needing legitimate top-level `require`): the test scans only inside `get*Hook` method bodies in `PostUpdateMigrator.ts`. Non-hook code elsewhere is untouched. Standalone hook .js files in `src/templates/hooks/` are also untouched.
- OVER (a legitimate use of `require` inside a hook): there isn't one — every instar hook ships into `.instar/hooks/instar/` in agent homes that are ESM by default. Bare top-level `require` is broken there. Dynamic `await import(...)` works in both CJS and ESM hosts; there is no scenario where the new pattern is wrong.

## Signal vs authority
- The regression test is the AUTHORITY (CI fails on a violation). The generator rewrites are the SUBSTANTIVE FIX (run in production). Together they form a complete loop: the rewrites unblock the fleet; the test makes the unblock permanent.

## Interactions
- `migrateHooks` always-overwrites instar/ hooks (existing standard) → the fixed generators automatically ship on every agent's next update. No new migration code required.
- No change to hook contracts (stdin JSON in, exit code semantics, stdout JSON out).
- No config or settings changes.

## Rollback cost
- Trivial: revert both files. Worst case: agents return to the silently-broken state they had before.

## Tests
- `tests/unit/no-bare-require-in-generated-hooks.test.ts` (18) — one test per generator (15+ healthy generators plus three sanity-check tests). Initially failed 8/18 (one per broken generator), all green after the source fix.
- Runtime smoke (manual, performed during diagnosis): the fixed hook content for `stop-gate-router`, `slopcheck-guard`, and `post-action-reflection` was piped a representative JSON payload on real ESM-mode hardware and exited cleanly (no `ReferenceError`). The same rewrite pattern applied to the other 5 generators.

## NOT in this commit (tracked, follow-up specs)
- Postmortem Finding #3 — notify-on-stop wiring (Task 2 of the autonomous run).
- Postmortem Finding #2 — false-blocker behavioral interceptor (Task 3).
- Postmortem Finding #4 — Agent Self-Propagation harness, CMT-560 (Task 4).

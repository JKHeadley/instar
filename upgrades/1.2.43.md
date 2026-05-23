# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**feat(dev): e2e-pairing pre-commit gate — GSD cherry-pick.**

New pre-commit gate (`scripts/check-e2e-pairing.cjs`, wired into `.husky/pre-commit`) that blocks any commit changing a non-test `src/server/*.ts` file unless it also stages at least one `tests/e2e/*.test.ts`. Structurally enforces the Tier-3 "feature is alive" discipline that CLAUDE.md calls the single most important test for any feature with API routes.

From the GSD-Instar spike, where the gsd-planner methodology surfaced that the Topic Intent Layer's Tier-3 lifecycle test would have been forgotten under ad-hoc planning. This gate makes "ship a route without an e2e test" structurally hard rather than discipline-dependent.

Two escape hatches keep it from being tyrannical: env bypass (`INSTAR_SKIP_E2E_PAIRING=1`) and an `E2E-PAIRING: EXEMPT — <reason>` marker in a staged server file (for genuine refactors / type-only / comment changes).

This governs instar's OWN development commits (it's in instar's `.husky/`), not agent-installed files — so no migration parity needed.

## Evidence

8 unit tests, all green (tmp-git-repo harness): passes with no server files, blocks server-without-e2e, passes server-with-e2e, ignores server test files + .d.ts, respects env bypass + EXEMPT marker, blocks when only an unrelated unit test is staged. TypeScript clean.

Verified the gate does not block this very PR (this PR changes scripts/ + .husky/ + tests/, not src/server/).

Side-effects review: `upgrades/side-effects/e2e-pairing-gate.md`.

## What to Tell Your User

Nothing user-visible. Internal dev-discipline gate for instar contributors.

## Summary of New Capabilities

One new pre-commit gate script + one line in .husky/pre-commit. Signal-with-commit-authority (blocks), with two escape hatches. Errs toward false positives because a route shipped without an e2e test is the corruption-class failure being defended against.

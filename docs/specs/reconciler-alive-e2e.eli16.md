# ELI16 — Add the missing Tier-3 feature-alive E2E for the ownership reconciler

## What this is, in plain English

The cross-machine "stuck move" fix (the ownership reconciler) shipped with unit tests
and integration tests, but it never got the THIRD kind of test the project's Testing
Integrity Standard requires for every feature with API routes: a "Tier-3 feature-alive"
end-to-end test. That tier answers one blunt question — *when you actually start a real
server, is the feature reachable and does it work, or does its API route return 503
because something wasn't wired up?*

This change adds exactly that test for the reconciler: it starts a real `AgentServer`
with the reconciler wired in, then over real HTTP (with auth) it checks that
`GET /pool/reconciler` returns **200, not 503**, that it reports it can see both
machines, and — most importantly — that the reconciler **actually converges**: it ticks
once and the topic that was pinned to the other machine gets handed off (marked
"transferring" toward the pin target), and the live status route reflects that transfer.

## Why this matters (and why it was missing)

The reconciler is the feature that closes the cross-machine stuck-move bug. Its earlier
"boot-ordering" defects — where the reconciler was never even constructed at server boot,
so its route returned 503 on real machines — slipped past the unit and integration tests
because those construct the reconciler by hand. They were caught only by a live
two-machine run. A feature-alive E2E is the standing category of test that catches
"the dependency wasn't wired" defects. The reconciler simply didn't have one, so this
adds it (mirroring the existing `pool-placement-transfer-alive` E2E).

## What's new

One new test file: `tests/e2e/pool-reconciler-alive-lifecycle.test.ts` (4 tests). No
runtime/source code changes at all — this is test-only coverage that completes the
three-tier requirement (unit + integration + e2e) for the reconciler fix.

## The safeguards, in plain terms

- **Test-only.** It changes no shipping behavior; it can only make CI stricter, never
  weaken it. Rollback is deleting one file.
- **Honest scope.** It wires `AgentServer` directly (like its sibling E2E tests), so it
  proves the route + the convergence are alive end-to-end. It deliberately does NOT claim
  to re-run `server.ts`'s exact boot sequence; the boot-ordering construction itself is
  covered by the reconciler unit tests' late-bound-dependency regression cases. The test
  comment states this plainly so no future reader over-trusts it.

## What you need to decide

Nothing risky. This is additive test coverage that closes the missing Tier-3 tier for an
already-shipped, already-proven fix. Merge it and the reconciler has all three test tiers.

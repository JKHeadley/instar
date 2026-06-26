# Verify-After Topic Reachability — core components (F7)

**Slug:** `verify-after-reachability` · **Maturity:** 🧪 Preview (core components; not yet wired) · **Audience:** agent-only

## What Changed

Lands the two pure, tested core components of postmortem fix F7 (Blast-Radius /
Verify-After): `SpawningTopicsRegistry` (a token-tagged, ABA-safe replacement for the
closure-local spawn-guard Set — `add` returns a token, `clear` is token-guarded, no
timeout/sweep so the `.finally` stays the sole clearer; `stuckSinceMs` exposes in-flight
age) and `TopicReachabilityVerifier` (a pure-signal decision core that, given a
reachability probe, surfaces a genuine orphan as ONE NORMAL attention item — with the
reachable-honesty guard, grace/coalescing, flap backoff, burst roll-up, and
pressure/emergency-stop skip + re-sweep). Both mutate nothing; neither is wired into the
running server yet (inert at runtime). The server integration (live probe + triggers +
dev-gate flag + status route + guard registration + the inbound-path registry refactor)
is the tracked next increment.

## What to Tell Your User

Nothing yet — this lands internal building blocks for the "did I just break the door?"
reachability check (postmortem fix #7). They are not wired into the running agent in this
change, so there is no user-visible behavior change. The user-facing heads-up surfaces in
the follow-up that wires them in.

## Summary of New Capabilities

- None at runtime in this change — two new internal components (a token-safe spawn-guard
  registry and a pure-signal reachability verifier) land under test, inert until the
  follow-up integration wires them into the server.

## Evidence

- `spawningTopicsRegistry.test.ts` (5): ABA token-guard; `.finally` sole clearer (no
  timeout/sweep); stuck-age seam.
- `topicReachabilityVerifier.test.ts` (8): grace; reachable-honesty (no false orphan on a
  topic that self-heals); orphan→one NORMAL item; pressure/halt skip + re-sweep; flap
  backoff; burst roll-up; coalescing.
- `tsc --noEmit` clean.
- Side-effects: `upgrades/side-effects/verify-after-reachability.md`.
- Spec (converged + approved): `docs/specs/verify-after-reachability.md`.

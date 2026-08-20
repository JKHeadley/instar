---
user_announcement:
  - audience: developer
    maturity: stable
---

## What Changed

The Testing Integrity standard now has a blocking executable kernel. Every added or
materially changed direct HTTP route is derived from production TypeScript and must carry
Tier-3 evidence that the guard executes itself through a real AgentServer. A test file or
route-shaped string is no longer enough: the request must complete with the asserted live
2xx response, never 503, and the concrete request path must match the declared route.

The guard fails closed when it cannot inspect the source tree, resolve the fleet base,
parse a route or evidence file, run the evidence test, or acquire execution proof. Its
population is code-derived and non-empty, with no exemption marker, bypass setting, or
growable allowlist. Callers cannot supply the comparison base: the guard queries the
hard-coded canonical fleet URL for the server-advertised protected `main` SHA and computes
the merge base from that identity, ignoring mutable local tracking refs.

## What to Tell Your User

Changes to HTTP routes now bring their live production-path test with them automatically.
If a route is added or materially changed without proof that it is alive, the normal code
checks stop the change before it can merge.

## Summary of New Capabilities

- Derive the direct HTTP-route population from production code.
- Require and execute route-specific Tier-3 evidence for changed routes.
- Execute `ALL` declarations with an explicit concrete request method.
- Refuse missing, empty, unreadable, malformed, skipped, or dead-on-arrival evidence.
- Refuse caller-selected bases and unverified protected-main refs.

## Evidence

- Unit controls cover nested route discovery, empty and malformed populations,
  symbol-preserving handler hollowing, missing execution proof, and matching proof.
- A Tier-3 lifecycle test boots a real AgentServer, drives its ping route through the
  canonical evidence helper, and verifies the emitted observation.
- The guard is mutation-tested against delete, executable-comment-out, and superstring
  export rename sabotages before release.

## Known Limits

- This enforces the mechanically derived direct-route and Tier-3 kernel. It does not claim
  that the prose word “significant” has been resolved for non-route features, nor that
  historical routes or Tier 1 and Tier 2 completeness have been certified.

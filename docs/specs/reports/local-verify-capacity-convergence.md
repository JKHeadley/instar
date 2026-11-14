# Convergence report — local-verify-capacity (a second verifier machine)

**Spec:** `docs/specs/local-verify-capacity.md` · **Reviewer:** Codex (`codex exec --sandbox read-only`, GPT-6 Astra), a model family other than the author's · **Gemini:** unavailable on the Studio (`gemini-not-authed`; tracked as ACT-150) · **Claude clean-door reader:** attempted, degraded (`error`), not counted.

## Rounds

| Round | Verdict | Findings | What changed |
|---|---|---|---|
| 1 | NOT-CONVERGED | 11 (4 blockers) | Batching found unsound (a member can merge without the others it was tested with; withdrawal cannot undo a merge) and worth ~1.2× at the measured 80% pass rate → Part C rejected for v1 and the operator asked to ratify dropping it. Peer design rewritten: attempt ids, lease-epoch fencing, peer-readable routes, bounded attempts, restart and lease-move rules, the peer named a merge-authorizing principal. |
| 2 | NOT-CONVERGED | 5 | Reserved entries excluded from local selection/refresh/derivation; immutable dispatched snapshot; `unknown` reclaim in any state with peer tombstones and orphan reaping; import by outcome (errors not recorded); busy as backpressure, breaker only for real failures; no promotion of peer attempts on a lease move. |
| 3 | NOT-CONVERGED | 1 | Dispatch now refreshes the entry's base (the existing conditional refresh) before reserving it, then re-checks everything. |
| 4 | **CONVERGED** | 0 | "No material findings remain in Part D." |

## What the design does, in plain words

A second machine (the Mac Mini) can run single pull-request test runs that the Studio hands it. Each hand-off carries a one-time id. The Studio accepts the result only if it answers exactly that hand-off, tested exactly what was handed over, ran the same verifier code and rules, and the Studio is still the machine in charge at the same lease epoch. Anything else is thrown away and the pull request stays in the Studio's line. A hand-off that goes quiet is reclaimed after a bounded time, each pull request is tried remotely at most twice, and a misbehaving peer is skipped for 30 minutes. Batching (testing several pull requests in one run) was rejected for now: unsafe as drafted and worth little at today's pass rate.

## Residual risks, stated

- The peer is trusted like the Studio itself: a compromised peer could forge a passing result. This is the pool's existing trust boundary, not a new one.
- Wall-clock checks (`started-before-dispatch`, run bounds) assume the pool's clocks are within minutes; the pool already raises clock-skew alarms.

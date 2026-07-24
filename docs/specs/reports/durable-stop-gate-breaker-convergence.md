# Convergence Report — Durable Stop-Gate Breaker

## Cross-model review: codex-cli:gpt-5.5

The spec received repeated independent GPT-family review through Codex. Gemini
3.1 Pro was detected and invoked twice, but returned no review payload; this is
recorded as a degraded secondary external door, not counted as a clean opinion.
The internal perspective pass was completed against security, scalability,
adversarial, integration, decision-completeness, and lessons/foundation concerns;
the local Claude CLI returned no payload, so those perspectives were synthesized
by the author and then contested by the independent Codex passes.

## ELI10 Overview

The Stop gate correctly lets a turn end when its model judge is too slow, but its
memory-only circuit breaker forgets every software restart. A still-slow provider
therefore gets a fresh retry budget after each release. The live agent accumulated
179 identical timeout feedback records across more than eighty versions.

The converged design stores the breaker’s count, cooldown, and one-probe lease in
the existing local Stop-gate database. Restarts retain the bound; provider-route
changes get a new key; credential repairs either wait at most five minutes or use
an authenticated reset. The existing fail-open judgment direction does not
change. The shared loop-safety standard and convergence ratchet also gain a
restart-survival invariant, so this failure class is structurally guarded.

## Original vs Converged

The first draft persisted a singleton count/deadline and tested one reconstruction.
Review changed it materially: routing-key isolation; atomic `BEGIN IMMEDIATE`
failure transitions; a bounded half-open lease with stale-token protection;
explicit clock clamps; lock-failure telemetry; multiple restart positions plus a
restart storm; exhaustive transition cases; status/suppression observability;
bounded old-row retention; explicit reset after credential/provider repair; and a
precise fail-open exception grounded in the existing authority standard.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|---|---|---:|---|
| 1 | Codex security/integration | 6 | Synchronous hydration, atomic transitions, repeat-restart proof, routing key. |
| 2 | Codex concurrency/operations | 5 | Half-open lease, retention, durable status, clock posture, fixture contract. |
| 3 | Codex standards/integration | 6 | Named fail-open exception, exact fingerprint, SQLite boundary, transition matrix. |
| 4 | Codex operations | 5 | 50ms lock budget, durable precedence, clock cases, multi-position restarts. |
| 5 | Codex foundation | 5 | Semantic-invalid breaker coverage, guardian-pulse lifecycle, fixed-cooldown rationale. |
| 6 | Codex scalability | 6 | Provider repair/reset, local-store performance proof, approximate off-path counters. |
| 7 | Codex clarity/governance | 5 | Supported concurrency, credential-generation rationale, terminology, explicit ratification. |
| 8 | Decision comparator | 0 | No material new finding; wording-only precision folded into final text. |
| 9 | Codex clarity/operations | 5 minor | Clock table, durable Guardian signal, route-key recovery tradeoff, explicit zero-I/O open path, earlier terminology. |
| 10 | Codex operability/clarity | 5 minor | Per-path timing table, actionable open-status UX, existing-controller rationale, bounded counter key, route terminology clarified. |

Standards-Conformance Gate: unavailable because the running server’s authenticated
spec-review endpoint was not reachable from this isolated worktree; the full
registry and signal-vs-authority source were supplied directly to every successful
external pass. This is disclosed rather than represented as a gate pass.

## Full Findings Catalog

- Hydration race and lost concurrent increments: resolved with synchronous
  construction, atomic transactions, and durable-state precedence.
- Restart survival too narrow: resolved with five close/reopen cycles,
  parameterized 25/50/75-percent reconstruction, and per-tick restart pressure.
- Concurrent half-open herd/crash: resolved with an atomic bounded lease and
  matching-token settlement.
- Route/config repair: resolved with a stable routing fingerprint, explicit key
  examples, five-minute automatic probe, and authenticated reset.
- Durable-state growth and privacy: resolved with a finite closed routing-key
  space and metadata-only rows excluding credentials, content, identities, and release version.
- Stop-hook latency: resolved with one-time hydration, no normal-path read, 50ms
  busy bound, local-store performance test, and contained memory fallback.
- Transport-success ambiguity: resolved by resetting only after a usable validated
  authority result; semantic-invalid output retains its failure kind and advances
  the unusable-authority breaker.
- Long-outage visibility: resolved through persistent-open guardian-pulse review,
  breaker status fields, and an approximate off-hot-path suppression counter.
- Standard/class scope: resolved by upgrading No Unbounded Loops and the existing
  self-action convergence ratchet instead of adding an instance-only test.

## Convergence verdict

Converged at iteration 10. The final comparison produced no material new issue,
all user decisions are frontloaded, and the spec is explicitly approved for the
delegated class-review/standard-upgrade lane.

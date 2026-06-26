# Convergence Report — Interactive Priority Lane for the Host Spawn Cap (F5)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex-cli, gpt-5.5) AND a Gemini-tier pass
(gemini-cli, gemini-2.5-pro) ran on every round where the spec body changed.
Round-1 surfaced material findings via the internal panel; rounds 2–3 ran both
external families. Final external verdicts: codex `MINOR ISSUES`, gemini
`MINOR ISSUES` (round-3) — all non-material clarity/operational refinements,
folded into the converged spec. This spec received genuine cross-model review.

## ELI10 Overview

The agent has a hard ceiling on how many AI "thinking" subprocesses run at the
same instant (default 8) — a safety cap that exists because a runaway once
spawned hundreds at once and crashed a machine out of memory. The problem the
postmortem found: that cap treated the user's own reply as equal to background
self-chatter, so under load the user's message lost its place in line and got
held — the crash-protection became the reason the user got silence.

This spec teaches the cap one distinction it lacked: a couple of the 8 slots are
reserved so the user's messages (their reply going out, and their message coming
in, including "stop everything") always have room, and a couple are reserved for
background safety checks so giving the user priority can't starve the watchdogs
either. The total of 8 never changes — it only decides *who gets which of the 8*.
When off (the default for everyone but the dev agent), behavior is byte-identical
to today.

The main tradeoffs: it adds two config knobs and lane logic to a safety-critical
component (real complexity, acknowledged — the longer-term fix is to unify onto
one priority queue, tracked as a follow-up); and reserving slots for the user
means a sustained background load is throttled to its guaranteed floor (loud and
counted, never silent).

## Original vs Converged

The original spec had the right core idea (reserve headroom within the existing
cap, no preemption) but review found a **blocking hole and ~12 material gaps**:

- **Blocking:** the original missed that the wrapper sheds callers at a SECOND,
  lane-blind gate (the "too many waiters" cap) *before* they ever reach their
  reserved slot — so under the exact incident conditions an interactive reply
  would still be turned away. The converged spec makes that ingress lane-aware
  (interactive fast-path first + a carve-out of the waiter budget, never raising
  the total).
- **Trust:** the original relied on "remember not to tag the fan-out as
  high-priority." The converged spec enforces it with a code allowlist + a CI
  lint + a test pinning the allowlist's membership (the very fan-out that caused
  the original crash can't inherit priority).
- **Safety floor:** the converged spec makes normative that a corrupt "lane"
  value can NEVER drop a holder (which would under-count and erode the OOM
  ceiling) — classification is equality-only, fail-safe to background.
- **Honesty:** the original over-claimed "safe in both directions" for mixed-
  version rollouts and "jumps the queue." The converged spec states precisely
  that the cap is always guaranteed but the *priority* is best-effort until all
  co-resident agents upgrade, and that the mechanism is a concurrency *floor*,
  not queue-jumping.
- **Decisions frontloaded:** the second tagged callsite, the `/spawn-limiter`
  response shape, the exact clamp algorithm (pinned to the runtime-resolved cap),
  and the flag mechanism were all under-specified originally and are now pinned.
- **Observability:** added effectiveness counters + a *coalesced* loud event on
  any interactive shed (an interactive shed IS an F5 recurrence — it must never
  be silent, but also must not self-amplify under the saturation it reports).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | lessons-aware, adversarial, scalability/integration, decision-completeness, conformance-gate (2) | 1 blocking + ~12 material | Comprehensive rewrite: lane-aware ingress (§B), structural allowlist+lint (§A), under-count safety rules (§E), emergency-stop decision (§A.1), clamp algorithm pinned to resolved-N (§F), precise guarantee restated (§D), mixed-version honesty (§E), effectiveness metrics (§G), /spawn-limiter shape (§G), prune-frees-headroom invariant+test (§C), flag-mechanism decision (§F), constitutional-traceability anchor, Migration-Parity + Agent-Awareness |
| 2 | lessons-aware, adversarial, codex, gemini, conformance-gate | 0 blocking, 2 medium + lows | `synchronousReply` spec'd as real wiring (§A.1); waiter accounting pinned as carve-out + right-sized (§B); DegradationReporter coalesced + counters labeled local-process (§G); ri/rb `>=0` resolution + lazy-singleton defaults + clamp-reshape log (§F); allowlist honesty + membership test (§A); emergency-stop residual documented (§A.1); "why not unify queues" rationale (C5); wiring-integrity test |
| 3 | convergence-confirm (internal), codex, gemini, conformance-gate | 0 material | Two text-consistency nits (joint waiter gate; ri/rb pseudocode); end-to-end layer invariant; bounded-loop brakes stated; operator-inbound burst bound; complexity acknowledged |

## Full Findings Catalog

**Round 1 (blocking + material):**
- [BLOCKING] Lane-blind waiters cap sheds interactive before reserve → §B lane-aware ingress. RESOLVED.
- [MATERIAL] Interactive signal convention-only → §A allowlist+lint. RESOLVED.
- [MATERIAL] Garbage lane could drop holder → under-count → erode OOM ceiling → §E normative rules. RESOLVED.
- [MATERIAL] Lane counts must be over pruned set, same critical section → §C. RESOLVED.
- [MATERIAL] Clamp must be deterministic, pinned to resolved-N, permit 0 → §F. RESOLVED.
- [MATERIAL] Emergency-stop / operator-inbound under-specified + possibly regressed → §A.1 (MessageSentinel on allowlist). RESOLVED.
- [MATERIAL] "jumps the queue" overclaim → §D concurrency-floor. RESOLVED.
- [MATERIAL] Mixed-version "safe both directions" overstated → §E best-effort-reserve note. RESOLVED.
- [MATERIAL] Observability gauges-only, no effectiveness metrics → §G counters. RESOLVED.
- [MATERIAL] /spawn-limiter shape, flag mechanism, config defaults under-specified → §F/§G. RESOLVED.
- [MATERIAL] Migration-Parity + Agent-Awareness obligations unaddressed → House-standard section. RESOLVED.
- [conformance] Constitutional-traceability (umbrella standard unregistered) → anchored to registered standards. RESOLVED.

**Round 2 (medium + low):**
- [MEDIUM] `synchronousReply` asserted to exist but doesn't → §A.1 spec'd as fail-safe new wiring. RESOLVED.
- [MEDIUM] interactiveWaiters additive (64→72) → §B carve-out, total stays waitersMax; right-sized to 4. RESOLVED.
- [MEDIUM] DegradationReporter per-shed → self-amplification/notification-DoS → §G coalesced. RESOLVED.
- [LOW] ri/rb inheriting `>0` filter would strip legit 0 → §F `>=0`. RESOLVED.
- [LOW] lazy getHostSpawnSemaphore() path defaults → §F. RESOLVED.
- [LOW-MED] allowlist "by construction" absolutism + membership growth → §A honesty + membership test. RESOLVED.
- [LOW-MED] emergency-stop shares lane / compromised channel → §A.1 documented residual. RESOLVED (documented, follow-up tracked).
- [conformance] Wiring-integrity tests for DI component → added to test matrix. RESOLVED.

**Round 3 (minor/clarity, all folded):**
- Joint waiter-admission gate phrasing; ri/rb pseudocode alignment; end-to-end layer invariant; bounded-loop brakes stated; operator-inbound retry-burst bound; complexity acknowledged. ALL FOLDED.

## Convergence verdict

Converged at iteration 3. The internal convergence-confirmation reviewer returned
CONVERGED ("the design is sound, complete, and buildable"); both external families
returned only non-material MINOR refinements, which were folded in. The OOM safety
floor (`liveTotal < N`) is byte-identical and never gated; every subdivision is a
carve-within-ceiling; the disabled state is byte-identical-to-today; every
fail-safe direction (un-wired → background, garbage lane → background, non-`true`
enabled → off) is uniform. Spec is ready for user review and approval.

## Open questions

*(none — all resolved into the spec; no live user-decision remains.)*

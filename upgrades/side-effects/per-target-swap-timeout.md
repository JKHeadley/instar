# Side-Effects Review — Per-Target Failure-Swap Timeout (fixes gemini-swap-timeout)

**Version / slug:** `per-target-swap-timeout`
**Date:** `2026-07-02`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `required — the change modifies timeout resolution on the failure-swap path that serves GATING calls (the tone gate rides it)`

## Summary of the change

The IntelligenceRouter failure-swap loop used ONE global per-attempt timeout (`intelligence.swapAttemptTimeoutMs`, default 5s) for every swap target. Measured provider latency (llm-pathway-bench, N=30) shows gemini's p50 is ~8.5s — the 5s cap sits BELOW gemini's median, so gemini as a swap target was reliably killed before it could answer, wasting a full swap slot ("poisoning the failover tail"). This change makes the cap resolvable PER TARGET FRAMEWORK (`intelligence.swapAttemptTimeoutMsByFramework`), adds a per-attempt clamp (`swapAttemptTimeoutMsMax`, invalid/unset ⇒ 120s), and adds an optional wall-clock TOTAL swap budget (`swapTotalBudgetMs`) that clamps each in-flight attempt to the remaining budget on a MONOTONIC clock, bounding the whole fail-closed tail to literally ≤ budget. All three fields default UNSET — routing/timeout behavior is byte-identical to today until an operator opts in (dark ship). Files touched: `src/core/IntelligenceRouter.ts` (resolveSwapCap, withSwapTimeout, per-target loop resolution, unknown-key hygiene), `src/core/types.ts` (three optional config fields), `src/commands/server.ts` (threads the three fields), `tests/unit/per-target-swap-timeout.test.ts`, `tests/integration/per-target-swap-timeout.test.ts`, spec + ELI16 + convergence report under `docs/specs/`. Spec: `docs/specs/per-target-swap-timeout-spec.md` (review-converged 2026-07-01, approved).

## Decision-point inventory

- `IntelligenceRouter failure-swap loop` (`src/core/IntelligenceRouter.ts` `evaluate()`) — **modify** — a routing/degrade path (which fallback provider gets how long), NOT a block/allow gate. No new gate is introduced or removed; the swap still fires only for `attribution.gating`/`deferrable` calls with configured `failureSwap` targets (scope unchanged). What changed is only HOW LONG each target is given (per-target vs one flat cap) and a new optional total-budget stop that falls CLOSED (the safe direction for gating calls).
- `Gating ladder deadline` (`gatingLadderBudgetMs`) — **pass-through** — still checked first at each loop iteration, unchanged.

**Phase 1 principle-check answer (recorded):** the change touches a decision point only in the routing/degrade sense — it does not gate information flow by content, block actions by meaning, or filter messages. Timeout resolution is deterministic mechanics (a wall-clock bound on a subprocess attempt), in the signal-vs-authority carve-out class of structural/transport mechanics, not a judgment decision. No brittle check gains blocking authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

At the default (all three fields unset): none — resolution degenerates to exactly today's single global cap; the regression tests assert the 5s behavior byte-for-byte (same cap value passed through as `timeoutMs`, same fail-closed rethrow).

When an operator opts in: two deliberate "rejections" exist and both are the spec's explicit fail-SAFE choices, not accidents. (a) A `swapTotalBudgetMs` set below the 250ms floor disables swapping on the first attempt — an absurd misconfig fails CLOSED (no swap) rather than open (unbounded swap). (b) When the remaining budget is ≤ 250ms, a viable fast target later in the tail is NOT admitted — the loop falls closed. Both are unit-tested. A per-framework value that is invalid (0, negative, NaN, non-number) can never over-block: it falls through to the global, never to "no cap" and never to a 0ms instant kill (FD5, tested for every invalid class).

---

## 2. Under-block

**What failure modes does this still miss?**

- **The dark default does not fix the field bug.** Gemini keeps dying at 5s until an operator sets the recommended values — this is the spec's own "ships-inert" finding. Mitigation is a DELIVERY obligation (FD8): surface the recommended values as a one-tap go/no-go and track the opt-in as a commitment (registered: CMT — see Conclusion). Tracked, not silently dropped.
- **A provider that ignores `timeoutMs` can overrun its cap as an orphaned subprocess.** The `Promise.race` timer still resolves the swap decision at the cap (the loop advances on time), but the subprocess kill is the provider's own responsibility — unchanged by this change and already true of the existing global cap (spec: provider timeout contract).
- **Operator misconfig within valid ranges:** a per-target cap set above the circuit breaker's failure sensitivity could keep a chronically-slow target alive without tripping the breaker; a slow target ordered FIRST in `failureSwap` delays faster ones up to its cap (order is latency-load-bearing). Both are documented operator constraints in the spec and the types.ts JSDoc — static caps remain blind to live latency drift by design (auto-tuning is explicitly out of scope, FD3 <!-- tracked: CMT-1889 -->).

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The failure-swap loop in `IntelligenceRouter` is the ONLY place that owns swap-attempt timing, and the change modifies exactly that resolution point (cap resolution moved inside the per-target loop). It does not re-implement any primitive: it reuses the existing `Promise.race` pattern (now wrapped in `withSwapTimeout`, which only adds timer-clear-on-settle), the existing `timeoutMs` provider pass-through contract, and the existing `onDegrade` observability channel (`swap-attempt-timeout:` reason format preserved byte-for-byte so DegradationReporter/metrics consumers are unaffected). The config lives in the existing `intelligence` block alongside the global cap it extends. No higher layer (LlmQueue, circuit breaker, gating ladder) owns per-attempt timing; no lower layer duplicates it.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The change has no judgment-based block/allow surface: it is timeout mechanics on a routing/degrade path (the signal-vs-authority carve-out class: structural bounds, not content judgment). The one nuance — acknowledged in the spec's foundation note — is that a static cap holds kill-authority over whether a provider ATTEMPT survives, blind to real latency; that mis-fit is the root shape of the original incident. This change REDUCES the mis-fit (caps sized per target to measured p50/p95) without adding any new authority, and the residual (static caps can drift from live latency) is explicitly flagged as a recurrence vector for the auto-tuning follow-up (FD3, out of scope <!-- tracked: CMT-1889 -->). Timed-out attempts still count toward the per-framework circuit breaker (unchanged), so the breaker — the existing authority over provider health — keeps its signal supply.

---

## 5. Interactions

- **Shadowing:** the gating-ladder deadline (`gatingLadderBudgetMs`) is checked FIRST at each loop iteration, before the new budget check — an active ladder still wins (unchanged precedence). The new total budget only ADDS a stop; it cannot extend the ladder's deadline. Verified in code order.
- **Double-fire:** the per-attempt timer and the provider's own `timeoutMs` SIGTERM fire at the SAME bound (the cap is passed through as `timeoutMs`, exactly as before) — by design, not a race: the race timer decides the swap, the subprocess bound kills the process. The budget-clamped cap keeps them identical (the clamped value is what flows through).
- **Races:** `withSwapTimeout` preserves the shipped crash-safe `Promise.race` semantics (per-input settlement handlers; late reject swallowed, late resolve ignored — both re-covered by the existing N1 tests, which still pass unmodified). The only addition is `clearTimeout` in a `finally`, which cannot race the rejection (a fired timer's clear is a no-op).
- **Feedback loops:** timed-out swap attempts still count toward the target's circuit breaker (unchanged), so a chronically-timing-out target still trips its breaker and gets skipped fast on later calls — no new loop. The spec documents the operator constraint that caps SHOULD stay ≤ the breaker's failure sensitivity.
- **Config layering:** the three new fields ride `IntelligenceRouterOptions`, NOT `ComponentFrameworksConfig` — so the §4.6 computed-default/live-override layering in `resolveConfig` is untouched (verified: the layered-resolveConfig tests pass unmodified).

---

## 6. External surfaces

- **Other agents / install base:** none until opt-in — all three fields default unset and there is no `migrateConfig` entry (absence is the default state, codexExecJson precedent), so no deployed agent's config changes on update.
- **External systems:** none. No new network calls, no new subprocess kinds — only how long an existing swap subprocess is given.
- **Persistent state:** none. Per-call resolution from live opts; no ledger, no file, no store.
- **Timing/runtime conditions:** the budget uses a MONOTONIC clock (`performance.now()`), never `Date.now()`, so an NTP step/DST jump cannot warp it (round-3 external finding; the gating-ladder's existing `Date.now()` deadline is unchanged — out of this change's scope). Observability: a cap firing emits the same `swap-attempt-timeout:` degrade reason as today (format preserved), visible in DegradationReporter and `/metrics/features`.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action is added — the knobs are config fields. The FD8 delivery obligation (one-tap go/no-go for the recommended values) is where the operator surface will live; it is a tracked commitment (see Conclusion), deliberately outside this spec's code change per the approved spec.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard/approval/grant/revoke/secret-drop file is staged; the change is config + router internals + tests).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** (spec FD4). The swap cap is a per-call routing parameter read from each machine's local config at call time. It holds no durable cross-machine state (nothing to strand on topic transfer), emits no user-facing notice (no one-voice gating needed), and generates no URL (nothing to survive machine boundaries). Each machine's providers have that machine's latency characteristics, so per-machine values are the correct scope; an operator who wants uniform values sets them per machine's config. No replication path needed.

---

## 8. Rollback cost

Pure code change with a dark default — two independent rollback levers, both cheap:

- **Operator-level (instant, no release):** remove the `swapAttemptTimeoutMsByFramework` / `swapAttemptTimeoutMsMax` / `swapTotalBudgetMs` block from `.instar/config.json` → instant revert to the global-cap behavior (spec: "Rollback: remove the config block → instant revert").
- **Code-level:** revert the commit, ship as next patch. No persistent state, no data migration, no agent state repair, no user-visible regression during the rollback window (the default path is byte-identical for routing/timeout semantics; the only internal difference is the timer-clear-on-settle hygiene, which is behavior-neutral for routing).

---

## Conclusion

The review confirms the change is a localized, additive, dark-shipped modification of the failure-swap timeout resolution with no new block/allow authority, no persistent state, no external surface until opt-in, and a two-lever rollback. The design decisions that the review leaned on hardest — FD5 (invalid per-framework values fall through to the global, closing the accidental-uncap footgun), FD6 (the total budget clamps each IN-FLIGHT attempt so the tail is literally ≤ budget, and falls CLOSED at the floor), FD7 (maxCap clamp + validated knobs + timer hygiene) — are all unit-tested on both sides of every boundary (valid vs each invalid class). Two items are flagged, both already tracked: (1) the FD8 delivery obligation (the dark ship fixes nothing until the operator opts in — the recommended-values go/no-go + commitment is registered as CMT-1889 and is delivery work outside this spec's code change per the approved spec); (2) static caps remain blind to latency drift — the auto-tuning follow-up <!-- tracked: CMT-1889 --> (FD3) rides the same tracked commitment's context. Clear to ship pending second-pass concurrence (required: the change sits on the path that serves gating calls).

---

## Second-pass review (if required)

**Reviewer:** claude (independent second-pass subagent)

**Independent read of the artifact: concur** — Verified against the working-tree diff (`src/core/IntelligenceRouter.ts`, `src/core/types.ts`, `src/commands/server.ts`) and all 56 tests (25 + 3 new; the 11 + 17 pre-existing pass unmodified): the code matches the spec's resolveCap contract exactly (isFinite && >0 validation, byFramework→global→undefined fall-through, maxCap clamp with invalid→120s default, in-flight `min(cap, remaining)` budget clamp on `performance.now()`, 250ms-floor fall-closed, budget-unset ⇒ no enforcement), no brittle check gains blocking authority (the unknown-key check is warn-once signal-only; the budget stop is a deterministic resource bound in the signal-vs-authority carve-out class), and the ladder-deadline-before-budget precedence, breaker counting, Promise.race crash-safety, finally-clause timer clear, and `swap-attempt-timeout:` prefix format are all true in the code as claimed — with one non-blocking precision note: the "byte-identical at default for ANY global cap" claim is overbroad for the exotic-but-JSON-reachable case of a pre-existing `swapAttemptTimeoutMs > 120000`, which the (spec-mandated, FD7-intended) default maxCap now clamps to 120s even with all three new fields unset — a fail-safe-direction change worth knowing in forensics, not a ship blocker.

---

## Evidence pointers

- Unit: `tests/unit/per-target-swap-timeout.test.ts` (25 tests — resolveSwapCap contract incl. every invalid class, the gemini 8.5s fix + 5s regression, FD6 budget in-flight clamp/floor/unset/invalid/uncapped-bound, FD7 timer clear, wiring incl. server threading scan, unknown-key warn-once).
- Integration: `tests/integration/per-target-swap-timeout.test.ts` (3 tests — server-exact wiring: the FD8 recommended-values package serves gemini at 8.5s under an 18s cap; no-config and absent-intelligence-block regressions pin the 5s global byte-for-byte).
- Pre-existing behavior locked: `tests/unit/provider-fallback-swap-timeout.test.ts` (11 tests) and `tests/unit/intelligence-router.test.ts` (17 tests) pass UNMODIFIED against the new code.
- Tier-3 carve-out: no HTTP route is added (internal routing-timeout knob), so per the Testing-Integrity Standard's no-route carve-out there is no "feature-alive/200" e2e; Tiers 1 + 2 apply (stated in the spec's Testing section).
- Measured basis: llm-pathway-bench N=30 (gemini p50 8,538ms / p95 15,726ms; claude ~3s/~6s; pi ~4.6s/~7s; codex ~18s/~43s).

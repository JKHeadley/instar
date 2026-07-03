---
title: "Per-Target Failure-Swap Timeout"
slug: "per-target-swap-timeout"
author: "echo"
eli16-overview: "per-target-swap-timeout.eli16.md"
review-convergence: "2026-07-01T03:50:54.264Z"
review-iterations: 3
review-completed-at: "2026-07-01T03:50:54.264Z"
review-report: "docs/specs/reports/per-target-swap-timeout-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 2
contested-then-cleared: 1
approved: true
approved-by: "justin (blanket pre-approval, autonomous run topic 29723, 2026-07-01)"
parent-principle: "No Silent Degradation to Brittle Fallback"
parent-principle-fit: "The failure-swap engine (IntelligenceRouter.failureSwap for gating calls) IS this standard's in-practice mechanism — swap provider before failing closed, never silently degrade. A swap target whose natural latency exceeds the flat 5s cap (gemini p50 8.5s) can structurally NEVER succeed: the swap looks protective while being fake-protective for that target, the exact fake-safety failure mode the standard names. Per-target caps sized to measured latency make the mandated provider-swap genuinely viable; the total budget keeps the standard's other arm (fail closed, bounded) honest."
---

# Spec — Per-Target Failure-Swap Timeout (fixes gemini-swap-timeout)

**Status:** draft (pre-spec-converge) · **Origin:** llm-pathway-characterization project, R4 finding.
**Ships:** dark/reversible, config-gated, additive — default behavior byte-identical to today.

## Problem statement

`IntelligenceRouter` failure-swap uses ONE global cap `swapAttemptTimeoutMs` (default 5000ms,
`server.ts` `config.intelligence?.swapAttemptTimeoutMs ?? 5000`). Each swap attempt races this cap
and passes it to the target as `timeoutMs` (subprocess SIGTERMs at the bound).

**Measured (llm-pathway-bench, N=30, uncontended):** gemini-flash p50 = 8,538ms, p95 = 15,726ms.
The 5s cap is BELOW gemini's median, so whenever gemini is a swap target it is killed at 5s before
it can answer on the majority of attempts — it reliably wastes a full 5s swap slot then fails
("poisoning the failover tail"). Other targets have different natural speeds too (claude ~3s p50 /
~6s p95, pi ~4.6s / ~7s, codex ~18s / ~43s), so a single cap cannot fit all.

## Fix

Make the swap cap resolvable PER TARGET FRAMEWORK, with an explicit validation contract, a
per-attempt clamp, AND a total swap-budget ceiling that bounds the fail-closed tail.

### `resolveCap` — exact contract (addresses validation / zero-is-falsy / byte-identical findings)

```
# isValid(x) := typeof x === 'number' && Number.isFinite(x) && x > 0

resolveCap(target, globalCap, byFramework, maxCap):
  perTarget = byFramework?.[target]
  candidate = isValid(perTarget) ? perTarget : (isValid(globalCap) ? globalCap : undefined)
  if candidate === undefined: return undefined            # no cap (today's behavior when global ≤0/unset)
  effMax = isValid(maxCap) ? maxCap : 120000              # maxCap itself validated; invalid → default 120s
  return Math.min(candidate, effMax)                      # per-attempt clamp (never exceeds maxCap)

# At each swap-loop iteration, the EFFECTIVE cap also honors the remaining total budget:
attemptCap(target, ...):
  cap = resolveCap(target, globalCap, byFramework, maxCap)
  if swapTotalBudgetMs is set (isValid):                  # unset ⇒ no budget enforcement (semantics unchanged)
    remaining = swapTotalBudgetMs - elapsedSinceFirstSwap
    if remaining <= 250: STOP loop, fall closed           # too little budget left to bother (fixed 250ms floor)
    cap = (cap === undefined) ? remaining : min(cap, remaining)   # budget bounds even an un-capped attempt
  pass `cap` as the attempt's timeoutMs (undefined ⇒ no timer, only when no cap AND no budget)
```

- **Monotonic clock (round-3 external finding):** `elapsedSinceFirstSwap` MUST be a MONOTONIC elapsed
  time (`performance.now()` / `process.hrtime`), NOT `Date.now()` — a wall-clock jump (NTP step, DST)
  must not make the budget spuriously short or long. `swapTotalBudgetMs` validation is `isFinite && >0`;
  a value `< 250` passes validation but simply disables swapping on the first attempt (fail-SAFE — an
  absurd misconfig fails closed, never open).
- **Provider timeout contract:** passing `cap` as `timeoutMs` bounds the attempt only if the provider
  HONORS `timeoutMs` as a hard subprocess deadline (the existing CLI providers SIGTERM at the bound;
  see the codex process-group-kill note in the pathway-characterization findings). A provider that
  ignores `timeoutMs` could overrun — the `Promise.race` timer still resolves the swap decision at the
  cap, but the orphaned subprocess is the provider's own kill-path responsibility (unchanged by this spec).

- **Validation is uniform and total:** a per-framework value that is `0`, negative, `NaN`,
  `Infinity`, or a non-number is INVALID and FALLS THROUGH to the global (never "no cap", never an
  immediate-0ms kill, never a `NaN`→`setTimeout` instant-fire). Selection uses a presence + `typeof`
  guard, **never `||`** (the zero-is-falsy lesson) — but note the deliberate design choice in FD5:
  per-framework CANNOT express "unbounded" (only the global's ≤0/unset does), which closes the
  accidental-uncap footgun the reviewers flagged.
- **Per-attempt clamp:** the resolved cap is clamped to `maxCap` (`swapAttemptTimeoutMsMax`, default
  120000ms) so a huge/typo'd value cannot create an effectively unbounded subprocess that pins a
  host spawn-cap slot.

### Bounding the fail-closed tail (total swap budget) — addresses the ~85s reachability finding

Per-target caps remove the old uniform `cap × (1+tail)` ceiling; a naive Σ of the recommended values
is ~85s, which would hold a gating call (e.g. the tone gate → a user's outbound message) that long
before failing closed — a reachability regression. Fix: a wall-clock **total swap budget**
`swapTotalBudgetMs` that bounds the WHOLE swap tail, made truly load-bearing (round-2 finding):

- **The budget clamps each in-flight attempt, not just the loop gate.** The effective cap for each
  attempt is `min(resolvedCap, budgetRemaining)` where `budgetRemaining = swapTotalBudgetMs − elapsedSinceFirstSwap`.
  Checking the budget only BEFORE each attempt is insufficient — an attempt admitted at
  `budget − ε` would still run its full per-target cap, so worst-case would be `budget + maxCap`
  (~150s at defaults), NOT `≤ budget`. Clamping each attempt to the remainder makes the ceiling
  literally `≤ swapTotalBudgetMs`. If `budgetRemaining` is ≤ a small floor (e.g. 250ms — too little
  time to be worth an attempt), the loop stops and falls closed.
- **The budget DEFAULTS UNSET (dark, truly byte-identical).** With `swapTotalBudgetMs` unset there is
  NO total-budget enforcement — behavior is byte-identical to today for ANY existing `failureSwap`
  configuration (including >6 targets, a high custom global cap, or legacy unbounded router
  construction). The budget engages ONLY when the operator sets it. The operator SHOULD set it
  alongside the per-framework caps (recommended `swapTotalBudgetMs: 40000`); the recommended-values
  block ships them together as one opt-in (FD8), so the reachability guarantee and the per-target
  caps arrive as a package, never a partial config that regresses the tail.
- So: per-target caps tune each attempt; `swapAttemptTimeoutMsMax` clamps any single attempt; the
  total budget (when set) bounds the whole tail — three layers, all off by default.

### Change surface (localized, additive)
- `types.ts`: add optional `intelligence.swapAttemptTimeoutMsByFramework?: Partial<Record<IntelligenceFramework, number>>`
  (typed to the framework union so an unknown/misspelled key is a compile-time smell; a stray key at
  runtime simply falls through to global — no effect, logged as an unknown-key warning), plus
  optional `intelligence.swapAttemptTimeoutMsMax?: number` and `intelligence.swapTotalBudgetMs?: number`.
- `IntelligenceRouter` opts: add the three fields above.
- `server.ts`: thread all three from `config.intelligence?.*` into the router opts (alongside the
  existing `swapAttemptTimeoutMs`). The global still threads as `?? 5000`.
- `IntelligenceRouter` swap loop: move cap resolution INSIDE the `for (const target ...)` loop —
  `const cap = resolveCap(target, this.opts.swapAttemptTimeoutMs, this.opts.swapAttemptTimeoutMsByFramework, maxCap)`
  — build `attemptOptions`/the timeout from the per-target `cap`, and check the total-budget before
  each attempt. **Clear the timeout timer on settle** (a `withTimeout(promise, cap, label)` helper
  that clears the timer in a `finally`) so a fast success does not leak a pending timer (codex-review
  finding: avoidable timer churn under many calls).

### Backward compatibility (dark/reversible) — precise
- All three new fields default UNSET. With them unset, `resolveCap` returns the global
  `swapAttemptTimeoutMs` (server-threaded as `?? 5000`) for every target, the per-attempt clamp is a
  no-op (maxCap defaults 120s ≫ 5s), and there is NO total-budget enforcement (`swapTotalBudgetMs`
  unset) — so the **routing/timeout semantics are unchanged under the default config** for ANY existing
  `failureSwap` config (any target count, any global cap, legacy unbounded router construction). The
  one internal difference is the timer-clear (clearing the `setTimeout` on settle) — a desirable
  cleanup with no user-facing routing effect, though timer lifecycle / event-loop liveness differ
  internally (so "byte-identical" is scoped to routing/timeout behavior, not literally every internal
  effect). No `migrateConfig` needed (additive optional config; absence preserves current).
- Recommended values (documented, operator opts in — NOT a shipped default, to keep the ship dark):
  `swapAttemptTimeoutMsByFramework = { "claude-code": 8000, "pi-cli": 9000, "gemini-cli": 18000, "codex-cli": 45000 }`
  (each ≥ measured p95 with margin; codex lowered 50000→45000 to sit under a sane total budget), with
  `swapTotalBudgetMs` raised to e.g. 40000 if the operator wants the full tail. Caps SHOULD stay ≤ the
  circuit breaker's failure threshold so a chronically-slow target still trips the breaker rather than
  being kept alive indefinitely (see Safety). Setting these is the actual fix; shipping the mechanism
  is this spec.
- **Ordering matters:** the swap loop is sequential, so `failureSwap` target ORDER is latency-load-
  bearing (a high-cap target early blocks faster later ones up to its cap or the budget). Operators
  SHOULD order `failureSwap` fastest-first; cap ≠ priority. Documented so mis-ordering is a known knob.
- Rollback: remove the config block → instant revert to the global cap.

## Safety / invariants preserved
- **The fail-closed tail is bounded by the TOTAL BUDGET (when set), including in-flight attempts.**
  Because each attempt's effective cap is `min(resolvedCap, budgetRemaining)`, the worst-case swap-tail
  latency is `≤ swapTotalBudgetMs` — literally, not "up to a per-target cap over." (Round-2 finding:
  gating the budget only BEFORE each attempt left a `budget + maxCap` overrun; clamping each attempt to
  the remainder closes it.) When `swapTotalBudgetMs` is UNSET (the dark default), there is no total-budget
  ceiling and behavior is byte-identical to today. Note: user-visible latency ALSO includes the primary
  attempt up to its own provider/circuit behavior BEFORE the swap tail — the budget bounds only the swap
  tail, which is what this change affects.
- **Per-attempt clamp** (`swapAttemptTimeoutMsMax`, default 120s) bounds any single attempt, so a
  huge/typo'd cap cannot create an effectively unbounded subprocess that pins a host spawn-cap slot.
- **Cap vs circuit breaker:** a per-target cap set ABOVE the breaker's failure threshold could keep a
  chronically-slow-but-eventually-succeeding target answering so the breaker never opens. Guidance:
  caps SHOULD stay ≤ the breaker's failure sensitivity; timed-out swap attempts still count toward the
  breaker (unchanged). Documented as an operator constraint on the recommended values.
- **Host spawn-cap interaction:** larger caps hold a host-wide spawn semaphore slot (fork-bomb ceiling,
  default 8) up to ~10× longer than the old 5s. Under concurrent gating load this reduces effective
  throughput; the total budget is the primary mitigation, and very-slow frameworks (codex) SHOULD be
  ordered last / capped conservatively so they don't hold slots during a burst.
- The `Promise.race` crash-safe pattern is unchanged (per-input settlement handler; late reject/resolve
  handled); the added `withTimeout` helper only CLEARS the timer on settle (no behavior change). The
  cap still flows to the subprocess as `timeoutMs`. Only `attribution.gating` calls with configured
  `failureSwap` targets are affected (unchanged scope).
- **Signal-vs-Authority (foundation note):** a static cap holds kill-authority over whether a provider
  answers, blind to real latency — the root shape of the original incident. Static per-target caps
  reduce the mis-fit but can still recur on operator misconfig or latency drift; auto-tuning from live
  latency (FD3, out of scope) is the eventual calibration. The misfit itself is a signal, not fully
  resolved — noted as a recurrence vector for the follow-up. <!-- tracked: CMT-1889 -->

## Testing (per Testing-Integrity Standard — Tier-3 carve-out justified)
This change adds NO HTTP route (it is an internal routing-timeout knob), so per the Testing-Integrity
Standard's no-route carve-out there is no Tier-3 "feature-alive/200" e2e — Tiers 1 + 2 apply. Stated
explicitly rather than claiming "all three tiers."
- **Unit — `resolveCap`:** per-framework valid value used; per-framework present-but-INVALID (0, -1,
  NaN, Infinity, "18000" string) FALLS THROUGH to global (not no-cap, not immediate-fire); unknown
  key falls through to global; unset map → global; global ≤0/unset → undefined; resolved cap clamped
  to `maxCap`. (Both-sides: valid vs each invalid class.)
- **Unit — total budget clamps in-flight attempts:** with `swapTotalBudgetMs` set, an attempt admitted
  near the budget edge gets an effective cap of `min(resolvedCap, budgetRemaining)` (NOT its full cap) —
  assert the worst-case tail is `≤ swapTotalBudgetMs`, and the loop falls closed when remaining ≤ 250ms.
  Regression: `swapTotalBudgetMs` UNSET → no budget enforcement, tail identical to per-cap-only behavior.
- **Unit — value validation:** an invalid `swapAttemptTimeoutMsMax` (0/NaN/negative) → 120s default; an
  invalid `swapTotalBudgetMs` → treated as unset (no enforcement).
- **Unit — timer clear:** a fast success clears the pending timeout timer (no leaked timer).
- **Unit (wiring):** router opts carry all three new fields; server threads them from config.
- **Integration:** primary throws, gemini swap target with an 18s cap + an 8.5s-latency stub → swap
  SUCCEEDS (previously timed out at 5s). Regression: no per-framework config → identical to the
  existing single-cap integration test.

## Ships-inert mitigation (Close the Loop — addresses "the field bug isn't fixed until opt-in")
Because the ship is dark (empty default), gemini keeps dying at 5s until an operator sets the values —
a dark ship that is never turned on is deferral = deletion. <!-- tracked: CMT-1889 --> So Fix-A DELIVERY (not just this spec)
MUST: (1) surface the recommended `swapAttemptTimeoutMsByFramework` values to the operator as a
one-tap go/no-go (per "operators act in taps, not text"), AND (2) register a tracked commitment so the
opt-in is followed through, not merely made possible. The spec ships the mechanism; the delivery
closes the loop.

## Surface note (Agent Awareness Standard)
No dashboard tab, no CLAUDE.md-template capability, no agent-facing API — this is an internal tuning
knob, so no Agent Awareness template update is required. Stated to preempt the standard's question.

## Out of scope
- Auto-tuning caps from live latency (future). This ships static, operator-set caps.
- Changing the DEFAULT cap value or shipping the recommended map as a default (would be behavioral →
  separate go/no-go; this spec keeps the ship dark).

## Decision points touched
- **Modifies** the failure-swap timeout resolution in `IntelligenceRouter` (a routing/degrade path,
  NOT a block/allow gate). No new block/allow gate is introduced or removed.
- The swap only fires for `attribution.gating` calls with configured `failureSwap` targets — scope
  unchanged. This spec changes only HOW LONG each target is given, per-target vs one flat cap.

## Frontloaded Decisions
- **FD1 — Default remains the current global cap (dark ship).** `swapAttemptTimeoutMsByFramework`
  ships UNSET; with it unset behavior is byte-identical to today (global `swapAttemptTimeoutMs ?? 5000`).
  The recommended per-framework values are documented for the operator to opt into, NOT shipped as a
  default. Rationale: keep the ship dark/reversible; changing the effective default is a separate
  behavioral decision. (Reversible: it's config; empty map = today.)
- **FD2 — Resolution order is fixed:** `byFramework[target]` → global `swapAttemptTimeoutMs` →
  undefined (no cap). Deterministic, no ambiguity.
- **FD3 — No auto-tuning.** Caps are static operator-set values this round. Live-latency auto-tuning
  is explicitly out of scope (future spec). Cheap-to-change-after: the mechanism is additive config;
  auto-tuning can layer on later without reworking this.
- **FD4 — Multi-machine posture: machine-local BY DESIGN.** The swap cap is a per-call routing
  parameter read from local config at call time; it holds no durable cross-machine state, emits no
  user-facing notice, and generates no URL. Each machine reads its own config. No replication needed.
- **FD5 — Invalid/zero/negative per-framework value semantics (the load-bearing new decision).** A
  per-framework value takes effect ONLY if `typeof === 'number' && Number.isFinite && > 0`; any other
  value (0, negative, NaN, Infinity, non-number, or an unknown/misspelled key) FALLS THROUGH to the
  global cap — it NEVER means "no cap" and NEVER produces an immediate-0ms kill. Deliberate consequence:
  per-framework config CANNOT express "unbounded for this target" (only the global's ≤0/unset does) —
  this closes the accidental-uncap footgun. Selection uses a presence + `typeof` guard, never `||`.
- **FD6 — Bound the fail-closed tail with a total budget that clamps EACH attempt (not just the loop
  gate).** `swapTotalBudgetMs` DEFAULTS UNSET (no enforcement ⇒ byte-identical to today for any existing
  config, including >6 targets / high global cap / legacy unbounded router construction — the round-2
  backward-compat finding). When SET, each attempt's effective cap is `min(resolvedCap, budgetRemaining)`
  and the loop falls closed once `budgetRemaining ≤ 250ms`, so worst-case swap-tail latency is literally
  `≤ swapTotalBudgetMs` (gating the budget only BEFORE each attempt was insufficient — an attempt admitted
  at `budget−ε` would overrun by a full cap). The operator sets it alongside the per-framework caps
  (recommended 40000) as ONE opt-in package (FD8) so the caps and their reachability ceiling arrive
  together, never a partial config that regresses the tail.
- **FD7 — Per-attempt clamp + value validation + timer hygiene.** Resolved caps are clamped to
  `swapAttemptTimeoutMsMax` (default 120s; the maxCap VALUE is itself validated `isFinite && >0`, invalid
  → the 120s default) so a typo can't create an unbounded attempt. `swapTotalBudgetMs` is likewise
  validated (invalid → treated as unset ⇒ no enforcement). The timeout timer is cleared on settle (a
  `withTimeout` helper) to avoid leaked timers. All internal-safety, no observable behavior change at the
  default (all-unset) config. Cheap-to-change-after: pure internals behind the dark default.
- **FD8 — Delivery closes the loop (not just the mechanism).** Shipping the mechanism dark is not the
  end state: Fix-A delivery surfaces the recommended values to the operator as a one-tap go/no-go AND
  registers a tracked commitment, so the gemini bug is actually fixed (opt-in followed through), not
  merely made fixable. This is a delivery obligation, tracked outside this spec's code change.

## Open questions
*(none)*

---
title: "Resilient Degradation Ladder — slow-down-before-fallback for deferrable work, fast-fail-closed for gates, never silently: Spec"
slug: "resilient-degradation-ladder"
author: "echo"
parent-principle: "No Silent Degradation to Brittle Fallback"
eli16-overview: "resilient-degradation-ladder.eli16.md"
status: "draft"
approved: false
parent-spec: "docs/specs/provider-fallback-default-policy.md (the framework-swap tail this EXTENDS); docs/LLM-SUPERVISED-EXECUTION.md (LLM intelligence — not a heuristic — directs important decisions)"
lessons-engaged:
  - "Operator degradation principle ([[feedback_heuristic_fallback_last_resort_never_silent]]): heuristic is a LAST RESORT, low-risk only; PREFER slowing down (backoff) over falling back; NEVER silently remain degraded indefinitely. Round-1 refinement: 'slow down' is for DEFERRABLE/background work — a synchronous GATE the agent is awaiting must stay responsive (swap fast / fail closed), never add backoff stall to it."
  - "FOUNDATION AUDIT (the #2 lesson) — round-1 verified every §2 prior-art claim against code (NO wrong claims). This EXTENDS the existing IntelligenceRouter / CircuitBreaker / LlmQueue / DegradationReporter; it does NOT rebuild. Rung (b) account-swap is CUT from v1 because it is net-new mechanism (internal calls use a process-wide credential; per-call account-swap does not exist) — account-swap already exists at the SESSION level (SubscriptionPool auto/proactive swap)."
  - "The 2026-06-21 DegradationReporter event-loop wedge ([[incident_eventloop_wedge_degradationreporter_reentrancy]]) — §4 extends THE EXACT subsystem that wedged. It MUST: be bounded (reuse MAX_EVENTS-class cap), be reentrancy-safe (preserve `_gatingHealthAlert`; the open-tracking sweep NEVER calls report()), use O(1) per-component mutation (no O(N) full-map serialize), and be liveness-gated (a run-once/idle component must auto-close, not escalate a false alarm)."
  - "No Silent Degradation to Brittle Fallback (parent): herd-aware, observable, MUST recover. LLM-Supervised Execution + Observable Intelligence + Signal-vs-Authority engaged."
---

# Resilient Degradation Ladder

## 1. Problem (operator principle + the current gaps)

Operator directive (2026-06-21): handle rate-limits/outages robustly "NO MATTER WHAT" without
becoming brittle, and WITHOUT silently abandoning LLM-supervised execution when a provider
throttles. The rule: heuristic is a LAST RESORT (low-risk only); PREFER slowing down (backoff) over
falling back; NEVER silently remain degraded indefinitely (loud, bounded, auto-healing). Order:
backoff → account-swap → framework-swap → queue → heuristic.

**Round-1 refinement (load-bearing):** "prefer slowing down" applies to **deferrable/background**
work. A **gating** call is one the agent/user is *synchronously awaiting* — adding backoff there
ADDS a multi-second stall to the exact path the existing router's 5s swap-cap exists to keep
responsive. So the ladder is path-dependent: **deferrable work gets the full gentle ladder; a
gating call swaps fast and fails closed (never a heuristic), and BOTH paths get never-silent
tracking.**

## 2. Foundation audit (what EXISTS — extend, do not rebuild; round-1 verified)

- **`src/core/IntelligenceRouter.ts:200-269`** — gating-call failure path: swap down the framework
  chain (`codex→pi→gemini→claude`), each circuit-checked, each bounded by `swapAttemptTimeoutMs`
  (default 5000, `server.ts:4999`), `onDegrade` per swap, then `throw` (fail closed). Non-gating →
  `throw err` → caller's heuristic (no herd). The `catch` after `primary.evaluate()` (L203-205) is
  the ladder seam.
- **`src/core/CircuitBreakingIntelligenceProvider.ts` + `src/core/LlmCircuitBreaker.ts`** —
  `onRateLimited` OPENS the breaker (no same-provider retry); a subsequent `evaluate()` is SHED via
  `breaker.acquire()`→`allow:false`→`LlmCircuitOpenError` until the open window elapses. The breaker
  is **ACCOUNT-GLOBAL** (one shared breaker per account pauses every LLM feature; a non-default
  routed framework has its own separate breaker built in `buildProvider`). It ALREADY has a bounded
  wait-and-retry primitive — and the SEAM the router can reach is `options.rateLimitWaitMs`:
  `CircuitBreakingIntelligenceProvider.evaluate()` (src/core/, ~L184-200) already calls
  `acquireOrWait(rateLimitWaitMs)` when the caller sets that option. **The router holds NO breaker
  reference** (it only sees `IntelligenceProvider` handles) — so deferrable backoff is realized by
  the router SETTING `options.rateLimitWaitMs` on the retry, NOT by a router→breaker call.
- **`src/monitoring/LlmQueue.ts:82`** — `enqueue(lane, fn: (signal: AbortSignal) => Promise<string>,
  costCents=0)`; priority-laned; enforces a DAILY-CENTS cap (throws `'LLM daily spend cap exceeded'`)
  and an interactive-reserve guard — an enqueue can be REJECTED. Used by callers, not the router.
- **`src/monitoring/DegradationReporter.ts`** — report + Telegram-alert + persist; `registerHealer`
  is a ONE-SHOT heal at report time; NO resolve/recover/duration lifecycle. Carries the
  `_gatingHealthAlert` reentrancy guard + `MAX_EVENTS` cap from the 2026-06-21 wedge.
- **Account-swap exists only at SESSION level:** `QuotaAwareScheduler.selectAccount` (a pure fn) +
  `ProactiveSwapMonitor` move a tmux SESSION to a different `configHome` (respawn, `--resume`).
  There is NO per-internal-call account selector; `ClaudeCliIntelligenceProvider.evaluate()` uses a
  process-wide credential fixed at boot.

### The gaps this spec closes (and the one it defers)

1. **No backoff-before-swap for DEFERRABLE work** — the router sets `options.rateLimitWaitMs` so the
   provider-layer `acquireOrWait` performs the bounded wait (NOT a parallel sleep that races the open
   window) for deferrable calls. The wait is account-global-breaker-scoped (the scope the call routes
   to), which is legitimate "slow down."
2. **No queue/defer rung** — wire `LlmQueue` for deferrable calls (handling enqueue-rejection).
3. **Never-silent not guaranteed** — DegradationReporter has no recover/escalate lifecycle.
4. **DEFERRED to a tracked follow-up (not v1):** account-swap for an internal call (rung b). It is
   net-new mechanism (per-call credential re-point), already covered at session level, and dissolves
   the herd + cross-machine + auto-swap-conflict concerns by being out of v1.

## 3. Design — path-dependent ladder

Extend the `IntelligenceRouter` gating-failure `catch`. The path is chosen by two caller flags on
`attribution`: `gating` (existing) and `deferrable` (NEW). **Structural invariant: `gating:true`
ALWAYS skips the queue rung (a gate is awaited; it can never be deferred) — code-enforced, not a
convention.** A gating-AND-deferrable call is treated as gating (fail-fast dominates).

### 3a. GATING call (synchronous, awaited) — stay responsive
`primary.evaluate()` → on failure, the EXISTING fast framework-swap tail (5s/attempt cap) → fail
closed (`throw`). **No backoff rung** (it would stall the awaited path). A single **ladder-total
wall-clock budget** (`gatingLadderBudgetMs`, default 6000) caps the entire gating failure handling;
when consumed, jump straight to fail-closed. If the fail-closed propagates to a caller heuristic
(only a NON-gating caller does that — a gating call throws), §4 tracking opens. Net change for
gating: the total budget + never-silent tracking; the fast-swap behavior is UNCHANGED.

### 3b. DEFERRABLE call (background, not awaited) — the full gentle ladder
1. **Backoff (NEW):** on a rate-limit, set `options.rateLimitWaitMs = min(retryAfterMs,
   deferrableBackoffCeilingMs)` on the retry to `primary.evaluate()`, so the provider-layer's
   existing `acquireOrWait` performs the bounded wait (the router holds no breaker — see §2). This
   slows down and retries the SAME provider, honoring the server's `retryAfterMs` (clamped to the
   ceiling; an over-ceiling retry-after for a deferrable call MAY wait the full hint up to a hard
   `deferrableMaxWaitMs`). It reuses the (account-global) breaker's open-window timing rather than
   racing it with a parallel sleep.
2. **Framework-swap (EXISTING):** the failureSwap tail.
3. **Queue (NEW):** if still failing, `LlmQueue.enqueue(lane, signal => provider.evaluate(prompt,
   {...,signal}))` for a bounded retry window with **rate-aware, jittered drain pacing** (honor the
   recovered account's `retryAfterMs`; the queue must not thundering-herd on recovery). If the
   enqueue is REJECTED (daily-cap / reserve), fall through to (4) — never silently drop.
4. **Heuristic (EXISTING, last resort):** the caller's heuristic, tracked by §4.

### 3c. Herd-awareness (preserved)
The non-gating no-herd property is unchanged. The queue drain (3b.3) is rate-aware so a recovered
provider isn't re-tripped by a burst of deferred calls (a NEW herd guard the queue lacks today).

## 4. Never-silent: bounded, reentrancy-safe, liveness-gated tracking (NEW)

Extend `DegradationReporter` with an open-degradation lifecycle — designed to NOT repeat the
2026-06-21 wedge:
- **Open** a degradation when a heuristic fallthrough (3a fail-closed-to-caller-heuristic, or
  3b.4) fires, keyed on `(component, framework)` (NOT bare component — round-1 collision finding;
  two callsites sharing a component string must not cross-resolve). Bounded by a `MAX_OPEN`
  cap (same class as `MAX_EVENTS`); over the cap → oldest evicted with a one-line log (never
  unbounded growth).
- **Auto-resolve** on the next SUCCESSFUL real-LLM call for that `(component, framework)` — record
  the degraded duration. This requires a NEW success hook: the router has only `onDegrade` today, so
  this spec adds a paired `onResolved(component, framework)` callback wired into the router's success
  returns (the `return await primary.evaluate(...)` paths AND the default-provider return) — net-new
  wiring, named here per the extend-not-rebuild discipline. The open-map mutation on open/resolve is
  O(1) (no full-map serialize). NOTE: the existing `DegradationReporter.persistToDisk()` does an
  O(N) read-parse-write per report — that pre-existing disk path is OUT OF SCOPE here; §4 adds no new
  O(N) path, but does not claim to fix the reporter's existing one.
- **Liveness-gated escalation:** a degradation OPEN longer than `degradationEscalateMs` (default
  15m) AND with ≥1 real retry attempt since open raises ONE deduped, age-escalating attention item.
  A degradation with ZERO retry attempts since open (a run-once / idle component that is simply
  done, not stuck) AUTO-CLOSES at a TTL instead of escalating — closing the round-1 false-alarm
  class.
- **Reentrancy-safe:** the open-tracking sweep NEVER calls `report()`/`reportEvent()`; it raises the
  attention item through the existing attention surface directly, preserving `_gatingHealthAlert`.
  The sweep is a level-triggered check, not an event emitter.
- **Inert when off:** when `neverSilent` is disabled the new lifecycle code path is NOT ENTERED (no
  map maintained, no sweep) — "dark" means bypassed, not "flag false but still accumulating"
  (round-1; given the wedge, this is mandatory).

## 5. Decisions frontloaded (single-run completable)

- **D1 Config + dark rollout.** `intelligence.degradationLadder`: `{ backoff?, queue?, neverSilent? }`
  (NO accountSwap in v1), each `{enabled, …bounds}`. Registered in `DEV_GATED_FEATURES`
  (`src/core/devGatedFeatures.ts`) with `enabled` OMITTED so `resolveDevAgentGate` resolves it
  live-on-dev / dark-on-fleet (the known instar-dev pattern — round-1). Ladder fully off =
  EXACTLY today's framework-swap-only behavior.
- **D2 Backoff bounds (DEFERRABLE only).** base 500ms, factor 2, max 3 attempts,
  `deferrableBackoffCeilingMs` 8000, `deferrableMaxWaitMs` 60000, full jitter; realized by setting
  `options.rateLimitWaitMs` (the provider-layer `acquireOrWait` seam, §2), do NOT sleep-race the
  breaker, and do NOT call a breaker from the router (it holds none). Gating calls have NO backoff.
- **D3 `gatingLadderBudgetMs` = 6000** — a single hard wall-clock budget for the whole gating
  failure path; consumed → fail closed. **D3 is a LOAD-BEARING correctness decision (responsiveness
  of awaited gates), NOT a dark-flag-tunable cheap tag** (round-1 contest).
- **D4 Risk boundary — honestly scoped.** v1's invariant: a **gating** call NEVER reaches a
  heuristic — it fails closed (UNCHANGED existing behavior). A **non-gating** call keeps today's
  behavior (heuristic on exhaustion) BUT is now TRACKED (§4). The stronger "a CONSEQUENTIAL
  non-gating call must also fail closed" requires a NEW `attribution.consequential` flag + a callsite
  migration — **explicitly a tracked follow-up, NOT v1** (round-1: `gating` does not carry
  consequence; claiming otherwise would be a strawman safety test). v1 does NOT add risk-based
  protection beyond the existing gating boundary; it adds the gentler ORDER (deferrable) + the
  never-silent TRACKING (both paths). This is a load-bearing scoping decision, frozen at approval.
- **D5 `deferrable` is caller-declared; `gating:true` ⇒ queue-skipped, code-enforced** (a structural
  precondition + a unit test `gating&&deferrable ⇒ not queued`), NOT a caller convention (round-1).
- **D6 Never-silent bounds:** `degradationEscalateMs` 15m; `MAX_OPEN` cap; key `(component,
  framework)`; liveness-gated (≥1 retry to escalate; TTL auto-close otherwise); deduped per episode;
  reentrancy-safe.
- **D7 Observability:** extend the `onDegrade` reason taxonomy (backoff-retry / framework-swap /
  queued / queue-rejected / heuristic-open / heuristic-resolved / escalated) so /metrics/features
  shows WHERE in the ladder calls land. Account-swap reason reserved for the deferred rung (b).
- **D8 Migration Parity:** NO `migrateConfig` entry needed — the ladder is opt-in + off-by-default,
  so deployed agents are unaffected until opt-in; the only install-path touch is the
  `DEV_GATED_FEATURES` registration. The new `attribution.deferrable` defaults false (safe) at every
  unmodified callsite.

## 6. Multi-machine posture (Cross-Machine Coherence)
Per-process / machine-local: each machine's router handles its own internal calls; DegradationReporter
state is machine-local. No replicated state, no cross-machine contract. (Cutting rung (b) removes the
only cross-machine concern round-1 raised — concurrent same-account selection.) A sustained
per-machine degradation could double-alert on a 2-machine setup for one provider outage; accepted as
a minor local-dedup limitation (noted, not coalesced in v1).

## 7. Testing (three tiers, NON-NEGOTIABLE)
- **Unit:** rung (a) sets `options.rateLimitWaitMs` (the provider-layer wait seam, no sleep-race,
  no router→breaker call) and only on deferrable; auto-resolve fires via the new `onResolved` hook on
  the next success; the gating path
  has NO backoff and obeys `gatingLadderBudgetMs`; queue used only when deferrable and `gating&&
  deferrable ⇒ NOT queued`; an enqueue REJECTION falls through to heuristic (never dropped); §4
  opens→auto-resolves on next success, escalates only with ≥1 retry, TTL-auto-closes a run-once
  component (no false alarm), keys on (component,framework) with NO cross-resolution, and the sweep
  never re-enters report() (reentrancy test) + bounded growth under a burst (the 2026-06-21
  invariant).
- **Integration:** the full deferrable ladder through the real IntelligenceRouter + stub breaker +
  stub LlmQueue asserts the ORDER (backoff → framework-swap → queue → heuristic) and the gating path
  asserts fast-swap-then-fail-closed within budget; each transition recorded in /metrics/features.
- **E2E:** the ladder config is alive in the server-boot path and FULLY INERT when off (the
  feature-alive + inert-when-dark test — mandatory given the wedge).

## 8. Open questions
*(none — round-1's three blocking items are resolved in-spec: rung (b) account-swap is CUT to a
tracked follow-up (§2.4/D7); the gating stall is closed by the path-split + `gatingLadderBudgetMs`
(§3a/D3); the safety boundary is honestly scoped to the existing gating fail-closed with the
`consequential` flag deferred (D4). The `retryAfterMs`>ceiling case is decided in D2 (clamp for
gating-N/A; deferrable may wait to `deferrableMaxWaitMs`).)*

---
title: "Resilient Degradation Ladder — backoff → account-swap → framework-swap → queue → (last-resort) heuristic, never silently: Spec"
slug: "resilient-degradation-ladder"
author: "echo"
parent-principle: "No Silent Degradation to Brittle Fallback"
eli16-overview: "resilient-degradation-ladder.eli16.md"
status: "draft"
approved: false
parent-spec: "docs/specs/provider-fallback-default-policy.md (the framework-swap tail this EXTENDS); docs/LLM-SUPERVISED-EXECUTION.md (the standard that LLM intelligence — not a heuristic — directs important decisions)"
lessons-engaged:
  - "Operator degradation principle ([[feedback_heuristic_fallback_last_resort_never_silent]]): heuristic fallback is a LAST RESORT, low-risk only; PREFER slowing down (exponential backoff) over falling back; NEVER silently remain degraded indefinitely (loud + bounded + auto-healing). The ladder order is backoff → account-swap → framework-swap → queue → heuristic."
  - "FOUNDATION AUDIT (the #2 lesson): much of this is ALREADY built — the IntelligenceRouter framework-swap tail, the CircuitBreaker, the SubscriptionPool account-swap, the LlmQueue, the DegradationReporter. This spec EXTENDS them into one ordered ladder; it does NOT rebuild. Every prior-art claim is grounded against the actual code and re-verified in spec-converge."
  - "No Silent Degradation to Brittle Fallback (the parent): a low-context heuristic must never silently replace an LLM decision; degradation must be herd-aware, observable, and recover."
  - "Observable Intelligence: every rung's firing is recorded in /metrics/features (the existing onDegrade → DegradationReporter path) so the ladder's behavior is auditable, never invisible."
---

# Resilient Degradation Ladder

## 1. Problem (operator principle + the current gaps)

Operator directive (2026-06-21): the system must "robustly handle rate-limits / outages NO MATTER
WHAT" without becoming brittle — and WITHOUT silently abandoning the LLM-supervised-execution
standard the moment a provider throttles. The binding rule:

> Heuristic fallback is a LAST RESORT, low-risk only. PREFER slowing down (exponential backoff)
> over falling back. NEVER silently remain degraded indefinitely (loud, bounded, auto-healing).
> Order: **backoff → account-swap → framework-swap → queue → heuristic.**

## 2. Foundation audit (what EXISTS — extend, do not rebuild)

Grounded against the code (2026-06-21):

- **`src/core/IntelligenceRouter.ts`** — the internal-call router. On a GATING call failure
  (rate-limit / circuit-open / error) it swaps DOWN the framework chain
  (`codex-cli → pi-cli → gemini-cli → claude-code`), each circuit-checked, each bounded by
  `intelligence.swapAttemptTimeoutMs` (5s), reports each swap via `onDegrade`, then fails closed
  (gating) — the non-gating caller swallows into its heuristic (no herd). Heuristic is ALREADY the
  de-prioritized last resort (Provider-Fallback Default Policy SUPERSEDED "rate-limited → heuristic").
- **`src/core/CircuitBreakingIntelligenceProvider.ts`** — per-framework breaker;
  `onRateLimited(msg, retryAfterMs)` + `LlmCircuitOpenError(retryAfterMs)`. Opens-then-swaps; does
  NOT backoff-retry the same provider.
- **`src/core/SubscriptionPool.ts`** — multi-Claude-account ACCOUNT-swap ("select an account = the
  swap mechanism"). Reactive auto-swap on `rate-limit:escalated` for SESSIONS; NOT wired into the
  internal-call router path.
- **`src/monitoring/LlmQueue.ts`** — priority-laned, rate-limited queue
  (`enqueue('interactive'|'background', fn)`); used by individual callers (openConversationBrief,
  A2ACheckInProxy, CartographerSweepEngine), NOT by the router's fallback path.
- **`src/monitoring/DegradationReporter.ts`** — reports a degradation (feature/fallback/impact),
  Telegram-alerts, persists; `registerHealer(feature, healer)` = a ONE-SHOT self-heal at report
  time. NO continuous "still degraded? escalate / auto-heal-confirmed?" tracking (verified: no
  resolve/recover/ongoing surface).

### The four real GAPS vs the ladder

1. **No backoff-first.** The router swaps frameworks immediately on failure; there is no
   exponential-backoff + retry of the SAME provider/account (respecting `retryAfterMs`) before
   switching. ("Prefer slowing down over falling back.")
2. **No account-swap in the router path.** The router swaps FRAMEWORKS (claude→codex); the operator
   order is ACCOUNT-swap FIRST (claude-acct-1 → claude-acct-2, stay on the provider). The
   SubscriptionPool can swap accounts but is not consulted in the internal-call fallback.
3. **No queue/defer rung.** The router swaps-or-fails; there is no "queue the work, retry shortly"
   step before the last-resort heuristic.
4. **Never-silent not guaranteed.** Degradations are reported with a one-shot healer, but a
   SUSTAINED heuristic-fallback is not tracked as a BOUNDED, AUTO-HEALING degradation that escalates
   if it persists. (The exact thing the operator named: "prevent fallback from silently remaining
   degraded indefinitely.")

## 3. Design — one ordered ladder in the gating-failure path

Extend `IntelligenceRouter`'s gating-call failure handling (the `catch` after
`primary.evaluate()`) into the full ordered ladder. Each rung is config-gated, observable
(`onDegrade` → DegradationReporter → /metrics/features), and bounded. The non-gating path is
UNCHANGED (it still propagates to the caller's heuristic — no herd).

**Rung (a) — backoff + retry the SAME provider (NEW).** On a rate-limit with a `retryAfterMs`
hint (or a bounded exponential backoff when absent: `base·2^attempt`, capped, jittered, ≤ N
attempts), wait and retry the primary before swapping. "Slow but correct" beats "fast but
switched." Bounded by a total-backoff ceiling so it never stalls a gating path indefinitely;
above the ceiling, fall through to (b). A non-rate-limit error skips (a) (no point slowing down a
hard error) and goes straight to (b)/(c).

**Rung (b) — account-swap, SAME provider (NEW wiring).** Before changing frameworks, if the
rate-limited framework is Claude and the SubscriptionPool has another eligible (non-throttled)
account, retry the SAME provider on that account (the pool's existing account-selection). Keeps the
call on the highest-quality provider. Bounded to the eligible-account set; exhausted → (c).

**Rung (c) — framework-swap (EXISTING).** The current `failureSwap` tail down the active chain,
each circuit-checked + `swapAttemptTimeoutMs`-bounded. Unchanged.

**Rung (d) — queue/defer (NEW wiring).** If (a)-(c) all fail and the call is deferrable (the
caller marks `deferrable: true` — e.g. a background sentinel, NOT a synchronous gate the user is
waiting on), enqueue via `LlmQueue` for a bounded retry window instead of degrading. A
non-deferrable gating call skips (d).

**Rung (e) — heuristic, LAST RESORT (EXISTING, hardened).** Only when (a)-(d) are exhausted (or
not applicable) does the caller's heuristic run — AND only when the operation is low-risk (a
consequential/irreversible decision queues or fails closed rather than guessing). Every heuristic
fallthrough opens a tracked degradation (§4).

## 4. Never-silent: bounded, auto-healing degradation tracking (NEW)

Extend `DegradationReporter` from one-shot report to a tracked lifecycle:
- **Open** a degradation when rung (e) (heuristic) fires for a component, keyed on the component.
- **Auto-heal confirm:** on the next SUCCESSFUL real-LLM call for that component, mark it RESOLVED
  (record the degraded duration). The existing one-shot healer remains; this adds the
  success-observed auto-resolve.
- **Persistence escalation:** a degradation OPEN longer than `degradationEscalateMs` raises a
  LOUD, deduped attention item ("component X has been on its heuristic fallback for N minutes —
  the LLM path hasn't recovered"). It can never persist silently: bounded by escalation, resolved
  by a real success, deduped so it's not a flood.
- Observable: open/resolved/escalated transitions feed /metrics/features + the audit file.

## 5. Decisions frontloaded (single-run completable)

- **D1 Ladder is opt-in per rung, config-gated, ships dark/dev-gated first** (`intelligence.degradationLadder`:
  `{ backoff?, accountSwap?, queue?, neverSilent? }` each `{enabled, …bounds}`). Default behavior
  with the ladder off = today's behavior (framework-swap only). Dev-agent gate → live-on-dev,
  dark-on-fleet.
- **D2 Backoff bounds:** base 500ms, factor 2, max 3 attempts, total ceiling 8s, full jitter;
  honor a server `retryAfterMs` over the computed delay. (Gating calls can't stall — the ceiling
  is hard.)
- **D3 Deferrability is caller-declared** (`attribution.deferrable`), NOT inferred. A synchronous
  gate is never queued. Background sentinels/reflectors opt in.
- **D4 Risk gate on (e):** a heuristic only runs for a low-risk operation; the caller already owns
  the heuristic, so this rung adds the tracking, not the risk judgment (the caller's existing
  gating/non-gating split is the risk boundary — a gating call fails closed, never heuristic).
- **D5 Account-swap reuses the SubscriptionPool's existing eligible-account selection** — no new
  account logic; the router consults the pool, the pool decides. Single-account agents = no-op.
- **D6 neverSilent escalation:** `degradationEscalateMs` default 15m; deduped per component; one
  attention item per episode, age-escalating, auto-resolved on real success.
- **D7 Observability:** every rung firing already flows through `onDegrade`; extend the reason
  taxonomy (backoff-retry / account-swap / queued / heuristic-open / heuristic-resolved) so
  /metrics/features shows WHERE in the ladder calls land.

## 6. Multi-machine posture (Cross-Machine Coherence)

The ladder is per-process (each machine's router handles its own internal calls); no replicated
state. The SubscriptionPool account-swap is already multi-machine-aware (account quota replicates
via the existing pool-scope reads). DegradationReporter state is machine-local (each machine
reports its own degradations). No cross-machine contract is introduced.

## 7. Testing (three tiers, NON-NEGOTIABLE)

- **Unit:** each rung in isolation against a fake provider — backoff retries then succeeds /
  exhausts to (b); account-swap consulted before framework-swap; queue used only when deferrable;
  heuristic only after exhaustion; DegradationReporter opens→auto-resolves on next success and
  escalates after the window. A NAMED safety-invariant test: a CONSEQUENTIAL/non-deferrable gating
  call NEVER reaches the heuristic (fails closed instead) — the operator's load-bearing rule.
- **Integration:** the full ladder through the real IntelligenceRouter + a stub SubscriptionPool +
  a stub LlmQueue, asserting the ORDER (backoff → account → framework → queue → heuristic) and that
  each transition is recorded.
- **E2E:** the ladder config is alive in the server-boot path (the router is constructed with the
  ladder when enabled; /metrics/features reflects a forced degradation) — the "feature is alive"
  tier.

## 8. Open questions
*(none — D1–D7 frontload the decisions with safe dark-first defaults; bounds are operator-tunable
at the approval checkpoint.)*

# Round 2 — Scalability / Performance convergence check

Reviewer lens: does the §4.5 CRUX resolution actually bound total swap latency; is the
§4.2 boot active-set cost still bounded; any NEW perf issue from the rewrite. Grounded
against `src/core/IntelligenceRouter.ts` (evaluate/failureSwap loop, :152-219),
`src/server/outboundGateBudget.ts`, `src/server/middleware.ts:378`,
`src/core/ClaudeCliIntelligenceProvider.ts` (execFile + 30s default),
the 7 gating callers (MessageSentinel:559, ExternalOperationGate:510, InputGuard:317-330,
IntentTestHarness:250, RelationshipAnomalyScorer:391, LlmIntentClassifier:126,
MessagingToneGate:264 + routes.ts:1730-1741).

---

## (1) Is §4.5's "per-attempt cap × chain length, bounded by the caller's own budget" SOUND?

**Verdict: the LATENCY BOUND holds, but the spec's STATED mechanism is half-wrong and
must be corrected — the per-attempt cap is load-bearing; the "caller's own budget" is NOT
the actual ceiling for 5 of the 7 gating callers.**

- **[material — unsound-as-stated, fix the prose] §4.5's reliance on "the caller's own
  overall budget still bounds the total" is FALSE for most gating callers.** I enumerated
  all 7 `gating:true` callsites and how each bounds time. Only ONE wraps the WHOLE
  `evaluate()` (and therefore the whole swap loop) in a single budget:
  - **InputGuard** (`:320-330`) — `Promise.race([evaluate(...), setTimeout(reject, timeout)])`,
    timeout ≥ 8000ms floor. This races the ENTIRE swap loop → genuine total bound. ✅
  - **MessagingToneGate** — does NOT bound itself; the bound is at the ROUTE
    (`routes.ts:1739` → `reviewWithinBudget(..., OUTBOUND_GATE_REVIEW_BUDGET_MS)`).
    `OUTBOUND_GATE_REVIEW_BUDGET_MS = 20_000` (`middleware.ts:378`) — **NOT the "5s budget"
    the spec asserts at §4.5 line 191/192.** The spec's parenthetical "the tone-gate already
    wraps its evaluate() in a 5s budget" is factually wrong; the real route budget is **20s**.
    Fix the number or drop the specific claim.
  - **IntentTestHarness / RelationshipAnomalyScorer / LlmIntentClassifier** (`:250 / :391 /
    :126`) — pass `options.timeoutMs` (8000 / 6000 / 8000). Crucially, the swap loop forwards
    the SAME `options` to EVERY target (`IntelligenceRouter.ts:194,202`), so this `timeoutMs`
    is applied **PER underlying `execFile` call, NOT once for the whole loop**
    (`ClaudeCliIntelligenceProvider.ts:70` / `CodexCliIntelligenceProvider.ts:365` →
    `execFile({ timeout })`). Total = `timeoutMs × attempts`, NOT a single caller budget.
  - **MessageSentinel** (`:559`) and **ExternalOperationGate** (`:510`) — **pass NO
    `timeoutMs` and have NO `Promise.race` budget.** They inherit only the provider's
    `DEFAULT_TIMEOUT_MS = 30_000` PER attempt. With NO §4.5 cap these two stack
    `30s × (1 primary + tail)` = **up to ~90–120s on a 3–4-link brownout** — the EXACT M1
    regression. For these callers the "caller's own budget" ceiling the spec leans on
    **does not exist.**

  **Why the bound still holds:** §4.5 puts the per-attempt cap INSIDE the swap loop, at the
  router, applied to EVERY attempt regardless of caller. That is the only reason
  MessageSentinel / ExternalOperationGate / the three `timeoutMs`-per-attempt callers are
  bounded at all. So the real, defensible statement is: **total swap latency is bounded by
  `swapAttemptTimeoutMs × (1 + activeTail.length)` for ALL callers — the per-attempt cap is
  the sole universal ceiling; an outer caller budget (where one exists) only tightens it.**
  - **Resolution:** Rewrite §4.5's second bullet. Drop "the caller's own overall budget bounds
    the total" as the primary claim (it's true only for InputGuard). State the bound as
    `swapAttemptTimeoutMs × (1 + activeTail.length)`, name it the universal router-level
    ceiling, and fix the tone-gate budget number (20s, not 5s). Note explicitly that
    MessageSentinel and ExternalOperationGate have NO caller budget and depend ENTIRELY on the
    new per-attempt cap — this is the strongest justification for §4.5 being non-optional.

- **[material — NEW] "Racing a timeout against `tp.evaluate()`" is cheap but NOT free of a
  side-effect: the abandoned attempt orphans a live `execFile` subprocess.** The CLI
  providers spawn via `execFile` (`ClaudeCliIntelligenceProvider.ts:65`,
  `CodexCliIntelligenceProvider.ts`). If §4.5 implements the cap as a router-level
  `Promise.race([tp.evaluate(opts), timeout(cap)])`, the LOSING `tp.evaluate()` promise is
  abandoned but its child process keeps running until ITS OWN `timeout` option fires
  (`options?.timeoutMs ?? 30_000`). So under a multi-provider brownout the loop advances every
  `cap` (~5s) while leaving a chain of still-alive subprocesses behind it — each consuming the
  provider account's quota/tokens and host CPU/FDs for up to the provider's own 30s timeout.
  This is a real (small, bounded) accumulation the spec does not mention; it slightly
  undercuts the herd-damping story (an abandoned-but-running codex call is still spending
  codex). Racing is correct for LATENCY (the caller advances on time) but is NOT a clean
  cancel.
  - **Resolution:** §4.5 should either (a) pass `options.timeoutMs = min(callerTimeout,
    swapAttemptTimeoutMs)` THROUGH to each `tp.evaluate()` so the per-attempt cap is the
    provider's OWN `execFile` timeout (kills the subprocess at the cap, no orphan) — strongly
    preferred, it makes the cap a real cancel not just an abandon; or (b) acknowledge the
    orphaned-subprocess tail as a known, bounded (≤ provider-timeout) cost. Option (a) is also
    cleaner because it reuses the EXISTING `execFile({ timeout })` machinery instead of adding
    a second racing timer — one timeout notion, not two that can disagree. Add a unit assertion
    that the per-attempt cap actually shortens the subprocess timeout (not just the awaited
    promise).

- **[minor] §4.5 default `~gateTimeoutMs, e.g. 5s` vs the providers' interactive needs.** The
  Claude provider's comment (`:67-69`) notes some gating callers legitimately need MORE than
  30s (the standards-conformance gate reviewing a full spec). A blanket 5s per-attempt cap is
  fine for the high-frequency sentinel/gate/reflector population this policy targets, but if
  the cap is applied to EVERY gating call it could prematurely abandon a legitimately-long
  gating review. The §4.1 chain only routes `sentinel/gate/reflector`, and those are the
  short calls — so this is contained — but the cap must be the per-ATTEMPT swap cap, NOT a cap
  on the primary's first call when no swap is configured (today's long single-provider gating
  calls must be unaffected).
  - **Resolution:** Scope the cap to the SWAP path only (a swap is configured AND this is a
    gating call) — never shorten the primary attempt for a caller that has no `failureSwap`.
    The `if (swapTargets.length === 0) throw err` guard at `IntelligenceRouter.ts:196` already
    isolates the no-swap path; the cap must live entirely past that guard. State this in §4.5
    so the implementer doesn't wrap the `primary.evaluate()` at line 194 with the cap.

## (2) Is §4.2's boot-time active-set computation cost still bounded?

**Verdict: YES — bounded and cheap, with ONE round-1 caveat that the rewrite did NOT fold in.**

- The active-set is `INTERNAL_FRAMEWORK_PREFERENCE.filter(isActive)` over a **fixed 4-element
  constant**, computed **once at boot**, memoized into a stable config object (per §4.6
  "memoized; active-set computed once at boot"). `isActive` = `buildProvider(fw) !== null`,
  and `buildProvider` → `detect*` is process-memoized (`Config.ts:146`) with pure
  constructor field-assignment providers/breakers. So the cost is **≤4 memoized detects + ≤4
  cheap object allocs, once.** Bounded. ✅
- The §4.6 memoization closing the round-1 minor item ("resolver must return the SAME reference
  on every `resolveConfig()` call, zero per-call alloc") is correctly addressed — §4.6 says
  "memoized; active-set computed once at boot" and §4.4 says compute-once. Good — the hot
  gating path stays O(1) string lookups with no per-call filter and no GC churn. ✅

- **[material — UNRESOLVED from round 1] §4.2 still does NOT state that the boot probe must
  resolve through the ROUTER'S OWN provider cache.** Round-1 scalability raised this
  ("Boot-time active-set probe must reuse the router's provider cache, or it double-builds
  every framework's provider+breaker"). The rewrite's §4.2 says compute the active-set via
  "`buildProvider(fw) !== null` … computed once at boot" and notes "already cached in
  `this.cache`" — but the router's `this.cache` (`IntelligenceRouter.ts:88`) is private and
  only populated via `providerFor()` at call time. If the boot resolver in `server.ts` calls
  the factory's `buildProvider` DIRECTLY (the obvious reading of §4.2), it builds N providers +
  N **fresh `new LlmCircuitBreaker()`** (server.ts allocates a new breaker per buildProvider
  call) that are discarded, and the router rebuilds them on first real call — wasted work AND a
  breaker-identity split (the boot probe's breaker ≠ the runtime breaker, so "active at boot"
  could diverge from "routable at runtime"). The §4.2 phrase "already cached in `this.cache`"
  is ASPIRATIONAL — nothing in the spec wires the probe through the router instance.
  - **Resolution:** §4.2 must state that the active-set probe resolves through the SAME router
    instance's `providerFor()`/`for()` path (which populates and reads `this.cache`), not a
    parallel direct `buildProvider`/factory call — so each framework is built exactly once and
    the boot "active" verdict and the runtime route share one breaker object. This was a
    round-1 material finding that the rewrite acknowledged only in passing without committing to
    the wiring. (Not double-counted as latency — it's a boot-cost + correctness item.)

## (3) New perf issues from the rewrite

- The orphaned-subprocess item under (1) is the one genuinely NEW perf issue (it follows from
  the specific "race a timeout against `tp.evaluate()`" phrasing introduced in the rewrite's
  §4.5).
- §4.1's `job` exclusion REDUCES the concentration-on-one-codex-CLI load that round-1 flagged
  (job/CartographerSweep no longer routed onto `active[0]`), so the background-volume-on-one-
  provider concern is strictly smaller than round 1. No new concern there. ✅
- No new hot-path allocation, no new per-call work, no new boot walk introduced. The engine is
  reused untouched (§4 "keep the engine's routing/breaker logic untouched") except the §4.5
  swap-loop cap.

---

**Verdict: NEEDS-CHANGES (prose-level, no design rework).** The latency bound is real and
§4.5 is the right fix — but its STATED basis is wrong: the per-attempt cap, not the caller
budget, is the universal ceiling; the tone-gate budget is 20s not 5s; 2 of 7 gating callers
have NO caller budget and depend entirely on the new cap (the strongest argument FOR §4.5,
currently buried); the cap should kill the subprocess (pass `timeoutMs` through) not merely
abandon the promise; the cap must be scoped to the swap path only; and the round-1
"probe-shares-router-cache" boot-cost/correctness item is still not committed in §4.2. All
fixable in spec prose + the unit tests already listed in §7 (extend the §4.5 test to assert
the bound is `cap × (1+tail)` independent of caller budget, and that an abandoned attempt's
subprocess is actually killed at the cap).

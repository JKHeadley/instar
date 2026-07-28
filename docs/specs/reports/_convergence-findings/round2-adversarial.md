# Round 2 — Adversarial convergence check (stress-test of the REWRITE)

Reviewer: adversarial. Grounded in `src/core/IntelligenceRouter.ts`,
`src/core/MessagingToneGate.ts`, `src/server/outboundGateBudget.ts`,
`src/server/middleware.ts`, `src/core/CircuitBreakingIntelligenceProvider.ts`,
`src/server/routes.ts` @ the tone-gate seam (worktree provider-fallback-chain).

Round-1 SYNTHESIS (M1–M11) is treated as RESOLVED and not re-raised. This pass
only stress-tests the three rewrite targets the prompt names: §4.5 timeout, §6.2
herd, §6.4 garbage-output scope-out — plus any NEW material the rewrite introduced.

---

## §4.5 — per-attempt swap timeout (the crux)

- **[verified — sound] The fail-open framing holds.** The swap loop
  (`IntelligenceRouter.ts:193-218`) catches every per-attempt failure and
  `continue`s; only when EVERY target is exhausted does it re-throw the original
  error → the gating caller fails closed. A §4.5 per-attempt timeout, modeled as
  "treat a timed-out attempt as a failed attempt," slots cleanly into this loop:
  timed-out → `continue` → next target → … → Claude tail → re-throw if all
  exhausted. It cannot convert a fail-closed outcome into a silent pass. The
  "timed-out attempt → next → Claude tail → fail-closed only if all exhausted"
  chain in §4.5 is **correct as stated.** **Resolution:** no change.

- **[MEDIUM — NEW, sharp edge the rewrite under-specifies] The per-attempt cap
  MUST dominate the inner `rateLimitWaitMs`, and §4.5 never says so.** This is the
  one real gap. Grounding: `MessagingToneGate.ts:268` passes
  `rateLimitWaitMs: 120_000` in `options`, and the SAME `options` object is handed
  to every swap target (`tp.evaluate(prompt, options)`, `IntelligenceRouter.ts:202`).
  Inside `CircuitBreakingIntelligenceProvider.evaluate` (lines 187-191), a target
  whose circuit is OPEN does `await acquireOrWait(120_000)` — it sits up to 120s
  per target. So the breaker does NOT make an open target "throw fast" the way §2
  and §6.2 claim for a gating caller carrying a 120s wait: the wait is the whole
  point of that flag. If §4.5's per-attempt timeout is a naive `Promise.race`
  AROUND `tp.evaluate()` that abandons-but-does-not-cancel, the inner 120s wait
  keeps running (timers are not cancelled) — fine for the budget (race wins) — BUT
  the spec must make the race the AUTHORITY: a ~5s per-attempt cap must beat the
  120s inner wait so the loop advances at 5s, not 120s. §4.5 as written says "races
  a per-attempt timeout" — adequate IF and only if the implementer wraps each
  `tp.evaluate` in the race and treats the inner `rateLimitWaitMs` as subordinate.
  **The danger:** an implementer reads "the gating caller's own overall budget
  still bounds the total" (§4.5) and concludes the inner provider already self-
  bounds, skipping the per-attempt cap — then chain-length × 120s rate-limit-waits
  stacks and the 20s route budget (`OUTBOUND_GATE_REVIEW_BUDGET_MS = 20_000`,
  `middleware.ts:378`) trips → `budgetExceeded` fail-open EVERY time under broad
  rate-limit. That is tonight's strangle relocated one hop, exactly the failure
  §4.5 exists to kill. **Resolution:** §4.5 must state explicitly: (a) the per-
  attempt cap applies to EACH `tp.evaluate()` including its internal
  `rateLimitWaitMs` wait, and the cap WINS; (b) the per-attempt cap (~5s) must be
  materially smaller than the route budget (20s) so ≥2 targets can actually be
  tried within budget — `swapAttemptTimeoutMs` default `~gateTimeoutMs` 5s already
  satisfies this (5s × ~3 tail = 15s < 20s), but the spec should NAME the 20s
  route budget as the binding ceiling rather than the vaguer "gating caller's own
  overall budget," and assert `cap × maxChainLen < routeBudget` as an invariant.

- **[LOW — answered, no change] "Correct slow answer dropped in favor of fail-
  closed when it shouldn't be?"** No. A timed-out PRIMARY is abandoned but the
  loop tries the tail; only all-exhausted fails closed. A provider returning JUST
  under the cap every time is honored (it's a successful, in-budget answer — the
  cap only fires on EXCEEDING it). A provider "slow AND eventually errors" is
  abandoned at the cap as a failure, which is the intended behavior — its eventual
  error would have been a failure anyway, so nothing correct is lost. The only
  case where a *correct slow* answer is dropped is a provider that would have
  answered correctly at cap+ε; that is the deliberate, named trade (§4.5: "abandon
  the slow primary at the cap") and is the RIGHT call for a delivery-path gate
  whose alternative is stalling message delivery. **Resolution:** §4.5's trade is
  sound; fold the naming into the MEDIUM fix above (state the trade is intentional
  and bounded by the route budget).

---

## §6.2 — herd analysis

- **[verified — airtight for the gating population] "Falling to Claude tail is
  correct for gating, herd is small + breaker-damped" holds.** Three legs all
  ground out:
  1. *Small population.* `swapTargets` is non-empty ONLY when
     `gating === true` (`IntelligenceRouter.ts:190-191`); non-gating calls
     re-throw at line 196 and never enter the swap loop. The gating population is
     the enumerated safety machinery (§6.3: MessagingToneGate, MessageSentinel,
     ExternalOperationGate, InputGuard, IntentLlmJudge, RelationshipAnomalyScorer,
     LlmIntentClassifier) — a fixed, small, low-QPS set, not all background
     traffic. Verified MessageSentinel is `gating: true` (`MessageSentinel.ts:562`).
  2. *Breaker-damped.* Each off-Claude framework has its OWN breaker; once Codex's
     breaker opens, `resolveProvider(codex)` still returns the provider but its
     `acquire()` denies → the call tries the NEXT active off-Claude link (PI/Gemini)
     before the Claude tail. The herd that reaches Claude is only the slice where
     EVERY off-Claude link is simultaneously down.
  3. *Correct last resort.* For a gating call, Claude-when-all-else-down is
     strictly better than fail-closed (a blocked legitimate message). This matches
     the directive's "Claude = last resort."

- **[LOW — residual, NOT a blocker, but state it] The breaker only damps the herd
  if the open-circuit path is genuinely FAST for a gating caller — and §4.5's
  `rateLimitWaitMs` interaction (MEDIUM above) is exactly what threatens that.**
  §6.2 leg-2 asserts "gating calls skip Codex FAST (no repeated slow attempts)."
  But a gating caller carries `rateLimitWaitMs` (120s tone-gate / 60s coherence /
  8s unjustified-stop), so an open Codex breaker does `acquireOrWait(120s)` — NOT
  fast — UNLESS the §4.5 per-attempt cap dominates it. So §6.2's "breaker-damped"
  claim is **load-bearing on the §4.5 MEDIUM fix.** With the per-attempt cap
  correctly dominating, "skip FAST" becomes true (skip at ~5s, not 120s) and the
  herd analysis is airtight. Without it, the herd doesn't stampede onto Claude —
  it stalls on each off-Claude link for 120s and then the route budget fires a
  fail-OPEN, which is a different but equally-bad failure. **Resolution:** add one
  sentence to §6.2 noting that "skip FAST" depends on §4.5's per-attempt cap
  bounding the carried `rateLimitWaitMs`; with the cap, fast-skip holds. No design
  change beyond the §4.5 MEDIUM — just cross-reference so the two sections aren't
  silently coupled.

- **[answered] Can a broad Codex rate-limit still stampede the small gating
  population onto Claude badly?** No — "badly" is bounded by construction: the
  population is small and fixed (not amplified), each call walks PI→Gemini before
  Claude, and Claude itself is a real subscription path (the thing the agent
  already runs on). The worst case is the small gating set briefly running on
  Claude during a multi-provider outage — which is precisely today's steady state,
  not a regression. **Resolution:** none.

---

## §6.4 — garbage-but-not-erroring output (the scope-OUT challenge)

- **[verified — the scope-out is DEFENSIBLE, but the spec MISLABELS it; it is
  CALLER-HANDLED, not an open deferral].** The prompt's worry — that §6.4 is an
  improper "No Deferrals" violation — is answered by reading how the gating caller
  consumes `evaluate()`'s raw output. Grounding in `MessagingToneGate.ts`:
  - `review()` calls `provider.evaluate(...)` (line 264) and immediately runs
    `parseResponse(raw)` (line 271), which is a try/catch JSON extractor that
    **fail-opens to `{pass:true}` on any malformed/garbage output** (lines 627-646:
    no JSON match → failOpen; `typeof pass !== 'boolean'` → failOpen; parse throw →
    failOpen).
  - Beyond shape-validation, `review()` enforces **semantic** validation: a block
    verdict citing a rule NOT in `VALID_RULES` (the B1..B20 allowlist) is rejected
    and fail-opened with `invalidRule: true` (lines 277-299), and an outer
    try/catch fail-opens on any thrown error (lines 308-318).
  - So for the tone-gate, garbage-but-not-erroring output does NOT silently poison
    a gating decision: malformed JSON, a hallucinated rule id, or a non-boolean
    `pass` all collapse to a SAFE, AUDITED fail-open (`failedOpen`/`invalidRule`
    flags drive the over-block audit at `routes.ts:1753`). The caller PARSES and
    VALIDATES every answer. This is **caller-handled, not deferred.**
  - This generalizes: every gating caller in §6.3 owns its own output contract
    (MessageSentinel wraps its `evaluate` in try/catch at `MessageSentinel.ts:590`
    and fail-opens). The engine returning a string is by-design the caller's to
    interpret.

- **[MEDIUM — wording fix, real per the conformance "No Deferrals" gate] §6.4
  should be re-titled and re-framed from "scoped OUT / future follow-up" to
  "caller-handled — out of THIS spec's mechanism by correct layering."** As
  written, §6.4 ("Out of scope here; flagged for a future 'swap-target output
  sanity' follow-up") reads as an open deferral of a safety property, which is
  exactly what the conformance gate flags. The grounded truth is stronger and
  removes the deferral: output sanity for the gating decision is ALREADY handled
  by each gating caller's parse/validate/fail-open layer (verified for
  MessagingToneGate and MessageSentinel). The honest statement is: *"This policy
  does not change output-sanity handling. Each gating caller already validates its
  LLM output and fail-opens on malformed/invalid answers (MessagingToneGate:
  parseResponse + VALID_RULES check + fail-open; MessageSentinel: try/catch
  fail-open). Routing more calls to non-Claude providers does not weaken this —
  the same per-caller validation runs regardless of which provider answered. The
  ONLY residual is a provider returning a WELL-FORMED but SEMANTICALLY-WRONG
  verdict (valid JSON, valid rule id, wrong judgment), which is a pre-existing
  property of ANY LLM gate independent of provider — not introduced or broadened
  in kind by this spec."* That residual is genuinely not this spec's job and is
  not a deferral (no LLM gate on any provider can self-guarantee semantic
  correctness; it's the nature of the tool). **Resolution:** re-label §6.4
  "caller-handled (not deferred)"; cite the MessagingToneGate parse/validate/
  fail-open path as evidence; narrow the "residual" to semantically-wrong-but-
  well-formed verdicts and state that residual is provider-independent and
  pre-existing, so it is NOT a deferral introduced by this change. Drop the
  "future follow-up" framing for the malformed-output case (it's already handled).

---

## Other rewrite-introduced material

- **[LOW — verify-on-build, not a spec change] §4.2 `buildProvider` probe at boot
  vs the §4.3 boot-frozen-primary honesty.** Consistent and correctly stated:
  primary is boot-computed (install-a-higher-CLI needs a restart — documented,
  §4.3) and the swap TAIL self-heals live via the per-call `resolveProvider` null
  check (`IntelligenceRouter.ts:199-200`, grounded). No contradiction with §5's
  "no persisted block." **Resolution:** none; the §4.3 honesty fix fully resolves
  round-1 M4.

- **[LOW — confirm in test, already in §7] §4.4 boot-snapshot operator-set
  detection.** The M5 risk (CartographerSweep auto-vivifies
  `config.sessions.componentFrameworks` in memory, defeating the operator-set
  check) is correctly addressed by snapshotting the RAW on-disk value at boot.
  The §7 unit test "NOT fooled by an in-memory auto-vivify" is the right regression
  guard. **Resolution:** none; ensure the test actually mutates the live config
  object AFTER the snapshot and asserts the default still resolves (the test as
  described does this).

---

## Convergence verdict

**needs-changes** — but ALL changes are documentation/wording precision on an
otherwise-sound design; ZERO are design reversals. Three items to fold in:

1. **§4.5 (MEDIUM):** state explicitly that the per-attempt cap dominates the
   carried `rateLimitWaitMs` (120s) and that `cap × maxChainLen < routeBudget(20s)`
   is the binding invariant — name the 20s `OUTBOUND_GATE_REVIEW_BUDGET_MS` route
   budget as the ceiling. Without this the chain re-creates tonight's stall as a
   uniform `budgetExceeded` fail-open. This is the only finding with teeth.
2. **§6.2 (LOW):** add one cross-reference sentence that "skip FAST" depends on
   the §4.5 cap bounding `rateLimitWaitMs`. No new design.
3. **§6.4 (MEDIUM, wording):** re-label "scoped OUT / future follow-up" →
   "caller-handled (not deferred)", grounded in the MessagingToneGate
   parse/validate/fail-open path; narrow the residual to provider-independent
   semantically-wrong-but-well-formed verdicts. Removes the conformance-gate
   "No Deferrals" exposure.

With (1) tightened, the rewrite genuinely closes M1 rather than relocating it.
The herd (M2) and the garbage-output concern (M8) are both correctly bounded once
the wording reflects the grounded reality.

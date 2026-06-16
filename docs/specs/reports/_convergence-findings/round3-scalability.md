# Round 3 — Scalability / Perf lens

Grounded in `src/core/IntelligenceRouter.ts`, `CircuitBreakingIntelligenceProvider.ts`,
the four CLI providers, `uncaughtExceptionPolicy.ts`, `server.ts` (commands/server.ts),
`middleware.ts`. Verifying only the four requested points.

## Verified SOUND (no new material)

- **(1) N2 fix in §4.5 — CORRECT and complete.** Grounded:
  - `MessagingToneGate.ts:29` `RATE_LIMIT_WAIT_MS = 120_000` (the ≈120s inner wait) — confirmed.
  - `middleware.ts:378` `OUTBOUND_GATE_REVIEW_BUDGET_MS = 20_000` (the outer route ceiling, NOT 5s) — confirmed; the old "5s caller budget" claim is gone.
  - The cap genuinely DOMINATES the inner wait: `CircuitBreakingIntelligenceProvider.evaluate()`
    performs `await this.breaker.acquireOrWait(waitMs)` at **line 190 INSIDE `evaluate()`** — so a
    per-attempt timeout racing the whole `tp.evaluate()` abandons the rate-limit-waiting attempt at
    the cap, exactly as §4.5 states. The 120s wait cannot stack across links.
  - The non-existent `gateTimeoutMs` is replaced by the real config key `intelligence.swapAttemptTimeoutMs`.
  - Total-latency formula `cap × (1 + activeTail.length)` is correct (cap applies per inner loop attempt,
    plus the primary attempt). No remaining false latency claim.

- **(2) N5 fix — CORRECT.** The §4.2/§7 probe contract ("reuse `providerFor`'s `this.cache`") is
  grounded: `IntelligenceRouter.providerFor()` (lines 133–144) get-or-builds into `this.cache`, so an
  active-probe routed through it builds each framework **at most once at boot**, never double-built.
  The idempotent/non-networking/non-spawning `buildProvider` contract (§4.2, N7) matches the factory's
  existing minimal-CLI-detection behavior. Sound.

- **(N6 ordering, cross-checked while here) — CORRECT.** Router constructed at
  `commands/server.ts:4687`; `CartographerSweep` auto-vivify is the `??=` chain at
  `commands/server.ts:11266–11267`, mutating the SAME `config.sessions.componentFrameworks` object the
  router's `resolveConfig` reads live. Snapshot-at-construction is the right mutation-proof fix.

## (3) New Observability conformance point — AGREE, with a refinement

**Agree** a timed-out swap attempt should emit a distinct `onDegrade` signal so the cap firing is
visible (today's swap loop only fires `onDegrade` on a *successful* swap, at `IntelligenceRouter.ts:203`;
a per-attempt timeout would otherwise be invisible — the operator could not tell a slow provider was
abandoned at the cap vs. erroring normally). Without it, the §4.5 cap is an *invisible* control, which
violates the Observable Intelligence posture the spec leans on in §6.6.

**Refine — do NOT add a second degrade reason-string only; carry a machine-readable cause.** The
existing `RouterDegradeInfo` is `{component, category, from, to, reason}` where `reason` is free text.
A timed-out attempt has **no `to`** (it advanced to the *next* target, or fell to the Claude tail, or
exhausted). Emitting a degrade with a bogus `to` would pollute `/metrics/features` `frameworks`. The
clean shape is a distinct signal that names the **abandoned** framework and the cause
(`swap-attempt-timeout`), separate from the served-by `onDegrade`. Concretely: add an optional
`cause?: 'timeout' | 'error' | 'circuit-open'` (or a sibling `onSwapAttemptAbandoned` callback) so the
metric distinguishes "abandoned at cap" from "errored fast" — otherwise the cap's effectiveness can't
be measured, which is the whole point of making it visible. This is a small build-time refinement to
§4.5/§6.6, not a redesign.

## (4) NEW perf issue — §4.5 cancellation mechanism ignores the ALREADY-WIRED subprocess kill

§4.5 frames cancellation as "pass an `AbortSignal` into `tp.evaluate()` … where a provider can't cancel,
the orphan runs to completion." Grounding shows this is **more pessimistic than reality and points at the
wrong primitive**:

- `IntelligenceOptions` has **no `signal`/`AbortSignal` field today** (it has `timeoutMs` and
  `rateLimitWaitMs` — `types.ts:850–861`). So "pass an AbortSignal" requires adding a new option field
  AND threading it through every provider — net-new surface the spec doesn't budget.
- Meanwhile **all four CLI providers ALREADY honor `options.timeoutMs` and kill the subprocess on it**:
  Codex routes it to `execFile(..., { timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS })`
  (`CodexCliIntelligenceProvider.ts:365`), Claude likewise (`ClaudeCliIntelligenceProvider.ts:70`),
  Gemini/Pi pass `timeoutMs` to their spawn helpers (`GeminiCli:102`, `PiCli:92`). Node's `execFile`
  `timeout` sends **SIGTERM to the child when it fires** — i.e. the subprocess-kill the spec wants for
  the orphan already exists and is per-call configurable.

**Implication (perf / resource):** the cleanest §4.5 implementation is to set each swap attempt's
`options.timeoutMs = swapAttemptTimeoutMs` (clamped to the cap) on the `tp.evaluate()` call, so the
provider's own timeout kills the subprocess at the cap — and only ALSO race a JS timer as the belt-and-
suspenders abandon path for a provider that ignores `timeoutMs` (e.g. the interactive-pool path, which
honors `timeoutMs` at `InteractivePoolIntelligenceProvider.ts:69` but via a different mechanism). This
**shrinks the orphan window from "runs to completion" to "killed at the cap"** for the CLI providers
that are the entire default chain (codex/pi/gemini), turning the spec's "bounded waste — at most one
extra in-flight CLI per timed-out attempt" into "the CLI is actively SIGTERM'd at the cap." The spec's
fallback orphan-swallow (`.catch(()=>{})` + N1 crash-safety) is still required as the belt for the
no-kill case, but the headline mechanism should be the existing `timeoutMs`, not a not-yet-existent
`AbortSignal`.

This is a **refinement, not an unsound-fix**: §4.5's outcome (bounded latency + no orphan crash) is
achievable as written via swallow-the-orphan; but it over-states the orphan cost and reaches for a
missing primitive when a wired one (per-call `timeoutMs` → SIGTERM) does the kill the spec actually
wants, on exactly the providers in the default chain. N1's crash-safety (`.catch` + timer `unref`/clear)
remains non-negotiable regardless of which kill primitive is used.

> Note: the interactive-pool provider honors `timeoutMs` but does NOT spawn a child per call (pool
> session), so its "orphan" is a pending promise, not a subprocess — the swallow path covers it; no
> subprocess leaks there. Only the CLI providers spawn, and all four kill on `timeoutMs`.

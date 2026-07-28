# Round 3 — Decision-Completeness Convergence Check

**Spec:** `docs/specs/provider-fallback-default-policy.md` (rounds 1–2 folded in)
**Lens:** Decision-Completeness (Autonomy Principle 2). Structural convergence criterion =
ZERO live user-decisions parked.
**Scope (per directive):** verify (1) `## Open questions` still *(none)* + zero parked
user-decisions; (2) whether the round-2 fixes introduced a NEW decision that should be
frontloaded — specifically `swapAttemptTimeoutMs` default (5s), the AbortSignal cancellation
policy, the new `migrateClaudeMd` marker, and the per-provider cancellation-support
documentation; (3) confirm the final counts.
**Grounding read this round:** full spec §4.5/§8/Frontloaded/Open; `src/core/IntelligenceRouter.ts`;
`src/core/types.ts` (`evaluate(prompt, options?)` :844, `rateLimitWaitMs` :861); `src/core/
CircuitBreakingIntelligenceProvider.ts` (`acquireOrWait(waitMs)` :190); `src/core/
MessagingToneGate.ts` (gating :269, `RATE_LIMIT_WAIT_MS` :268); `src/server/middleware.ts`
(`OUTBOUND_GATE_REVIEW_BUDGET_MS = 20_000` :378); `src/core/uncaughtExceptionPolicy.ts`
(`NON_FATAL_UNCAUGHT_PATTERNS` allowlist + default-crash :17,:86); the round-2 findings.

---

## (1) Structural convergence — live user-decisions parked

- **`## Open questions` = *(none — all resolved into Frontloaded Decisions above.)*`** ✅
  Verified verbatim at spec line 430-432. No `[decide in convergence]`, `TBD`, `???`,
  `operator must choose`, or any park marker anywhere in the body.
- **`## Frontloaded Decisions`** present (lines 407-428), 4 items, each with a stated
  resolution + section cross-reference.
- **Live user-decisions parked: 0.** Structural criterion met.

## (2) Did the round-2 fixes introduce a NEW un-frontloaded decision?

The four named round-2 additions, each classified:

- **§4.5 `swapAttemptTimeoutMs` default = 5s** → **type-B, correctly resolved in-spec; NOT
  parked.** A reversible internal tuning knob behind a config key, no external contract. The
  round-2 grounding nit (the old "default ~`gateTimeoutMs`" cited a non-existent constant) is
  now FIXED in the spec text: §4.5 line 197-198 states a **5s literal**, config
  `intelligence.swapAttemptTimeoutMs`, and explicitly "*not* a pre-existing `gateTimeoutMs`,
  which does not exist." Grounding-verified: `grep swapAttemptTimeoutMs|gateTimeoutMs src/`
  returns NOTHING — both are genuinely new, the corrected claim is true. The basis is pinned
  (cap must dominate the provider's inner `rateLimitWaitMs` ≈120s, grounded: `acquireOrWait`
  honors `rateLimitWaitMs` at `CircuitBreakingIntelligenceProvider.ts:190`) and the safety
  direction is stated (fail-open per attempt). Building agent picks 5s with full in-spec
  justification; never stops to ask. **Not a user-decision.**

- **§4.5 AbortSignal cancellation policy** → **type-B, correctly resolved; NOT parked.** The
  policy is fully specified: pass an `AbortSignal` into `tp.evaluate()` where supported; where a
  provider can't cancel, the orphan runs to completion and its result is discarded (bounded
  waste — at most one extra in-flight CLI per timed-out attempt, breaker- and cap-bounded).
  Grounded: `evaluate(prompt, options?: IntelligenceOptions)` (`types.ts:844`) is an
  additive/optional INTERNAL interface — adding a `signal` field is an internal extension, not a
  published-interface break (no external/published contract touched). The orphaned-promise
  `.catch(()=>{})` requirement is a genuine HARD requirement, not a decision: grounded against
  `uncaughtExceptionPolicy.ts` (`NON_FATAL_UNCAUGHT_PATTERNS` allowlist + default-crash posture)
  — a late CLI rejection not in the allowlist WOULD crash the server, so the swallow is forced
  by safety, not chosen by taste. **Not a user-decision.**

- **§4.5 per-provider cancellation-support DOCUMENTATION ("Document which providers support
  cancellation")** → **type-B documentation task, NOT a decision at all.** This is an
  engineering deliverable (write down which providers honor `AbortSignal`), not a choice with
  branches a user must adjudicate. The design degrades safely either way (cancel where
  supported; discard the orphan where not). No taste/money/identity/irreversible/published-
  interface call. **Not a user-decision.**

- **§8 new `migrateClaudeMd` marker** → **type-B, correctly resolved; NOT parked.** §8 pins the
  exact marker: content-sniff on the NEW literal `run off Claude by default` /
  `INTERNAL_FRAMEWORK_PREFERENCE`, explicitly NOT the pre-existing
  `## Per-Component Framework Routing` heading (sniffing the existing heading would make the
  migration a silent no-op — the round-2 N4 finding, now closed in-spec). Choosing a sniff
  marker is a reversible internal migration-mechanics call; the chosen marker is the *correct*
  one (a genuinely-new string guarantees the append fires on existing agents). The two-halves
  split (generateClaudeMd EDITs in place for new agents; migrateClaudeMd APPENDs a corrective
  subsection for existing agents) correctly reflects the real constraint that `migrateClaudeMd`
  can only append. **Not a user-decision.**

**Bonus — round-2's two grounding nits are both CLOSED in the round-2→3 rewrite:** (a) the
`gateTimeoutMs` non-existent-constant nit is fixed (now a 5s literal, explicitly disclaiming the
phantom constant); (b) the "tone-gate has a 5s budget" claim is CORRECTED to the real
`OUTBOUND_GATE_REVIEW_BUDGET_MS = 20s` (grounded at `middleware.ts:378`) with the wrong "5s
caller budget" claim removed. Neither was ever a parked decision; both are now also factually
accurate.

**NEW un-frontloaded user-decision introduced by the round-2 fixes: NONE.** Every round-2
addition is type-B (internal, reversible, no external/published contract), in-spec resolved, and
fail-open/fail-closed safe by construction.

## (3) Final counts

- **frontloaded-decisions = 4** (Q1 active-probe, Q2 runtime-computed, Q4 `job` excluded,
  Q5 model-size preservation) — matches spec line 428.
- **cheap-to-change-after tags = 0** — confirmed; none of the four escalated to type-A, and the
  spec claims no "cheap-to-change" framing.
- **contested-then-cleared = 1** (Q4 `job` exclusion — contested INCLUDE vs EXCLUDE, cleared to
  the conservative type-B EXCLUDE) — matches spec line 428.

## Verdict

**CONVERGED** on the decision-completeness lens. `## Open questions` = *(none)*; zero live
user-decisions parked; all 4 Frontloaded Decisions are genuine type-B engineering choices; the
round-2 fixes (swapAttemptTimeoutMs default, AbortSignal policy, cancellation-support docs,
migrateClaudeMd marker) introduced NO new un-frontloaded decision — each is type-B and resolved
in-spec; and the two round-2 grounding nits are now closed AND factually correct. No grounding
nits remain for the building agent. Final counts: frontloaded = 4 · cheap-to-change = 0 ·
contested-then-cleared = 1.

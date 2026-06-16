# Round 2 — Decision-Completeness Convergence Check

**Spec:** `docs/specs/provider-fallback-default-policy.md` (rewritten — round-1 folded in)
**Lens:** Decision-Completeness (Autonomy Principle 2). Structural convergence criterion =
ZERO live user-decisions parked. Verify the `## Frontloaded Decisions` section resolves
Q1/Q2/Q4/Q5, `## Open questions` = *(none)*, each frontloaded item is genuinely type-B, and
the rewrite introduced no NEW un-frontloaded decision.
**Grounding:** read the full rewritten spec + `src/core/IntelligenceRouter.ts` (swap loop
193-210, `buildProvider`/`resolveProvider` 128-149, unavailable-primary degrade branch
167-182), `src/core/MessagingToneGate.ts` (gating attribution :269, fail-open :309), and the
round-1 decision-completeness findings.

---

## (1) Structural convergence — live user-decisions parked

- **`## Open questions` = *(none — all resolved into Frontloaded Decisions above.)*`** ✅
  Verified verbatim at spec line 358-360. No `[decide in convergence]`, `TBD`, `???`, or
  "operator must choose" markers anywhere in the body.
- **`## Frontloaded Decisions` section present** ✅ (lines 335-356), resolving Q1/Q2/Q4/Q5
  with a stated resolution + section cross-reference each.
- **Live user-decisions still parked: 0.** ✅ The structural criterion is met.

## (2) Are the Frontloaded Decisions genuinely type-B (not smuggled type-A)?

- **Q1 — active-probe = `buildProvider(fw) !== null`** → **type-B, correct.** Internal,
  reversible, no external side-effect, no published interface. Grounded: `resolveProvider`
  (`IntelligenceRouter.ts:148-149`) routes through the SAME `buildProvider` closure, so the
  active-set is the router's own truth — not a second, driftable notion. Captures pi-cli's
  two-precondition reality (`buildProvider('pi-cli')` returns null when unconfigured). NOT
  taste/money/identity/irreversible/published-interface. Correctly auto-resolvable.

- **Q2 — runtime-computed, no persisted config block** → **type-B, correct.** Pure internal
  representation choice; reversible; `migrateConfig()` writes nothing. The only user-visible
  surface (`GET /intelligence/routing`) is additive observability, not a contract change.
  Choosing "compute live vs. freeze a block" is an engineering call, and the chosen direction
  (live) is the *safer* one (no stale-active-set pin, unambiguous operator-override signal).
  NOT type-A.

- **Q4 — `job` EXCLUDED (only sentinel/gate/reflector)** → **type-B, correct — and the
  classification is RIGHT, but note the rewrite REVERSED round-1's lean.** Round-1
  decision-completeness recommended **INCLUDE `job`** (round1 line 17). The rewrite resolved
  the OPPOSITE way — **EXCLUDE** — citing that routing `job` off-Claude would auto-arm
  cost-bearing background jobs (CartographerSweep, whose entire design is "refuse to author
  rather than spend Claude quota") as a *side-effect of an unrelated default* (§4.1). This
  reversal does NOT make Q4 type-A: the surface is still internal, reversible, and
  operator-overridable (`categories.job` set explicitly). It is a type-B engineering choice
  either way; the author legitimately picked the **conservative** branch. The classification
  "contested-then-cleared" still holds — but the contest cleared to type-B EXCLUDE, not the
  type-B INCLUDE round-1 leaned toward. The EXCLUDE rationale is the stronger one: a
  cost-bearing feature being silently armed by an unrelated routing default is exactly the
  "auto-arm a cost-bearing background feature" anti-pattern the constitution warns against, so
  the conservative direction is correctly chosen. **Verdict: classification right, resolution
  defensible and arguably superior to round-1's lean. Not a smuggled user-decision.**

- **Q5 — model-size preservation, confirm-only** → **type-B, correct (structurally true,
  not a decision at all).** Grounded: `model: 'fast'|'balanced'|'capable'` travels per-call in
  `IntelligenceOptions` and the router passes the SAME `options` to primary and every swap
  target (`IntelligenceRouter.ts` swap loop). Orthogonal to framework by construction; no code
  added, just a pinning unit assertion. NOT a user decision.

- **Smuggled type-A among Q1/Q2/Q4/Q5: NONE.** No taste, money, identity, irreversibility, or
  published-interface contract is touched by any of the four. The `0` cheap-to-change-after
  tags claim is accurate — none of the four needed escalation to type-A.

## (3) NEW latent decisions introduced by the rewrite — un-frontloaded?

The rewrite's biggest NEW addition is **§4.5 (bounded per-attempt swap timeout)** — confirmed
genuinely new: `grep swapAttemptTimeoutMs` over `src/` returns NOTHING (it does not yet exist
in code). Three candidate latent decisions inside it:

- **§4.5 `swapAttemptTimeoutMs` DEFAULT VALUE (~5s / `gateTimeoutMs`)** → **type-B engineering,
  correctly NOT a user-decision; adequately frontloaded by §4.5's own prose.** Choosing a
  per-attempt timeout default is a reversible internal tuning knob behind a config key, with no
  external contract. The spec pins the basis ("default ~`gateTimeoutMs`, e.g. 5s") and the
  safety direction (fail-open: a timed-out attempt is just a failed attempt → next target →
  Claude tail → fail-closed if all exhausted, §4.5). The building agent can pick 5s with full
  in-spec justification; it never needs to stop and ask the user. **Not a parked
  user-decision.** *(Minor: the named basis `gateTimeoutMs` does not currently exist as a
  constant in `src/core/` — grep returns nothing — so "default ~`gateTimeoutMs`" is a directional
  hint, not a resolvable reference. The building agent must pick a concrete literal (5s is
  stated) rather than import a non-existent constant. This is a grounding nit, not a decision
  gap.)*

- **§4.5 "the tone-gate already wraps its `evaluate()` in a 5s budget"** → **grounding claim to
  re-verify, NOT a decision.** I could not confirm an explicit 5s race-wrapper around the
  `.evaluate()` call in `MessagingToneGate.ts` (gating attribution at :269, fail-open at :309,
  but no visible caller-side timeout). The spec is self-aware here and does NOT park a decision:
  "verify each gating caller imposes one; where a caller has none, the per-attempt cap ×
  chain-length is the ceiling" (§4.5). So the design degrades safely regardless of whether the
  caller budget exists — the per-attempt cap is the structural backstop. No user-decision; one
  build-time grounding assertion (does each gating caller bound its total?) that §7's
  wiring-integrity test already covers (M11). **Not a parked user-decision.**

- **§4.6 router-construction wiring point (`server.ts:~4687`, `?? computedDefault` thunk)** →
  **type-B, fully pinned in-spec** (matches round-1 latent-decision resolution). No decision left.

- **Empty-active edge / `fallback: 'default'` vs `'none'` / `categories.other` left unset** →
  all carried from round-1 latent decisions; §4.2 + §7 pin them. No NEW un-frontloaded
  decision.

**NEW un-frontloaded user-decision introduced by the rewrite: NONE.** The one genuinely-new
mechanism (§4.5 timeout) and its default value are type-B, in-spec-resolved, and the safety
direction is fail-open with a structural ceiling.

---

## Final counts

- **frontloaded-decisions: 4** (Q1, Q2, Q4, Q5) — matches the spec's stated count (line 356).
- **cheap-to-change-after tags: 0** — confirmed; none of the four needed escalation, and no
  "cheap-to-change" framing is claimed in the spec for any decision.
- **contested-then-cleared: 1** (Q4 `job` exclusion) — confirmed; classification right, cleared
  to type-B (conservative EXCLUDE).

## Verdict

**CONVERGED** on the decision-completeness lens. Zero live user-decisions parked; `## Open
questions` = *(none)*; all four Frontloaded Decisions are genuine type-B engineering choices
correctly auto-resolved; the rewrite introduced no NEW un-frontloaded user-decision. Two NON-
blocking grounding nits for the building agent (advisory, not decision gaps): (a) `gateTimeoutMs`
is not an existing constant — pick the concrete 5s literal §4.5 already states; (b) re-verify
the "tone-gate already has a 5s budget" claim at build time — the per-attempt cap is the
structural backstop if it doesn't.

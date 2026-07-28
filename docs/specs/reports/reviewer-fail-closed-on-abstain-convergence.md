# Convergence Report — Coherence Reviewers Fail CLOSED on Abstain

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI on the converged spec (verdict: directionally sound, uses existing gate machinery well; 5 refinement findings, all incorporated). Gemini-cli was also available; one successful external family pass satisfies the cross-model requirement.

## ELI10 Overview

Your agent screens every outbound message with a panel of LLM "reviewers" — one looks for leaked credentials/PII going to the wrong person, one for breaking your org's stated constraints, others for fabricated claims or hallucinated links. An audit found a quiet hole: when one of those reviewer LLM calls *errored or timed out*, the shared code silently treated it as "looks fine, send it." So during any LLM hiccup, the highest-stakes checks were skipped and the message went out unchecked.

This change makes a failed reviewer say "I couldn't check" (an *abstain*) instead of a fake "looks fine." A failed *critical* reviewer (leak, org-constraint, fabricated-claim, bad-URL) on a message going to the outside world now HOLDS the message and tells you once, rather than letting it slip through. Internal/self messages still go through (blocking those risks freezing the agent's own loop), but the abstain is recorded.

The tradeoff the review process sharpened: naive "fail closed" would have caused a worse problem — during a real LLM outage it would have bounced every blocked message back to the agent to re-write, spawning more LLM calls during the exact moment LLM capacity is scarce (a self-inflicted storm). So the final design holds-and-escalates-once with a circuit breaker instead of re-trying into a down provider, has a live operator off-switch, and makes the "critical" set a hardcoded floor that config can strengthen but never silently weaken.

## Original vs Converged

The original draft invented a brand-new "critical" reviewer tier. Review caught that the gate code **already has** a `'high'` criticality tier that does exactly the wanted behavior (block external / allow-internal on a high-stakes abstain) — and that nothing in the code reads the value `'critical'`, so the original design would have shipped a **silent no-op**: a safety "fix" that fixed nothing. The converged spec reuses the existing `'high'` mechanism and just routes errored reviewers into it (the real bug: an errored reviewer was mis-counted as a genuine pass, so the existing fail-closed net never fired).

The original also claimed held messages "ride retry, not lost." Review found that was **false** on the real path — there is no durable queue; a block bounces the draft back to the live agent, so during an outage it amplifies into repeated re-drafts and reviewer spawns. The converged spec replaces that with hold-and-escalate-once + a per-reviewer circuit breaker, and classifies the failure from **structured error types** (not by string-matching the error text — the same standard this work enforces, applied to itself), defaulting any unknown error to the safe hold. Review also closed two coverage bypasses the fix would otherwise have left open (leak-review was skipped for the default `primary-user` recipient type; short URL-free messages skipped the gate entirely), added a real per-gate kill-switch (the one the draft referenced belonged to a different gate), made the critical set a non-downgradable floor, and confirmed multi-machine uniformity.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security/adversarial, scalability/integration, decision-completeness/lessons; conformance gate (ran, 0 flags) | 2 blockers + ~10 material | Full Phase-2 rewrite: reuse `'high'` tier; abstain→tally wiring; hold-and-escalate + breaker; kill-switch; hardcoded floor; recipientType + short-message bypass fixes; multi-machine; failureSwap; CI ratchet; Frontloaded Decisions A–E; open questions → none |
| 2 | security/adversarial/scalability (all round-1 resolved, 0 new); decision/lessons/integration (1 material) + codex-cli external (concurred, 5 refinements) | 1 material + 5 refinements | Predicate-normalization (`'critical'`→`'high'` so a config value can't dead-end); explicit hold state machine; structured-error classification (no string-match); failureSwap as hard requirement + ratchet; short-message cost bound + metric |
| 3 | (converged) | 0 | none |

## Full Findings Catalog

Round 1 (blockers): (B1) `critical` tier is a no-op vs the code's `'high'` predicate → reuse `'high'`. (B2) abstain flag never reaches the tally because `review()` never rejects → intercept `abstained` in the fulfilled branch. (B3) "rides retry" false → retry/spawn amplification on the re-draft loop → hold-and-escalate + breaker. Round-1 material: weaponized fail-closed DoS; no real kill-switch; config-downgrade vector (no floor); recipientType `primary-user` leak-review skip; `<50`-char SendGateway bypass; multi-machine config divergence; `'standard'` published-type mismatch; failureSwap engagement; CI ratchet scope; SendGateway Stage-4 + MessageSentinel dispositions. All addressed in the Phase-2 rewrite (§§1–9, Decisions A–E). Round 2: predicate must treat config `'critical'` as fail-closing (addressed: normalize → `'high'`). Codex round-2 refinements: define the hold state machine (added); clarify `'critical'` is a legacy alias for `'high'` (added); structured error classes not string-matching for outage-vs-content (added); short-message cost/latency bound + metric (added); failureSwap as a hard requirement with a ratchet (added).

## Convergence verdict

Converged at iteration 3. No material findings remain; open questions = none; every code reference verified against live source by the round-2 reviewers. The spec reuses the existing gate machinery (Signal-vs-Authority compliant), fails closed in the safe direction without retry amplification, is operator-revertable, multi-machine-uniform, and carries a forward CI ratchet. Ready for user review and approval.

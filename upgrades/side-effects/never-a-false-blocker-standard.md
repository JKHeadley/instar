# Side-Effects Review — Never a False Blocker (B17_FALSE_BLOCKER)

**Slug:** `never-a-false-blocker-standard`
**Date:** 2026-05-24
**Author:** echo
**Second-pass reviewer:** internal adversarial convergence (two reviewers) + real-LLM test-as-self

## Summary of the change

Adds the constitution standard "Never a False Blocker" to `docs/STANDARDS-REGISTRY.md` and its structural enforcement: a new always-evaluated rule **B17_FALSE_BLOCKER** in `MessagingToneGate` (the outbound-message authority that hosts B15/B16). B17 holds an outbound message that defers a doable task to a person — "needs a human / I can't / second opinion / reverse-engineering" — when the message names no genuinely-human-only item and shows no inventory of the agent's own means (computer use, terminal, send-keys, MCP). The `deferral-detector` PreToolUse hook is extended (signal-only) to prime the inventory checklist for the new excuse-shapes. Registers the standard in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (P12). The sibling of B16 — feasibility-surrender (B16) vs human-deference (B17).

## Decision-point inventory

- `VALID_RULES` set — **add** `'B17_FALSE_BLOCKER'`. Without this the gate's drift-detection fails-open on a legitimate B17 citation (verified: a real-LLM B17 citation is accepted, `failedOpen=false`).
- `buildPrompt()` rule section — **add** the B17 definition after B16 (always-evaluated, no precondition), including the B16/B17 de-confliction + straddle handling + citation precedence (B15>B16>B17) + the UI-interaction clarification + a worked block example.
- Response-format enumeration + two doc comments (`B1..B16`→`B1..B17`) — **modify**.
- `deferral-detector` template (`PostUpdateMigrator.getDeferralDetectorHook`) + the deployed copy — **add** `needs_human_to` / `needs_reverse_engineering` patterns and a guarded `wants_second_opinion` (suppressed when a model/agent is named, so self-fetched cross-model review is not flagged). Checklist text updated to name the agent's own means + the tiny human-only set.
- No route changes: `checkOutboundMessage` → 422 is rule-agnostic; B17 rides the existing outbound paths.

## 1. Over-block

Principal risk: blocking legitimate escalations. Mitigated — severity favors false-negatives, and the allowlist explicitly passes: a password/secret only the user holds, CAPTCHA, legal/billing/payment authorization, **required approvals** (side-effects/policy-gated), **account/access grants**, **external rate-limit/quota waits**, genuine value judgments, deferrals after a named-outcome inventory, self-fetched cross-model review, and rule-discussion. Real-LLM test-as-self confirmed password escalation, value-judgment, and required-approval all PASS while the founding false-blocker BLOCKS — no false-positive introduced by the precision-tightening.

## 2. Under-block (a real false blocker slipping through)

Two known holes, both accepted by design:
- The gate sees only message text, so a **fabricated inventory** ("I tried everything, your call") can pass — same limit as B16, stated honestly in the rule. Mitigated by requiring *named outcomes* (not bare tool names); the hollow-inventory case is a unit assertion.
- Borderline misses are acceptable per the false-negative-favoring posture. Test-as-self caught the founding case passing initially and the prompt was tightened (UI-interaction clarification + worked example) until real Haiku blocked it.

## 3. Level-of-abstraction fit

Correct: the block authority lives inside the single outbound authority (where B15/B16 live), not in the detector. The `deferral-detector` extension is signal-only (injects `additionalContext`, never blocks). Signal-vs-authority compliant.

## 4. Blocking authority

No new brittle authority. B17 is one more rule the existing authority may cite; the 422 plumbing and fail-open behavior are inherited unchanged.

## 5. Interactions

B17 is always evaluated alongside B15/B16 in one LLM call — no extra calls, marginally longer prompt. De-conflicted from B16 (missing mechanism → B16; person required → B17; the straddle → B17) with explicit citation precedence B15>B16>B17 so telemetry is deterministic. Drift-detection unaffected (an invented rule id still fails open — regression test included). The detector's orphan-TODO patterns are preserved (the regenerated deployed copy carries them, so migration does not regress that prior improvement).

## 6. External surfaces

None. No new endpoints, credentials, or network calls.

## 7. Rollback cost

Low. Reverting removes the rule from the set + prompt, the detector patterns, and the doc entries; no state, no migration, no schema. An older server simply lacks the rule.

## 8. Test evidence

- Unit (`messaging-tone-gate-b17.test.ts`, 13 tests) + integration (`telegram-reply-b17-false-blocker.test.ts`, 2 tests) green; tsc clean; smoke suite (62 files / 2371 tests) green.
- Detector behaviorally exercised: false-blocker and reverse-engineering payloads flag; self-fetched cross-model review and clean status messages do not.
- **Real-LLM test-as-self** (real `ClaudeCliIntelligenceProvider` → Haiku, in-process against the built rule, production server untouched): founding codex-trust message + the fused straddle both BLOCK with B17; password escalation, value judgment, required approval, self-fetched second opinion, and post-inventory deferral all PASS.

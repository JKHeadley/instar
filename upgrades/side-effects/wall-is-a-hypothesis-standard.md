# Side-Effects Review — A Wall Is a Hypothesis (B16_UNVERIFIED_WALL)

**Slug:** `wall-is-a-hypothesis-standard`
**Date:** 2026-05-24
**Author:** echo
**Second-pass reviewer:** internal conformance pass

## Summary of the change

Adds the constitution standard "A Wall Is a Hypothesis" to `docs/STANDARDS-REGISTRY.md` and its structural enforcement: a new always-evaluated rule **B16_UNVERIFIED_WALL** in `MessagingToneGate` (the existing outbound-message authority that hosts B15). B16 blocks an outbound message that declares a path impossible/blocked/infeasible because an interface/API/mechanism is missing, when the message shows no evidence the agent inventoried its own capabilities first. Also registers the standard in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (the catalog the `/spec-converge` reviewer loads).

## Decision-point inventory

- `VALID_RULES` set — **add** `'B16_UNVERIFIED_WALL'`. Without this the gate's drift-detection fails-open on a legitimate B16 citation.
- `buildPrompt()` rule section — **add** the B16 definition after B15 (always-evaluated, no precondition).
- Response-format enumeration + two stale doc comments — **modify** to include B16 (the comments already lagged at B14).
- No route changes: `checkOutboundMessage` → 422 is rule-agnostic; B16 rides the existing outbound paths.

## 1. Over-block

The principal over-block risk: blocking ordinary "I can't do X" messages. Mitigated in the rule text — severity explicitly favors false-negatives; genuinely-external limits ("can't read your email until you connect it"), walls reported after a visible inventory, real either/or questions, real runtime errors, and messages discussing the rule all pass. The rule targets only the precise pattern: an internal feasibility verdict resting on a missing interface with no inventory shown.

## 2. Under-block (a real wall-surrender slipping through)

Possible if the LLM judge misses a borderline case — acceptable by design (favor false-negatives), matching the gate's stated philosophy (high signal, not adversarial correctness). The standard + the `/spec-converge` registration provide the softer review-time catch as backup.

## 3. Level-of-abstraction fit

Correct: the guard lives inside the single outbound authority (where B15 lives), not as a new detector with independent block power. Signal-vs-authority compliant.

## 4. Blocking authority

No new brittle authority. B16 is one more rule the existing authority may cite; the 422 plumbing is unchanged. Fail-open behavior (LLM error/timeout/invalid-rule) is inherited unchanged.

## 5. Interactions

B16 is always evaluated alongside B15 and the signal/health rules in one LLM call — no extra calls, marginally longer prompt. No interaction with the health-alert (B12-B14) or style (B11) rules, which remain gated by their preconditions. The drift-detection branch is unaffected (an invented rule id still fails open — covered by a regression test).

## 6. External surfaces

None. No new endpoints, credentials, or network calls. The standard's enforcement claim was verified against code before authoring (the registry is not parsed at runtime; the conformance gate and Usher are unbuilt North Star designs) — so the "Applied through" line states only what exists.

## 7. Rollback cost

Low. Reverting removes the rule from the set + prompt and the doc entries; no state, no migration, no schema. An older server simply lacks the rule.

## 8. Test evidence

Unit (`messaging-tone-gate-b16.test.ts`, 9 tests) + integration (`telegram-reply-b16-wall.test.ts`, 2 tests) green; tsc clean. Both sides of the decision boundary covered with realistic inputs; the /goal-style wall blocks through the real route (422, message suppressed) and the happy path still delivers (200).

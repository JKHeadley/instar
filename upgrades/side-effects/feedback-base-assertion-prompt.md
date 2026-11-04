# Side-Effects Review — Feedback worker base proof wording

**Version / slug:** `feedback-base-assertion-prompt`
**Date:** 2026-11-03
**Author:** Echo
**Second-pass reviewer:** independent read-only reviewer concurred after clarification

## Summary of the change

The one-line worker instruction in `src/feedback-factory/execute/executorSession.ts` now states that an existing-behavior base test must fail by a Vitest assertion and gives a thrown-error example. `tests/unit/feedback-factory/execute-units.test.ts` checks the rendered instruction. The executable base-failure classifier is unchanged.

## Decision-point inventory

- Base-failure classifier — pass-through — still accepts assertion failures and its narrow missing-new-source exception.
- Worker test-writing choice — modified guidance — directs the worker to express thrown defects as assertions.

## 1. Over-block

No new block or allow surface. A worker may overread the wording as excluding new-file tests; the prompt explicitly states the existing narrow exception.

## 2. Under-block

The worker can still write a poor test or ignore the instruction. The unchanged base check rejects non-assertion failures, and independent review remains required before merge.

## 3. Level-of-abstraction fit

The mismatch is at the worker instruction boundary. The executor classifier already owns the deterministic proof rule, so changing that authority would weaken evidence. This change aligns the prompt with the existing rule.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

- [x] No — this change has no new block/allow surface.

The prompt guides test writing; the existing deterministic base-proof gate remains the only authority at this boundary. The gate checks an enumerable assertion-or-new-source proof shape, not an open-ended judgment about report meaning.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The existing gate's proof shape is unchanged.

## 5. Interactions

- **Shadowing:** The guidance runs before base-check, so a compliant worker avoids a refusal. It does not shadow the check.
- **Double-fire:** No new executor action or notification is added.
- **Races:** No shared state is changed.
- **Feedback loops:** A failed attempt may be retried under the existing bounded executor policy; this change adds no retry loop.

## 6. External surfaces

The instruction is visible to feedback workers on agents that install the new package. It does not change APIs, persistent records, user messages, or timing. No operator-facing action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Replicated through the published Instar package and normal update path. It emits no user-facing notices, holds no durable state, and generates no URLs. Existing attempts keep their historical prompt; new attempts receive this wording after update.

## 8. Rollback cost

Revert the one-line prompt change and test in a patch release. There is no migration or persistent state to repair. Workers started on the previous release may still hit the old wording until they complete.

## Conclusion

The prompt now states the proof requirement the executor already enforces. The independent reviewer found an initially overbroad sentence; adding the missing-new-source exception resolved it. The change is ready for normal verification and PR review.

## Second-pass review

**Reviewer:** `/root/feedback_gate_review`
**Independent read of the artifact:** The reviewer independently reviewed the code wording before this artifact and concurred after the exception was made explicit; artifact-specific review has not been requested.

## Evidence pointers

- Focused executor unit tests: 53 passed on head `b0584d9` before audit-artifact amendment.
- Live attempt `feedback-e800bf35-6381-46e7-a769-1530c55ac7ac:a4` stopped at `base-check:not-an-assertion-failure`.

## Class-Closure Declaration (display-only mirror)

- `defectClass`: `prompt-parser-contract-drift`
- `closure`: `guard`
- `guardEvidence`: `ratchet`, `tests/unit/feedback-factory/execute-units.test.ts`; the prompt contract test asserts that the worker sees the existing-behavior assertion requirement and the new-source exception, catching a recurrence of this wording gap.

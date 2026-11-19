# Side-Effects Review — Fix sessions see the independent review's rules

**Version / slug:** `executor-worker-sees-review-rules`
**Date:** `2026-11-17`
**Author:** `Echo`
**Second-pass reviewer:** `not required` (the review gate's own prompt and verdict logic are byte-identical; only the confined worker's instructions grow)

## Summary of the change

Tier 1, 3 source/test files plus artifacts (about 130 added lines, 9 removed). Effort: no spec rounds, one build pass.

The feedback executor's independent review refuses fix PRs on six rules (Scope, Tooling, Secrets and reach, Tests, Injection, Breakage) that the build session was never shown, so fixes kept failing on avoidable points (PR 3261: credential-looking fixture literals and a replaced `process.env.HOME`; PR 3252: a catch widened beyond the brief with no test; PR 3292: existing tests weakened by added delays). The rule lines move verbatim into a new module, `src/feedback-factory/execute/reviewRules.ts` (`reviewRuleLines(kind)`, `REVIEW_RULE_HEADINGS`, `workerReviewRulesSection(kind)`). `independentReview.ts → buildExecutorReviewPrompt` spreads `reviewRuleLines(input.kind)` where the literal lines were; its output is byte-identical (sha256 pinned in the new test, and the pin was verified against the unmodified upstream file). `executorSession.ts → buildExecutorPrompt` adds the section "Your change will be refused by an independent reviewer if any of these hold:" with the same lines (spec variant for spec-drafting items) and short practical guidance, placed after the task and before the result-file contract.

## Decision-point inventory

- Independent review admission (`judgeIndependentReview`, reviewer prompt) — pass-through — the reviewer reads the same rule text from a new location; no verdict logic or wording changes.
- Build-session prompt — modify — informational text only; it decides nothing.

---

## 1. Over-block

No block/allow surface added. The worker prompt is guidance to a confined session; nothing is refused on its basis. The reviewer's rules are unchanged, so it refuses exactly what it refused before.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The worker can still ignore the guidance; the reviewer, the diff gate and the secret gate still catch that, as before.

---

## 3. Level-of-abstraction fit

Right layer: the rules belong to the review, and the worker is the producer the review judges. One shared constant consumed by both prompt builders is the smallest structure that keeps them in step (Structure > Willpower), instead of copying the text into a second prompt that would drift.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The authority (the two LLM reviewers plus the admission rule) is untouched. The worker prompt gains information, not authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

- **Shadowing:** none; the reviewer prompt bytes are identical.
- **Double-fire:** none.
- **Races:** none; pure string builders.
- **Feedback loops:** the rework path (`previousReviewFile`) still feeds prior findings; the rules section now sits alongside it, so a rework attempt sees both the general rules and the specific findings. Rule 2's parenthetical "(The executor should already refuse these…)" and rule 5's "aimed at you" read slightly reviewer-addressed in the worker prompt; they are still accurate statements of what is refused, and keeping the lines verbatim is the point of one source.

---

## 6. External surfaces

- Other agents / install base: agents running the feedback executor get longer build-session prompts (about 2.5 KB more). No config, state or API change.
- External systems: none. No new network, shell-out or file access.
- Persistent state: none.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: prompt text is computed in-process from shipped code on whichever machine runs the executor attempt; every machine on the same version builds the same text. No notices, no durable state, no URLs. No status surfaces changed.

---

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state, no migration, no user-visible regression during rollback.

---

## Conclusion

Clear to ship. The reviewer prompt is pinned byte-identical; the worker prompt gains the same rules from the same source plus concrete guidance mapped to the three recent refusals.

---

## Evidence pointers

- `tests/unit/feedback-factory/execute-review-rules-shared.test.ts` — worker prompt contains every rule heading and every rule line for both kinds; reviewer prompt sha256 pinned (fix `f2de9e1b…`, spec `2c5c38a7…`), the pin checked against the upstream `independentReview.ts`.
- Existing `tests/unit/feedback-factory/execute-independent-review.test.ts` and `execute-units.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `prompt-parser-contract-drift` (the build-session prompt drifted from the contract its consumer, the independent reviewer, enforces).
- **`closure`** — `guard`.
- **`guardEvidence`** — `{enforcementType: ratchet, citation: tests/unit/feedback-factory/execute-review-rules-shared.test.ts, howCaught: both prompts render from reviewRuleLines(), and the test fails if the worker prompt lacks any rule line the reviewer applies}`.

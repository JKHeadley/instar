# Side-Effects Review — LLM benchmark-coverage ratchet (INSTAR-Bench v2 §6, ratchet #2)

**Version / slug:** `llm-bench-coverage-ratchet`
**Date:** `2026-07-02`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (build-time test + data map only; zero runtime surface)

## Summary of the change

Adds `src/data/llmBenchCoverage.ts` — a coverage ledger mapping every LLM component (every key of `COMPONENT_CATEGORY`) to its INSTAR-Bench v2 status: `{task}` covered (10 Wave-1 critical components), `{pending}` queued (42, pinned), or `{exempt}` argued (1) — and `tests/unit/llm-bench-coverage-ratchet.test.ts`, which fails CI when a new LLM component ships without a coverage decision, when the pending/exempt sets grow (shrink-only pins), when an exemption's argument is lazy (<40 chars), or when a Wave-1 critical component slides back to uncovered. Operator directive 2026-07-02 (topic 29723) + INSTAR-BENCH-V2-SPEC §6. No runtime code is touched.

## Decision-point inventory

None at runtime. The only "decision" is a CI pass/fail on repository content — a build-time ratchet identical in class to the existing `llm-attribution-ratchet`.

## 1. Over-block
The ratchet can block a COMMIT (not a message/action): a developer adding an LLM component who genuinely cannot author bench cases yet must add the component to the pending baseline inside the test — a deliberate, visible act. That is the intended cost, not an over-block; there is no path it rejects that it shouldn't (an argued exemption is always available).

## 2. Under-block
Honest limits: (a) the ratchet keys off `COMPONENT_CATEGORY` — an LLM callsite that dodges the category map would also dodge this map, but the companion evaluate-coverage wiring test + attribution lint close that hole upstream; (b) it cannot verify the bench task file CONTENT (those live in the bench harness on the benching agent) — the task id is a contract, and a wrong/empty id would surface at the next bench run, not in CI. Accepted for v1 of the ratchet; noted in the map docblock.

## 3. Level-of-abstraction fit
Right layer: repository data + unit test, the established ratchet pattern (`llm-attribution-ratchet`, `WIRING_EXCLUSIONS` pins). Extends the existing chain (callsite → category map → THIS → bench coverage) rather than inventing a parallel mechanism.

## 4. Signal vs authority compliance
Compliant. No runtime authority; a CI test is deterministic, cheap, and its "block" is a build failure with instructions. (docs/signal-vs-authority.md concerns runtime decision points; none added.)

## 5. Interactions
Complements `llm-attribution-ratchet` (attribution presence), `componentCategories` wiring test (map exhaustiveness), and the LLM Routing Registry doc. No double-fire: each guards a different link of the chain. No runtime interaction possible.

## 6. External surfaces
None. Not user-visible; no API, no message, no config.

## 7. Multi-machine posture (Cross-Machine Coherence)
Not applicable — repository content evaluated in CI; identical on every machine by construction (git).

## 8. Rollback cost
Delete the test + map (one revert). No state, no migration, no fleet impact — the ratchet only ever constrained future commits.

## Test evidence
`llm-bench-coverage-ratchet.test.ts`: 6 tests — completeness over COMPONENT_CATEGORY, no dangling entries, pending pinned shrink-only, exemptions pinned + argued, non-empty task ids, Wave-1 regression pin. All green; `tsc --noEmit` clean.

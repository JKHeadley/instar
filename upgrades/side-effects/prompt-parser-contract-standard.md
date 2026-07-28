# Side-Effects Review — Prompt↔Parser Contract Standard (defect class 1, dark increment)

**Version / slug:** `prompt-parser-contract-standard`
**Date:** `2026-07-03`
**Author:** `echo`
**Tier:** `1 (dark increment — additive library + classification + pinned ratchet; no runtime wiring, no live prompt/parser change, no operator-gated text)`

## Summary of the change

The mechanical arm of the "The Prompt and the Parser Are One Contract" standard (defect class 1 closure; `docs/specs/prompt-parser-contract-standard.md`), shipped as a self-contained DARK increment. It ships:

1. **`src/core/promptContract.ts`** — the shared prompt↔parser contract library. The `PromptContract` manifest type (a co-located, machine-readable promise carried next to a prose-shaped prompt), the `ContractForm` election type, and `deriveRejectedForms(vocabulary, extras, options)` — a PURE generator for the fail-closed counter-examples a per-callsite contract test feeds the REAL parser (case-mutation, prefix-truncation at each separator — the exact B15 shape — separator-stripping, plus hand-picked extras, minus any form that collides with a promised token). No runtime caller in this increment.
2. **`src/data/llmBenchCoverage.ts`** (additive) — `LLM_PARSER_CONTRACT`, the `contract` axis of the program's shared per-callsite metadata record. Required-explicit for every `COMPONENT_CATEGORY` key; the four spec-named highest-stakes callsites seed `contract-wave-1`, other enumerated-verdict callsites are `contract-wave-2`, and a no-closed-vocabulary callsite is `{ false: '<reason>' }`.
3. **`tests/unit/parser-contract-classification-ratchet.test.ts`** — required-explicit + no-dangling + valid-wave + wave-1 seed floor + shrink-only pending + shrink-only argued-false + real-reason floor + the gate/sentinel cross-check lint.
4. **`tests/unit/promptContract.test.ts`** — the derive-rejected-forms mutation logic (incl. the B15 prefix shape, collision-exclusion, purity) and the manifest type surface.
5. **`docs/specs/prompt-parser-contract-standard.md`** + **`.eli16.md`** — the converged spec and its plain-English overview.

## What is DELIBERATELY out of scope (not orphan deferrals)

- **The per-callsite contract tests + the live-builder render refactor (spec rollout §0/§1).** A contract test renders the REAL production prompt through an exported pure render function; several production builders (e.g. `MessagingToneGate`'s prompt builder) are private instance methods with live deps and need that render refactor, which TOUCHES live parsing code. Per the CAREFUL constraint on this defect class (live, load-bearing parsers), that refactor is deferred to its own A/B-gated increments, one callsite at a time, so live parse behavior is UNCHANGED on this merge. The four siblings deferred their behavioral/render arms for exactly this reason; this increment mirrors that.
- **The runtime contract-drift warning (spec Frontloaded Decision #3 / "Decision points touched" (a)).** A signal-only prompt-build-time assertion that also touches the live builders; it lands with the by-construction single-sourcing migrations, not this inventory increment.
- **The registry / constitution text (spec §1).** Operator-gated — ships ONLY with Justin's explicit sign-off (spec front-matter `operator-gate`). The registry entry is DRAFTED in the spec; this run does not write `docs/STANDARDS-REGISTRY.md`.

## Decision-point inventory

- `src/core/promptContract.ts` — **add** — a pure library (types + string/array helpers). NO runtime caller in this increment (dark by construction); it changes NO prompt text and NO parser until a per-callsite contract test + render refactor lands through its own gate. No allow/deny surface.
- `LLM_PARSER_CONTRACT` classification (`src/data/llmBenchCoverage.ts`) — **add** — build-time metadata only. Read by the new pinned ratchet; no runtime consumer. A SIGNAL producer (which callsites parse a taught output vocabulary), never a runtime authority.
- The two new vitest tests — **add** — CI-only pinned baselines (same family as `llm-bench-coverage-ratchet`). The ratchet gates the build (adding an unclassified callsite / growing the pending or false set silently is red CI), never a runtime path.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None at runtime — nothing is wired to a runtime allow/deny path, and no live prompt or parser changes, so no model answer that was accepted before is rejected now. At CI/build time the only new red-CI surfaces are: (a) adding a new LLM component to `COMPONENT_CATEGORY` without an explicit `contract` classification, (b) growing the pending or argued-false set without editing the pinned baseline, and (c) marking a gate/sentinel `false` without the reviewed allowlist. All three are intentional, self-describing failures with fix-instructions in the assertion message — the "visible, reviewed act" the standard exists to force, not an over-block of legitimate work.

## 2. Under-block

**What failure modes does this still miss?**

- This increment adds NO test that a callsite's prompt and parser are ACTUALLY coherent — that is the per-callsite contract test, deferred with its render refactor. So a classified-`pending` callsite can still ship a drifted prompt↔parser until its contract test graduates. This is the known staged-rollout gap, tracked in the spec's rollout §0→§3, not a silent miss — the pending set IS the honest inventory of that remaining work.
- Classification accuracy is author-judged against a stated criterion (a CLOSED taught verdict vocabulary → needs a contract; free-text / open-set / no-live-prompt → `false`). A mislabel of a gate/sentinel is partly caught by the cross-check (the highest-risk category); a reflector/job mislabeled `false` would pass. The argued-false shrink-only pin makes every such call visible and reviewed at PR time; this seeding PR IS that review.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The contract library is a pure `src/core/` module (the layer where shared prompt/parser scaffolding belongs — sibling to `promptClauses.ts` from the authority-clause standard); the classification extends the ONE shared metadata record the program mandates (`src/data/llmBenchCoverage.ts`), not a new parallel registry; the ratchet is in the established pinned-baseline vitest family. No higher gate already owns "does the prompt's taught vocabulary match the parser"; no lower primitive is duplicated.

## 4. Signal vs authority compliance

The classification and the ratchet are SIGNALS (which callsites parse a taught vocabulary; is the pending/false inventory shrink-only) — they inform the build and the reviewer, never grant or deny a runtime action. `deriveRejectedForms` returns an array; it is inert until a contract test consumes it. No model-produced field is wired to satisfy any authorization check. The library changes no live parser's accept/reject decision.

## 5. Interactions with existing systems

- **`llm-bench-coverage-ratchet` / `untrusted-input-classification-ratchet`** — unaffected: `LLM_PARSER_CONTRACT` is a NEW additive export; the existing `LLM_BENCH_COVERAGE` and `LLM_UNTRUSTED_INPUT` records and their ratchets are untouched (all green post-change). The argued-false membership is consistent with the sibling axes' "no live judging/parsing callsite" reasoning where they overlap (PromiseBeacon, InteractivePoolCanaryJudge, AutoApprover, IntegrationGate, CoherenceGate, InputDetector), and adds the free-text-content reflectors/summarizers on top (which parse no closed verdict vocabulary).
- **`lint-scrape-fixture-realness`** — the new helper is named `deriveRejectedForms` (not `parse*`/`scrape*`), so it is deliberately outside that lint's `parse*`/`scrape*` surface; it consumes no untrusted real-world text (it operates on a callsite's own declared vocabulary constant).
- **green-PR auto-merge protected paths** — `src/data/llmBenchCoverage.ts` is already in the class-closure agent-authored-artifact predicate; the pinned ratchet baselines route every future classification/pending/false edit to operator review while a fully-conforming graduation (pending→contractTest) keeps auto-merge (program-shared machinery).

## 6. Failure modes / rollback

Pure additive TypeScript + tests + docs. Rollback = revert the commit; nothing persists state, nothing runs at runtime, no migration, no config key (no agent-side config key exists or is wanted — repo posture only, so no Migration Parity work). `tsc --noEmit` clean, `npm run lint` exit 0, all new + adjacent ratchets green under bounded single-file vitest runs (the machine has intermittent external CPU pressure; verification used bounded runs per the CI-as-gate pattern, full suite gated by CI).

## 7. Second-pass reviewer

Self-review (bounded machine-pressure build). The change is additive, dark, and test-pinned; no runtime surface and no live prompt/parser touched. Key self-checks: (1) confirmed `deriveRejectedForms` never emits a promised token as a "rejected form" (the collision-exclusion test), so a future contract test's accept/reject assertions cannot contradict; (2) confirmed the classification covers all 53 `COMPONENT_CATEGORY` keys exactly once (the required-explicit + no-dangling ratchet asserts it); (3) confirmed the wave-1 seed is exactly the four spec-named highest-stakes callsites; (4) confirmed no `src/` file outside tests imports `promptContract.ts`, so the increment is dark by construction.

# Side-Effects Review — Authority-Clause Standard (defect class 2, dark increment)

**Version / slug:** `authority-clause-standard`
**Date:** `2026-07-03`
**Author:** `echo`
**Tier:** `1 (dark increment — additive library + classification + pinned ratchets; no runtime wiring, no operator-gated text)`

## Summary of the change

The mechanical arm of the "Authority Lives Outside the Content" standard (defect class 2 closure; `docs/specs/authority-clause-standard.md`), shipped as a self-contained DARK increment. It ships:

1. **`src/core/promptClauses.ts`** — the shared authority-clause library. `authorityClause(judgedThing)` (the exact base wording from spec §2), two per-category suffix builders (`judgesClaimsSuffix` gate-flavored, `durableOutputSuffix` writer-flavored), and `clausesFor(flags, judgedThing)` — the ONE composer that emits a single deduplicated clause block from a callsite's flag set, honoring the composition rule `durableOutput ⇒ untrustedInput`. A `AUTHORITY_CLAUSE_VERSION` constant anchors the versioning discipline (wording edits ship as a new versioned export, never an in-place mutation).
2. **`tests/unit/promptClauses.test.ts`** — the pinned golden-content test (change control §2) plus composition/dedup tests.
3. **`src/data/llmBenchCoverage.ts`** (additive) — `LLM_UNTRUSTED_INPUT`, the `untrustedInput` axis of the program's shared per-callsite metadata record. Required-explicit for every `COMPONENT_CATEGORY` key; argued-false written as `{ false: '<reason>' }`.
4. **`tests/unit/untrusted-input-classification-ratchet.test.ts`** — required-explicit + no-dangling + argued-false-pinned-shrink-only + the sentinel/gate cross-check lint (design §3).
5. **`docs/specs/authority-clause-standard.eli16.md`** — the plain-English overview.

## What is DELIBERATELY out of scope (not orphan deferrals)

- **The registry / constitution text (spec §1).** Operator-gated — ships ONLY with Justin's explicit sign-off (spec front-matter `operator-gate`). The registry entry is DRAFTED in the spec; this run does not write `docs/STANDARDS-REGISTRY.md`.
- **The render-lint (spec §2) and the bench-axis battery ratchet (spec §4).** Both depend on program-wide frontloaded infrastructure not yet landed on canonical main: (a) the prompt-parser render-harness contract-test machinery for the sentinel-string / delimiter / per-slot assertions, and (b) the "batteries readable by CI" decision (`research/` is absent from main; the consolidated axis ratchet must read committed batteries or a distilled per-task axis manifest — `class-closure-gate.md` §"Program-shared machinery" #2, binding all three axis specs). Landing either inside a single sibling PR would be doing shared cross-program work under one standard's name. The keystone (#1347) staged the axis-requirements ratchet identically into its OWN dark increment 3.
- **Per-component A/B migrations to the shared clause (rollout step 2).** Behavioral prompt-text changes, each gated by the A/B protocol — a downstream task, not this dark increment.

## Decision-point inventory

- `src/core/promptClauses.ts` — **add** — a pure string-building library. NO runtime caller in this increment (dark by construction); it changes NO prompt text until a component migrates to it through its own A/B. No allow/deny surface.
- `LLM_UNTRUSTED_INPUT` classification (`src/data/llmBenchCoverage.ts`) — **add** — build-time metadata only. Read by the new pinned ratchet; no runtime consumer. A SIGNAL producer (which callsites judge untrusted content), never a runtime authority.
- The two new vitest ratchets — **add** — CI-only pinned baselines (same family as `llm-bench-coverage-ratchet`). They gate the build (adding an unclassified callsite / editing clause wording is red CI), never a runtime path.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None at runtime — nothing is wired to a runtime allow/deny path. At CI/build time the only new red-CI surfaces are: (a) editing a pinned clause string without adding a new versioned export, and (b) adding a new LLM component to `COMPONENT_CATEGORY` without an explicit `untrustedInput` classification (or flipping an argued-false without touching its pinned baseline). Both are intentional, self-describing failures with fix-instructions in the assertion message — the "visible, reviewed act" the standard exists to force, not an over-block of legitimate work.

## 2. Under-block

**What failure modes does this still miss?**

- The clause is a per-prompt MINIMUM, not the whole defense. A model that reads the clause can still be manipulated; the deterministic out-of-band verification (mandate gate / verified-operator binding) remains primary for authority-sensitive callsites. This increment adds no enforcement that a callsite ACTUALLY renders the clause (that is the render-lint, deferred) — so a classified-`true` callsite can still ship clause-less until the render-lint enforcing flip. This is the known staged-rollout gap, tracked in the spec's rollout steps 1→3, not a silent miss.
- Classification accuracy is author-judged. A mislabel (`true` marked `false`) is partly caught by the sentinel/gate cross-check (the highest-risk mislabels), but a reflector/job mislabeled false would pass. The argued-false shrink-only pin makes every such call visible and reviewed at PR time; this seeding PR IS that review.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The clause library is a pure `src/core/` string builder (the layer where shared prompt fragments belong — sibling to the existing prompt-parser modules); the classification extends the ONE shared metadata record the program mandates (`src/data/llmBenchCoverage.ts`), not a new parallel registry; the ratchets are in the established pinned-baseline vitest family. No higher gate already owns "where does prompt authority live"; no lower primitive is duplicated.

## 4. Signal vs authority compliance

The classification and the ratchets are SIGNALS (which callsites judge untrusted content; is the clause wording unchanged) — they inform the build and the reviewer, never grant or deny a runtime action. The clause text itself, once consumed, makes a model REPORT an in-content authority claim rather than CREDIT it — it explicitly relocates authority OUTSIDE the content to the out-of-band check. It never becomes the authority. `clausesFor` returning a string is inert until a caller renders it. No model-produced field is wired to satisfy an authorization check.

## 5. Interactions with existing systems

- **`llm-bench-coverage-ratchet`** — unaffected: `LLM_UNTRUSTED_INPUT` is a NEW additive export; the existing `LLM_BENCH_COVERAGE` union and its ratchet are untouched (both green post-change). The argued-false membership mirrors the bench-coverage exemption set's "no live untrusted-judging callsite" reasoning (same six components), so the two records tell a consistent story.
- **`class-closure-lint.mjs`** — already names `src/core/promptClauses.ts` and `src/data/llmBenchCoverage.ts` as agent-authored artifacts (the keystone pre-registered the protected path); this increment fills in the file it anticipated.
- **green-PR auto-merge protected paths** — `src/core/promptClauses.ts` is in the class-closure agent-authored-artifact predicate; the pinned ratchet baselines route every future classification/exemption edit to operator review while a fully-conforming new callsite entry keeps auto-merge (program-shared machinery §4).

## 6. Failure modes / rollback

Pure additive TypeScript + tests. Rollback = revert the commit; nothing persists state, nothing runs at runtime, no migration, no config key (spec §"Decision points touched": no agent-side config key exists or is wanted — repo posture only, so no Migration Parity work). tsc clean, `npm run lint` exit 0, all new + adjacent ratchets green under bounded runs (machine was under heavy external CPU pressure; verification used bounded single-file vitest per the CI-as-gate pattern, full suite gated by CI).

## 7. Second-pass reviewer

Self-review (bounded machine-pressure build). The change is additive, dark, and test-pinned; no runtime surface. Key self-check: confirmed the argued-false set is defensible (each entry has no live LLM callsite that sees external content — grep-consistent with the bench-coverage exemptions), and the composition rule + dedup are covered on both sides in `promptClauses.test.ts`.

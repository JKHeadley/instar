# Side-effects review — Phase 5b.2 (TaskClassifier + OverrideDetector)

**Version / slug:** `phase-5b2-task-classifier-override-detector`
**Date:** `2026-05-15`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (two narrow LLM-backed classifiers with strict parsers and fail-safe-to-no-override / fail-safe-to-unclassified-sentinel paths; full branch coverage)
**Driving spec:** `specs/provider-portability/10-suggest-and-confirm-ux.md`

## Summary of the change

Second implementation slice of Phase 5b. Lands the two LLM-backed classifiers the UX needs:

1. **`TaskClassifier`** (`src/providers/uxConfirm/TaskClassifier.ts`) — maps a task prompt to a stable kebab-case slug (the `taskPattern` cache key used by Phase 5b.1's PreferenceStore). Fast-tier IntelligenceProvider call with a curated one-shot prompt. Strict slug validator (lowercase-with-hyphens, 3–80 chars, no embedded sentinel). Errors and malformed output collapse to `UNCLASSIFIED_PATTERN` so the TriggerGate routes through `ask-new-pattern` (the safe outcome).

2. **`OverrideDetector`** (`src/providers/uxConfirm/OverrideDetector.ts`) — passively inspects user messages for routing overrides ("use Gemini for this one", "always use Codex for refactors"). Fast-tier call with JSON output. Returns a discriminated union: `{ overrideRequested: false }` or `{ overrideRequested: true, framework?, model?, scope }`. Slugs are normalized against the caller's known-frameworks / known-models lists; out-of-list slugs are discarded rather than propagated downstream. Empty / whitespace messages return no-override without calling the LLM.

The other Phase 5b components (TelegramConfirmer, FrameworkModelRouter composition root) remain to land in subsequent slices.

Files touched:
- `src/providers/uxConfirm/TaskClassifier.ts` — new, 164 LOC.
- `src/providers/uxConfirm/OverrideDetector.ts` — new, 188 LOC.
- `tests/unit/providers/uxConfirm/TaskClassifier.test.ts` — new, 13 cases.
- `tests/unit/providers/uxConfirm/OverrideDetector.test.ts` — new, 20 cases (12 parsing + 8 phrasing variants per spec AC #6).

## Decision-point inventory

This change adds two signal producers — neither is a blocking authority.

- **`TaskClassifier.classify`** — `add`. Returns a pattern slug. PreferenceStore (Phase 5b.1) keys cache rows by this slug; TriggerGate (Phase 5b.1) reads the cached row. The classifier doesn't decide anything itself.
- **`OverrideDetector.detect`** — `add`. Returns a structured override request or no-override. The UX layer (not yet implemented) decides what to do with the result. The detector doesn't apply overrides itself.

Both classifiers fail-safe in the same direction: when they can't produce confident output, they return the value that triggers the user being asked. False-negative (missed override) means the user gets the cached pick — they can override again. False-positive (spurious unclassified) means the UX asks — annoying but never wrong.

## Signal vs authority

Both classes are signal producers. Per the locked principle that brittle/low-context filters cannot have blocking authority:

- The detection is LLM-backed (intelligent), not regex-backed, per the "intelligence over string matching" rule.
- Even the LLM doesn't have blocking authority — the UX layer above interprets the structured result and decides whether to act on it.
- All parsing failures collapse to the safe outcome (unclassified / no-override), never to a confident wrong answer.

## Over-block / under-block analysis

**TaskClassifier — over-classify (asking too often):**
- The fallback path produces `unclassified` which Phase 5b.1's TriggerGate treats as `ask-new-pattern`. If the LLM has a flaky day, the user sees more confirmation prompts. Acceptable — a few extra prompts are a cheap price for not silently auto-using a wrong cache key.

**TaskClassifier — under-classify (silent miss):**
- Distinct-shape tasks colliding to the same slug means the user's "yes" to one carries to the other. Mitigation: the curated prompt examples bias toward 2-4 segment slugs that retain enough specificity ("code-refactor-typescript" not "code"). The classifier's max slug length (80 chars) leaves room for granularity when the LLM picks it.

**OverrideDetector — false-positive (spurious override):**
- Detecting an override when the user is just musing ("I wonder if Gemini would handle this better") would apply a routing change the user didn't intend. Mitigation: the JSON contract requires the model to set `override: true` explicitly, and the in-prompt examples include a "follow-up clarifications → false" rule. Production tuning may require additional negative examples.

**OverrideDetector — false-negative (missed override):**
- Missing a user's "use Gemini" means the cached pick runs. The user can re-issue the override or use `/route` explicitly. Same correction loop as TaskClassifier — not silently wrong, just slightly less convenient.

## Level-of-abstraction fit

- Both classifiers live in `src/providers/uxConfirm/` next to the gate and store they feed. No cross-cutting concerns.
- `TaskClassifier` does NOT depend on the framework / model catalogs — it produces a slug that's independent of routing. This keeps Phase 5b survivable across catalog churn.
- `OverrideDetector` takes the known-frameworks / known-models lists as constructor args. The application layer wires the current catalog state through. No baked-in catalog references.

## Interactions

- **Phase 5b.1 (`PreferenceStore`, `TriggerGate`)** — `TaskClassifier`'s output is `PreferenceStore`'s cache key; `TriggerGate` consumes the cached row to decide whether to invoke the UX flow.
- **`IntelligenceProvider`** — both classifiers route through the existing fast-tier abstraction. No new credential surface, no new provider integration.
- **No existing source file is modified.** Pure addition.

## External surfaces

- New exports: `TaskClassifier`, `TaskClassifierOptions`, `ClassifyInput`, `ClassifyResult`, `UNCLASSIFIED_PATTERN`; `OverrideDetector`, `OverrideDetectorOptions`, `OverrideDetectInput`, `OverrideDetectResult`, `OverrideScope`.
- No new endpoint, no new CLI command, no new config field, no new LLM credential pathway.

## Rollback cost

Trivial. `git revert` removes four files. No persistent state, no runtime callsite consumes these yet — TelegramConfirmer is the next slice and will be the first consumer.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/providers/uxConfirm/` — 56/56 pass (11 + 12 from 5b.1; 13 classifier + 20 detector from this slice).
- TaskClassifier branch coverage: ok path, leading-prefix strip, quotes strip, lowercase normalization, illegal chars → fallback, too-short → fallback, too-long → fallback, sentinel-echo → fallback, provider-throws → fallback, fast-tier opts, prompt embedding, tag append, truncation, custom template.
- OverrideDetector branch coverage: empty bypass, JSON-false → no-override, throws → no-override, non-JSON → no-override, known-list normalization (framework + model), unknown-slug discard, all-null cheaper-one path, invalid-scope default, JSON-amid-prose extraction, fast-tier opts, truncation.
- Spec AC #6 (8+ phrasing variants): all 8 cases pass with the production-prompt-shaped LLM responses.

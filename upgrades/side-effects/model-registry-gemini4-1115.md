# Side-Effects Review — model registry: Gemini 4 Carbon and Hydrogen recognized (2026-11-15)

**Version / slug:** `model-registry-gemini4-1115`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `not required (registry recognition only, no routing or pin change)`

## Summary of the change

The daily frontier-model-watch job (operator request, topic 141385, 2026-11-15 13:19 PST) found Google's Gemini 4 Carbon and Gemini 4 Hydrogen missing from the registry. Both are listed by the Gemini API models endpoint, and each answered a trivial generateContent call on 2026-11-15 (paid key). They join the gemini-cli door's `topModels` as `recognized-not-promoted`, `frontier:false`, next to `gemini-4-argon`, which follows the same precedent (registry only, not in `KNOWN_GEMINI_MODELS`). The Studio's gemini CLI is not signed in, so they were not CLI-probed, and the accepted-model list is unchanged.

## Decision-point inventory

None changed. No pin, tier, default or accepted-id list moves.

## 1. Over-block

No issue identified.

## 2. Under-block

No issue identified.

## 3. Level-of-abstraction fit

Same registry layer as Argon's recognition on 2026-10-25.

## 4. Signal vs authority compliance

Unchanged.

## 5. Interactions

The registry lint passes. The capable pin stays `gemini-3.1-pro-preview` and remains in the derived frontier set.

## 6. External surfaces

None.

## 7. Rollback cost

Revert the commit.

## Tests

- `lint-model-registry-freshness`: PASS.
- model-registry-freshness and model-registry-freshness-reviewer-pin: 23 of 23 pass.

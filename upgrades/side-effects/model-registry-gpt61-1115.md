# Side-Effects Review — model registry: GPT-6.1 Sol and Terra recognized (2026-11-15)

**Version / slug:** `model-registry-gpt61-1115`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `not required (recognition only, no routing or pin change)`

## Summary of the change

The daily frontier-model-watch job (operator request, topic 141385, 2026-11-15 13:19 PST: "we should also be daily checking to make sure Instar is aware of the latest frontier models from each major AI lab") found two OpenAI models missing from the registry: GPT-6.1 Sol (2026-09-29) and GPT-6.1 Terra (2026-10-26).

I live-probed both on 2026-11-15, on codex CLI 0.169.0 against the ChatGPT account. Each answered a trivial prompt. This change:

- adds `gpt-6.1-terra` to `KNOWN_CODEX_MODEL_IDS` (`gpt-6.1-sol` was already there from 11-04), so operator pins to it validate;
- adds both models to the codex-cli door's `topModels` in `scripts/model-registry-freshness.manifest.json` as `recognized-not-promoted`, `frontier:false`.

Nothing is promoted. The capable pin stays `gpt-6-astra`, because a routing lane is earned by benchmarks, not by release date.

Gemini 4 Carbon and Hydrogen were also found. They are not added, because the Studio's gemini CLI is not signed in and they could not be live-verified. That waits on the operator's Google-account answer, already asked in topic 143457.

## Decision-point inventory

None changed. Recognition only widens which ids an operator pin may name. No default, tier or pin moves.

## 1. Over-block

No issue identified.

## 2. Under-block

A pin naming `gpt-6.1-terra` now validates. It was live-verified, and launchers still check local CLI capability before using it, as they do for `gpt-6.1-sol`.

## 3. Level-of-abstraction fit

Same single codex list and the same registry layer as every prior recognition.

## 4. Signal vs authority compliance

Unchanged.

## 5. Interactions

The registry lint passes. The pricing manifest has no Terra price, so metered paths refuse it on unknown price, as designed.

## 6. External surfaces

None.

## 7. Rollback cost

Revert the commit.

## Tests

- `lint-model-registry-freshness`: PASS.
- model-registry-freshness, modelTierEscalation-resolver, codex-model-tier-resolution, codex-model-swap-wiring, model-registry-freshness-reviewer-pin: 82 of 82 pass.
- tsc clean.

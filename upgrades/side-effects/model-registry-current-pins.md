# Side-Effects Review — Model-registry current-pins correction

**Version / slug:** `model-registry-current-pins`
**Date:** 2026-07-03
**Author:** Echo (autonomous, instar-dev)
**Second-pass reviewer:** not-required (Tier 1 — value-only pin correction; no decision-point surface added)

## Summary of the change

Corrects stale "capable/frontier" model-tier pins to the current, live-verified IDs, and marks the model-registry freshness guard's two flagged-stale items as resolved. Concretely: the Gemini `capable` tier moves `gemini-2.5-pro` → `gemini-3.1-pro-preview` (`src/providers/adapters/gemini-cli/models.ts` TIER_TO_MODEL + the mirroring Gemini branch in `src/core/frameworkSessionLaunch.ts`); the Claude Opus tier is reconciled to `claude-opus-4-8` in the two disagreeing maps (`src/core/models.ts` ANTHROPIC_MODELS.opus and `src/providers/adapters/anthropic-headless/models.ts` API_MODEL_MAP.capable) — `ModelTierEscalation` already used `claude-opus-4-8`; the freshness manifest (`scripts/model-registry-freshness.manifest.json`) frontier allowlist is updated to match both new pins and its `flaggedStale` array is emptied; and the routing doc (`docs/LLM-ROUTING-REGISTRY.md`) capable row, opus caveat, and freshness note are updated. The Codex/OpenAI `capable` pin was already `gpt-5.5` (GA flagship) and is left unchanged — `gpt-5.6-sol` (preview-only/gov-gated) is intentionally NOT pinned. Three test files that asserted the old IDs are updated. No decision-point surface is added.

## Decision-point inventory

This change touches no gate/block/filter/dispatch decision point. It edits the concrete model ID that abstract tier lookups return, and the metadata the (report-only, non-gating) freshness lint reads.

- Gemini `capable` tier pin — modify — `gemini-2.5-pro` → `gemini-3.1-pro-preview` (adapter map + frameworkSessionLaunch mirror).
- Claude Opus tier pin — modify — reconciled to `claude-opus-4-8` in `models.ts` + anthropic-headless adapter.
- Codex `capable` tier pin — pass-through — already `gpt-5.5`, unchanged.
- Freshness manifest allowlist + flaggedStale — modify — allowlist matched to new pins; flaggedStale emptied (both prior pending items resolved).

---

## 1. Over-block

No block/allow surface — over-block not applicable. The change edits model-ID values returned by tier lookups; it does not accept/reject any input.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Correct layer. The tier→ID maps are the documented single source of truth for "which concrete model a tier resolves to" per provider door (the routing doc row #8 explicitly says "changing Claude models = edit this file, not config"). The freshness manifest is the intended single human-edit surface for the frontier allowlist. This change edits exactly those surfaces and nothing lower (no call-site hardcoding) or higher (no config/gate). The `KNOWN_GEMINI_MODELS` closed enum is the type domain for the Gemini tier map, so the new ID is added there (required for type-safety) rather than loosening the type.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It adds no authority. It changes which model ID a lookup returns. The freshness lint that reads the manifest remains a report-only signal (non-gating); this change resolves its flagged items rather than granting it any new authority.

---

## 5. Interactions

- **Shadowing:** none. The pins are read the same way before and after.
- **crossModelReviewer coupling (intended):** `src/core/crossModelReviewer.ts` resolves its Gemini reviewer model via the shared `resolveCliModelFlag('capable')` (it has no independent hardcoded ID). So its Gemini reviewer now automatically uses `gemini-3.1-pro-preview` — which is precisely the freshness-guard's stated intent ("`gemini-2.5-pro` kept routing spec-review/converge work long after Gemini 3-class shipped"). The reviewer's *door* (framework = gemini-cli, tier = capable) is unchanged; only the concrete ID the capable tier resolves to is corrected. The reviewer's risk-item doc row (`docs/LLM-ROUTING-REGISTRY.md` line ~216) is intentionally left unchanged per the operator's scope boundary for this change — its model value follows the pin automatically.
- **Capacity fallback pool:** `KNOWN_GEMINI_MODELS` grows from 2 to 3 entries, so the Gemini capacity-exhaustion fallback picker now has `gemini-3.1-pro-preview` as an additional candidate; `gemini-2.5-pro` remains ordered ahead of it, so the default fallback-from-flash target is unchanged. The capacity/adapter/reviewer tests that encoded the 2-model world (and the old capable ID) are updated to match. The three unit tests (`crossModelReviewer-piece3`, `gemini-cli-adapter`, `geminiCapacityPolicy`) were updated in the original pin commit; a follow-up commit updates the two model-set-size assertions that were missed in `tests/integration/gemini-capacity-policy-integration.test.ts` and `tests/e2e/gemini-capacity-policy-lifecycle.test.ts` — the account-wide-defer spawn count moves 2→3 (flash→pro→`gemini-3.1-pro-preview` before the genuine account-wide defer) and the recorded last-exhausted stop-state model moves `gemini-2.5-pro`→`gemini-3.1-pro-preview` (the new final entry of the fallback iteration). No product-source change; these are pure test-expectation corrections tracking the model-set growth.
- **Spawn allowlist:** `src/server/routes.ts` uses `KNOWN_GEMINI_MODELS` as the accepted-model allowlist for explicitly spawning a Gemini session — keeping `gemini-2.5-pro` in the set (append, not replace) avoids rejecting a still-working model, and adds `gemini-3.1-pro-preview` as spawnable.
- **Double-fire / races:** none.

---

## 6. External surfaces

Internal model selection only. Other agents/users/systems do not read these IDs directly. The change alters which model runs internal capable-tier work (spec review/converge, heavy-work escalation baseline, background headless calls) — a quality improvement, not a protocol/interface change. No timing or conversation-state dependence.

## 6b. Operator-surface quality

Not applicable — no operator surface (dashboard/CLI form/authorization surface) is touched by this change.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN, and identical on every machine. These pins are compiled source constants shipped in the release artifact (`dist/`), not per-machine state — so every machine running the same instar version resolves the same IDs. There is no per-machine divergence to replicate, no durable state to strand on topic transfer, and no generated URL involved. Not an agent-installed file (CLAUDE.md template / `.instar/config.json` default / hook), so the Migration Parity Standard imposes no migration: existing agents pick up the corrected pins on their normal version update, and no on-disk agent state carries the stale ID (the config default `DEFAULT_TIER_ESCALATION_CONFIG` and the CLAUDE.md template already reference `claude-opus-4-8`).

## 8. Rollback cost

Trivial. A plain `git revert` of the single commit restores the prior IDs, allowlist, and flaggedStale block; no data migration, no agent-state repair. The freshness manifest change is reversible in the same revert. Because the guard ships report-only (non-gating), even a mistaken pin cannot break CI on its own.

## Framework generality

This change is per-framework by construction: each provider door's `capable` pin is corrected independently in that door's own map (Gemini adapter, anthropic-headless adapter, Claude `models.ts`), and the touched `src/core/frameworkSessionLaunch.ts` edit is confined to the `gemini-cli` branch — mirroring the Gemini adapter's single source of truth — while the `claude-code`, `codex-cli`, and `pi-cli` branches are untouched. The abstraction (tier → concrete ID per framework) is preserved; no Claude-specific assumption is introduced, and codex-cli / gemini-cli remain correct (codex `capable` stays `gpt-5.5`; gemini `capable` becomes `gemini-3.1-pro-preview`). Standard: docs/STANDARDS-REGISTRY.md → "Framework-Agnostic — and Framework-Optimizing".

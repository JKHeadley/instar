# Side-Effects Review — MR1 model-registry review application

**Version / slug:** `mr1-model-registry-review`

**Date:** `2026-08-18`

**Author:** `Instar Agent (instar-codey)`

**Second-pass reviewer:** `testing_integrity_review (Hilbert)`

## Summary of the change

This change updates reviewed frontier metadata in `scripts/model-registry-freshness.manifest.json` and repoints three existing routing values in `src/providers/adapters/anthropic-headless/models.ts`, `src/providers/adapters/openai-codex/models.ts`, and `src/core/ModelTierEscalation.ts`. It does not change the freshness gate's logic or configuration. The targeted suite found that the new Claude default is not accepted by the existing closed model enumeration, so this branch is not clear to merge.

## Build-location and plan record

- Fresh worktree: branch `phaseb/mr1-model-registry-review` from `upstream/main` at `248ed7177f5bf416aa7bdad9763741478195e1fc`.
- Upstream remote: `https://github.com/JKHeadley/instar.git`.
- Package version: `1.3.1180`.
- Problem: the review date moved while stale frontier labels and source pins remained accepted.
- Fix: apply only the reviewed manifest values and three reviewed source pins.
- Acceptance: freshness passes; a non-frontier pin mutation fails; targeted tests and type-check expose any runtime incompatibility; full lint passes.
- Rollback: revert this commit; there is no data migration.

## Decision-point inventory

- `anthropic-headless` capable-tier mapping — **modify** — deterministic choice of the concrete model for a capable request.
- `openai-codex` capable-tier mapping — **modify** — deterministic choice of the concrete model for a capable request.
- Claude tier-escalation default — **modify** — deterministic default model selected by the tier policy.
- Model-registry freshness input — **modify** — reviewed data consumed by the existing strict invariant check; gate logic is unchanged.

---

## 1. Over-block

The new Claude default is a legitimate vendor-offered id, but `KNOWN_CLAUDE_MODEL_IDS` does not contain `claude-opus-5`. The resolver therefore rejects it with `id-not-in-closed-enum` semantics and returns `null`. This is a concrete over-block and is why the branch must not merge as written.

---

## 2. Under-block

The freshness lint verifies only the pin sites declared in the manifest. It does not prove that a reviewed id is accepted by every downstream closed enumeration, and it does not detect stale explanatory comments or notes. The targeted resolver test caught the closed-enum mismatch that the freshness lint cannot see.

Three preserved manifest notes now directly contradict the reviewed values: `doors['codex-cli'].note` and `$flaggedStaleNote` say `gpt-5.6-sol` is deliberately non-frontier and the capable pin remains `gpt-5.5`; `$lastReviewNote` says no pins changed and `claude-opus-4-8` remained frontier. MR1's value-only authorization did not name these note fields, so they were not rewritten. This contradiction is a second merge blocker.

---

## 3. Level-of-abstraction fit

The three routing maps are the existing low-level owners of deterministic tier-to-model selection. The registry is the existing reviewed source for frontier status. No parallel detector or authority is introduced. The discovered mismatch shows that registry drift and runtime acceptability are separate invariants and both need evidence before landing a routing change.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no judgment-based block/allow surface.

The freshness lint has deterministic blocking authority over a narrow, enumerable invariant: a named source pin must belong to its reviewed doorway frontier set. MR1 changes the reviewed data and pin values, not the authority logic. The runtime closed enumeration is also a hard input-validation invariant, not a contextual judgment gate. No brittle interpretation of user intent is added.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. Tier-to-model mappings and closed model enumerations are deterministic configuration invariants.

---

## 5. Interactions

- **Shadowing:** the freshness lint can pass before the runtime closed enumeration rejects `claude-opus-5`; the two checks cover different properties.
- **Double-fire:** no action is emitted by either check, so there is no double actuation.
- **Races:** the change is static source and manifest data; no concurrent mutable state is introduced.
- **Feedback loops:** none. Model selections do not write back into the registry.
- **Migration defaults:** `PostUpdateMigrator` reads `DEFAULT_TIER_ESCALATION_CONFIG`; its value-pinned test fails on the reviewed new default.
- **Reviewer pin:** the clean-door reviewer remains `claude-fable-5` and its non-vacuity tests pass.
- **Manifest prose:** three unchanged notes contradict the newly reviewed frontier values. The lint ignores note prose, so they neither block nor expose the inconsistency.

---

## 6. External surfaces

If deployed, capable anthropic-headless calls would route to `claude-opus-5`, capable Codex calls through the changed adapter would route to `gpt-5.6-sol`, and new/default tier-escalation configuration would name `claude-opus-5`. The latter is currently rejected by the closed enum, so its behavior would be a fail-closed no-model result rather than the intended routing change. Pricing values and persistent data formats are unchanged. No operator action, message format, URL, or external API contract is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated** — the manifest and source defaults ship in the same software release to every machine. There is no per-machine state, pooled read, or machine-local override added by MR1. The change emits no user-facing notices, holds no durable runtime state that could strand on topic transfer, and generates no URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the value-only commit and ship the next patch.
- **Data migration:** none.
- **Agent state repair:** existing user configuration is not rewritten; a generated default written during a bad release may retain the new id and should be inspected during rollback.
- **User visibility:** capable calls could choose different models, and the Claude tier default currently fails closed, during any interval in which this code is deployed.

---

## Conclusion

The reviewed registry and source-pin delta is narrow, and the unchanged drift tooth demonstrably catches a non-frontier pin. The side-effects review found two merge blockers: `claude-opus-5` is absent from the closed Claude id enumeration, causing the intended default route to resolve to `null`; and three preserved manifest notes contradict the reviewed frontier state. The branch is suitable only as an unmerged review artifact until the operator explicitly authorizes a complete consistent change and the value-pinned tests pass.

---

## Second-pass review (required because the change modifies data consumed by a gate)

**Reviewer:** testing_integrity_review (Hilbert)

**Independent read of the artifact:** Concur with the revised review. The initial concern was that the artifact omitted contradictory Codex manifest notes; the revised artifact records those notes, plus the contradictory `$lastReviewNote`, as a second merge blocker without changing unauthorized values.

---

## Evidence pointers

- `scratchpad/phaseB/REPORT-MR1.md`
- `npm run lint:model-freshness` — pass after the reviewed edits.
- Required control: temporary Codex pin `gpt-5.5` — strict drift failure naming `codex-capable-tier`.
- Targeted Vitest run — 120 passed, 3 failed; `modelTierEscalation-resolver` proves the closed-enum blocker behaviorally.
- `npx tsc --noEmit` and `npm run lint` — pass.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. MR1 applies an operator-reviewed registry/routing update and records an integration blocker; it does not claim to fix that blocker.

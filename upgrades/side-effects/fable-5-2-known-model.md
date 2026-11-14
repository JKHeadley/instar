# Side-effects review — Fable 5.2 becomes a known claude-code model id

**Tier:** 1 (small, reversible: one allowlist entry + one manifest row). No spec; ELI16 at `docs/specs/fable-5-2-known-model.eli16.md`.
**Change size:** 2 files, ~12 LOC; tests: the existing enumerating suites (model swap, door display, topic-profile validation, tier-escalation resolver) and the registry freshness lint.
**Effort:** 1 build attempt.
**Trigger:** operator request 2026-11-09 13:30 PT (topic 141014): move every Fable 5.1 job/task/topic to Fable 5.2. `POST /topic-profile/validate-choice` refused `claude-fable-5-2` as `invalid-model`; the id was live-verified against the claude CLI (2.1.319) the same minute.

## Summary
Adds `claude-fable-5-2` to `KNOWN_CLAUDE_MODEL_IDS` (`src/core/ModelTierEscalation.ts`) and as a `recognized-not-promoted`, `frontier: false` row in `scripts/model-registry-freshness.manifest.json`. Nothing is repointed by this change; it makes the operator's repoint possible.

## 1. Over-block
None added; this removes a refusal of a real id. No issue identified.

## 2. Under-block
The list is still an allowlist; only one verified id is added. A wrong id is still refused.

## 3. Level-of-abstraction fit
Exactly where the 5.1 and Opus 5.5 entries live; the manifest is the one hand-edited registry surface by design.

## 4. Signal vs authority compliance
Structural validation of an enumerable domain; no judgment logic. Compliant.

## 5. Interactions
`ModelSwapService` already handles `-N` version siblings generically (its 5.1 guard rejects a bare "5" when "5.1" was asked; 5.2 behaves the same). The escalation policy accepts the id if the operator sets it as the escalated target; the shipped default stays `claude-fable-5`. The freshness lint: the row is `frontier: false`, so the derived frontier set is unchanged and no pin drifts; `lastReviewedAt` (2026-10-25) stays within the 45-day window.

## 6. External surfaces
`GET /topic-profile/options` lists the new id; the dashboard model picker shows it. No notice, no behaviour change until an operator pins something.

## 6b. Operator-surface quality
Not applicable: the picker renders the list it already renders.

## 7. Multi-machine posture
Code-level allowlist: identical on every machine running this build. A machine on an older build refuses the id until it updates (the existing version-skew behaviour for every list entry). Unified by build.

## 8. Rollback cost
Delete the line and the manifest row. A topic pinned to the id in the meantime would read `off-enum` and fall back to the framework default, as it does for any unknown id.

## Found problems (triage)
- None.

## Proportion
Tier 1, 2 files, 1 attempt. In line.

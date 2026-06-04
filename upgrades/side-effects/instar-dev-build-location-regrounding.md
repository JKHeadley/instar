# Side-Effects Review — instar-dev build-location re-grounding

**Version / slug:** `instar-dev-build-location-regrounding`
**Date:** `2026-06-04`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change hardens the instar-dev workflow against a mentor-onboarding failure mode: a respawned agent built a fleet PR from a stale agent-home checkout instead of current `JKHeadley/instar` main. Phase 2 of the instar-dev skill now requires an explicit build-location re-grounding plan item before code edits: confirm a fresh current-main worktree, verify the remote, and verify the package version. PostUpdateMigrator backfills existing deployed instar-dev skills by content-sniffing for the new marker and replacing only stock skill copies; customized skill text is left untouched.

## Decision-point inventory

- `/instar-dev` Phase 2 planning checklist — modify — adds a required self-verification step before build execution.
- `PostUpdateMigrator` built-in skill migration — modify — updates deployed stock instar-dev skill files during agent update.
- Commit/push gates — pass-through — unchanged; they continue to enforce side-effects/release metadata after this workflow step has grounded the checkout.

---

## 1. Over-block

The skill now requires a planning statement even for small instar-dev changes. That can feel redundant when the agent is already visibly in a correct worktree, but it is intentionally cheap and does not block via code; the enforcement is procedural text plus review artifacts. The migrator only overwrites installed instar-dev skill files that still match the stock fingerprint, so a customized local workflow is not clobbered.

---

## 2. Under-block

This does not make a hard shell gate that rejects stale checkouts. An agent could still ignore the skill text or lie in the plan, but the expected workflow now requires the check at the right point, and the plan/review trail makes omissions visible. A future stronger gate could validate branch ancestry automatically, but this PR focuses on the requested structural skill and migration layer.

---

## 3. Level-of-abstraction fit

The change belongs in Phase 2 because that is the last explicit planning checkpoint before `/build` starts edits. It also belongs in PostUpdateMigrator because the instar-dev skill is an agent-installed built-in file; updating only the package copy would leave existing agents on stale instructions.

---

## 4. Signal vs authority compliance

- [x] No — this change produces a planning requirement and migration update, not a brittle block/allow authority.

No new runtime authority is introduced. The skill text creates a required human/agent-visible checkpoint. PostUpdateMigrator makes the checkpoint available to existing agents but does not make build-location decisions.

---

## 5. Interactions

- **Shadowing:** The new checklist item complements the existing worktree convention and pre-commit gates. It does not replace them.
- **Double-fire:** Fresh installs receive the updated bundled skill; existing installs receive the same text once through the migrator. The marker makes repeated runs no-op.
- **Races:** The migrator performs a single local file write during update. If the file is already customized or already current, it skips.
- **Feedback loops:** The change reduces the chance of stale-repo fixes generating follow-up CI/PR cleanup loops.

---

## 6. External surfaces

Existing dev agents will see updated instar-dev skill text after update if their installed copy is stock. This is intentionally fleet-visible because the bug came from a respawned development agent. End users do not invoke instar-dev; the surface is limited to infrastructure-development agents and their installed skill files.

---

## 7. Rollback cost

Rollback is a normal code revert. Agents that already received the updated skill text would keep a harmless extra planning checklist item until a later migration rewrites it. No persistent database migration is involved.

---

## Conclusion

The review confirms the right fix layer is the workflow body plus migration parity, not another ad hoc reminder in a transcript. The remaining gap is deliberate: this PR does not add an automatic stale-checkout blocker. It makes the grounding step required and fleet-distributed, with tests covering update, idempotency, customization preservation, and missing-skill no-op behavior.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

This changes a dev skill and migration path but does not alter session lifecycle, messaging gates, sentinels, or runtime block/allow logic.

---

## Evidence pointers

- Focused PostUpdateMigrator built-in skill migration tests passed.
- TypeScript typecheck passed.

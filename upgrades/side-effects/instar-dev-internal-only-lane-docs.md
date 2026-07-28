# Side-Effects Review — instar-dev internal-only release-note lane docs

**Version / slug:** `instar-dev-internal-only-lane-docs`
**Date:** `2026-06-04`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change documents PR #765's internal-only release-note lane in the bundled `/instar-dev` skill and adds a PostUpdateMigrator backfill so existing deployed stock skill copies receive the same guidance.

The skill text documents four operational facts grounded in #765: `<!-- internal-only -->` opts a fragment into the lane, the marker lets the fragment omit `What to Tell Your User` and `Summary of New Capabilities`, the shared assembler auto-fills those sections only when every contributing fragment is internal-only, and the pre-push gate rejects the marker when runtime `src/*.ts` files changed.

## Decision-point inventory

- `/instar-dev` skill text — modify — teaches agents when the internal-only lane is valid.
- `PostUpdateMigrator` built-in skill migration — modify — copies the bundled stock skill into existing stock deployed copies when the new marker is missing.
- Release gates — `hasInternalOnlyMarker` (`scripts/assemble-next-md.mjs`) hardened to match the marker only as a standalone directive line (see §8); pre-push behavior otherwise unchanged.

---

## 1. Over-block

The migration may skip a deployed instar-dev skill that is structurally stock but lacks the conservative fingerprint (`# /instar-dev` and `### Phase 2 — Planning`). That is acceptable because the alternative is clobbering customized local workflows. Fresh installs still receive the bundled skill.

---

## 2. Under-block

This does not enforce correct use of the internal-only marker beyond documenting the already-merged pre-push gate. An agent can still misunderstand the lane, but the guidance now lives in the skill at the point where agents prepare release fragments.

---

## 3. Level-of-abstraction fit

The skill is the right documentation layer because `/instar-dev` owns the release-fragment workflow. PostUpdateMigrator is the right deployment layer because installed skills are untracked agent-local files; package updates alone do not rewrite existing copies.

---

## 4. Signal vs authority compliance

- [x] No new authority is introduced.

This PR changes documentation and migration parity only. The objective authority remains PR #765's existing pre-push gate, which checks the marker against the diff.

---

## 5. Interactions

- **#760 migration:** This mirrors the existing build-location skill migration but uses a new marker phrase, so both migrations are independently idempotent.
- **Fresh installs:** `installBuiltinSkills` gets the updated bundled skill directly.
- **Existing installs:** PostUpdateMigrator rewrites only stock deployed copies missing the new phrase.
- **Customized installs:** The conservative fingerprint check leaves them untouched.

---

## 6. External surfaces

The visible surface is limited to development agents reading `/instar-dev`. End-user behavior does not change. Existing agents with stock skill installs will see the new guidance after update.

---

## 7. Rollback cost

Rollback is a normal code revert. Agents that already received the updated skill keep a harmless documentation section until a later migration rewrites the file. There is no persistent database migration.

---

## Conclusion

The change closes the deploy-awareness half of #765 without changing the ship-lane mechanism itself. The main risk is overwriting customized skills, and the migration avoids that by using the same conservative content-sniffing pattern as #760.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

This touches development-skill documentation and an idempotent post-update skill migration. It does not alter session lifecycle, messaging gates, sentinels, or runtime block/allow decisions.

---

## 8. Marker-detection hardening (surfaced while building this PR)

Building this docs PR surfaced a false-positive in `hasInternalOnlyMarker`
(`scripts/assemble-next-md.mjs`): the matcher used a whole-content regex, so a
fragment that merely *documents* the `<!-- internal-only -->` marker in prose (as
this PR's own release fragment does, quoting the literal marker in backticks) was
misread as *using* the internal-only lane — and tripped its own §3c src-conflict
gate (this PR touches `PostUpdateMigrator.ts`). Hardened the matcher to recognize
the marker ONLY as a standalone directive line (like `<!-- bump: -->`), never an
inline/backtick mention. Pure script + test change; no `src/` runtime surface.
Behavior for genuine internal-only fragments (marker on its own line) is unchanged
— all three prior `detects the marker` assertions stay green. Regression test
added (`does NOT detect an inline/backtick mention…`).

---

## Evidence pointers

- `npm test -- --run tests/unit/migrate-instar-dev-build-location.test.ts tests/unit/migrate-instar-dev-internal-only-lane.test.ts`
- `npm test -- --run tests/unit/assemble-next-md.test.ts tests/unit/pre-push-gate.test.ts` (47 tests — marker false-positive regression)

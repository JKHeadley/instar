# Side-Effects Review — CI fragment invariant (server-side publish-jam guard)

**Version / slug:** `ci-fragment-invariant`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane (CI check addition reusing existing shared validators; no runtime surface)`

## Summary of the change

`scripts/check-repo-invariants.mjs` (the Repo Invariants required CI check) gains invariant #3: release-note fragments (`upgrades/next/*.md` + legacy `NEXT.md`) must assemble and validate cleanly, using the SAME `assembleNextMd` + `validateGuideContent` the pre-push gate and publish workflow use. Closes the bypass path of the publish-jam class (task #42): local pre-push hooks are skipped by admin/web merges, so a malformed fragment could reach main and jam every subsequent fleet release at publish-time (lived twice: v1.3.180, #781 on 2026-06-05).

## Decision-point inventory

- `check-repo-invariants.mjs` invariant #3 — add — assemble-in-memory + validate; assembly throw → failure; validator issues → failures; no upgrades dir / zero fragments → pass.

## 1. Over-block

Two considered cases:
- **Inherited red:** a malformed fragment already on main turns Repo Invariants red on EVERY open PR until fixed (same blast shape as tonight's ratchet debt). Intentional — Zero-Failure treats main breakage as everyone's loudest problem; the alternative (silent until publish) jams the whole fleet's release train invisibly.
- **Cross-fragment validator coupling:** validation runs on the ASSEMBLED guide, so one PR's red can be caused by another's fragment. This mirrors the pre-push gate's long-standing behavior exactly (same functions), so no NEW over-block class is introduced.
- "src changed without any fragment" is deliberately NOT asserted here (stays a per-branch pre-push concern); docs-only states and post-release-cut states (no fragments) pass.

## 2. Over-permit

None — purely additive check; nothing previously blocked becomes allowed.

## 3. Drift risk

Validation logic is imported from the shared modules (`assemble-next-md.mjs`, `upgrade-guide-validator.mjs`) — no duplicated rules, so the CI check can never drift from what publish actually enforces.

## 4. Failure modes

- Validator/assembler module missing or broken → the invariants script itself fails to load → Repo Invariants red (loud, correct).
- Empty `upgrades/next/` dir or absent `upgrades/` dir → pass (post-release-cut normal state; verified on the live tree and pinned by test).

## 5. Migration parity

None needed — repo-internal CI script; ships with the repo.

## 6. Token/cost impact

None. Pure-node in-memory assembly per CI run (milliseconds).

## 7. Rollback

Revert the commit; the invariant disappears, local pre-push remains the only fragment guard (the prior, bypassable state).

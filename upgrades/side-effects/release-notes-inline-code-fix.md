# Side-Effects Review — Release notes inline-code fix

**Version / slug:** `release-notes-inline-code-fix`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required — documentation-only`

## Summary of the change

Documentation-only. The "What to Tell Your User" paragraph for the Phase 1c-runtime lock-file change in `upgrades/NEXT.md` contained inline code formatting (backticks around `origin:instar` and `untrusted-no-lockfile`). The release-cut "check upgrade guide" lint rejects user-facing inline code per the established convention: user-facing language must be plain and conversational. This commit rewords that paragraph in plain English without code formatting so the release pipeline can publish v0.28.102 (which carries PR #182's standby fix and several other behavior changes).

Files touched:
- `upgrades/NEXT.md` — single paragraph reworded; no code or behavior changes.

## Decision-point inventory

None. No runtime decisions touched.

---

## 1. Over-block — Not applicable (documentation-only).
## 2. Under-block — Not applicable (documentation-only).
## 3. Level-of-abstraction fit — Right layer: release-notes prose lives in `upgrades/NEXT.md`.
## 4. Signal vs authority compliance — Not applicable (documentation-only). No new gate, no new detector.
## 5. Interactions — Unblocks the existing release-cut "check upgrade guide" lint that was rejecting v0.28.102.
## 6. External surfaces — User-visible release notes prose changes from inline-code formatting to plain English. No API, schema, or behavior change.
## 7. Rollback cost — Trivial. Single revert. No data migration, no state, no agent impact.

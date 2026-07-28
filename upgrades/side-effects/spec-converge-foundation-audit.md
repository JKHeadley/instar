# Side-Effects Review — spec-converge clause (d) foundation/subsystem audit

**Version / slug:** `spec-converge-foundation-audit`
**Date:** `2026-06-10`
**Author:** `echo`
**Tier:** `1` (skill-prompt clause + idempotent content migration + tests; no new runtime subsystem, route, or config)
**Second-pass reviewer:** `not required`

## Summary of the change

Extend the `/spec-converge` Lessons-aware reviewer's mandate with clause **(d)
FOUNDATION/SUBSYSTEM AUDIT**: the review must reach one layer below the spec boundary
and weigh the subsystem the spec *tests / extends / builds on* against known standards
and lessons — not just the spec's own surface. When that foundation is flawed, the
finding is "this spec is sound but the subsystem it depends on violates standard X /
repeats mistake Y — surface it before building on/around it."

Two edits + tests:
1. `skills/spec-converge/SKILL.md` — the bundled source skill gains clause (d) on the
   Lessons-aware bullet (the `## Internal reviewers` section).
2. `src/core/PostUpdateMigrator.ts` — a new `migrateSpecConvergeFoundationAudit`
   (registered in the migrate runner) so existing agents' installed
   `.claude/skills/spec-converge/SKILL.md` receives clause (d) on update. Idempotent +
   conservative: re-copies the bundled skill only when the installed copy (a) lacks the
   `FOUNDATION/SUBSYSTEM AUDIT` marker AND (b) still matches the stock spec-converge
   fingerprint (`# /spec-converge` + `**Internal reviewers (Claude subagents):**`). A
   customized skill is skipped untouched.
3. `tests/unit/migrate-spec-converge-foundation-audit.test.ts` — 5 tests (update,
   idempotent, customized-untouched, not-installed no-op, bundled-source wiring
   integrity).

Motivation: the 2026-06-09 gap where a test-harness spec converged cleanly while the
permission gate it proved still held brittle blocking authority in violation of
Signal-vs-Authority. The convergence audited only the harness and took the flawed
foundation as given. This closes that gap structurally (Structure > Willpower): the
reviewer is *instructed* to look below the spec, rather than the author having to
remember to.

## Decision-point inventory

- **Migration content-sniff guard** — re-copy vs. skip. Inputs: installed skill text.
  Branch 1: marker already present → return (idempotent no-op). Branch 2: stock
  fingerprint missing → skip + record `customized`. Branch 3: stock fingerprint present
  AND marker absent → re-copy the bundled skill. No LLM, no runtime authority — pure
  string-presence checks at update time.

## 1. Over-block

**What legitimate inputs does this change reject?** Nothing is rejected at runtime — no
gate, no message path, no API. The migration's only "rejection" is *declining to update*
a skill it can't confidently recognize as stock (fingerprint missing → skipped). That is
the safe direction: a customized spec-converge skill keeps the operator's edits rather
than being clobbered. The reviewer clause makes the review *stricter* (one more thing to
check), but the Lessons-aware reviewer is signal-only — it surfaces findings, it does not
block; blocking authority remains the separate Standards-Conformance Gate path.

## 2. Under-block

**What does this still miss?** (a) The clause is a *prompt* instruction, so its
effectiveness depends on the reviewing model actually reaching one layer down — it is a
stronger signal, not a code-enforced guarantee (a future code-backed "foundation
referenced by the spec was audited" check could harden it, but that is out of scope for a
Tier-1 prompt change). (b) The migration re-copies the *whole* bundled skill (matching the
established skill-migration idiom); an agent on a much older stock version receives all
accumulated bundled changes, not just clause (d) — acceptable because the fingerprint
guard only fires on stock copies. (c) Agents who customized the skill are intentionally
not upgraded; they must adopt clause (d) by hand.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The clause lives in the one reviewer whose job is standards/lessons
conformance (Lessons-aware), beside its existing (a)/(b)/(c) checks — not bolted onto an
unrelated reviewer. The migration lives beside the sibling skill-content migrations
(`migrateInstarDevInternalOnlyReleaseNoteLane`, `migrateTestAsSelfSkill`) and reuses their
exact fingerprint-guarded re-copy pattern, so it inherits the proven Migration-Parity
idiom rather than inventing a new one.

## Migration / rollback

- **Migration:** `migrateSpecConvergeFoundationAudit` runs on the normal post-update path.
  Idempotent (marker check) and conservative (fingerprint guard). No state, no config.
- **Rollback:** pure revert — drop the clause from the bundled skill, remove the migration
  method + its registration line, delete the test. No data migration to undo; the migration
  only ever copied a newer skill prompt over a stock older one.

## Testing-integrity note

Unit tests cover both sides of the migration's decision boundary (updates stock /
skips customized / idempotent / not-installed) plus a wiring-integrity test asserting the
bundled source actually carries the marker (so the migration cannot silently no-op for
every agent). `tsc --noEmit` clean; sibling skill-migration + builtin-dev-skills suites
stay green (19 tests total across the touched area).

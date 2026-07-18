# Side-Effects Review — CMT-872 apprenticeship program concepts + defect-matrix template

**Change:** two new documentation files — `docs/apprenticeship/PROGRAM-CONCEPTS.md`
(five operator-ratified program concepts) and `docs/apprenticeship/DEFECT-MATRIX-TEMPLATE.md`
(required fundamental-gap fields on defect entries) — plus this artifact and the ELI16
companion. Documentation-only; no runtime surface.

## Phase 1 — Principle check

Does this change involve a decision point (gating information flow, blocking actions,
filtering messages, constraining agent behavior)? **No.** It is a data-model-free
documentation change. No code reads these files. The defect-matrix "requirement" is a
process convention enforced by drive reviewers (minds), not by any hook or gate (no
enforcement code is added or modified). Signal-vs-authority does not apply — nothing
here holds or delegates authority.

## The eight questions

1. **Over-block** — No issue identified. Nothing is blocked; no executable surface.
2. **Under-block** — No issue identified. The template's "required fields" rule relies
   on drive-review discipline, not enforcement; that is deliberate (judgment-layer
   convention, documented as such). If the program later wants structural enforcement,
   that would be a separate speced change to whatever tool ingests the matrix.
3. **Level-of-abstraction fit** — Correct layer: program-level docs live in
   `docs/apprenticeship/` beside RETRO-HARVEST-PROCEDURE.md. The concepts intentionally
   do NOT live in a spec (they are ratified framings, not a buildable design); the
   stall-coverage-matrix STANDARD referenced by concept 4 remains a separate spec draft
   going through /spec-converge on its own track.
4. **Signal vs authority compliance** — N/A; no detector, no authority, no blocking
   logic added.
5. **Interactions** — No issue identified. No existing doc claims to be the canonical
   concepts statement (checked docs/apprenticeship/ and docs/specs/APPRENTICESHIP-*);
   the new files cite and link the existing project-design spec rather than shadowing it.
6. **External surfaces** — Visible to any agent/human reading the repo. Content is
   operator-ratified framing with origin citations (topic 29723, dates); no secrets, no
   PII beyond the operator's first name already used throughout the repo's docs.
7. **Multi-machine posture** — Machine-agnostic BY DESIGN: git-tracked documentation
   replicates via the repo itself; no machine-local state, no notices, no URLs.
8. **Rollback cost** — `git revert` of one docs-only commit. No data migration, no
   agent state, no release-behavior dependency.

## Conclusion

Documentation-only, no runtime surface, rollback is a one-commit revert. Tier 1.

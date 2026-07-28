# Side-Effects Review — cmt872-apprenticeship-concepts

**Change:** documentation-only. (a) New `docs/apprenticeship/PROGRAM-CONCEPTS.md`
(four operator-ratified apprenticeship concepts + evaluation cautions, CMT-872).
(b) `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md`: three REQUIRED `rootGap*`
fields added to the §13.1 issue schema + new §13.9 explaining the requirement.
No runtime code, no tests, no templates, no hooks.

## Phase 1 principle check

Does this change involve a decision point (gates information flow, blocks actions,
filters messages, constrains agent behavior)? **No.** It is prose: a concepts page and
a spec schema amendment. The write-time validation §13.9 describes will be a future
build of the (staged, off-by-default) mentor loop; this commit changes no executable
path. Signal-vs-authority is not implicated — documentation carries no authority.

## The eight questions

1. **Over-block** — No issue identified. Nothing executable changes; nothing can
   reject any input.
2. **Under-block** — No issue identified (nothing enforces yet). Named residual: until
   the mentor-loop build implements §13.9 validation, the rootGap requirement binds
   drive practice by convention (already live in drive 5's matrix) rather than by code.
   That build is governed by the mentor spec's own staged rollout.
3. **Level-of-abstraction fit** — Correct layer. Concepts page lives in
   `docs/apprenticeship/` beside RETRO-HARVEST-PROCEDURE.md; the schema change lives in
   the spec that owns the issue ledger. The drive-workspace matrix template mirrors the
   same three questions, so judgment structure exists at both layers (program docs +
   ledger schema).
4. **Signal vs authority** — Compliant; no authority exists in this change. When built,
   rootGap validation is a write-time completeness check on a ledger record (like the
   existing bucket allowlist), not a behavioral gate.
5. **Interactions** — The mentor spec is converged+approved (2026-05-27). This amends
   its schema section additively; no existing field is renamed or removed, so no
   consumer (none built yet for these fields) breaks. §13.8 (Concurrency) numbering is
   untouched; the new section is §13.9. The concepts page references the spec and vice
   versa — both references verified present in this diff.
6. **External surfaces** — None. No user-visible runtime surface, no other-agent
   surface. The docs ship in the npm package as before.
7. **Multi-machine posture** — Machine-local BY DESIGN in the trivial sense: these are
   git-tracked repo docs, identical on every machine via the release; no runtime state,
   no replication path needed, nothing strands on topic transfer, no URLs generated.
8. **Rollback cost** — Trivial: revert the docs commit. No data migration, no agent
   state, no hot-fix pressure.

## Conclusion

Documentation-only, no runtime surface. Tier 1 declared: small, low-risk, records
operator decisions already made 2026-07-17.

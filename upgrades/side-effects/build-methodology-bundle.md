# Side-Effects Review — /build Methodology Bundle

**Source:** Cherry-picks from GSD-Instar spike (gsd-planner + gsd-executor methodology)
**Author:** Echo · autonomous run · 2026-05-23

## 1. Over-block
None — these are prompt-skill methodology sections, not gates. They add steps the agent runs, not blocks. The Phase 0.5 "quality gate" (must-haves.md exists before Phase 1) is a soft self-check inside the skill, not an external block.

## 2. Under-block
The methodology is advisory within /build. An agent could skip Phase 0.5. Enforcement of the spirit lives elsewhere (e2e-pairing pre-commit gate, /verify-claim, response-review). This bundle imports the DISCIPLINE; the structural gates are separate cherry-picks.

## 3. Level-of-abstraction fit
All four changes are content edits to the /build SKILL.md — the natural home for build methodology. The defense-in-depth doc lives in docs/patterns/ alongside other pattern docs. The migration follows the existing migrateSkillPortHardcoding content-sniff pattern.

## 4. Signal-vs-authority compliance
Compatible. Phase 0.5 must-haves PRODUCE the verification signals that Phase 3 (authority: the agent + reviewers) acts on. STRIDE mitigations bind to tests (the authority). The defense-in-depth doc explicitly reconciles itself with signal-vs-authority. No brittle filter is given blocking authority.

## 5. Cross-feature interactions
- Phase 0.5 key_links + /verify-claim (separate PR) compose: must-haves define the wiring; /verify-claim checks it.
- Atomic-commit discipline aligns with the e2e-pairing pre-commit gate (per-task commits make the gate's per-commit check meaningful).
- SUMMARY deviation-tracking references the executor Rule 1/2/3/4 vocabulary (consistent with the deferral-detector + the GSD methodology framing).
- The old Phase 5 `git add -A` guidance is REPLACED (it contradicted the new atomic-commit discipline) — a deliberate fix, not just an addition.
- Migration only touches a stock /build skill; customized skills are fingerprint-guarded.

## 6. Rollback cost
Moderate-low. Revert the SKILL.md edits + the migration method + the doc + the migration test. Existing agents that already ran the migration would keep the updated SKILL.md (harmless — the new sections are additive guidance). The migration is idempotent and conservative, so a revert-then-re-apply is safe.

## 7. Migration parity
- New agents: bundled SKILL.md (copied by installBuildSkill on fresh init) carries the sections.
- Existing agents: migrateBuildSkillMethodology() content-sniffs for the Phase 0.5 marker and re-copies the bundled SKILL.md if absent AND the file matches the stock fingerprint. Wired into the migration sequence after migrateSkillPortHardcoding. Idempotent + fingerprint-guarded (verified by 4 tests).
- The defense-in-depth doc is a repo doc, not an agent-installed file — ships with the package, no migration needed.

## Conclusion
Ship. Bundling the four /build-touching items into one PR is correct (separate PRs would self-conflict on SKILL.md). The methodology is the spike's planner+executor discipline imported as Instar's own. Migration parity covered with a conservative content-sniff migration + 4 tests. Seven-dimension review clean.

# Side-Effects Review — Jev evidence path correction (EVO-027)

**Version / slug:** `jev-evidence-path-docs`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, 6 source/test files plus artifacts, about 65 lines; no spec rounds; first commit attempt unless noted below. Corrects the capability card and `docs/specs/jev-job-supervision.md` to the path the writer has always used, adds `JEV_EVIDENCE_DIR_NAME`, patches existing agents' CLAUDE.md in `migrateClaudeMd`, and adds a test holding card, spec and writer together. The writer's resolved path does not change. The second half of EVO-027's option list (moving packs under `state/`) was deliberately not chosen, since the proposal offers either direction.

## Decision-point inventory

None. No gate, sentinel or filter is touched.

## 1. Over-block

No issue identified: nothing is blocked. The migration replaces only the exact stale directory string, and that string names no real directory.

## 2. Under-block

Applies to `CLAUDE.md` only, the one file `migrateClaudeMd` handles. An agent with a hand-reworded card keeps its wording. The test guards this one path, not documented paths generally; the proposal's general concern stays a pattern, not a new linter.

## 3. Level-of-abstraction fit

Right layer: the constant lives with the writer, and the migration sits beside the code that installs the card.

## 4. Signal vs authority compliance

Not applicable: no decision logic, per `docs/signal-vs-authority.md`.

## 5. Interactions

The replacement is an `else if` on the existing card-install guard, so a fresh install takes the first branch with the corrected text. The `.gitignore` rule from PR #2118 already covers the real path. Retention sweeps use the same `evidenceDir`, unchanged.

## 6. External surfaces

Each agent's CLAUDE.md gains a one-string correction at update. Nothing else is visible.

## 7. Multi-machine posture

Machine-local by design, as before: each machine audits its own scheduler. The migration runs per machine on update.

## 8. Rollback cost

Revert the commit. No state to repair; a corrected card left behind on an agent stays correct.

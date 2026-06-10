# Upgrade Guide — Decision-Completeness Gate in spec-converge

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Implements Piece 2 of `docs/specs/AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC.md` (Autonomy Principle 2 — frontload all user decisions so a spec completes in ONE autonomous run). Three parts, all in the agent-private spec-converge skill (no runtime `src/` surface):

1. **New internal reviewer** (`reviewer-decision-completeness.md`, 6th of six): enumerates every mid-run stop-and-ask-the-user point; each must be frontloaded into `## Frontloaded Decisions` or tagged cheap-to-change-after behind a named dark/dry-run/read-only phase. The reviewer CONTESTS every cheap tag against a closed non-cheap taxonomy (durable external side-effects, money, identity, published/user-visible interface — never cheap); a rejected tag is a material finding that blocks convergence. Applies to ALL specs (D7), no per-spec override (D11).
2. **New convergence criterion** (Phase 3): a spec cannot converge while `## Open questions` contains an unresolved user-decision.
3. **Structural enforcement + earned evidence** (`write-convergence-tag.mjs`): the tag writer refuses to stamp `review-convergence` while open questions remain, and writes `single-run-completable: true` plus the reviewer's counts (`frontloaded-decisions`, `cheap-to-change-tags`, `contested-then-cleared`) — the tag carries its evidence, earned not minted. Pre-existing converged specs are unaffected (the gate fires at stamp time only).

The spec's migration decision is resolved and recorded: spec-converge stays **agent-private** (matching `/instar-dev`'s not-user-facing status) — deliberately NOT promoted to the fleet builtin skill set, so no fleet migration surface exists.

## Evidence

- `tests/unit/write-convergence-tag-decision-completeness.test.ts`: 15 new tests — none-marker variants, section scoping, refuse-on-live-question (tag NOT written), stamp-on-resolved, earned counts, no-counts → no minted tag, idempotent re-runs.
- `tests/unit/write-convergence-tag-crossmodel.test.ts`: 16 existing tests green (no regression from the import-safe main-guard restructure).
- Live functional run: refused a spec with `- **Q1:** should we do A or B?` (exit 1 + remediation message); stamped `single-run-completable: true` + counts once the section read `*(none)*`.

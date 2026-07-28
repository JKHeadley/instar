# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**feat(build): /build methodology bundle — four GSD cherry-picks + defense-in-depth doc.**

Four enhancements to the /build skill, all from the GSD-Instar spike, bundled in one PR because they all touch the /build SKILL.md:

- **Phase 0.5: MUST-HAVES (goal-backward)** — before planning HOW, state WHAT must be observably true: truths (consumer-perspective), artifacts (exist + substantive + wired), and key_links (grep patterns proving real wiring). Each truth becomes a Phase 3 verification gate. Prevents shipping a component that compiles + passes unit tests but is never instantiated.
- **STRIDE threat pass** (LARGE builds only) — a small threat register where each mitigation binds to a specific test. Skipped for SMALL builds.
- **Atomic-commit discipline** in Phase 2 EXECUTE — one commit per plan step, stage specific files by name (never `git add -A`), `{type}({scope}): {summary}` format, verify no accidental deletions. Replaces the old single-mega-commit guidance (which was unreviewable).
- **SUMMARY.md deviation-tracking** in Phase 5 COMPLETE — enumerate deviations from plan, categorized by the executor Rule 1/2/3/4, plus the must-haves verification result and any infrastructure-backed deferrals.

Also adds `docs/patterns/defense-in-depth-insert-and-projection.md` — the insert-time + projection-time pattern the spike surfaced (with the Topic Intent Layer affirmation cap as the worked example).

## Evidence

4 unit tests for the migration (migrateBuildSkillMethodology): stock skill updated, idempotent, customized skill untouched, no-throw on missing. TypeScript clean.

Migration parity: installBuildSkill is install-if-missing, so existing agents get the methodology via a content-sniffed idempotent migration (only updates a stock /build skill lacking the "Phase 0.5: MUST-HAVES" marker; leaves customized skills alone).

Side-effects review: `upgrades/side-effects/build-methodology-bundle.md`.

## What to Tell Your User

Your /build skill got sharper. It now asks "what must be true when this is done?" before planning, commits work in reviewable per-task chunks instead of one giant commit, and writes a short deviation log at the end so you can see exactly what changed from the original plan. On big builds it also does a quick threat pass. Nothing you have to do differently — /build just does more of the right thing automatically.

## Summary of New Capabilities

Four /build methodology sections + one pattern doc + one content-update migration + 4 migration tests. Framework-agnostic (prompt-skill content + a migration). The methodology is the GSD planner/executor discipline imported as Instar's own.

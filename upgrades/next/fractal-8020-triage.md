## What Changed

- **Spec review converges on fractal 80/20.** `/spec-converge` stops when a round raises no finding that changes what gets built; wording and long-tail findings go to a `## Left behind` list instead of another round. Round cap 3 for Tier 1, 6 for Tier 2+. The "a smaller finding count is NOT convergence" rule is removed, and the report gains a `## Proportion` line.
- **Plain size tiers** in `/instar-dev` and `/build`: small and reversible → short spec, one review round, targeted tests; the full chain for large, irreversible or security-sensitive changes.
- **Found-problem triage** in `/instar-dev`, `/build` and `/autonomous`: blocks the current work → fix now; major → new topic + session that starts its own `/autonomous` run to completion; otherwise → the feedback queue (`/feedback`) or the evolution queue (`/commit-action`). Found problems no longer accrete into the run.
- **Proportion signal**: convergence reports, build summaries and autonomous final reports state effort (rounds, gate attempts) beside change size and flag a mismatch. Signal only.
- Existing agents receive the updated skills through a new update migration (stock copies only; customized skills are left alone).

## What to Tell Your User

Nothing to do. My reviews of my own changes now stop once they stop changing what I build, and problems I spot along the way get sorted instead of piling onto the current job, so small requests finish much faster.

## Summary of New Capabilities

- None (process change to built-in skills).

## Evidence

- Before: `skills/spec-converge/SKILL.md` said "A smaller finding count is NOT convergence" with a 10-round cap; a single requested feature (topic 127831) ran 18 rounds and 9 commit attempts and absorbed 13 found problems, still unbuilt after 14 hours.
- After: the bundled skills carry the 80/20 criterion, size tiers, triage rule and proportion line; `tests/unit/PostUpdateMigrator-fractalEightyTwentyTriage.test.ts` proves the content and that a stock installed copy (including one carrying the previous criterion's marker, and the prior autonomous skill from main) is upgraded once, idempotently, while a customized copy is left untouched.

<!-- bump: patch -->
## What Changed

Records the Context Budget Phase 0 verification results in `docs/specs/reports/context-budget-phase0-results.md`, measured on 2026-11-10. It also adds re-runnable read-only measurement scripts in `scripts/context-budget/`:

- compaction-path counts
- sender asymmetry
- the topic-intent inventory
- the per-turn token baseline
- hook delivery capacity

Docs and scripts only. Nothing changes at runtime.

## What to Tell Your User

Nothing changes for you. I measured how well the first stage of my long-conversation memory work actually performs, and wrote the numbers down. Those numbers turned up one real problem, which is fixed separately.

## Summary of New Capabilities

- `scripts/context-budget/*.mjs`: re-runnable measurements of compaction recovery, token use per turn and layer inventory on a machine.

## Evidence

- `docs/specs/reports/context-budget-phase0-results.md`

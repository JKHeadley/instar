# Offline Context Comparison Preparation

## What Changed

Added an internal, data-only replay preparation and scoring command for the stale-contact evaluation fixtures. It constructs paired no-context, reduced-context and full-context trial grids and imports fixed captured answers. It records refusals, failures, repeated full-context variation and declared costs. It does not call models, execute tools or change active agent instructions. General source-grounded answer and judge contracts are design documents; their semantic evaluation is not implemented by this runner.

## What to Tell Your User

The preparation tools for comparing shorter instructions are ready for evaluation. They keep failed results visible and compare against both full instructions and no task-specific context. No live comparison or measured saving has been established, and no job has switched to shorter instructions.

## Summary of New Capabilities

| Capability | How to Use |
| --- | --- |
| Offline replay preparation and imported-answer scoring | See `docs/evaluation/context-budget/relationship-maintenance/README.md`; this is an internal evaluation command, not an agent setting. |

## Evidence

The original runner has seventeen focused Python checks covering unit, combined pipeline and actual-command lifecycle behavior. Its Vitest wrappers and complete repository verification remain in the normal shared verification path. General schemas compiled under strict Ajv Draft 2020-12 and passed thirteen synthetic field/conditional checks. These results do not establish blind model execution, semantic correctness, qualification, measured savings or activation.

# A feature now adds its agent instructions as one new file

<!-- bump: patch -->

## What Changed

New agent-awareness text no longer has to be edited into `src/scaffold/templates.ts` and `src/core/PostUpdateMigrator.ts`, where every feature appended at the same spots and conflicted with every other. A feature adds one data file, `src/data/awareness/<id>.md` (a title, an optional `requires: telegram`, and text; format in `src/data/awareness/README.md`). `src/awareness/registry.ts` reads that folder from the package at run time and writes all entries as one "Feature notes" section at the end of the instruction document: for new agents, for existing agents on every update, and in the Codex and Gemini copies. The section is rebuilt each time, so a wording fix or a removed entry reaches every agent. The folder ships empty: with no entries every generated document is byte-identical to before. An advisory check (`scripts/lint-awareness-entry-registry.mjs`, never fails) prints a notice when a change adds awareness the old way. Spec: `docs/specs/awareness-entry-registry.md`.

## What to Tell Your User

Nothing changes for you today. This is plumbing that lets new features merge without tripping over each other.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Add a feature's agent instructions without touching shared files | Add `src/data/awareness/<id>.md` (see the README in that folder) |
| Instruction wording fixes and removals reach existing agents | Automatic on update, for text added this way |

## Evidence

2026-11-14: 8 features left the test line on merge conflicts in one night, 4 of them in `templates.ts`; 18 of 83 open changes touch `PostUpdateMigrator.ts` and 11 touch `templates.ts`. Tests: `tests/unit/awareness-entry-registry.test.ts` (43), `tests/unit/awareness-entry-registry-consumers.test.ts` (26), `tests/unit/lint-awareness-entry-registry.test.ts` (6), plus the extended reference-layout unit (35), integration (6) and e2e (2) files; `tsc --noEmit` clean.

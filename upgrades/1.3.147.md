---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; load/CPU root — Justin: treat load as a suspected Instar bug)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — exclude agent node_modules from macOS Spotlight (a top idle-CPU source)

Live profiling on the dev box (2026-05-31) found macOS Spotlight (`Metadata.framework`) +
`mediaanalysisd` as the top CPU consumers (~62% / ~52%), not instar's own processes. Instar
already drops a `.metadata_never_index` marker at the `.worktrees/` container, but the **bigger
churning set was never excluded**: each agent home carries a full `node_modules/` (~1.3GB /
~25k files measured) AND a `.instar/shadow-install/node_modules/` (~600MB), which Spotlight
re-indexes on every `npm ci` and every shadow-install update. Across a ~10-agent fleet that is
~20GB of un-excluded node_modules being continually re-indexed.

This adds a `PostUpdateMigrator` pass that drops the `.metadata_never_index` marker into the
agent's `node_modules/` and `shadow-install/node_modules/` (mirroring the worktree exclusion),
so existing agents get the relief on their next update. node_modules never need Spotlight
indexing, so the marker is unambiguously safe, honored recursively, harmless on non-macOS, and
idempotent.

## Summary of New Capabilities

- `PostUpdateMigrator.migrateNodeModulesSpotlightExclusion` — drops `.metadata_never_index` at
  `<agentHome>/node_modules` and `<stateDir>/shadow-install/node_modules` (skips missing dirs,
  reuses the existing generic marker-dropper, reports per dir, idempotent).
- Wired into the migration `run()` sequence right after the worktree exclusion.

## What to Tell Your User

On macOS, your agent will stop letting Spotlight re-index its node_modules folders — those are
build dependencies that never need to be searchable, and re-indexing them was a real background
CPU drain. Nothing to configure; it applies on the next update.

## Evidence

- Live: `ps` showed `Metadata.framework` ~62% CPU; agent node_modules (echo) = 1.3GB / 24,592
  files + 635MB shadow-install, none carrying the exclusion marker (worktrees did).
- Unit: `tests/unit/worktree-spotlight-exclusion.test.ts` — new cases: drops the marker into
  agent-home node_modules AND shadow-install on update; skips missing dirs without error;
  idempotent (8 tests pass).
- Immediate operational mitigation already applied across the live fleet (43 node_modules dirs
  marked); this migration makes it permanent + automatic for all agents.
- `tsc --noEmit` + `npm run lint` clean.
- Spec: `docs/specs/node-modules-spotlight-exclusion.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/node-modules-spotlight-exclusion.md`.

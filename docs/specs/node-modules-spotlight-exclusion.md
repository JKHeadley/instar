---
title: Exclude agent node_modules from macOS Spotlight (idle-CPU hygiene)
slug: node-modules-spotlight-exclusion
status: approved
review-convergence: 2026-05-31T06:00:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h autonomous deploy mandate (topic 13435).
  Directly serves the foundational mandate task: "treat the degraded/rate-limit signal as a
  SUSPECTED Instar bug — load points to bugs." Live profiling identified macOS Spotlight
  re-indexing un-excluded agent node_modules as a top OS-level CPU consumer (the box's #1/#2
  CPU users were Metadata.framework + mediaanalysisd, not instar processes). node_modules
  exclusion is unambiguously correct hygiene (build deps never need indexing), so the change is
  safe + low-risk; it mirrors the already-shipped worktree exclusion.
second-pass-required: false
second-pass-status: n/a-os-hygiene-additive
---

# Exclude agent node_modules from macOS Spotlight

## Problem

macOS Spotlight (`mds_stores` / `Metadata.framework`) and `mediaanalysisd` re-index file trees
on change. Each instar agent home carries a full `node_modules/` (~1.3GB / ~25k files measured
on echo) AND a `.instar/shadow-install/node_modules/` (~600MB). These churn constantly — every
`npm ci` in a dev checkout, every shadow-install update during auto-update. Across a ~10-agent
fleet that is ~20GB of node_modules being continually re-indexed, measured live as
`Metadata.framework` ~62% CPU + `mediaanalysisd` ~52% (the box's top two CPU consumers, above
every instar process). instar already excludes `.worktrees/` (the prior top consumer under a
worktree backlog) but never excluded the agent-home / shadow-install node_modules.

## Design

Add `PostUpdateMigrator.migrateNodeModulesSpotlightExclusion`, wired into `run()` immediately
after `migrateWorktreeSpotlightExclusion`. It drops a `.metadata_never_index` marker at:
- `<agentHome>/node_modules`
- `<stateDir>/shadow-install/node_modules`

It reuses the existing generic marker-dropper `ensureWorktreeSpotlightExclusion(dir)` (the
function is dir-agnostic — it just creates the marker if absent and returns whether it did).
Missing dirs are skipped silently; each created marker is reported in `result.upgraded`; the
pass is idempotent (a present marker → no re-report, no error). Runs on every update, so
existing agents are backfilled.

## Safety
- `.metadata_never_index` is a Spotlight-only hint — it changes nothing functional (no effect
  on file access, module resolution, or builds). node_modules never need to be searchable, so
  excluding them is unambiguously correct (not a tradeoff).
- Honored recursively, harmless no-op on non-macOS, idempotent, best-effort (a write failure is
  swallowed by the helper — it must never block the migration).
- Worst case: Spotlight keeps indexing (the prior behavior). No regression is possible.

## Test plan
- Unit (`worktree-spotlight-exclusion.test.ts`, extended): the migration drops the marker into
  agent-home node_modules AND shadow-install on update; skips missing node_modules dirs without
  error; idempotent (second run does not re-report). The existing worktree cases stay green.

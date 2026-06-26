---
title: "AgentWorktreeReaper — untracked-only droppings must not block reclaim"
slug: "worktree-reaper-untracked-blindspot"
author: "echo"
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
review-convergence: "2026-06-26T03:35:30.681Z"
review-iterations: 2
review-completed-at: "2026-06-26T03:35:30.681Z"
review-report: "docs/specs/reports/worktree-reaper-untracked-blindspot-convergence.md"
cross-model-review: "skipped-abbreviated"
cross-model-review-reason: "tightly-scoped single-gate fix during active load investigation; lessons-aware + adversarial + conformance-gate ran and caught a deletion-safety BLOCKER"
approved: true
approved-by: "echo (under Justin's standing blanket authority, topic 28130/28730 — explicit directive to investigate the load thesis + root out the unbounded-growth design flaw, 2026-06-25)"
approved-basis: "standing-authorization + explicit directive; convergence caught + resolved a deletion-safety BLOCKER (fail-open→fail-closed) and 2 MAJORs (narrow denylist, OrphanedWorkSentinel coupling); ships behind agentWorktreeReaper.enabled+dryRun (operator reviews the dry-run report first); operator may revert by editing frontmatter"
---

# AgentWorktreeReaper — untracked-only droppings must not block reclaim

## Problem statement

`.worktrees/` on the echo agent grew to **289 git worktrees / 118 GB**. macOS `fseventsd` (file-change daemon) burns ~165% CPU watching that tree, which `load-assess.sh` and any load-average glance misread as "agent overload" — driving false load-shed/deferrals (the 2026-06-25 misdiagnosis Justin flagged).

The AgentWorktreeReaper (`src/monitoring/AgentWorktreeReaper.ts`) exists to reclaim merged+clean+idle worktrees, but it keeps **246 of 289** with reason `uncommitted-changes`. Grounded inspection (2026-06-25): of those 246, **only 42 have real tracked modifications**; the other **204 are untracked-only** — stray droppings, not work. The single most common untracked file (112/120 sampled) is **`.metadata_never_index`**, the Spotlight-exclusion marker dropped into each worktree the SAME day to *reduce* indexing load. Because it is untracked, it makes every worktree fail `isClean` → the reaper keeps it → worktrees accumulate without bound. **The marker added to reduce load blocks the cleanup that reduces load.**

Root cause in code: `AgentWorktreeReaper.evaluate()` L122 `if (!isClean(path)) return keep('uncommitted-changes')` fires BEFORE the squash-merge-aware `isMerged` check (L123). `isClean` deliberately counts ANY untracked file as dirty (design comment L11-22: "no uncommitted OR untracked changes"). That conflates *uncommitted tracked work* (precious) with *untracked droppings* (disposable).

Grounding corrected my initial secondary hypotheses: `resolveBaseRef` (`agentWorktreeGit.ts` L38-50) ALREADY prefers `JKHeadley/main` → `upstream/main` → `origin/main` → `main`, so the reaper resolves the canonical ref correctly (the broken `origin/instar-echo` only bit the worktree-create CLI, not the reaper); and `isBranchMerged` (L61-71) already detects single-commit squash-merges via `git cherry` patch-id (conservative — multi-commit squash → KEEP). Neither needs changing.

## Proposed design

**The fix reuses an EXISTING, tested PURE function — but fails CLOSED, with a reaper-specific narrow denylist.** The codebase has `src/core/worktreeDirtyCheck.ts` → the pure `classifyPorcelain(porcelain, denylist)` (returns "dirty" only when a porcelain line is a *non-residue* change). The convergence review (2026-06-26) corrected three foundation-inheritance traps that a naive reuse would have hit:

1. **`agentWorktreeGit.ts` `isClean`** → call the PURE `classifyPorcelain` on a SUCCESSFULLY-READ porcelain, preserving the existing fail-CLOSED catch:
   ```
   isClean: (p) => { try { return !classifyPorcelain(readGit(['-C',p,'status','--porcelain'],p), REAPER_RESIDUE_DENYLIST); } catch { return false; /* unknown → dirty → KEEP */ } }
   ```
   **Do NOT** consume the `makeWorktreeDirtyCheck` wrapper: it fails OPEN (git error → "not dirty"), which for the killer/orphaned-work consumers is the safe direction but for a DELETION gate inverts to "looks clean → delete-eligible" — the No-Silent-Degradation trap (a safety check silently degrading to the unsafe side on a transient `git status` failure). The reaper keeps its current `catch { return false }` (dirty → KEEP). ANY non-residue change — tracked OR a hand-authored untracked `.ts`/`.md` — still returns dirty → KEEP, so the 42 real-WIP worktrees stay kept.

2. **A NEW `REAPER_RESIDUE_DENYLIST`** local to `agentWorktreeGit.ts` — NARROW, only unambiguous-never-work: `dist/`, `node_modules/`, `.cache/`, `.turbo/`, `*.tsbuildinfo`, `.metadata_never_index`, `.instar/instar-dev-traces/`. Deliberately EXCLUDES the broad `out/`, `build/`, `coverage/`, `*.log` entries of `DEFAULT_RESIDUE_DENYLIST` — those match files users legitimately hand-author (a `build/deploy.md`, an `analysis.log`) and must never be silently reaped on a merged worktree. **Do NOT modify `DEFAULT_RESIDUE_DENYLIST`** (which feeds the separate yield-safety config list + would broaden other consumers); the reaper carries its own list.

3. **Third consumer disclosed: `OrphanedWorkSentinel`** (`orphanedWorkGit.ts` `hasUncommittedWork = !base.isClean`) shares this `isClean`. Widening "clean" to ignore the narrow never-work set is correct there too (it should not preserve a worktree whose only content is the Spotlight marker / audit traces), but the coupling is now explicit and tested (a marker-only worktree → `clean`→skip there; a worktree with a tracked diff is NEVER hidden).

**Backfill is bounded + observable:** existing `maxReapsPerPass` + `dryRun` + `enabled` knobs unchanged. Reclaim removes only the CHECKOUT; branch + commits remain in git. NOTE (review m2): non-`--force` `git worktree remove` refuses on TRACKED uncommitted changes but does NOT refuse on untracked files — so for the untracked case `isClean`/`classifyPorcelain` is the SOLE gate (not a "second guard"), which is exactly why the narrow denylist (#2) + fail-closed (#1) matter. The ~200-worktree backlog drains over many passes, each audited.

**Brake on sustained reclaim failure (No Unbounded Loops standard).** Today a worktree whose `git worktree remove` persistently fails (a permission/lock edge) is re-attempted every reaper pass forever — a bounded periodic no-op (the loop is timer-driven, `maxReapsPerPass`-capped, and increments `reaped` only on success), but with no breaker. Since this change makes far more worktrees reap-eligible, add a per-path consecutive-failure breaker: track removal failures per worktree path; after `maxReclaimFailuresPerPath` (default 3) consecutive failures, the reaper marks that path `keep` with reason `reclaim-failed` and stops attempting it (emits the breaker-trip once), until process restart. This converts an indefinite retry into a bounded, observable give-up — the standard's "every repeating behavior carries its own brakes."

## Decision points touched

This MODIFIES a destructive reclaim safety gate (worktree deletion). It does NOT add blocking authority to a brittle signal — it REFINES an over-conservative KEEP gate (wire `isClean` to the existing tested residue-aware `classifyPorcelain`) so it stops conflating droppings with work, and ADDS a bounded per-path failure breaker. The conservative direction is preserved: ANY non-residue change (tracked OR untracked) still returns dirty → KEEP. Net: fewer false-keeps, zero new false-reaps, and a brake on sustained reclaim failure.

## Frontloaded Decisions

- **Residue-denylist additions** — `.metadata_never_index` + `.instar/instar-dev-traces/` only (clearly-never-work). Extending later is cheap (data, not logic).
- **Non-residue untracked policy** — KEEP (conservative; already how `classifyPorcelain` behaves). A hand-authored untracked source file preserves the worktree. Fixed as KEEP.
- **No auto-mass-delete on first run** — the reaper keeps its `dryRun` + `maxReapsPerPass`; the ~200-worktree backlog drains over many passes, each audited. The operator can review the dry-run report first.

## Open questions

*(none)*

## Side-effects preview (for the full artifact at build time)
- Over-reap risk: bounded by classifyPorcelain (any non-residue change → KEEP) + isMerged + isInUse. The only behavioral change is reclaiming merged+idle worktrees whose only residue is denylisted droppings.
- Multi-machine posture: machine-local BY DESIGN (worktrees live on one disk; the reaper only ever evaluates its own machine's `.worktrees/`). No replication/proxy surface.
- Rollback: `agentWorktreeReaper.enabled:false` (existing) fully disables; the allowlist is config-tunable.

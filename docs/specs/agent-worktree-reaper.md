---
title: AgentWorktreeReaper — reclaim stale CLI worktrees
slug: agent-worktree-reaper
status: approved
review-convergence: 2026-05-31T01:40:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate during an explicit
  5-hour autonomous run (topic 16782, 2026-05-30) on the Responsible Resource
  Usage standard. Justin directed focus on mitigating macOS/OS resource load and
  confirmed OS resource hygiene belongs in the standard; reclaiming the ~115
  stale worktrees is the disk/CPU half of that. Ships OFF + dry-run, so shipping
  carries no auto-delete risk. Flagged in the PR per cross-agent discipline.
---

# AgentWorktreeReaper — reclaim stale CLI worktrees

## Problem

CLI-created worktrees under `~/.instar/agents/<agent>/.worktrees/` are full
source-tree checkouts that accumulate with NO cleanup (measured: ~120 worktrees /
~55 GB on echo). The existing `WorktreeReaper` only manages `WorktreeManager`
bindings under `.instar/worktrees/` via the state-reconciliation matrix — the
CLI `.worktrees/` worktrees are entirely unmanaged. The backlog is both a disk
drain and the workload behind the macOS Spotlight/mediaanalysisd CPU problem the
sibling `.metadata_never_index` marker mitigates.

## Goal

Reclaim stale CLI worktrees safely and automatically, reclaiming disk and shrinking
the macOS-indexing workload. Level 4 (OS resource hygiene) of the Responsible
Resource Usage standard.

## Non-goals

- Not the binding-tracked WorktreeManager worktrees (the existing WorktreeReaper).
- Not the Spotlight marker (sibling, already shipped).
- Not auto-enabling: ships OFF + dry-run; bulk reclaim of an existing backlog is a
  human-reviewed decision off the dry-run report.

## Design

A new `AgentWorktreeReaper` with a pure, injectable classifier. THE hard
requirement: NEVER delete unmerged or dirty work. A worktree is reap-eligible ONLY
when ALL hold (cheapest protect-gates first, short-circuit on KEEP):

1. not in use — no `.session.lock` / `.git/index.lock` AND no running process whose
   cwd is inside the worktree (`lsof -d cwd`, scanned once per pass),
2. has a known branch (detached ⇒ KEEP),
3. clean — `git status --porcelain` empty,
4. merged — `isBranchMerged` via `git cherry` patch-id equivalence against the
   resolved default branch (JKHeadley/main → upstream/main → origin/main → main).
   Catches fast-forward, merge-commit, rebased, and single-commit-squash merges;
   a multi-commit squash is reported NOT merged (KEPT) — conservative, never a
   false-positive "merged".

**Why no staleness gate:** real-data validation on echo's 112 worktrees showed
staleness cannot discriminate here — on a high-velocity fleet every branch is
rebased onto recent main, so both commit dates AND directory mtimes are uniformly
recent. The load-bearing safety is "merged + clean + not-in-use": for a merged
branch the content is already in main, so removing the working-dir checkout loses
NOTHING (the branch + commits remain; the worktree is re-creatable on demand);
clean ⇒ no uncommitted work lost; not-in-use ⇒ no active session yanked.

Any signal that throws ⇒ KEEP. All git queries are read-only (SafeGitExecutor.
readSync); the single destructive op, `git worktree remove`, goes through
SafeGitExecutor.execSync. Ships OFF + dry-run, with a bounded `maxReapsPerPass`
blast radius. Observability: `GET /worktrees/agent-reaper` (per-worktree verdict +
reclaimable count + armed state). Boot-wired in server.ts (start() no-ops when
disabled).

## Decision points (signal vs authority)

This IS an authority (it deletes worktrees) — hence the conservative AND-of-all-
gates classifier, dry-run + dark default, bounded blast radius, and read-only
report for human review before enablement. Per `docs/signal-vs-authority.md`, the
authority is gated behind positive proof (merged + clean) and KEEPs on any
ambiguity; the report is a pure signal.

## Testing

Unit: the classifier on both sides of every gate + cheap-gates-first + dry-run-
never-deletes + blast-radius cap + the `git cherry` merged-detection (with a fake
git). Integration: the route (503 unwired / 200 snapshot). E2E: feature-alive
through the real AgentServer. Plus discoverability + completeness lints.

## Rollback

Trivial. Dark + dry-run by default, so it deletes nothing until explicitly enabled
and reviewed. Operationally, set `enabled:false` to neutralize with no deploy. A
PR revert removes the class + route + config. No state, no schema.

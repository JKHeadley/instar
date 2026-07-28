# Side-Effects Review — AgentWorktreeReaper

**Version / slug:** `agent-worktree-reaper`
**Date:** `2026-05-30`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

A new `AgentWorktreeReaper` reclaims CLI worktrees under `.worktrees/` that are
**merged + clean + not-in-use** (for a merged branch the work is in main, so
removing the checkout loses nothing). Pure injectable classifier; git-backed
signals (`agentWorktreeGit.ts`, incl. a lock + process-cwd in-use check);
`GET /worktrees/agent-reaper` report; boot-wired in server.ts; config
`monitoring.agentWorktreeReaper`. Ships OFF + dry-run.

## Decision-point inventory

- **Per-worktree reap/keep decision** (new authority — DELETES worktrees). Gated
  behind an AND of all safety signals; KEEPs on any ambiguity; dry-run + dark by
  default; bounded blast radius.

## 1. Over-block

**What legitimate inputs does this reject?** By design it KEEPs anything not
provably reclaimable — including multi-commit squash-merged branches (the merged-
detection is conservative). So it under-reclaims rather than ever deleting unmerged
work. That is the correct bias for a deleting authority.

## 2. Under-block

**What does it miss?** Multi-commit squash-merged branches are kept (not detected
as merged by `git cherry`). This is acceptable: the goal is safe reclamation, and
the dry-run report makes the kept-set inspectable so detection can be refined before
broader enablement. (Validation on echo: ~49 of 112 worktrees are merged + clean +
idle and would be reclaimed; the rest are kept for genuine uncommitted work or
unmerged/multi-commit-squash branches.)

## 3. Level-of-abstraction fit

**Right layer?** Yes. The classifier is a pure monitoring component (mirrors
SessionReaper's injectable design); git/fs signals are isolated in a separate
module so the classifier is unit-testable with fakes; the destructive op routes
through SafeGitExecutor. Distinct from the binding-based WorktreeReaper (different
worktree system) — no overlap.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

It IS a deleting authority, so it is gated behind POSITIVE proof (merged + clean +
not-active + stale) and KEEPs on any failed/ambiguous signal — never reaping on the
absence of evidence. The `GET /worktrees/agent-reaper` report is a pure signal for
human review. Ships dark + dry-run so the authority is inert until reviewed-enabled.

## 5. Interactions

No interaction with the SessionReaper, the binding-based WorktreeReaper, sentinels,
or recovery paths. Reads the same instar git repo via SafeGitExecutor.readSync;
the only write is `git worktree remove` via execSync (audited). Config auto-migrates
via ConfigDefaults. Pairs with (does not depend on) the Spotlight-exclusion marker.

## 6. External surfaces

One new read-only HTTP route (`GET /worktrees/agent-reaper`, Bearer-auth, classified
in the discoverability lint as operational observability). No notifications, no
Telegram, no new on-disk state. The only filesystem effect — when enabled+live —
is removing already-merged, clean, stale worktrees.

## 7. Rollback cost

Trivial. Dark + dry-run by default ⇒ deletes nothing until explicitly enabled and
reviewed. `enabled:false` neutralizes with no deploy. A PR revert removes the class,
route, and config. No state, no schema, no irreversible op (git worktree remove only
detaches an already-merged checkout; the branch + commits remain in the repo).

## Conclusion

A deleting authority built conservatively: AND-of-all-safety-gates, KEEP-on-
ambiguity, dry-run + dark default, bounded blast radius, read-only review surface,
and the destructive op funneled + audited. Directly targets a measured ~55 GB / ~120-
worktree backlog that also drives macOS indexing load.

## Second-pass review (if required)

Not required for the ship (dark + dry-run, zero auto-delete risk). A second-pass /
operator review of the dry-run report on real worktrees is the gate before
enabling live reaping.

## Evidence pointers

- `tests/unit/agent-worktree-reaper.test.ts` — safety classifier (both sides),
  dry-run, blast cap, merged-detection.
- `tests/integration/agent-worktree-reaper-routes.test.ts` — the route.
- `tests/e2e/agent-worktree-reaper-lifecycle.test.ts` — feature-alive.
- `upgrades/NEXT.md` — upgrade guide.

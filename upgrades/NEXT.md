---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; independent 2nd-pass review CONCUR ship-dark)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — the rate-limit auto-recovery now works for codex sessions too (ships DARK)

The RateLimitSentinel keeps a throttled session alive: it notices, tells you "backing off,
you're not dropped," retries with escalating backoff, confirms recovery by watching the
session's transcript grow, and escalates if it never clears. This whole lifecycle was
Claude-only — a codex session throttled by OpenAI was invisible to it and could hang with
no recovery.

Now it's codex-aware. Recovery-verification reads the newest codex rollout (the OpenAI
limit is account-wide, so the newest rollout's growth is the "is codex producing output
again?" signal — no fragile per-session id needed, which was the earlier attempt's bug).
The user-facing notices use OpenAI wording for codex. A dark server-side poll reads
codex's own rate-limit flag and reports throttled codex sessions into the sentinel.

Claude behavior is byte-for-byte unchanged. The detection poll ships OFF by default.

## What to Tell Your User

Nothing changes yet — the codex side ships switched off. It is the groundwork so that a
codex agent that hits a temporary rate limit gets the same calm, automatic "backing off,
hang tight, here we go again" recovery a Claude agent already gets, once it is turned on.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex-aware rate-limit recovery | Automatic for codex sessions once detection is enabled. Recovery reads the newest codex rollout's growth. |
| Codex throttle detection poll | Set `monitoring.rateLimitSentinel.codexUsageDetection: true` (default false / dark). Off → instant rollback. |
| Per-vendor throttle wording | Codex notices say OpenAI / status.openai.com; Claude unchanged. |

## Evidence

- Unit: `tests/unit/findNewestRolloutSync.test.ts` (newest-by-filename, month/year crossing,
  empty-partition skip, null-safe, single-stat perf). `tests/unit/RateLimitSentinel-codex-recovery.test.ts`
  (grow→recover, no-grow→escalate, codex vendor wording = OpenAI not Anthropic).
- Claude-unchanged: existing `tests/unit/RateLimitSentinel.test.ts` message-asserting tests pass.
- `tsc --noEmit` clean; `npm run lint` clean.
- Independent second-pass review: CONCUR on shipping DARK. Known must-fix-before-enable:
  concurrent-codex-session false recovery (account-wide signal vs per-session state) — gated
  behind the default-off flag. See the spec + side-effects.
- Spec: `docs/specs/ratelimit-sentinel-codex-parity.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/ratelimit-sentinel-codex-parity.md`.

---

## What Changed — a reaper reclaims stale agent worktrees (ships OFF + dry-run)

**A new reaper reclaims stale agent worktrees — the disk-and-CPU backlog behind
the macOS indexing load — safely, and only what it can prove is reclaimable.**

CLI-created worktrees under `~/.instar/agents/<agent>/.worktrees/` are full
source-tree checkouts that accumulate with no cleanup (measured: ~120 worktrees /
~55 GB on one agent). The existing WorktreeReaper only manages a different,
binding-tracked worktree system; these CLI worktrees were entirely unmanaged.
That backlog is both a disk drain and the workload behind the macOS Spotlight CPU
problem the new `.metadata_never_index` marker mitigates.

The new `AgentWorktreeReaper` reclaims a worktree ONLY when ALL of these hold:
it is not in use (no live session/index lock AND no running process whose working
directory is inside it), clean (no uncommitted or untracked changes), and merged
(its branch's content is already in the default branch, detected via `git cherry`
patch-id so fast-forward, merge-commit, rebased, and single-commit-squash merges
all count). For a merged branch the work is already in main, so removing the
working-dir checkout loses nothing — the branch and its commits stay in the repo.
Any ambiguity keeps the worktree. It ships **OFF and dry-run by default** — the
only worktree path that deletes on a heuristic — with a bounded per-pass blast
radius. (Staleness is deliberately not a gate: on a high-velocity fleet every
branch is rebased onto recent main, so timestamps cannot distinguish abandoned
from active — "in use" is the real signal.)

This is the second piece of the **OS resource hygiene** facet of the Responsible
Resource Usage standard, paired with the Spotlight-exclusion marker.

## What to Tell Your User

Nothing to configure yet — it is off by default on purpose, because it deletes
worktrees. There is a new read-only report that shows which old worktrees could be
safely reclaimed and why each one is being kept, so you can review before turning
it on. It is deliberately cautious: it will never remove a worktree that has
unsaved changes, an unmerged branch, or anyone actively using it. Once you have
looked at the report and are comfortable, you can enable it to keep the worktree
pile from growing and reclaim disk.

## Summary of New Capabilities

- New `AgentWorktreeReaper` (`src/monitoring/AgentWorktreeReaper.ts`) — pure,
  injectable classifier; reaps only merged + clean + not-in-use worktrees;
  dry-run + dark by default; bounded `maxReapsPerPass`.
- Git-backed signals (`src/monitoring/agentWorktreeGit.ts`) — `git worktree list`
  parsing bounded to `.worktrees/`, `git status` cleanliness, a lock + process-cwd
  in-use check, `git cherry`-based conservative merged-detection, and `git worktree
  remove` via SafeGitExecutor.
- New read-only endpoint `GET /worktrees/agent-reaper` — per-worktree verdict +
  reclaimable count + whether reaping is armed.
- Config `monitoring.agentWorktreeReaper` (`enabled` false, `dryRun` true,
  `maxReapsPerPass` 20), auto-migrated to existing agents.

## Evidence

- `tests/unit/agent-worktree-reaper.test.ts` — the safety classifier on BOTH sides
  of every gate (in-use / dirty / unmerged / detached all KEEP; reap-eligible only
  when all clear), cheap-gates-first (no git merged-check on a dirty worktree),
  dry-run never deletes, blast-radius cap, the `git cherry` merged-detection, and
  the lock+process-cwd in-use check.
- `tests/integration/agent-worktree-reaper-routes.test.ts` — `GET
  /worktrees/agent-reaper` 503 unwired / 200 with snapshot.
- `tests/e2e/agent-worktree-reaper-lifecycle.test.ts` — Phase-1 feature-alive
  through the real AgentServer plumbing.
- Validated live on echo's real 112 worktrees: 49 merged+clean+idle reclaimable,
  the rest correctly kept (dirty / unmerged / in-use).
- `capabilities-discoverability` + `feature-delivery-completeness` green; lint clean.

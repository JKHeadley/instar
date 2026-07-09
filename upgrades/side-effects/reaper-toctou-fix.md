# Side-Effects Review — AgentWorktreeReaper TOCTOU fix

**Slug:** reaper-toctou-fix · **Tier:** 1 (small, pure safety tightening) · **Author:** echo · 2026-07-09

## Phase 1 — Principle check (signal vs authority)
The AgentWorktreeReaper IS a decision authority (it deletes worktrees). This change does NOT add new brittle blocking authority — it adds MORE signal re-checks (live branch/clean/in-use/merged + a build marker) BEFORE the existing authority acts, and only ever moves the verdict toward KEEP. It feeds the existing delete-authority with fresher signals; it never blocks anything new. Compliant — strictly safer.

## Phase 4 — Side-effects review (all 8)
1. **Over-block** — Could KEEP a genuinely-reapable worktree if a signal transiently flips (a momentary lock, a slow git read). Harmless + self-correcting: KEEP means "not deleted this pass"; it's re-evaluated next pass. No data loss, ever. This is the intended safe direction.
2. **Under-block** — Residual: a builder that checks out the SAME branch name with NEW commits between eval and reclaim → currentBranch matches, but the isMerged RE-CHECK against the current branch catches the new (unmerged) commits → keep. A micro-window between the currentBranch read and `git worktree remove` remains, but `removeWorktree` is NON-forced (refuses a dirty/locked worktree) — a second, independent guard on the actual delete. Acceptable.
3. **Level-of-abstraction fit** — Correct layer. The reaper owns the reap decision; the re-validation belongs exactly at its reclaim point (not a higher/lower layer). No smarter existing gate to feed.
4. **Signal vs authority** — See Phase 1. The change adds signals to make an existing authority more conservative. No new brittle authority. Ref docs/signal-vs-authority.md.
5. **Interactions** — Runs AFTER the per-path reclaim-failure breaker and the maxReapsPerPass cap, immediately BEFORE removeWorktree. Does not shadow or double-fire with them. Adds one `reclaim-raced` event (observability). The mutated evaluation (reap-eligible→keep on race) is the same object already pushed to `evaluations`, so the reap-log/pass event reports the honest raced verdict.
6. **External surfaces** — No API/other-agent/other-user surface change. The verdict/reap-log gains new `raced-*` reasons (pure observability). New OPTIONAL file convention: a `.instar-build-active` marker a builder may drop at a worktree root to claim it; absence = today's behavior.
7. **Multi-machine posture** — MACHINE-LOCAL BY DESIGN. Each machine's reaper operates only on ITS OWN `.worktrees/` (worktrees are physical checkouts on one disk); currentBranch (local git) and the marker (local fs) are inherently local. No replication needed or wanted — a worktree cannot exist on two machines.
8. **Rollback cost** — Trivial. Additive change (2 injected deps + 1 guard method + the re-validation call). No config, no migration, no persisted state. Back-out = revert the commit.

## Phase 5 — Second-pass (inline; this fork cannot spawn a subagent)
Independent adversarial re-read: (a) Could the guard ever make the reaper MORE aggressive? No — every branch of `reclaimRaceGuard` returns a KEEP reason or null; it can only subtract reaps. (b) Could a throw in the guard cause a reap? No — the guard's try/catch returns `reclaim-recheck-error` (KEEP) on any throw. (c) Does the null-branch fail-closed hold? Yes — a null live branch ≠ a non-null info.branch (info.branch is always non-null at reclaim, since evaluate keeps on !info.branch) → raced → keep; test pins this. (d) Marker fail-closed: an fs error reading the marker returns true (KEEP). **Concur with the review** — the change is delete-safe by construction; no concern raised.

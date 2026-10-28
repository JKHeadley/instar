# Side-effects review — worktree capacity and preservation

**Date:** 2026-10-28  
**Author:** Echo  
**Second-pass reviewer:** independent reviewer concurred with the bounded CLI cap and stricter reaper KEEP rule; residual risks recorded below.

## Summary and decisions

The CLI refuses new worktrees at 500 physical child directories, using an exclusive agent-local lock across count and Git add. The reaper keeps a checkout if any ordinary or ignored file is present. Its owner repository, enable setting, and dry-run setting are unchanged.

## 1. Over-block

Non-worktree directories count toward the ceiling, so an agent may be unable to create a checkout even if some children are harmless. A crash-left lock also refuses future creates until a person verifies and removes it. This preserves disk and work rather than guessing. The reaper now keeps checkouts with generated or marker-named files, reducing automatic reclamation; Echo's separately installed cleaner can archive verified artifacts.

## 2. Under-block

Direct `git worktree add` and other creation paths do not call this CLI and can exceed 500. An existing backlog is not deleted by the new cap. Git status and ignored-file inspection are observations; a writer racing after the final revalidation could still add bytes before removal. Existing process, lock, and reclaim-time checks narrow that interval but do not establish a global filesystem transaction. The reaper remains off and dry-run by default.

## 3. Level of abstraction

The CLI is the earliest source boundary for its own worktree creation. The lock makes the count meaningful under concurrent CLI calls. The reaper's `isClean` check is the right deletion-adjacent authority to read ignored files because Git can delete them during removal. The approved SourceTreeGuard read-tier spec now records the added read-only `ls-files` verb and corrects its old assumption about non-forced worktree removal.

## 4. Signal vs authority

Per `docs/signal-vs-authority.md`, a physical count is a hard resource invariant, and KEEP on uncertain files is a safety guard for an irreversible action. Neither is a keyword heuristic about code quality. The reaper's other merge and activity decisions remain unchanged.

## 5. Interactions

The lock file lives under the agent's `.instar/local` runtime state, outside the counted `.worktrees` directories. It is acquired after the worktree directory is validated and released in `finally` only when its inode is still the holder's. A second count immediately precedes Git add. The local six-hour cleaner may reduce count between refused and retried creates, and is not modified by this patch.

## 6. Operator surface

New `worktree-capacity` and `worktree-create-busy` errors name the cause. No new API or notification. Reaper status may show fewer reclaimable checkouts when generated files are present; this is an intentional preservation signal.

## 7. Multi-machine posture

Machine-local by design: the physical directories, lock, and process activity are on one host. No user or conversation state is replicated, and no URL is generated.

## 8. Rollback

Revert and release. A retained crash lock can be inspected and removed; it is runtime state, not a schema migration. Existing checkouts and archive refs are unaffected by the revert.

## Evidence

Real-Git tests cover ignored unique files and generated-output directories. Unit tests cover the lock and count boundaries; integration covers the CLI path and concurrent calls (10/10 passed). Production-lifecycle E2E passed 2/2. The updated closed-read-tier test passed 15/15. The complete local suite passed 52,820 unit, 4,930 integration, and 3,594 E2E tests with zero failures. The live cleaner has three successful launchd runs and a 308-directory count; PR merge is pending.

# Reaper stale-idle override — ELI16

> The one-line version: idle sessions still never got cleaned up — even after the last fix — because each one keeps its own little helper programs (MCP servers) running, and the reaper's rule "never kill a session that still has any program running" treated those idle helpers as "this session is busy." Now, if a session has had NO message from you in 8h AND is just sitting at an idle prompt producing nothing, the reaper stops counting its own idle helpers as "busy" and can finally reap it.

## The problem (found 2026-06-06, after #955 deployed)

A load-average-30 overload traced to dozens of multi-day Claude sessions, each holding a heavy MCP server stack. #955 fixed one blocker (stale commitments pinning sessions). But a dry-run after #955 deployed showed the reaper STILL reaps nothing — the same idle sessions just moved to the next keep-reason: **active-process (the idle MCP servers each session runs)**. The reaper treats any live child process as "this session is working," so an idle session is shielded by its own idle tools. And the MCP-process reaper refuses to kill an MCP server whose session is still alive (correct — it only cleans up dead/orphaned ones). So idle-but-MCP-heavy sessions sat in a gap neither reaper would touch.

## What this changes

The active-process veto gets the SAME staleness logic #955 gave the commitment veto. A session that has had no user message within the staleness window (default 8h — your "no message today" rule) is treated as abandoned, so its idle children stop shielding it. Crucially, the session must STILL clear every other check after that — it has to be sitting at a positive idle prompt AND producing no new transcript output AND be confirmed across multiple ticks — before it's actually reaped. So this only catches "silent for a day + idle + producing nothing," never anything genuinely working.

- New config `monitoring.sessionReaper.reapStaleIdleWithActiveChildren` (default true).
- Reuses the existing 8h `staleCommitmentWindowMinutes` as the "abandoned" threshold.
- Audited via a new `staleIdleRelaxed` flag so a kill's reason is explicit (relaxed-because-CPU-flat vs relaxed-because-8h-silent).

## Why it's safe

- It only ever makes MORE sessions reap-eligible, and ONLY ones that are ALL of: 8h-user-silent, bound to a topic (so we can time-bound it — unbindable sessions are never relaxed), positively idle at the prompt, producing no transcript output, and confirmed across the reaper's multi-tick window.
- Every other guard (protected, recovery, pending-injection, recent-user, open-commitment, active-subagent, structural-long-work, main-process) is unchanged and still fires.
- `reapStaleIdleWithActiveChildren: false` restores the old conservative behavior exactly.
- The reaper is itself opt-in + dry-run-first, so nothing changes until an operator enables it.

## Honest scope

This is the third and final unblock in the chain (worktree/Spotlight #952 → stale-commitment #955 → stale-idle here) so the idle-session reaper can actually do its job. The operator asked to be "slightly aggressive" given repeated overloads; this is that, bounded by the four combined safety conditions. Validated with the dry-run that surfaced each layer.

## Evidence

`tests/unit/session-reaper.test.ts`: reaps a stale-idle idle-child session (flags staleIdleRelaxed); keeps when the session is NOT stale (message within window); keeps when the flag is off; keeps when stale-but-not-positively-idle (safety holds after relax); keeps when no bound topic. 35/35 green. `tsc --noEmit` clean.

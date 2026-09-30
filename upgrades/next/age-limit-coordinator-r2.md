# An age-limit kill records uncommitted work, so the session can be revived

## What Changed

The age gate in `SessionManager` ended the Instar 2.0 coordinating session
(topic 52075) at 2026-09-30 01:52:17Z as `terminal`, `midWork:false`. The
resume queue skipped it (`insufficient-evidence`). The session really was
idle: its last background task ended at 01:38, and it cleared its own expired
goal at 01:40. But its worktree held uncommitted work. The idle reaper
records that as `uncommitted-worktree-work` (strong evidence) before a kill.
The age-limit kill did not.

- `SessionManager.setWorktreeDirtyCheck()` receives the reaper's bounded,
  cached Build-Session Yield Safety probe. It is wired only when `yieldSafety`
  is live (dev-gated).
- Before an age-limit kill, the manager supplies the guard's observe-only
  evidence plus `uncommitted-worktree-work` when `session.cwd` is dirty. A
  failing probe omits the signal and never blocks the kill.

Topic sessions run in the agent home, and a dev agent's home checkout is
usually dirty. So where `yieldSafety` is live, an age-killed topic session is
in practice revived with its conversation, as idle-reaped ones already are.
The resurrection cap (≤2 per topic per 24h) bounds this. On the fleet,
`yieldSafety` is off, so nothing changes there.

Kill timing, the KEEP guard and the resume queue's gates (resurrection cap,
dry-run, drain-time checks) are unchanged.

## Evidence

- `tests/unit/session-manager-terminate.test.ts` drives the real monitor tick
  ("age gate R2"):
  - Replay: a live shell is kept on two samples 20 minutes apart. The later
    idle kill carries `midWork:true` and `uncommitted-worktree-work`, and
    `classifyEligibility` accepts it. This test fails with the fix line
    removed.
  - A clean worktree is still reaped and is `insufficient-evidence`.
  - A throwing probe omits the signal, and the kill still happens.
  - An active autonomous run keeps an over-age idle session.

## What to Tell Your User

If a long-running session of mine is ended for age while it still has
unfinished changes in its folder, it now restarts with its conversation
instead of staying down until you message it.

## Summary of New Capabilities

- Age-limit kills record uncommitted worktree changes as work in progress,
  the same way idle clean-ups do, so the restart queue can revive the
  session.

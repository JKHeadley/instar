# Local Verify re-posts its GitHub status when the reason changes

## What Changed

- `StatusReconciler` re-posts the `instar/local-verify` status when the projected reason changes under an unchanged state (it remembers the description it last posted per head), so GitHub no longer keeps showing a stale "verifying". Projection, gating and the per-minute cap are unchanged.

## What to Tell Your User

Nothing for ordinary agents. For people developing instar: the merge checker's status on GitHub now says the real reason a pull request is waiting.

## Summary of New Capabilities

- None; an accuracy fix.

## Evidence

New unit test replaying PR #2405's sequence fails on main and passes with the change; StatusReconciler suite 43/43.

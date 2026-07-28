# Plain-English overview — Stop the watchdog from interrupting a session that's actively working

## What this is

There's an internal safety watchdog (the "Compaction Sentinel"). Its job: when a long agent session hits its context limit and auto-compacts, that can occasionally leave the session stuck, so the watchdog gives it a little "nudge" to wake back up.

## The bug

When my session compacts (normal on a long run), the watchdog goes to nudge it. It already checks "is this session actively working right now?" and politely waits if so — **but only for about 4 minutes.** After that, it forced the nudge in **even if I was still actively working.** That forced nudge lands as an interruption of whatever I was in the middle of — the recurring "Claude was interrupted" the operator kept seeing. On a 23-hour session that compacts repeatedly, it fired several times.

## What this change does

The watchdog now **stands down** instead of forcing the nudge: if the defer budget runs out but the session is *still actively working*, it concludes the session is alive and already recovered on its own, and does **nothing** — it never interrupts a live, working turn. The time limit now caps how long it *waits*, not a license to barge in.

The one case the old "force after 4 minutes" was trying to catch — a session whose footer falsely says "working" while it's truly frozen — is already handled by the *other* watchdogs (the silence and context-wedge sentinels), which detect a genuinely frozen screen. So nothing is lost by this watchdog standing down.

The explicit opt-out is preserved: setting the defer budget to 0 still means "inject immediately even while working," for anyone who wants the old aggressive behavior.

## Safeguards / rollback

Pure logic change in one guard method, behind no flag (it's a strict de-escalation — the watchdog becomes *less* likely to act, never more). 24 unit tests pass, including a new regression test that fails if a still-working session is ever force-injected again. Rollback is a one-line revert. No data, no migration.

## What you need to decide

Nothing — it's a safety de-escalation that removes a known cause of interruptions. The only judgment call (made here) is that a still-working session should be trusted as alive rather than nudged, with the frozen-frame sentinels as the backstop for genuinely-hung sessions.

# A conversation stuck at its usage limit is moved again on the current Claude Code screen

## What Changed

The usage-wall rescue (moves a conversation that hit its account's limit to an account with room) never started on Claude Code's current screen layout: rows under the "You've hit your weekly limit" banner that the watcher did not know, a right-hand diff panel, and background-helper timers that tick every second all kept the watcher from reporting the wall. The watcher now cuts off a side panel, recognises each new row (anchored, so look-alike prose still counts as work), settles on the banner region only, and, when the screen still shows a banner it cannot clear, reads the session's own transcript: a latest main-turn usage-limit error (not the server throttle) confirms the wall.

The pre-emptive swap also stopped deferring forever on a session that reads busy for hours. A busy stretch now keeps its age across the 30-minute give-up. Once it has waited a full ceiling and the account is at or above `subscriptionPool.swapContinuity.wallEscalationPct` (default 95), the swap runs through the reactive class (two-minute grace, then the move with the interrupted-work note), at most once per busy stretch. The ledger row carries `wallEscalated: true`.

## What to Tell Your User

If a conversation runs out of its account's weekly or session allowance and another account has room, it is moved there again, as intended. Before this fix, Claude Code's newer screen layout hid the limit from the agent, and the conversation just sat there. Nothing to do.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Usage-limit detection on the current Claude Code layout, confirmed from the session's own transcript | Automatic |
| Busy conversations near the limit are moved instead of waiting indefinitely | Automatic; `subscriptionPool.swapContinuity.wallEscalationPct` (default 95, above 100 turns it off) |

## Evidence

Real pane captured from echo-instar-app on 2026-11-10 (fixture `tests/fixtures/usage-wall/claude-weekly-wall-side-panel-2026-11-10.txt`): the shipped detector returned false; the new one returns true, and returns false for the same pane with one line of real output after the banner. Its transcript held the structured row (`isApiErrorMessage: true`, `error: "rate_limit"`, text "You've hit your weekly limit · resets Nov 14 at 1pm"). The swap ledger shows nine busy deferrals and eight ceiling drops for that session between 06:06Z and 16:06Z, each new deferral restarting at deferralAgeMs 0. New tests: 25 detection/transcript/watchdog cases and 6 escalation cases (escalates at 97%, drops at 94%, age carries across a drop, once per episode, disable switch, idle path unchanged).

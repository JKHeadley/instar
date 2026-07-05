# ELI16 — Session Respawn/Kill Thrash Elimination

## What the bug is

The agent runs a housekeeping loop that ticks every 5 seconds. On each tick it checks each session and asks: "Has this session been sitting idle too long? If so, kill it." For a handful of protected sessions — ones with an open commitment or a recent user message — a guard always answers "no, keep it." That's correct. The problem is what happens next: the loop never remembered that it just got a "no." It didn't reset the session's idle clock, so 5 seconds later the exact same session was still "too long idle," the loop tried to kill it again, the guard said "no" again, and around and around it went — forever, or until the session finally aged out or the user sent a new message.

The cost was real. On the Mac mini running this, that loop fired roughly **8,472 "Killing zombie" warnings a day** and wrote about the same number of "skipped" audit records — one every ~5 seconds for a single stuck session. The audit log file (`reap-log.jsonl`) ballooned to **132MB / 463,000 lines**, almost entirely from this one spin. To the operator it looked like the agent was thrashing — restarting and swapping sessions dozens of times a day — when really it was one branch of a cleanup loop retrying a decision it had already lost, thousands of times over.

Interestingly, a sibling branch of the same loop (the age-based kill) already had a brake for exactly this problem — it backs off after a rejected kill. The idle-zombie branch was simply the one branch that never adopted that brake. That asymmetry is the entire bug.

## The fix

Instead of inventing something new, the fix **generalizes the brake the sibling branch already uses** (`AgeKillBackoff`, shipped in #863) into a shared `VetoedKillBackoff`, and gives the idle-zombie branch its own instance of it. Now, when a kill is vetoed, the branch records "I got a no for this reason" and **waits out a cooldown window (default 30 minutes) before trying again** — instead of retrying every 5 seconds. That takes the retry rate from thousands a day down to at most about 48 a day per stuck session, and drops the log's growth rate by over 95%.

Crucially, **the kill authority is completely unchanged.** No session that would be killed today stops being killed; no session that's kept today starts being killed. The only thing that changes is *how often a kill that was already rejected gets retried*. Every uncertainty (a missing config value, a changed protection reason, an unknown reason type) is designed to fail toward *more* checking, never toward silently skipping a legitimate kill. A safety brake (P19 breaker) also raises a single alert if one session stays permanently stuck, so a genuinely wedged session gets noticed instead of quietly cooling down forever.

## What ships now vs later

**Ships now (this PR):** the veto-backoff ledger + the breaker, wired into the idle-zombie branch, plus the config knob, tests, and a CI ratchet that makes the fix un-regressable. It ships **enabled on the development agent (Echo) and OFF on the rest of the fleet** — so a bad ship is inert everywhere except where it's being watched.

Merging this PR fixes the *loop*, but it does **not** by itself fix the mini's 132MB thrash: the code lands on the box with its switch off. The operator's actual symptom is resolved only in a **later, deliberate step** — after the fix has soaked healthily on Echo for a day, an operator flips the switch on the mini, restarts its server, and archives the old 132MB log to reclaim the space. "Shipped" and "the mini is fixed" are two separate milestones, and the spec is honest about that.

**Ships later (tracked separately):** bounding/rotating the reap-log file so it can never grow unbounded again (defense-in-depth); the same backoff applied to a rarer cross-machine post-transfer case (Fix C, ~1% of the churn, needs a real two-machine test); and swapping the session reaper's memory metric to a more accurate one (Fix D). None of those block this fix — they're defined, scheduled follow-ups, not gaps.

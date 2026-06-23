# ELI16 — The health panel that was stuck showing days-old news

## The problem in plain words

Instar runs a built-in "system review" — a batch of ~16 quick self-checks (is the scheduler alive, is messaging working, etc.) — and shows the result as a health summary. It's meant to run on a repeating timer so the summary stays current.

The timer is set to every 6 hours. But here's the bug: the review only ever ran *when the 6-hour timer went off* — it never ran *when the agent started up*. And this agent restarts pretty often (every update, every recovery bounce, restarts a few hours apart). Each restart resets the 6-hour timer back to zero. So if the agent restarts more often than every 6 hours, the timer never actually reaches 6 hours — and the review never runs again after the very first time.

The result: the health panel got frozen on whatever it last said. On this agent it was stuck showing a scary "critical — only 11 of 16 checks passing" from days ago (during a past incident), long after everything had recovered. Anyone looking at the dashboard would think the agent was on fire when it was perfectly healthy.

## The fix

Run one review shortly after the agent boots, in addition to the 6-hour timer. Now every startup refreshes the panel within about 30 seconds, so it always reflects the *current* state regardless of how often the agent restarts.

Two safeguards keep it sensible:
- **It waits ~30 seconds and runs in the background**, so it never slows down startup.
- **It skips if the panel is already fresh** (a review ran in the last hour). That way, if the agent is in a rapid restart loop, it won't pile up a review on every single boot — just one per hour at most. (If the timestamp is somehow unreadable, it errs on the side of running the review — better a fresh check than a stale one.)

## What it does and doesn't do

- It does: keep the health panel honest by refreshing it on every boot, so it shows current health instead of a days-old snapshot.
- It doesn't: change what the checks are or how the 6-hour cadence works, and it doesn't add any cost worth worrying about — the checks are all local (no AI calls, no network), so running one extra on boot is cheap.

There's an off-switch (`reviewOnStart: false`) for anyone who wants only the 6-hour cadence, and it's on by default because a health panel showing days-old "critical" status is a real, misleading bug. Low risk: it's an additive background timer with a freshness guard, covered by tests.

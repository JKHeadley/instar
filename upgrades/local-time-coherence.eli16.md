# The agent stops misreading its own clock

The agent kept two clocks without knowing it. Every hook that tells the agent "here's the current time" speaks in YOUR local time ("5:49pm PDT") — but every block that shows it conversation history spoke in unlabeled UTC ("[21:23]"). The agent has no way to tell those apart, so it did the natural thing: read both as the same clock. That's how it told Justin "you heard nothing between **9:23pm** and now" about a message sent at **2:23pm** his time — off by exactly the 7-hour UTC gap. The user experiences this as the agent being confused about basic reality.

The fix makes every timestamp the agent ever sees speak ONE language: the machine's local time, with the timezone written right on it — `[2026-06-05 14:23 PDT]` instead of `[21:23:10]`. History lines also now carry the date, so a conversation spanning midnight can't be misread either ("was that 12:30am today or yesterday?" stops being a guess).

Where this applies — every surface that renders history or status timestamps into an agent's context: the thread history a new session boots with, the history relayed when a conversation moves between machines, the recent-messages block injected on every Telegram message, the post-compaction recovery context, the Slack channel context, the session-start recent messages, and the lifeline's "last healthy" status line. One new shared helper does the rendering in code; the hook scripts get a tiny equivalent helper with a safe fallback (if a timestamp ever fails to parse, it renders the old way instead of crashing the hook).

Existing agents get this automatically: the built-in hook scripts are always refreshed on update, and the code paths ship with the next release. Nothing about WHEN things happen changes — only how the time is written down. There is no new config, no new decision surface, and the worst possible failure (a malformed timestamp) renders the way it used to render rather than breaking anything.

What you need to decide: nothing — this is a pure rendering fix for a live mis-statement the agent made to you. The PR is the review surface.

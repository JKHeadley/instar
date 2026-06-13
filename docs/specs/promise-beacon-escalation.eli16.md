# Promise-Beacon Escalation — plain-English overview

## The problem, in one story

When the agent tells you "I'll get back to you the moment X is ready," it doesn't just rely on remembering — it writes that promise down in a durable list (a "commitment"). A background watcher called the PromiseBeacon is supposed to keep that promise alive: it pings every so often and nudges the agent to follow through.

But there's a hole. The agent does its actual thinking inside a "session" (a live process). Sessions don't live forever — they get cleaned up when they go idle, hit a time limit, or the machine is under load. Here's the bug: when the session that made a promise dies, the PromiseBeacon *notices* — and then just marks the promise "broken, session lost" and goes quiet. It writes a tombstone. Nobody starts a new session to actually finish the promised work, and you don't get told anything honest like "my session ended, I'm picking this back up."

This actually happened on June 12: the agent promised Justin a link "the moment it's live," the session died 15 minutes later, and the promise sat in the list for three and a half hours while Justin heard nothing. The list remembered perfectly. Nothing *acted* on it.

## What this change does

It adds the missing step: when a promise's session dies, instead of silently giving up, the agent tries a short, safe ladder of actions:

1. **Bring it back to life.** Start a fresh session for that conversation and hand it the promise — "your last session ended before delivering this; finish it or tell the user where things stand." Now a real agent turn happens again.
2. **If it can't start a session** (the machine is at capacity, out of quota, or this isn't the right machine to act), **tell you the truth**: "Still on X — my session ended before I delivered it, I'll pick it back up shortly." Never a fake "still working."
3. **If even that keeps failing** several times in a row, only *then* mark the promise broken — but loudly, with an alert to the operator, so a genuinely-unkeepable promise is impossible to miss.

## Why it's built carefully

The whole reason sessions were dying in the first place (the June 5 meltdown) was runaway loops with no brakes. This new "revive the session" behavior is itself a loop, so it gets the same brakes the agent ratified into law: it can only retry a few times, only one revival per conversation at a time, it won't fire on a backup machine, and reviving a session re-stamps the promise so it doesn't instantly try to revive again. It also can't accidentally deliver the same thing twice.

## What changes for you

Mostly invisible when things work — promises just quietly get kept even if a session dies in the middle. When they *can't* be kept, you get an honest heads-up instead of silence. It ships turned off, then in a watch-only "here's what I would have done" mode first, and only goes live after that evidence looks clean — so it can't misbehave on the way in.

## The principle it serves

This change serves the constitutional standard **Close the Loop** — "every loop the agent opens (a promise to a user) must be durably registered and re-surfaced on a cadence until it reaches a *deliberate* close." Today a promise whose owning session dies is silently closed as "broken"; this adds the missing rung that re-surfaces it *into action*, not just into a postmortem record.

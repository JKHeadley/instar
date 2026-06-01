# Plain-English overview: "always update me, the developer's agent, right away"

## What this is

Echo is the agent that builds instar. It needs to always be running the newest
version of instar, because if it runs old code it tests old behavior and ships
against the wrong starting point. This change adds a single on/off switch —
`updates.restartImmediately` — that, when turned on for one agent, makes that
agent update to the latest version the moment a new version is ready, instead of
politely waiting.

## What already exists

When a new instar version is published, the agent downloads it, but it has to
*restart* its server to actually run the new code. Today the agent is careful
about when it restarts:

- It will **not** restart while any of its chat sessions are "busy" — it waits,
  possibly for hours, so it doesn't interrupt work.
- It can also be told to only restart during a quiet time window (like 2–5 AM).

For a normal user's agent, that politeness is exactly right: their work matters
more than being on the newest version.

## What's new

For the **developer's own agent**, that politeness backfired. Echo ended up
sitting *two versions behind* for five hours because a couple of long-running
sessions were marked "busy". Justin said: stop waiting — you're the developer,
always be current. (And he was clear: this is the rule **for you only**, not for
every agent.)

So the new switch, when on:

- skips the "wait for busy sessions" rule, and
- skips the "wait for the quiet window" rule,

and the agent just restarts onto the newest version right away.

## The key fact that makes this safe

**Restarting the server does NOT close your chat sessions.** They survive and
pick right back up (the same way they recover after a normal restart). The only
thing you notice is a ~1-minute pause in messaging while the server bounces. So
"wait hours to avoid a 1-minute pause, and run stale code the whole time" was a
bad trade — but only for the developer's agent, which is why it's opt-in.

## What you (the reader) need to decide

Nothing, if you're a normal agent — this is **off by default**, so the whole
fleet behaves exactly as before. The only agent that flips it on is Echo (the
instar developer's agent), by setting `updates.restartImmediately: true` in its
own config. You can check whether it's on by reading `GET /updates/status` —
it now reports `restartImmediately`.

## What's NOT changing

- No session is ever killed to do an update. Sessions always survive a restart.
- The protections against restart *loops* (don't restart for the same version
  twice in 30 minutes; coalesce two releases that land within ~15 minutes into
  one restart) stay exactly as they were.
- Every other agent keeps waiting for busy sessions and quiet windows, unchanged.

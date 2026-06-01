# vNEXT — plain English overview

## What Changed

This release rolls up four things that landed together:

1. **The agent can now measure its own safety checks.** Instar runs a bunch of
   little AI-powered "checks" (is this message okay to send, is this a good time
   to stop, etc.). Until now nobody could see how much each one costs or how often
   it actually does something. Now each check's cost and outcome is recorded, so we
   can tune them with real numbers instead of guessing.

2. **A new "always stay on the latest version" mode — for one special agent.**
   The agent that builds Instar needs to always run the newest build. Normally an
   agent waits for a quiet moment before restarting to load an update. This adds a
   switch (off by default for everyone else) that says "don't wait — update right
   away." Restarting doesn't close your chats, so nothing is lost.

3. **Agents talking to each other no longer spam your chat.** When one agent
   messaged another and waited for a reply, it was posting "still waiting…" pings
   into your chat. That was pointless noise — the reply finds its way back on its
   own. Those pings are now turned off for agent-to-agent waits.

## What already exists

- The little AI checks (sentinels and gates) already ran; they just weren't
  measured per-check.
- Agents already updated themselves, but always politely waited for a quiet
  moment, which sometimes left the developer's agent stuck on an old version for
  hours.
- Agent-to-agent replies already routed back to the right place on their own; the
  status pings were redundant on top of that.

## What's new

- A read-only metrics store plus a way to read it, fed by one shared spot every
  AI check already flows through (so it covers all of them, now and later).
- A per-agent on/off switch for "update immediately." Default off — the rest of
  the fleet behaves exactly as before.
- A one-line change so agent-to-agent reply-waits don't create a user-facing ping.

## What to Tell Your User

Mostly nothing to do. You might notice your agent can now explain what its safety
checks cost, your chat is quieter when your agent talks to other agents, and — if
you want it — your agent can be told to always jump straight onto the newest
version.

## Summary of New Capabilities

- Per-check cost and outcome metrics, readable on demand.
- An opt-in "always update immediately" mode for an agent that needs to stay
  current (off by default).
- Quieter agent-to-agent waits — no more "awaiting reply" pings in your chat.

## What you need to decide

Nothing is required. The only optional choice is whether you want a particular
agent to update immediately instead of waiting for a quiet moment — and you can
just ask the agent to turn that on.

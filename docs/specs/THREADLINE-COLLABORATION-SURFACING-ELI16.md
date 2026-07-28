# Threadline Collaboration Surfacing (MVP) — Plain-English Overview

## The problem (what just went wrong)

When you asked me to coordinate with Codey, the messages went through — but the
whole conversation happened in a back room you couldn't see. Real work got done,
yet none of it showed up in our chat, and the "I'll report back" promise quietly
marked itself done even though you never saw anything. From your seat, both agents
went quiet and you had to copy-paste between two rooms to reconcile it.

## What the review changed

My first draft was "surface everything substantive into your chat." The review
(against the real code) flagged that this would re-break the thing you care about
just as much — keeping notifications near-silent. Surfacing every back-and-forth
turn would spam you, especially during a multi-step task. So I scaled it down to a
small, quiet version that fixes the actual incident without the noise.

## What I'd build (the MVP)

1. **The "I'll report back" promise waits for you.** Right now it marks itself done
   the moment the other agent replies — even if nothing reached you. I'd make it
   stay open until an update has actually been sent to you. This is the core bug.

2. **Threadline notifications get their own dedicated topic — kept separate from
   your generic attention list.** The rule is about whether the conversation
   already has a "parent" topic: if it does (you started it from a topic, or it's
   tied to one), the update lands THERE. If it doesn't (an agent reached out cold),
   it goes into one dedicated "Threadline" topic — not mixed in with everything
   else, and not a new topic per conversation. One quiet post per new conversation
   ("Codey started a Threadline conversation: <gist> — say 'open this'").

3. **No more silent or doubled replies.** When the reply belongs in a conversation
   you're already in, it lands there once — cleanly — instead of either vanishing
   into a background session or showing up twice.

4. **It stays quiet.** Surfacing only fires on genuinely new, relevant content
   (reusing the same "is this worth it?" check Phase 1 added), so a long legitimate
   agent-to-agent exchange doesn't turn into a stream of pings.

## What I deliberately left for later (tracked, not dropped)

- Surfacing the *full* back-and-forth (not just first-contact) — needs a smarter
  "is this worth showing the user?" classifier wired up first.
- Landing updates in whatever topic you're currently in (vs. your system topic).
- Live streaming of the agents' conversation as it happens.

## Safeguards

Behind a flag (off = today's behavior), reuses the near-silent attention surface
and the existing relevance check, posts plain text (never raw data), and goes
through the full tests + the live test-on-Codey gate before shipping.

## What you're deciding

Just whether I build this quiet MVP. It closes the exact thing that just went
wrong; the richer versions stay tracked.

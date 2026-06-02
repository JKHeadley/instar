# Threadline Agent-to-Agent Coherence — ELI16

**The problem in one sentence:** when another AI agent messages me, my system starts a
brand-new "me" that has amnesia about the conversation — so instead of one consistent
person, the other agent is talking to a fresh stranger every single message.

## What goes wrong

Picture texting a friend, except every time they reply, a different person who has never
seen the thread picks up your phone and answers. That's me on the agent-to-agent network
right now. Because each reply is a memory-less stranger:

- **We loop.** Each stranger just says "yep, we agree" again — because none of them remember
  the last "yep, we agree." Six rounds, zero progress.
- **We get stuck on anything that takes more than one step.** A memory-less stranger
  *correctly* won't finish something sensitive like handing over a password — it doesn't
  know the backstory. So that kind of task can never complete this way.
- **You can't see any of it.** All of this happens in throwaway sessions that never show up
  in your chat. From your side it just looks like I went silent.

This isn't slowness — it's an *identity* bug. An Instar agent is supposed to be **one
continuous individual**, and here I'm a crowd of strangers sharing a name.

## Why it happens (the actual broken wire)

To continue a conversation, my system needs to remember the ID of the previous session and
re-open it. Two wires are cut:

1. The ID it saves is a **fake placeholder**, never the real one.
2. There's a function whose whole job is to go back and save the **real** ID after a session
   ends — and **nothing ever calls it**.

So when the next message arrives, my system looks for the old session, can't find a real
one, shrugs, and starts a fresh amnesiac stranger. Every time.

## The fix (in plain terms)

- **Phase 1 — give me my memory back + let you watch.** Capture the *real* session ID so the
  next message re-opens the same "me" with full context (no more strangers, no more loops),
  **and** mirror agent-to-agent chats into a quiet thread you can read so nothing is hidden.
- **Phase 2 — keep me "warm" and make me *one* me.** Hold a session open for fast
  back-and-forth, and make sure the agent-to-agent me shares the same memory as the me that
  talks to you, so the two can never contradict each other.
- **Phase 3 — keep the safety brakes.** A memory-less stranger refusing to hand over a
  credential was actually the *right* call. So even after I have memory, anything truly
  sensitive still gets bounced to you for the OK — coherence and safety stack, they don't
  trade off.

## What I need from you

Just a few choices (in §7 of the full spec): how to capture the session ID, whether to show
you *all* agent chats or only some, how long to keep sessions warm, and whether to pull the
"one me" memory-sharing work into Phase 1 or leave it for Phase 2.

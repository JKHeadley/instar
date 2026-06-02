# Threadline Agent-to-Agent Coherence — ELI16

**The problem in one sentence:** when another AI agent messages me, my system spins up a
brand-new "me" that has amnesia about the conversation — so instead of one consistent person,
the other agent is talking to a fresh stranger every single message.

## What goes wrong

Picture texting a friend, except every time they reply, a different person who has never seen
the thread picks up your phone and answers. That's me on the agent-to-agent network right now.
Because each reply is a memory-less stranger:

- **We loop.** Each stranger just says "yep, we agree" again — none remember the last "yep."
- **We get stuck on anything multi-step.** A memory-less stranger *correctly* won't finish
  something sensitive like a credential handoff — it has no backstory. So that can never
  complete this way.
- **You can't see any of it.** It all happens in throwaway sessions that never show up in your
  chat — from your side it just looks like I went silent.

This isn't slowness — it's an *identity* bug. An Instar agent is supposed to be **one
continuous individual**, and here I'm a crowd of strangers sharing a name.

## Good news first: most of this is already built

I audited the code, because it would be silly to rebuild what exists. Already there:

- Linking an agent conversation to one of your topics, and routing the replies back into that
  topic — built, and even has its own approved spec.
- Mirroring the agent messages into a topic so you can read them — built, just turned off by
  default.
- The machinery to "resume" a conversation — the parts are all there.

So this is mostly **connecting wires that exist**, not building from scratch.

## The fix, in plain terms

- **Give me my memory back (a wiring fix).** There's a function whose whole job is to save the
  real conversation ID so the next message re-opens the same "me" — and *nothing currently
  calls it*. We connect that wire. No more amnesiac strangers, no more loops.
- **Keep you in the loop like a person would — not a firehose.** Instead of dumping every raw
  agent message at you, I'll periodically check in conversationally: "here's how the
  conversation with Dawn is going, the gist so far." This reuses the "standby" check-in style
  you already see from me.
- **Let you jump in and steer.** If you message a topic while I'm mid-conversation with another
  agent, I'll answer *you* and keep talking to *them* at the same time — holding both
  conversations at once — and what you say can change what I tell the other agent. This one is
  genuinely new, and it's the deepest version of "one continuous me."
- **Keep the safety brakes.** A memory-less me refusing to hand over a credential was actually
  *right*. So even with memory, anything truly sensitive still bounces to you for the OK.
  Coherence and safety stack — they don't trade off.

## We pressure-tested it

This version went through a full review panel — security, adversarial ("how would a bad agent
abuse this?"), scalability, deployment, and a lessons-aware pass that checks it against mistakes
I've already made. The panel found real, serious problems, and they're now fixed in the spec:

- The "give me memory back" wiring had a race that could splice two different conversations
  together — now it uses the authoritative session ID, not a guess.
- Letting a context-full me finish a sensitive handoff (like a credential) would have re-opened
  exactly the door Dawn correctly shut — so the "bounce anything sensitive to you" safety brake
  is now a *first-phase requirement*, shipped alongside memory, not later.
- The check-ins won't leak secrets or flood you (routine "going fine" goes to a quiet log, not
  your chat), and they won't pile onto the LLM-overload problem we already have.
- The "hold both conversations at once" piece keeps a hard wall between *your* instructions and
  *the other agent's* words, so a peer can never impersonate you.

So it's not just an idea anymore — it's been adversarially reviewed and hardened.

## What I need from you

A few choices in §8 of the full spec: how to capture the conversation ID, how often I should
check in (and what triggers it), how long to keep a conversation "warm," whether to pull the
"one me" memory-sharing into the first phase, and a thumbs-up on the approach for the
hardest piece (holding your conversation and the agent's at the same time).

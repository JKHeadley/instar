# Cross-Machine Seamlessness — Plain English

*Companion to [`CROSS-MACHINE-SEAMLESSNESS-SPEC.md`](./CROSS-MACHINE-SEAMLESSNESS-SPEC.md). Read this first; the technical spec is the appendix.*

## The dream (measured the right way: from the user's side)

Picture one employee — call her Luna — who has a desk in two offices. You should be able to walk into either office and it's the same Luna: she remembers the conversation you were just having, the task she was halfway through, everything. You never notice she's actually in two places. That's the goal: **one agent that follows you across machines with no amnesia.**

**The crucial point: "seamless" is judged entirely from the user's chair, in whatever channel they're using.** Telegram is the default and the one we test first, but the exact same promise has to hold on Slack and any other channel we add — so we build it as a general rule of the channel layer, not a Telegram special case. It's not about clever syncing under the hood; it's about what the person messaging the agent experiences. The test is simple: someone is mid-conversation (on Telegram, Slack, wherever), the agent quietly switches machines underneath them, and they notice *nothing* —

- no message of theirs gets lost,
- they never get the same answer twice,
- the reply still knows exactly what they were just talking about (no "sorry, who is this?"),
- no sudden "hi, how can I help you?" restart,
- no weird long pause.

Everything in this spec exists to deliver that experience. The plumbing is just the means.

## The honest bar (your nudge): "as smooth as a compaction pause," not magic

You pushed back on the word *seamless*, and you were right — chasing magically-perfect, zero-gap invisibility is where you'd over-build. So here's the honest yardstick we're actually holding ourselves to: a machine handoff should feel **no worse than two things the agent already does that you're used to** — pausing to *compact* (tidy up its memory), or spinning up a *fresh session* when you message a quiet topic and it takes a beat to get up to speed. Nobody expects those to be invisible. They expect them to be quick and to come back knowing what's going on. That's exactly the bar for a handoff. The nice bonus: that means we reuse the catch-up machinery we already trust, instead of building a fragile new "always-live wire" between machines just to chase perfection.

So the goal isn't "perfectly invisible" — it's **carry over as much fresh context as we possibly can, and degrade gracefully when we can't.** And there are really two flavors of handoff, with two fair expectations:

- **Planned hand-off** (both machines awake, one politely passes the baton): near-instant, full context goes across cleanly. This is the smooth case.
- **Hard failover** (a machine crashes, or the internet drops while you're in the middle of a live test): best-effort. The backup picks up from the last good save — it might miss the last few seconds, exactly like a session that crashed and recovered. We *deliberately don't* twist ourselves into knots trying to make that rare worst-case perfect. If you were running live development tests when a machine's internet dropped mid-handoff, a tiny gap is honest and fine.

**And one thing you specifically asked for: the agent always knows which machine it was just on, and that a handoff happened.** It's cheap, and it lets the agent be upfront — "picking this back up from the other machine" — when its context is a little behind, instead of pretending nothing changed. It also feeds the idea you raised early on, that each machine can know what's specific to it.

### The user stories driving it

- **Failover mid-chat:** the machine serving me dies, I keep texting, I notice nothing.
- **My two machines:** same agent, same conversation, on either machine — I switch and don't miss a beat.
- **Reliability I feel but don't see:** the agent is just always there and coherent; that it spans machines is invisible. More machines = more reliable, never more noise.

## What we already had — and what we just proved

We'd already built most of the hard plumbing: the two offices know they're the same company, they share a filing cabinet, and there's a rule for who's "on duty."

On May 26 we ran it on two real machines for the very first time (your laptop and a Mac mini, using a throwaway test agent so nothing real was at risk). Two things genuinely worked:

- **Linking the two machines into one agent** — done, on real hardware.
- **A backup taking over when the main one is dark** — the mini, finding nobody home, correctly said "then I'm on duty."

## The two things that broke (this is the useful part)

1. **Two captains.** After the mini took charge, the shared directory listed *both* machines as "on duty" at once — nobody marked the powered-off laptop as "off duty." The info to fix it was sitting right there (the laptop hadn't checked in for nearly an hour), but no rule was actually enforcing the cleanup.

2. **No automatic filing.** Even with the mini running, it wasn't automatically filing its updates into the shared cabinet. I had to walk the paperwork over by hand. So the "they quietly keep each other in sync" promise wasn't actually happening.

And the headline feature — handing the conversation from one live machine to another with no memory loss — we couldn't even test yet, because that piece doesn't exist.

## What this spec builds (three pieces, in order)

1. **One captain, always.** A simple, automatic rule: if two machines both think they're on duty, the one that's actually been active recently wins, and the silent one is marked off duty. No human needed; it just settles itself. (And if it genuinely can't tell — say both are equally active — it asks you rather than flip-flopping.)

2. **Automatic filing.** The on-duty machine quietly saves its updates to the shared cabinet on a schedule, and the backup reads them. This is the thing that was missing — and we'll add a test that would have caught it.

3. **The seamless conversation experience (the real magic).** This is the user-facing piece, and it has three parts working together: (a) the current conversation and half-finished work get continuously copied to the backup machine, so it's already caught up; (b) the "phone line" to the channel is handed over cleanly — only one machine is ever answering at a time (so you never get a double reply), and it's handed off at an exact spot so no message slips through the cracks; (c) the new machine picks up the thread instead of starting fresh, so the very next reply still knows what you were talking about. The handoff rule is strict: the new machine has to confirm "I've got everything and I've got the line" *before* the old one lets go.

**And it's not Telegram-only.** Each channel has its own version of "pick up exactly where I left off" — Telegram tracks a message number, Slack has its own bookmark, and so on. So instead of hard-coding Telegram, the spec defines one "clean handoff contract" that every channel has to meet, builds it for Telegram first as the reference, and proves it on Slack too. Any new channel we add later is only considered done when it passes the same handoff test — so seamlessness comes built-in, not bolted on per channel.

## You're in control of the dial

You told me this has to be tunable — balance smoothness against wasted effort. So everything has a knob: how often they sync, how fresh the backup's copy has to be, how aggressive the handoff is. The defaults are tuned for a personal two-machine setup; someone with ten machines or a tight budget can dial it down. More machines means more reliability — without meaning more constant chatter.

## What's NOT in this spec (on purpose)

How an agent *installs itself* onto a new machine in the first place (the SSH-and-git access we set up by hand today) is a separate, related write-up — your "agent does it all after one yes" standard. I'm keeping the two specs separate so each stays focused, but they're cousins, and today's hands-on run feeds both.

## What the formal review tightened (and why it matters to you)

I ran the draft through the formal review — five different expert "hats" plus an outside-model reviewer. They agreed on a handful of real holes, and fixing them genuinely made the design safer. In plain terms:

- **"One captain" now uses numbered tickets, not a clock.** The first draft picked the captain by "who checked in most recently," which a machine with a wrong clock could win unfairly. Now there's a single numbered badge (each new captain takes the next number), and you can only act as captain if you're holding the current badge. Clocks can't game it anymore.
- **No double-replies is now a hard lock, not a hope.** The draft assumed "only one machine listens, so no double answers." Reviewers pointed out that during a messy handoff both machines can briefly think they're listening. So now every incoming message gets a ticket and is only ever *answered once* — even if it arrives twice, the second one is recognized and ignored. Double replies become structurally impossible, not just unlikely.
- **The private wire between your machines is now locked down.** The conversation copy that flows to the backup can contain sensitive stuff. The draft left that "to be decided" — now it's required to be encrypted, the receiving machine has to prove it's really yours, and any secrets get stripped before they cross.
- **One manager runs the whole handoff.** Instead of five parts each doing a piece (which is how things fall through cracks), one component owns the handoff start-to-finish and won't let go of the baton until the other machine has *proven* it caught up.
- **It won't spam your repo or your phone.** Heartbeats no longer get written into permanent history (which would've bloated things), and if the two machines genuinely can't agree, you get *one* clear question — not a buzz every 30 seconds.

The honest bar you set survived intact: a handoff is still allowed to feel like a quick compaction pause. What review added is that it's *never* allowed to lose or double-answer a message while doing it.

## Bottom line

The foundation is real and works. The "seamless" part is now three clearly-defined pieces instead of a vague wish — and we know they're the right three because we watched the system miss exactly those on real hardware. And thanks to your nudge, the bar is now honest: a handoff should feel no worse than a compaction pause or a fresh-session catch-up — quick, and back up to speed — not a magic trick we'd over-engineer chasing.

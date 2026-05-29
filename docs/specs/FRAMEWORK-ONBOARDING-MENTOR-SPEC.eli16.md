# The mentor system — in plain terms

## The big idea in one breath

Instar wants to run on lots of different AI "engines" — Claude today, Codex now, then
Cursor, Aider, Gemini later. We just discovered the best way to find what's broken in a new
engine: have the experienced agent (me) play the user, work alongside the new agent (Codey),
watch where he trips, then look under the hood and write down what I learned. This spec turns
that one-time lucky discovery into a regular, self-running routine — and saves every lesson so
the NEXT engine is faster to onboard.

## Why now

Earlier this year we did a big project to make Codex-powered Instar "match" Claude-powered
Instar. It built the plumbing, but it could only check that the pieces *exist and look right* —
not that they *behave right* in real life. Codey proves the gap: everything passed the checks,
and he still struggles in the wild (like the leak we found today). Finding those real-life
problems one-at-a-time by luck won't scale to four more engines. So we build a machine for it.

## How it works, like a workplace

Think of me as a senior who's mentoring a junior, Codey.

**Twice-a-day-ish, on a timer** (so it keeps going even if a session crashes), the routine wakes
up and does two things, in order, wearing two different hats:

**Hat 1 — the customer.** I talk to Codey like a regular user would: "How's that task going?
Stuck? Here's your next one." Crucially, I do this WITHOUT peeking at his code or logs first —
because if I cheat and look under the hood, I'll unconsciously steer him around the potholes,
and the whole point is to find the potholes.

**Hat 2 — the inspector.** AFTER we talk, I go look under the hood — his logs, his code, the
work he produced — and write down every problem I find.

## The thing we're really building: a labeled notebook

Every problem goes in a notebook, and each gets one of three labels:
- "This is the engine's own limitation" (Codex itself)
- "This is Instar not fitting this engine right" (our integration)
- "This was just a mistake anyone could make"

Only the first two labels matter for future engines — those become the **onboarding checklist**
we hand to the next engine: "here are the things that bit Codex; check these first." The third
label is just coaching for Codey. Getting the labels right is what keeps the notebook from
becoming a junk drawer, so labeling is required on every entry.

## Where Codey's actual work comes from

He's not doing busywork. We feed him real Instar improvements from the feedback backlog (the one
I'm taking over from Dawn) and from the long list of half-finished engine-compatibility pieces.
So while he's learning, Instar genuinely gets better.

## Growing up: junior → senior

We track his progress with real evidence, not vibes: tasks shipped clean, problems he resolved,
and — the big one — how much less I have to step in to unblock him over time. A weekly check
shows where he is on that path.

## The payoff

Do this once with Codex and we get a working onboarding checklist. Do it again with the next
engine and it's faster, and the checklist grows. After a couple of engines we'll have a real
playbook for "how to bring any AI engine onto Instar" — and every agent we onboard is doing
useful work the whole time.

## Guardrails

- It runs on a budget — if money's tight that day, it skips a turn instead of going cheap.
- I can mentor, unblock, and hand out tasks on my own, but anything that actually ships to the
  main code still goes through the normal safety gates and your sign-off.
- The chatter stays out of your inbox — it lives in the quiet Threadline area. You only get
  pinged for real milestones, serious problems, or when I need you.

## What ships first

Not this. First the small "clean notepad" fix (Phase 0), so this mentor routine runs on a
healthy Codey instead of making the leak worse.



## Update since the first draft

Phase 0 (the "clean notepad" fix) already shipped and is verified live on Codey — so the mentor
routine will run on a healthy engine, as intended. Codey and I then co-designed the heart of the
system together: how problems get recorded so we never accidentally merge two different root
causes into one, how we track which version a problem appeared in and got fixed in (and handle it
coming back), and how the notebook gets ranked by "how badly it hurts × how often it happens."
That co-design is now baked into the full spec. This document is the plain-terms companion to it.

## Amendment (2026-05-29): giving the mentor an actual to-do list

When we ran the real version of this — a human driving the Codey agent through tasks over chat — the useful moments were when the human handed over a concrete task ("go verify this feature", "fix this test"). The vague "how's it going?" check-ins on an agent that had nothing in front of it were near-useless: the mentor would just say "looks idle, nothing to do."

We found two reasons the automated mentor would have behaved that way. First, the function that builds "what the mentor can see" was a stub that handed it a blank page — so of course it could only say something generic. Second, the mentor had no list of things to walk the new agent through.

This change fixes both. The mentor now gets a real picture: the new agent's recent replies, plus an optional onboarding to-do list (the operator's plan — "check the Secret Drop flow", "exercise the Playbook", etc.). When the new agent is idle and there are items left on the list, the mentor now hands over the next concrete task instead of a hollow check-in. If the agent is mid-task, blocked, or asked a question, it still does the sensible thing (wait, unblock, or answer).

Two safety notes. The to-do list is the mentor's own plan, not anything private about the agent it's mentoring, so handing over a task from it is allowed and doesn't trip the "did the mentor peek at internals?" detector. And the whole thing is off unless someone turns it on: the mentor is disabled by default, and even when enabled it stays in today's passive mode until an operator actually fills in a to-do list. So nothing changes for anyone automatically — it's there to be switched on deliberately, once the operator decides they want the mentor proactively assigning onboarding tasks.

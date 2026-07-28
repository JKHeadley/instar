# Multi-Machine Session Pool — the plain-English version

## The big idea
Right now, when your agent is installed on two machines, only ONE of them is "awake"
and doing the work; the other just sits as a backup, ready to take over if the first
one dies. That's safe, but it wastes a whole machine, and everything you say has to go
through that one machine.

We want to flip that: **every machine the agent lives on is awake and working at the
same time.** Think of it like a small team instead of one person with a backup napping
in the corner. Each conversation you start gets handed to whichever team member (machine)
is the best fit and least busy. You never know — and never need to know — which one is
actually answering you.

## Who's in charge?
There still has to be ONE machine that plays "dispatcher" — the one that decides which
machine takes each new conversation. We call that the **router**, and it's like holding
a talking stick: only one machine holds it at a time. If the machine holding the stick
goes down, the others automatically pick a new one (this part already exists — we're just
pointing the existing "who's in charge" machinery at the dispatcher job instead of at the
whole agent).

## Each conversation has an owner
Every conversation gets a little ownership tag that says "machine B is running this one
right now." That tag guarantees two machines never accidentally answer the same
conversation at once. And the tag can MOVE — which is how a conversation hops from one
machine to another.

## Moving a conversation (the cool part)
Sometimes a conversation needs to move:
- the machine it's on is getting overloaded,
- the task needs special hardware (a GPU, a particular local model),
- you said "run this one on the mini,"
- or the machine it was on just went offline.

When that happens, the agent **transfers** the conversation to another machine. To you,
it feels exactly like when a session "restarts" today — the new machine reads the
conversation history and your synced files and picks right up where you left off. No
starting over, no "wait, who am I talking to?"

## Naming your machines (and moving a chat to one)
The dashboard has a **Machines tab** that lists every computer the agent lives on, with
its specs (chip, memory) and how busy each one is. Every machine gets a friendly
**nickname** automatically (like "MacBook Pro" or "mac mini"), and you can rename them to
whatever you want. Once a machine has a nickname, you can just say **"move this to the
mini"** in the middle of a conversation and the chat hops to that machine and keeps going —
same thread, nothing lost. That move-by-nickname is exactly the headline thing we'll test
end-to-end: start talking on one machine, say "move this to &lt;name&gt;", and watch the
conversation continue smoothly on the other one.

## Never drop, never double
The whole point is it stays invisible. Across any move or any machine dying, you get
**exactly one** reply — never a dropped message, never the same reply twice. We already
have the machinery that guarantees this (a per-message ledger); we're extending it to
cover the new "conversation hopped machines" cases.

One honest footnote: this "exactly one" promise is about the **chat** — your messages and
the agent's replies. If, right as a conversation hops machines, the agent was in the middle
of doing something to the OUTSIDE world (sending an email, posting to another service), we
can't magically guarantee that outside action happens exactly once across the hop — that
action might get retried. The agent handles that the normal way any careful program does
(tagging such actions so a repeat is recognized), but we say it plainly rather than pretend
the chat-level guarantee covers everything.

## How the "owner tag" and "talking stick" actually stay honest
We don't add a fancy new database to keep these tags straight — instar's rule is "no
database, everything's a file," and we keep it. The tags live in the same shared git the
agent already uses to sync its files. Git has a quiet superpower here: when two machines
try to grab the same tag at the same instant, the shared copy accepts only the FIRST and
bounces the second — so they can't both win. The only tricky case is a machine that loses
its internet mid-grip: it can't see the shared copy, so it might THINK it still holds a tag.
We handle that with a timer — if a machine can't re-confirm its grip within a short window,
it lets go on its own (goes quiet) instead of risking a double-answer. That timer runs off a
"stopwatch" clock that can't be fooled by the computer's wall-clock jumping around (a real
bug we've hit before), so a laptop waking from sleep can't grab something it shouldn't.

## What we already have vs. what we're building
We already have: the talking-stick election, the secure machine-to-machine connection,
the "pick up where you left off" resume, the no-drop/no-double ledger, and a first-class
"Projects" tracker to run this build.

We're building: the **dispatcher** (decides who runs what), the **ownership tags** (one
owner per conversation), a **live scoreboard** of how busy/capable each machine is, and
the **move-a-conversation** machinery. Plus: letting more than one agent live on the same
machine and share it fairly.

## How we'll know it's done
Two real machines running at once. New conversations land on the right machine. A live
conversation moves between machines cleanly. The dispatcher machine dies and another takes
over with nobody noticing. A machine goes offline and its conversations re-appear elsewhere.
And the real test: we drive your actual Telegram, force a move and a machine-death
mid-conversation, and you get exactly one smooth reply each time.

## Why it's safe to build
It ships "dark" — turned off — and turns on in stages, each stage proven before the next.
A one-machine agent acts EXACTLY like it does today (it's just its own dispatcher and its
own only worker). Nothing changes for you until there's genuinely a second machine to
share the load.

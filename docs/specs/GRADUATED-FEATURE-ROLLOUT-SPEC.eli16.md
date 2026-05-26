# Graduated Feature Rollout — the plain-English version

## What you asked

Two things, after SessionReaper shipped: (1) make the "weekly check-in that pushes a new feature toward fully-on" a standard, not a one-off; and (2) check whether our **initiative tracker** is actually being used — because if SessionReaper didn't show up in it on its own, our infrastructure isn't living up to "the user shouldn't have to remember; Instar should use its own tools automatically."

## What I found

These two turn out to be the **same problem**.

We have an initiative tracker — think of it as a whiteboard for "big things in progress," with columns showing how far along each one is. It works. But the only way anything gets onto that whiteboard is if someone walks up and writes it there by hand (a command, or a manual API call). Nothing puts things on it automatically.

So I checked: **SessionReaper was never on the whiteboard.** A whole feature — specced, reviewed, built, merged — and the tracker had no idea it existed. The only things on it are there because someone manually added them. That's exactly the gap you suspected.

And here's why it connects to your first ask: a "push it toward fully-on" check needs two things — something to *put the feature on the board* in the first place, and something to *keep nudging* until it's done. Those are the same two things the whiteboard is missing to be useful on its own.

## What I'm proposing

Don't build a separate new system. The whiteboard already has the right columns — it even already has a built-in lane for the development stages (spec → approved → built → merged). It's just not being *fed* and not being *watched*. So we add two things:

1. **Auto-feed it.** When a feature gets an approved spec and a merge, it lands on the board by itself — no one has to remember. And if a feature ships in "off / watch-only" mode (like SessionReaper), it also gets the rollout lanes: watch-only → live → default-on. Best part: the same mechanism can sweep our *existing* specs and retroactively put SessionReaper (and this very idea) on the board — proving the gap is closed.

2. **Watch it.** One standing weekly check (the tracker's own spec promised this years ago and it was never built) looks at everything on the board, gathers the evidence, and pings you only when something needs a decision — "this feature's been clean for two weeks, ready to go live?" The custom SessionReaper job I made last hour becomes just the first thing this generic watcher handles, then retires.

The decision to actually advance a feature always stays yours. The system does the remembering and the evidence-gathering; you do the approving.

Two more things you asked for, now baked in:

- **I'll actually know about this.** Right now, if you ask "what are we working on?", I'd answer from memory — which is exactly the wrong way. So the board gets wired into the stuff I check reflexively: it shows up in my capabilities list, in my "check the registry before guessing" rules, and I get a one-line heads-up at the start of every session ("3 things in flight, 1 needs your call"). So the board isn't just correct — it's the thing I reach for first when you ask.
- **It lives inside Projects, not next to it.** We already have a Projects system; this isn't a competing list. A feature is just a task on the board, and if it belongs to a bigger project it shows up under that project. One board answers "what's going on" for everything.

## The honest part

The reason I had to hand-write SessionReaper's review job, and the reason I had to manually note this idea in my memory instead of it appearing on the tracker, is the exact thing we're fixing. So this spec's first test is literal: run the auto-feed, and if SessionReaper and this spec show up on the board without me typing them in, it worked.

## Where this is

This is now a **converged draft spec**, not code. I ran it through the same three-way review SessionReaper got (a different AI model plus two passes that read the actual code), and it caught real problems — the biggest being that I'd misread how the tracker marks things "done," and that the way I planned to auto-add items couldn't actually carry the data it needed. All fixed; the most important safety fix is that a feature can now *never* flip itself to fully-on — the system only ever notices that you flipped the switch, never flips it for you. Per our rule, nothing gets built until you sign off on this converged version. A short list of remaining choices is at the end of the full spec.

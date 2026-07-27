# ELI16 — A compass check for long-running work

## The problem, in one sentence

When an agent works alone for many hours, every next step is chosen from the last one — so
after enough steps the work can be perfectly sensible locally while no longer being what you
asked for.

## Why this exists

You have had to manually re-ground this work three times: July 23, July 26, and again on
July 27. Each time the pattern was identical — the queue had filled with reasonable-looking
next steps whose sum had quietly stopped matching your priorities, and you noticed before
the agent did.

Your words on the 27th: *"I'm going to continue to ask you to do this periodically until
the infra is robust enough that I DON'T HAVE TO."*

That is the whole specification. This is the infrastructure that means you don't have to.

## What it does

On a cadence during long autonomous work, it builds a list of what you have actually asked
for — taken from your own messages, verified as genuinely from you — and compares it against
what the agent is currently doing. It answers: on track, drifting, or diverged.

The answer goes **to the agent, not to you.** You only hear about it if drift is sustained,
and then once. A compass that pings you hourly is the notification noise you have been
objecting to.

## The four things that were wrong with the first draft

Seven rounds of review by a different AI model — deliberately not a Claude model, so it does
not share the author's blind spots — found problems worth naming.

**It would have forgotten your older instructions.** The first design only looked back seven
days. The directives driving this work are two to four days old, so the window would have
started dropping them exactly as they became load-bearing. Now a goal stays on the list until
it is genuinely resolved or you replace it. Age alone never removes anything.

**A signal nobody acts on is the same as no signal.** The first draft was satisfied by
*showing* the agent a drift warning. That is precisely the failure that keeps happening —
the information was available and went unread. Now the agent's next plan update has to say
which priority it is serving, or say plainly that it is rejecting it. Nothing is blocked if
it doesn't; it is recorded, and repeated silence gets louder.

**A compass that always says "north" is as useless as a broken one.** A steady stream of
reassuring "on track" answers looks identical to genuine alignment, and "on track" is the
cheapest answer for a model to produce. So there is a check that involves no AI at all: if
you asked for something and no work has referenced it for several cycles, that surfaces
regardless of what the reviewing model said.

**"Done" cannot be something the agent decides alone.** An early draft let a merged pull
request close out a goal. But a merged PR proves work happened, not that your intent was
met. Now the agent can only mark something *believed* done — it stays visible, dimmed, until
you confirm it or a mechanical check proves it.

## What it will not do

It never blocks, never rewrites a message, never halts work, and never overrides the agent's
judgment. It changes what the agent *sees*, not what it *can do*. The strongest thing it ever
does is put a neglected priority more prominently in front of the agent.

## Shipping in three parts

The review's final finding was that this had quietly grown too large to build in one go —
which would be the exact mistake the spec is about.

1. **See it.** Build the goal list and compute verdicts, injecting nothing anywhere. This
   answers "is the compass even right?" before it is allowed to speak, and it can be checked
   against the three real re-groundings you already had to do.
2. **Say it.** Turn on the briefs to the agent — only after part one shows a low false-alarm
   rate.
3. **Check it.** Turn on the audits that watch the watcher.

Each part is separately useful, and part two cannot begin until part one has proved itself.

## The honest risk

Deciding "is this sentence a priority?" takes judgment, and that judgment is made by an AI
model. If it misreads one of your messages as unimportant, that goal becomes invisible.

Three things guard against that, and one involves no AI at all: every message of yours that
*looks* like an instruction goes into a visible holding list and stays there until it has
been explicitly classified as a priority or not. A backlog in that list is itself the alarm.
Part one exists so this risk is measured before anything depends on it.

## What I need from you

Read this, and if it's right, approve it. Then it gets built — and I'd like the
implementation to go to Codey rather than me, since it's now specified tightly enough to
hand over, and moving work to him is the standing priority.

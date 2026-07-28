# ELI16 — The switch that looked like the switch

## The setup

The agent runs scheduled jobs — things that happen on a timer without anyone asking.
Some ship built in and arrive switched off, waiting for someone to decide they want
them.

Each of those jobs has a text file describing it, and near the top that file says,
plainly:

```
enabled: false
```

So you change it to `true`. The file now says `true`. You check — still `true`.
Done, apparently.

## What actually happens

That file is regenerated from scratch every time the agent updates itself. It's
built that way on purpose: it means an agent can never get permanently stuck on a
broken job description, because every update restores a known-good copy. Same rule
applies to a few other built-in files, for the same good reason.

The consequence is that your edit survives right up until the next update, and then
vanishes. On a machine that updates every half hour, that's about twenty minutes of
looking correct.

There *is* a durable setting. It lives in a different file — a small record kept
alongside, one per job — and the updater deliberately preserves it. That record is
also the one the scheduler actually reads when deciding what to run. The line in the
text file is only a starting value, used the first time, when no record exists yet.

## Why this is worth a fix rather than a shrug

Two files, one visible and wrong, one hidden and right, with no signal telling you
which is which.

I hit this myself. I edited the visible one, watched it revert, and concluded there
was no way to do it at all — then told Justin it was a decision he'd have to make.
That's the part that actually stings. There's a standard here saying a blocked path
is mine to solve first and that I should ask for the smallest possible thing from
him. I'd tried one of two doors, found it locked, and asked him to open the building.

An hour later I read the installer's source and found the second door immediately.

## The fix

Add a line to the instructions the agent reads at the start of every session, saying
which file is the real one and why the other lies. Plus a migration, so agents
already running get the line too rather than only fresh installs.

That's the whole change — no behaviour, just telling the agent something true that
nothing was telling it.

## Why documentation counts as a fix here

There's a principle in this project that a thousand-line prompt is a wish and a
ten-line hook is a guarantee — prefer structure over asking people to remember.

By that standard a documentation change is the weaker option, and it's fair to ask
why not make the visible file actually work, or make it complain when overwritten.
Either would be better. Both are behaviour changes to the update path, which is the
machinery that keeps every agent recoverable — not something to reshape at the end
of a long session on the strength of one bad hour.

So: say the true thing now, where every session sees it, and leave the sturdier fix
written down as a separate decision rather than smuggling it in.

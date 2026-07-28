# The reminder that goes off the moment you set it — plain English

## The one-sentence version

Any newly created scheduled job fires immediately the next time the server
restarts — even one set for months in the future — because the startup check
that looks for jobs that missed their turn couldn't tell "brand new" apart from
"long overdue," and guessed.

## What the startup check is for

When the server has been off for a while, some scheduled work will have been
missed. The daily 4am job doesn't run if the machine was asleep at 4am. So at
startup there's a sweep: look at everything scheduled, work out what should
already have happened, and run those now rather than waiting another full day.

Sensible. The problem is how it decides.

## The mistake

To know whether a job missed its turn, the check compares *now* against *the
last time it ran*. Fine for a job with a history.

But what about a job that has never run at all? There's no last-run time to
compare against. The code hits that case and does this:

> "No record of it running? Then it's overdue. Run it."

Which is right for a job that was added while the machine was off and quietly
slept through its window. And catastrophically wrong for a job created five
minutes ago whose first scheduled moment is in December — because "has never
run" describes both of those equally well.

So: you set a reminder for December. The server restarts that evening. The
reminder fires. It's now been delivered, months early, and it will never fire
again, because it has run.

## The part that bothers me most

The comment directly above that code says what it's *supposed* to do:

> *"Jobs that have never run: trigger on startup if their first expected run
> time has already passed."*

That's exactly the correct rule. Someone knew. It just isn't what the code does
— the code skips the "if" entirely and triggers unconditionally. The intent was
written down and never enforced, which is the whole difference between a
comment and a check.

There's a second tell. The scheduler's own test file starts every test by
pretending each job has already run once, with the note *"so the startup check
doesn't trigger jobs at startup."* The tests were built to step around this
behaviour. It was known well enough to work around and never recognised as a
bug.

## Why it couldn't check its own rule

To ask "has its first scheduled time already passed?" you need to know when the
job started existing. Nothing recorded that. The system knew when each job last
*ran*, and nothing else — so for a job that had never run, there was no fact to
reason from, and the code fell back to a guess.

## The fix

Write down when each job is first registered. Then the rule the comment always
described becomes checkable: a job that has never run counts as overdue only if
it has existed longer than the gap between its own runs.

- A reminder created today for December has existed for minutes. Its gap is a
  year. Not overdue — it waits, correctly.
- A job that was added a day ago, runs every four hours, and still hasn't run,
  has genuinely slept through six windows. It catches up, exactly as before.

When the information is missing entirely — a job whose record predates this
change — it does nothing rather than guess. A skipped catch-up costs one delayed
run. Guessing wrong costs a reminder that fires early and looks delivered, which
is worse than one that never fires at all: you'd never go looking for it.

## Why this came up now

It's a prerequisite for something you asked for: when you tell me you'll check
in on something by a date, that should become a real scheduled reminder rather
than an intention I'm holding. That reminder rides this scheduler. Building it
on a scheduler that fires future-dated jobs at boot would produce reminders that
mark themselves delivered before the date arrives — worse than not having built
it. This is the floor that had to be solid first.

## What you'd notice

Nothing changes for jobs that already run normally. What stops happening is the
odd unexplained "why did that just run?" after a restart.

One honest note: a job that's been sitting unrun for less than one of its own
cycles will now wait for its next proper turn instead of firing at startup. That
delay is the intended behaviour — it's the difference between "scheduled" and
"whenever we happen to reboot."

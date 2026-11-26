# Check-in reminder server tick: plain overview

## What this is

When the agent promises "I'll check in by Friday", it can save that date on the commitment.
Instar already has code that notices the date has arrived and posts one short reminder in that
conversation. The trouble is that nothing ever runs that code. The scheduled job meant to run it
is switched off, because each run would have started a full AI session every five minutes, and
that cost is out of proportion to a simple date check.

## What already exists

The check itself, the fixed reminder wording, the protection against sending twice, and a
read-out showing which dated promises are waiting. It all works. It just never gets called.

## What is new

The agent's server now runs that check on its own timer, every five minutes, with no AI session
and no AI model involved. It is the same check, so the existing protections still apply.

It stays in practice mode. It records what it would have sent and sends nothing. That record goes
to a small log file, which is what makes the promised seven-day trial possible.

## Safeguards

**Prevents double reminders.** Only one check runs at a time, and each reminder is stamped as sent
after it goes out. A test sends one real due reminder through the real server code and confirms it
goes out once, including after a restart.

**Prevents session cost.** The timer never starts a session. A test checks that too.

**Prevents silent failure.** If a reminder finally cannot be delivered, one Attention item says so.
If the check itself keeps crashing, that is reported once.

**Prevents log floods.** Practice mode writes one log row when something changes, plus one an hour,
instead of a line for every waiting promise every five minutes.

## What ships when

This one change ships the timer in practice mode. Actually sending stays a separate, deliberate
switch after the trial.

## What you actually need to decide

Nothing now. At the end of the trial, about sixteen old promises would post at once if the switch
were flipped today, so that list should be reviewed and cleaned up first. Should the timer ship in
practice mode? Yes is the recommendation, and it changes nothing a user can see.

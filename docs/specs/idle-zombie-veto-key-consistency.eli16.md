# Plain-English overview — Idle-Zombie Veto-Backoff Key Consistency

## What this is

A while ago we shipped a fix for a wasteful loop: when the agent had a session it wanted to
clean up but wasn't allowed to (for example, a session that belongs to the *other* machine, or
one with an open promise attached), the cleanup code kept re-trying every 5 seconds forever.
The fix was supposed to make it "back off" — try once, then wait 30 minutes before trying again.

It turns out that fix **doesn't actually work for the most common case**, and we only found out
by looking at the live logs: the same warning was printing every 5 seconds, 2,523 times in a row.
The back-off wasn't holding.

## Why it was broken (in one picture)

The back-off works by remembering "I already tried this session, for *this reason* — don't try
again for 30 minutes." The bug is that **two parts of the code disagreed about what the reason
was.** The part that *checks* "have I backed off?" looked up one reason, but the part that
*records* "I backed off" wrote down a *different* reason. Because the two never matched, the
memory got thrown away and rebuilt every single tick — so the 30-minute timer never got a chance
to run. It's like writing a reminder to yourself but filing it under the wrong name, so you never
find it and keep redoing the task.

## What already exists

The back-off machinery itself is already built and shipped (`VetoedKillBackoff`). The config
switch to turn it on already exists. The visible symptom — a log file that used to balloon to
132MB — was *separately* capped by a different fix, which is exactly why nobody noticed the
underlying loop was still spinning: the loud alarm went quiet, so everyone assumed it was solved.

## What's new

A three-line change to one small internal method so that the "have I backed off?" check and the
"record that I backed off" step use the **same** reason. Concretely: the checker now looks at the
same things, in the same order, that the real cleanup code looks at — is the session protected?
is this the standby machine? — before falling back to the general reason. That makes the two
sides agree, the memory sticks, and the timer finally holds.

## The safeguard that makes this trustworthy

The honest risk with a fix like this is that "make the two sides agree" is a rule kept by
*discipline* — and discipline is exactly what failed the first time. So the real protection isn't
the three lines of code; it's a **test that fails automatically if the two sides ever disagree
again.** The test runs the *real* cleanup code as the source of truth and checks that the checker's
answer matches it, for every combination of session shape. If someone later adds a new reason to
the cleanup code and forgets to teach the checker about it, that test goes red in CI — nobody has
to remember. That's the "structure beats willpower" principle applied: the guarantee lives in a
machine check, not in a person's good intentions.

## What you're deciding

Whether to approve building this fix. It's a small, reversible, internal-only change (no data, no
network, no user-facing surface), it ships behind the same on/off switch that already gates the
back-off, and it's a strict no-op on a single-machine setup. The tests prove the loop actually
stops — not just that one warning printed once, but that the repeated cleanup attempts genuinely
stay suppressed for the full 30 minutes.

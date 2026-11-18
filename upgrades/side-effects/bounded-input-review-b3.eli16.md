# Checks that act on what they can see, batch 3 (ELI16)

## The problem

Some decisions inside the agent are made by a model reading a short piece of text. When the code cuts that text to save space and does not say so, the model decides from a fragment as if it were the whole thing. Our standards ask that every such cut be justified, announce itself, or, when the decision really depends on the missing part, not be made at all. There are 43 places to check before a lint starts failing builds on 23 November. This is the third batch.

## What we found and changed

The important one is the watchdog that notices a command running "too long" and asks a model whether it is stuck. If the model says stuck, the watchdog presses Ctrl+C, which kills the command. The model was shown only the first 200 characters of the command. Many real commands start with a long folder path, like "go to this very long folder, then run the tests", so the model often saw only "go to this folder". That looks like something that should finish instantly, so the model would call it stuck and the tests would be killed.

Now the model sees the whole command, up to 2,000 characters. If a command is even longer, the watchdog does not ask the model at all. It falls back to the rule it already uses when the model is unavailable: wait for a hard time limit and never interrupt early. While checking this, our reviewer found that the time-limit rule never actually fired: any command the watchdog could not decide on was skipped forever. That is fixed too. Such commands are now checked again each time, and stopped only once they pass the limit. When the evidence is incomplete, we choose not to act rather than act on a guess.

A message the agent sends to another agent, to follow up on an old request, now says clearly when the quoted request was shortened.

When one agent disputes another's commitment, its reason is shared with every session. That reason used to be cut short without any sign. Now a reason that is too long is sent back to be shortened, and an accepted one is kept whole.

The other places were checked and do not feed a decision. They clean up text before storing it, or they are labels or ID numbers. Each now carries a one-line reason.

## Safeguards

Nothing gained new power. The watchdog can now only interrupt less, never more. Reverting the change undoes it completely.

# ELI16 — the feedback sorter asks about ten groups at a time

## The problem

The feedback sorter ("drain") groups similar bug reports. Then it asks a model which groups
are ready to become a task. It used to put up to 50 groups into one question.

The model takes about 3 to 4 seconds per group. Fifty groups need about three minutes, but
each question is allowed one minute. So the big question ran out of time every time. The
run failed and no group got a verdict. With ten groups per question, the answer came back
in about half a minute.

## The fix

The sorter now asks about at most ten groups per question, one question after another. It
keeps going until it reaches the run's group limit or runs low on time. Each answer is saved
as soon as it arrives. If a later question fails, the earlier answers still count.

Before each question it checks the clock. If the next question would not finish in time, it
stops and leaves the remaining groups for the next run. That run starts with them.

The rule for "the model is broken, stop trusting it" counts whole runs:
- A run where at least one question worked shows the model is fine, and resets the count.
- A run where every question failed counts once.
- Three such runs in a row switch the model off.
- A wrong-shaped answer still switches it off at once.

A setting for the run's time limit (90 seconds) existed but was never used. The sorter
quietly used 115 seconds. It now follows the setting.

## What does not change

The question wording, the answer format, the daily spending cap and the approved group
limit are the same. The spending cap is now checked before each question rather than once
per run.

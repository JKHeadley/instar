# ELI16 — "ran out of time" is not "broken", and the job now waits for the answer

## The problem

The feedback sorter ("drain") asks a model which groups of bug reports are ready to become a
task. It asks about up to ten groups per question, one question after another, until its
run's time is nearly used up.

It guessed how long the next question would take from how long earlier questions took per
group. But every question also has a fixed start-up cost of about 9 seconds, however few
groups it holds. Near the end of a run, the sorter had about 8 seconds left. It decided one
group would fit and asked. The question could never finish in 8 seconds, so its own timer cut
it off. The run was then labelled "degraded, the model failed", even though the model never
failed once. Two real runs on 2026-10-01 went exactly like this.

A second fault hid it. The scheduled job that starts each run waited only 60 seconds for the
result. These runs took 70 seconds, so the job gave up, said "still running, the next run will
check", and recorded a success. No later run ever checks an earlier one.

## The fix

- The sorter does not start another question unless at least 25 seconds are left.
- If its own timer still cuts a later question short, that is "out of time", not "the model
  failed". Those groups simply wait for the next run.
- A run that got some answers and then ran out of time is now "succeeded". It carries a short
  note saying the rest is still waiting.
- Real problems still mark the run degraded: the model timing out on its own, an error, a
  wrong-shaped answer, the spending cap, or a first question that cannot finish.
- The job now waits up to 3 minutes. That is longer than any run may last (at most 115
  seconds). If a run is somehow still going after that, the job counts it as a failure
  instead of quietly passing.

## What does not change

The question wording, the answer format, the spending cap, the approved group limit and the
rules for switching the model off all stay the same.

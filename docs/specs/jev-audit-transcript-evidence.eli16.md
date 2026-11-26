# Jev task checker: show it what the task actually did

## What this is, in plain English

The task checker is an experiment. After each of my scheduled tasks finishes,
a small, cheap model (Jev) is asked one question: "did this task actually do
what it said it would?" It only watches and writes down its answer — it
cannot stop, retry or change anything.

To answer, Jev needs evidence. Until now the evidence came from the task's
terminal window, captured the moment the task finished. The problem: by that
moment the window has already closed. So for nearly every task that runs as a
model session, Jev received the task's description, the word "success", and a
blank. On 24 September, about 410 of the 420 checks waiting to run looked like
that. "Can't tell" was the only honest answer, and it made Jev look unsure
because of our mistake, not its own.

## What already exists

- The checker itself, its trial switch and its daily budget.
- A scrubber that removes keys and passwords from anything before it is stored
  or sent.
- Every task session already leaves a saved record (its transcript) on disk:
  every command it ran, what came back, and its final reply.

## What is new

When a task finishes, the checker now reads that saved record instead of the
closed window, and builds a short summary: each command, a trimmed piece of
its result (with failures marked), and the final reply. That summary goes
through the same scrubber and the same size limit as before. If the record
can't be found, the old behaviour is used.

One detail matters for fairness. Some tasks announce "I saved this file" with
a special line, and the checker then confirms the file really changed. Those
lines were being lost the same way. They now come through, but only when the
task itself said them, never when they merely appeared inside a file the task
read. That stops a stray line in a document from being mistaken for a claim.

## Safeguards

- Watch-only, as before: nothing Jev says changes what happens.
- Same secret scrubbing and same size cap as before.
- Reading is capped at the last 1 MB of the record.
- Any error falls back silently to the old behaviour; finishing a task can
  never fail because of this.

## What you need to decide

Nothing new. This makes the trial you already approved able to reach a real
verdict. Once it is live, the trial's clock restarts so all three days are
measured on real evidence.

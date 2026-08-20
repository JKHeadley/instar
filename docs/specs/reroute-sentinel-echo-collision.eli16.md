# ELI16 — The job watcher was reading its own instruction back and calling the work finished

## What this is about

Instar can run a background job by opening a normal chat session with the model and
typing a task into it, rather than running a one-shot command. This is the
"rerouted-interactive" lane, and it exists so background work bills through a
subscription instead of a separate credit pot.

A one-shot command has an obvious way to know the job is over: the program exits.
An open chat session never exits. So instar needed another way to tell "finished"
from "still working".

## The way it worked, and why it broke

The chosen approach was a codeword. When instar starts one of these jobs it appends
a line to the task:

> *When you have fully completed this task, print exactly this marker as your final
> line: INSTAR_JOB_COMPLETE_1a2b3c4d*

Instar then watches the session's screen and, when it sees that codeword, concludes
the job is done and shuts the session down.

The flaw is that **the task is typed into the session**, so everything in it —
including that instruction — appears on the very screen being watched. The codeword
was therefore sitting there from the moment the task was pasted in, before the model
had done a single thing. The watcher looked, saw the codeword, and shut the job down
as a success.

It is a machine reading its own instruction back and mistaking it for the answer.

## How bad it was in practice

Measured on a real three-machine setup, on the machine running the scheduled work:

- **31 out of 31** of these jobs were killed between 15 and 41 seconds. Every single
  one was recorded as `completed`.
- That included **25 scheduled maintenance jobs** — the health check, the commitment
  sweep, the maintenance overseers — all reporting `success` with `0` consecutive
  failures, while each did roughly sixteen seconds of work.
- The machine's shutdown log covered about 43 hours and held **1,074** of these kills.

Nothing looked broken. Every status surface was green. That is the worst property of
this bug: it did not fail, it *reported success*.

There is a partial safeguard that declines to shut a session down while a command is
visibly running. That is why the death time varied instead of being a flat sixteen
seconds — it delayed the false verdict, it did not prevent it.

Jobs run the old one-shot way were never affected, because "the program exited" cannot
be faked by something written on the screen.

## What changes

Instead of handing the model the finished codeword, instar now hands it the pieces and
asks it to join them:

> piece 1: `INSTAR_JOB_COMPLETE`
> piece 2: `_`
> piece 3: `1a2b3c4d`

The joined codeword now appears on the screen **only if the model actually types it**.
The instruction itself no longer matches.

The model is also told to write the marker only on that final line and never to quote
it back while narrating.

## What happens if the model gets the joining wrong

It doesn't get shut down early — it runs to the existing hard time limit and is recorded
as a **timeout**. That is deliberate: a loud non-completion is a far better failure than
a silent false success. We checked the assembly behaviour against the real model on the
affected machine before relying on it, and it assembled the marker correctly.

## Why the existing tests did not catch this

Both halves were already tested, separately, and both passed:

- "the rerouted prompt gets the completion sentinel appended" ✅
- "a pane containing the sentinel is detected as complete" ✅

Neither test knew that the prompt *is* screen content. Their **composition** was the
defect. One of them actually asserted that the codeword must be the last thing in the
instruction — the bug was written down as intended behaviour and guarded as such.

The new test puts the two halves together: it takes the real prompt instar would inject
and feeds it to the real matcher as screen content, and requires "not finished". It was
confirmed to fail on the unfixed code before being trusted, and it carries a positive
control so a matcher that simply never fires cannot pass it.

## What this does not fix

The deeper issue is that a plain text search holds the authority to kill a session. It
still cannot tell the model's own output from an instruction, a quotation, or a user
repeating the codeword back. This change removes the collision that made that dangerous
in practice; it does not change who holds the authority. That is tracked separately as
ACT-1798.

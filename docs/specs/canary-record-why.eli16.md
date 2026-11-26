# When the safety rehearsal stops us, it should say why — Plain-English Overview

## The problem in one breath

The fix pipeline stopped itself for a full day because one check in its safety rehearsal came out
wrong. It recorded WHICH check, but not what it saw — and the evidence is deleted moments later. So
working out why cost a whole manual re-run, and there was nothing left to read.

## What already exists

Before writing any fix, the pipeline rehearses its sandbox: about twenty checks, most proving the
sandbox refuses what it should, a few proving ordinary work still succeeds. If any one comes out
wrong, it declares its own safety unproven and stops for 24 hours. Nothing can lift that early — by
design, and that part is right.

## What this adds

The reason, kept.

One of those checks asks the sandboxed session to run a command and report what it printed. The code
read the reported value and, if it was simply *missing*, treated that exactly like the command having
failed. Those are very different things — one means the sandbox is unsafe, the other means the
session skipped a line of its own report — and both produced the identical one-word record.

So two changes, both additive: the check's description now quotes what it actually saw, and the 24-hour
stop record keeps those descriptions instead of only the check names.

## The safeguards

- **No verdict changes.** The expression that decides pass or fail is untouched, deliberately and
  with a comment saying so. This only changes what gets written down.
- The kept text is length-capped and run through the same secret-scrubber used elsewhere, because it
  quotes output from inside the sandbox and must never carry a credential into stored state.

## What ships when

Immediately, always on. No setting, no migration.

## What you actually need to decide

Nothing. Next time this stops the pipeline, it will tell you why instead of needing an investigation.

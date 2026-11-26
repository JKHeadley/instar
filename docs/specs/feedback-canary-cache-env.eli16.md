# The sandbox rehearsal needs its own scratch space — Plain-English Overview

## The problem in one breath

Before the fix pipeline is allowed to write anything, it runs a rehearsal that proves the sandbox
really is locked down. That rehearsal was about to fail for a reason that has nothing to do with
safety — and a failed rehearsal locks the whole pipeline for a full day, with no way to unlock it.

## What already exists

The rehearsal runs about twenty checks. Most prove the sandbox *refuses* things it should refuse.
A handful prove ordinary work still *succeeds* inside it — including running the project's linter
and one real test. If any single check comes out wrong, the pipeline decides its own safety profile
can't be trusted and stops for 24 hours.

## What this adds

Two environment settings for the rehearsal's commands, so the test runner writes its scratch files
inside the sandbox instead of outside it.

The test runner and its bundler both keep caches next to the nearest project folder. Inside the
sandbox that search walks *upwards* out of the work area and into the agent's home folder, which is
deliberately unreadable. So the "run one real test" check died with a permission error — not because
anything was unsafe, but because it was pointed at a folder it isn't allowed to touch.

The pipeline already does exactly this for its later verification runs. The rehearsal was simply
missing the same two settings.

## The safeguards

- Nothing is unlocked. The home folder stays unreadable; the scratch files just go somewhere the
  sandbox already allows.
- Every other rehearsal check is untouched, including all the ones that prove the sandbox refuses
  what it should refuse.

## What ships when

Immediately, always on. No setting, no migration.

## What you actually need to decide

Nothing.

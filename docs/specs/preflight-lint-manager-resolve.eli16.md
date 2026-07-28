# Why a passing check was hiding a broken one — in plain English

## The one-paragraph version

Contributors have a command, `instar dev:preflight`, that runs the project's checks
before they open a pull request. Its first step is the linter. That step was written to
launch the linter using **pnpm** — one particular package manager. On a developer's
laptop pnpm is installed, so it worked. On the build server it is not: the build server
installs things with **npm** and has never had pnpm. So on the build server the linter
did not fail — it never *started*. The command then reported that as **"lint failed."**

An environment that was missing a tool got reported as **code that was broken**.

## Why nobody noticed for a long time

There is a test whose job is to run that command and check it exits cleanly. It begins
with, in effect: *"if the compiled program isn't here, stop and do nothing."*

The build server runs tests directly from source and never compiles the program first.
So the compiled program was never there, so the test stopped and did nothing —
**every single time**. It had been reporting success for as long as it has existed,
without once doing the thing it was written to do.

A separate change (a different pull request) added a step that compiles the program
before tests run. Its own description says it exists so that a test like this one
"cannot skip silently." It woke this test up, the test finally ran for real, and it
failed within seconds — on a genuine problem that had been sitting there the whole time.

So the other change did not break this. **It revealed it.**

## What this fixes

The linter step now asks a simple question first: *which package manager is actually
available here?* It prefers pnpm, and uses npm if pnpm isn't around. Both run the exact
same list of checks, so nothing about the linting itself changes.

If **neither** is available, the command does not quietly carry on and it does not
pretend to pass. It stops and says, in those words, that the check **did not run**.

That last part is the real point. "This check passed" and "this check could not run"
are completely different facts, and a tool that shows them the same way is worse than
useless — it is confidently wrong. Anywhere those two outcomes look alike, something is
being hidden.

## What it deliberately does not do

It does not change what the linter checks, does not skip anything, and does not make
any check easier to pass. Nothing that failed before passes now. The only new outcome
is a clearer failure.

## How I know it works

Rather than trust that the change was right, I rebuilt the program and ran it for real
with pnpm deliberately removed from the environment — the exact situation on the build
server. It picked npm and finished cleanly. The proof that it was broken before is the
build server's own log, which recorded the failure in production.

## The honest limit

There is a second problem here that this **does not** fix. The test that passes by
doing nothing is one example of a shape that may exist elsewhere in the test suite:
a test that quietly skips itself when something it needs is missing, and reports that
skip as success. Fixing that properly means going through the whole suite, and bundling
it into this small fix would make a one-file change into a risky one. It is written
down and tracked separately (ACT-1514) rather than mentioned and forgotten.

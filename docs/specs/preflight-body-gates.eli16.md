# Preflight body gates — Plain-English Overview

> The one-line version: the pre-submission checker could only look at your code,
> so the checks that read your pull-request *description* always failed later on
> the server — now it can check those too.

## The problem in one breath

There is a command you run before submitting work (`instar dev:preflight`) that
runs the same checks the server will run, so you find problems in seconds instead
of minutes. It only ever looked at the **code changes**. But several checks read
the **pull-request description** instead — and that text does not exist until you
actually open the request. So "I ran the checks locally and they passed" was a
true statement that still missed them, every time.

Measured: one of those description checks failed across **three separate work
sessions**, on work whose local checks were green the whole way through.

## What already exists

- **`instar dev:preflight`** — runs the linter, a discoverability test, and a
  heuristic about new routes. All of these read the code diff.
- **The description checks** — one requires a plain-English summary in the
  request description (because that description is what a reviewer actually reads
  before approving); another requires a statement of user-visible impact. Both
  run on the server, after submission.

## What this adds

`dev:preflight` now accepts the description as a file. Give it one and it runs the
description checks too, so a missing summary is caught in a second locally rather
than as a red mark after submitting.

- `--body <file>` — the description to check
- `--title <text>` — the title, which one check needs for its exemption rules

## The safeguards

**It never fails you for not having a description yet.** Omit `--body` and the
description checks are skipped, because running the checker *before* writing the
description is exactly when it is most useful — failing that would train people
not to run it early.

**A skip is visible, not silent.** The summary prints `SKIPPED` with the reason. A
silent skip looks identical to a pass, which is the confusion this command exists
to remove.

**An unreadable file is a failure, not a pass.** If you point `--body` at
something that cannot be read, the run fails and says so. Passing because the
check could not run is the exact false-confidence being fixed.

**Nothing changes for existing users.** The new inputs are optional; without them
the command behaves exactly as before.

## What ships when

All of it at once — it is one small flag plus the wiring behind it. The checks
themselves are unchanged; this only lets you run them earlier.

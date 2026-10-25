# ELI16 — Tick the folder-trust box for the folder the session actually opens

## The one-sentence version

Instar pre-answered Claude Code's setup questions for each of its logins, but it
was ticking a general "setup done" box and never the separate per-folder "I trust
this folder" box — so a login could be declared ready and still kill every session
it launched, because the unanswered folder question defaults to "No, exit".

## The two boxes

Claude Code keeps two different acknowledgements in a login's config:

- a top-level "first-launch onboarding is done" flag, and
- a per-folder entry recording that you trust the files in *that* folder.

They are not the same question. The folder question is the one that appears as
"Do you trust the files in this folder?", and its highlighted answer is **No,
exit** — so an agent starting up in an unanswered folder quits immediately.

Instar's readiness seeding wrote the top-level flags and then checked only those
three before declaring a login "already interactive-ready". A login whose folder
answer was missing therefore passed as ready and was fatal in practice.

## What that looked like

On 2026-10-20 two of one machine's logins were enrolled, signed in, and reported
healthy, with no folder answer recorded. The operator's conversation was placed on
that machine. It opened a session three times in thirty-five minutes — and each one
died sixteen seconds later at that question. Because other logins on the same
machine *did* have the answer, the failure looked random rather than configured.
The operator saw delivery receipts and no replies, and nothing anywhere said why.

## What changed

The seeding function now takes the directory the session will open and ticks the
per-folder answer for exactly that directory, shaping the entry the way a genuinely
accepted folder carries it. The absence of that answer is now reason enough to
patch a login — which is the part that matters, because the old early-return on the
top-level flags is precisely how a fatal login passed as ready.

All three callers pass the directory, including the sweep that runs when an existing
agent updates itself. That sweep is the only way machines already out there receive
this.

## What is deliberately unchanged

No credential or token is ever touched. A config file that cannot be parsed is
still refused rather than rewritten, because it may still hold a recoverable login.
Other folders' entries and their settings are preserved. Calling without a
directory behaves exactly as it did before.

## The first version of this broke something worse

Worth recording, because the automated tests caught it and I would not have.

To tick the per-folder box, the code has to ask "which folder?" — so it calls a
small new accessor on the session manager. On paper that is safe: the type says
the session manager is there, and the compiler was happy.

In practice several callers hand that code a stripped-down stand-in carrying only
the handful of methods that path needed before today. Those stand-ins have no such
accessor, so the call did not just skip the box — it threw, and took the whole
session-restart down with it. A missing safety tick had become a dead restart.

Now the call is optional. If the folder cannot be determined, the login is prepared
exactly as it was before this change — and a line is written saying the folder
answer was not ticked, so the gap is visible instead of silent. Degrading quietly
would have re-created the very problem this change exists to remove.

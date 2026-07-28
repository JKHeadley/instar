# Idle-Error Detection, in plain English (CMT-1785)

## The one-sentence version

When a session pauses at its prompt, the agent guesses *why* by scanning the
terminal for error words like "API Error:" — but that scan is so crude it fires on
old errors still on screen and on the agent merely *talking about* an error, kicking
off a needless recovery. This change makes the scan look only at the live bottom of
the screen and only at lines that are actually an emitted error, so the recovery
fires when something really broke and stays quiet when it didn't.

## What exists today

A background loop watches every running session. When a session goes quiet at its
input prompt, the loop grabs the last 30 lines of its terminal and checks: does any
of a dozen error strings appear *anywhere* in those 30 lines? If yes, it assumes the
session died on an API error and hands it to the recovery system (which backs off,
re-checks, and nudges the session back to life instead of waiting 15 minutes to kill
it). That recovery hand-off is good and stays exactly as-is.

## What's actually wrong

"Does the error string appear anywhere in the last 30 lines" is too blunt in two
ways:

1. **Old news.** The session hit an error, recovered on its own, and is now happily
   waiting at a fresh prompt — but the old error line is still visible a bit higher
   up. The blunt check sees it and triggers recovery on a perfectly healthy session.
2. **Just talking about it.** The agent is writing a message that contains the words
   "API Error", or the user pasted an error log, or a tool printed "fetch failed" as
   normal output. None of these mean the *session* failed — but the blunt check can't
   tell the difference between "this turn died on an error" and "this text mentions
   an error."

Both cases waste the recovery system's effort and, worst case, restart a session
that was fine. This exact bug class was already fixed once for a different feature
(the "conversation too long" message that kept false-alarming because it was scrolled
up in the buffer) — this applies the same proven fix here.

## What changes

A small, well-tested helper now makes two extra checks before declaring "this turn
died on an error":

- **Look at the bottom only.** The error has to be in the live region right above
  the prompt (the last ~20 non-blank lines), not anywhere in the 30-line grab. An
  error that caused the pause is, by definition, near the bottom; an error scrolled
  higher up is old news and is ignored. (We use 20, not a tighter number, because a
  real error prints a wrapped error box plus a usage line plus the input box on top
  of it, which pushes the error line up a bit.)
- **Look for a REAL error line, not a mention.** The error word has to sit on a line
  the agent's tool actually emitted as an error — one led by the tool's own bullet
  marker, or one that also carries the "API Error" frame — not a line that merely
  contains the word in passing. This single rule applies to every error pattern,
  including the machine-looking codes (which, it turns out, DO show up in normal
  content — a failing test, a pasted log, even the agent reading the source file that
  lists those codes). So a code sitting in plain content no longer triggers a false
  recovery; only a genuinely-emitted error frame does.

## Why this is safe

The new logic can only make the trigger *pickier*, never trigger-happier — the
bottom-of-screen-and-real-error set is a strict subset of "anywhere in the buffer."
So it can't invent a new recovery the old code wouldn't have done; it only removes
false ones. And the recovery system it feeds doesn't blindly trust this signal, and —
importantly — it never does anything destructive: at most it gives the session a gentle
"nudge" to continue, then *re-checks* whether the session actually moved. It does not
restart or kill anything. So even a forged or stale error line can, at worst, cause one
wasted nudge that the re-check proves did nothing. The single real risk is the opposite:
missing a genuine error. If that ever happened, the session simply falls through to
the normal kill-and-restart safety net it had before — a slower recovery, never a
stranded session and never silent data loss — and we now emit a record every time the
check suppresses something, so a wave of real misses is visible instead of silent.
It's a one-commit revert if it's ever wrong: put the old one-line check back.

## What you, the operator, decide

Nothing operationally — there's no new setting, no new screen, no message you'll see.
This is an internal precision fix to how the agent diagnoses a paused session. The
decision in front of you is just: is this the right fix to the false-recovery
problem, and is the "pickier, fails safe" trade-off the one you want? The spec lays
out the tail width (20 non-blank lines), the two-tier "is this a real emitted error
frame" rule, and the test matrix that pins both sides of every case.

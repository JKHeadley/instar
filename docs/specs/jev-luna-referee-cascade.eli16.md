# Jev asks Luna when it is unsure — plain-English overview

## What Changed

Jev is a very cheap, very fast model that answers narrow questions with a
confidence score. Its confident answers have been reliable in every test we
ran; its mistakes cluster where it is unsure. Justin set the default for every
Jev integration on 2026-09-26: let Jev answer when it is confident, and hand
the question to a smarter light model, GPT-6 Luna, when it is not.

The message trial had never tested that. It compared Jev on its own against my
existing message checks and called Jev "not ready" — but when we re-scored it,
every one of Jev's "misses" sat in its unsure zone, exactly where Luna would
have taken over. The trial could not settle who was right, because for privacy
it had kept the text of only 5 of those 94 unsure messages.

## What's new

A small shared piece, used by the message trial first and every later Jev
integration after it:

- When Jev's confidence on a question is in the unsure zone (between 30% and
  70% by default, adjustable per question), the same question goes to Luna.
- A small random share of Jev's CONFIDENT answers also goes to Luna, so we keep
  measuring whether confident still means correct instead of assuming it.
- Both answers are written side by side in the trial log, next to what my
  existing check said. That is the data that sets each question's threshold.

## Safeguards, in plain terms

- It decides nothing. Like the rest of the trial, it only writes log lines.
- Off unless switched on, separately from the trial itself.
- Anything that looks like a password or key is stripped from the text before
  it goes to Luna. The log records verdicts only, never the message.
- One Luna call at a time; overlap and a daily limit (300 by default) are
  recorded as such, so missing coverage is visible rather than silent.
- A slow or failing Luna never slows Jev or the message; it runs on its own
  lane with its own circuit breaker.

## Who decides what

Nothing new is asked of anyone. This follows the default Justin set. Switching
it on, and the three-day trial window, are config changes the agent makes and
reports.

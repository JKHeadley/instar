# Letting Jev help the message gate, without giving it any new power — plain English

## The background

Before a message of mine goes out, a two-layer check runs. The bottom layer is a
set of hand-written pattern matchers that spot "technical artefacts": a file path, a
terminal command, a config key, a web address of our own system, code to paste, an
environment variable, a cron line or an internal id. The top layer is a language
model — the judge — that reads the whole message and decides, in context, whether
showing that artefact to you is actually a problem. On a development agent the
judge's call on these artefacts is a nudge I can override, not a wall.

For the last week Jev, TypeSafe's fast decision model, has been answering the same
seven questions on every real message in the background, deciding nothing. Since
Sunday a slower, smarter model (GPT-6 Luna) has been grading Jev's answers when Jev
was unsure, plus a random 5% of its confident ones.

## What the record says

When Jev was confident it agreed with Luna 75 out of 75 times; the pattern matchers
agreed 72 times. When Jev was unsure, it still agreed with Luna more often than
the patterns did (70 vs 54 out of 96). Jev answers in about a fifth of a second
(99% within 0.85 s). One honest caveat: most confident answers were "no artefact
here", so evidence that a confident "yes" is right for each kind is still thin.

## What this change does

When the new switch is on, the gate asks Jev first and waits at most about a
second and a quarter. Where Jev is confident, its answer is what the judge sees
for that kind of artefact, labelled as coming from Jev. Where Jev is unsure — or
slow, down, or erroring — the pattern matchers' answer is used exactly as before.
If the patterns spotted something Jev confidently says is not there, the
pattern's finding still counts exactly as today, with a note that Jev disagrees,
and the judge makes the call. Jev never hides or overrides anything, and Luna stays in the background grading, too slow to
sit in the message path.

## The safeguards, plainly

- **No new power.** Jev only feeds the judge, and only where the judge's
  artefact rules are overridable nudges. It never blocks a message on its own.
  The secret-leak wall, the "don't quit early" checks and the offline safety
  floor are untouched.
- **Never slower than about 1.25 s**, and after three vendor failures in a row it
  stops asking Jev for five minutes, so an outage doesn't slow every message.
- **Secrets are scrubbed** from the text before it is sent to Jev.
- **Everything is logged**: each message's record says which source decided
  each artefact, so we keep measuring.
- **On for my development agent only; off for everyone else** until someone
  switches it on. Setting `enabled` to `false` turns it off on the very next message.

## What you need to decide

Nothing new for the development agent: you asked to move forward on this data.
Turning it on for other agents later would mean their outgoing messages
(scrubbed) also go to TypeSafe for as long as the switch is on. That is a
separate decision for then.

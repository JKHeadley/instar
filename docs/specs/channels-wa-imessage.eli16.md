# Closing a gap I wrote down myself

## What this is

Your agent has a page that answers "which ways of reaching you actually work right now?" It checks
each channel's live state rather than reading the settings file — because a settings file says
"Telegram: on" just as confidently four hours after the connection died.

When that page was built it covered Telegram and Slack, and the note shipped alongside it said
plainly that WhatsApp and iMessage existed but were not covered. That was honest, but it was also a
hole in the one promise the page makes: every channel gets a row, so a broken one can never simply be
missing. A channel with no row cannot report that it is missing.

This adds the two missing rows.

## The state that a yes-or-no answer would have destroyed

WhatsApp does not have a simple connected-or-not flag. It runs through real stages, and one of them
matters a lot: **waiting for you to scan a pairing code**.

In that state the connection is perfectly alive. It is simply not authenticated yet, and no amount of
restarting will change that — a person has to pick up a phone and scan. If the page reported that as
"broken", it would send someone off to debug a connection that is behaving exactly as designed.

So it gets its own verdict: reachable, but no credential yet. The same distinction Telegram already
makes when its token is rejected.

The in-between stages — connecting, reconnecting — report "unknown" with the stage named, rather than
being guessed either way. An answer that will be different in five seconds should not be frozen into
a verdict.

## The trap that was inside this fix

iMessage reports a connection time alongside its state. It would have been the natural thing to show.

It is fiction. The value is computed as "if we are started, the time right now" — so it reports the
moment you asked, never the moment it connected. Ask three times, get three different connection
times, all of them wrong.

The rows are built on the state and deliberately not on that field, and a test now fails if anyone
wires it in. A displayed timestamp looks more precise than a state name, which is exactly what makes
it worse: it would have been confidently wrong instead of honestly vague.

## Honest limits

A live reading is not a promise. "Working" means the link was up when asked — not that a message to
one particular chat or contact would arrive. Both rows say so in their own text rather than leaving
the reader to assume.

iMessage is also tied to one machine, because the thing it talks to runs there. That is recorded as a
real cost of choosing it, not hidden.

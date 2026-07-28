# Plain-English overview: stop a false "token missing" warning

## What was wrong

Echo's health check kept announcing "Telegram configured but token missing" —
about 20 times per run — even though the Telegram bot token is perfectly fine.

Here's why. instar recently started moving secrets (like that token) out of the
plain config file and into a separate encrypted store, leaving behind a tiny
placeholder that just says "this value is a secret, look it up elsewhere."

The health check that confirms the token is set only knew how to recognize a
plain-text token. When it saw the secret placeholder instead, it didn't
understand it and concluded "token missing!" — a false alarm that repeated every
cycle and cluttered the logs.

## The fix

Teach the health check that the secret-placeholder ALSO means "the token is set"
(it's just stored securely now). A genuinely missing or empty token still gets
flagged correctly; only the false alarm goes away.

To avoid two copies of "what does the placeholder look like" drifting apart, we
reused the one helper that already knows the placeholder's exact shape, instead
of writing a second copy.

## What you need to decide

Nothing — it's an automatic, safe, log-only cleanup. It can't change any real
behavior: it only stops a false "missing" warning when the token is actually
present. A token that is truly absent still fails the check exactly as before.

## A note on coordination

This was originally going to be two fixes. The second one (a different watcher
spamming a "refusing to run against the source tree" error) turned out to be
already fixed on `main` by another change — and fixed better than my version. So
I dropped mine. That's a small reminder of why concurrent work has to be checked
against the latest `main` before shipping, which is exactly what surfaced it.

## Not included (on purpose)

Two other noisy warnings (a feedback webhook getting rate-limited, and a
capability-manifest signature check) were left out because fixing them right
needs figuring out WHY they happen first — quietly hiding them could mask a real
problem. Those are tracked for a proper follow-up.

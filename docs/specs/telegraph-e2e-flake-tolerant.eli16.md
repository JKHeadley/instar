# ELI16 — Telegraph e2e test tolerant of transient API hiccups

## What this is, in plain English

Instar can publish pages to Telegraph (a free public web-page service). To make
sure that feature really works, there's an end-to-end test that actually talks
to the live Telegraph website: it creates a page, edits it, reads it back.

## The problem

Talking to a real external website means sometimes the website has a momentary
hiccup — it returns an error like `PAGE_SAVE_FAILED` for a second, then is fine
again. That has nothing to do with our code. But our test ran on every pull
request, so when Telegraph hiccupped, the WHOLE build went red — even on pull
requests that never touched Telegraph at all. That actually happened: a teammate's
unrelated change (fixing a Gemini quota bug) got a red build purely because the
Telegraph website blinked at the wrong moment. Red builds block merges and waste
everyone's time chasing a "failure" that isn't real.

## What's new

The test now retries those external calls a few times before giving up. If the
website hiccups, the test quietly tries again (up to 4 times, with a short pause
between) — and almost always the second try succeeds. So a momentary blink no
longer fails the build.

Crucially, it only retries the specific "the website had a temporary problem"
errors. If the test finds a REAL bug — a wrong page title, a broken response, a
genuine outage that doesn't clear — it still fails, loudly, the way it should.

## Why it's safe

It's a change to a test file only — no shipped behavior changes. It can only make
the test more tolerant of the external website's flakiness, never less tolerant
of real bugs (those still fail immediately). Verified: the test still passes all
5 checks against the live Telegraph API, and a type-check is clean.

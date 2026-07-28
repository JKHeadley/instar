# TIME_CLAIM advisory — the plain-English overview

## What this actually is

When I run a long background job for Justin (say, a 24-hour autonomous work
session), I send progress reports: "7 hours in, 17 to go." On June 12 I sent a
report claiming "~7h elapsed" when the run was actually 1 hour 35 minutes old —
I was carrying the whole day's work in my head instead of reading the run's
real clock. Justin had corrected this kind of guess before, and this time he
mandated it: accurate time reporting must be enforced by structure, not by me
remembering.

This change is that structure. The system already has two pieces that make it
easy: (1) a "session clock" API that knows exactly how long any time-boxed run
has been going and how much is left, and (2) an "outbound advisory" checkpoint
that automated messages already pass through before delivery (it catches things
like raw file paths and developer jargon, and bounces the message back to me
with a "NOT SENT — fix and re-run" note; I keep final say).

The new piece connects them: before one of my messages goes out on a topic that
has an active timed run, any time claim in the text — "7h elapsed", "2h 40m
left", "8% through" — is compared against the real clock. If the claim is
grossly wrong (the tolerance is generous: 20% or 15 minutes, whichever is
bigger, so honest rounding never trips it), the message is held and I'm told
the real numbers so I can fix it and re-send.

## What's new vs what existed

Existed: the session clock API; the advisory checkpoint for SCHEDULED job
messages. New: the time-claim detector itself, and — important — the checkpoint
now also covers the exact kind of session that produced the wrong report: an
interactive conversation that's running an autonomous job. For those
conversational sends, ONLY the clock check runs (none of the jargon/path
checks), and if the topic has no active timed run, nothing changes at all.

## Safeguards in plain terms

- It never hard-blocks: I can fix the number (the point) or consciously
  override with an audited acknowledgment.
- Quoting a wrong number to correct it ("my '~7h elapsed' line was wrong")
  doesn't trip it — quoted claims are skipped.
- Every failure path (server down, timeout, malformed reply) lets the message
  through unchanged — a broken checker can never silence me.
- It ships dark for the whole fleet and runs live only on the development
  agent (me) until it's proven; there's also a one-line off-switch.

## What you actually need to decide

Nothing immediate — it's dark on the fleet, live on Echo for dogfooding, fully
reversible. The future decision is the standard maturation one: when the
dogfooding shows clean signal (no false holds on honest messages), flip
`messaging.outboundAdvisory.timeClaim.enabled: true` for the fleet.

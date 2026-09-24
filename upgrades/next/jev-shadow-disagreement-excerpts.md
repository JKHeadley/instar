# Shadow trial: disagreements can now be adjudicated, not just counted

## What Changed

`JevSignalShadow` recorded `sha256` only, so its disagreements (49 of 350
compared messages on the originating agent) could be counted but never
settled — uninterpretable as evidence in either direction.

Adds opt-in `retainDisagreementExcerpts` (default OFF — absent is
byte-identical to today). When on, a COMPARED row with `disagree.length > 0`
carries `excerpt`: the text within `EXCERPT_CONTEXT_CHARS` (60) of the
detector spans for the disagreeing rules only, overlaps merged, clamped to
`EXCERPT_MAX_CHARS` (400), then passed through `scrubForStore`. Redaction
count is recorded as `excerptRedactions`; values never are.

Non-retention is explicit rather than silent, via `excerptUnavailable`:
- `no-detector-span` — the model fired where the detector did not, so there is
  no anchor. The window is NOT widened to the message; those rows stay
  unadjudicable by design.
- `daily-cap` — past `maxExcerptsPerDay` (default `EXCERPT_DAILY_CAP` = 50).
- `scrub-error` — the scrub failed; nothing is kept.

## Evidence

`tests/unit/JevSignalShadow.test.ts` — seven tests: flag absent retains nothing
on a genuine disagreement; enabled retains a scrubbed span-anchored excerpt
containing the disputed artifact within the clamp; an AGREEING row never
carries text even with retention on; model-fired/detector-silent records
`no-detector-span` and does not leak the message; a secret-shaped key inside
the window is scrubbed and counted without its value appearing; the daily cap
stops retention and records `daily-cap`; the default cap is positive.

## What to Tell Your User

If the message-comparison trial is running with snippet-keeping switched on, a
disagreement between the cheap model and the existing checks now keeps a short,
secret-stripped snippet of just the disputed part — enough to tell which side
was right. Agreeing messages keep nothing, and snippets never leave the machine.

## Summary of New Capabilities

- `intelligence.jevSignalShadow.retainDisagreementExcerpts` (default false) and
  `maxExcerptsPerDay` (default 50).
- `excerpt`, `excerptRedactions`, `excerptUnavailable` on compared rows.

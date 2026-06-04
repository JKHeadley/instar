<!-- bump: patch -->

## What Changed

Fixed CommitmentSentinel over-detection: it was registering a false-positive
commitment for bare approval/continuation messages ("please proceed", "yes"),
which flooded the commitment registry with noise (dozens of fake "violated"
commitments). A deterministic pre-filter now drops bare-approval exchanges before
the LLM detector runs, and the detection prompt is reinforced. Genuine durable
requests (anything with an action verb) are unaffected.

## What to Tell Your User

Your commitment list is trustworthy again. The follow-through tracker used to treat
almost everything you said — even a plain "yes" or "please go ahead" — as a promise
it had to track, which buried the real promises under noise. Now it ignores simple
approvals and only tracks genuine durable requests, so when you ask what is still
open you get a clean, honest answer.

## Summary of New Capabilities

- More accurate commitment detection (fewer false positives); no new endpoints or
  config. Signal-only and reversible.

## Evidence

50 unit tests covering both sides of the boundary: 36 bare-approval phrasings are
dropped, 11 genuine durable requests (including ones that open with an approval
word, like "go ahead and deploy") are kept, plus emoji/empty edge cases. Full
typecheck clean.

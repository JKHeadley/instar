# Feedback webhook: back off on rate-limit (429) instead of re-sending the whole backlog

## What Changed

`FeedbackManager` now treats a `429`/`503` from the canonical feedback endpoint as a
stop-signal: it HALTS the current retry batch and waits (honoring `Retry-After`, else
exponential 60s→1h) before POSTing again. Previously `retryUnforwarded()` re-POSTed the
ENTIRE un-forwarded backlog every scheduled cycle regardless of rate-limiting — against
a 429-ing endpoint that re-sent the whole backlog forever (observed live: 661 backlog
items → 2,384+ failed POSTs). A pure `decideFeedbackRetry()` helper makes the cadence
decision; the local feedback record is always written (nothing is lost or dropped).

## Evidence

- New `tests/unit/feedbackBackoff.test.ts` (11 cases): 2xx clears backoff; 429/503 halt
  + exponential backoff capped at 1h; `Retry-After` honored + capped; non-429 errors
  retry-next-cycle and PRESERVE the 429 streak (flap protection); junk/negative
  `Retry-After` rejected.
- `tests/unit/FeedbackManager.test.ts` (+2 cases): a 429 halts the batch after ONE POST
  (not the whole backlog) and the next cycle POSTs zero times while backed off; no item
  lost. Independent second-pass review concurred.

## What to Tell Your User

If your agent had been quietly retrying feedback against a busy endpoint, it now backs
off politely instead of hammering it — fewer wasted network calls and less background
churn. Nothing you do changes; no feedback is lost (notes are still saved locally and
sent once the endpoint is ready).

## Summary of New Capabilities

- Rate-limit-aware feedback forwarding: halts on 429/503, honors `Retry-After`, backs
  off exponentially (capped), and never re-sends the whole backlog against a limited
  endpoint. Back-compatible on a healthy endpoint (forwards immediately as before).

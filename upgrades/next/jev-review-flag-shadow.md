# A log-only "does this reply need your review?" measurement, on development agents

## What Changed

A new dark research instrument measures whether Jev (TypeSafe, `jev-1.13.0`)
can tell which agent replies need the operator's review, without ever showing
a flag. On a development agent, once a minute the server reads the newest
agent replies in its own Telegram history (conversational sends only, at most
30 minutes old), strips secrets from each reply and the operator message it
answers before cutting anything, and asks Jev: does this reply need review
(it claims done without evidence, asks the operator to decide or act, reports
a costly step, or misses the ask), is it fine, or can't it tell? It writes one
content-free row per reply to `logs/jev-review-flag-shadow.jsonl` (the
Telegram message ids, the label, P(needs review) in both option orders, and
whether a flag would have been shown). `GET /jev-review-flag/summary` reports
the counts. No hook or settings change: it is a server-side timer, so it
covers every framework that relays through the server.

Dev-gated: live on a development agent, dark on the fleet
(`intelligence.jevReviewFlagShadow`, `enabled` omitted). Needs the vault
`typesafe_api_key`. Bounded by a daily call cap (default 3000), a 1.5 s
timeout and one call at a time; the kill switch is read live at every tick.

## Evidence

- Live through the real module against this agent's real Telegram history and
  the real vendor: four recent replies judged in 89–169 ms each, all `fine`
  (P(needs review) 0.07–0.49, both option orders agreeing); the log held no
  message text.
- Unit, integration and e2e tests; the e2e builds the shadow with the server's
  factory reading config.json live, starts the real timer, and shows the
  feature alive on a development agent, dark on the fleet, and stopped by an
  explicit `false`.

## What to Tell Your User

Nothing changes for you. On a development agent, Instar now quietly records
which of its Telegram replies a fast model thinks you should look at, so we
can check those guesses against the replies you actually corrected before
deciding whether to show you a "worth a look" marker.

## Summary of New Capabilities

- `GET /jev-review-flag/summary`: checks, would-flags and per-topic counts from the log-only review-flag shadow (development agents).

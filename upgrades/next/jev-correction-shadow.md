# A log-only check on whether corrections are being missed, on development agents

## What Changed

The Correction & Preference Learning Sentinel only studies a user message when
a keyword detector (Layer 0) marks it as a correction or preference, and that
detector misses most real corrections. A new dark research instrument measures
the gap without changing anything. On a development agent, for each inbound
Telegram message from the user, the server secret-scrubs the message and the
tail of the agent's previous message in that topic, and asks Jev (TypeSafe,
`jev-1.13.0`) whether it is a correction, a standing preference, neither, or
cannot tell. It writes one content-free row to `logs/jev-correction-shadow.jsonl`
(Jev's probabilities, the Layer-0 verdict, whether they agree and the message
id; never the text). `GET /jev-correction/summary` reports Jev
flags against Layer-0 signals and their agreement.

It changes nothing the sentinel records and delivers nothing. Dev-gated: live
on a development agent, dark on the fleet (`intelligence.jevCorrectionShadow`,
`enabled` omitted). Needs the vault `typesafe_api_key`. Bounded by a daily call
cap (default 500), a 1.5 s timeout and two calls at a time; the kill switch is
read live.

## Evidence

- A 14-day backfill over 347 real operator messages using the shipped
  rendering and question: Jev flagged 90, Layer 0 flagged 12, both 11. From 1
  to 5 October Jev flagged 13 and Layer 0 flagged none, matching the verified
  "no-signal since 29 September" audit.
- Unit, integration and e2e tests; the integration and e2e tiers drive a real
  TelegramAdapter's message seam and the real routes, and show the feature
  alive on a development agent and dark on the fleet.

## What to Tell Your User

Nothing changes for you. On a development agent, Instar now quietly measures
how many of your corrections its learning feature is missing, so we can decide
later whether a smarter detector should feed it.

## Summary of New Capabilities

- `GET /jev-correction/summary`: Jev correction/preference flags against the correction sentinel's keyword verdicts, from the log-only correction shadow (development agents).

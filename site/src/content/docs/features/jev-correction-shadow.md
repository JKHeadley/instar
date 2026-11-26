---
title: Jev Correction Shadow
description: A log-only measurement that asks a fast decision model whether each message from the user is a correction or a standing preference, beside the keyword check the learning feature relies on. It changes nothing. Development agent only.
---

The Correction & Preference Learning Sentinel only studies a user message after a cheap keyword check (Layer 0) marks it as a possible correction. In a two-week sample of 347 real messages, that check marked 12; Jev (TypeSafe's fast decision model) marked 90, and most of those were real corrections or standing rules. Corrections the keyword check misses are never learned.

**`JevCorrectionShadow`** measures that gap without changing anything. For each inbound Telegram message from the user, the server secret-scrubs the text, asks Jev whether it is a correction, a standing preference, neither, or cannot tell (with the agent's previous message as context), and writes one content-free row: Jev's probabilities, the Layer-0 verdict, whether they agree, and the message id — never the words.

## Safeguards

- Log-only: `JevCorrectionShadow` never changes what the sentinel records and never sends, blocks, or delays a message.
- The log (`logs/jev-correction-shadow.jsonl`) is content-free.
- Text sent to Jev is secret-scrubbed; each check is bounded in time and capped per day. Failures are recorded and skipped.
- Live on a development agent, dark on the fleet; `intelligence.jevCorrectionShadow.enabled: false` is a kill switch, read live. It needs the vault `typesafe_api_key`.

Summary route: `GET /jev-correction/summary` (Bearer) — checks run, Jev flags versus Layer-0 signals, and agreement. A row with a Jev flag and no Layer-0 signal is a correction the sentinel missed.

---
title: Jev Review-Flag Shadow
description: A log-only measurement that asks a fast decision model whether each agent reply on Telegram needs the operator's review. It never shows a flag. Development agent only.
---

An operator catches some agent mistakes only by reading a reply and correcting it: a "done" with nothing to show for it, a question the reply never answered, a costly step mentioned in passing. If a cheap check could pick out those replies, the operator's attention (or a stronger reviewer) could go there first.

**`JevReviewFlagShadow`** measures whether that check works, without ever showing a flag. Once a minute the server reads the newest agent replies in its own Telegram history (conversational sends only, at most 30 minutes old), removes anything that looks like a secret from each reply and the operator message it answers, and asks Jev (TypeSafe's fast decision model) whether the reply needs review, is fine, or cannot be told. It records only the answer, keyed by the Telegram message numbers, so a week of answers can be compared with the replies the operator actually corrected.

## Safeguards

- Log-only: `JevReviewFlagShadow` never sends, blocks, delays, or changes a message.
- The log is content-free: message numbers, label, probability, would-flag.
- Text sent to Jev is secret-scrubbed before it is shortened; each call is time-bounded, metered, and capped per day; one call at a time. Failures are silent.
- Live on a development agent, dark on the fleet; a kill switch is read live.

Summary route: `GET /jev-review-flag/summary` (Bearer) — checks, would-flags, and per-topic counts.

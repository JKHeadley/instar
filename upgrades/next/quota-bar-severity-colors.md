# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Subscriptions dashboard's quota bars are now colour-coded by how much of each account's limit is used. Every bar previously rendered in the same green regardless of utilization, so the only difference between an account at 4% and one at 92% was the bar's length — a distinction that is hard to read at a glance across a stacked list of accounts, which is exactly where the list is read.

Each bar's fill now carries one of three severity classes derived from the same clamped 0–100 integer that already sets its width: green below 75% used, amber from 75% through 89%, red at 90% and above. The percent text that has always sat beside the bar is unchanged, so the colour is redundant with information already on screen rather than the only way to read the value.

This is presentation only. No routing, placement, load-shedding, proactive-swap or alerting decision reads the new class — those keep consuming the numeric quota they already consumed, on their own thresholds, unchanged.

## What to Tell Your User

Your Subscriptions dashboard now shows each account's quota bar in green, amber or red depending on how much of the limit is used, instead of always green. An account that is comfortable stays green, one that is getting tight turns amber at 75%, and one that is at or near its wall turns red at 90%. Nothing about how work is routed between your accounts changed — this only makes the page easier to scan. The percentage is still written next to every bar.

## Summary of New Capabilities

- Subscriptions quota bars are colour-coded: green (<75% used), amber (75–89%), red (≥90%).
- The colour is derived from the already-clamped percent, so a bad reading cannot produce a misleading colour — it clamps to 0% / green or 100% / red.
- Colour is never the only signal: the "N% used" text is unchanged and always present.
- No routing, shedding or alerting behaviour reads the new class.

## Evidence

- Visual: the shipped module and the shipped CSS rendered together against the account mix from the operator's reference screenshot — 0/22/68% green, 83/89% amber, 100% red.
- Unit (`tests/unit/subscriptions-render.test.ts`, 92 passing): both sides of both band boundaries (74/75 and 89/90), severity derived from the clamped number (1000 → critical, −50 → ok, non-numeric → ok, 74.6 → warn by rounding), the fill's class attribute, and a hostile percent proving the class stays a closed-set literal.
- Mutation-checked: flipping `>=` to `>` on the warn boundary fails the 75% case, so the boundary assertions are load-bearing rather than decorative.

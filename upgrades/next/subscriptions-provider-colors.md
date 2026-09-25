# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Subscriptions dashboard colors each provider so Claude and Codex are told apart at a glance: Claude in clay orange, Codex in blue. Each group heading in the account-by-machine grid and in the account list becomes a wide tinted band in its provider color. Each grid row's account cell and each account card gets a thick left edge in that color. A new closed mapping, `providerClass()` (anthropic → `sub-prov-claude`, openai → `sub-prov-codex`, anything else → `sub-prov-other`), is the only path from a provider string to a class name. Grouping, ordering and the single-provider "no heading" rule are unchanged.

## What to Tell Your User

On the Subscriptions page, Claude accounts now show in orange and Codex accounts in blue, both in the grid and in the list below, so you can see which is which without reading the labels.

## Summary of New Capabilities

- Provider color-coding on the Subscriptions dashboard (grid bands, row edges, card edges).

## Evidence

- Operator request 2026-09-25: "make the various claude/codex sections MUCH more differentiated/apparent so its much easier to at-a-glance know which accounts I'm looking at".
- Tests: `tests/unit/subscriptions-render.test.ts` (+3: card and heading classes, grid band and row classes, closed mapping for unknown or hostile provider strings); 100/100 pass. A visual mockup was rendered from the real CSS and renderer.

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Manual Codex balancing prefers freshly reset local accounts with a verified 0% weekly reading while their usage forecasts are gathering history. Remaining hours and work already on each account guide the choice. When no fresh reset qualifies, the existing forecast ordering applies.

## What to Tell Your User

When you ask me to move a Codex session, I can now use a freshly reset account as soon as its quota is verified. The existing checks still protect work in progress.

## Summary of New Capabilities

Manual Codex balancing can use a verified fresh reset without waiting for a full usage forecast.

## Evidence

Unit, HTTP integration, and production-shaped lifecycle tests cover the new choice. Existing forecast and busy-work refusal cases remain active.

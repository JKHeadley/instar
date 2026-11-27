# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Manual Codex balancing can use freshly reset local accounts with a verified 0% weekly reading while their usage forecasts are gathering history. It compares how many sessions are already on the fresh account and the best account with a forecast before choosing. If the fresh account has more sessions, the move goes to the account with a forecast.

## What to Tell Your User

When you ask me to move a Codex session, I can now use a freshly reset account as soon as its quota is verified. The existing checks still protect work in progress.

## Summary of New Capabilities

Manual Codex balancing can use a verified fresh reset without waiting for a full usage forecast.

## Evidence

Unit, HTTP integration, and production-shaped lifecycle tests cover the new choice. Existing forecast and busy-work refusal cases remain active.

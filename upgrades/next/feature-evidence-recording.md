# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

113 switched-off features now record what they do: when each fires, holds back or fails, with the reason and a few small facts. Rows go to the evidence log on development agents, so the maturation ladder can judge each feature by its own behaviour. No feature's behaviour changes. Decisions taken per message are limited to one row per window, and that row says how many it stood for.

## What to Tell Your User

Nothing changes for you. Features still switched off now keep a record of what they did and why, so it's clear when each is ready to turn on.

## Summary of New Capabilities

- 113 more features can be judged from real records instead of reading "no data".

## Evidence

Reproduction of the gap: 115 of 172 ladder entries read "no data" with nothing recording. After this, 2 remain, and neither can record from inside the server: one is a CI script, one has no decision point. Unit tests of every changed module pass, and the full run is the merge gate. Text is scrubbed and bounded; message text, prompts and credentials are not recorded.

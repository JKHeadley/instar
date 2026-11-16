# Internal: Chief of Staff, work board and Conversations links tested directly

<!-- bump: patch -->

## What Changed

The code that links the Chief of Staff's projects and the work board's cards to Conversations (projects offered as suggestions, cards proposed under their project) now lives in one small module with direct tests. No change in behaviour.

## What to Tell Your User

Nothing to tell: this changes nothing they see.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| None (internal) | — |

## Evidence

- `tests/unit/work-front-doors-graph.test.ts`.

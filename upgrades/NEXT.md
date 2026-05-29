# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Commitments guidance now matches the live one-time follow-up contract. Agents
record follow-up promises as `one-time-action` commitments and include both the
user request and the agent response before marking them delivered.

## What to Tell Your User

- **Commitment follow-through is more reliable**: "When I register a future follow-up for myself, the built-in guidance now uses the same wording the server actually accepts, so the reminder can be created and closed cleanly."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Commitments follow-up contract guidance | Automatic for newly generated or migrated agent guidance |

## Evidence

Live commitment lifecycle verification created a test commitment, inspected it,
delivered it, and verified it was terminal/closed. Focused unit, integration, and
e2e lifecycle tests now pin the accepted create payload, delivery transition,
active-list closure, generated guidance, and PromiseBeacon stop behavior.

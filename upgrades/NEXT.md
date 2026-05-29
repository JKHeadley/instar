# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Attention Queue API now accepts the documented write-side vocabulary while
keeping its canonical read shape. Status aliases like `resolved` map to the
stored `DONE` value, priority aliases like `medium` map to `NORMAL`, and create
requests can use the documented `body` and `source` fields. Generated guidance
now shows the required stable item id when queueing an attention item.

## What to Tell Your User

- **Attention items are easier to manage**: "When I queue or resolve something that needs your attention, the documented wording now works reliably while the queue stays consistent internally."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Attention Queue write-vocabulary compatibility | Automatic for attention item create, list-filter, and resolve requests |

## Evidence

Read-only inspection found existing queue items using canonical uppercase
statuses and priorities, while generated guidance and an internal release
readiness caller used lowercase documented terms. Focused unit, integration, and
e2e lifecycle tests now verify the documented create and resolve vocabulary maps
to canonical queue state without creating real Telegram topics during tests.

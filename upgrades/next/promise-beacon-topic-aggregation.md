<!-- bump: patch -->

## What Changed

PromiseBeacon now composes every qualifying notice for a conversation into one durable count-and-list summary per topic cadence. The topic uses the shortest effective cadence among its open promises, so the most urgent promise retains its timing without every slower promise multiplying the message count.

Mixed-news summaries distinguish status from inventory: promises with real news receive update bullets, while quiet siblings appear only in the open-promises list. Pending updates survive restart, typed delivery failures retain their existing dispositions, and the aggregate retry cannot run faster than the topic cadence. A rollback setting restores legacy per-promise delivery.

## Evidence

- Tier 1 burst coverage proves twelve same-topic commitments emit one message in-window and one aggregate at the next boundary.
- Mixed-news coverage proves one newcomer’s progress is not attributed to two quiet siblings.
- Boundary, multi-topic, restart, and terminal session-loss cases are pinned.
- The existing PromiseBeacon regression suite, migration tests, typecheck, build, lint, and precommit gate pass.

## What to Tell Your User

Promise updates are quieter now: when several are open in one conversation, you get one clear summary with the full list instead of a burst of separate messages.

## Summary of New Capabilities

- One PromiseBeacon summary per conversation cadence.
- Durable aggregation of qualifying promise updates across restart.
- Honest mixed-news presentation with separate open and updated lists.
- Configurable rollback to legacy per-promise delivery.

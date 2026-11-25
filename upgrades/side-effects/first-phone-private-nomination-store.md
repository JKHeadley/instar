# Store one nomination for a private Telegram Accept tap

The isolated SQLite transaction records one nomination identifier with its callback hash, delivery receipt ID and exact proposal hash. An exact eligible replay returns the original identifier. Reuse of the callback, receipt or proposal with a conflicting binding is refused.

- Authority. The caller must supply authenticated callback evidence and current account, owner and holder facts. This checkpoint does not authenticate Telegram, enroll devices or write production state.
- Retry. Nested transactions are refused so a returned nomination cannot be rolled back by an outer transaction. A later phone approval still needs the separate first-acceptance check.
- Rollback. No runtime caller or installed migration.

Independent review concurred for the isolated transaction. Live nomination must retain durable provenance and bind current owner, account, device and holder in the proposal.

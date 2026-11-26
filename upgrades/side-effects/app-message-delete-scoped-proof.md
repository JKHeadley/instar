# App Delete history proof and unrelated chat writes

The unmounted history projection can keep preparing or reusing an existing proof during successful plain-message appends in a different chat. The durable journal identity remains part of the same-chat proof. The accounting excludes only the known successful index transaction for a plain message. External SQLite commits, catch-up and all other local writes can still invalidate preparation.

The write path adds two local SQLite counter reads to ordinary message indexing. The counter has no durable state. Receipt verification and the current App history routes keep their existing behavior. Reverting the change restores database-wide invalidation for all writes.

## 6b. Operator-surface quality

Messages arriving in another chat no longer prevent the first history check from completing. A change to the chat being checked still cancels an outdated check.

## Framework generality

The change applies to the App conversation store independently of the client and agent harness.

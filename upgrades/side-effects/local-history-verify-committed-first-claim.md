# Side effects of verifying the committed first claim

The permit verifier uses a private, read-only jobs database connection and an exact snapshot of the slot and operation. It checks the first claim only and refuses missing, uncommitted, changed or interrupted state. The operation and slot observations share one SQLite read transaction. No write, retry or schema change occurs.

A future worker must pair this check with its exact child, writer and one-shot in-memory plan. The verifier alone does not authorize a mutation, receive a message, or expose a route. The disposable pilot and real-user hold remain as specified. Reverting the helper removes only the read capability.

Independent review concurred. The database snapshot distinguishes an uncommitted outer transaction from the exact committed applying state and rejects substituted slot fields. Live authority and one-shot consumption remain coordinator obligations.

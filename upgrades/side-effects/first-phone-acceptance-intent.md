# First-phone acceptance intent

The phone writer can record the exact nomination and proposal against the durable first-approver reservation. Reservation matching, live holder checks and intent insertion run in one local transaction. A replacement winner, changed nomination or proposal, or stale holder cannot publish an intent. Recovery can look up the exact persisted intent after reopening.

This is a local checkpoint with no production caller. It grants no device authority. The trust journal and predecessor fencing still determine when the effective acceptance can be published.

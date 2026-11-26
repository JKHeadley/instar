# Side effects of executing a verified first claim

The planned store entry point recomputes the claim digest from the worker's already validated artifact descriptor, current destination and actual held plan. It checks the exact applying permit through a read-only jobs snapshot, then checks the branded live child allocator for that operation and run. The allocator marks its first attempt consumed immediately before the synchronous store write. Changing store instances does not reset that attempt.

Bad plan identity, mismatched or uncommitted permit, stale destination, wrong child or repeat attempt refuses before a claim write. A failed issued attempt stays consumed. Normal preview, legacy imports and ordinary planned-store callers keep their current behavior.

The runtime coordinator must still supply verified artifacts, enforce its live reservation and deliver the committed permit under authenticated disposable scope. This entry point has no signed route and is exercised only in a synthetic registered-child fixture in this checkpoint. Production copy remains held. Revert the entry point and allocator latch together. The first claim uses the existing durable format.

Independent rereview concurred after the one-shot latch moved to the real worker allocator. The fixture uses a measured private ledger reservation, performs the committed claim in an actual registered child, rejects a second attempt, and settles after child close.

# Durable first-approver nomination binding

Private nomination capture stores the first-approver slot alongside the callback, receipt, and proposal digest in the same SQLite transaction. Reading the binding retrieves the slot and proposal digest for final validation. A replay cannot reinterpret an existing receipt as a nomination for another slot.

The schema update is additive and serialized. Older rows have no slot and cannot supply a binding or acquire one through callback replay. They retain their uniqueness checks. Fresh enrollment will need a new proposal. Tests cover binding readback, a missing nomination and migration of an older row.

The store has no live callers. Device acceptance still requires authoritative current owner, account, holder and device proof, plus the exact slot check at the durable acceptance write.

Independent review concurred after schema initialization and binding reads were restricted to committed state outside caller-owned transactions.

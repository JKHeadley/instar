# Read-only relay phone binding

The relay phone status handler can use this adapter to join a verified enrollment to the current agent, relay assignment, owner lineage, signed holder lease, TLS pin and active native phone key. It accepts only the exact currently active authorizing owner key instance. An unreadable or mismatched source returns no binding. The adapter refuses use before the lease begins and at expiry.

The production enrollment verifier remains an input owned by Identity. The adapter adds no storage, enrollment writes, public bootstrap route or default startup wiring. It returns only the hostname, assignment and phone key hash. The synthetic tests use independent signatures and cover wrong scope, forged or missing evidence, key and owner revocation and lease timing. Revert by removing the dormant adapter. There is no state migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. Each call joins one current enrollment and verified owner and lease scope without writes.

# Side-Effects Review — Camera verifier request issuance

## Summary of the change

Adds request issuance against a journal transaction supplied by the caller. No production route or journal adapter instantiates the service in this checkpoint.

## Decision-point inventory

- Reject unavailable or contradictory receipt history, unknown principals and builders.
- Reject a fresh request while Pass remains active.
- Return a server-generated request only after the journal confirms a durable append.

## 1. Over-block

The assigned verifier must record Pending before retesting a passing candidate. An unavailable authoritative journal holds legitimate requests until it recovers.

## 2. Under-block

A caller could supply a false principal, incomplete head, or a write lock that does not coordinate receipt changes. Prevent these at the production entry point by resolving the strict live session and using the lease-fenced journal transaction for all writes. This checkpoint adds no standalone endpoint.

## 3. Level-of-abstraction fit

The request service applies the deterministic rule. The journal owns locking, authoritative coverage and persistence. The server owns authentication and request validation.

## 4. Signal vs authority compliance

The exact verifier binding and latest receipt are enumerable. The human verifier still judges whether the actual journey passed. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point.

## 5. Interactions

The service checks receipts and appends under the same transaction contract. An invalid receipt stream stays unavailable. No service registers a handler or takes a lease in this checkpoint.

## 6. External surfaces

No HTTP endpoint, operator action or user message changes. Tests use an in-memory journal double.

## 7. Multi-machine posture

The service has no local state. The production adapter must use the replicated Chief of Staff journal and the active lease. This checkpoint sends no notices, stores no live records and generates no URLs.

## 8. Rollback cost

Revert the checkpoint. No migration or live-state repair is required.

## Conclusion

The checkpoint tests issuance behavior. Durable adapter and route tests are necessary before enabling the pilot.

## Second-pass review

The independent acceptance security reviewer concurred. The production receipt adapter must consume server-issued requests under the same lock and validate the current assignment epoch and issuance window. A new Pass invalidates outstanding request IDs. A durable Pending opens the next issuance window.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.

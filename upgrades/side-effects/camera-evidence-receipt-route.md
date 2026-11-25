# Side-Effects Review — Camera evidence receipt route

## Summary of the change

Adds a dormant HTTP route to record a Camera evidence receipt. The request contains only an issued request ID. Evidence comes from the configured protected reader.

## Decision-point inventory

- Require normal server authentication and the shared strict verifier resolver.
- Reject unexpected body fields and hold when request-bound evidence is missing.
- Acknowledge only a recorded receipt and map stale or altered retries to conflict.

## 1. Over-block

A valid reviewer cannot submit until the protected evidence reader resolves the same request. Forged or extra caller evidence is rejected.

## 2. Under-block

The protected reader must verify current reviewer provenance, freshness, attribution and scope. The route cannot attest evidence on its own. There is no production resolver or evidence reader yet.

## 3. Level-of-abstraction fit

HTTP accepts an opaque reference. The protected source resolves evidence, and the journal adapter checks active state and authorization before writing.

## 4. Signal vs authority compliance

The boundary enforces exact provenance and request identity. The verifier supplies actual journey evidence. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is introduced.

## 5. Interactions

Evidence loading occurs before the locked journal submission. The production adapter rechecks authorization immediately before emission. The test injects a protected reader and journal.

## 6. External surfaces

Adds a dormant internal reviewer endpoint. It returns decision and sequence. It exposes neither evidence nor credentials.

## 7. Multi-machine posture

The production receipt belongs to the existing replicated Chief of Staff journal. The route adds no store or owner notice.

## 8. Rollback cost

Remove the dormant route and option. No live state needs migration.

## Conclusion

The route and its AgentServer HTTP test are ready for draft review. Production resolver and protected evidence reader remain open.

## Second-pass review

The independent acceptance security reviewer concurred for the dormant route. Production must preserve immutable request-bound evidence and recheck authorization after the awaited read. The route uses the same scoped journal for issuance, withdrawal and submission.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.

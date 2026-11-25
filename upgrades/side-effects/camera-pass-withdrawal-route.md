# Side-Effects Review — Camera Pass withdrawal route

## Summary of the change

Adds a dormant authenticated HTTP surface for retiring an exact Camera Pass. Request issuance and withdrawal share strict verifier authentication. Camera lifecycle cases now live in a dedicated test file.

## Decision-point inventory

- Reject invalid withdrawal bodies and unverified sessions.
- Delegate exact Pass, retry and durable write decisions to the Camera journal service.

## 1. Over-block

The route refuses a body with missing or unexpected fields. A verifier referencing a stale Pass must reread the current result.

## 2. Under-block

The production boot path still needs a resolver that binds a strict credential to the configured pilot and a lease-fenced journal. The default server has no resolver.

## 3. Level-of-abstraction fit

The route validates HTTP input and maps statuses. Authentication and the journal own their respective authority.

## 4. Signal vs authority compliance

Input shape and retry identity are exact invariants. The independent verifier determines the reason to retire a Pass. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is introduced.

## 5. Interactions

A successful withdrawal allows the request service to issue the next test request. Altered reuse is a conflict, and retrying an exact withdrawal does not append another record.

## 6. External surfaces

Adds a dormant internal reviewer endpoint. There is no new owner action or message.

## 7. Multi-machine posture

Production writes go through the existing replicated Chief of Staff journal and its current lease. No local store or outbound link is introduced.

## 8. Rollback cost

Remove the dormant endpoint and retain the existing request route. There is no new live state to migrate.

## Conclusion

The real AgentServer HTTP lifecycle test covers authentication, body validation, conflict, and a new request after Pending. Production resolver composition remains open.

## Second-pass review

The independent acceptance security reviewer concurred. Both routes require the shared verifier check and existing server authentication. Exact retries return the recorded result, and production remains unavailable without a resolver.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.

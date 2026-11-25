# Side-Effects Review — Camera reviewer runtime composition

## Summary of the change

Connects strict session authentication, a configured Camera scope, the journal adapter and protected evidence reader behind the server resolver contract. Production boot does not instantiate it in this checkpoint.

## Decision-point inventory

- Require the active Camera scope before and after async authentication.
- Reject stale scope or revoked authorization before accessing evidence and after an awaited read.
- Allow journal operations only under the active scope and verifier assignment.

## 1. Over-block

Requests hold during a lease or scope change, verifier revocation or an unavailable assignment. No user action is blocked by the dormant checkpoint.

## 2. Under-block

The runtime caller must supply an authoritative scoped assignment, an independently verified request-bound evidence reader and a lease-fenced journal. The factory delegates these checks.

## 3. Level-of-abstraction fit

The factory composes existing components. It neither implements authentication nor collects evidence.

## 4. Signal vs authority compliance

Exact scope and credential binding are deterministic. The independent verifier supplies the observed journey. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is introduced.

## 5. Interactions

The factory rechecks scope and liveness across awaited stages. The journal adapter still rechecks active assignment before emission. Production has no caller yet.

## 6. External surfaces

No change to live endpoints, user actions, outbound notices or persistent format.

## 7. Multi-machine posture

The serving holder checks local session liveness. The authority and journal state are supplied by the replicated Chief of Staff backend. No local durable state or notice is introduced.

## 8. Rollback cost

Revert the checkpoint. No live state needs migration.

## Conclusion

The resolver composition is tested. Production boot inputs and independent evidence storage remain to be connected.

## Second-pass review

The independent acceptance security reviewer confirmed the runtime and receipt route use the same evidence loader contract and concurred with the unwired checkpoint.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.

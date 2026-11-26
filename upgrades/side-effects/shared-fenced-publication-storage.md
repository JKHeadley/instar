# Shared fenced publication storage checkpoint

## Summary of the change

A single transactional store records the authority generation and permanent exact claims independently for four namespaces.

## Decision-point inventory

Provision an initial scope once. Prepare an exact successor only from the current active generation. Activate only that recorded candidate. A claim checks active holder and epoch, then atomically inserts or returns the existing exact result.

## 1. Over-block

Pending handover refuses both old and new holders. Conflicting evidence or a mismatched candidate remains pending.

## 2. Under-block

The store cannot authenticate its users, witness a serving lease deadline, or detect rollback of its own volume. Production requires those checks outside this checkpoint before it can grant dispatch authority.

## 3. Level-of-abstraction fit

The store enforces namespace, generation, phase and claim serialization. Receiver authentication and each client's admission policy belong above it.

## 4. Signal vs authority compliance

An existing claim is historical evidence. It does not grant another physical operation. The storage component has no runtime producer or dispatch callback.

## 4b. Judgment-point check

All database decisions are exact comparisons. There is no interpretation of operation payloads.

## 5. Interactions

Claims survive generation change. The mobile client will use the agent, device and request as its stable operation key and bind its exact admitted digest.

## 6. External surfaces

This checkpoint opens no endpoint and does not publish data.

## 7. Multi-machine posture

All eligible writers must reach the same authenticated authority. Independent database copies cannot be used as interchangeable writers. An independent floor must prevent an old backup from becoming authoritative.

## 8. Rollback cost

No production runtime opens the database. Rollback removes only the unused store.

## Second-pass review

Concur for the dark storage checkpoint. The immediate transaction serializes generation and pending checks with claim insertion. Activation and claim history use exact identities. The follow-up checks actual WAL mode and tests reopening after a committed pending transition.

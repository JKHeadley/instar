# App handover intake checkpoint

## Summary of the change

Add an atomic waiting record to the existing private mobile request store. The record refers to an already durable signed message event.

## Decision-point inventory

The lookup rejects conflicting reuse and respects the existing per-device cap. The private write persists the event reference with the 202 receipt before reporting success.

## 1. Over-block

Existing capacity and failed-write handling still apply. A duplicate with a different payload hash remains a conflict.

## 2. Under-block

The store cannot verify the external event itself. The future ingress caller must prove the event was committed and bound to the exact request before calling this helper.

## 3. Level-of-abstraction fit

The request store owns persistent idempotency receipts. The signed conversation journal owns message bytes.

## 4. Signal vs authority compliance

A waiting receipt preserves custody. It does not authorize execution or confer a serving lease.

## 4b. Judgment-point check

The checkpoint introduces no language interpretation or policy judgment.

## 5. Interactions

The ordinary reserve path still creates an active entered record. Waiting records use a separate operation tag and stay outside the native send recovery sweep.

## 6. External surfaces

This checkpoint introduces no HTTP behavior.

## 7. Multi-machine posture

This store remains local. Transfer and one current-holder claim are separate wiring requirements.

## 8. Rollback cost

Existing readers understand the done state. No storage migration is required.

## Conclusion

The atomic waiting receipt can be tested independently of the handover transport.

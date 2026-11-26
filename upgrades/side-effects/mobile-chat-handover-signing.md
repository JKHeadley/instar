# App handover signed custody checkpoint

## Summary of the change

Sign exact historical custody for a Telegram-backed app message, and verify the original device and accepting-machine evidence before it can be used by a future transfer receiver.

## Decision-point inventory

Check the exact device, request, key, message and event identities. Recompute the existing idempotency hash for an available exact body, including its existing attachment projection. For intentionally redacted bodies, the admitting machine attests the request hash and event.

## 1. Over-block

Missing trusted device or machine evidence prevents verification. This unwired checkpoint does not affect active ingress.

## 2. Under-block

An attestation cannot establish current topic access or a current-holder claim. The receiver must authorize the enrolled ingress peer and revalidate live device rights before a claim. The claim must key on device and request ID, comparing the proven body hash.

## 3. Level-of-abstraction fit

The carrier reuses existing device-signature and machine-receipt verification. It does not add a new trust registry.

## 4. Signal vs authority compliance

The carrier proves historical custody only. It grants no session, lease, command, replay or delivery authority.

## 4b. Judgment-point check

The checks are deterministic. Unreadable, malformed or unknown evidence returns false.

## 5. Interactions

All existing media routes use the same fingerprint projection as before. Existing redaction continues to avoid retaining removed tokens.

## 6. External surfaces

No HTTP route uses the checkpoint yet.

## 7. Multi-machine posture

Machine keys and device identities come from trusted receiver-side sources. Later wiring must apply the current holder fence and bound received payloads.

## 8. Rollback cost

The code introduces no schema changes or persisted records.

## Conclusion

The checkpoint binds historical evidence without enabling custody transfer or dispatch.

## Second-pass review

Concur for the unwired checkpoint. Exact device bodies rederive the original request fingerprint. The carrier verifies derived IDs and both signatures, and malformed proofs fail closed. The future receiver must still authorize the current device, recipient and epoch before claiming the device and request ID.

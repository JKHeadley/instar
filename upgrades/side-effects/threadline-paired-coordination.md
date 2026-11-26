# Side-effects review for paired Threadline coordination

The unmounted rule adds a single exact grant scope for work coordination. It admits only an already-authenticated recipient whose full key still matches a verified pairing and whose same-operator membership matches the current grant. Explicit denials and revoked or unavailable grants keep the send closed. Display names and partial fingerprints never identify an authorized recipient.

Grant changes require a trusted owner PIN approval for the exact scope, owner revision, expected grant revision and action. The durable writer must atomically recheck authority, consume the approval and write the grant revision. The module ships default-off and has no live caller, mutation route, credentials, or storage migration. It does not bypass any existing Threadline check.

The next composition must use verified owner membership evidence, an owner PIN control-plane action, and the authenticated final transport identity. It must enforce existing denials before the send and retain the ordinary content checks. The fixtures exercise only the policy and trusted-port contract. Rollback removes the dormant module without changing any user policy.

Work coordination also requires an authority-owned work record with the exact outbound message digest and recipient key. The live sender must derive the digest from the final bytes and recheck the same snapshot at egress.

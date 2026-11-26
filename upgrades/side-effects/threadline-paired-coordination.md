# Side-effects review for paired Threadline coordination

The unmounted rule adds a single exact grant scope for work coordination. It admits only an already-authenticated recipient whose full key still matches a verified pairing and whose same-operator membership matches the current grant. Explicit denials and revoked or unavailable grants keep the send closed. Display names and partial fingerprints never identify an authorized recipient.

Grant changes require a trusted owner PIN approval for the exact scope, owner revision, expected grant revision and action. The durable writer must atomically recheck authority, consume the approval and write the grant revision. The module ships default-off and has no live caller, mutation route, credentials, or storage migration. It does not bypass any existing Threadline check.

The next composition must use verified owner membership evidence, an owner PIN control-plane action, and the authenticated final transport identity. It must enforce existing denials before the send and retain the ordinary content checks. The fixtures exercise only the policy and trusted-port contract. Rollback removes the dormant module without changing any user policy.

Work coordination also requires an authority-owned work record with the exact outbound message digest and recipient key. The live sender must derive the digest from the final bytes and recheck the same snapshot at egress.

The dark composition has one signed-in owner PIN surface at `/trust/paired-agent-coordination`. It uses the shared current-PIN verifier and its guess limits. A SQLite transaction binds the exact action to the current owner and grant revisions, records one-time proof use and changes the grant. The delivery adapter owns the final outbound bytes and classifies only an admitted send under the paired coordination kind. Existing generic send and modify handling remains in effect outside this lane. The running service mounts neither path.

## 6b. Operator-surface quality

The isolated endpoint exposes one description of the permission and its current state. An eventual dashboard view can lead with the proposed scope and present approve or turn off as the only actions. The response contains no PIN or peer internals. The permission text is short enough to read on a phone. There is no dashboard view or live link in this checkpoint.

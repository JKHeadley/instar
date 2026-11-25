# Windows relay pairing routes

The optional loopback router lets a paired Windows app check relay availability and request a one-use code. The two exact paths require the existing native local-owner signature, the original loopback host and a direct local arrival. A bearer, a browser device, a nonlocal device or forwarded traffic cannot use them. The signed-device allowlist extension is disabled for existing listeners.

Issue responses carry only the code and its remaining lifetime and are marked no-store. The router checks current device and owner authority after waiting for issuance and withholds the code if the device was revoked. No code is logged or stored in the router. Existing admission and relay limits still apply.

The signed HTTP test uses a real local owner device, actual signing and verification, and a disposable relay service boundary. It proves refusal and success, including revocation during issuance. Independent rereview concurred. The router is still dormant. Production listener composition and its lifecycle verification remain separate. Reverting needs no migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. Each action requires a signed local owner request and reaches a bounded runtime operation.

# Relay runtime admission

The explicit startup adapter reads the current machine identity and verifies the local holder's signed committed lease before starting the outbound connection. The caller supplies both the committed store read and the lease coordinator's ownership verdict. The raw data stream only connects to the caller's dedicated TLS listener on IPv4 loopback. The adapter creates no listener and is disabled unless explicitly enabled.

Pairing code issuance becomes available after the relay authenticates the control stream. It rechecks the current authority before issuing a code and again before returning one. Connection closure, shutdown or lease loss withdraws the capability. The local monitor samples at 250 milliseconds. One request at a time is held through actual stream closure, and the relay reply is size and time bounded. The relay still independently verifies issuance authority.

The disposable integration test uses actual MachineIdentity keys, a signed lease, the live relay admission flow, and a real loopback TLS listener. It covers dark startup, premature and concurrent refusal, issuance and redemption, and revocation after local ownership loss. Independent rereview concurred. No installed agent invokes this adapter. The paired-owner local HTTP routes and production assignment and TLS listener composition remain pending. Reverting the slice requires no state migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. An explicitly started relay uses bounded reconnect attempts and allows a single in-flight code request per admission.

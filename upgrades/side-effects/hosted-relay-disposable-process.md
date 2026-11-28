# Side effects of disposable relay control wiring

The disposable relay binds one control stream per outbound HTTP/2 session. The holder answers a one-use challenge with a signed lease claim. Only an admitted session can offer data streams. The service sends a typed admission or refusal and disconnects transport when control closes.

- A malformed, oversized, late or repeated claim fails closed. A session receives a bounded claim buffer and a handshake deadline. Raw TLS admissions are capped and close on service stop. Control EOF revokes service, including active streams.
- The lease gate still owns admission. The caller owns authoritative committed evidence and socket creation. Aggregate connection limits and a production secure listener remain prerequisites before exposing the service.
- The test uses isolated loopback listeners, synthetic signed owner and lease records and the agent's own certificate. The relay forwards the encrypted bytes and leaves direct access unchanged.
- There is no deployed endpoint, app activation or automatic reconnect. Reverting requires no migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. The service accepts caller-owned sockets and uses a single bounded deadline per control attempt. Callers own any periodic sweep.

Independent rereview concurred with signed admission, exact control and stream ownership, and raw socket cleanup.

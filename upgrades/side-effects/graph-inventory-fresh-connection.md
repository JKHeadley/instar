# Fresh graph inventory connections

- Over-block. Inventory startup pays one TCP connection and, for HTTPS, one
  TLS handshake per export. The existing deadline includes this setup.
- Under-block. A fresh socket still fails if the peer or network is
  unavailable. Inventory pages keep the existing transport.
- Abstraction. The transport, which owns sockets, makes this decision.
- Signal versus authority. This changes connection selection only. The
  existing certificate, registry and signed-response checks still decide
  which results can be accepted.
- Interactions. The dedicated HTTP/1.1 dispatcher does not use the Node global
  fetch dispatcher for inventory startup. Node’s environment-proxy opt-in
  is honored by the dedicated transport. There is no new POST replay; the
  existing registered-peer endpoint iteration is preserved.
- External surfaces. The paths, signed payloads, status and response bounds
  are the same. This does not change other fetches.
- Multi-machine posture. The managed witness and enrolled peer use the same
  connection policy. Local owned custody runs without HTTP.
- Rollback. Reverting the code needs no data changes.

## 6b. Operator-surface quality

User-facing behavior is limited to fewer avoidable inventory read failures.

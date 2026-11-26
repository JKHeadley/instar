# App Delete background history proof

Cold removal-aware reads return unavailable. Preparation shares one active scan per store, yields between 64 KiB journal chunks, and publishes only if the same custody, file identity and SQLite generations hold throughout. A competing conversation can retry after the active preparation. The scan releases its descriptor and slot after success, invalidation or failure. The indexed read checks the proof before and after projection.

Receipt verification and raw journal reads keep their existing behavior. No HTTP route, feed or client capability is mounted in this checkpoint. Unrelated writes can restart preparation, and the first scheduled turn contains a synchronous count query. Test both under ordinary activity before mounting the route.

The independent reviewer concurred on checkpoint consistency and descriptor cleanup. The cross-model review requested an external index-only writer regression, which was added.

## 6b. Operator-surface quality

Preparing history in chunks lets the server service other work while reading a long journal. A concurrent removal cannot result in the earlier history being served.

## Framework generality

The store behavior is independent of the client and agent harness.

# Disposable native owner approval routes

An isolated router serves signed inventory, disclosure and challenge and verifies a dedicated phone signature at the authority callback. It requires exact paths, request shapes, device and holder bindings, current eligibility and live expiries for new approval. Only an exact historical receipt can be recovered after expiry. The consumer must atomically resolve the current state, consume that challenge and record the result. A mismatched receipt fails closed.

The disposable test supplies a synthetic owner and stand-in receipt store. The production server mounts no route. The shared dashboard PIN writer is unchanged. No sign-in configuration, secret, key binding or installed phone is changed. Durable consumption, real signed transport composition and the writer's distinct biometric mandate provenance remain separate integration work.

## 6b. Operator-surface quality

The native app reads a signed description of the policy and returns a short status. The response distinguishes a recorded approval from applied machine results. It contains no recovery credentials or raw approval internals in the primary screen. This checkpoint adds no destructive action or live user interface.

Receipt results are projected onto the known machine outcome fields and may name only machines in the exact approved proposal. Unknown or duplicate target rows leave the response unavailable.

The merge candidate is based on main independently of the first-phone branch. It carries only the shared biometric signature primitive needed by the disposable router. Application key registration and first-phone enrollment are outside this diff.

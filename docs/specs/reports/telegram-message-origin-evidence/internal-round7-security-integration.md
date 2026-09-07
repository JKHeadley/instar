# Round 7 — Security and Integration/Deployment

Spec: `docs/specs/telegram-message-origin.md`.

Canonical reviewable hash, verified with `node skills/spec-converge/scripts/cross-model-review.mjs --spec docs/specs/telegram-message-origin.md --hash-only`: `113955744c76d9474652b98ceb450012a6066f68be38f7008a0fe2d09e1784f2`.

Full-file SHA-256 for this observation: `2560e8d36e348daff9239d204463eb670a7988b7061df8963c0f08e51825e5a2`. The helper hash, not an independently trimmed-body hash, identifies the reviewable snapshot.

## SECURITY perspective

**0 DESIGN findings. 0 PRECISION findings.**

Rechecked current canonicalization, trusted session binding, attestation/key history, protected browser capability, same-message ASP, authorized materialization, and audit-read boundaries. Canonicalization now names the version, key/array ordering, Unicode and entity preservation, numeric restrictions and structured destination/media identities. It does not rely on ambiguous field concatenation or floating-point 64-bit IDs.

The outage-notice claim belongs to exactly one named process incarnation; other processes use bounded authenticated IPC and cannot reinterpret a timeout as claim transfer. Notice dispatch checks current permission, ownership, mute/archive/deletion/opt-out and display version. Invalid reservations are suppressed without rewriting the sealed body. These changes preserve the pre-recorded-only exception and do not grant an arbitrary bypass capability.

The explicit signer/verifier skew assumption does not weaken ASP's verifier. Known excessive skew holds; unknown skew remains an operating assumption rather than falsely verified clock evidence. The existing same-message requirement continues to avoid the previously identified human-authority interval.

## INTEGRATION/DEPLOYMENT perspective

**0 DESIGN findings. 0 PRECISION findings.**

Local spool resilience is now accurately limited to database/file failures; shared filesystem/device failures remain correlated. Fallback budget and independent outbox-admission failure are explicit. Evidence mirrors still cannot execute or compete for claims. Notice reservations have independent bounded capacity and cannot consume the ordinary delivery budget.

The Web K feasibility claim is supported by the saved primary-source/build evidence and anonymous manager-RPC canary. The spec correctly treats this as an incidental versioned client seam, requires authenticated send/receipt validation before activation, and does not imply the managed login was verified. Closing the exclusively owned browser process on the invocation deadline addresses the discovered worker-internal retry issue; the operation remains possibly in flight, and closing the process never becomes proof of non-delivery or permission to use a replacement random ID.

Rechecked original deadlines/attempt accounting, immutable redrive, late child materialization, legacy queued work, rolling writer/lifeline/peer activation, and audit retention/pagination. No additional contract-level flaw was identified in these perspectives. Concrete adapters, durable-store wiring and their fault tests remain implementation obligations; they are not claimed as already working.

## Authority and review status

Justin's explicit hold-with-notification decision remains authoritative. The diagnostics supervisor cannot manufacture receipts or authorize uncertain retries. Structural binding/idempotency validators stay within the hard-invariant exception in `docs/signal-vs-authority.md`.

`conformance-round-7.json` reports 90 standards checked, zero findings, non-degraded, with a successful 90-article registry canary. That independent result is consistent with this review, not a substitute for it. Earlier rounds' findings remain historical findings and are not relabeled quiet.

**Total: 0 DESIGN, 0 PRECISION.** This is a quiet round for these two perspectives on the hash above; it does not establish the next quiet round, overall convergence, implementation completion or deployment. No feature source or runtime state was modified.

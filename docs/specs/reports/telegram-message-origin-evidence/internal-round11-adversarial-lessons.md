# Round 11 — adversarial and lessons-aware review

Reviewed current spec body SHA-256 `056d5361eae344c45ba1e602e8b1a0a0b90043e12e600d741bcfdee8bc1feeed`, the changed notifier/rollout contracts, unchanged binding and lifecycle invariants, and conformance round 11. Both perspectives below are from the same reviewer.

## ADVERSARIAL

**DESIGN: 0. PRECISION: 0.**

The notifier is explicitly the sole consumer of reserved permits. Its private boundary has source enforcement plus behavioral rejection controls, including when the lint itself is sabotaged. Ordinary references cannot acquire a special claim or supply alternate text, destinations or variants. Finite variants still share one preclaimed child and one process-incarnation permit; no retry or fallback acquires another sender.

Fire-time policy now comes from independent authority projections rather than the failed origin database. The snapshot has a 30-second maximum, cannot outlive an authority lease, immediately invalidates on known revocation/observer failure, and cannot refresh itself. Origin-worker failure and policy-authority failure have opposite explicit tests: actual mocked-network notice versus suppression. Dequeue checks remain load-bearing during paced fan-out; the existence of a previously queued permit does not authorize stale delivery. This closes the correlated lookup gap without allowing origin evidence or a cached permit to grant destination permission.

Wire immutability, ASP freshness, same-message user-account authorship, server receipt correlation and uncertain-claim holds remain intact. No new defect found in the changed contract.

## LESSONS-AWARE

**DESIGN: 0. PRECISION: 0.**

Round-10 D1 is resolved: failed browser canaries hold writes and update health immediately, then run at most one safe fresh-process/reload and read-only recanary before escalating. The recovery cannot send or replay messages. Its attempt/attention latch and episode brake prevent repeated failed writes or process restarts from becoming a repair loop. This meets P22's heal-before-notify trigger without handing recovery receipt or resend authority.

Rechecked P19/P22/P23/P24 and L5 against the actual fresh-worktree self-action governor/policies and prior attention-routing evidence. Reusing bounded admission/lifecycle machinery does not excuse the feature's own one-attempt latch; the spec requires both. Hub coalescing, explicit incomplete notification coverage, authority-snapshot expiration and the public-MTProto migration trigger preserve the relevant lessons. Implementation must still establish these actual bindings and activation controls; this review does not claim deployed behavior.

## Counts and scope

Combined: **0 DESIGN, 0 PRECISION**. This is one design-quiet review round for these perspectives, not aggregate convergence. All prior findings retain their original classifications. Conformance round 11 checked 90 standards, zero findings, not degraded. Justin's explicit hold-and-notify authorization remains controlling. No source/runtime edits, external messages or browser sends performed.

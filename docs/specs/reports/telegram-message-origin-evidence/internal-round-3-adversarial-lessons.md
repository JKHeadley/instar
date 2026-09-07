# Round 3 — Adversarial and lessons-aware review

Reviewed the entire revised Telegram Message Origin draft and rechecked the ASP signer/classifier contract. This report changes no runtime or source implementation.

## ADVERSARIAL perspective

### R3-AL1 — DESIGN — Renewed tags and receipt-bound companions cannot satisfy the currently immutable plan contract

The new signature-freshness and captionless-carrier contracts are useful behavioral resolutions, but their execution is inconsistent with the existing sealing rules. The draft requires all permitted variants to be signed before handoff, commits the complete immutable plan before execution, includes variant/plan digests in the immutable origin attestation, and requires egress to dispatch only the exact serialized stored child. Contract 15 subsequently renews the timestamp/nonce/signature; that changes serialized bytes and therefore the variant digest. Contract 16 generates the companion's receipt-binding body only after content has been delivered; the returned message identifiers cannot be known in the pre-signed complete plan. Recording an audited signing attempt alone neither authorizes the new wire digest nor makes it match the frozen plan. A conforming strict egress rejects both paths; a permissive implementation risks creating the arbitrary replacement-body seam the first review closed.

Fix: specify a closed, typed derivation/sealing mechanism for these two cases. The immutable origin/parent may authorize only a signature refresh over an unchanged canonical body and/or a carrier template populated from validated child receipts. Before the derived child is dispatched, durably seal its exact rendered payload, signature, receipt dependencies and digest in the same execution authority. Bind that child to the immutable origin and authorized derivation without rewriting the original origin attestation. Preserve existing child delivery identity, attempt ceiling, deadline and possibly-accepted prohibition across renewal. Arbitrary body/destination/display changes must remain impossible. Test stale-signature renewal and receipt-generated companions through the real digest-checking egress, plus mutation of a non-permitted field.

Other resolutions checked: unchanged ASP freshness plus a shorter dispatch deadline honestly handles offline signer loss; mandatory hidden-display security carriers now have a specified receiver-verifiable binding; one credential-owner outbox with inert evidence mirrors eliminates the proposed multi-sink execution authority; Tier 1 consult has no retry or receipt-classification authority. I found no additional adversarial design defect in those decisions beyond how the two dynamically generated signed payloads enter the immutable wire plan.

## LESSONS-AWARE perspective

### R3-AL2 — PRECISION — Failure summary still states a stronger availability guarantee than the new outbox rule

The paragraph immediately after recording fallback says: "Only when no durable sink can acknowledge preparation is a new send held as audit-unavailable." The preceding paragraph correctly adds a separate mandatory hold when the sole credential-owner outbox cannot admit or claim. The final architecture already makes that choice, so this is a wording conflict rather than a missing new mechanism.

Fix: distinguish evidence-unavailable and execution-outbox-unavailable in the summary, and state that a healthy evidence sink alone cannot keep sends live if the execution outbox is unavailable. Preserve the intended rule that origin-store failure alone is survivable when the execution outbox remains writable. This avoids the evidence-mirror fallback being read as a solution to all local persistence failures.

Lessons engaged: P20 (state versus symbol), P8 (honest failure/recovery behavior), B22 (one complete lifecycle), and the documented reachability collision. Previous queue-retention, timeout, typed-outcome and supervision findings remain resolved. No additional lessons-aware DESIGN finding.

## Counts

DESIGN: 1. PRECISION: 1. The new permitted late-bound signature/carrier operations need an explicit plan-sealing lifecycle; this is a design change and resets the quiet-round counter.

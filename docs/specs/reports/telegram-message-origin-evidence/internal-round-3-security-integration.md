# Round 3 — Security and Integration/Deployment

Reviewed the updated proposed `docs/specs/telegram-message-origin.md`. This is a specification review, not an implementation/deployment assessment. Two residual correctness issues remain: one DESIGN and one PRECISION.

## SECURITY perspective

### Earlier findings

The explicit security companion now supplies a cryptographically bound carrier for captionless operator-account content independently of cosmetic display. Separate machine attestation, scoped preparation credentials, managed browser isolation, operator-only audit reads and key lifecycle remain adequate proposed contracts. The late-arriving carrier introduces the ordering issue below.

### S3-1 — DESIGN: Original content can be classified as operator-authored before its security companion arrives

Anchor: binding contract 16 creates the signed receipt binding only after concrete content receipts exist, then sends the companion. It specifies the honest partial outcome if that second step fails, but not how the receiving agent handles the already-visible original in the meantime.

Concrete current behavior: `src/core/agentSignatureProvenance.ts:276` classifies untagged input as `human`. Thus a captionless or uneditable operator-account operation can arrive unsigned, pass through the receiver's ordinary inbound classification and be interpreted as operator-authored before a delayed companion arrives. A later audit correction cannot retract any actions already taken on that classification. A permanent companion failure leaves this gap open indefinitely; reporting partial delivery on the sending side does not close it.

Required fix: add a receiver-side admission protocol that establishes pending agent-origin evidence before such original content can be dispatched as human/operator-authored. State how a receiver recognizes and holds the exact pending operation, how a receipt binds and releases it, and what happens on missing/out-of-order/failed companions. No prose/style heuristic may grant operator identity. If the supported receiver cannot provide this protocol, mark these specific operator-account operation forms unsupported before dispatch; do not claim that a post-content companion alone preserves ASP's identity boundary. This does not require withholding unrelated human messages.

Required controls: delay companion delivery while the original arrives, crash after content acceptance, companion permanent failure, and companion-before-original reordering. Assert that no original is promoted to operator authority before verified classification, and that unrelated genuine human traffic remains reachable.

## INTEGRATION/DEPLOYMENT perspective

### Earlier findings

The credential-owner's single outbox resolves the earlier distributed selection ambiguity: mirror evidence records are inert and cannot claim or execute work. Explicit ASP freshness/renewal-or-hold resolves the six-hour recovery versus 15-minute verifier incompatibility without weakening inbound replay rules. Rolling activation, immutable redrive, distinct-origin dedup and audit retention fixes remain present.

### I3-1 — PRECISION: Define authorized late-bound child materialization without mutating the sealed parent plan

Anchors: contracts 3–5 seal the complete plan/variant digests and exact serialized request; contract 15 permits later nonce/timestamp renewal; contract 16 builds a companion body containing platform message IDs that cannot exist until preceding content has been delivered. The prose still says to sign every permitted variant before handoff. A literal implementation either cannot create the necessary companion/renewal or modifies fields protected by the immutable plan contract.

Required fix: distinguish the immutable parent template and bounded derivation rules from the later immutable concrete child/variant. At preparation, reserve the exact child role, destination, content relationship and authorized late-bound fields. After a verified receipt or authorized signature renewal, append a separately attested concrete child/variant linked to the original envelope digest; durably record it before its first dispatch. Egress then verifies that concrete child. No unrelated content/destination mutation is allowed, and the originating envelope remains unchanged. Clarify that the credential-owner broker's specified attestation capability, not an unavailable original host, authorizes receipt-bound companion materialization. Update the blanket pre-sign-before-handoff wording to match these two explicit exceptions.

Required controls: create a companion after a real content receipt and renew an expired tag without changing the parent digest; then attempt to alter an unrelated body/destination field through the same materialization path and verify refusal. Recovery must discover and reuse an existing concrete child rather than minting a duplicate after a crash.

## Result

No additional defects found in these two perspectives. The two issues above concern the proposed contracts' correctness and ordering, not the absence of code. No runtime files were edited and no external messages were sent.

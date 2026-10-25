# Round 2 — Security and Integration/Deployment

Scope: proposed design in `docs/specs/telegram-message-origin.md`; no runtime, implementation, or convergence claim. Reviewed the revised draft and the existing ASP verifier. Three residual issues below; the first-round fixes otherwise close the reported design gaps at specification level.

## SECURITY perspective

First-round disposition: session-credential scope/incarnation/revocation, authenticated origin-envelope binding, managed-browser isolation, distinct ASP versus origin-attestation roles, and operator-scoped audit authorization are now concretely specified. They require implementation and tests later; absence of implementation is not itself a draft defect.

### S2-1 — DESIGN: ASP has no defined carrier for hidden-display captionless operator-account operations

Anchors: draft lines 87 and 91. Captionless media and uneditable forwards get a linked attribution companion only when display is enabled, while operator-account operations must preserve receiver-verifiable ASP independently of display. The private origin attestation cannot substitute for the agent-versus-human distinction in the Telegram receiver. A captionless/uneditable operation has no signed receiver-visible body under the current plan.

Fix: explicitly distinguish cosmetic origin companions from mandatory authorship carriers. Define a supported ASP carrier and receiver join for these operator-account operations (including binding to the actual media/forward identity), or declare those specific operator-account operation forms unsupported before dispatch until such a carrier is implemented. The existing unsigned bot operation can remain a separate capability; do not silently use a cosmetic companion's absence as permission to omit ASP. Add hidden-display captionless-media and forward tests proving the receiver still classifies authorship, or a deterministic pre-dispatch unsupported result.

## INTEGRATION/DEPLOYMENT perspective

First-round disposition: rolling storage/writer/lifeline/peer activation and legacy pending work are covered by contract 14; immutable redrive is contract 7; content-only dedup is contract 6; retained audit versus queue cleanup is contract 11. Snapshot freshness remains honestly disclosed and fresh-main grounding remains mandatory. These fixes resolve the prior findings as proposed contracts.

### I2-1 — DESIGN: Pre-signed ASP variants expire before the proposed delivery recovery deadline

Anchors: draft line 91 signs every variant before handoff; contract 11 allows six hours of recovery. Existing `src/core/agentSignatureProvenance.ts:54` sets `DEFAULT_MAX_AGE_SECONDS = 900`; verification at lines 285–286 rejects older tags as stale. Thus an operator-account message known not delivered until minute 16 can retain perfectly immutable bytes yet fail authorship verification when recovery finally succeeds. The current tests promise ASP survives retries without specifying this case.

Fix: include signing freshness/expiry in the prepared variant. Permit transmission only while the receiver's freshness contract can accept it. After expiry, obtain a narrowly scoped fresh delivery-signature variant for the same immutable content/origin from the owning signer, with a new nonce and an append-only variant record; if that signer is unavailable, return signing-unavailable/hold rather than dispatching a predictably stale tag. Alternatively choose an explicit shorter retry deadline for these operations. Do not extend the global replay window as an incidental workaround. Test known non-delivery beyond 15 minutes, signer unavailability, and clock-skew boundary behavior.

### I2-2 — PRECISION: Fallback preparation must be explicitly non-executable until durable authority selection

Anchors: line 99 separates preparation from exclusive execution and allows ambiguous preparation copies; contract 5 at line 127 instead says to atomically commit origin, plan and executable outbox admission. If an initial sink commits but its acknowledgement is lost, fallback preparation can create a second outbox. Both stores can locally satisfy claim CAS; the statement that they use the same selected authority does not say how that selection survives caller crash.

Fix: distinguish inert prepared replicas from executable admission. Persist an immutable selected-authority record/certificate and require its validation at claim time; only its selected sink may admit executable children. No sink may infer selection from possessing a prepared row. If authority selection or claim acknowledgement is uncertain, preserve inert/unknown state and reconcile rather than selecting another executor. Clarify where selection is durably recorded and how recovery discovers it; align the atomic-commit sentence with that sequence. Test first-sink commit with lost acknowledgement, fallback commit, caller crash, and concurrent recovery from both stores.

## Result

Two DESIGN residuals and one PRECISION residual remain. No further issues from these two perspectives were found in the reviewed draft. The explicit invariant validators remain compatible with the hard-invariant exception in `docs/signal-vs-authority.md`; the bounded recovery supervisor does not acquire permission to manufacture delivery evidence.

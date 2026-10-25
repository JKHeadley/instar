# Round 2 — Adversarial and lessons-aware review

Reviewed the revised `docs/specs/telegram-message-origin.md`, the previously read lessons catalog and relevant memory, and the actual ASP signer/verifier. No runtime changes or external messages.

## ADVERSARIAL perspective

### R2-AL1 — DESIGN — Hidden display leaves captionless operator-account sends without an ASP carrier

The revised presentation contract permits attribution companions only when display is enabled and promises hidden-display sends no cosmetic companions. The ASP contract simultaneously preserves required operator-account authorship, but ASP v1 authenticates a text body with a final-line tag (`src/core/agentSignatureProvenance.ts`, `splitTag`, `signMessage`). Captionless messages, stickers and uneditable forwards do not have a body where the broker can append that tag. A hidden origin attestation stored in an operator-only audit is not the inbound ASP tag consumed by the existing verifier. The broker therefore has no specified compliant action for this combination; treating absence of a tag as normal reaches the verifier's `classification: human` branch.

Fix: distinguish mandatory authorship carriers from cosmetic origin display. Specify a concrete mandatory ASP companion protocol for these operation types, with receiver-side binding to the content/operation it attributes and unambiguous initiating-agent versus forwarded-author roles. It must remain enabled when cosmetic display is off. If the existing ASP protocol cannot support a type without modification, refuse that operator-account operation explicitly until the carrier/verifier support is installed; do not declare that transport/type fully compliant. Add hidden-display captionless/forward tests through the real receiver classifier.

Other first-round adversarial resolutions: immutable egress plan loading and complete wire binding address the substitution finding; existing CAS/fenced claims now own execution; truthful unknown coverage has positive controls; dedicated broker profile ownership is a concrete authority boundary within the declared non-hostile-OS trust model. Signed fallback preparation addresses missing origin keys, subject to the freshness finding below.

## LESSONS-AWARE perspective

### R2-AL2 — DESIGN — Pre-signed retry variants expire long before the proposed retry deadline

The revised ASP contract signs all normal/fallback variants before handoff so an offline origin's relay can retry without its key. The capacity contract allows six hours of automatic recovery. Actual ASP v1 has `DEFAULT_MAX_AGE_SECONDS = 900` (`src/core/agentSignatureProvenance.ts:54`) and rejects a tag when its timestamp differs from verification time by more than that window (`verifyMessage`, freshness branch). A valid queued message first delivered after 16 minutes therefore fails authorship verification even when its body, origin and transport receipts are all correct. The original session/host may already be unavailable, so re-signing at retry is precisely the capability the new variant design avoids requiring.

Fix: explicitly reconcile signing freshness with durable delay. For example, choose an ASP-capable delivery deadline within the actual verifier window (including clock/processing allowance) with signing-unavailable/expired handling and a bounded refresh path when the owning signer remains available. Alternatively specify and review a versioned deferred-delivery attestation/verification protocol with its corresponding replay-retention contract. Do not silently widen or disable ASP freshness or stamp future times into pre-signed variants. Test first delivery and fallback beyond 15 minutes, including origin-host loss and replay rejection.

Lessons engaged: L5 (external-state/parser contracts need live controls), B22 (own the complete lifecycle), P4 (semantic boundary tests) and P20 (a stored signature is not proof the current receiver will accept it).

Other first-round lessons resolutions: typed receipt outcomes distinguish 200 suppression from delivery; pre/post-dispatch timeout phases and script guidance migration address the retry hazard; retained tables are separated from queue cleanup; Tier 1 uncertain-result supervision is now explicitly wired and bounded. Primary/spool/peer fallback engages the reachability collision, with the all-sink limit stated honestly rather than claimed as normal reachability.

## Counts

DESIGN: 2. PRECISION: 0. Both findings change observable behavior or protocol support and must reset the design-quiet counter.

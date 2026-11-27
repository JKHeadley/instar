# Decision Completeness Review — Round 1

Verdict: **Not yet builder-complete.** The access boundaries and first-increment scope are clear. The following contracts still require decisions before independent builders can produce compatible behavior. This review read the spec, conformance report, and current receipt implementation. No code changes or test suites were run.

## Material Findings

1. **DESIGN — Freeze the wire and stored projection schemas.** The input is exact, but the normalized stored reference, readable quote output, unavailable output, `replyMirror` values, and link success/not-linkable/error bodies are described only in prose. Define literal field names, enum values, null/absence behavior, and applicable HTTP statuses. Specify whether previews expose the normalized source ID and which sender/attachment fields survive. An app and server built independently would otherwise disagree about successful versus unsupported actions.

2. **DESIGN — Specify receipt v3 signed bytes and persisted fields.** Existing receipts use domain-separated newline payloads (`receiptPayload` and `receiptPayloadV2`). The new version lists semantic inputs but does not freeze its domain separator, canonical serialization of the normalized reference/null, persisted receipt shape, or destination normalization. Define those bytes and the validation dispatch for absent/v1/v2/v3 and unknown versions, retaining the existing signing algorithm and key history. Otherwise two valid implementations can reject each other's replicated records.

3. **DESIGN — Gate quote projection on quote-proof validity, not only original ACL.** The spec requires verification to fail on altered metadata but does not state which quote DTO is exposed when base text remains readable and quote binding is failed or unknown. Explicitly require unavailable quote output until the reference has acceptable v3 evidence, and retain the independent original-message ACL check. Define the origin verdict when private proof fields are stripped, so a downstream holder cannot treat a preserved verdict alone as authority to project a quote.

4. **DESIGN — Define the recoverable representation after an old codec strips metadata.** If both the reference and v3 marker disappear, the surviving base record is indistinguishable from an ordinary historical unquoted record; it cannot reliably emit the promised quote-unavailable state. Select a concrete compatibility representation/protocol and actual-old-codec merge rule that preserves evidence of the committed relation, or explicitly delimit what can be known after total evidence loss. Define precedence for full versus stripped copies in both arrival orders and rebuild. Do not derive authoritative linkage from an old ignored request-body field. This overlaps the conformance report's committed-metadata custody finding.

5. **DESIGN — Freeze reserved quote custody and replay dispositions.** “Replay the exact reserved reference” does not identify which normalized reference/proof/provider-target facts are in the durable operation, when receipt v3 is fixed, or how recovery proceeds when the original disappears or signing identity changes after reservation. Define the saved operation fields and whether recovery holds/fails without appending, or appends the fixed relation with unavailable mirror after fresh authority checks. Also define whether an exact completed retry returns its original `replyMirror` outcome or a fresh measurement. This changes append and provider retry behavior, not merely wording.

## Bounded Lookup Decision

The spec's bounded history reader cannot establish absence of a known older message merely because it lies outside the first page. Define a bounded exact-ID lookup with explicit unavailable versus absent outcomes, or a concrete admitted continuation policy. This is **DESIGN**, already independently raised by conformance; permission remains deterministic. The request-local cache must not authorize a different public witness.

## Precision Only

The introductory handoff vocabulary and parent-principle fit explanation are **PRECISION** for this server increment. Native action placement belongs to the app owner; this review does not add UI scope, forwarding/deletion, or a new operator approval request.

## Counts And Fixed Limits

There is no explicit Frontloaded Decisions inventory yet. The six “Decision points touched” bullets are topic groups, not resolved schema/protocol decisions. Do not report them as six completed frontloaded decisions. Cheap-to-change-after and contested-decision counts cannot honestly certify completeness until the material contracts above are resolved and inventoried.

Fixed-limit contest: the referenced history-page bound is useful for resource admission, but is not evidence of source absence. Counterexample: an authorized exact source lies one page before the loaded window. Reject using that limit as a final 404 rule. Existing identifier/preview/request limits are inherited rather than new numerical choices; no additional timer, quota or soak period is proposed.

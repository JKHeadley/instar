# Lessons And Experience Fit — Round 1

Read-only source review; this report is the only file written. No source changes or tests.

## Material Findings

1. **DESIGN — Exact identity lookup versus a history-page boundary.** A known original outside the current bounded history page is not proven absent or forbidden. Use the existing store/provider exact-ID path with current per-message authorization, distinguishing lookup uncertainty from confirmed absence internally while retaining the non-disclosing response. If no exact-ID seam exists, specify bounded continuation through existing readers rather than accepting the first page as absence. This changes no access floor and requires neither a model authorization decision nor an unbounded scan.

2. **DESIGN — Exact-link opening must drive its own lookup.** Copy Link already identifies the exact conversation and message. Requiring repeated Keep looking presses shifts mechanical lookup onto the reader. Reuse the current locator and automatically continue within existing admission budgets, with explicit loading, continuation and unavailable states. No second locator subsystem is needed. Prove opening an old-message link reaches the actual message across more than one page without repeated manual search.

3. **DESIGN — Make mixed-codec loss claims exact.** The older codec allowlist excludes the new reference, and first-arrival duplicate suppression does not necessarily repair a stripped event when a full copy arrives later. Test both arrival orders, restart and rebuild. A base message surviving is not evidence that its quoted relation survived. Missing relation/proof must remain unavailable; retained v3 proof contradicting metadata must fail verification. Revise rollback wording that says originals/references are preserved if the actual compatibility path can erase them. Explicitly disclose that legacy relays or a sole surviving stripped replica may permanently lose quote metadata. No companion store, receipt quorum or origin-offline recovery subsystem is required for this bounded increment; do not claim those guarantees.

4. **DESIGN — Decision classifications are missing.** The Decision points section describes rules but does not classify each as invariant with justified basis/evidence or judgment-candidate with floor and arbiter/argued exemption. Add the existing skill-required classifications. Exact identity, signature binding and current ACL are legitimate deterministic floors; no language model is needed to adjudicate an exact readable message ID.

## Conformance Dispositions

- Bounded-page false absence: accepted, finding 1.
- Selective metadata loss on older replicas: accepted as an honesty/compatibility correction, finding 3; not grounds for an unlimited replication redesign.
- Manual Keep looking for an already identified target: accepted, finding 2.
- Internal handoff opening: PRECISION. Explain today's behavior, the new Reply/Copy Link result, and the app/server ownership before internal identifiers.
- Operator-Surface Quality weak fit: advisory, not a blocker. Correct selected-message targeting, clear unavailable states and automatic exact navigation are meaningful server-side contributions to that principle. Observation Needs Structure supports durable reference custody. Native menu placement and usability remain the app owner's responsibility and require evidence.

## Foundation Audit

The audit reaches the App replication codec and existing locator beneath the new routes. The current codec's explicit field allowlist (`src/core/AppConversationsReplicatedStore.ts`) does not preserve arbitrary optional fields. Therefore ordinary message survival cannot prove quote survival. The existing history-page and locator budgets bound work, not the set of messages a reader is authorized to reference. Reusing those foundations requires the loss and lookup distinctions above rather than treating their current behavior as proof of correctness.

## Experience Fit

**Source and stated outcome:** Justin requested Telegram-style Reply and Copy Link on selected messages; the Chief assigned reply, forward, delete and links under standing authorization. This increment delivers quote/link only and keeps the overall card open for forward/delete.

**Contrasting cases:** a readable selected original yields the correct preview and exact link; a private or deleted original yields unavailable without source metadata; an older readable original is located without treating the first page as proof of absence; unavailable provider linkage is distinguished from successful ordinary dispatch; a stripped legacy record retains its readable base without a fabricated quote.

**Evidence limits:** API success alone does not show that Reply selects the intended message or that opening a copied link scrolls to it. Require actual native-build and deployed user-channel proof, including an older message beyond the first history page and an unreadable-original case. Previous-codec tests establish compatibility behavior, not universal metadata durability.

**Disposition:** proceed under existing authorization once material corrections are incorporated. No redundant approval is warranted absent a wider audience or new authority. Keep unsupported actions explicit and do not close the full card after this first increment.

## Fixed-Limit Contest

No new independent numeric quota was found. Existing identifier/schema bounds have an enumerable protocol basis. Current ACL, same-conversation identity and signature binding are genuine floors; no legitimate within-scope counterexample was found. Existing history-page limits are valid work budgets but are not a legitimate final absence/authorization rule: an older readable message is the counterexample. Preserve bounded work with continuation rather than expanding those limits or denying the action arbitrarily. Bounded previews limit disclosure/display content rather than message eligibility.

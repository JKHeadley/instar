# Security Review — Round 1

Verdict: No material security DESIGN findings. Read-only source inspection; this report is the only written artifact. No tests or suites run.

## Grounding

Reviewed the draft and live conformance report against `src/core/AppRecordSignatures.ts`, `src/server/mobileConversationRoutes.ts`, `src/server/mobilePairingRoutes.ts`, `src/core/messageLinks.ts`, and `dashboard/console/chats-model.js`. Existing receipts bind canonical request hashes; Slack v2 additionally binds canonical destination because its signed path carries a local alias. Existing verification compares signed text/attachment projections. The proposed v3 must extend these checks rather than infer authority from reference shape. Current device sync already removes internal origin/receipt objects, making the proposed proof-side-channel restriction consistent with the existing DTO boundary.

## Security Assessment

The specified same-conversation exact original lookup, independent original ACL, actor revalidation across awaits, v3 destination/reference binding for both exact and redacted bodies, and explicit stripping of hidden proofs close the reviewed authorization and signature-side-channel boundaries. Provider linkage requires real physical identity and preserves routing. A copied link confers no access, and the exact device route leaves the broad agent-only link route unchanged. Older stripped evidence cannot authorize a fabricated relation; fully retained mismatched v3 evidence must fail. No additional security DESIGN change is required.

## Conformance Inputs

The bounded-history flag identifies an availability distinction worth resolving: a message outside a page is not proven absent. Existing App storage supports exact `getMessageEvent(conversationKey,messageId)` lookup; providers must distinguish lookup unavailability from established absence without expanding ACL. This is an existing conformance finding, not a separate security escape.

Old-codec loss is explicitly disclosed as unavailable metadata while preserving readable base content; it does not justify reconstructing authoritative references from ignored historical body fields. Actual prior-codec arrival/rebuild probes remain necessary before implementation claims. Keep-looking and introductory language flags concern navigation and documentation rather than weakened security authority.

## Precision

When implementing the DTO rule, keep stripping the entire private origin/receipt proof objects as current sync does. Merely deleting a direct `replyTo` property while retaining signed body bytes or reference-bearing receipt fields would not satisfy the specified no-leak invariant. No cosmetic change requested.

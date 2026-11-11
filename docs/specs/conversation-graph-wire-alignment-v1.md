# Conversations wire alignment, increment B/C

Status: implementation clarification for review; not deployment acceptance or a new operator approval. The reviewed v3 and its actual approval provenance remain unchanged.

## Item layout

Use the current typed Item shape: `ref`, `kind`, `title`, `role`, `primaryPath` and `visibleChildCount` are top-level fields. `source`, when available, retains the existing flat list's exact conversation id type/value and machine. Response refs are NodeRef objects; route refs alone are canonical JSON encoded as base64url.

An effort has `metadata: {frontDoor: ConversationRef}` only when the server certifies that choice from its all-member verified final-certificate union and the viewer can see it; otherwise its metadata is `{}`. A conversation has no metadata key. There is no separate eligibility/certification flag. Path, role, order and recency never manufacture a front door. A screen with replica-lag remains partial and must not claim every device is caught up.

This resolves the illustrative v3 §7.5 example's nesting of count/path without changing their semantics: those two fields stay viewer-filtered and move to the typed Item's top level. Section7.5 explicitly calls its examples illustrative. The later definitive front-door contract reported by Dawn at00601f1236b9 specifies empty effort metadata when there is no visible certified choice and no conversation metadata; that rule is retained exactly. The root's unchanged local backend capture and AgentServer tests exercise this implementation. They are synthetic local evidence, not live integration or proof that Dawn's reported branch was deployed.

Clients may retain their existing decoder fallback for older provisional fixtures. Newly captured fixtures and this server's responses use the canonical top-level fields. No client should add metadata to conversation rows or infer permissions from the compatibility fallback.

## Correction identity

Observed placement/front-door heads are raw graph event IDs from the authorized correction envelope. A returned eventId/operationKey such as `graph-event:change-UUID` is a qualified operation identity for status/cancel; it is not an observed graph head. Preserve a request's UUID and frozen body through uncertainty. A stale cursor is409 and restarts page1; it is not a successful empty page.

This note does not authorize route activation, source-backed attention, digest, native release, cloud resources or weakening increment-A acceptance. Those remain their own gates.


## Source-owner projection-layout clarification (2026-11-06)

The current owned-custody handoff and actual captured roots/node bodies use **top-level** `role`, `primaryPath` and `visibleChildCount` on each Item. `metadata` is effort-only: `{}` or `{frontDoor: ConversationRef}` with field presence as the certified-and-visible signal. Conversation Items carry no metadata key. Clients may retain the older nested-layout decoder as compatibility, but producers use the top-level layout. This reconciles the older v3 example with Dawn's later definitive effort-only front-door semantics; it does not change source authorization, NodeRef objects, cursor rules or any acceptance gate.

Evidence: `ProjectionItem` and the projection builder in `src/core/conversationGraph.ts`; unmodified `native-owned-local-wire-capture-with-phone-write.json` roots/node Item keys. This is a source-owner clarification of the existing captured interface, not new operator approval or production/runtime acceptance.

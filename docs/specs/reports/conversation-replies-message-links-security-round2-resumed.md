# Security Review — Round 2 Resumed

Model disclosure: inherited Codex reviewer. No Claude execution or model-family diversity is claimed. This is an independent read of the proposed design and existing source, not implementation approval. No tests, source edits, external calls or peer messages were performed.

## Verdict

Two material DESIGN findings remain: the new quote preflight must preserve the existing semantic emergency-stop authority, and the proposed missing-append recovery needs an explicit recoverable representation or the existing no-append disposition. The typed App selection, v3 reference binding and private-source projection requirements otherwise address the reviewed round-one security boundaries.

## Findings

### S2-1 — DESIGN · High · Quote preflight can prevent the existing stop authority from seeing a non-exact emergency stop

**Source evidence.** The draft's Reservation, Recovery And Stop section requires current original visibility and a real quote signer before ordinary quoted admission, but grants priority only to an *exact* emergency stop (spec lines 40–46). `src/core/MessageSentinel.ts:432–435` intentionally recognizes only enumerated exact phrases structurally. Its `dispositionFor()` also accepts model-classified `emergency-stop` as `kill` (`:573–584`), and explicitly explains why non-exact messages must route through rather than be guessed away (`:423–430`). The actual App route invokes this existing authority at `src/server/mobileConversationRoutes.ts:1142–1154`; its exact fast path is separate at `:1125–1133`.

**Counterexample and consequence.** An authenticated owner submits a text-only quoted reply containing a genuine stop paraphrase that the existing sentinel would classify as `kill`, while the selected original has become unavailable or the machine signer is missing. The new early quote refusal ends the request before the established semantic authority sees it. The session can continue its side effects. This is not a request to widen `isExactStopMessage`, add a substring rescue, assume that every paraphrase is a stop, or drop a normal reply reference silently.

**Concrete resolution.** Preserve the enumerated exact fast path. Specify how the already-authenticated request reaches the existing sentinel's single disposition authority before any *new quote-only* source/signer refusal, using the same scope and idempotent urgent operation. A genuine authority-returned `kill` must execute through the existing stop path independently of quotation admission; route-through remains subject to all strict quote checks and cannot become an unquoted ordinary send. Retain the existing policy for pause and classifier failures rather than inventing another detector authority. Freeze the retry result for the urgent exception. Test both an authority-classified non-exact kill with missing original/signer and a negated or ordinary reference to stopping that must not kill. A classifier refusal/error must never be silently converted into authority to append an unquoted ordinary message.

**Conformance contest.** The second conformance flag is substantiated by these distinct existing exact and model-classified paths; it is not accepted merely because the checker emitted it.

### S2-2 — DESIGN · Medium · Missing-append recovery is not defined by the actual durable reservation

**Source evidence.** The draft lists reference, actor key, destination, accepted origin bytes/redaction, timestamp and fixed v3 receipt in the reservation, then says recovery may “finish the same durable append” (spec lines 40–44). In the current implementation `src/core/MobileChatRequests.ts:30–35` explicitly stores operation details and never message text. The actual send reserves only `op`, `conversationKey` and `messageId` at `src/server/mobileConversationRoutes.ts:1043–1051`. `AppConversationService.recoverStranded()` treats a missing stored send message as `not-delivered` and never reconstructs or redispatches it (`src/core/AppConversationService.ts:1009–1041`). Exact signed bodies and redacted bodies are materially different: `verifyRecordedOrigin()` uses retained body bytes for exact text but only a hash plus redaction attestation for redacted text (`src/core/AppRecordSignatures.ts:299–318`). The redaction proof cannot reconstruct the sanitized stored text/attachment projection.

**Counterexample and consequence.** A redacted quoted media send crashes after reservation but before message append. A fixed receipt and body hash do not supply the complete sanitized message/attachment witness needed to finish that append. Independent builders could either regenerate with the current signer/source, append an incomplete candidate, or refuse. The first two would break fixed-proof custody; the last is safe but is not the draft's promised recovery behavior.

**Concrete resolution.** Prefer retaining the existing explicit disposition: missing append becomes the durable original `not-delivered` result; an existing append with uncertain downstream delivery remains unknown and is never redispatched. If append completion is required instead, enumerate a complete immutable *sanitized* candidate (all stored text, attachment metadata, origin/redaction, fixed receipt and selected reference) in the existing reservation, explicitly describe this new private-text custody/retention, and name its revalidation path. Never persist removed raw credentials to make reconstruction possible, replace the admitted actor, regenerate proof under a new signer, or replay provider effects after ambiguity. Test a real request-store restart between reservation and append with redacted media and key rotation, plus the existing-append/unknown-provider case. This is a real recovery contract decision, not a new recovery service request.

## Round-One Boundaries Rechecked

- App input selects `replyTo.eventId`; the server derives the public identifier from the same decoded witness. This is consistent with the approved-source sibling branch's `readMessageTarget(..., 'event')` and prevents a shared public ID from redirecting selection. The sibling source is a prerequisite, not asserted to be merged.
- The v3 domain separator, complete normalized reference, actual destination and canonical request hash now have concrete signed bytes. Unknown versions cannot silently fall through to old receipt verification. Existing v1/v2 behavior is explicitly retained.
- Quote evidence is not self-authorizing: its complete witness must match the immutable base and pass actual ledger/historical-key checks. Conflicting valid relations remain unavailable, and evidence does not become a message/unread item.
- A readable reply does not grant original access. The current-reader projection removes original IDs, text, author, filename and entire nested proof objects when source access is unavailable. This addresses the signed-body side channel, not just the direct `replyTo` property.
- Reopen/focus/actor-change invalidation now addresses a cached preview surviving ACL revocation without another reply event. Native proof is still required; source prose is not evidence the cache already obeys it.
- Confirmed absent and forbidden are masked identically after conversation admission. Bounded lookup exhaustion is unavailable, not established absence. Provider originals must remain physical-message identities in the actual destination namespace.

## Other Conformance Inputs

**Mixed-version custody:** no additional security DESIGN finding from that flag. The draft now preserves complete v3 evidence when it actually arrives, forbids fabricated relation recovery from ignored old body fields, and explicitly admits total old-codec loss cannot be detected from a stripped base alone. That is a disclosed durability limit and separately tracked proof-substrate gap, not permission to reveal or invent an original. It must not be marketed as complete fleet/offline relation durability. Cross-machine graduation remains the owning review's concern.

**Suite concurrency and maturation:** no separate security finding. These checker observations concern resource coordination and release evidence. They do not weaken the enumerated identity/signature/ACL floor, nor authorize a competing test run. No suite was started by this reviewer.

## Precision

No additional PRECISION-only correction is requested. The issues above change admissible urgent behavior and recoverable state, so neither should be relabeled cosmetic.

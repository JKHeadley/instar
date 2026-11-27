# Quoted Replies: Boundary Fixtures For The Next Owned Increment

Status: draft acceptance inventory, not implementation, approval, executed tests or release evidence. Owned by topic 145738 and card wc_4d8dd0e0144b636e. Source draft: docs/specs/conversation-replies-message-links.md. App exact-message links have since been extracted to docs/specs/conversation-message-links.md in feat/app-message-links; the older combined draft's link response shape must not override that approved contract.

## Existing Reusable Seams

AppRecordSignatures.ts already has domain-separated receiptPayload/receiptPayloadV2, canonicalStringFromHash and verifyMachineSignature with real historical-key lookup. MobileChatRequests.ts reserves operation details with the payload hash in one synchronous step before effects and recovers entered requests across restarts. Extend those existing seams after the reply spec is approved; do not introduce another request ledger or pretend an extra unsigned HTTP send retains the original signed path.

## Fixtures And Observable Boundaries

| Case | Real fixture setup | Required observable result |
|---|---|---|
| Same conversation | Two messages with distinct event and public identifiers; select one exact readable message in the destination. | Stored reply binds the selected normalized reference and signed action path. No copied source text is stored as caller authority. |
| Cross-conversation collision | Same public identifier in another conversation whose text is different. | Resolve only the actual destination namespace; never quote the other conversation. |
| Typed App selection with shared public ID | Two readable App events share a public message identifier; the request selects one exact eventId. | Succeed only for the selected event and retain that eventId in proof/projection/navigation; the public-ID collision cannot redirect the quote. |
| Ambiguous provider identity | Provider lookup cannot uniquely verify the selected physical message in the actual destination namespace. | Reject as unavailable; do not choose a newest or first row. |
| Older original | Original is older than the recent history page. | Indexed actual lookup succeeds; a page boundary does not establish absence. |
| Revoked original | Reply remains readable but the original's current grants are revoked. | Public reply is unavailable without original text, author, filename or private reference. |
| Access changes during await | Revoke/reassign the original admitted actor while media or routing is awaited. | No append or provider admission under the replacement actor. |
| Changed reference, same retry ID | Reserve once, repeat the same request ID with a different reference. | Existing operation hash rejects reuse before effects. |
| Retry after restart | Preserve request reservation, fixed receipt and completed result; restart real request store. | Same immutable result; no second append/dispatch or provider send. |
| Incomplete provider outcome | Provider send may have happened before transport interruption. | Preserve unknown/failed linkage independently of App delivery; no ordinary-message fallback retry. |
| Modified signed relation | Preserve signature and original canonical request; change/remove/add reference or destination bytes. | V3 quote proof fails; v1/v2 historical unquoted verification remains unchanged. |
| Missing signer | New quoted request while actual machine signer is unavailable. | Refuse before reservation effects, append, dispatch or provider attempt. |
| Emergency stop | Authenticated exact stop with missing original and missing quote signer. | Existing stop priority/idempotency applies once; no quoted append and no original disclosure. |
| Stripped then complete | Receive stripped readable base, then complete same-event quoted message through actual duplicate path. | Existing duplicate rules preserve the stored base without enrichment or another message/unread/preview effect. Known quote with unverifiable relation shows "Quoted message unavailable"; total marker loss omits the chip. |
| Complete then stripped | Reverse previous arrival order; rebuild and restart derived index. | Retained original relation is verified against the stored base. No duplicate message/unread/preview effect; availability need not match the stripped-first case. |
| Modified stored relation | Change/remove/add original reference or replying-base IDs without a matching receipt. | No available preview or redirected source; a known admitted quote becomes unavailable. No evidence journal or remote witness merge is introduced. |
| Device sync redaction | Original becomes unreadable while internal proof bytes still contain its reference. | Redact entire private nested proof from public event/pool/notification projections, not just the direct reply field. |
| Unsupported old holder | Send to a holder lacking the dedicated reply action. | Explicit unsupported result; client never retries after dropping the reference. |
| Cached preview after revocation | Close/reopen a cached readable reply after original access changes and without a new reply event. | Clear old preview until current-reader revalidation; offline status never certifies the old quote. |

## Test Placement

Unit coverage belongs beside actual signature, request reservation and store/projection tests. HTTP integration must use real signed device admission and the dedicated action path. A production AgentServer lifecycle test must show the capability and action alive, then preserve retry semantics over the supported restart path. Native quote selection, unavailable-source UI and draft preservation need the actual app owner's proof. Tests must run only through allocated normal admission; none ran for this inventory.

## Design Corrections Before Implementation

The combined draft predates typed App event/message identities and the masked held-source link contract. Reuse the approved App source primitive rather than reintroducing its superseded link DTO or treating a public ID as unique. The draft now fixes App selection to exactly replyTo.eventId and retains the derived exact event in the receipt and available projection; provider selection retains verified physical messageId. Provider quote protocols and immutable receipt/evidence evolution still require their existing spec review; this document grants no authority to change them.

## Narrow Draft Recheck

The contract reviewer found that the initial ambiguous-public-ID fixture contradicted typed App selection. It is now split into successful exact App selection despite a shared public ID and refusal of an unverifiable physical provider identity. The stale open typed-identity decision was removed. This narrow recheck is not full spec convergence, approval or executed test evidence.

## Bounded Compatibility Disposition, 2026-11-23

Chief handoff 39e3e5f6 explicitly accepts older App codec loss as a compatibility limit and excludes durable transferable proof for this increment. The three duplicate/evidence fixtures above now verify ordinary immutable-base behavior and honest unavailability instead of requiring enrichment or arrival-order convergence. Existing v3 signature binding remains required; no weaker identity or access policy is authorized. The current implementation remains absent and no fixture here has run.

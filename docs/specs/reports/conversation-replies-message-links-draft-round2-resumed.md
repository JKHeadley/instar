---
title: Quoted Replies And Exact Message Links
slug: conversation-replies-message-links
author: echo
status: draft
tier: 2
parent-principle: "Operator-Surface Quality"
card: wc_4d8dd0e0144b636e
eli16-overview: docs/specs/conversation-replies-message-links.eli16.md
review-reading-link: https://echo-studio.dawn-tunnel.dev/docs/85932ee3-14ea-4142-93ab-65b9b7005098
single-run-completable: true
frontloaded-decisions: 18
cheap-to-change-tags: 0
---

# Quoted Replies And Exact Message Links

Draft round2 resumed, 2026-11-23. App links are a prerequisite on feat/app-message-links, governed by conversation-message-links.md. This draft is unapproved. Boundary fixtures: reports/quoted-replies-boundary-matrix.md.

## Outcome And Scope

Reply should identify the selected message, and Copy Link should open that exact message. Today App sends lack a checked quote reference, while the agent-only link builder returns an App conversation link. The dashboard already understands a message target. This increment supplies authorized identity and automatic exact navigation.

This is the first increment of card wc_4d8dd0e0144b636e under standing feature authorization, handoff 5f955c7c-c366-44a1-a1aa-4aa925778a73. Forwarding and single-message deletion remain owned later increments on the same open card. The Apple app owner supplies native menus and releases. Source completion and native proof remain separate. Existing conversation/message access remains required.

Operator-Surface Quality governs correct selection and honest source states. Signed references preserve observation. Exact identity and current ACL are enumerable floors, not semantic judgments.

## Exact Signed Reply Paths

Add POST /mobile/chat/app/:key/reply, POST /mobile/chat/:topicId/reply and POST /mobile/chat/slack/:conversationId/reply. Each reuses its corresponding text/media send body. App requires exactly replyTo:{eventId:string}, an opaque stored event identity subject to the approved App source reader bounds. Telegram and Slack require exactly replyTo:{messageId:string}, validated as a real physical provider message identity. The destination and signed action path supply the namespace. Reject caller quote text, author, source-conversation fields, mixed event/message selectors and unknown keys. App never selects by an ambiguous public message identifier.

Ordinary send paths retain existing behavior for old bodies and reject a new replyTo field. Older holders lack the new action path and return unsupported/404. Clients never fall back by dropping the reference. Share internal send logic while retaining the actual signed path; avoid an unsigned second HTTP send.

Resolve the original within the destination's same actual conversation. Preserve Slack channel/thread routing. Telegram requires the correct physical forum/topic and real message ID; a synthetic App ID is not a provider ID. Normalize a server-owned ReplyReference:{conversationKey:string,eventId:string|null,messageId:string}. App derives both the actual eventId and public messageId from the unique selected source event; provider references use eventId:null and the verified physical messageId. Its key is app:<uuid>, the verified physical Telegram chat/wire-topic key, or the existing stable Slack registry key. The request supplies only the ID; destination context supplies the namespace. Verify this key against the destination at admission and projection.

Use exact indexed App lookup and actual exact provider/store lookup. A recent page boundary is not proof of absence. If the existing provider/log reader uses admitted scanning, budget exhaustion is unavailable. Confirmed absent and forbidden receive identical404 without source metadata. Temporarily unmeasurable lookup receives409 {error:"source-unavailable",retryable:true}, after conversation access is checked. Resolve the exact selected witness, not another public message.

## Reservation, Recovery And Stop

Before a new reservation require current send permission AND current original-message visibility. Extend the existing operation hash with reference presence/value. Save normalized reference, original actor key, canonical destination, accepted origin bytes/redaction, receivedAt and fixed v3 receipt in the existing send reservation before first append/provider attempt. Retain existing text, attachment and deterministic message/event ID behavior.

A new quoted operation requires the real machine signer; unavailable signer returns503 before append/dispatch. Recheck actor/source/destination after media/routing awaits and immediately before append/provider admission. Reassignment/revocation invalidates the captured actor.

Retry reuses the fixed reservation across restart/key rotation. Completed retry returns the original immutable replyMirror outcome after current access checks. Recovery preserves existing stranded-send safety: finish the same durable append only with its fixed proof and current authority, and keep ambiguous provider delivery unknown/not-delivered instead of sending twice.

An exact authenticated emergency stop retains existing stop priority and idempotency BEFORE quote source/signer admission. Missing original or signer cannot delay it. Execute the existing stop once, append no quoted message, expose no original, and return the existing stop result with replyMirror not-applicable/emergency-stop. Existing authentication and stop authority still apply.

## Storage And Receipt V3

Message/media-message stores only normalized replyTo; derive original preview/author at read time. Extend verifyRecordedOrigin's accepted paths to the exact reply actions. For App, compare signed input eventId with the selected stored event identity; derive its public messageId from that same decoded source witness. For providers, compare signed input messageId with the verified physical message identity. The machine receipt binds the complete normalized reference, server-derived namespace and actual stored destination.

Receipt shape is {v:3,conversationKey,replyTo:ReplyReference|null,machineId,signerKeyHash,sig}. Its exact Ed25519 payload is the following array joined by one literal newline, with no trailing newline:

    ["instar-app-receipt-v3", sha256(canonicalDeviceRequest), receivedAt,
     machineId, canonicalStoredDestinationKey, canonicalJson(replyToOrNull)]

Use the existing canonicalJson, device canonical request, signer and key-history implementations. Quoted admission requires v3 even with original signed bytes. Redacted bodies retain existing text/attachment redaction proof plus v3 reference binding. The new validator rejects unknown receipt versions as unsupported proof instead of demoting them. Unquoted v1/v2 verification remains unchanged.

Added/removed/changed reference under preserved complete v3 proof, wrong destination/body/signature or physical namespace mismatch fails quote verification. Unknown key history stays unknown. A base origin verdict or historically ignored body field alone cannot authorize a quote.

## Complete Evidence And Duplicate IDs

Preserve immutable base signed events. Add an internal App event kind quote-evidence within the EXISTING appConversations JSONL, derived index and replication transport. Shape: {kind:"quote-evidence",eventId,conversationKey,at,machineId,messageId,witness}. witness is a complete normalized quoted message/media-message, never an evidence wrapper. messageId targets its reply base.

Derive eventId as "quote:" plus SHA256 of "app-quote-evidence-v1" followed by one newline and canonicalJson(witness). at and machineId identify the original receipt's receivedAt and signing machine: this carries its existing attestation, rather than impersonating a new observer action. The deterministic wrapper itself grants no trust.

Observe a complete v3 message BEFORE duplicate-event early return. If a stripped base already exists, retain its text/attachments/origin and append the deterministic evidence event once through existing append/index/emitter paths. Evidence ingestion never derives further evidence. Evidence arriving before its base waits in the same derived index.

Compare recognized immutable base fields, normalizing only newly absent quote/receipt-version fields. Verify candidates with the real ledger/key history before projection. One consistent valid reference enriches display. Conflicting valid base/reference evidence makes the quote unavailable and reports the conflict; it never replaces base text arbitrarily. Invalid/unknown proof cannot become available. Use indexed candidates, request-local verified results and existing admission budgets; unfinished verification remains unavailable.

Both full/stripped arrival orders and rebuild/restart yield the same quote result when complete evidence is available. Evidence advances synchronization/invalidation without becoming another message, preview or unread item. Internal peer replication retains the witness; device sync emits only the authorized public invalidation/projection. Existing stores and polling carry this feature; a separate sidecar, journal kind or recovery service is unnecessary.

Actual older codecs can drop the reference/evidence event or demote v3 fields. A sole surviving stripped redacted copy may permanently lose the relation. Total loss cannot be distinguished from an ordinary historical unquoted message. Keep the readable base under its existing ACL and disclose mixed-version support as partial/unknown at holder/response level. Normal replay does not magically repair discarded metadata. This increment preserves complete evidence when it arrives and leaves the separately tracked transferable-proof substrate gap explicit.

## Current-Reader Projection And Cache

Remove raw stored replyTo and proof objects from public DTOs, then apply this closed projection:

| Evidence and current source | Public reply field |
|---|---|
| Unique valid v3 relation and readable original | reply:{state:"available",eventId,messageId,preview,senderName} |
| Admitted new-protocol relation but source/private/key/conflict evidence unavailable | reply:{state:"unavailable"} |
| Relation evidence absent or fabricated/failed on a legacy record | Omit reply; retain existing origin-verdict/diagnostic policy. |

For App, the available eventId is the authorized exact original and the reply chip opens the approved typed App event navigation; never fall back to messageId. For providers, eventId is null and messageId retains the physical provider namespace. Unavailable exposes neither identifier. preview uses existing bounded pin/message preview functions; senderName is a safe source label or null. Unavailable exposes neither original ID nor text/author/filename. Reply permission does not grant original permission. Strip ENTIRE private origin/receipt/redaction objects when their bytes reveal the original, using existing device-sync redaction patterns. Internal verification stays intact; a forwarded verdict label is not authority.

Apply this to actual App/Telegram/Slack history, event, pool, pin, conversation and notification paths exposing a quote. Evidence visibility requires a readable reply base. An unreadable original permits only its authorized unavailable invalidation, excluding the nested witness/reference. Future message deletion can make the original unavailable through the same resolver.

Derived previews/source IDs are ephemeral current-view data, not persisted immutable message content. Clear them on navigation/reopen, focus/resume, reader or authorization change; refetch currently visible history pages using existing cursors before showing fresh quotes. Pending/offline revalidation cannot show an old preview. Test reopening a cached readable reply after original access is revoked without a new reply event.

Reuse existing polling/foreground signals and one indexed source view/verified map per response. Recheck authorization after peer awaits. Native cache behavior needs actual app proof before release claims.

## Provider Outcomes

Preserve dispatch/delivery, mirror, destination and wrong-machine/machine-required outcomes. Quoted responses additionally save one immutable replyMirror:

- {state:"applied",platform:"telegram"} after confirmed native linkage.
- {state:"not-applicable",reason:"app-only"} or reason emergency-stop.
- {state:"unavailable",reason:"no-platform-target"} or reason unsupported.
- {state:"failed",reason:"provider-refused"} or reason transport-unknown.

Slack keeps its registered thread. Telegram requires the correct holder and real physical target. Protected original text is never copied into a provider fallback. App dispatch can succeed while linkage is unavailable/failed; keep those results independent. An uncertain provider send is not retried as an ordinary message. Unquoted responses omit replyMirror.

## Exact Navigation Dependency

App message links are an independently owned prerequisite, governed by the approved `conversation-message-links.md` on `feat/app-message-links`. Build quoted replies from that merged source head; do not reimplement its held-source reader, target/context DTO, typed `e` navigation, masked refusal, current-reader checks or client generation mechanics. The historical combined link API in this draft is removed. An available App reply exposes only its authorized exact eventId and opens the original through that approved contract. Opening it retains the existing draft and attachments; a source that becomes unavailable remains unavailable without falling back to a public-ID match.

Provider message-link generation remains owned on card wc_4d8dd0e0144b636e, separately from native quoted-send linkage. This quoted-reply increment neither changes provider URL authority nor promises Instar can revoke independent provider membership.

## Capability And Compatibility Contract

`GET /capabilities` reports `appConversations.quotedReplies:{contractVersion:1,sourceAvailable:boolean,protocols:string[]}`. The sourceAvailable value requires the actual reply routes mounted, a substantive native conversation service, and the current native/pairing gate. Protocols names only mounted adapters: `app-v1`, `telegram-v1`, `slack-v1`; off/unmounted yields false and an empty list. This reports local protocol support, not message availability, provider delivery, permission or fleet readiness. The actual action rechecks its physical holder, source and actor. A compatible client uses both the named protocol and dedicated signed action path, and never silently drops a selected reference on a 404/unsupported holder.

## Multi-machine posture

Unified message state uses the existing appConversations event stream, including references, v3 receipts and evidence events. Every holder applies its current viewer/original checks. Peer previews/verdicts are not authority. Pool reads retain physical/holder identity and recheck the reader across awaits. Mixed-version loss is partial/unknown; this adds neither global synchronous acknowledgement nor origin-offline recovery.

Provider dispatch is machine-local-justification: physical-credential-locality. Telegram credentials/forum namespace and Slack installation remain on their holder. App identity and signed evidence replicate; credentials stay local. App locators reuse console/router selection; provider URLs declare provider authority. Existing polling, event storage and routing supply execution. Dark holders remain unknown/unavailable.

## Frontloaded Decisions

These are enumerable invariants, with evidence below. Resource budgets bound work, never source eligibility. A language model is not given authority over exact identity/signature/ACL checks.

| ID | Decision | Invariant evidence |
|---|---|---|
| D1 | New exact reply action paths | Older handlers must not silently discard selected-message intent. |
| D2 | Same physical conversation and exact original | Existing ACL and actual ID, rather than title/window location. |
| D3 | Client ID only; namespace/preview server-owned | Existing source custody; caller cannot fabricate attribution. |
| D4 | Fixed actor/reference/origin/receipt reservation | Existing durable request and retry identity. |
| D5 | Emergency stop precedes quote admission | Existing authenticated stop priority/idempotency. |
| D6 | Exact v3 signed bytes/version dispatch | Existing Ed25519 and key-history checks. |
| D7 | Quote proof AND original ACL | Signature validity is not read authority. |
| D8 | Deterministic evidence, immutable base | Duplicate suppression must preserve a later complete proof. |
| D9 | Conflicts/unknown stay unavailable | Arbitrary replacement cannot become authority. |
| D10 | Total legacy loss is unknowable | Actual codec behavior; bounded increment makes no offline claim. |
| D11 | Whole private proof redaction | Reference bytes can exist beyond the direct field. |
| D12 | Ephemeral quotes revalidate on reopen/focus/actor change | Append-only reply events do not signal every ACL change. |
| D13 | Dispatch/native linkage independent | Existing provider custody and uncertain-send safety. |
| D14 | Typed App event selects the original | A repeated public ID cannot redirect the selected event. |
| D15 | Local mounted quoted-send capability | Capability is protocol support, never source/permission/delivery proof. |
| D16 | Reuse approved App exact navigation | Prerequisite link contract retains current-reader and composer mechanics. |
| D17 | Reuse existing event/history/polling machinery | Unified identity with credential-local action. |
| D18 | Native/deployed proof remains separate | A source field or API200 does not complete a menu action. |

Frontloaded decisions:18; cheap tags:0. Review records actual contests. Native layout stays with the app owner; forward/delete stay on this card.

## Decision points touched

Every point is a hard invariant in an enumerable identity/protocol/ACL domain; no new semantic message blocker or competing-signals heuristic is introduced.

| Decision | Classification | Basis and independent evidence |
|---|---|---|
| Signed action/schema and unsupported holder | invariant; basis: enumerable-domain; evidence: exact path and closed reply selector are in canonical device request bytes | An old action cannot attest the new reference. |
| Exact selected App event/physical provider original | invariant; basis: enumerable-domain; evidence: decoded source event and destination namespace must match the selected typed identity | Repeated public IDs cannot select another event. |
| Current actor, destination and original ACL | invariant; basis: enumerable-domain; evidence: existing device/key ledger/person/grant authorities are re-resolved after awaits | A signed old actor is not the replacement actor. |
| Fixed reservation and retry result | invariant; basis: enumerable-domain; evidence: existing MobileChatRequestStore payload hash and durable entered/done state | Same request ID cannot authorize a changed reference or another send. |
| Authenticated emergency stop priority | invariant; basis: irreversible-consequence; evidence: delaying the existing exact stop behind missing source/signer can continue a side effect the person ordered stopped | Retain existing stop authentication/idempotency without quoted append. |
| V3 proof and supported-version dispatch | invariant; basis: enumerable-domain; evidence: exact domain-separated Ed25519 payload and historical key lookup | Changed namespace/reference bytes cannot keep a valid proof. |
| Evidence consistency and base immutability | invariant; basis: enumerable-domain; evidence: actual duplicate-event path, deterministic complete witness and conflict check | Stripped/full arrival order cannot choose arbitrary text/reference. |
| Current-reader projection and private-proof stripping | invariant; basis: enumerable-domain; evidence: original source ACL plus verified relation and public DTO allowlist | A readable reply cannot authorize private original bytes. |
| Provider dispatch/linkage outcome | invariant; basis: enumerable-domain; evidence: existing dispatch receipt and actual provider acknowledgment are distinct facts | Unknown linkage cannot justify a duplicate ordinary send. |
| Mounted capability and navigation dependency | invariant; basis: enumerable-domain; evidence: actual route/service/gate wiring and the approved typed App target acknowledgment | A capability symbol is not a successful current source read. |

No new behavioral timeout, rate, retention ceiling or growth quota is selected here. Existing request/media/provider resource bounds remain inherited and must be independently contested in review; source budget exhaustion is unknown, not proved absence. Fixed schema/version fields and one-reference selection are protocol domains, not quotas on eligible history.

## Open questions

None. This unapproved draft may still change through review; it adds no authority to build or ship before the required review and approval.

## Testing And Wiring

Unit: closed typed references and destination namespaces; exact v3 null/presence/body/destination/reference tampering; redacted media; unknown keys/versions; actual older codecs; both complete/stripped arrival orders, evidence-before-base, conflict, rebuild and restart; no duplicate message/preview/unread; whole nested-proof redaction; request-local indexed lookup reuse. Preserve the approved App-link tests.

Signed HTTP: original unreadable while reply remains readable; masked absent/forbidden; budget unknown; changed-reference retry; fixed-proof restart/key rotation; actor revocation/reassignment across awaits and completed retry; stop with unavailable original/signer executes once; unsupported holder never drops reference; exact physical provider identity/holder; independent dispatch/linkage outcomes. Reopen cached reply after original ACL changes without another reply event and require fresh projection. Available App reply opens the selected typed event beyond page one while preserving composer state.

Production AgentServer must wire the substantive store, identity/key ledger, current-person predicates, holder/namespace readers, capability and signed quote routes. Exercise actual send/history/projection; only provider transport is fake. Require awareness, release fragment, side-effects review, independent implementation review, complete exact-head Local Verify and actual app proof before readiness. No competing suite runs.

## Rollback And Completion

Old clients retain ordinary sends/history while ignoring optional fields; old holders lack the new reply route. Old codecs may permanently lose references/evidence, so rollback cannot promise every relation survives. Immutable base messages retain their current ACL. This operation grants no new access and performs no purge.

Full verification, deployed real-channel behavior, native captures and actual cache/navigation proof precede a live claim. Card closure also requires the later forward/delete increments.

## Maturation plan

- **test-agent-live:** Initialized signed send, private-source redaction, stop priority and automatic old-message navigation.
- **dev-agent-live:** Deployed protocol and real owner-channel quote/link after verification/release.
- **fleet:** Existing native conversation rollout, rather than a new silent flag.
- **graduation criterion:** Selected identity, binding, current original access, automatic exact target, complete exact-head gate and native/user-channel proof.
- **dark-window:** Uncertain/unsupported stays explicit until evidence; existing lifecycle governs admission.
- **ladder:** mobilePairing.native

## Review State

This is the proposed second-round design, not implementation approval. Reviewers must ground exact provider readers and history-position mapping in existing code. Round-one findings and the original draft are preserved under reports. Forward/delete remain later owned increments.

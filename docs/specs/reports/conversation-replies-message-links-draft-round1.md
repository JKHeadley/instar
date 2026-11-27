---
title: Quoted Replies And Exact Message Links
slug: conversation-replies-message-links
author: echo
status: draft
tier: 2
parent-principle: "Operator-Surface Quality"
card: wc_4d8dd0e0144b636e
eli16-overview: docs/specs/conversation-replies-message-links.eli16.md
single-run-completable: true
---

# Quoted Replies And Exact Message Links

## Authorized Outcome And Increment

Chief handoff5f955c7c-c366-44a1-a1aa-4aa925778a73 assigns quoted reply, forward, single-message deletion and exact message links to this session. This first coherent increment implements quoted replies and links. Forward/delete remain owned subsequent increments on the same card; the card stays open until all its features and native/deployed proof are complete. No access grant, new recipient, source deletion or conversation movement is introduced here. Apple owns menus and native releases.

The existing dashboard already parses the `m` message target and offers bounded source finding with Keep looking. Reuse that path; do not build another locator subsystem. Existing /messages/link is an agent-only tool and may return matched text, so it is not broadly admitted to devices.

## Constitutional Basis

Operator-Surface Quality requires Reply and Copy Link to target the selected actual message, with clear unavailable states instead of made-up linkage. Current authorization, durable request custody and verifiable signed metadata are structural floors. They do not require a language model to decide whether an exact message ID is readable. Observation Needs Structure is served by the immutable reference and explicit mirror outcome.

## Signed Reply Input

Extend existing signed App, Telegram and Slack text/media sends with optional `replyTo:{messageId:string}`. Absent preserves existing behavior. The object accepts exactly its one key; reject empty/invalid IDs, unknown keys, caller quote text, author and source-conversation fields. A reference is always within the destination's same canonical conversation, resolved by the existing platform/store identity path. It never changes Slack channel/thread routing or accepts an external URL as identity.

Before reservation, resolve the actual original through the same bounded current message reader used for history/pins. Require current send permission AND current original-message visibility; unknown, absent and forbidden originals receive the same404 response without returning source metadata. Telegram native IDs must be real physical IDs in the correct forum/topic. Slack IDs must be actual timestamps in the exact registered channel/thread and serving holder. An App UUID is not silently coerced to a provider ID. Include reference presence and normalized value in the existing operation hash. Recovery replays the exact reserved reference and message ID rather than resolving a different source. Reused request IDs with changed references conflict.

Persist only the immutable normalized reference, not copied quote text/author. Preserve existing text/attachment semantics. Require a real machine signer to admit new quoted sends; otherwise return503 without appending or dispatching. Do not block ordinary unquoted legacy sends. Check the current actor and source/destination access after routing/media awaits and immediately before append/provider admission. A reassigned/revoked caller cannot complete under an old captured person.

## Signature And Codec Binding

Add optional `replyTo` to stored message/media-message validation and the appConversations replication codec. This remains the existing event kind and transport; no parallel quote store or journal kind. The device signature already covers exact request bytes. Extend verifyRecordedOrigin to compare normalized reply reference presence/value along with text and signed attachment fields.

Add machine receipt v3 binding canonical request hash, receivedAt, machineId, canonical destination conversation key and normalized reply reference (explicit null when absent). A quoted record requires that v3 binding even when original signed bytes are present; an old receipt cannot authorize metadata appended afterward. Redacted authority-token requests retain existing text/attachment redaction proof and require the same v3 receipt to bind the reply reference. Wrong reference, wrong destination, omitted/added reference under a retained v3 proof, wrong signature or wrong body fails verification. Unknown key history remains unknown, never verified. No original-author proof is invented by quoting a message.

Old v1/v2 unquoted records verify exactly as before. An older codec may drop the new reference or v3 proof while retaining the base message. Preserve that readable base message; report quote metadata unavailable when evidence was lost, rather than fabricating a quote or claiming origin certainty. Do not reconstruct authoritative metadata from a historically ignored request-body field or a title. Exercise the actual previous codec, both arrival orders and rebuild/restart. Missing proof does not become an access grant. A fully preserved v3 proof with altered metadata is failed, not a compatibility escape.

## Current-Reader Quote Projection

For each device-visible message, independently verify that the current viewer may read its original before exposing either the original ID or a derived preview. Read permission to the reply alone is insufficient. Readable originals yield bounded previews using existing message/pin preview functions, with safe displayed sender information derived from stored source, never caller input. Unavailable originals yield only `replyState:"unavailable"`; no source ID, text, author, attachment name or hidden signature payload may leak.

Apply the same projection to App history, event sync, conversation previews, Telegram/Slack native history, peer/pool responses, pins and any notification preview that exposes a quote. Raw signed body bytes and v3 receipt fields can themselves contain the reference: device DTOs must strip those private proofs when the original is unreadable, while internal verification and authorized peer replication retain them. Preserve existing origin verdict reporting without relabeling stripped evidence as newly verified. Never render raw internal metadata as the primary user content.

Resolve references from one bounded request-local source view where possible, and recheck current authorization before output after awaited peer operations. Do not scan unbounded history or search for a different public witness when the exact original is absent/private. Later message-deletion work must be able to make the source unavailable through this same resolver; no copied text is retained in replies.

## Provider Mirror Semantics

The App relation is authoritative only within the existing App record model. Telegram may receive a native reply parameter only when the exact physical target is verified and this machine is its serving holder. An unavailable native target does not get guessed from an App ID. Slack retains its current channel/thread target; quoting must not create another conversation by changing thread_ts.

Add a separate `replyMirror` outcome to quoted send receipts: native linkage applied, unavailable (no verified provider target), or unsupported by that provider's existing inline-reply surface. Preserve existing dispatch/delivery and mirror outcomes independently. Where native linkage cannot be made, a successful ordinary send remains successful and the app relation remains available to authorized readers. Do not copy protected original text into an external provider message as a fallback. Synthetic App IDs never become native provider reply IDs. Keep wrong-machine/machine-required results and existing server-owned routing; no new authority to act for another holder.

## Exact Message Link Read

Add a dedicated signed-device/approved-browser read `GET /mobile/conversations/message-link?ref=<conversation-ref>&messageId=<id>&machine=<optional-serving-holder>`. Bearer use is owner-agent scope under existing handler authorization, never a way for a signed device to select another reader. Validate exact query keys and existing bounded identifier shapes. Resolve canonical conversation and actual message with current per-message visibility; unknown/forbidden is404 without a matched body.

For App, return the existing console origin plus `#/work/chats?c=app:<uuid>&m=<messageId>` with correct URL encoding, after proving the exact readable message exists. Use the existing m target matcher and bounded paging/Keep looking interface; do not claim that a conversation-only link targets a message. For Telegram/Slack, reuse existing messageLinks builders only with verified physical provider message IDs and the correct holder/namespace. Do not return a conversation link when an exact provider target is unavailable. Report not-linkable with the existing retryable distinction. A local-only origin is explicitly localOnly; tunnel unavailable remains retryable, not a fabricated public URL. No credential, body, quote or ticket appears in copied links.

The link itself grants nothing. Opening it still requires current app/dashboard authentication and message-level access. Source routing survives machine changes through canonical conversation/message identity and existing console/router origin selection; a dead holder stays explicitly unavailable. Device middleware and active browser allowlists add only this exact read; the broad /messages/link endpoint stays agent-only.

## Multi-machine posture

Unified message state uses the existing appConversations replicated event stream with optional quote metadata and verifiable v3 receipts. Read projection is current-reader scoped on each holder; peers' quote previews are not authority and must be sanitized/recomputed. Pool reads keep holder and physical identity, fail closed when the exact source cannot be verified, and recheck the current reader across awaits. No global synchronous acknowledgement or origin-offline recovery guarantee is added.

Provider dispatch is machine-local-justification: physical-credential-locality. Telegram forum credentials and Slack installation/serving identity remain on their existing holder; canonical App references and signed records replicate, credentials do not. The generated locator is canonical/proxied-on-read via existing owner console/router selection, not a new machine-local URL registry. There is no new timer, background loop, quota or user-facing notice emitter. Dark holders remain unavailable/unknown; new readiness claims are local protocol support, not whole-agent completion.

## Decision points touched

- Same-conversation source selection: deterministic identity and current ACL floor; never title matching or a heuristic author guess.
- Signed quote validity: exact request/receipt reference binding, explicit unavailable proof, no new v3 metadata on old receipts.
- Current-view projection: separate original permission from reply permission, including signature-side-channel redaction.
- Provider reply action: only real verified physical target and current serving holder; unsupported/unavailable is reported separately from dispatch.
- Exact link: source witness, current access and actual message anchor; never grant access or substitute a chat link.
- Retry/recovery: durable fixed operation through existing request reservation; current caller authority remains required.

No competing-signals heuristic receives authority. Unknown identity/authorization/proof stays uncertain. Bounds reuse existing request, identifier, preview and history-page limits; no independent arbitrary quota is introduced.

## Testing And Wiring

Meaningful unit coverage must test both sides of reference validation, signature v3 tampering/null/presence/destination binding, redacted bodies, unknown signing keys, actual old-codec loss, device DTO redaction and exact link encoding/target matching. Test real references at physical Telegram/Slack boundaries, not synthetic IDs masquerading as provider IDs.

HTTP tests use actual signed devices and approved browser paths. Cover source private while reply readable, forbidden/unknown source equivalence, changed retry reference, recovery after reservation, cached mutation after revocation, actual peer fan-out and current-reader reassignment during awaited work, correct/missing Slack holder, provider linkage refusal independent of successful dispatch, and no broadening of agent-only link route access. Prove no body/proof leak in any public projection.

Production AgentServer initialization must wire real store, signature/identity ledger, current-person resolvers and link origin; test quoted send/history and an anchored exact readable message link through signed HTTP. Only external provider transport is a fake boundary; no mocked ACL, no-op route or test-only store injection may substitute for wiring proof. Awareness, release fragment, side-effects artifact and repeated independent runtime review are required. Complete suites go only to normal exact-head Local Verify, not a manual duplicate run.

## Rollback And Operator Proof

Old clients ignore optional fields and retain ordinary sends/history. An older server/codec cannot prove quote support, so Apple must leave unsupported actions explicit rather than silently drop the quote. Rollback preserves signed originals/references but may show unavailable quote metadata. No data erasure or access widening is required. Actual quoted menu behavior and exact-message navigation need native captures and deployed real-channel evidence before this increment is called live. Card closure still requires forward/delete and their proof.

## Maturation plan

- **test-agent-live:** Actual production initialization and signed request show a readable quote, redacted unreadable original and exact anchored link.
- **dev-agent-live:** Record deployed protocol and a real owner-channel quote/link interaction after ordinary verification/release.
- **fleet:** Follow the existing native conversation ladder; no new fleet flag or silent rollout.
- **graduation criterion:** Signed original binding, no unauthorized source leakage, exact link target, full exact-head verification and native/user-channel proof.
- **dark-window:** Unsupported or uncertain remains explicit until actual evidence; no arbitrary soak timer.
- **ladder:** mobilePairing.native

## Open questions

None. Review may identify design changes before implementation. Forwarding/deletion are explicitly separate owned increments, not completion claims for this one.

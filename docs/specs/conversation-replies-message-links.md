---
title: Quoted Replies
slug: conversation-replies-message-links
author: echo
status: draft
tier: 2
parent-principle: "Operator-Surface Quality"
card: wc_4d8dd0e0144b636e
eli16-overview: docs/specs/conversation-replies-message-links.eli16.md
single-run-completable: false
frontloaded-decisions: 18
cheap-to-change-tags: 0
---

# Quoted Replies

The first runtime increment is App-to-App Reply, off by default under `mobilePairing.native.quotedReplies.enabled`. It builds on the held-source lookup and typed message anchor in exact message links PR 3812. That pull request is published and awaiting full verification. Telegram and Slack contract sections remain follow-on work. Their routes and capability advertisements are outside this first runtime change. Boundary fixtures are listed in reports/quoted-replies-boundary-matrix.md.

## App Implementation Boundaries

- The dedicated signed App route reuses the current native send pipeline. It has a separate operation hash domain and accepts the selected event ID, never a caller preview or a public message ID. The ordinary send path rejects the quote field. The App-only setting starts false and has no effect on ordinary sending. It controls App quote admission, capability and projection. A flag-off holder omits the reply field and any quote preview, original identifier or quote proof, even for a replicated quoted message. This rule precedes all enabled-projection cases. It continues to show the authorized base text and files. Test ordinary history and exact context on that holder. After signed authentication, a disabled dedicated Reply endpoint returns unsupported, without evaluating or acting on any text there. The existing ordinary authenticated Stop route stays available. On the enabled Reply endpoint, the existing exact and semantic Stop policies are evaluated before quote-specific refusals. Tests cover both forms with the flag off and with the existing Stop route.
- Reuse `exactMessageReader` for signed identity continuity and `AppConversationStore.exactMessageCandidates(key, eventId, 'event')` for an indexed original. These are the actual published names. The store returns validated row projections. Reuse their current App ACL for the source. Re-read the exact event after awaits and compare destination, stored event ID and public message ID before reservation and append. Treat missing or unreadable source uniformly.
- Use the pre-existing send request store for duplicate and restart custody. Mark the reservation as an App reply and persist the exact original identity, accepted actor and fixed proof before calling any append or dispatch. Ordinary send reservations continue to use the existing hash and outcomes.
- For App history and context, share the same derived public reply projection. While a signed view stays active, use its existing conversation-list refresh and reader visibility signal to invalidate cached previews and re-read the same displayed reply event identities. A changed visibility revision immediately clears previews before the read. On every successful signed list refresh revalidate the displayed reply identities, including when membership and the visibility value are unchanged. Hide previews before revalidation. Start a fresh projection generation before each revalidation, even when membership and visibility are unchanged. An off-state refresh advances that generation and clears both the chip and its navigation target without requesting a replacement. Apply results only when view, reader and projection generation all match. Test an enabled response held until after an off-state refresh. If refresh fails, previews stay hidden until authorization is verified again. A successful empty event poll supplies no such proof. Test remote revocation without navigation, focus change or a new reply event. The original event ID is emitted only when that original is independently readable now. A stored reply with unverifiable proof returns the unavailable state. Older peers that stripped every quote marker can still show the ordinary base message.
- Prove the flag-off route, legacy sends, same-target duplicate retry, typed event collision, masked denied and missing target, emergency Stop, and crash-before/after-append against production admission. Native fixture payloads cover available and unavailable chips, a mismatch, and the exact event link. The first App runtime is not ready until the link prerequisite and these checks are verified.

## Outcome And Scope

Reply identifies the exact selected original without granting its audience new access. This draft adds quoted-send proof/projection and reuses the separately approved App-link prerequisite for opening originals. Card wc_4d8dd0e0144b636e and handoff5f955c7c-c366-44a1-a1aa-4aa925778a73 own the work; forward/delete and provider URL generation remain tracked on that card.

Operator-Surface Quality governs correct selection and honest source states. Existing ACLs and exact identity/proof are floors; the existing sentinel owns semantic stop intent. Native menus/releases belong to echo-instar-apple-app-rebuild. Source completion never certifies native behavior.

## Exact Signed Reply Paths

Add POST /mobile/chat/app/:key/reply, POST /mobile/chat/:topicId/reply and POST /mobile/chat/slack/:conversationId/reply. Each reuses its corresponding text/media send body. App requires exactly replyTo:{eventId:string}, an opaque stored event identity subject to the approved App source reader bounds. Telegram and Slack require exactly replyTo:{messageId:string}, validated as a real physical provider message identity. The destination and signed action path supply the namespace. Reject caller quote text, author, source-conversation fields, mixed event/message selectors and unknown keys. App never selects by an ambiguous public message identifier.

Ordinary send paths retain existing behavior for old bodies and reject a new replyTo field. Older holders lack the new action path and return unsupported/404. Clients never fall back by dropping the reference. Share internal send logic while retaining the actual signed path; avoid an unsigned second HTTP send.

Resolve the original within the destination's same actual conversation. Preserve Slack channel/thread routing. Telegram requires the correct physical forum/topic and real message ID; a synthetic App ID is not a provider ID. Normalize a server-owned ReplyReference:{conversationKey:string,eventId:string|null,messageId:string}. App derives both the actual eventId and public messageId from the unique selected source event; provider references use eventId:null and the verified physical messageId. Its key is app:<uuid>, the verified physical Telegram chat/wire-topic key, or the existing stable Slack registry key. Destination supplies the namespace; verify it at admission and projection.

Use exact indexed App lookup and actual exact provider/store lookup. A recent page boundary is not proof of absence. If the existing provider/log reader uses admitted scanning, budget exhaustion is unavailable. After conversation authorization, every unresolved original (hidden, absent-local, ambiguous, unreadable or unfinished lookup) returns the identical409 {error:"reply-source-unavailable",retryable:true}. No public status/body distinction discloses whether an original exists here. Resolve the exact selected witness, not another public message.

Positive provider evidence is required, not a complete search of all historical messages. A Telegram row must carry its actual physical chat and wire-topic namespace plus message ID; historical topic-only log rows cannot acquire that provenance from today's config. Capture that namespace at the existing provider ingestion boundary for new records. Until such a verified row is available, return the same masked unavailable result. Slack resolves the registered workspace/channel/thread and exact provider timestamp together; a retained-page miss is unavailable, never proof of deletion. No exhaustive historical reconstruction or new history service belongs in this increment.

## Reservation, Recovery And Stop

Before a new reservation require current send permission AND current original-message visibility. Extend the existing operation hash with reference presence/value. Save normalized reference, replying eventId/messageId, original actor key, canonical destination, accepted origin bytes/redaction, receivedAt and fixed v3 receipt in the existing send reservation before effects; removed raw credentials are never persisted for recovery. Retain existing text, attachment and deterministic message/event ID behavior.

New quoted admission requires its real signer; absent signer503 before append/dispatch. Recheck actor/source/destination after media/routing awaits and immediately before append/provider admission. Reassignment/revocation invalidates the captured actor.

For a valid request ID, compare the durable request hash and resolve the existing disposition before semantic Stop classification. Completed retries and request-ID conflicts perform no fresh semantic classification or Stop action. Before yielding to semantic classification, atomically claim the request ID and hash in the serving holder’s active request state. A competing hash conflicts and an identical request sees in-progress. Before any Stop effect, persist that same claim with the Stop intent and preserve the existing holder fence. After semantic classification yields, re-read the original admitted actor, current destination scope and holder authority at Stop effect admission. Revoked or reassigned actors cannot trigger Stop. Test revocation during a suspended classifier and assert zero Stop effects. A crash with a durable entered Stop and no durable disposition returns outcome-unknown without reissuing the stop. Prove simultaneous submissions and a crash after effect before acknowledgment. For a new request, use the established exact Stop floor and then the existing semantic Stop admission before any new quote-specific source or signer refusal. Test that replay after classifier drift and conflicting content each perform zero additional Stop effects. Retry reuses the fixed reservation across restart/key rotation. A completed retry returns the original immutable replyMirror outcome after checking the captured actor and current access to the reply destination. If that actor lost access only to the original, still return the recorded send disposition with all original source fields suppressed. Test a lost acknowledgement followed by original-source revocation. Resolve the captured actor before reading the old result; a replacement device/person cannot inherit it. A different payload/reference with the same request ID remains a conflict. Retain actual existing stranded-send recovery: a missing append becomes the durable original not-delivered result, never a reconstructed append from a body hash. An existing append with uncertain downstream delivery stays unknown and is never redispatched. No new sanitized-text custody is promised. A crash after provider admission but before its acknowledgment is recorded remains transport-unknown, even if the message later appears on that provider; an ordinary unquoted retry is forbidden.

Register the dedicated reply actions in actual signed-device route admission and authentication-time read-quota exemptions. Preserve the unvetoable exact authenticated stop floor. Before any NEW quote-only source/signer refusal, feed authenticated authored text (without fetching an inaccessible original) to the existing MessageSentinel disposition authority. A model-confirmed kill uses the existing scoped idempotent stop once, without quoted append or original disclosure; return the existing stop result with replyMirror not-applicable/emergency-stop. A negated/ordinary discussion must not kill. Unknown/classifier failure follows existing policy and retains strict quote checks; it never becomes an ordinary unquoted send. Existing pause semantics remain unchanged. Quote metadata grants no stop authority.

## Storage And Receipt V3

Message/media-message stores only normalized replyTo; derive original preview/author at read time. Extend verifyRecordedOrigin's accepted paths to the exact reply actions. For App, compare signed input eventId with the selected stored event identity; derive its public messageId from that same decoded source witness. For providers, compare signed input messageId with the verified physical message identity. The machine receipt binds the complete normalized reference, server-derived namespace and actual stored destination.

Receipt shape is {v:3,conversationKey,eventId,messageId,replyTo:ReplyReference|null,machineId,signerKeyHash,sig}. eventId/messageId identify the replying base, not the selected original. Its exact Ed25519 payload is the UTF-8 canonical JSON encoding of the following array, with no trailing newline. Every field occupies its own array slot, so adjacent opaque IDs cannot collide through separator placement:

    ["instar-app-receipt-v3", sha256(canonicalDeviceRequest), receivedAt,
     machineId, canonicalStoredDestinationKey, replyingEventId, replyingMessageId, replyToOrNull]

Use the existing canonicalJson, device canonical request, signer and key-history implementations. For receivedAt, sign the exact immutable ISO string already stored on the replying base. Persist it in the existing reservation and base as the same string, and read it from the decoded base when verifying after restart. Missing or mismatched timestamps fail quote proof. The receipt byte fixture also requires equivalent references with different input property order to encode identically. Quoted admission requires v3 even with original signed bytes. Redacted bodies retain existing text/attachment redaction proof plus v3 reference binding. The new validator rejects unknown receipt versions as unsupported proof instead of demoting them. Unquoted v1/v2 verification remains unchanged.

Changed replying base IDs, added/removed/changed reference, wrong destination/body/signature or physical namespace mismatch under preserved v3 proof fails quote verification. Verify receipt base IDs against the actual immutable message; a copied witness cannot attest a new base. Unknown key history stays unknown. A base origin verdict or historically ignored body field alone cannot authorize a quote.

## Bounded Compatibility And Immutable Base

Chief of Staff explicitly disposes the older-codec disagreement as a disclosed compatibility limit, not a prerequisite to this increment. Do not add quote-evidence events, a transferable-proof ledger, duplicate-evidence enrichment, all-member acknowledgment, a recovery service or an alternate replication transport. The ordinary quoted message and its v3 receipt travel through the existing event stream. Existing duplicate-event and immutable-base semantics remain unchanged.

Validate the relation carried by the actual stored replying base using its canonical conversationKey, eventId and messageId. A shared public messageId cannot select a different base or original. A copied receipt for another base fails; invalid or unknown proof never authorizes a preview. A syntactically recognized retained quote marker always permits the same content-free unavailable state when proof is missing or fails. A syntactically valid stored replyTo relation is a marker. A v3 receipt carrying a valid non-null relation is also a marker. A v3 receipt with replyTo:null and no base replyTo, or only a legacy/demoted receipt and no surviving relation, supplies no marker. The same retained bytes produce the same state whether an older codec stripped proof or a stored record carried bad evidence. One request-local verification result per exact stored base is enough: this design does not enumerate competing remote witnesses or claim a complete distributed evidence frontier. Do not overwrite a stored message, merge proof from a later duplicate, append another visible message or increment unread to repair stripped metadata.

Actual older codecs can strip the relation or demote receipt fields. Where the stored message still identifies a quote but its relation cannot be verified or resolved, project only reply:{state:"unavailable"}; the client displays exactly "Quoted message unavailable". Keep readable base text and attachments under their existing access rules. A complete newer duplicate is not promised to repair a stripped stored base. Arrival order may therefore affect quote availability, and this is an explicit mixed-version compatibility limit rather than a claimed convergence property.

If an old codec removes every indication that the message was a quote, it is indistinguishable from an ordinary historical message. Omit the reply chip rather than inventing a relation; disclose partial/unknown quote support for that holder. No design can promise a per-message unavailable chip after all quote markers have vanished. Retain this distinction in native acceptance and release notes. Durable transferable proof and single-machine quote-relation survivability are outside this increment; no unified-survivability or fleet-readiness claim is earned by source completion.

## Current-Reader Projection And Cache

Remove raw stored replyTo and proof objects from public DTOs, then apply this closed projection:

| Evidence and current source | Public reply field |
|---|---|
| Unique valid v3 relation and readable original | reply:{state:"available",eventId,messageId,preview,senderName} |
| A recognized stored quote marker remains, but its relation/source/key is unavailable or cannot be verified | reply:{state:"unavailable"}, rendered as "Quoted message unavailable" |
| No recognized stored quote marker remains | Omit reply; retain existing origin-verdict/diagnostic policy. |

For App, the available eventId is the authorized exact original and the reply chip opens the approved typed App event navigation; never fall back to messageId. For providers, eventId is null and messageId retains the physical provider namespace. Unavailable exposes neither identifier. preview uses existing bounded pin/message preview functions; senderName is a safe source label or null. Unavailable exposes neither original ID nor text/author/filename. Reply permission does not grant original permission. Strip ENTIRE private origin/receipt/redaction objects when their bytes reveal the original, using existing device-sync redaction patterns. Internal verification stays intact; a forwarded verdict label is not authority.

Apply this to actual App/Telegram/Slack history, event, pool, pin, conversation and notification paths exposing a quote. Quote visibility requires a readable reply base. An unreadable original permits only its authorized unavailable projection, excluding private references and nested proof. Future message deletion can make the original unavailable through the same resolver.

Derived previews/source IDs are ephemeral current-view data, not persisted immutable message content. Clear them on navigation/reopen, focus/resume, reader or authorization change; retain each displayed page's original request boundary or exact visible reply identities, and obtain their current projection before restoring quotes. Neither the next-page cursor nor an empty incremental sync certifies that displayed coverage. Pending/offline revalidation cannot show an old preview. Test reopening a cached readable reply after original access is revoked without a new reply event.

Reuse existing polling/foreground signals and one indexed source view/verified map per response. Recheck authorization after peer awaits. Native cache behavior needs actual app proof before release claims.

## Provider Outcomes

Preserve dispatch/delivery, mirror, destination and wrong-machine/machine-required outcomes. Quoted responses additionally save one immutable replyMirror:

- {state:"applied",platform:"telegram"} after confirmed native linkage.
- {state:"not-applicable",reason:"app-only"} or reason emergency-stop.
- {state:"unavailable",reason:"no-platform-target"} or reason unsupported.
- {state:"failed",reason:"provider-refused"} or reason transport-unknown.

Slack keeps its registered thread; this increment reports native linkage unavailable/unsupported rather than presenting thread membership as an exact-message native reply. Telegram requires the correct holder and real physical target; only an actual provider acknowledgment of linkage earns applied. Protected original text is never copied into a provider fallback. App dispatch can succeed while linkage is unavailable/failed; keep those results independent. An uncertain provider send is not retried as an ordinary message. Unquoted responses omit replyMirror.

## Exact Navigation Dependency

The App-link prerequisite `conversation-message-links.md` on feat/conversation-message-actions is published as PR 3812 and pending full verification. Runtime implementation must integrate its actual verified source through the normal branch process before claiming navigation works. Reuse its held-source reader, typed `e` target/context contract, masked errors, current-reader checks and client generations; do not reimplement the removed historical link DTO. Available App replies open their exact event while retaining draft/files; never fall back to public-ID matching. Provider URL generation remains on card wc_4d8dd0e0144b636e and grants no new provider-membership claim here.

## Capability And Compatibility Contract

`GET /capabilities` reports `appConversations.quotedReplies:{contractVersion:1,sourceAvailable:boolean,protocols:string[]}`. The sourceAvailable value requires the actual reply routes mounted, a substantive native conversation service, and the current native/pairing gate. Protocols names only mounted adapters: `app-v1`, `telegram-v1`, `slack-v1`; off/unmounted yields false and an empty list. This reports local protocol support, not message availability, provider delivery, permission or fleet readiness. The actual action rechecks its physical holder, source and actor. A compatible client uses both the named protocol and dedicated signed action path, and never silently drops a selected reference on a 404/unsupported holder.

## Multi-machine posture

Message state uses the existing appConversations event stream, including optional references and v3 receipts, with no new evidence event kind. Every holder applies its current viewer/original checks. Peer previews/verdicts are not authority. Pool reads retain physical/holder identity and recheck the reader across awaits. Mixed-version loss is partial/unknown; this adds neither global synchronous acknowledgment nor origin-offline recovery. Chief's bounded disposition accepts that limit for this increment; it does not amend the continuity standard or certify fleet readiness.

Provider dispatch is machine-local-justification: physical-credential-locality. Telegram credentials/forum namespace and Slack installation remain on their holder. App identity and signed evidence replicate; credentials stay local. App locators reuse console/router selection; provider URLs declare provider authority. Existing polling, event storage and routing supply execution. Dark holders remain unknown/unavailable.

## Frontloaded Decisions

These are enumerable invariants, with evidence below. Resource budgets bound work, never source eligibility. A language model is not given authority over exact identity/signature/ACL checks.

| ID | Frontloaded choice (contract above; classified below) |
|---|---|
| D1 | Dedicated signed paths; no dropped-reference fallback |
| D2 | Exact same-conversation original |
| D3 | Server derives namespace and preview |
| D4 | Fixed reservation/proof; no missing-append reconstruction |
| D5 | Exact stop floor plus existing semantic authority |
| D6 | Frozen v3 bytes and version dispatch |
| D7 | Verified relation AND independent original ACL |
| D8 | Receipt binds exact stored base; no duplicate enrichment |
| D9 | Unknown/invalid retained relation stays unavailable |
| D10 | Total legacy loss cannot be invented away |
| D11 | Strip whole nested private proof |
| D12 | Clear/revalidate current visible coverage |
| D13 | Dispatch and native linkage are separate facts |
| D14 | Typed App event cannot alias public ID |
| D15 | Mounted local protocol is not delivery/source proof |
| D16 | Reuse approved exact App navigation |
| D17 | Reuse existing storage/replication/admission |
| D18 | Owned native handoff and actual proof |

Frontloaded decisions:18; cheap tags:0. Review records actual contests. Native layout stays with the app owner; forward/delete stay on this card.

## Decision points touched

Identity/protocol/ACL points are invariants. Non-exact stop intent is delegated to the existing contextual authority; no new semantic phrase-list blocker is introduced.

| Decision | Classification |
| --- | --- |
| Signed action/schema and unsupported holder | invariant; basis: enumerable-domain; evidence: exact path and closed reply selector are in canonical device request bytes |
| Exact selected App event/physical provider original | invariant; basis: enumerable-domain; evidence: decoded source event and destination namespace must match the selected typed identity |
| Current actor, destination and original ACL | invariant; basis: enumerable-domain; evidence: existing device/key ledger/person/grant authorities are re-resolved after awaits |
| Fixed reservation and retry result | invariant; basis: enumerable-domain; evidence: existing MobileChatRequestStore payload hash and durable entered/done state |
| Authenticated emergency stop priority | invariant; basis: irreversible-consequence; evidence: delaying the existing exact stop behind missing source/signer can continue a side effect the person ordered stopped |
| Non-exact stop intent | judgment-candidate; floor: authenticated current actor/scope, exact stop unvetoable, no quote disclosure/unquoted fallback; arbiter: existing MessageSentinel.decideInboundDisposition; fallback: existing unknown/route-through policy plus strict quote admission |
| V3 proof and supported-version dispatch | invariant; basis: enumerable-domain; evidence: exact domain-separated Ed25519 payload and historical key lookup |
| Relation validity and base immutability | invariant; basis: enumerable-domain; evidence: receipt matches exact stored base; existing duplicate-event path cannot replace or enrich it |
| Current-reader projection and private-proof stripping | invariant; basis: enumerable-domain; evidence: original source ACL plus verified relation and public DTO allowlist |
| Provider dispatch/linkage outcome | invariant; basis: enumerable-domain; evidence: existing dispatch receipt and actual provider acknowledgment are distinct facts |
| Mounted capability and navigation dependency | invariant; basis: enumerable-domain; evidence: actual route/service/gate wiring and the approved typed App target acknowledgment |

No new behavioral timeout, rate, retention ceiling or growth quota is selected here. Existing request/media/provider resource bounds remain inherited and must be independently contested in review; source budget exhaustion is unknown, not proved absence. Fixed schema/version fields and one-reference selection are protocol domains, not quotas on eligible history.


## Open questions

None. This unapproved draft may still change through review; it adds no authority to build or ship before the required review and approval.

## Testing And Wiring

Execute every App boundary in reports/quoted-replies-boundary-matrix.md with real store/key ledger/request restart and signed device/browser HTTP. Add changed-base-ID replay, same-public-ID exact-base binding, both stripped/complete duplicate arrival orders without enrichment, identical unresolved-source responses, semantic kill versus negation/classifier failure, read-quota exhaustion on new actions, and missing-append not-delivered. Exercise independent provider outcomes in their corresponding follow-on increments. Verify original ACL/cache revocation without a new reply event; never certify it through empty incremental sync. Preserve App-link tests. Do not add proof-frontier, evidence-journal or transferable-proof tests for machinery excluded from this increment.

Production AgentServer must wire substantive store, identity/ledger, current-person/holder readers, capability and signed actions. Test real App quote send, history and projection. Provider increments use their actual signed server and store paths with only the remote provider transport substituted. Require actual client proof, awareness, release/side-effects review, independent implementation review and complete exact-head Local Verify. Use normal per-host admission/shared verification custody without duplicate runs or overrides; an independently admitted idle host is not globally excluded.

## Rollback And Completion

Old clients retain ordinary sends/history while ignoring optional fields; old holders lack the new reply route. Old codecs may permanently lose relations or receipt fields, so rollback cannot promise every relation survives. Known unavailable quotes use the plain fallback; total marker loss may remove the chip. Immutable base messages retain their current ACL. This operation grants no new access and performs no purge.

Full verification, deployed real-channel behavior, native captures and actual cache/navigation proof precede a live claim. Card closure also requires the later forward/delete increments.

## Maturation plan

Register `mobilePairing.native.quotedReplies` in the existing feature ladder/evidence machinery. Emit its version-bound quote outcomes from actual admission/projection/custody code; ordinary `mobilePairing.native` traffic cannot satisfy it. No content, raw proof, private IDs or grants enter telemetry. The existing review must inspect current-version own outcomes plus signed HTTP/lifecycle/recovery/ACL and actual client proof, not a capability bit or an unrelated count.

Owner: Echo/session echo-telegram-parity-for-instar-chats. Review due: 2026-11-24, then a fresh owned date per actual rung disposition. Carrier: existing feature-maturation-review job and the same Work card; prove registration, enabled/awake carrier and own evidence read before dev-agent-live. Failed/missing carrier keeps the rung ungraduated and goes to Chief through existing follow-through, not an invented watcher or indefinite silent trial. Independent review judges evidence within existing floors; no arbitrary new soak/count is introduced.

Rungs: test-agent-live requires real initialized signed quote/stop/ACL/recovery and retained-relation validation, including the disclosed unavailable/marker-loss cases. Dev-agent-live requires normal verified release/deployment and real owner interaction. Fleet remains ungraduated unless actual compatible native behavior and the applicable continuity standard are independently satisfied; this bounded compatibility disposition does not meet those requirements. Transferable-proof infrastructure is not a server design or implementation prerequisite for this increment.

Native contract owner: echo-instar-apple-app-rebuild. Deliver exact wire/unsupported/source/cache/composer acceptance contract and record its explicit acknowledgment/evidence location under this card. The server run ends at verified server source plus accepted native handoff; the overall card remains open until actual native captures, cache/navigation/retry proofs and released client pass. Tool delivery alone is not acceptance. No native acknowledgment or completion is presently claimed.

## Review State

This is a bounded design revision after two historical review rounds, not implementation approval or a claim that those rounds converged. Chief handoff 39e3e5f6 resolves the compatibility disagreement and excludes durable transferable proof. The new bounded review must assess these changed bytes, exact base binding, masked source response, existing stop authority and existing crash recovery. Historical reports remain unchanged; their findings are not relabeled. Forward/delete remain later owned increments.

The first App increment requires the App rows of the boundary matrix, including dedicated-route default-off checks, duplicate outcome after source revocation, and the retained-marker/absent-marker pair. Telegram mirroring and Slack routing outcomes require their own provider increments.

Two bounded Codex Astra passes identified and motivated these clarifications. The final revisions require confirmation. No successful runtime or convergence is recorded by this checkpoint.

The focused review confirmed the preview generation, Stop authority and App-only test corrections. It also identified a potential delimiter ambiguity in the draft receipt. The v3 contract now uses canonical JSON for the entire tuple. The expected-byte fixture covers the two adjacent-ID values that the prior newline-join encoding could conflate. The wire encoding still needs runtime and independent implementation verification.

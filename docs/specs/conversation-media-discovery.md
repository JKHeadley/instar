---
title: Find Media In Conversations
slug: conversation-media-discovery
author: echo
status: draft
approved: false
card: wc_6c53d5472cbe88bb
eli16-overview: docs/specs/conversation-media-discovery.eli16.md
---

# Find Media In Conversations

Let people find messages with media by attachment kind and, where a stable author identity is available, by sender. Show a lightweight video preview only when the current conversation holder can produce one from an attachment the viewer may open. These capabilities use the existing registered device, conversation and message access checks.

## Search

Use the same validated filters for keyword and meaning search. The allowed kinds come from the canonical attachment kind mapping used by history. Match a message when at least one authorized attachment matches the selected kind. Author matching uses a platform-scoped stable identity, never a display name or the coarse `fromUser` flag. Resolve sender choices from identities the current conversation exposes to that reader. Apply both filters together when supplied.

For App conversations, join against the authorized history event and its verified attachment references. For Telegram, the TopicMemory text index is insufficient to identify attachments or named senders for all historical rows. The Slack search view similarly lacks stable author identity and attachment metadata today. For each platform, either apply the filter from the same typed history record and exact message identity or report that coverage as partial. Historical rows lacking the required evidence are not confidently ruled out. Missing metadata must not be backfilled by guessing from message text, link syntax, usernames or filenames.

Apply predicates before ranking and limiting, or scan a documented bounded candidate window and explicitly report partial coverage. In particular, filtering the returned Telegram FTS page or the first 150 meaning candidates cannot imply complete results. A filtered request for pool scope searches the local replica and reports unexamined remote scope. Unfiltered search keeps its current semantics and response compatibility.

### App search contract

The first slice applies filters to App messages. Attachment kind is an optional exact enum from the existing App media attachment contract. Sender is available only inside an explicitly selected App conversation. Sender-filter requests are local-only in the first slice, including when the client requests a pool view. Report the local scope in the acknowledgement and show that other computers were not searched. Do not send sender handles to peers. A sender selection refers to the recorded `senderPerson` pair (home machine and user ID) through an opaque, conversation-scoped value. The picker uses only visible, readable stamped rows. Names are display snapshots. For two readable people with identical display names, show each choice with a distinct, recent, authorized message excerpt or readable date and position that opens that sample. Keep picker keyboard and screen-reader labels distinct. If no readable distinguishing context exists, do not offer ambiguous choices. Use the existing per-conversation message scan ceiling for the picker and show when the list is incomplete. A reader can also start a sender filter directly from any readable stamped history message, including an older message outside that picker window. Device IDs, role, origin model and a message's wording cannot stand in for a person. Historical operator rows without a registry person produce a coverage gap for sender searches.

Keyword and meaning paths share one authorized App predicate. Before evaluating filters, load the current live conversation and check the event with the existing per-row read policy. Each matching attachment must have its indexed reference agree with the event's conversation, message ID, index and content hash. A purged or tombstoned reference cannot match. An unavailable local blob can still be listed when the authorized attachment reference is intact. Do not expose indexed reference fields, physical paths, or hidden sender identities in search results or coverage diagnostics.

A filtered keyword request may omit its text to browse media newest first through the same bounded scan, including captionless attachments. Resolve ties using the canonical conversation and event identifiers. This first slice shows the latest matches rather than a paging browser. Return a three-valued overflow signal distinct from scan coverage. It is yes after observing one additional distinct authorized result, no after exhausting the requested scope, and unknown when coverage ends first. Detect overflow before slicing the published list. Offer a narrower text or conversation filter and test the 51st match independently of scan truncation. An unfiltered or meaning request still requires text because it retains the existing keyword and embedding contracts. The meaning index does not hold attachment or sender evidence. For the first slice it may search its bounded ranked candidate window and then apply the predicate, but the result states that filtered meaning coverage is incomplete when the window or index coverage can omit eligible rows. This status must remain visible on empty results. A supplied punctuation-only query cannot silently become a browse.

Every filtered response carries an acknowledgement of the same normalized filter and version, separate from its rows. An older server can silently ignore unknown parameters and answer HTTP 200. Without exact acknowledgement the browser reports filtered search unavailable and must never display those results as filtered. Revalidate the current signed device and reader ability before publishing any local response after asynchronous embedding. Use the live owner admission check for owner devices. A non-owner request without an equivalent live recheck can use synchronous filtered keyword search and receives a clear unavailable response for filtered meaning. Existing unfiltered request behavior is unchanged. Missing platform coverage and remote scope are communicated as aggregate gaps without identifying hidden rows or people. Unknown choices and inaccessible conversations use the ordinary unavailable response without identity details. Bound attachment-reference lookups in addition to the existing message scan bounds, mark the result partial when either budget is spent.

## Video Previews

Expose a preview variant associated with an existing authorized conversation reference, message ID and attachment index. Reuse the current media access rules and resolve the exact attachment ID and index on the requested message before cache lookup. A hash-based first reference from another message is insufficient, even when both messages are in the same chat. A remote preview requires a targeted read to a proven holder with the existing authorized caller boundary. If that path is missing, retain the playable tile. The preview cache key may combine a verified source content hash with a decoder recipe version for reuse, but the hash grants no access. Run the same current message and attachment checks for cache hits and repeat them before returning a generated result. If access changed while decoding, discard the response.

Accept only verified local media bytes from the existing media store. Use a fixed, bounded decoder command and a fixed-size image output. Cap concurrency, source size, runtime and retained bytes, and use per-attempt temporary output and an atomic cache publish. No user-provided values can become command options or paths. The implementation must establish decoder isolation and local-only input, or retain the generic video tile. Do not install a decoder or turn on network access as part of previewing. Test actual decoder availability before advertising the capability. Render received previews as ephemeral media in the web interface with private no-store responses. An unsupported or failed preview keeps the existing playable attachment tile.

## Acceptance

Unit tests cover attachment-kind and stable sender matching, combined predicates, unknown metadata, candidate truncation and preview limits. HTTP integration uses actual signed requests to prove filters are honored across authorization scopes and pool capability boundaries. Exercise legacy HTTP 200 without acknowledgement, truthful pool coverage and zero peer calls for filtered requests in either mode. Preview tests cover a cache hit from a different unauthorized message, revocation during generation and safe fallback on a holder without a decoder. Production initialization and a real browser must demonstrate the controls, finding a captionless video by kind alone, a direct jump from a result, safe handling of a conversation switch while a result is in flight, a preview when supported and a playable fallback. Existing message text, composer attachments and pending sends remain usable.

The first search change must record the sender and preview dependency disposition in its release evidence. Preview remains a separate deployment slice with a verified decoder capability and exact attachment read contract as requirements. Until then the application presents the playable tile. It introduces no shared browsing-history cache and makes no installation or release claim.

## Frontloaded Decisions

The first deployable slice is filtered search for App conversations with authoritative event metadata. Telegram and Slack must explicitly report their coverage gaps until their history adapters supply typed attachment and sender evidence. Existing clients remain on unfiltered search. A new client opens canonical references through the existing history navigation. If a result cannot be resolved by that reader, it shows an unavailable message state.

Preview work is a distinct deployment slice. It reuses the current media path, retains the existing video tile when decoder capability is absent, and introduces no decoder installation or configurable executable supplied by callers. No user decision is expected for those defaults. If an approved decoder cannot establish process confinement and verified local-input handling, the slice stays dormant.

## Decision points touched

| Decision | Classification and evidence |
| --- | --- |
| Accept a filter only for its declared syntax and canonical type catalog | invariant; basis: enumerable-domain; evidence: existing attachment type catalog and stable per-conversation author identity |
| Return matching events only through the same conversation and event authorization as history | invariant; basis: irreversible-consequence; evidence: a disclosed attachment or sender association cannot be recalled |
| Mark coverage incomplete when metadata or acknowledged peer execution is missing | invariant; basis: external-constraint; evidence: unavailable history cannot answer whether a message matched |
| Preview remains unavailable when exact authorization, safe input, confinement or worker admission cannot be established | invariant; basis: irreversible-consequence; evidence: exposure of private files or unbounded execution from untrusted attachments cannot be reversed by returning a later error |

## Standards trace

This design applies *Verify the State, Not Its Symbol* to search membership. A filter acknowledgement is a client compatibility signal. The current authorized event and exact attachment-reference tuple provide predicate evidence. Absent evidence yields visible partial coverage. This protects the benefit described in *A Safeguard Must Leave a Benefit*: a person can browse App attachments by kind, including those without captions, and narrow by sender within a chat where names and access have a clear scope. Cross-conversation sender discovery waits for a method that preserves each chat’s access boundary without exposing a stable correlation token.

The current history store supplies App metadata after it has applied a replicated authoritative event on this member. A conversation unknown to the local store cannot be searched locally. This search change does not assert that the existing fleet has fully replicated every conversation. The search query does not own authoritative history, and losing a peer cannot hide committed metadata already replicated locally. The first slice introduces no new fanout and declares remote coverage unknown. A later filtered fanout must use canonical identifiers, bounded continuation, independent local evidence, and streamed byte limits. It must rebuild the displayed text and rank from current authorized evidence. Query work stops at pre-existing scan, candidate or peer limits plus a bounded metadata-read budget. These are work limits with partial outcomes and narrower-query support, and cannot certify absence. Exercise sparse qualifying histories at the existing scan boundaries and measure the additional authorized reference work. Use the existing maximum attachment count per event as the per-row ceiling rather than choosing an unrelated lower limit. The preview slice must justify its input and decoder resource limits separately before approval.

## Multi-machine posture

Filtered search is a read projection of the existing replicated App store. It introduces no authoritative machine-local state. Each machine searches stored events already available there. A request for pool scope explicitly reports that pending or unreplicated history elsewhere was not searched. Sender choices are ephemeral, chat-scoped, and not sent between machines. Remote previews can be proxied only once the exact current-holder path is proven. The derivative cache is an implementation cache on that holder. A move can regenerate a derivative from accessible source bytes, without changing the attachment's identity or permission. Revocation is evaluated per request even when the same derivative exists on another machine.

## Rollback

Older web clients omit the optional filters and preview read entirely. An older server’s missing filter acknowledgement is the browser’s unsupported response. An unavailable or unsupported preview keeps the playable tile. Deployment introduces no durable client schema. Cache expiry can remove preview bytes independently of original attachments.

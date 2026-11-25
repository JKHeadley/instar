---
title: App Message Delete
slug: conversation-message-delete
author: echo
status: approved
approved: true
approved-by: echo under standing build approval for local storage and private fresh admission only
parent-principle: Operator-Surface Quality
tier: 2
review-convergence: "2026-11-25T16:04:06.000Z"
review-iterations: 13
review-completed-at: "2026-11-25T16:04:06.000Z"
review-report: "docs/specs/reports/conversation-message-delete-convergence.md"
cross-model-review: "cross-model-review: codex-cli:gpt-6.2-astra"
---

# App Message Delete

The first increment hides one exact occurrence in an App conversation after an authorized person confirms Delete. It starts off. The client captures the paired machine, conversation and settled message event when the action is selected. A forwarded copy has its own occurrence. Removing one occurrence cannot remove a copy elsewhere.

## Signed action and authority

Use a device-signed action scoped to a live App conversation, exact event ID and request ID. The existing People policy supplies the current actor and row visibility. An eligible conversation owner may remove a visible occurrence. Author-based removal requires immutable historical person evidence and is outside this admission checkpoint. Establish author identity from recorded person and signed evidence, never display names or the current owner of an old device. Ambiguous or missing authorship grants no author privilege. Require active serving custody on the immutable creation machine for a first write. Same-intent retries keep the signed scope and return the recorded outcome. A changed target under the same request ID conflicts. An unresolved write cannot authorize a replacement mutation.

## Visibility and durability

Persist an immutable removal fact naming the original exact event and message IDs. Keep the fact valid if it reaches a replica before its target. Once removed, the occurrence cannot appear as visible history, an exact link or a quote preview. Apply removal to every server-side projection before exposing text, including incremental sync, search, preview, pins, reaction state, media authorization and future session context. For incremental clients, carry a removal instruction containing only the IDs needed to evict the cached row. Older readers must be kept from serving this conversation once they cannot enforce the removal fact. Include authenticated requests against stale replicas and old clients in the activation tests.

Retain original journal bytes under the existing storage policy. Message removal is a visibility action. Verify and describe what remains in historic transcripts, backups, downloaded files, and copies already sent to another conversation. Attachments must become unavailable through the removed occurrence. Shared bytes and references held by other authorized occurrences keep their own lifecycle. Removing a message does not itself request storage purge.

## Client and provider boundary

Show Delete only for a live capability and a settled row with an eligible action. Confirm on the captured target. Evict that row after an accepted response or an authenticated removal event. Leave the existing draft and other message actions intact. A denied or unavailable result must not remove a different row. The client must distinguish an unresolved request from a completed removal.

Telegram mirroring follows the App action. It requires an exact verified provider mapping and independent provider authority. Report the two outcomes separately. The App copy can be removed even if Telegram fails or is unavailable. No substitute mutation can run when the mapping is missing. Mirroring will require durable pending work bound to the same verified occurrence, and ambiguous provider acknowledgments remain unknown until reconciled.

## Related work

- Exact App message links and Reply for target identity, quote visibility and signed recovery.
- App Forward for separate occurrence identity and stale client boundaries.
- App attachment purge for reference lifecycle and authorization.
- Mobile unread and pool history for replica and incremental payloads.

## Overlapping reads and cache ordering

Name the mobile feed event `message-removed`, distinct from the existing conversation tombstone. It carries the exact removed event ID and the destination conversation scope. The paired and authorized feed establishes the account scope. Use the event ID as the merge key even when the retained message row also has a legacy message ID.

A confirmed action response or authenticated feed event records a removal marker before applying any history merge. Scope markers by pairing, conversation and exact event ID. Apply markers to the current view, delayed history pages, exact context and any restored cache. Persist the marker and evict the row together when the client has durable history. A history page cannot clear a marker or revive that occurrence, even if the page was fetched later from a lagging replica. Keep markers across pagination, cursor changes and restart. Display restored durable history for a Delete-enabled conversation only after an authenticated restore handshake obtains the creation custodian’s current sync high-water mark and the client has durably applied authorized sync through that mark. Until then, keep that cached history covered. Reconcile cached rows against current visibility before uncovering them. If current access cannot be reconciled, discard those rows and fetch authorized history. Clear markers with sign-out and when dropping the entire corresponding cache namespace, including any pending read generation. A denied or unknown action response leaves the row until an authenticated removal is observed.

## Store and read-path acceptance

Keep the immutable journal available to replication and recovery. Use a conversation-scoped removal index to determine interactive visibility before pagination. Bind each removal to the exact event and its message ID. Never infer a removal by display text, the newest row or the message ID alone. Index a removal before its target if replication arrives out of order. When that target arrives later, apply the marker before exposing it. Preserve the removal in a rebuild from the journal.

- **History and unread.** Exercise chronological browse, the unread window, direct event and message lookup, and exact context on the same removed row. A deleted row must not consume the visible page limit or revive on a peer after an older page arrives. A direct request for a removed anchor uses the same response as an unavailable anchor.
- **List and search.** Seed the removed row as the most recent message. Confirm the list preview falls back to a still-visible message or empty. Search for a sentinel string unique to the removed text and confirm it never appears in local or merged results. Keep the older visible message available.
- **Incremental sync.** A fresh reader sees the removal marker without seeing the original payload. A reader that already holds the row sees the marker after its current cursor and evicts that exact row. Exercise a stale page before and after the marker, as well as a store rebuild and cursor restart. Conversation-level tombstones retain their existing meaning.
- **Dependent content.** The target's quote previews, pin text, reactions and media authorization must stop resolving through it. A shared attachment's unaffected occurrence must still resolve. Forwarded copies in other conversations remain independent. An ordinary agent session started after deletion must omit the removed occurrence from generated context.
- **Replica compatibility.** Verify removal-before-original, duplicate replay of one fact, two different facts for one target, mismatched target identity, and a stale peer returning a prior snapshot. Keep the feature off until every serving reader can apply or respect the removal state. An older peer serving the original is an activation failure. It may retain journal bytes only while excluded from interactive reads.

## Storage checkpoint

The first runtime checkpoint defines and tests a local journal fact and its derived lookup. It adds no signed route, new network kind registration, or client advertisement. The app cannot create or project a removal until the admission, replica and read changes can ship together. The lookup distinguishes an absent matching fact from unresolved creation or index evidence. It can look up any valid occurrence fact for visibility or a specific fact ID for a request receipt. Event, derived row and byte checkpoint are indexed in one transaction. Negative proof checks the journal bytes against both indexes and caches only complete evidence for that file checkpoint and SQLite write generation. Byte disagreement or an event without its derived row yields unknown, including when the index files reopen. A route may acknowledge removal only after confirming the exact indexed fact backed by durable journal bytes.

The fact carries the conversation key, its own event ID, the exact target event ID, the target message ID, timestamp and custodian machine ID. It stores no message text. The derived table admits multiple distinct candidate bindings so a mismatched arrival cannot block a later valid one. Only a candidate from the machine named by unique creation evidence may take effect. The target event/media kind and both identifiers must match. Creation or original arriving later cannot change which IDs the fact names. Raw journal access stays available for trusted recovery, replication and writer reconciliation.

## Frontloaded decisions

The write route, when mounted, accepts one exact confirmed target and uses the same request intent at one signed custodian. Before append, persist the actor-scoped request reservation and the digest of the custodian, conversation and resolved target. The derived fact ID binds the request ID. Derive the removal event ID from the custodian, actor and request ID. A retry can acknowledge only the exact durable fact matching that reservation. Changed intent conflicts. A matching reservation with conclusively absent bytes may resume only on its original custodian after current authorization and target revalidation. Incomplete proof remains unknown. Projecting a removal into mobile sync needs authorization against the retained original access stamp, independently of whether the row itself is currently visible. Stop sync before the marker when original authorization cannot yet be determined, leaving the cursor before the fact and returning no later entries. Resume the same cursor after the original authorization evidence arrives. Consume a conclusively denied marker without exposing its IDs and continue to later entries. Recheck successful history and exact reads after awaited peer and pagination work. Before enabling Delete for a conversation, route interactive projections for that conversation to its immutable creation custodian. Fail closed while that custodian or its indexed visibility evidence is unavailable. Pool lists and search cannot fall back to a peer copy. Persist the authoritative-read requirement independently of the write flag. Keep it across disablement, transfer and downgrade, including while the custodian is unavailable. Only an upgraded custodian can serve affected interactive reads. Activation requires a version-independent front-door check that excludes incompatible serving builds, including during downgrade.

## Decision points touched

| Decision | Classification | Authority and evidence |
| --- | --- | --- |
| Exact target binding | invariant | basis: irreversible-consequence; evidence: removing the wrong occurrence can hide unrelated content. |
| Creation custody | invariant | basis: external-constraint; evidence: the existing unique creation record and active serving state identify the one admitting writer. |
| Removal proof | invariant | basis: irreversible-consequence; evidence: a negative or unreadable derived row cannot justify confirming success to the client. |
| Projection and broadcast | invariant | basis: irreversible-consequence; evidence: a raw row or unauthorized sync marker can disclose protected content or its existence. |

## Multi-machine posture

A future supported removal fact replicates through the existing App event journal. The decoder and authenticated sender must agree on custodian identity, and an index waits for unique creation evidence before using that fact. The storage checkpoint adds no network ingress. Before activation, confirm peer freshness, version compatibility, authenticated sender binding and recovery from missed replication. A local fact cannot authorize success on another machine merely because the client switched routes.

## Maturation plan

- **test-agent-live:** Enable only after the signed action and permitted reads are wired in an isolated throwaway agent. Exercise restart, out-of-order replication and cache overlap.
- **dev-agent-live:** Keep off until full candidate verification and native confirmation.
- **fleet:** Keep off pending compatible peer and client versions and actual acceptance of all read surfaces.
- **graduation criterion:** Exact confirmed removal survives reopen, replication and stale page merges without disclosing the original text or altering any unaffected occurrence.
- **dark-window:** Review within 14 days of the runtime merge and record any failed condition with the next review date.
- **ladder:** mobilePairing.native

## Signed admission checkpoint

Fresh admission runs the exact-message device authority, then checks current conversation read access, unique creation custody, active serving status, conversation ownership, the current delete grant and exact row access. It takes a signed JSON object containing exactly `custodianMachineId`, `eventId` and `requestId` on the path that names the conversation. Denied, missing, unreadable and ambiguous targets share one response once custody and conversation authority are established. An unavailable custodian returns the same result for any target ID.

The first implementation admits the recorded conversation owner. A legacy owner conversation admits its owner profile when the server has a stable named person or owner account identifier. A named owner must match the current signed person in the creation machine namespace. The pairing namespace and serving machine ID must agree. Broader conversation grants do not confer ownership. The existing device signature binds the sending key and original request, but does not authenticate a historical person assignment. Author-based admission must wait for immutable person evidence so that reassigning a device cannot transfer a former person's removal rights.

The admission result is internal. It includes a derived fact ID bound to the custodian, signed pairing, current person identity and request ID, and a digest that also binds the conversation and exact message occurrence. A later handler must persist and compare these values before touching storage. The namespace uses the signed device key and named user ID, or owner account identifiers for unnamed owner profiles, so an owner account change does not inherit the old namespace. The fresh-admission helper issues no receipt and does not reserve, append, advertise or expose a production route. This keeps the storage and authorization checkpoints separate from the visibility change. Retry and recovery will run before fresh admission when the client already has a recorded request. They still require current signed scope and must not disclose original text.

## History projection checkpoint

Use an explicit removal-aware read on the creation custodian. Read the page or exact candidates from the same SQLite snapshot used to establish removal integrity. Filter by the authoritative machine, conversation, event ID and message ID before applying the page limit. Derive the backward cursor from the last visible tuple selected by the query. A missing integrity proof must produce an unavailable read, never an unfiltered fallback. Raw journal reads stay separate for receipt recovery and replication.

Exact context starts with the authorized anchor. If a known removal matches that anchor, return the same unavailable result as a missing or unreadable target. The earlier-message query uses the visible window, but the server must also recheck the anchor and every returned row against current removal evidence immediately before sending a response after asynchronous work. A changed snapshot must be retried or refused as a whole. A legacy identifier that can name multiple rows must remain ambiguous until the ordinary access check resolves it.

Use one fixture across browse and exact context: insert an older visible row, a visible anchor and a newest removed row. Fetch a page of one row and require the visible anchor, with the older row available on the next page. Direct exact lookup of the newest row must be unavailable. Add a second fact with the wrong target message ID and verify that it cannot hide the older row. Then add a valid removal of the anchor while the context response is paused, and require the response to withhold it. Exercise a replica with no removal evidence and prove it cannot act as the authoritative read source.

---
title: App Message Delete
slug: conversation-message-delete
author: echo
status: draft
tier: 2
---

# App Message Delete

The first increment hides one exact occurrence in an App conversation after an authorized person confirms Delete. It starts off. The client captures the paired machine, conversation and settled message event when the action is selected. A forwarded copy has its own occurrence. Removing one occurrence cannot remove a copy elsewhere.

## Signed action and authority

Use a device-signed action scoped to a live App conversation, exact event ID and request ID. The existing People policy supplies the current actor and row visibility. An eligible conversation owner may remove a visible occurrence. An eligible author may remove their own operator occurrence while their write grant is current. Establish author identity from recorded person and signed evidence, never display names or the current owner of an old device. Ambiguous or missing authorship grants no author privilege. Require active serving custody on the immutable creation machine for a first write. Same-intent retries keep the signed scope and return the recorded outcome. A changed target under the same request ID conflicts. An unresolved write cannot authorize a replacement mutation.

## Visibility and durability

Persist an immutable removal fact naming the original exact event and message IDs. Keep the fact valid if it reaches a replica before its target. Once removed, the occurrence cannot appear as visible history, an exact link or a quote preview. Apply removal to every server-side projection before exposing text, including incremental sync, search, preview, pins, reaction state, media authorization and future session context. For incremental clients, carry a removal instruction containing only the IDs needed to evict the cached row. Older readers must be kept from serving this conversation once they cannot enforce the removal fact. Include authenticated requests against stale replicas and old clients in the activation tests.

Retain original journal bytes under the existing storage policy. Message removal is a visibility action. Verify and describe what remains in historic transcripts, backups, downloaded files, and copies already sent to another conversation. Attachments must become unavailable through the removed occurrence. Shared bytes and references held by other authorized occurrences keep their own lifecycle. Removing a message does not itself request storage purge.

## Client and provider boundary

Show Delete only for a live capability and a settled row with an eligible action. Confirm on the captured target. Evict that row after an accepted response or an authenticated removal event. Leave the existing draft and other message actions intact. A denied or unavailable result must not remove a different row. The client must distinguish an unresolved request from a completed removal.

Telegram mirroring follows the App action. It requires an exact verified provider mapping and independent provider authority. Report the two outcomes separately. The App copy can be removed even if Telegram fails or is unavailable. No substitute mutation can run when the mapping is missing.

## Related work

- Exact App message links and Reply for target identity, quote visibility and signed recovery.
- App Forward for separate occurrence identity and stale client boundaries.
- App attachment purge for reference lifecycle and authorization.
- Mobile unread and pool history for replica and incremental payloads.

## Overlapping reads and cache ordering

Name the mobile feed event `message-removed`, distinct from the existing conversation tombstone. It carries the exact removed event ID and the destination conversation scope. The paired and authorized feed establishes the account scope. Use the event ID as the merge key even when the retained message row also has a legacy message ID.

A confirmed action response or authenticated feed event records a removal marker before applying any history merge. Scope markers by pairing, conversation and exact event ID. Apply markers to the current view, delayed history pages, exact context and any restored cache. Persist the marker and evict the row together when the client has durable history. A history page cannot clear a marker or revive that occurrence, even if the page was fetched later from a lagging replica. Keep markers across pagination, cursor changes and restart. Clear them with sign-out and when dropping the entire corresponding cache namespace, including any pending read generation. A denied or unknown action response leaves the row until an authenticated removal is observed.

## Store and read-path acceptance

Keep the immutable journal available to replication and recovery. Use a conversation-scoped removal index to determine interactive visibility before pagination. Bind each removal to the exact event and its message ID. Never infer a removal by display text, the newest row or the message ID alone. Index a removal before its target if replication arrives out of order. When that target arrives later, apply the marker before exposing it. Preserve the removal in a rebuild from the journal.

- **History and unread.** Exercise chronological browse, the unread window, direct event and message lookup, and exact context on the same removed row. A deleted row must not consume the visible page limit or revive on a peer after an older page arrives. A direct request for a removed anchor uses the same response as an unavailable anchor.
- **List and search.** Seed the removed row as the most recent message. Confirm the list preview falls back to a still-visible message or empty. Search for a sentinel string unique to the removed text and confirm it never appears in local or merged results. Keep the older visible message available.
- **Incremental sync.** A fresh reader sees the removal marker without seeing the original payload. A reader that already holds the row sees the marker after its current cursor and evicts that exact row. Exercise a stale page before and after the marker, as well as a store rebuild and cursor restart. Conversation-level tombstones retain their existing meaning.
- **Dependent content.** The target's quote previews, pin text, reactions and media authorization must stop resolving through it. A shared attachment's unaffected occurrence must still resolve. Forwarded copies in other conversations remain independent. An ordinary agent session started after deletion must omit the removed occurrence from generated context.
- **Replica compatibility.** Verify removal-before-original, duplicate removal, mismatched target identity, and a stale peer returning a prior snapshot. Keep the feature off until every serving reader can apply or respect the removal state. An older peer storing or serving the original is an activation failure, even if it ignores the new event type.

---
title: Send Only Changed Rows In Telegram And Slack Chats
slug: telegram-slack-change-feed
status: approved
tier: 1
approved: true
approved-by: "Echo (agent), reversible read-only page diff; Justin authorized the parity work in topic 145738"
eli16-overview: docs/specs/telegram-slack-change-feed.eli16.md
---

# Send Only Changed Rows In Telegram And Slack Chats

## Problem

The web chat requests the newest 50 Telegram or Slack messages every five seconds and a full pool page every 30 seconds. Most returned rows are unchanged. Work card `wc_1cd7f517af0e78ee` and parity row W10 ask for smaller updates without losing the messages, delivery marks, media or origin information the existing polls provide.

## Design

Both existing history routes accept optional `knownRows`, a comma-separated list of complete SHA-256 row digests. An empty string starts a fresh baseline. Absence keeps the existing plain read unchanged. Inputs are bounded to 100 lowercase 64-character hexadecimal digests and 6499 characters. Arrays, malformed values and combinations with backwards-history parameters return 400. The web chat requests 50 rows, so its usual query is about 3.3 KiB before query escaping. Authentication, device signing and audience checks remain unchanged.

The server builds exactly the same bounded current page as a plain read, including origin joins, store/platform deduplication, device media shaping and signature stripping. Only then does it hash each complete emitted row. The response contains only rows whose digest is absent from `knownRows`, in their original page order, and `changeFeed: { rowHashes: [...] }` containing the FULL page's ordered digest list. Read positions, pins, backwards cursors and pool failure metadata remain outside the message diff and are returned normally. A caller that claims to hold a digest can omit only that exact row from its own response; this grants no additional read authority.

This is a payload diff of the existing newest page, not a durable ingestion cursor. It preserves all rows that the previous five-second bounded full-page poll would show. It does not expand that page's existing history coverage or implement edits/deletes at the platform. Message text, delivery state, media and origin changes alter the digest and therefore resend the row. Late or future timestamps never determine inclusion. Rotation, restart, source changes and row reordering cause harmless retransmission rather than skipped rows. Identical repeated rows can share a digest; the ordered full hash list retains their positions.

## Web Chat And Multiple Tabs

The leader keeps the actual full quick-page rows together with their hashes, atomically, for each conversation reference. It sends hashes only for a baseline whose rows it retains. A request captures that exact baseline before awaiting the response. It reconstructs the complete current page by walking the returned full ordered digest list: reuse a row from the sent baseline when known; otherwise consume the next changed response row. Only a complete, validated reconstruction is broadcast, with an internal marker indicating that the broadcast already contains the full page. Every receiving tab can then retain the same row/hash baseline. A newly opened tab, new leader or reopened view must never learn hashes for rows it has not retained.

Malformed or inconsistent metadata invalidates the baseline; no incomplete page is represented as complete. The next quick request sends an empty baseline. An older agent or holder ignores `knownRows` and returns its normal full page without metadata; the client uses that page and does not adopt digest state. The existing 30-second pool read remains plain. First-load and scroll-back behavior remain unchanged.

The initial unshipped `after` timestamp design is replaced, rather than retained as a competing interface. Review found that an old stored Slack row could be removed before deduplication and replaced by a newer raw mirror. A future-dated row could also suppress ordinary quick-poll arrivals long enough to introduce gaps beyond the existing newest-page limit. Final-row hashing avoids both defects without changing the underlying storage systems.

## Multi-Machine Posture

Unified by the existing proxied-on-read history paths. Telegram pool reads first complete their current own-row-wins merge and privacy shaping, then compute the diff. The signed pool protocol stays unchanged because peers still return their normal bounded history pages. Slack holder reads forward `knownRows` to the trusted holder with the existing owner revalidation, body limit and device-view checks. Older holders return a full page. No new durable machine-local state, replicated schema, configuration or credentials are introduced.

## Decision Points Touched

- Digest syntax, count, length and incompatible query parameters: invariant; these are structural API validation.
- Omitting a row only when its entire final digest was supplied: invariant; exact byte-content identity, not semantic message filtering.
- Client baseline adoption: invariant; complete hash/row correspondence is required before claiming a full current page.
- Existing authentication, owner/device admission, media privacy and pool origin authority: unchanged.

There is no new judgment gate, outbound-message authority, session lifecycle operation or UI element. Reference: `docs/signal-vs-authority.md`.

## Acceptance And Tests

- Plain reads stay unchanged; an empty baseline returns a full page; an identical repeat returns no message rows but the full digest list.
- New arrivals with old or future display times are returned. Changing only delivery, media or origin fields resends the row.
- Device and pool reads hash the final authoritative row; a newer raw platform mirror cannot replace a stored verified caption or leak a private path.
- Hash validation exercises both sides of count/length boundaries and incompatible backwards cursors.
- Slack trusted-holder forwarding retains revocation and device privacy behavior; legacy holders fall back to full pages.
- The browser reconstructs full pages before cross-tab broadcast; new tabs, leader changes and reopened views cannot suppress unseen rows.
- Unit and HTTP tests run locally in targeted files. Full unit/integration/E2E/build validation is delegated to the shared Local Verify owner for the exact final PR head, per the Chief of Staff handoff. Maintenance holds are not released by this task.

## Rollback

Revert the PR. No migration or agent-state repair is needed. Clients sending `knownRows` to older servers receive the normal full page and discard digest state. Native apps retain their current behavior until they adopt this optional protocol.

## Open Questions

None.

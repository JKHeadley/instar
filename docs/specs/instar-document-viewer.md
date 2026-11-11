---
title: "Instar Documents: commentable, team-private, conversation-linked documents"
slug: "instar-document-viewer"
eli16-overview: instar-document-viewer.eli16.md
author: echo
created: 2026-11-10
status: converged
approved: true
approved-by: "justin (telegram topic 141469, message 141587, \"Approved\", 2026-11-10 15:19 PST)"
parent-principle: "The Person Decides; the Agent Does the Rest (STANDARDS-REGISTRY), applied to documents as the approved text of Rule 123 directs. Rule 123: An Instar Agent Always Serves a Team (approved by Justin 2026-11-10 in topic 141014; being written into both rule books on branch echo/rule-123-team by the session in topic 141014; this build does not wait for that merge because the rule's text is approved and this spec applies it directly)"
origin: "Justin, 2026-11-10, topics 141014 and 141469"
lessons-engaged: "P21 An Instar agent is always a multi-machine entity (unified rows by vector pull, §5); No silent degradation (size and rate drops refused out loud, §5.3); P19 No unbounded loops (peer poll, pending re-check, re-anchor and compare jobs, §5.1, §3.5); P7 LLM-supervised execution (Tier 0: these loops are deterministic, bounded and observable in GET /docs/health, no model in the loop); P17 Bounded notification surface (one push per pass through MobilePush, §4.9); P24 Never silently cut decision data (session-start overflow line, §3.7); P20 Verify the state, not its symbol (§7); Signal vs Authority (all access decisions deterministic, §6); work in other repositories has an owner (app work owned, briefed and on the completion bar, §4.5)"
review-convergence: "2026-11-10T22:09:13.509Z"
review-iterations: 6
review-completed-at: "2026-11-10T22:09:13.509Z"
review-report: "docs/specs/reports/instar-document-viewer-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
clean-door-anthropic-review: "claude-code:claude-fable-5-2"
single-run-completable: true
frontloaded-decisions: 13
cheap-to-change-tags: 0
contested-then-cleared: 2
---

# Instar Documents

## 1. Problem statement

When an agent shares a document today it uses the private viewer (`POST /view`). The page is read-only. The operator reads it, then retypes their reactions in chat without the passage they refer to, which is slow for them and imprecise for the agent.

Justin's brief (2026-11-10, topic 141014, restated in topic 141469): something Instar-native that works like Google Docs. Read a document, select any passage, comment on it, then tell the agent to read the comments. The agent replies under each comment and revises the document. It becomes every agent's default way to share a document.

Two further requirements from the same day:

1. **Team-compatible from the start** (Rule 123): a document is private to the person it was made for by default, can be shared with chosen people or the whole team through the same owner-signed access records as the rest of team support, and members and guests see and comment only on what they have been given. It works on every machine, so a machine switch can't lose a comment.
2. **Conversation-native** (Justin, topic 141469, 13:03 PST): "documents should be at least internally linked to relevant topics in a way that assists a sort of general knowledge graph ability for an Instar agent to traverse related content, and also so that a document has a primary conversation linked to it so it knows where to collaborate with the user on discussions related to that document."

And one process requirement (Justin, 13:14 PST): all needed functionality ships in this work, the iPhone app included; every piece has an owner and a plan (§4.5).

## 2. What exists (instar main 333660390, read from code)

- **Private viewer** `src/publishing/PrivateViewer.ts`: one JSON per view in `<stateDir>/views/`, overwritten in place, rendered server-side under `VIEW_SANDBOX_CSP` (no scripts, no forms; `src/server/middleware.ts:912`). Links carry a non-expiring HMAC of the path, not tied to a person. Machine-local. It cannot host comments by design.
- **Console** pages run under `script-src 'self' 'unsafe-inline' cdn.jsdelivr.net` (`middleware.ts:925`) on the origin that holds the owner's stored browser key. Team spec Frontloaded Decision 8: no non-owner gets a console.
- **Team access** (`docs/specs/team-roles-and-access.md`, steps 2a and 2b both merged, 2b in #2933): `OrgRole` → tier (`src/permissions/TeamAccess.ts`); the owner-signed, origin-chained, replicated access log (`src/core/TeamAccessLog.ts`, `TeamAccessMerge.ts`, `TeamAccessSync.ts` vector pull); the conversation check `mayUseConversation(person, ref, …, op)` (`src/core/MobilePeople.ts:178`), which for legacy `msp` phones returns true on every `telegram:` ref (`MobilePeople.ts:194–197`); message-level read decisions from immutable stamps (`mayReadMessage`, `TeamAccessMerge.ts:241`); confined places and `confined.json`; non-owner sends into owner-reach sessions refused `403 read-only-owner-reach`.
- **Inbound paths a person's message takes**: Telegram-topic messages from the app enter through `ctx.mobileInbound.ingest` (`telegramForwardHandler`, `src/server/routes.ts:29515`), called by `POST /mobile/chat/:topicId` (`src/server/mobilePairingRoutes.ts:1803`), which also enforces the lease holder (`409 not-serving`), keeps idempotency in `MobileChatRequestStore`, and mirrors the message into the Telegram topic. App-conversation messages enter through `POST /mobile/chat/app/:key` (`src/server/mobileConversationRoutes.ts:733–1000`), which builds a signed origin from the device signature, runs the emergency-stop sentinel, lease routing and dispatch.
- **Replication transports**: the coherence journal caps a replicated line at 80 KiB and drops larger ones with only a counter (`CoherenceJournal.ts:417`, `1106–1108`), rate-caps at 100 burst / 50 per second and drops the excess (`:421`, `:1075`), and serves only a machine's own stream. `TeamAccessSync` pulls self-verifying rows by version vector and relays through any peer.
- **Push**: `MobilePush.ts` is the chokepoint (2-minute fold, hourly after 40 pushes in 24 h, dedupe); `PushTrigger.kind` is `'item' | 'notice' | 'reply'`.
- **Links today**: `InitiativeLink { type: 'doc' | 'topic' | … }` on initiatives/projects; Telegram-only, machine-local topic-project bindings. No general graph.
- **iPhone app**: separate repository `apps/instar-ios` on the Mac Studio, no remote, owned by session `echo-instar-app` (topic 134088). Already-paired phones declare no per-request capabilities (`appCaps` is read only at pairing, `mobilePairingRoutes.ts:1188`).

## 3. Proposed design

### 3.1 Who can see a document: its conversation

Every document has exactly one **primary conversation**, and **the document's audience is that conversation's audience**. There is no separate per-document grant. This is the central decision; it makes comments, Send, the agent's sessions and the link graph all follow one existing confinement model:

- A document in the owner's own chat is visible to the owner only. That is the default for anything the agent makes for the owner: private by default.
- A document in a person's own app conversation is visible to that person and the owner (members are told the owner can read everything, as today).
- A document in a shared conversation is visible to everyone that conversation is granted to, at their grant level. This is the one stated exception to "what a person creates is private to them" (Rule 123): a document made in a shared place is a message to that place, like any message there, and a confined shared session has no single requester to own it. A member who wants a private draft asks in their own conversation.
- **Sharing with chosen people** is one owner action on the phone: "Share with…" picks people, and the phone runs three existing-style signed requests (§4.2): create a conversation shared with them (or pick an existing one), grant it, then `primary-set` the document there. **Whole team** is the same action with everyone selected. Both use the existing signed grant events, so access is granted only through the owner's signed team record.
- **Once shared, always confined** (the team spec's rule for conversations, §3.5). A document that has ever had a primary conversation with a non-owner audience is marked confined for good: it can move only to another shared conversation, never back into an owner-only one, and owner-reach sessions see only its metadata forever. Copies of it are confined too. Moving an owner-only document into a shared conversation publishes its whole history to that audience (the same as granting a conversation, team spec Frontloaded Decision 7); the phone's share sheet says so in words before Face ID: "Everyone in Instar Docs will see this document, its earlier versions and its comments."

Because a shared conversation is a confined place (team spec §3.5), the session that reads its documents' comments is always confined to that same audience. Non-owner text never reaches an owner-reach session through documents, and the agent's replies in a shared document can't carry owner-private memory, because the confined session doesn't load it.

**Supported primary conversations**: Telegram topics and app conversations, the two kinds the team model can share. A document started from a Slack conversation gets the owner's own app conversation as its primary (created if missing) and a `discusses` link to the Slack conversation; the Slack thread gets the document link. Slack conversations can't be shared in the app (`grantRefusal` → `slack-not-yet`, owned by the team spec's Slack step), so this keeps the document private and still reachable from Slack; if the team spec later makes Slack conversations shareable, a Slack conversation becomes a valid primary with no change here beyond accepting the `slack:` ref in `placeOf`.

### 3.2 The access rule

One pure function, `mayDoDocument(principal, doc, op, teamState)` in `src/documents/DocumentAccess.ts`, `op` ∈ `read | comment | send | resolve-own | resolve-any | revise | delete` (`delete` = tombstone: the owner phone and the document's owner person only; purge: the owner phone only):

| Principal | read | comment / send | resolve | revise |
|---|---|---|---|---|
| Owner, on the phone or a browser approved through the owner's channel (not `dashboard-pin`) | yes | yes | any | yes |
| Dashboard PIN session alone | owner-only documents; metadata of shared ones | no | no | no |
| Team person with `mayUseConversation(p, primary, 'read')` | yes | if also `'send'`, `!teamRefusal()` and not `sendReachesOwner` | own comments | if the document's owner person is them |
| Guest | read only | no | no | no |
| `msp` phone (legacy role) | **no** (no conversation-derived standing on documents) | | | |
| Agent session | §3.3 | | | |
| Anyone else | `404 unknown-document` | | | |

Every refusal by `mayDoDocument` is `404 unknown-document`, so a person can't probe; refusals that come later (`403 access-being-checked`, `409 not-owner`, `403 presence-required`) are only ever returned after read standing has been confirmed. Ownership of a person's own app conversation is decided from the conversation's own record (its home machine and the team log's `conversation-own` row), never from which machine is checking, so every machine reaches the same answer.

**Freshness**: a machine accepts a non-owner's write only when the team log's own staleness rule (team spec step 2b: no visible gap, no held person) lets that person act there; otherwise `403 access-being-checked` ("Checking your access with the other machines. Try again in a moment."). No wall clock is compared. On the peers, a person's row is re-checked against the immutable team rows its `access` vector names; a row concurrent with a revoke of that person (the revoke not in its `access`, and the row not an ancestor of any row that knew the revoke) is withheld from everyone and counted in `GET /docs/health`, so once machines reconcile, a revoked person's writes made on a stale or partitioned machine are suppressed everywhere. This is retrospective: while a machine is cut off it can still serve someone revoked elsewhere (the team spec's inherited partition limit; its `strictStaleness` setting closes it by refusing non-owners on a machine that can't confirm). `mayUseConversation` gains a guard that refuses any `doc:`-prefixed ref, and the documents code always passes refs in their prefixed form, never a bare document id (a bare uuid is a valid app-conversation ref, `MobilePeople.ts:168`), so no document id can ever satisfy a conversation check.

### 3.3 The agent's access, by session place

- Places are compared with `placeOf(primary)`, the same place resolution sessions use (an unshared Telegram topic resolves to its group's place, a shared one to its own `placeKey`), never by comparing refs.
- A **confined session** (shared place or a person's own conversation) may read, comment on, revise and reply in documents whose primary conversation is its own place, and may create documents there. Nothing else. The check is in the route handlers (`memorySessionAllows` is a pure path check, `memorySessionGuard.ts:88`): the route resolves the session's place and compares it to the document's primary place. Peer-agent places are denied (`denyPlacePrefix`, as similar routes do). The session's `placeKey` is recorded on every event it writes.
- An **owner-reach session or the bearer token** may read and write documents whose primary conversation is owner-only (the owner's own chats). For every other document it gets metadata only: `{ id, primary ref, the conversation's owner-chosen name, version number, counts }`. No title, note, link reason or author name, because any of those can be text a member wrote or steered; the page and replies say "a document in Instar Docs". `GET /docs/session-context` takes the place from the session's own token and ignores any `conversation` parameter from a session caller. Asked to read the comments of a document that moved to a shared conversation, it answers: "That document now lives in Instar Docs. I'll read the comments there." Sharing adds a `discusses` link from the document back to the chat it came from, so the trail is kept.
- Every agent write is `actor: { type: 'agent', placeKey }`. Nothing written by the agent or the bearer token is ever attributed to the owner. Owner-attributed events come only from the owner's phone signature. **Every person write is signed by a device that belongs to that person**: their phone, or a browser approved as one of their devices (§3.6). A dashboard PIN session is never enough, because the agent can read the PIN from its own config. A PIN-only session sees owner-only documents and the metadata of shared ones, and writes nothing. So the guarantee that non-owner text never reaches anything the agent can drive, and that nothing the agent drives can write as a person, holds structurally. Moving and sharing need the owner's phone (Face ID).

### 3.4 The document stream

A document is an append-only stream of immutable rows, each self-verifying, modelled on team access step 2b:

```
DocRow = {
  docId, origin: machineId, incarnation, seq, prevHash,     // per-origin chain, as TeamAccessLog 2b
  eventId: uuid, eventKind, receivedAt,                      // receivedAt is display only, never ordering
  actor: { type: 'owner-phone', signedOrigin }               // the phone's whole signed request
       | { type: 'person', personKey, deviceId, signedOrigin }        // required: in-app writes are phone-signed (§3.6)
       | { type: 'agent', placeKey },
  access: Vector,                                            // team-log vector the accepting machine decided under
  docDeps: Vector,                                           // this document's rows the writer had seen: origin/incarnation → highest seq
  primaryRow: rowKey,                                        // the primary-set (or created) row in force when standing was decided
  ...kind fields (small metadata only),
  payloadHash?,                                              // sha256 of the row's content blob (body, chunk text, title), if any
  machineSig                                                 // accepting machine's identity key over all of the above
}
```

**Content blobs.** All text (version chunks, comment and reply bodies, titles, link reasons, and every anchor's `exact`, `prefix` and `suffix`, including long-selection head and tail) lives in separate content blobs keyed by `payloadHash = sha256(salt ‖ text)`. Version chunks use one secret salt per document (itself a blob, replicated with the document's blobs, deleted on purge; a prune keeps it, so pruned text stays checkable against guesses by anyone who could already read the document, which is a storage feature, not a privacy one), so an unchanged paragraph has the same id in every version and is stored once; comment, reply, title and reason text use a random per-blob salt. Either way a purged short text can't be confirmed by guessing, stored beside the stream and pulled with it. Rows sign and chain over the hash, never the text, so a purge can delete text while every row still verifies (§3.4 purge). A blob is ≤ 48 KiB **as serialized on the wire** (the split is measured on the encoded bytes, so escape-heavy text splits into more pieces, never larger ones).

The accepting machine decides standing with `mayDoDocument` against its folded team state and the document's primary in force, records the team-log vector, the document vector and that primary row, and signs the row. Any machine verifies the signature and the chain. A peer that holds the team rows named in `access` re-checks the decision from those immutable facts (the same rule as `mayReadMessage`), so every machine reaches the same answer without depending on arrival order; a peer that lacks them holds the row as **pending** and re-checks when its team log advances. A row whose decision fails on re-check is ignored and counted (`GET /docs/health`). Revocation is effective from the revoke row onward; rows accepted before it stand, exactly as messages do.

Event kinds (the replicated format; each validated identically on every machine):

| eventKind | fields | who may write |
|---|---|---|
| `created` | `title` (write-side default ≤ 120 chars, no control characters), `ownerPerson` (`'owner'` or personKey, from the primary conversation's `conversation-own` row or the owner), `primary` (conversation ref), `createdFrom` (ref) | agent; owner; a person in their own conversation |
| `version` | `versionId`, `label`, `parents: versionId[]`, `contentHash`, `projectionVersion`, `chunks: number`, `note?`, `addressesHash?` | agent; owner; the document's owner person |
| `version-chunk` | `versionId`, `index`, `payloadHash` (blob ≤ 48 KiB serialized) | same row author as its `version` |
| `comment` | `commentId`, `anchor` (§3.5, text in a blob), `body` blobs (total set by the write-side limit), `onVersion` | principals with `comment` |
| `comment-edit` | `commentKey`, `body` | the comment's author |
| `comment-reanchor` | `commentKey`, `anchor`, `onVersion` | the comment's author |
| `reply` | `commentKey`, `replyId`, `body` blobs (total set by the write-side limit) | principals with `comment`; agent |
| `resolve` / `reopen` | `commentKey` | author; document owner person; owner |
| `addressed` | `commentKeysHash` (the list in a blob), `versionId` | agent |
| `send` | `batchId`, `commentKeysHash` (the list in a blob), `primaryRow`, `messageRequestId` | the person's device, for their own comments |
| `link` / `unlink` | `edge` (§3.7) | agent (in its place); owner |
| `primary-set` | `primary` | **owner phone only** |
| `title` | `title` | agent; document owner person |
| `tombstone` / `purge` | — | owner phone; document owner person (`tombstone` only) |
| `prune` | `versionIds[]` | owner phone |
| `place-disclosure` | `grantRow`, `heads` | the place's serving machine (machine-signed) |
| `device-seen` (stream `_devices`) | `deviceId` | the machine that served the call (machine-signed) |

A comment is identified by `commentKey = authorKey + ':' + commentId`, so a client-minted id can't collide with someone else's; reusing an id with different content is `409`. Every write is idempotent by `eventId`.

**Versions**: `versionId` is a uuid; `parents` names what it was based on. Each version gets a stable `label` when it is written: one more than the highest label among the versions in its `docDeps`. It never changes afterwards, so "version 4" in a message stays true. Two versions written at once can share a number; they are shown as "Version 4 (Mara's edit)" and "Version 4 (Echo's edit)". Two versions made at once on two machines both survive: the page shows "Two edits were made at the same time" with a compare link, the latest is the later one in fold order, and the agent's next revision names both as parents.

**Fold order**: a deterministic topological order over `docDeps` (a row comes after every document row it had seen), ties broken by origin id then `seq`. Resolve/reopen, edits, titles and "latest version" therefore follow what each writer actually saw. Wall-clock time never orders rows.

**Who sees which rows.** Agent rows carry two stamps: `access` (the accepting machine's team vector, used to decide standing) and `sessionAccess` (the session's launch-time vector, stamped by the server from the session's spawn record, never supplied by the session, and never later than `access`), as team step 2b stamps agent messages. Visibility for a reader of the document's current place:
- **The move is the disclosure, and the owner signs exactly what is disclosed.** The app first fetches the document's heads (`GET /mobile/docs/:id/summary` returns them), shows the share sheet's description of that history, and puts those `docDeps` inside the presence-signed `primary` request body. A machine rejects a `primary-set` whose signed `docDeps` names rows it doesn't hold, or rows that turn out to descend from or be concurrent with it. Every row that is an ancestor of it (in `docDeps`) is visible to that audience.
- **Rows after the move** follow the team 2b message rule (`mayReadMessage`) on their `sessionAccess` against the reader's grants on the place: a row written by a session that didn't yet know a reader had been added is withheld from that reader, exactly as messages are.
- **Rows concurrent with the move** (authorised under the old primary, neither ancestor nor descendant of the `primary-set`) are withheld from the new audience, so an owner-reach session writing at the moment of a share can't leak into it.
- **People granted the place later**: the team spec opens a conversation's history to a new grantee (Frontloaded Decision 7), but its grant vectors record message rows, not document rows. So when the place's serving machine (`servingMachineFor(ref)`, the single writer) folds a new `grant` for the place, it writes into each document of that place a machine-signed `place-disclosure { grantRow, heads }` row. Because a vector of heads describes a prefix, not a selection, the covered set is defined by a predicate over immutable facts: **the rows at or below `heads` that are visible to the place's existing audience under this section's rules**, evaluated against the row's own stamps and the `primary-set` it descends from. Rows withheld as concurrent with the move or by the 2b rule stay withheld even when they sit between visible rows of the same origin (tested with interleaved eligible and withheld rows). This is the signed proof that the new grantee may see that history.
- **Rows by people and by the agent after that** follow the team 2b rule's second clause exactly as `mayReadMessage` does: a reader sees the row if the row's `access` vector (for agent rows, `sessionAccess`) includes the reader's grant row, or a `place-disclosure` for that grant covers it. No place "generation" is used (team step 2b replaced generations with these vectors). Tested with a grant made after a share that raced an owner-reach write, and with a grant racing a comment across two machines, on the real fold.

**Descendants of a withheld or ignored row**: rows that depend on it for their meaning (a reply to it, an edit, resolve or re-anchor of it, an `addressed` naming it) are withheld with it from the same readers; a version that lists it in `addressesHash` list simply doesn't show that link to them; rows that merely have it in `docDeps` are unaffected. Tested.
A reader who can't see the newest version sees the newest one they can. The session-start list, counts, confined-session reads and push all use this same per-row filter. Tested by sharing into a new conversation and into an existing one, with a concurrent owner-reach write.

Storage: `<stateDir>/documents/<sha256(docId)>.jsonl`, directory mode 0700, files 0600, appended and fsynced before acknowledging; in `.gitignore`; in the never-served deny layer; **left out of ordinary snapshots** (both `documents/` and `.instar/documents/` added to `BLOCKED_PATH_PREFIXES`, as team access is, `BackupManager.ts:33–52`), because `createSnapshot` copies synchronously and keeps 20 copies, which would mean multi-gigabyte blocking copies and a purge rewriting every snapshot. On a multi-machine agent the peers are the copy. Every agent also keeps a **document export** at `<stateDir>/backups/documents/`: because stream files are append-only and blobs are content-addressed and immutable, the export is built by hard-linking new blobs and appending new rows, asynchronously, so it costs only what changed. A purge deletes that document's blobs from the export too. Documents are restored only by a dedicated merge-restore (`POST /docs/restore`, run by the agent or from the dashboard, since it can only add rows), which reads the export, merges by row identity, never removes a `purge`, `tombstone` or `primary-set` row the machine already holds, skips blobs of purged documents, and starts a new incarnation. So a one-machine agent can recover its documents without rolling back who can see them. The export sits on the same disk, so it protects against mistakes and corruption, not disk loss; on a one-machine agent the page's footer says "Documents are kept on this computer only", and adding a second machine is the real backup. A derived in-memory index (titles, primary, counts, edges, anchor results) is rebuilt at boot from the streams. `purge` (owner phone) is itself a replicated row: each machine deletes that document's content blobs and refuses to store or serve them again; every row still verifies because rows sign over hashes. Every sync response begins with the responder's set of purged documents, and responders never serve those documents' blobs, so a replica deletes and refuses a purged document's text as soon as it learns of the purge. A peer that reconnects first to another peer that hasn't yet learned it may briefly receive the blobs; it deletes them as soon as the purge row reaches it, and the system converges with no copy left. Tested with a stale peer relaying before the purge arrives. After a purge a thread shows "This document's text was removed", with authors and times only; row files and rebuilt indexes contain no excerpts. Tested with an offline peer rejoining after a purge.

### 3.5 Anchoring: comments stay attached to their text

A comment's `anchor` follows the W3C Web Annotation selectors on the version's **plain-text projection**:

- `projectText(markdown, projectionVersion)` in `src/documents/projection.ts`: every `version` row is stamped with the `projectionVersion` it was written under, and the projector keeps every past version (the `marked` lexer is pinned per projection version), so all machines compute the same projection for the same row across rolling updates and dependency bumps. A new projection version is a format change with its own golden corpus.
- The projection itself: tokenise with the pinned `marked` lexer, emit text in document order, collapse whitespace, join blocks with `\n`. One module, served unchanged to the page (§3.6), so the page and the server compute the same string; a golden corpus test pins it.
- `TextQuoteSelector { exact (≤ 2 KiB), prefix, suffix (≤ 48 chars each) }`; `TextPositionSelector { start, end }` on `onVersion`; `blockHint`.
- **The page never sends the browser's selection text.** When it builds the DOM from tokens, every text node carries its start offset in the projection (a parallel map, not attributes in the content). A selection is converted to `(start, end)` through that map, snapping to whole characters, and `exact`, `prefix` and `suffix` are cut from the projection string itself. Selections across list items, table cells and code blocks therefore always match. Golden tests cover those cases in a real browser.
- On write, the server requires `exact` to occur in `onVersion`'s projection; if it is at a different position, the server stores the corrected position. A quote that is not in the document is refused `422 quote-not-in-document`, so nobody can attach a comment to text the document never said. A selection longer than 2 KiB stores its first and last 1 KiB plus the position.

**Re-anchoring** never runs on the request path's critical section: for each new version, one capped diff per (old version, new version) pair (20,000 operations, else paragraph-level) is computed once, shared by all comments, in slices that yield to the event loop; until it finishes, the page shows comments as "placing…". **Re-anchoring** (for a version with two parents, against the parent the comment's version descends from, else the first parent) runs once per (comment, new version), deterministically, lazily on first read of that version, cached in a byte-bounded LRU (32 MiB) beside the derived index (an evicted result is recomputed):

1. **Exact with context**: occurrences of `exact` scored by prefix/suffix agreement and distance from the old position mapped through the version diff; accept the best if unique or ahead of the next by at least 25% of the maximum score.
2. **Fuzzy**: for `exact` ≥ 20 characters, approximate search within ±2,000 characters of the mapped position, in 32-character Bitap chunks; accept at similarity ≥ 0.75, `anchorState: 'edited'`.
3. **Otherwise** `anchorState: 'orphaned'`. Never dropped: listed under "Passage changed or removed" with the original quote, and the agent receives it. The author can re-attach it (`comment-reanchor`).

Bitap and a Myers diff are in-repo implementations because the project avoids new dependencies; their property tests compare against brute-force references written in the tests (an LCS reference for the diff, an exhaustive edit-distance search for the fuzzy matcher), so no package is added even for tests. Compare (`GET /docs/:id/compare?from=&to=`) diffs in two levels: paragraph hashes first, then a word diff only inside changed paragraph pairs, each pair capped at 2,000 edit operations (above which that pair is shown as replaced). It runs as the same yielding, cached background job as re-anchoring; the page shows "Working out the changes…" until it's ready. Results are cached in a byte-bounded LRU (16 MiB). Because the work is bounded per paragraph pair, a large rewrite costs time in slices, never one long block of the event loop.

### 3.6 The document page

One canonical link for everyone: `/docs/<docId>`, served by the agent through its tunnel. It is **not a console page**. It has its own response policy:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none';
require-trusted-types-for 'script'
```

The page's scripts and styles are static files shipped with instar (`dashboard/docs/`), with `marked` served from the package, nothing from a CDN. Markdown is rendered by building DOM nodes directly from `marked`'s tokens (never an HTML string, never `innerHTML`): block and inline `html` tokens become escaped text, link schemes are checked with `new URL()` after entity decoding and kept only for `http:`, `https:` and `mailto:`, remote images become plain links (no tracking pixels), and comment bodies and titles are always text nodes. No sanitizer is needed because no markup from a document is ever interpreted. The page sends `Referrer-Policy: no-referrer`, and outbound links carry `rel="noopener noreferrer"`, so a document's links can't leak its address or the tunnel's hostname.

Who gets in:
- **On a computer, anyone (owner, member or guest)** uses a **browser device**: the browser holds a non-extractable signing key and is one of that person's devices. The browser signs page writes under the `instar-docpage-v1` domain with operation-specific payloads (§3.6, as the app bridge does), signs its own `open` payload (bound to the document) to get a read cookie, and posts Send through the existing chat routes, which browsers may already use (`BROWSER_ROUTES`, `mobilePairingRoutes.ts:2173`, open to member tier at `:2235`). The owner's browsers use the existing approved-browser flow, except that a browser whose ledger activation is `dashboard-pin` can read but never write (anything that can read the PIN could have made it). Members' browsers are new; see **Member browser devices** below. Writes signed by a browser are labelled "from Mara's computer" to people and carry `originClient: 'browser'` for the agent.
- **People in the app**: `POST /mobile/docs/:id/open` (device-signed, §4.2) returns `{ url, code, expiresAt }`, where `url` is `/docs/<id>` on the answering machine's own tunnel origin. `open` is served by the machine the phone talks to. If that machine has no stable origin (no named tunnel; `stableOrigin` is null, `MobilePairing.ts:56`), the answer is `409 documents-need-a-named-tunnel` and the app says "Documents need a permanent address for your agent. Turn on a named tunnel in Settings." Tested with a phone paired only to a machine without a named tunnel.
- `code` is single-use, 60 seconds, bound to `{ personKey, deviceId, docId }`. The app loads `url#code=<code>`; the page posts the fragment's code to `POST /docs/<id>/session` and removes the fragment. The server sets `instar_doc` (`HttpOnly; Secure; SameSite=Strict; Path=/docs/<id>`), valid 30 minutes, re-minted by the app. The cookie authorises only that document's page reads (`GET /docs/<id>`, `/data`, `/versions`, `/versions/:v`, `/compare`, `/links`); it is **read-only**, since every page write is device-signed (§3.6), and it never satisfies dashboard or bearer auth. Every response carrying document text also sends `X-Content-Type-Options: nosniff` and a JSON or HTML content type. Every request re-checks the current access state, so a revoked person loses access on the next request. A forwarded URL carries no access.
- **Links and machines.** Links the agent posts in chat are `/docs/<id>` paths on the lease holder's tunnel; the app opens them through `open`. A browser on any machine authenticates by signing an `open` payload with its device key; every machine can verify it against the replicated binding (`phone-bind` for phones, `browser-bind` for browsers, §3.6a), so reads and writes work on any awake machine and nothing needs re-approval after a lease move. What stays machine-local is only the replay state for single-use codes and nonces, and each machine's cookies. A link naming a machine that is asleep is a stated limit of per-machine tunnels.
- Writes require `X-Instar-Request: 1` and a device signature (phone or approved browser); the cookie only authorises reads.
- **Inside the app, the composer and Send are native.** The page only reports a selection (its projection offsets) to the app; the app shows its own bottom sheet with the quoted passage (cut from the projection the app fetched itself) and the text box, and the app's own bar holds Send. So a page that has been tampered with can at most propose a passage; it can't make the phone sign a comment or a Send the person didn't see and confirm.
- **Inside the app, page writes are signed by the person's phone, under their own signing domain.** The page passes the app a typed request `{ op, docId, fields }`, never a method or path. The app builds the request itself, only for the opened document's page write routes (`comments`, `replies`, `resolve`, `reopen`, `edit`, `reanchor`, `send`), host pinned to the opened origin, and signs it with the device key under the domain string `instar-docpage-v1` bound to that `docId`. The server accepts that domain only on that document's page write routes, and no device-signed route accepts it, so the bridge can't be turned into a signer for grants, conversations or chat. The presence (Face ID) key is never reachable from the bridge. Tested: a bridge request for any other path or document is refused by the app and by the server.
- Anchor text (`exact`, `prefix`, `suffix`) lives in a salted blob too, and `anchorHash` is that blob's hash.
- **What the phone signs is a canonical, operation-specific payload** covering every field that gives the operation its meaning, plus a phone-minted `requestId`: `comment {docId, commentId, onVersion, anchorHash, bodyHash}`, `reply {docId, commentKey, replyId, bodyHash}`, `resolve|reopen {docId, commentKey}`, `edit {docId, commentKey, bodyHash}`, `reanchor {docId, commentKey, onVersion, anchorHash}`, `send {docId, batchId, commentKeysHash, primaryRow, messageRequestId}`. Text and lists appear only as hashes (`sha256(salt ‖ text)` per blob, where the salt lives only inside the blob and is never in the signed payload or the row, so after a purge the hash can't be checked against guesses; peers verify a blob by recomputing the hash from the blob's own salt and text; for a body split across blobs, `bodyHash` is the sha256 of the ordered list of the blobs' `payloadHash` values). `requestId` is unique per device, and used ids are recorded in the replicated rows themselves, so a pruned or restored machine (a new incarnation after merge-restore) still refuses a replay. The replicated row is derived **only** from that payload, its `eventId` is derived from `requestId`, and peers reject a row whose fields don't match its signed payload or whose `requestId` was already used. Tested with altered fields and with a replay under a new machine-generated event id.
- **Peers reject any `person` row without a valid `signedOrigin`** from a phone or a browser device bound to that person (§3.6a). A bare cookie never writes.

### 3.6a Member browser devices

1. **Linking.** On a computer the page shows a QR code carrying the browser's public-key fingerprint, the machine id, the host and a single-use nonce. The member's app scans it, shows the fingerprint and asks for Face ID, then calls a new device-signed route open to members and guests, `POST /mobile/browsers/link { browserPublicKey, nonce, machineId, host }` (added to `DEVICE_ALLOWLIST` and `TEAM_ROUTE_TIERS`). The phone sets the expiry itself (30 days); the QR never does. The server checks that the signing phone's person is the person being linked and that the nonce is fresh for this machine.
2. **Record, scoped to documents.** The browser becomes a browser device record with `userId` = that person, `role: 'team'`, `scope: 'documents'`, `linkedByDeviceId`, and a new `approvedVia: 'person-phone'` (added to the `ApprovedVia` union, `originApprovedVia` and the migrator text), with a key-ledger activation row (`client: 'browser'`). A guest's linked browser gets `scope: 'documents-read'`: document reads only. A `scope: 'documents'` device is refused on every route except the `instar-docpage-v1` page writes and reads, and one chat send: the Send template for the opened document into that document's primary conversation (the server checks the body is exactly the template with that document's link). It never gets the member's other conversations, messages, media or conversation edits that `BROWSER_ROUTES` opens to member tier (`mobilePairingRoutes.ts:2173, 2235`). **Binding**: the person-to-browser binding row (`browser-bind`) carries the phone's whole signed `browser-link` request, so peers verify the chain phone → browser themselves and the browser binding is never weaker than the phone's; `bindTeamPhones` reads browser keys through `deviceKeyOf`.
3. **Revocation.** A linked browser is revoked when the linking phone (`linkedByDeviceId`) is revoked, when the person is removed or lowered (`revokePersonPhones` already covers every `role: 'team'` device), when the member chooses "Forget this computer" (device-signed `POST /mobile/browsers/:id/forget`, writing a `browser-unbind` row), or when 30 days pass (a new expiry sweep in `reconcileTeamPhones`).
4. **Allowance.** Each member may hold 3 linked browsers by default (home, work, laptop), with at most 4 links per member per hour, counted from the replicated `browser-bind` and ledger rows (so not multiplied per machine) and separate from the owner's pool (the browser count check, `MobileDeviceKeys.ts:528`, gains a role filter). Linking needs the existing browser switch (`mobilePairing.browser`, `mobileOwnerDeviceAdmission.ts:35`).
5. **Stated limit.** The page that shows the QR code is served by the machine. A process running as the agent's user could show its own key instead, and a member who scans without checking the fingerprint would link it. That key could then write comments as the member on documents the member can see, and send the Send template, for up to 30 days, always labelled "from Mara's computer". It can't read the member's chats, share, move, or read anything the member can't. The phone's Face ID and fingerprint step is the check, and the People screen lists each linked computer with "Forget". Separately, inherited from team step 2b: anything holding the machine key can write machine-signed `phone-bind` rows, so a phone binding is only as strong as the machine; browser bindings add no weaker link because they carry the phone's own signature.
6. **Remote code relay (stated limit, mitigated).** Anyone who can reach the tunnel can ask for a link code for their own browser key and send the QR to a member ("scan to open the doc"). The fingerprint check can't catch this, because the fingerprint on the attacker's own page matches. Mitigations: the server records, at code time, the requesting address (taken from `cf-connecting-ip` only when the request came through the tunnel) and a short browser description from its User-Agent, and returns them with the code's age to the phone, which shows them before Face ID ("A computer using Chrome on macOS asked 2 minutes ago") with the line "Only scan a code shown on a computer in front of you." Outstanding codes are capped at 3 per caller address, so one caller can't exhaust the shared pool. A member who approves anyway gives that computer the same bounded reach as item 5, and the People screen's "Forget" ends it.

**Phone layout** (≤ 640 wide): document full width. Selecting text shows a floating **Comment** pill above the selection, offset clear of the system copy menu. Tap → bottom sheet with the quoted passage and a text box. Commented passages have a soft highlight; tap one to open its thread. A bottom bar shows "3 open comments" and **Send comments to Echo** (the agent's name).

**Computer layout** (≥ 900 wide): centered column with threads in a right margin aligned to their passages, collapsing into the list when they would overlap. Selecting shows a **Comment** button; `c` with a selection opens the box, `Esc` closes.

Every thread shows the quote, comments and replies (name, role, time), **Resolve**, and an anchor note when relevant. The header shows the title, a version picker ("Version 3 of 3"), **Compare**, "Discussed in: <conversation name>", and who can see it, in words, computed from the conversation's real readers including Telegram's own boundary: "Only you", "You and Mara", "Everyone in Instar Docs", or "Everyone in Instar Docs; the Echo Telegram group can also see messages about it" when the primary is a Telegram topic whose group has other members. Drafts are kept in `localStorage` (wrapped in try/catch), and comment posts are idempotent, so a flaky phone connection can retry. Threads, the pill and the sheet are reachable by keyboard and screen reader; highlights meet 4.5:1 contrast in light and dark.

The owner's console gets a "Documents" list tab (`GROUPS.work`, with a `probe` on `/docs` so it hides when the feature is off, plus `CONSOLE_ONLY_TABS` and the route map). The list links out to `/docs/<id>`; the console never renders document content.

### 3.7 The link graph

**Primary conversation**: one per document, a durable ref (`telegram:<id>` or `app:<uuid>`), never a session name or a machine-local alias. Default: the conversation the document was created from. It is where Send lands and where the agent discusses the document. If it is deleted, the page says "This document's conversation was removed", Send is disabled with that reason, and the owner gets one attention item offering "Move to another conversation" (a phone-signed `primary-set`).

**Edges**: `link { edge: { to: Ref, kind, reason? (≤ 200 chars) } }`. `Ref` is `doc:<uuid>`, a conversation ref (including `slack:` for the Slack case in §3.1), `project:<id>`, `initiative:<id>` or `spec:<repo path>`; `kind` ∈ `discusses | derived-from | supersedes | references | about-project`; `primary` is implicit.

Edges are added automatically (a document derived from another → `derived-from`; created in a project-bound topic → `about-project`) and explicitly by the agent (`POST /docs/:id/links`) within its place. **`discusses` edges belong to the conversation, not the document**: when a document's link is posted in a conversation, that conversation's place writes the edge into a per-conversation link index (replicated the same way), so no session ever writes into a document it may not write. Readers check visibility of both ends. `InitiativeLink { type: 'doc' }` entries are read into the graph as `about-project` edges.

**Copying never widens**: `POST /docs { derivedFrom }` requires `read` on the source by the same caller and creates the copy in the source's primary conversation (a confined source makes a confined copy). `{ fromView }` is accepted only from owner-reach sessions or the bearer token, because a view has no audience of its own, and the copy always lands in the owner's own chat. Moving a copy elsewhere is `primary-set` by the owner's phone. `POST /docs/:id/links` refuses a target the writer can't read with the same `404 unknown-document`, so links can't be used to probe.

**Traversal**: `GET /docs/:id/links`, `GET /docs?conversation=<ref>`, `GET /docs/graph?from=<ref>&depth=1|2`. Rules on every hop:
- A node is returned only if the principal may read it (documents by §3.2/§3.3; conversations by `mayUseConversation`; `project:`, `initiative:` and `spec:` nodes only to the owner and owner-reach sessions).
- Traversal never passes through a node the principal can't see, so a hidden document can't reveal that two visible things are connected.
- An edge's `reason` is shown only when both ends are visible.
- Counts include only visible nodes.

**Session start**: a session starting in a conversation receives that conversation's documents once, through `GET /docs/session-context`, wired into the `SessionStart` hook (`session-start.sh`, not the per-message topic-context hook, so it doesn't repeat on every message) and into app-conversation dispatch `notes` (`appConversationPool.ts:506`). The block is re-sent mid-session only when the conversation's document list changes. Both `src/templates/hooks/session-start.sh` and the inline string `migrateHooks` actually writes (`getSessionStartHook()`, `PostUpdateMigrator.ts:19907`) are patched, and a test checks they match. The hook reads the conversation from `INSTAR_TELEGRAM_TOPIC` or the app conversation's binding variable and authenticates with the session's own token; a `503` prints nothing. Each line: quoted, attributed title ("Onboarding plan", by Mara), version, open comments, link. Ordered by open comments, then most recent. At most 10 lines and 1,600 characters (titles cut at 60 characters in this list), because the boot context is shared with identity and memory; when more exist, a final line says "and N more documents in this conversation: GET /docs?conversation=<ref>".

### 3.8 Send comments, and "read the comments"

**Send comments to Echo** is a message from the person, sent the way they already send messages:

1. The person's device (the app, or their approved browser) posts the fixed-template message into the document's primary conversation through the **existing** device-signed send route for that conversation: `POST /mobile/chat/:topicId` for a Telegram topic, `POST /mobile/chat/app/:key` for an app conversation, or the browser device's equivalent conversation send. Those routes already enforce everything a person's message needs: the tier and team checks, `sendReachesOwner`, rate limits, the lease holder rule (`409 not-serving` / `503 owner-unavailable`, which the app and browser already handle), idempotency by `requestId`, the Telegram mirror and dispatch. Nothing new is added to the inbound path for phones and owner browsers; the only new check is for a member's documents-scoped browser, whose single allowed send must be exactly the template for the opened document (§3.6a).
2. Template: `I left 3 comments on "Onboarding plan" (version 4): <link>` with the title quoted as data; the message is an ordinary person message, so it can never be a command or an approval by anyone else.
3. The device then writes a signed `send { batchId, coveredHash, primaryRow, messageRequestId }` row, where `coveredHash` names each covered comment together with the revision it had (its latest `comment-edit` row, or the comment row itself), so an edit made after a Send shows as an unsent change and the next Send covers it. `messageRequestId` is derived from `batchId`, so if the `send` row fails after the message went through, a retry re-sends only the row and the send route's idempotency makes the message a no-op. The `send` row is advisory bookkeeping for the "sent" badges: comments are already visible to the agent, so nothing depends on proving the message exists, and no machine has to see the message to accept the row. "Sent" shows once the conversation's own delivery state does; if the message send fails, no `send` row is written and the comments stay unsent, with the existing chat error shown.
4. A further Send is simply another message covering the comments not yet sent. There is no coalescing window and no separate outbox; repeated taps are deduplicated by the send route's `requestId`.

So the Telegram mirror, dispatch, the lease and split-brain behaviour are exactly those of any message. The one new case is a move between the two writes: the message lands in the old conversation and the `send` row is refused (its `primaryRow` no longer matches), so the comments still show as unsent in the new conversation and the page says "This document moved while sending. Send again to tell Echo in Instar Docs." After a client restart the same holds: comments not covered by a `send` row show as unsent. Tested with a move and a crash between the two writes.

**What "unsent" means.** Comments are visible to everyone who can read the document as soon as they are posted, as in Google Docs, and the agent may read them at any time. Send is the nudge: it tells the agent, in its conversation, which comments are new for it, and the `send` row records that for the "sent" badge.

**"Read the comments"** in chat (any phrasing; the agent decides): `GET /docs/:id/comments?status=open` returns each comment with its quote, the surrounding paragraph, anchor state, thread, author name and role. If no document is named, the agent uses the documents of the current conversation (§3.7), then title search, all within its place (§3.3). Comments are quoted content from people, the same as their messages in that conversation.

**The agent then** replies under each comment, writes a new version (`POST /docs/:id/versions { markdown, note, addresses }`), and answers once in the conversation with the compare link. It marks comments "Addressed in version 4"; the commenter resolves. (`documents.agentMayResolve`, default false.)

### 3.9 Agent API

All routes check `mayDoDocument` / §3.3 on every call.

- `POST /docs` `{ title, markdown, primary?, derivedFrom?, fromView? }` → `{ id, url }`. `primary` defaults to the calling session's conversation; with the bearer token and no session, the owner's own app conversation, else the owner's Telegram operator topic. An owner-reach caller naming a shared or member `primary` is refused `409 primary-wider-than-caller` (that would publish owner-private content; it is the owner phone's `primary-set`). With no machine holding a named tunnel, `POST /docs` answers `409 documents-need-a-named-tunnel` and the agent shares a read-only `/view` page instead. An agent with neither app conversations nor Telegram (a Slack-only agent) answers `409 documents-need-a-conversation` with "Documents need the Instar app or Telegram. I'll share this as a read-only page instead", and the agent uses `/view`.
- `GET /docs?conversation=&q=` · `GET /docs/:id/data` (the page's HTML is `GET /docs/:id`; JSON is always `/data`) · `GET /docs/:id/versions` · `GET /docs/:id/versions/:versionId`
- `POST /docs/:id/versions` · `GET /docs/:id/compare?from=&to=`
- `GET /docs/:id/comments?status=open|sent|resolved|all` · `POST /docs/:id/comments/:commentKey/replies`
- `GET|POST /docs/:id/links` · `GET /docs/graph` · `GET /docs/session-context`
- `GET /docs/health` (pending rows with their count and oldest age, ignored rows, chunk gaps per document, peers behind, push and pull failures per peer). Pending rows are kept on disk, not in memory, so their number has no memory bound to break; a pending row older than 7 days raises one attention item naming the team row it is waiting for.
- Page routes: reads (`GET /docs/:id` HTML, `GET /docs/:id/data`, `POST /docs/:id/session`) with the cookie or an owner session; writes (`POST /docs/:id/comments`, `…/replies`, `…/resolve|reopen|edit|reanchor`, `POST /docs/:id/send`) only device-signed under `instar-docpage-v1`
- Peer routes: `POST /docs/sync` and `POST /docs/sync/notify` (machine-signed, §5.1)

`/view` stays for read-only pages and public-signature cases (its no-script policy is deliberate). With documents on, the agent's default for sharing a document becomes `POST /docs`. `POST /docs { fromView }` copies a view as version 1, adds a `supersedes` link to it, and the agent offers once to delete the old view (its link never expires and isn't tied to a person); with no answer the view is kept.

## 4. The iPhone app and the phone routes

### 4.1 How the app knows the feature exists (facts from `echo-instar-app`, 2026-11-10 13:31)

The app has no per-request capability header. It gates new features the other way: a feature stays hidden until its server route answers. Documents follow that convention: the app shows document rows only when `GET /mobile/docs` answers 200 (503 when the feature is off). The server learns that a phone runs a documents-capable build when that phone first calls a `/mobile/docs*` route, and records it as a replicated, machine-signed `device-seen { deviceId }` row in the documents stream's reserved device stream (`docId = "_devices"`, no content) (not on the per-machine device record), so every machine, including the lease holder that sends pushes, sees it; document pushes go only to phones with that mark, so an older build never receives a push kind it can't show. The same mark on Justin's owner phone is how run 2 (§4.5) detects the install.

Device signing reuses `AgentClient.authorize` (headers `X-Instar-Device`, `X-Instar-Device-Time`, `X-Instar-Device-Sig`, `X-Instar-AgentId`; signed string `instar-device-v1\n{deviceId}\n{host}\n{METHOD}\n{path+query}\n{timeMs}\n{sha256(body)}`). Face ID actions (`primary`, and the existing grants) are signed with the second, presence-gated key (`PresenceKey`), as the team screens already do.

### 4.2 Device-signed routes (new `DEVICE_ALLOWLIST` entries)

Signed exactly like the existing `/mobile/chat` routes. Response shapes (JSON):

```
GET  /mobile/docs?conversation=<ref>
  → { documents: [ { id, title, version: 3, openComments: 2, updatedAt, ownerName } ], more: false }
GET  /mobile/docs/:id/summary
  → { id, title, version, openComments, myOpenComments, primary: { ref, name }, audience: "Only you", heads: { "<origin>/<inc>": seq, … } }
POST /mobile/docs/:id/open            body: {}
  → { url: "https://<this machine's tunnel>/docs/<id>", code: "<base64url 32 bytes>", expiresAt }
POST /mobile/docs/:id/primary         body: { primary: "<conversation ref>", docDeps: { "<origin>/<inc>": seq, … } }   (owner phone only, Face ID)
  → { ok: true, audience: "Everyone in Instar Docs" }
Sharing uses only existing signed requests, so the team log's format doesn't change:
  1. POST /mobile/conversations                   (existing; creates the conversation, default name
                                                   "<document title> (shared)")
  2. POST /mobile/team/grants                     (existing; Face ID; one grant per person, or every
                                                   current person for "Whole team")
  3. POST /mobile/docs/:id/primary { primary }    (new; Face ID) → { ok, audience }
  The app runs the three in order and keeps a resumable step state, so an interrupted share resumes at the step that didn't finish; the page reflects the new audience as soon as step 3 lands.
  Refusals the share sheet shows in words: a system topic ("This is a system topic and can't be shared"), a topic a scheduled job posts to ("A scheduled job posts here, so it can't be shared"), a person's own conversation ("This is Mara's own conversation, so it can't be shared"), and team access off ("Turn on team access first").
```

Refusals: `404 unknown-document`, `403 presence-required` (an owner action without the Face ID signature), `409 not-owner`, `503 documents-off`.

### 4.3 What the app shows

1. **Documents in a conversation**: a "Documents" row (count and newest title) on the conversation screen when `GET /mobile/docs` returns any; tap → list with title, version, open comments, last change.
2. **Opening**: tap → `POST /mobile/docs/:id/open` → load `url#code=…` in a second in-app `WKWebView` (the app already hosts one for the console in `ConsoleView.swift`) pinned to that origin (no navigation elsewhere; external links open in Safari), with the app's own close button. When the page reports the session expired (`401 doc-session-expired`), the app repeats the open call.
3. **Links in messages**: a `/docs/<id>` link in chat opens through step 2.
4. **Push**: the document push (§4.4) opens the document at the comment.
5. **Owner sharing**: a share sheet ("Only me / Choose people… / Whole team") running the three requests in §4.2 with Face ID, and "Move to conversation…" calling `/mobile/docs/:id/primary`.
6. Handles the new push kind (§4.4) in `NotifyExtension/NotificationService.swift`.
7. **Native composer and Send**: the page reports a selection; the app shows its own sheet with the quote and text box, and its own Send button, which posts the template message through the existing `POST /mobile/chat/…` route and then the signed `send` row (§3.8).
8. **Link a computer**: "Open on a computer" in the document screen scans the QR code shown by the page in a browser and signs the `browser-link` (§3.6), so the person can comment from a computer too.

### 4.4 Push

A new push kind `document` through `MobilePush`, keeping its invariants: the payload never carries document text, so the alert body is fixed ("New answers to your comments"), and the payload carries only `instar.kind: 'document'`, `itemId` (docId), `commentKey` and `count`; the notification extension fetches the title itself with its notify token, and the notify-text route learns this kind. Recipients are decided per document at send time by a `mayNotifyDocument(person, doc)` check (re-run when the push is sent, so a revoked person gets nothing). The `document` kind is exempt from `receivesNotices` (which skips team phones for every kind but `reply`, `AgentServer.ts:2063`), msp phones are excluded, and only phones with a `device-seen` row receive it. `dedupeKey = doc:<id>:<person>:<pass>`, so the peer fan-out sends once. One push per (person, document, agent pass): when the agent writes the version that addresses that person's comments, or 60 seconds after its last reply to them if no version follows. MobilePush's fold and hourly bounds still apply. `PushTrigger.kind` gains `'document'` and the peer trigger route's whitelist (`mobilePairingRoutes.ts:1775`) learns it; peers on older builds would answer `400 bad-trigger`, so document pushes are sent only from the lease holder, and only to machines advertising the `documentsPushKind` seamlessness flag. Burst test: 20 replies produce one push.

### 4.5 Who builds the app part, and when it's done

The app repository is owned by `echo-instar-app` on the Studio, which builds and ships every app build through TestFlight. Plan:

1. After approval, the server routes land first behind the dark gate, live on this development agent (Echo on the M5), so the app can be built against them.
2. When Justin approves this spec (`approved: true` in this file's frontmatter, recorded from his message in topic 141469), this session sends `echo-instar-app` the build brief: §3.6 page behaviour, §4.1–4.4 contracts with the examples above, and the in-app part of the §10 proof. It records a commitment that re-surfaces on a cadence until the build ships, and checks that session's pane and the app repository's commits at each re-surface.
3. `echo-instar-app` builds the screens, runs the in-app part of the §10 proof as a simulator UI test (`Tests/InstarAppUITests`, a `LIVE_PROOF_SCRIPT` run against a throwaway development agent, on the Studio when it is idle, per its heavy-work rule), and uploads a TestFlight build with `scripts/ship.sh`.
4. If `echo-instar-app` stops making progress, this session works down a ladder, never a question to Justin: (a) a nudge through its pane; (b) a restart of that session through the Studio's session routes; (c) a new session on the Studio with the same brief (the Studio holds the signing identity, so the work stays there); (d) only if the Studio itself can't be reached, one attention item: "The Mac Studio has been unreachable since <time>, so the app build is waiting on it." The cadence (default: check every 2 hours, escalate a rung after 4 hours without a new commit) is advisory; the session judges each rung from what the pane and commits show.

**Run boundary.** Installing the build on Justin's phone is his tap, so the work is split in two at that point, with nothing left unowned:
- **Run 1 (this run) ends** when the server work is merged, the browser proof has passed, the app build is on TestFlight with the simulator proof passing, and one attention item asks Justin to install it ("The documents build is on TestFlight. Install it, then open any conversation").
- **Run 2 starts** when Justin's owner phone first calls a `/mobile/docs*` route (its `device-seen` row, §4.1), which only the new build does. It re-runs the in-app happy path on his phone with him, then turns the feature on for the fleet (§13 decision 10). Run 2 is registered as a commitment when run 1 ends.

## 5. Multi-machine posture

### 5.1 Documents: unified

The `documents` rows replicate by **version-vector pull**: the same protocol as team access (self-verifying rows, per-origin chains, any peer serves any origin's rows, so a sleeping laptop's rows still reach everyone), not the coherence journal (no 80 KiB line cap, no drop-on-burst rate cap). It reuses the protocol, not the `TeamAccessLog` class, which holds its whole log in memory, re-folds and copies it on every ingest and fsyncs row by row; that suits a small control log, not documents.

- **One chain per origin across all documents**, so the vector is machines × incarnations, never documents × machines. An on-disk index maps (origin, seq) to (file, offset), so "rows beyond this vector" is a seek, and a "nothing new" answer costs O(origins).
- `POST /docs/sync` is a machine-signed POST carrying `have`, `heads` and `starts` (the same shape as `/api/team-access/rows`, so chain heads and short streams are checked), with its own body limit, and returns rows and the blobs they reference, **paged by bytes**: at most 4 MiB per response and per push, always at least one row; repair pages the same way. A machine that can't be dialled pushes its rows out over the same paged POST, and push failures are counted, never swallowed. Document lag never holds the lease (unlike team-log lag). Pages are written with one async fsync each. Ingest folds only the documents the page touched, adding just the new rows.
- The pull code is generalised over a row-log interface (today `pullFromPeers` is typed to `TeamAccessLog`, `TeamAccessSync.ts:18`); team access keeps its behaviour. A local append sends peers a small machine-signed `POST /docs/sync/notify { heads }`, which triggers their pull; peers also poll every 60 seconds. Pull and push failures are counted per peer in `GET /docs/health`, never swallowed. Single-machine survivability: every machine answers from its own copy, and writes on any machine replicate.

### 5.2 Derived index and anchor cache: a projection of the unified stream

Not machine-local state: a deterministic fold of the replicated rows, rebuilt at boot, identical on every machine that holds the same rows.

### 5.3 Size and rate, refused out loud

- A version's text is split into `version-chunk` rows by content-defined chunking at paragraph boundaries: a chunk ends after a paragraph whose hash matches a mask, with chunks between 4 KiB and 48 KiB serialized (a paragraph longer than 48 KiB is split inside). Boundaries depend only on nearby text, so an edit near the top re-stores only the chunks it touches. Blobs are content-addressed per document, so unchanged paragraphs are stored once across versions and an edit near the top doesn't re-store the rest.
- **Pruning old versions**: the owner's phone can prune chosen old versions (`prune { versionIds }`); each machine deletes those versions' unshared blobs, the rows still verify, comment threads stay, and compare against a pruned version says "This version's text was removed". Pruning gets purge's three protections: sync responses list pruned versions first, machines refuse to store or serve those blobs again, and the export and merge-restore skip them; `/docs/health` and repair leave pruned versions out of the missing-chunk check. A version is visible only when all its chunks and its `contentHash` match; `GET /docs/health` lists any document with missing chunks, and the page shows the previous complete version with "The newest version is still arriving from another machine".
- Nothing is silently dropped: a write that can't be stored (disk below the Disk Steward's existing critical floor) is refused with a plain message, and replication lag is visible in `GET /docs/health` and `?scope=pool` reads, which name machines that didn't answer.
- There is no count cap on versions or comments and no fixed store cap. Signed rows can't be compacted, so the Disk Steward can only **report** document storage (its pool read gains a documents line); a document whose text passes 50 MiB raises one attention item to the owner offering to prune old versions, which the owner decides on the phone. Boot indexes only metadata rows (chunk rows are skipped by offset) and loads chunk text when a version is opened, so boot cost grows with the number of rows, not their size; tested with a 5 MiB document × 1,000 versions.

### 5.4 Page sessions, open codes and browser device records: machine-local

machine-local-justification: physical-credential-locality — open codes, page cookies and the replay state for single-use codes and QR nonces are credentials checked by the machine that minted them; the device keys' bindings to people are replicated (`phone-bind`, `browser-bind`, §3.6a), so any machine verifies a device; the open response always names that machine's own tunnel origin, so the page talks to the machine that minted it.

### 5.5 Notices

Attention items (conversation removed, owner proposals) go through the lease holder, one voice.

## 6. Decision points touched

| Decision point | Class | Basis / floor and arbiter |
|---|---|---|
| `mayDoDocument` (read/comment/send/resolve/revise/delete) | invariant | basis: irreversible-consequence; evidence: a disclosure to the wrong person can't be taken back, so access is computed deterministically from the signed team log and never by a model |
| Audience = primary conversation's audience | invariant | basis: irreversible-consequence; evidence: it is the only arrangement in which non-owner text can't reach an owner-reach session (team spec §3.2, §3.5) |
| `primary-set` and sharing need the owner's phone signature | invariant | basis: irreversible-consequence; evidence: the agent can read the dashboard PIN, so only the phone signature proves the owner widened access |
| `msp` phones get no document standing | invariant | basis: irreversible-consequence; evidence: `mayUseConversation` gives msp phones every Telegram topic (`MobilePeople.ts:194`), which would expose the owner's private documents |
| Agent session scope = its own place (§3.3) | invariant | basis: irreversible-consequence; evidence: team spec §3.5, confined history must never load into an owner-reach session |
| Quote must exist in the version (422) | invariant | basis: enumerable-domain; evidence: the quote either is or isn't a substring of the projection |
| Re-anchor accept thresholds (25% margin, 0.75 similarity, 20 chars, ±2,000 window); deterministic because the derived index must be identical on every machine (§5.2) | judgment-candidate | floor: a comment is never dropped (orphaned instead); arbiter: the comment's author, who sees "the passage changed" and can re-attach it |
| Session-start list (10 lines; ordered by open comments, then most recent); deterministic because it runs in a hook with no model call | judgment-candidate | floor: an "and N more" line always states what was left out and how to list them; arbiter: the agent, which reads the full list with one call whenever the conversation is about a document not shown |
| Accept-side format constants: blob 48 KiB serialized and row 4 KiB (sized so a 4 MiB sync page carries many rows and each row is cheap to verify), quote 2 KiB, title 512 chars and link reason 512 chars (an upper bound so a title can't carry a document's worth of text into other people's lists and boot context, the injection surface in §8), and the diff caps (2,000 operations per paragraph pair), which change where comments land | invariant | basis: enumerable-domain; evidence: constants of the replicated row format (`formatVersion` 1) and of `projectionVersion`, identical on every machine so a row valid or anchored one way on one machine is the same on all; changing them is a format version, never config |
| Write-side limits: a comment or reply up to 256 KiB in total and a title up to 120 characters by default (lists show about two lines of title on a phone, and boot context cuts at 60), and anything stricter the owner sets | judgment-candidate | floor: never looser than the format bounds; an over-limit post is refused with words ("This comment is too long. Split it into two.") and the draft is kept; arbiter: the owner's config (`documents.limits`), which never changes what peers accept |
| Open code 60 s, page cookie 30 min, browser link 30 days | judgment-candidate | floor: single-use code, short-lived cookie bound to one document and device, re-minted silently by the app; arbiter: config |
| Member browser allowance (3 linked browsers, 4 links per hour) | judgment-candidate | floor: counted from replicated rows; an over-limit link is refused in words ("You already have 3 computers linked. Forget one in People first."); arbiter: the owner's config (`documents.limits`) |
| Storage notice at 50 MiB of text per document | judgment-candidate | floor: storage is only reported, never refused below the Disk Steward's critical floor; arbiter: the owner, who decides whether to prune |
| Peer poll 60 s, 4 MiB pages | judgment-candidate | floor: a local append also notifies peers immediately, and failures are counted in health; arbiter: config |
| Per-person write quotas, counted over the replicated rows, so on connected machines they don't multiply (machines cut off from each other can each accept up to the remaining allowance, an overshoot bounded by the number of machines): 120 comments and replies per hour per document, 20 MiB of text per person per day across documents; 1,024 chunks per version (about 48 MiB at most, typically far less) | judgment-candidate | floor: one member can't exhaust storage or the event loop for everyone; an over-quota write is refused with words ("You've added a lot to this document in the last hour. Try again in a few minutes.") and the draft is kept; arbiter: the owner's config (`documents.limits`) |
| Push timing (one per pass, 60 s quiet) | judgment-candidate | floor: MobilePush's existing fold and hourly bounds; arbiter: the person's notification settings |
| Agent resolves comments | judgment-candidate | floor: off by default (`documents.agentMayResolve: false`); arbiter: the owner's config |



## 7. Verify the state, not its symbol

| Claim | Symbol read | Independent corroboration | When it can't be measured |
|---|---|---|---|
| A comment is attached to this passage | stored position | the server re-finds `exact` in the version's own projection on every write and every new version | `anchorState: 'orphaned'`, shown to people and the agent, never hidden |
| Person X can see this document | a grant row | each request re-folds the signature-verified team log; the §10 proof checks a member and a guest against documents they must not see | the team log unreadable or held ⇒ everyone but the owner gets 404 (`access-being-checked` reason in People) |
| The comments reached the agent | a `send` row | the conversation's own delivery state for the message named by `messageRequestId` | message send failed ⇒ no `send` row, comments stay unsent with the chat error shown |
| A version replicated | local append | `?scope=pool` read showing each machine's highest seq per origin, naming machines that didn't answer | a machine that doesn't answer is listed as unknown, never as caught up |
| A version is complete | a `version` row | all chunks present and the content hash matches | previous complete version shown with "still arriving" |

## 8. Security

- **Script and markup injection**: the page runs under its own strict policy (`script-src 'self'`, no inline script, no CDN, `form-action 'none'`, Trusted Types); document markdown is rendered with raw HTML disabled; titles and comments are always text. Member-written text can't run code or draw fake controls, and the page is not on the console's routes.
- **CSRF**: writes need `X-Instar-Request: 1` plus a phone or browser device signature; the cookie never authorises a write.
- **Probing**: every miss is `404 unknown-document`; lists and graph filter per principal; traversal never passes through hidden nodes.
- **Prompt injection through comments and titles**: comments reach only sessions confined to the people who could write them (§3.1). Titles are bounded (120 characters by default, 512 at most), stripped of control characters, and appear in boot context quoted and attributed. Comments can't widen access, because the agent can't write `primary-set` or sharing.
- **Forged or replayed rows**: rows carry the accepting machine's signature and chain; owner rows carry the phone's signed request and are checked with the team log's own verifiers (`verifyTeamAccessRow` and the device-signature checks in `AppRecordSignatures.ts`); standing is re-checked from the immutable team rows named in `access`.
- **Lease split-brain** (inherited): a Send is an ordinary message, so it behaves exactly as any message does in a split (the pool's existing idempotency by `requestId` and `eventId`).
- **Moving between shared conversations**: the earlier audience loses the document, including their own comments on it; the share sheet says so.
- **Shared origin**: `/docs/<id>` is served on the same tunnel origin as the console, which stores the owner's browser key. The page inherits the origin's trust: the console on the same origin runs `unsafe-inline` and a CDN and shares storage with it, so a console compromise is a page compromise, exactly as it already is for everything else on that origin. The page adds no new risk to it because no document content is ever interpreted as markup or script (DOM built from tokens, Trusted Types, `script-src 'self'` serving only instar's own files), and page drafts in `localStorage` hold only the person's own unsent text. A separate hostname would need a second tunnel route per agent and wasn't worth the operational cost; if the page ever needs to render untrusted markup, it moves to its own hostname first.
- **Monotonic access**: each origin's `access` vector must never go backwards along its chain, so a row can't be backdated to before a revoke that origin had already seen.
- **Stated limit** (same as team spec §3.2): an owner-reach session on the machine could edit files directly or read the machine's key. Member writes carry the phone's signature (§3.6) and their composer is native, so neither can be forged; machine-signed rows (agent rows, disclosures, device marks) could be, by such a session. Replication restores deleted rows from peers on multi-machine agents; nothing detects a deletion on a one-machine agent.
- **What a person's signature does and does not prove (honest threat model, added 2026-11-10 after the operator's app-dependency question and a Fable 5.2 review).** The goal is that the agent can't write a comment as a person or approve access for one. What the design actually delivers, per signer:
  - **Phone (native app):** strongest. The app's code is not served by the agent, and its key is in the Secure Enclave. Its weak point is enrollment: an app paired by a confirmation code that passes through the agent's own Telegram bot could, in principle, be a software key the agent paired itself (no Apple App Attest check today).
  - **Computer browser (WebCrypto key):** the key can't be exported, but any script on the origin can use it, and the agent's machine serves that script. While a linked tab is open, a session able to change the served page could sign comments silently.
  - **Approval through the owner's Telegram chat:** the agent runs the bot that receives the tap, so a session that deliberately forged an update or edited the device registry could approve a key. On one machine, nothing but the agent's own guards stops that; on several machines, a peer still checks the phone's signature on every replicated binding.
  So the honest claim is "the agent would have to deliberately forge state, and a forgery is visible in the signed logs", not "the agent cannot". Passkeys (one person gesture per signature, page script can't fake it) and chained enrollment (a new device admitted only by a signed record from a device the person already has) are the planned way to strengthen this and to remove the app dependency for members; see §14.

## 9. Agent awareness and migration parity

- **Reference file**: a "Documents" section in the messaging reference (`.instar/reference/messaging-2.md` template) with the routes and the read-the-comments behaviour.
- **CLAUDE.md template** (`generateClaudeMd()`): one Feature Proactivity line ("User asks for a write-up, plan or report → create it as a document in this conversation and send the link") and one Registry First row ("Which documents belong to this conversation? → `GET /docs?conversation=…`"). `migrateClaudeMd()` adds both with a content-sniff guard.
- **Config**: a `documents` block in `ConfigDefaults` with `enabled` omitted (dev-agent gate, `DEV_GATED_FEATURES` entry, listed in `machineCoherenceManifest`); `migrateConfig()` adds missing fields only.
- **Discoverability**: CapabilityIndex entries for `/docs` and `/mobile/docs`; routers added to `ROUTE_SOURCE_FILES`; write routes in `WriteDomainRegistry`; device routes in `DEVICE_ALLOWLIST`; session-token routes classified in `memorySessionGuard`.
- **Hooks**: the session-start hook calls `/docs/session-context` and prints nothing on `503` (feature off); `migrateHooks()` overwrites built-in hooks on update as usual.
- **Everything agent-facing follows the switch**: the CLAUDE.md lines and the reference section are written by the migrator only when `documents.enabled` resolves true on that agent (and removed by the migrator if it later resolves false), so a fleet agent with the feature off is never told to make documents. A test checks that a fleet config gets none of them.

## 10. Live-User-Channel Proof (before "done")

On a throwaway agent with team access on and two machines, a user-role harness drives the real page through the tunnel at **390×844** and **1280×728**, and signs a PASS/FAIL matrix:

- **Happy path**: create in a conversation → select a passage → comment → Send → the agent's session receives exactly one message → the agent replies and revises → compare shows the change → the comment is re-anchored → resolve.
- **Anchors**: edit the passage (edited), delete it (orphaned, still listed and re-attachable); a fabricated quote is refused.
- **Permission**: a member in the shared conversation reads and comments; a guest reads but can't comment; a member outside it gets 404 on the page, the list, the graph, the session-context and a forwarded URL; an msp phone gets 404; revoking access stops the next request; a confined session can't read another place's document; an owner-reach session gets metadata but not comment text from a shared document.
- **Multi-machine**: a comment made on machine A appears on B; a 300 KiB version reaches B complete; a page cookie from A is refused on B; a Send from a phone talking to a standby follows the existing chat send behaviour (the app's lease-holder handling) and its `send` row reaches every machine.
- **Idempotency**: a double-tapped comment and a retried Send each produce one row and one message.
- **Failure**: primary conversation deleted → Send disabled with its reason; message send fails → no `send` row, comments stay unsent with the chat error shown; no named tunnel → the plain refusal.
- **Notifications**: 20 replies in one pass → one push.
- **App**: in the iOS simulator against this development agent, then on Justin's phone: the conversation shows its documents, a document opens in the app, a comment and Send work, the push opens the right comment, and the owner's share sheet creates the shared conversation with Face ID.

- **Computer linking**: a member links a browser by scanning the QR code with the app (simulator), comments from the browser at 1280×728 labelled "from <name>'s computer", the link is refused for a mismatched person and a reused nonce, and "Forget this computer" and person removal both stop the next write; a PIN-approved owner browser reads but can't write.

Members and guests in the browser part are driven with throwaway device keys signing requests exactly as the app does, plus one real linked browser.

## 11. Build order

1. `src/documents/`: row types and validator, chain and signature, fold, projection, anchoring, diff, `DocumentAccess`.
2. Store with fsync, blobs, chunking; `POST /docs/sync` vector pull, notify and polling; document export and merge-restore; deny layers.
3. Routes (`src/server/documentRoutes.ts`): agent, page (with its own policy) and device routes; CapabilityIndex, WriteDomainRegistry, memorySessionGuard, DEVICE_ALLOWLIST, the replicated `device-seen` row.
4. Send: the page's Send through the existing device send routes, and the signed `send` row; browser devices for members (`browser-link`).
5. Owner phone route `POST /mobile/docs/:id/primary` (presence-signed) and the resumable three-step share.
6. The page (`dashboard/docs/`) for phone and computer; console list tab.
7. Session-start route, hook template and app-dispatch context; push kind.
8. Template, reference file, migrations, dark gate.
9. Tests (§12) and Local Verify.
10. App build (§4.5) with `echo-instar-app`.
11. Live proof (§10), browser and app.
12. Turn on for the fleet (§13 decision 10).
Every step lands behind the same dark gate, so a partial landing is inert on the fleet.
13. When Rule 123 merges (owned by the session in topic 141014), update this spec's `parent-principle` to cite the merged rule; the `/spec/conformance-check` parent check then resolves. This is tracked as a commitment in topic 141469.

## 12. Tests

- **Unit**: fold determinism under shuffled arrival across origins; pending rows re-checked when team rows arrive; idempotent duplicates; commentKey collision 409; projection golden corpus shared by server and page; anchoring (exact unique, ambiguous with context, fuzzy edit, orphan; property test that random edits never drop a comment); Myers and Bitap property tests and the 20,000-operation fallback; chunk reassembly and hash mismatch; `mayDoDocument` table for every principal × op on both sides of each boundary, msp included; `mayUseConversation` refusing a `doc:` ref; title sanitisation.
- **Integration**: every `/docs*` and `/mobile/docs*` route with owner, member in the conversation, member outside, guest, msp phone and stranger; confined-session and owner-reach-session scopes; the page policy header present; Send posts exactly one message through each existing send route and none on a retried tap; a `send` row without its message is refused; the push burst test.
- **E2E**: the production init path serves `/docs` (200) on a development agent and 503 on a fleet config.
- **Wiring integrity**: the sync route is registered and not a no-op; access delegates to the real team-log fold; the browser-link verifier is the real device-key check.

## 13. Frontloaded Decisions

1. Documents get their own page and policy; `/view` is unchanged and the console never renders document content.
2. A document's audience is its primary conversation's audience; sharing is conversation sharing; there are no per-document grants.
3. Guests can't comment.
4. "Whole team" creates (or reuses) a conversation granted to every current team person; people added later get access when the owner adds them to that conversation, as with any shared conversation.
5. Moving and sharing need the owner's phone; the dashboard and the agent can't.
6. The agent doesn't resolve comments by default.
7. No new npm dependencies; Bitap and Myers are in-repo.
8. Send arrives as an inbound message from the person through the conversation's real inbound path.
9. People reach documents through their own devices only: the app (phone-signed open) or a browser linked to them (§3.6a); there are no shareable links that carry access.
10. Ships dark: live on development agents, off on the fleet. This agent (Echo) turns it on for the fleet in run 2 (§4.5), after the §10 proof passes in the browser and in the app on Justin's phone, and after the app build is available through the channel fleet owners get builds from: TestFlight's external testing group, submitted by `echo-instar-app` with `scripts/ship.sh` (part of run 2's completion bar). External testing needs Apple's beta review, an outside wait of usually a day; run 2's commitment re-surfaces until it clears. A member with an older app simply doesn't see documents (the app shows a feature only when its route answers, §4.1), and a document link in chat opens a page saying "Update the Instar app to open this document" when there is no page session. Recorded as a commitment in topic 141469 with the proof artifact attached.
11. Telegram topics and app conversations are the supported primary conversations; a Slack-started document lives in the owner's own app conversation with a link to the Slack thread.
12. Storage units are format constants (versioned with the row format, §6), not behaviour limits: content blobs ≤ 48 KiB serialized and rows ≤ 4 KiB, chosen so a 4 MiB sync page carries many rows and every row is cheap to verify. Floor: every page carries at least one row, sizes are measured on the serialized bytes, and anything bigger is split across blobs (lists of comment keys in `send`, `addressed` and a version's addresses live in a blob, so no row grows with them). There is no cap on how many versions or comments a document has.
13. legacy `msp` phones get no documents.

## 13a. Alternatives considered

- **Store comments and versions as conversation messages.** Since a document's audience is its conversation's, this would inherit `mayReadMessage`, replication and holds. Rejected because: Telegram topics have no replicated, per-conversation event store (only app conversations do), so half the supported primaries would have nowhere to put rows; a document moves between conversations, and conversation events are keyed to one conversation (moving would mean copying history between stores, losing signatures); and documents need blob-level purge and versions measured in megabytes, which conversation events don't support. The document stream reuses the conversation rules where they matter: 2b visibility, holds, the team log's verifiers.
- **Per-document grant rows in the team log.** Rejected in round 1: a person with only a document grant could comment into a conversation they can't speak in, and their words could reach an owner-reach session (§3.1); conversation audiences are the only boundary the team model confines sessions to.
- **Share a copy instead of moving.** A document that never moves, with sharing as a copy of a chosen version, would avoid the move-disclosure rules. Rejected because Justin's brief makes a document's conversation the place where it is discussed and where its comments live: a copy splits the comment threads and the history in two, and the owner usually wants the people they share with to see how the document got here. The owner still gets "share a copy" for free: derive a copy (`derivedFrom`) in their own chat, then move the copy.
- **WebAuthn passkeys for member browsers.** A passkey is the standard origin-bound browser key, but approving it would still be a page served by the machine, so it doesn't close the stated same-user limit, and it needs a platform authenticator on every computer; a phone-approved non-extractable key works in every browser and reuses the phone's existing Face ID approval.
- **The coherence journal** as transport: rejected for its 80 KiB line cap and drop-on-burst rate cap (§2, §5.1).
- **diff-match-patch as a dependency**: rejected only to keep dependencies flat; the tests compare the in-repo diff and fuzzy matcher against brute-force references instead, and the choice can be reversed with no format change.
- **A separate hostname for the page**: not built, because the page interprets no document markup; §8 states the condition under which the page moves to its own hostname.

## 14. Open questions

- **App dependency (operator, 2026-11-10 17:54 PST, topic 141469):** members and guests can only comment from a computer by linking it with the iOS app, which ties a core Instar feature to an Apple-distributed binary and leaves out Android and computer-only people. Proposed (Fable 5.2 review plus Echo): passkeys as the standard person signer in any browser (also a second way to sign the existing link request), the app kept as the strongest optional signer, and chained enrollment. Removing Telegram as an approval authority and App Attest on app pairing are platform-wide and would be a separate project. **Waiting on the operator's decision.**

## 15. Rollback

Turning `documents.enabled` off answers 503 on every documents route, hides the console tab, stops the session-start block and the pushes, and changes nothing else. Stored documents stay on disk and in each machine's copy, untouched, so turning it back on restores everything. Shared conversations created by "Share with…" are ordinary shared conversations and keep working. Reverting the code removes the routes; the rows remain readable JSONL.

## Maturation plan

- **test-agent-live:** every §10 scenario on a throwaway agent with two machines, the iOS simulator, and a linked browser.
- **dev-agent-live:** Echo (the development agent), with Justin and a test member using real documents for a week.
- **fleet:** turned on for the fleet in run 2 (§4.5, §13 decision 10) after the in-app proof on Justin's phone and the TestFlight external build is available.
- **graduation criterion:** a week on Echo with at least ten documents shared across at least two people, zero comments lost or misplaced after edits, zero reads outside a document's audience in the audit, and the agent defaulting to documents for write-ups.
- **ladder:** documents
- **dark-window:** if documents are not on for the fleet within 30 days of approval, record why on the Maturation board with a new date.

## Left behind

*(filled at convergence)*

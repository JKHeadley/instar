# DF-0004 · Generated work belongs under its real parent

| | |
|---|---|
| Entry | DF-0004 |
| Date of feedback | 2026-11-22, 13:26 PST (2026-11-22T21:26:25Z) |
| Card | `wc_26e234784f116ae6`, the server card that owns implementation ("Keep Created App Chats Under Their Parent"); its source binding has not been verified by this register |
| Source message | Owner message `4597726001389351` in conversation topic `141385` (Chief of Staff), recorded 2026-11-22T21:26:25Z (13:26 PST), with three photos. The history marks it as from the owner, but its authorship field is empty and the id is not a Telegram message number, so authorship is left to the card path's sender check |
| Relay | The wording quoted under "Relayed Request" came through the Chief of Staff in message `e6e0479a-e8d7-4db1-b1bb-c4c371093ada` |
| Standard | `docs/DESIGN-STANDARD.md` |

Date: 22 November 2026, 13:26 PST. Source: Justin’s feedback relayed by Chief of Staff in message e6e0479a-e8d7-4db1-b1bb-c4c371093ada. The quoted request below preserves that relay; that relay packet held no direct transcript. The original message was found in the conversation history on 2026-11-27 and is quoted separately below, with its authorship caveat.

Original owner captures remain in the private feedback archive. No original image is published here; the only conversation text published is that original message. This public-safe diagnosis keeps the Chief of Staff relay as a relay, and does not present the original message as verified owner authorship.


## The original message (recorded as from the owner; authorship not verified)

The message (item 3 is this entry; the message also produced the other entries named after the quote):

> "We have a lot of work to do on the UI of the app:
>
> 1) The Chief of Staff conversation should, by default, have a clear, standalone position at the top of the list and look different from the rest. The UI should make it clear to the user that the Chief of Staff conversation is the unique, go-to, top level chat.
> 2) There are no right-click options on chats or messages like telegram
> 3) There are MANY very confusing conversations viewable that just say "App". I'm not sure what purpose these serve, but if they need to exist this is EXACTLY why we should have heirarchies of conversations"

The photos stay in the private archive.

## Relayed Request
> Find what creates them. Then fix it at the source: they should nest under their parent project or the Chief of Staff in a hierarchy, or not be created as top-level chats at all. Do not delete any existing conversation without telling me first.

## Diagnosis And Root Cause
1. WorkBoardRuntime.ensureConversation intentionally creates an App backing conversation for a live non-redacted card, through the server conversation seam and applyCreate(work-board,...). It is functional storage, not automatically a duplicate. Relevant to DS-LAYOUT-13: functional storage is not itself a duplicate.
2. App-platform session creation also calls applyCreate(dashboard,...) without parent context. Ordinary mobile create currently accepts title/requestId and does not carry a parent. Breaks DS-LAYOUT-13: creation carries no parent.
3. App creation persists the created event, owner and alias. It does not establish hierarchy. The list obtains parentConversationKey from a separate authoritative Chief tree. Work card projectKey groups cards but does not establish chat parentage. Breaks DS-LAYOUT-13: creation does not establish hierarchy.
4. Read-only live examples were matched by conversation UUID to Work Board card data, not by titles: two backing chats had project grouping but parentConversationKey:null. The live first page separately exposed the canonical pinned Chief row. The richer graph route returned503. Breaks DS-LAYOUT-13: live backing chats have no parent.
5. The flat UI consequently exposes helper work beside person-created primary chats, with a generic App subtitle and internal task-like titles. Client-only title guesses would hide the symptom and corrupt ownership semantics. Breaks DS-WORDS-2 and DS-WORDS-3 (internal text and ids as names) and DS-LAYOUT-8 (grouped by kind), and DS-LAYOUT-13.

Source evidence supplied by parity owner: canonical main6db601344, WorkBoardRuntime.ts:424, commands/server.ts:11183, routes.ts:15042and15306–15346, mobileConversationRoutes.ts parent projection. Private live-reference artifact: docs/projects/telegram-parity-parent-proposal.json in Echo home; peer messages5b69bb9c-b4f4-44e8-abda-8e406059457f and76bc6697-e108-49f7-94da-79a0c2d83c78. No private UUIDs or message contents are needed in the public diagnosis.

## Rules And Sharpening
- DS-WORDS-2/3/5: internal job text and opaque identifiers are not useful navigation names.
- DS-LAYOUT-8 and DS-PARITY-1/4: group by meaning and preserve discoverability instead of silently losing data.
- DS-DELIGHT-6: awkward real data includes many generated work-card/helper chats, not only a tidy set of hand-made examples.
- Missing rule at the time: creation records authenticated provenance and an authorized parent, explicit root placement or recoverable unplaced state. Missing legacy metadata is unknown, not authority to invent a root or parent. Read and write projections share this policy. The earned rule is DS-LAYOUT-13.


## Rules this entry added or sharpened

| Rule | Added or sharpened | Problems |
|---|---|---|
| DS-LAYOUT-13 | Added | 2, 3, 4, 5 |

## Concrete Fix And Structural Checks
The parity owner implements server-recorded provenance and validated parent handling, replication, retries and previewed reconciliation. Draft creationSource and hierarchyState field names are proposals, not shipped APIs. Durable create with failed parent linkage remains recoverably unplaced. Both-side access, namespaces and cycles are checked on the server. sourceConversationKey is origin context, not automatically current parent. Mac presentation uses the final verified contract, keeps absent fields compatible, and exposes unplaced work in a recoverable separate bucket. Do not infer hierarchy from projectKey, title or a missing field; do not confuse machine placement with hierarchy.

Regression checks cover Work Board and session creation, explicit person-created roots, partial linkage failure, retries, restart/replication, private or foreign parents, cycles, old-server responses, legacy unknowns, readable unplaced work, and unchanged existing records. Real captures show normal and large-text hierarchy with crowded data. Any existing-chat reconciliation is previewed; no existing conversation is deleted.

## Status
Root cause and private live-reference evidence recorded. Server card wc_26e234784f116ae6 owns implementation. Client contract adoption, reconciliation proof and releases remain required. Nothing moved or deleted.

## Earlier Server Owner Readiness Snapshot
At 14:13 PST on 2026-11-22 the parity owner confirmed that provenance, hierarchy state and reconciliation remain audit/draft work only. The three backend cards have no implementation pickup, exact tested head or deployment proof. Existing generated Work Board conversations are preserved. The app must continue handling absent metadata and may not claim the generated-root problem is fixed by the distinct Chief control. The owner was asked to progress the already authorized server work, without prompting Justin again for a default board approval label.


## Canonical Register Disposition

Earned rule: DS-LAYOUT-13. This record remains open. Adding a rule does not certify its implementation or release. The independent app and server owners retain the execution and proof requirements above.

Creation provenance and validated hierarchy remain owned by the server work card. The navigation release does not establish parentage or close this feedback item. No existing conversation has been moved or deleted by this register update.

## Later Client Release Receipt

The Apple owner reports Mac 0.5.2 build 137 at source bee1f46dd6e3c1c5cd7e849510967b6e6f74f5da, with verified child nesting and a recoverable unplaced group in that client. Its normal installed update completed at 2026-11-23 09:53:33 UTC. This supersedes a claim that all client implementation is still absent; it does not establish actual production-owner graph activation, complete server provenance adoption or reconciliation of existing chats. Deferred title readability polish remains separately tracked by the app owner. The earlier startup failures and private evidence remain retained. This register has not moved or deleted a conversation, and this entry remains open.

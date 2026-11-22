# DF-0004 · Generated work belongs under its real parent

Date: 22 November 2026, 13:26 PST. Source: Justin’s feedback relayed by Chief of Staff in message e6e0479a-e8d7-4db1-b1bb-c4c371093ada. The quoted request below preserves that relay; the packet does not contain a direct transcript of Justin’s wording.

Original owner captures remain in the private feedback archive. No original image or private conversation content is published here. This public-safe diagnosis preserves the Chief of Staff relay as a relay, rather than presenting it as a direct owner quote.

## Relayed Request
> Find what creates them. Then fix it at the source: they should nest under their parent project or the Chief of Staff in a hierarchy, or not be created as top-level chats at all. Do not delete any existing conversation without telling me first.

## Diagnosis And Root Cause
1. WorkBoardRuntime.ensureConversation intentionally creates an App backing conversation for a live non-redacted card, through the server conversation seam and applyCreate(work-board,...). It is functional storage, not automatically a duplicate.
2. App-platform session creation also calls applyCreate(dashboard,...) without parent context. Ordinary mobile create currently accepts title/requestId and does not carry a parent.
3. App creation persists the created event, owner and alias. It does not establish hierarchy. The list obtains parentConversationKey from a separate authoritative Chief tree. Work card projectKey groups cards but does not establish chat parentage.
4. Read-only live examples were matched by conversation UUID to Work Board card data, not by titles: two backing chats had project grouping but parentConversationKey:null. The live first page separately exposed the canonical pinned Chief row. The richer graph route returned503.
5. The flat UI consequently exposes helper work beside person-created primary chats, with a generic App subtitle and internal task-like titles. Client-only title guesses would hide the symptom and corrupt ownership semantics.

Source evidence supplied by parity owner: canonical main6db601344, WorkBoardRuntime.ts:424, commands/server.ts:11183, routes.ts:15042and15306–15346, mobileConversationRoutes.ts parent projection. Private live-reference artifact: docs/projects/telegram-parity-parent-proposal.json in Echo home; peer messages5b69bb9c-b4f4-44e8-abda-8e406059457f and76bc6697-e108-49f7-94da-79a0c2d83c78. No private UUIDs or message contents are needed in the public diagnosis.

## Rules And Sharpening
- DS-WORDS-2/3/5: internal job text and opaque identifiers are not useful navigation names.
- DS-LAYOUT-8 and DS-PARITY-1/4: group by meaning and preserve discoverability instead of silently losing data.
- DS-DELIGHT-6: awkward real data includes many generated work-card/helper chats, not only a tidy set of hand-made examples.
- Missing rule at the time: creation records authenticated provenance and an authorized parent, explicit root placement or recoverable unplaced state. Missing legacy metadata is unknown, not authority to invent a root or parent. Read and write projections share this policy. The earned rule is DS-LAYOUT-13.

## Concrete Fix And Structural Checks
The parity owner implements server-recorded provenance and validated parent handling, replication, retries and previewed reconciliation. Draft creationSource and hierarchyState field names are proposals, not shipped APIs. Durable create with failed parent linkage remains recoverably unplaced. Both-side access, namespaces and cycles are checked on the server. sourceConversationKey is origin context, not automatically current parent. Mac presentation uses the final verified contract, keeps absent fields compatible, and exposes unplaced work in a recoverable separate bucket. Do not infer hierarchy from projectKey, title or a missing field; do not confuse machine placement with hierarchy.

Regression checks cover Work Board and session creation, explicit person-created roots, partial linkage failure, retries, restart/replication, private or foreign parents, cycles, old-server responses, legacy unknowns, readable unplaced work, and unchanged existing records. Real captures show normal and large-text hierarchy with crowded data. Any existing-chat reconciliation is previewed; no existing conversation is deleted.

## Status
Root cause and private live-reference evidence recorded. Server card wc_26e234784f116ae6 owns implementation. Client contract adoption, reconciliation proof and releases remain required. Nothing moved or deleted.

## Server Owner Readiness Check
At 14:13 PST on 2026-11-22 the parity owner confirmed that provenance, hierarchy state and reconciliation remain audit/draft work only. The three backend cards have no implementation pickup, exact tested head or deployment proof. Existing generated Work Board conversations are preserved. The app must continue handling absent metadata and may not claim the generated-root problem is fixed by the distinct Chief control. The owner was asked to progress the already authorized server work, without prompting Justin again for a default board approval label.


## Canonical Register Disposition

Earned rule: DS-LAYOUT-13. This record remains open. Adding a rule does not certify its implementation or release. The independent app and server owners retain the execution and proof requirements above.

Creation provenance and validated hierarchy remain owned by the server work card. The navigation release does not establish parentage or close this feedback item. No existing conversation has been moved or deleted by this register update.

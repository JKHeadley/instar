---
title: Keep Generated App Chats With Their Origin
slug: conversation-creation-context
author: echo
status: approved
tier: 2
parent-principle: "Observation Needs Structure"
approved: true
approved-by: "Echo, after reading the bounded review report, under Chief handoff 1b9a32d3-0f69-43f4-90a8-3caea1ded254"
card: wc_26e234784f116ae6
eli16-overview: docs/specs/conversation-creation-context.eli16.md
review-convergence: "2026-11-22T22:54:34.151Z"
review-iterations: 1
review-completed-at: "2026-11-22T22:54:34.151Z"
review-report: "docs/specs/reports/conversation-creation-context-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Keep Generated App Chats With Their Origin

## Problem And Authorized Scope

Work Board and session creation currently produce App conversations without recording their source or parent. The app consequently presents them as unrelated roots. Chief of Staff handoff1b9a32d3-0f69-43f4-90a8-3caea1ded254 explicitly selects this bounded first increment: record new creation context, expose verified hierarchy, offer a read-only existing-chat preview, and have Apple nest verified children. It explicitly excludes any claim of recovering metadata while its creator is offline. Parent work remains ahead of mute/archive. This narrows the preceding capped draft; that draft and actual review reports remain in reports for audit.

No existing conversation is deleted, rewritten, automatically reparented or hidden. No access or audience is widened. Transferable original-author proof (wc_d3ce8fd1ba6a5cde) and competing creates under one card key (wc_baa561764dcb692b, including loss assessment and numbered post-mortem if confirmed) are separately tracked findings, not silently claimed fixed by this increment.

## Durable Creation Contract

Add optional validated creationContext to immutable App created events:

```
{v:1,source:{kind:"person"|"work-board-card"|"session",cardId?,requestId?,originMachineId?,sourceConversationKey?,projectKey?},parentConversationKey?:canonicalRef|null,parentBasis?:"explicit"|"source"|"project"}
```

Server code assigns source kind/producer; clients can supply only optional parent intent. Existing protocol bounds apply. Durable App refs are app:<uuid> (normalize bare UUID); Telegram uses positive topic refs; Slack uses stable registry identity. Preserve bounded raw legacy source/project plus origin, but do not convert machine-local negative aliases into a durable parent during writes. Read-only resolution may establish a unique real canonical conversation; ambiguity stays unresolved. No title inference.

Store a complete validated winning created-event snapshot in one nullable derived creationRecord JSON column. This contains base fields and optional context, enabling deterministic earliest (at,machineId,eventId) context selection without reopening JSONL per row. Existing owner selection remains unchanged; if context-winner owner differs from effective conversation owner, context is unavailable. NULL migration preserves legacy unknown. Index rebuild and new replication allowlist/validator preserve the field. Old codecs retain the chat but strip the field (actual previous-codec fixture); those copies remain unknown. This increment adds no companion kind, all-member receipt protocol, offline-recovery guarantee or new synchronization authority.

A locally recorded creation context or an upgraded replica's validated event is evidence, not current parent authority. Do not trust peer list metadata. Preserve normal authenticated App replication admission; do not mistake arbitrary inner origin text for independent original-author proof. No current parent is inferred from missing/conflicting or unverifiable evidence. Before same-id suppression, durably retain validated created-evidence observations in an append-only evidence log alongside the conversation store, fsync before acknowledging their contribution. This log records received created-event copies, not messages or authoritative placement; its read projection/rebuild joins the same evidence. Identical base + missing context contributes no evidence; identical base + one validated context uses that context in either arrival order; two differing validated contexts or differing bases for the same id mark conflict permanently across restart/index rebuild. Never clear a conflict by choosing one surviving index winner. Evidence is derived from the same locally received App event replication and is retained when its duplicate would otherwise disappear; it adds no claim of replication completeness or independent author proof. Reads never append or repair the log. Test stripped-first/full-first/conflicting orders through restart/rebuild. Mark projection unresolved and retain existing primary events; do not silently replace them. This is conservative detection, not a claim that the underlying competing-create defect is fixed. The two-machine delivery-order tests must demonstrate uncertainty rather than fabricated convergence when evidence conflicts.

## Creation Writers And Recovery

Person POST /mobile/conversations accepts optional parentConversationKey; omitted means explicit root. Session POST /sessions/create platform app accepts the same field; omitted means generated unplaced, explicit null intentional root. At first reservation, nonnull parent must exist and be readable under current caller scope; existing shared-readable parents are allowed without a new common-owner restriction. Parent recording never grants access or writes Chief placement.

Look up request reservation before deriving context. Hash caller intent including presence/normalized parent; persist complete context in reservation and reuse it after restart/retry. Keep legacy no-context reservation hashes compatible. Changed explicit parent under same requestId fails. Recovery retains authorized historical context while enforcing current child admission; current parent visibility is separately rechecked at projection, and completed retry returns only ordinary authorized child result.

WorkBoardRuntime passes context from the immutable recorded card-created evidence, not today's edited project assignment. Context source/card id and recorded origin are server assigned. Distinct eligible source/project candidates remain unresolved; matching candidates can qualify via either source proof or confirmed project binding. Existing conversations are not backfilled. Existing Work Board base-event/deduplication mechanics are unchanged in this bounded increment; uncertainty from observable conflicting created evidence suppresses fallback placement. Do not introduce a purported canonical origin or transferable signature that existing transport cannot prove.

## Reader-Scoped Hierarchy

Owner-role devices and existing Bearer readers receive additive creationSource and hierarchyState:root|child|unplaced|unknown on App list rows; parentConversationKey remains the compatible field. Keep existing Chief-parent audience: team/MSP rows receive none of these metadata references, even where the child is readable. This retained scope does not create a new access grant. Strip raw creationContext from ALL device event streams, including owners. Peer list assertions are stripped and enrichment uses locally held validated records only.

Use one final enrichment for normal, pinned and list-pinned rows after ordinary visibility filtering. Individually validate every parent/source/project/card/session reference under the reader scope. Unknown or newly unreadable nonnull recorded parent means unplaced, including person-created chats; never root. Legacy absence means unknown. Exact immutable Work Board card->conversation binding may establish generated-kind evidence (evidence:card-binding) for a legacy chat without adding a current parent; its placement remains preview-only. New recorded context is evidence:created-event.

Capture one complete Chief tree/project-binding view. Explicit stored tree entry, including null, wins. If its parent is currently unreadable, retain that placement authority, omit its reference, emit unplaced and suppress every historical fallback; test with another readable historical candidate. Disabled/unavailable/incomplete is not an empty tree: generated chats become recoverably unplaced, unproven legacy/person unknown. With a complete view and no explicit entry, explicit-null=>root; recorded real readable source/explicit parent=>child; project parent requires current confirmed owner binding; unresolved generated/non-null intent=>unplaced. Historical context does not override later placement.

Complete view/projection caches use strict source signatures, relevant Chief-kind pending sequence state, local creation-index generation, registry alias and immutable card-evidence generations, and reader scope/authorization generation. Non-ENOENT enumeration/stat errors or changing before/after signature yield unknown. No TTL or global pending count proves completeness. Dirty reads return uncertainty and coalesce background refresh outside HTTP. Refresh is non-flushing/non-repairing, starts outside requests, retries on existing Chief ticks/source changes/explicit background refresh without a new timer. Unchanged polls do not scan archives or the full inventory. Cooperative finite visited/memoized graph computation checks full effective relation independently of pagination; suppress every fallback edge in a cycle, preserve explicit tree entries, and never mutate tree state. Authorization changes invalidate scoped caches and emitted references are checked again.

Apple must nest verified children and present generated unplaced rows recoverably. This requirement is handed to the Apple owner; server merge alone does not finish the card.

## Read-Only Existing-Chat Preview

GET /mobile/conversations/parent-preview?cursor=&limit= is available when native conversations are ready, independently of rich graph readiness. Add exact signed-device ownerOnly and browser conversation-read allowlist entries, plus runtime active owner or Bearer admission; person:null is not owner proof. Reuse existing list pagination bounds.

Return {dryRun:true,canApply:false,rows:[{conversationRef,currentParentConversationKey?,proposedParentConversationKey?,creationSource?,action:"would-place"|"keep-current"|"unresolved",reason}],nextCursor}. Use exact card references and recorded creation evidence, never titles. Any existing explicit placement is keep-current even when historical evidence differs, including explicit root versus proposed A and explicit B versus proposed A. A validated current fallback that already matches is also keep-current. Capture current relation first; assess legacy proposals against that fixed relation, suppress only cyclic new proposal edges. A current B->A survives a rejected proposed A->B. Missing/conflicting/unreadable evidence is unresolved with a plain reason. No ensureConversation, append, journal flush/repair, emit, rename, delete, reparent, apply token or apply route. Primary/index/tree contents are unchanged by reads.

## Multi-Machine Posture

Unified through existing App conversation event replication with additive optional context. Older peers may strip it; an answering machine without verified context reports unknown/unplaced and does not trust remote list assertions. No claim of recovery through another holder while the origin is offline. Original-author proof and competing-create substrate repair remain tracked separately. If a context loss is indistinguishable from legacy absence, report unknown rather than fabricate loss counts. Known conflicting evidence is visible as unresolved. Source merge, deployed readiness and native behavior are separate claims.

## Decision Points Touched

- Shape, canonical identities and schema domains — invariant; basis: enumerable-domain; evidence: existing protocol validators.
- Current access, owner metadata audience and per-reference redaction — invariant; basis: irreversible-consequence; evidence: preserve existing disclosure boundaries.
- Explicit tree overrides and unknown versus empty — invariant; basis: enumerable-domain; evidence: current stored placement authority.
- Placement evidence — judgment-candidate; floor no guessed/refuted evidence, no mutation/access grant; arbiter current readable source or owner-confirmed project binding, unresolved default.
- Preview — judgment-candidate; floor dryRun true/canApply false; operator/Chief inspects recorded evidence before any separate placement action.
- Existing data retention — invariant; basis: irreversible-consequence; evidence: no deletion or rewriting.

## Frontloaded Decisions

1. New optional context only, nullable indexed winning snapshot, legacy unknown.
2. Existing authenticated App replication, no companion or offline recovery claim.
3. Server-assigned provenance, canonical identities and immutable card source evidence.
4. Existing owner scope and independently readable references, no access grants.
5. Current explicit placement wins; incomplete is unknown.
6. Person omission root; session omission unplaced; persisted retry snapshot.
7. Scoped source-version caches and deterministic cycle handling outside HTTP.
8. Exact owner-only read-only preview, no changes to old chats.
9. Track the two replication foundation gaps separately and expose uncertainty.
10. Full verification through throughput; exact Apple native proof before card completion.

No cheap-to-change-after tags and no unresolved operator decisions.

## Implementation Map

AppCreationContext validates the historical schema. AppConversationStore retains created observations and the winning indexed snapshot; AppConversationsReplicatedStore preserves the optional field. CreationPlacementSnapshot maintains the complete non-flushing Chief view through ChiefOfStaffLoop. AppCreationHierarchyProjection computes the scoped current relation and preview for mobileConversationRoutes. WorkBoardRuntime supplies immutable card evidence. AgentServer and commands/server wire the substantive production dependencies.

## Test Strategy

Unit: context validation, winning snapshot/migration/rebuild/owner consistency, new wire roundtrip, actual previous-codec field stripping with conversation survival, conflicting duplicate metadata yields uncertainty; reservation/recovery/legacy hashes. HTTP: real create paths, current permission revocation, owner/event redaction, all row pools, preview exact admission and no mutation, valid/missing/unconfirmed parents, complete-empty vs unavailable tree, cross-page cycle order independence, scoped cache invalidation from registry/card/auth changes. Lifecycle: production Work Board/session creation and preview returns200 when native ready and graph off, real injected seams not no-ops, restart/replication retains supported context and missing evidence stays unknown. Focused tests locally; complete exact-head verification through echo-increasing-throughput per Chief handoffdaf98781-e21b-47f2-a68e-409a2925172c. No manual full suites.

## Rollout, Awareness And Rollback

Add awareness file via existing awareness refresh. Existing index opens add nullable column idempotently; no manual setup. Revert removes recording/enrichment/preview, leaving optional JSONL and unused derived column safely. Old clients ignore optional list fields, old codecs preserve conversation but omit context. The supplied actual previous-reader probe is the compatibility evidence. No rollback deletes user chats.

## Maturation plan

- **test-agent-live:** Throwaway native-enabled production initialization proves creation and read-only preview, plus uncertain placement when evidence is missing.
- **dev-agent-live:** On Echo after deployment, inspect exact recorded source and dry-run preview without moving any existing chat; record counts of verified child/unplaced/unknown rows from those owner-scoped states, without collecting message content or inventing lost legacy counts.
- **fleet:** After observed development-agent preview/list behavior and two independent readings of that evidence, follow the existing native-conversation release/update path; no extra feature switch or silent default graduation.
- **graduation criterion:** Focused three-tier checks plus exact-head throughput gate and Apple's exact native build showing verified nesting and recoverable unplaced rows.
- **dark-window:** No additional dark interval; remain unshipped until the checks above, preserving current native feature readiness.
- **ladder:** mobilePairing.native

## Open questions

None.

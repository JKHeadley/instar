# Side Effects: Generated App Chat Origins

Spec: docs/specs/conversation-creation-context.md. Principle reference: docs/signal-vs-authority.md.

## Change And Scope

New App creation paths record optional historical source and parent evidence. Owner list readers receive verified hierarchy and a read-only existing-chat preview. This does not delete, move, hide or rename existing chats and does not grant access. The Chief explicitly narrowed the increment in handoff1b9a32d3; transferable author proof and competing Work Board creates remain tracked as wc_d3ce8fd1ba6a5cde and wc_baa561764dcb692b.

## Over-Block

Unverifiable, conflicting, unreadable or incomplete evidence suppresses only historical fallback placement, not the authorized conversation itself. Existing explicit placement always wins; an unreadable explicit parent remains authoritative but its reference is omitted. Older replicas may show unknown/unplaced because their codec stripped metadata. Existing shared-readable parents retain current authorization rather than requiring common ownership.

## Under-Block

This does not establish transferable original-author authentication or guarantee context recovery while the creator is offline. Existing upstream competing-create loss can hide a conflicting history that never reaches this replica; no title guess fills that gap. Observed conflicts are retained durably before duplicate suppression and stay unresolved through index rebuild.

## Level Of Abstraction

Immutable creation context belongs in App created events and the derived index. Work Board supplies immutable source evidence. The list/preview share a reader-scoped projection; the existing Chief tree remains current placement authority. Complete tree reads are cached outside HTTP, not implemented by polling the mutable dashboard graph or flushing a journal in a read route.

## Signal Versus Authority

Source/project observations are evidence. Existing access controls and explicit owner-confirmed placement hold authority. Missing evidence yields uncertainty and no mutation. The preview is structurally dryRun:true/canApply:false and has no mutation endpoint. Schema identities and permission boundaries remain deterministic invariants; uncertain placement does not hide a chat or block ordinary messaging.

## Interactions

Reservation/recovery persists the historical context before creation and reuses original caller intent. A retry after the event was durably appended does not manufacture a new timestamp under its existing event id. Existing owner winner remains unchanged; a differing context-owner winner cannot expose provenance. All device event reads remove raw creationContext. All normal/pinned list paths use final scoped enrichment. Source signatures include current Chief streams/pending state, creation evidence, registry mappings, Telegram topic identity, card evidence and reader authorization.

## External Surfaces

Optional parent input on App person/session creation; optional owner list metadata; exact owner-only signed/Bearer GET /mobile/conversations/parent-preview. Existing clients ignore additive fields. Team and managed-person devices retain current metadata audience. Apple owns native presentation and release; exact native/user-channel proof is required before card completion.

## Multi-Machine Posture

Optional context travels with existing authenticated App event replication. Updated codecs preserve it; old codecs retain the chat while dropping unknown context, reported honestly as unknown/unplaced. Durable local received-evidence observations preserve observable conflict across rebuild and do not claim all-machine commitment. No credentials/message text are newly replicated. No companion stream, receipt protocol or offline-recovery promise ships here.

## Rollback Cost

A source revert stops recording/enrichment/preview. Optional JSONL and derived nullable column can remain safely. Received creation-evidence observations can remain; rollback does not delete user content or require rewriting old chats. Existing update/open path adds the column idempotently; awareness file refresh reaches existing agents.

## Verification

Focused checks passed for creation/storage and mixed-version observations, Work Board immutable provenance, service restart/recovery, complete snapshot pending/read behavior, awareness and production wiring. Session-create HTTP (11), neighboring list-pin HTTP (6), and a real AgentServer session-create/preview lifecycle (1) passed. Scoped hierarchy unit tests passed12/12; new owner/create/preview HTTP passed8/8 and existing native-conversation HTTP passed12/12. Source TypeScript and whitespace checks passed. The throwaway test-as-self --no-roundtrip deployment passed startup/verification and tore down its processes. Full exact-head suites go through the normal throughput verification queue; no manual full suite pass is claimed.

## Second-pass review

**Reviewer:** context_spec_security (independent source reviewer; personally confirmed the prior review, exact-head corrections and identical shared Node24 lifecycle-fixture adoption).

## Independent Review

Independent security/correctness review concurred after verifying source validation, current authorization, cache identity and DTO redaction. Performance review concurred after a second pass verified pending-write completeness, unfiltered graph inventory and one source per response. Adversarial/gaps review concurred after verifying optional invalid Work Board source handling through a real store and current-child checks on completed create retries. The runtime audit records both the corrected findings and the clean second pass; these reviews do not replace full queue verification.

## Operator-Surface Quality

The owner sees readable placement states and preview reasons. No raw token, JSON template or technical identifier entry is added to native user flows; the app supplies validated parent references. The preview cannot execute changes. Agent Proposes, Operator Approves: this increment offers evidence for later placement decisions, not a new approval or authority grant. It preserves current owner-only parent metadata and never silently broadens who can see or change a chat.

## Self-Action Scope

The unbounded-self-action class is not introduced: background refresh is coalesced and triggered by source changes, the existing Chief tick or an explicit external read, and never schedules itself after success/failure. Unknown source versions do not repeatedly self-retry. Existing full verification admission is respected.

## Shared Fixture Correction Provenance

The native Node24 diagnostic proved a disconnected test page retained its real polling lock. The shared N79 owner corrected fixture lifecycle disposal and obtained one newly allocated whole-file run:29passed on actualNode24.14.1 with real SQLite. This branch adopts exact tested blob473d0d1ed9c91a249c01cea530f84130927426f5; independent review confirmed unchanged assertions/deadlines and identical dashboard source. No duplicate focused/full suite is claimed. The earlier wait-only correction was insufficient for this native lock lifetime. Production behavior is unchanged.

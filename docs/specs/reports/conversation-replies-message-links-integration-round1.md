# Integration Review — Round 1

Reviewer: inherited Codex runtime; an exact model identifier is not exposed. Read-only source review; no tests or source edits.

## DESIGN — Explicit quoted-send capability is missing

The rollback section correctly says older servers cannot prove quote support, but the protocol does not define the evidence a client must obtain before sending `replyTo`. Existing send handlers accept selected known input fields and do not implement this field. An old holder can therefore return a successful ordinary send after ignoring the quote. Recognizing the missing quote only after sending cannot undo that external side effect.

Define an additive local protocol capability, advertised only when v3 signing, reference resolution and projection are wired. Require the app to establish that capability on the actual serving holder before enabling quoted send. Missing/unknown capability means unsupported, with no automatic unquoted retry. A missing quote receipt after a submitted request is an uncertain outcome to reconcile through the same request identity, not permission to resend. Test an old holder that returns an ordinary successful response. Reuse current capability/status machinery rather than introducing discovery storage.

## DESIGN — A history-page miss does not establish exact-message absence

Signed Reply Input uses the bounded history/pin reader as final admission. A selected older source can be absent from that window while still existing and readable. The same issue applies to link creation. Existing App storage has indexed message/event identities; use its exact lookup or existing exact-source resolver under the same current access gate. For platform history without an exact available lookup, distinguish temporarily unverifiable from an established absence internally while preserving the specified non-disclosing public refusal. Do not scan unbounded history or add a separate locator subsystem. Test an exact readable source outside the newest history page.

## PRECISION — Codec loss is permanent under current duplicate handling

`AppConversationsReplicatedStore.ts` has an explicit field allowlist, and `AppConversationStore.validateReceipt()` treats unknown receipt versions as legacy-shaped receipts, dropping version-specific fields. `AppConversationStore.write()` returns immediately for an existing conversation/event ID. Consequently stripped-first arrival followed by the complete original does not repair the stored event, even while the original machine is online. Rebuild of that stored JSONL cannot restore the lost fields either.

Make this concrete in the compatibility contract and actual previous-codec fixture: degraded copies remain quote-unavailable under current deduplication, and must never be advertised as preserving complete quote state. If repair is required, explicitly choose authenticated enrichment through the existing event path; do not assume ordinary replay performs it. No all-member receipt protocol or parallel quote store is implied by this finding.

## Other seams

The proposed exact signed/browser read is appropriately narrower than `/messages/link`. Existing Telegram and Slack link builders encode real physical target identifiers; the App helper is conversation-only and needs the existing `m` target added explicitly. Dashboard `findSource()` already performs bounded paging with explicit continuation, so reusing it is coherent and does not require another lookup service. Unified stored references versus holder-local provider credentials are correctly separated. Current-reader source projection explicitly covers signed-body and receipt side channels, pool reads, pins and previews. Provider `replyMirror` remains independent from dispatch and ordinary mirror success. Production lifecycle proof must retain the specified real initialization and middleware coverage.

Verdict: revise the two design gaps and make codec-loss behavior explicit before implementation. This review does not claim an independent external review passed.

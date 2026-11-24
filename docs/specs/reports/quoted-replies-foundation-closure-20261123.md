# Quoted Replies: Foundation Closure And Implementation Boundary

Recorded 2026-11-23. Card: `wc_4d8dd0e0144b636e`. Source worktree: `conversation-message-actions`, branch `feat/conversation-message-actions`, head `80c92dc38a88bd1763ca674dce5395c795fcd3f1`, package `1.3.1979`. The cached main is `ec9401e5bdf28ed5ab1ff13f88e0032cc7895fc6`; the inspected signature, request-store, App-store and native route source files have no diff between these heads. No remote freshness, merge, release or live-provider result is asserted.

## Disposition

The bounded design already records the four owner decisions: bind the exact replying base, mask every unresolved original identically, preserve existing stop authority, and retain existing crash recovery. Chief's compatibility decision is retained: no durable transferable proof, quote-evidence stream, duplicate enrichment or historical reconstruction service. Known unverifiable quotes show exactly “Quoted message unavailable.” Total marker loss cannot produce a truthful per-message chip.

The quoted runtime is not implemented. The separate App-link source remains an actual implementation prerequisite, not an installed library. Its staged files were read to identify contracts, not copied, merged or treated as verified. This report advances independent proof and integration planning while that source is frozen under its own test custody.

## Minimum App-Link Foundation To Integrate

| Symbol or contract | Concrete dependency | Quote usage |
|---|---|---|
| `appMessageReader(pairing, req, accessRef).current()` | `src/server/appMessageReader.ts`; returns a current person, captured admission and `AppMessageReadPolicy`, or null | Re-resolve the original signing actor and reader after awaits. Never switch to whichever person later occupies the same device ID. |
| `AppMessageReadPolicy` | `src/server/appMessageReads.ts`; immutable fingerprint plus `mayRead(StoredMessageEvent)` | Apply current source visibility independently of reply-base visibility. |
| `visibleMessageTarget(store, ref, eventId, 'event', policy)` | `src/server/appMessageReads.ts` over `AppConversationStore.readMessageTarget` | App selects the exact event. A shared public message ID cannot select another original. Null is translated into the quote route's single masked unavailable response. |
| `messageWitnessesCurrent(store, ref, witnesses, policy)` | `src/server/appMessageReads.ts`; exact event re-read, deep equality and current policy | Verify the captured source after the final await, alongside the current actor, destination and holder. |
| `AppConversationStore.captureMessageReadFrame()` and `readMessageTarget()` | Store's positively decoded indexed source and reset evidence | Use real stored bytes, not a recent page or index location alone. Frame currentness does not replace actor authorization. |
| Typed `e` navigation | `src/core/messageLinks.ts`, the dedicated App source/context routes and guarded web generations | Available App quote opens its exact original while preserving the current draft/files. Never restore the removed historical public-ID DTO. |

These are specific candidate interfaces, not a request to import every link change. The prerequisite's actual guarded commit and complete verification must determine what source is integrated. There is no exported `readAppMessageSource` helper in that candidate; the actual source functions are named above.

## Actual Baseline Proofs

Two existing whole unit files ran through normal enforcing targeted admission under Node24: `mobile-chat-requests.test.ts` and `app-record-signatures.test.ts`. All 21 tests passed in 2.02 seconds. They establish existing request reuse, restart uncertainty and receipt/key-rotation behavior. They do not test the new quote protocol.

A separate one-shot historical baseline probe ran through the same normal unit configuration: three cases passed in 1.59 seconds. It established:

1. The current old App codec drops a supplied `replyTo` and strips a supplied version3 receipt down to legacy signature fields. It retains the base text. This directly supports the disclosed mixed-version compatibility limit, not a new receipt verifier's correctness.
2. Ingesting a base first and a later same-event duplicate carrying quote metadata does not enrich the already stored base. Reopening the real store preserves that result. No second message or quote repair was manufactured.
3. The real request store retains fixed opaque reservation metadata over restart, answers outcome-unknown and refuses re-reservation or payload-hash reuse. It does not hold the message text from which a missing append could be reconstructed.

The probe was archived verbatim outside normal test discovery after execution: `.instar/state/build/quoted-baseline-probe.fixture.txt`. It characterizes historical behavior and is intentionally not installed as an acceptance test that would demand future codecs keep stripping quotes. Exact source/fixture hashes and logs are in `quoted-foundation-proof.json`, `quoted-foundation-focused.log` and `quoted-baseline-probe.log`. No full suite, quote HTTP route, startup lifecycle or provider test ran.

## Four Runtime Closures Still Required

**Exact base binding.** `AppRecordSignatures.ReceiptSignature` presently describes legacy/v2 receipts. `verifyRecordedOrigin` chooses v2 only when `v===2`, otherwise the v1 payload. The new version must have explicit dispatch, exact bytes and comparison against the immutable replying base's actual destination, event ID and message ID. Unknown versions cannot be interpreted as v1 by the new verifier. The actual stored source event supplies the selected original's event/public IDs. Preserve unquoted v1/v2 behavior; a copied origin verdict is not quote authority.

**Masked source response.** After conversation authorization, App source absence, hidden source, ambiguous source, unreadable bytes and failed/unfinished lookup all become the identical `409 {error:"reply-source-unavailable",retryable:true}`. The link reader's internal distinctions never escape through this route. Known unavailable projections carry no source ID, text, author or nested proof. ACL revalidation must use the exact current visible reply coverage, not an empty incremental response or an unrelated next-page cursor.

**Existing stop authority.** The current App and Slack routes contain both `isExactStopMessage` and `sentinel.decideInboundDisposition`. The latter uses its current kill/pause/continue policy and idempotent message key. A dedicated quote action must invoke those existing authorities for authenticated authored text before a new missing-original or missing-signer refusal; it cannot add a phrase matcher or classify hidden source text. Preserve scoped emergency routing and semantic negation behavior, signed-device admission and authentication-time read-quota exemptions. Source presence and quote metadata do not create stop authority.

**Crash recovery.** `AppConversationService.recoverStranded()` treats an entered `op:send` without its stored message as not-delivered. A stored pending message receives unknown delivery and the reservation remains outcome-unknown. It does not reconstruct or redispatch the send. New quote metadata must travel in the original durable reservation without weakening those outcomes, changing identity on retry, refreshing operation IDs or falling back to an unquoted send. Provider admission without an acknowledged linkage remains transport-unknown independently of App dispatch.

## Provider Boundary

Telegram must positively establish the actual physical chat, wire-topic and provider message ID at ingestion or an exact verified source. A historical topic-only row cannot gain that evidence from today's configuration. Slack must keep its registered workspace/channel/thread and exact timestamp; a recent-page miss is unavailable. Slack exact-message native linkage remains unsupported for this increment. A fake transport can test outcomes but cannot certify a live provider acknowledgment.

## Next Execution Boundary

Close the bounded spec review against these actual interfaces, retaining the existing round ledger and cap. Integrate the App-link foundation through the normal branch process only after its real candidate is committed and verified. Then run quote-specific RED/GREEN unit, signed HTTP and production AgentServer lifecycle tests for the four closures. Native cache/navigation/composer proof stays with the named app owner; a delivered handoff is not accepted native behavior. Chief publishes exact committed heads and throughput owns complete verification.

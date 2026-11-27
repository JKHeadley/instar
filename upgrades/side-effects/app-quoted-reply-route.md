# App quoted Reply checkpoint

## Authority and effects

The signed App Reply route is off by default. When enabled for testing, it resolves the selected event from the held conversation and checks current send and original-message access before saving a reply. The machine receipt binds the authorized original to the immutable reply. Normal history and sync omit the raw relation and receipt. Existing holder and actor checks remain the authority for Stop.

A change outside the Reply route, declared after second-pass review (2026-11-27): src/commands/server.ts now gives AppConversationService the machine id `_meshSelfId ?? appSigner?.machineId() ?? os.hostname()` instead of `_meshSelfId ?? os.hostname()`. On a machine with a mesh id nothing changes. On a machine without one but with a machine identity, every App record and receipt written from then on carries the identity's machine id instead of the hostname, so it matches the id the v3 receipt signature is checked against. Records already stored keep their hostname value. Second-pass review found one comparison this breaks: Reply custody (ownsReplyCustody in src/server/mobileConversationRoutes.ts) requires the conversation's immutable creation record to name the current machine, so every conversation created before the change would have refused Reply with reply-custody-unavailable for good. Fixed: the service takes legacyMachineIds (src/commands/server.ts passes the hostname only when the machine has no mesh id), and custody also accepts a creation record carrying one of them, but 'local' is not accepted; an integration test covers refused, accepted and the 'local' case. Lesser effects of the same change: an old sync cursor stops matching and the client resyncs once from the start; old agent rows without an origin record read as other-machine instead of not-recorded; a later redone transcript gets a different derived id. A residual edge that predates this change: on a machine with a mesh id, a conversation created during early boot before the mesh id was set carries the hostname, and legacyMachineIds is empty there, so such a conversation still refuses Reply. The same signer fallback is in src/server/AgentServer.ts (the service built when one is not passed in), where the old fallback was 'local', which custody already refused. Rollback: revert that line; rows written in between keep the identity id.

## Recovery and verification

The route records the request before sending or stopping. The focused HTTP suite covered duplicate sends, missing and denied originals, receipt tampering, and revocation before Stop. The request claim is process-local before durable reservation. The immutable creation machine owns Reply custody and rejects another holder before classification. Held-work Stop uses a strict durable queue read and reports an unconfirmed result when that read fails or the queue is unavailable. Restart recovery records an unconfirmed result without replaying either effect. Authorized preview and full lifecycle acceptance remain pending.

## Second-pass review

**Reviewer:** independent Claude sub-agent, fresh context, not the author (Parity session, 2026-11-27 03:51-04:03 PT), after the repair-lane second pass (echo-m5-review-3-b1) dissented on the earlier head.

First verdict on the repair: OBJECT. The merge of 3812 left the integration file unparseable (the Reply describe was not closed before the outbox describe), and the receipt machineId change broke Reply custody for every conversation created under the hostname on a machine without a mesh id (ownsReplyCustody in src/server/mobileConversationRoutes.ts); the release note also claimed more than the code does. After the fixes (file closed, legacyMachineIds custody with an integration test including the 'local' case, side-effects note, release note reworded as the reviewer proposed): CONCUR WITH CHANGES, the only change being the release-note wording, which was applied. No likely first-run failure found by tracing; no tests were run on the M5.

## 6b. Operator-surface quality

This server checkpoint adds no visible control. It uses a single outcome for missing and inaccessible originals, and supplies a stable refusal when Reply is off. The native preview and its controls are outside this checkpoint.

## Framework generality

The feature uses existing signed device and machine proofs. No model or agent framework is required for signing or sending. Semantic Stop reuses the configured classifier through its existing interface.

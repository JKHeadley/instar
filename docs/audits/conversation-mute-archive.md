---
audit: conversation-mute-archive
standing-guard: tests/e2e/conversation-preferences-alive.test.ts
blind-spot-class: personal-state-transport-boundary-mismatch
standard-response-kind: no-change
standard-response-ref: docs/STANDARDS-REGISTRY.md
standard-response-article-id: iterative-audit-to-convergence
standard-response-article: Iterative Audit to Convergence
standard-response-rationale: Existing current-authorization, durable custody and repeated-review requirements already govern these seams; production-path regressions enforce them without another constitutional rule.
converged: "2026-11-23T00:26:37.432Z"
rounds: "8"
standard-response-digest: "5505039f748ca3861ec2d399966503a57b5080138e073a3d87b7f31683b37c47"
meta-artifact-at: "2026-11-23T00:26:37.432Z"
meta-artifact-digest: "25a7a0a6988afa432c8ba3886f634acbf38ba3e0c88da81c8d3a60428b4281c4"
---

# Conversation Mute And Archive Runtime Audit

Five independent reviewers covered security, integration, performance, adversarial behavior and completeness. Source reviews and focused checks do not substitute for normal complete verification or native/deployed proof.

## Meta-insight

How it arose: personal preferences cross asynchronous list, replication, device ownership and provider transport boundaries. A correct local fold does not prove that a captured reader is current, a represented message exists, a dedupe receipt includes every recipient, or every server uses the same cursor position.
Why prior controls missed it: isolated mocked notification predicates permitted unknown witnesses, fixed local list fixtures did not exercise actual upgraded peers, and synchronous emission tests did not model production asynchronous journal confirmation. Real initialization, two-router regressions and save-count assertions now exercise those boundaries. Existing standards already require these invariants; this audit improves enforcement.

## Round 1

Search angles: independent security, integration, performance, adversarial and completeness review of all changed storage, route, initialization, queue, provider and test paths.
Surface delta: per-reader preferences, archive filtering, typed notification sidecar, legacy quarantine and production wiring.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| src/server/conversationPreferenceIdentity.ts:29 | Internal Telegram offset accepted as physical wire topic | namespace-confusion | fixed:tests/unit/conversation-preference-identity.test.ts |
| src/core/MobilePush.ts:receive | Main dedupe could acknowledge before every recipient was durable | recipient-custody-gap | fixed:tests/unit/mobile-push-preferences.test.ts |
| src/core/MobilePush.ts:selection | Generic notice policy shadowed independent document authorization | policy-shadowing | fixed:tests/unit/mobile-push-preferences.test.ts |
| src/core/MobilePush.ts:selection | Reconstructed decision payload lost approve/decline value | payload-semantics-loss | fixed:tests/unit/mobile-push-preferences.test.ts |
| src/commands/server.ts:36891 | Failed real wiring silently constructed a writable local store | unavailable-became-local-success | fixed:src/commands/server.ts |
| src/core/ReplicatedStoreReconciler.ts:tick | Refused preference appends lacked a live maintenance retry | stranded-outbox | fixed:tests/unit/conversation-preferences-reconcile-retry.test.ts |
| src/core/ConversationPreferences.ts:latest | Hot preference reads scanned every stored field | multiplicative-hot-read | fixed:tests/unit/conversation-preferences.test.ts |
| src/core/MobilePush.ts:selection | Discards each rewrote/fsynced the complete sidecar | repeated-durable-snapshot | fixed:tests/unit/mobile-push-preferences.test.ts |
| src/server/AgentServer.ts:2656 | Legacy push predicate allowed missing/unreplicated message witness | unknown-witness-admission | fixed:tests/e2e/conversation-preferences-alive.test.ts |
| src/server/mobileConversationRoutes.ts:mergeConversationPages | Bare Telegram topic IDs collapsed distinct physical chats | identity-before-overlay | fixed:tests/integration/conversation-preferences.test.ts |
| src/server/mobileConversationRoutes.ts:list | Awaited peer fetch could mix old reader preferences with reassigned device | stale-reader-capture | fixed:tests/integration/conversation-preferences.test.ts |
| src/core/MobilePush.ts:selection | Diagnostics omitted required scrubbed admission evidence | reason-without-current-facts | fixed:tests/unit/mobile-push-preferences.test.ts |

New findings this round: 12

## Round 2

Search angles: recheck corrected source and actual production wiring; dynamic peer conversation arrival; production durable callback batching; upgraded-peer equal-time pagination.
Surface delta: strict witness proof, indexed preference reads, batched sidecar discards, fresh reader stamp and physical dedup keys.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| src/core/ConversationPreferencesWiring.ts:wirePreferenceStore | Synchronous batching missed production asynchronous confirmation writes | mock-production-shape-mismatch | fixed:tests/unit/conversation-preferences.test.ts |
| src/server/AgentServer.ts:canonicalReplyRef | Early conversation absence captured permanent null queue identity | uncertain-identity-stranding | fixed:tests/e2e/conversation-preferences-alive.test.ts |
| src/server/mobileConversationRoutes.ts:listCursorFor | Unknown peer namespace used different sort keys on producer and answerer | transport-order-mismatch | fixed:tests/integration/conversation-preferences.test.ts |
| src/server/conversationPreferenceView.ts:overlay | Peer could borrow another platform or App row's verified preference identity | cross-resource-overlay | fixed:tests/unit/conversation-archive-selection.test.ts |

New findings this round: 4

The production confirmation batch awaits existing bounded journal durability promises, then marks only successful current winners in one transaction. It introduces no timer and never marks rows emitted before durability. Strict send-time existence/ACL checks remain separate from syntactic App queue identity.

## Round 3

Search angles: shared verified Telegram group across actual Z/B server instances; unknown B/C holders with identical opaque hints and numeric-prefix topic IDs; compare dedup and transport ordering separately.
Surface delta: producer and answerer preserve existing bounded preferenceRef solely as an opaque ordering hint, without granting preference or ACL authority.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| src/server/mobileConversationRoutes.ts:listCursorFor | Holder-qualified cursors could repeat a verified physical duplicate on the next page | dedup-sort-disagreement | fixed:tests/integration/conversation-preferences.test.ts |

New findings this round: 1

Verified physical copies now share a terminated group position. Unknown identities retain holder-specific positions, and producer filtering understands that holder boundary. Actual HTTP tests cover unknown43 then42, verified shared43 once then42, and unknown C/B43,42,4 without starvation or collapse. Live inventory can move during pagination; this is not a frozen distributed snapshot.

## Round 4

Search angles: final full changed list/authorization recheck; independent source rechecks of security, integration, production performance and bounded diagnostics; current-reader, unknown witness and asynchronous journal semantics.
Surface delta: final canonical group cursor, cross-platform overlay guard, production durability batching and bounded admission evidence.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|

New findings this round: 0

The adversarial reviewer reported no new material findings after inspecting the final model. Security, integration, performance and completeness reviewers independently concurred on their corrected surfaces. Reviewers did not claim independent full-suite execution. The normal complete gate and actual Apple/deployment proof remain required.

## Round 5

Search angles: focused standards unit ratchets before commit, actual feature ladder lookup and every scanner-counted new catch against its existing response/admission/reporting outcome.
Surface delta: final feature code passed HTTP/lifecycle checks; standards checks additionally found a registry reference and missing explicit descriptions of already observable fail-closed outcomes.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| docs/specs/conversation-mute-archive.md:111 | Ladder declaration named the config flag rather than the actual registry ID | registry-reference-mismatch | fixed:docs/specs/conversation-mute-archive.md |
| src/core/MobilePush.ts:selection | Scanner lacked explicit justification for existing admission evidence, held delivery, injected failure reports and unavailable state; route/reservation catches likewise exposed503/unknown but lacked scanner-recognized rationale | observable-failure-explanation-missing | fixed:src/core/MobilePush.ts |
| src/core/MobilePush.ts:phoneStillCounts | An exception became affirmative inactive and discarded typed pending contributions | unknown-proof-became-revocation | fixed:tests/unit/mobile-push-preferences.test.ts |

New findings this round: 3

The independent annotation review found this real loss boundary; unknown proof must hold, while affirmative inactive proof may discard. Its fix and restart regression are required before convergence.

The annotation-only edits do not change runtime behavior; the unknown-phone-proof correction deliberately changes discard to hold. The exact scanner dropped from506 to493 and the ratchet is lowered to493 rather than raised or waived. The annotation correction receives independent security review before commit.

## Round 6

Search angles: independent full correction recheck of unknown phone standing, production person resolution, exception/nonboolean outcomes, versioned queue acknowledgement, restart/urgent-notice assertions, actual signed team-log availability and restoration, scanner explanations and side-effects wording.
Surface delta: unknown standing now holds with an explicit diagnostic reason; production unresolved person evidence signals unknown rather than cancellation. Only absent/inactive devices provide affirmative cancellation proof.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|

New findings this round: 0

Independent security review reported zero remaining material findings in source and correction artifacts. Provider restart tests cover reply and urgent notice retention, recovery, and affirmative cancellation. The production lifecycle uses the actual signed team-access log becoming unreadable and readable again, without replacing the ACL predicate. Review concurrence does not claim independent test execution or a complete gate pass.

## Round 7

Search angles: normal merge with current parent metadata, explicit represented readers, production canonical Slack lookup and independent integration tracing.
Surface delta: retain preferences and hierarchy together; require the resolved reader for owner metadata and exact workspace-qualified canonical parent identity.

| location | behavior | bucket | disposition |
| --- | --- | --- | --- |
| src/server/mobileConversationRoutes.ts:ownerMetadataOf | Newly combined explicit-reader reads needed one consistent role for personal preferences and owner hierarchy fields | cross-feature-reader-context | fixed:tests/integration/app-creation-hierarchy.test.ts |
| src/server/AgentServer.ts:creationHierarchySource.resolveRef | Workspace-free registry tuple lookup could rewrite a canonical Slack parent to a different readable local workspace | mistaken-parent-identity | fixed:tests/e2e/session-app-new-alive.test.ts |

New findings this round: 2

The Slack finding is source-reachable mistaken placement, not a demonstrated unauthorized-access incident. The fix requires returned canonical-key equality. Origin-checked machine-qualified aliases are unchanged. Tests use the real AgentServer dependency and registry with a synthetic transport; they do not certify a live Slack account.

## Round 8

Search angles: independent final merge/identity review; actual private Node24 ABI137 SQLite probe; all nine allocated whole files across unit, HTTP and production lifecycle; exact frozen index/source hashes.
Surface delta: corrected merged source unchanged during the allocated checks. Reviewer concurrence and actual execution agree on represented-reader refusal/reassignment, read-only preview, preserved preferences and exact canonical parent identity.

| location | behavior | bucket | disposition |
| --- | --- | --- | --- |

New findings this round: 0

The normal build passed. All78unit,25HTTP and4lifecycle tests passed with zero failures/skips; every selected whole file executed. Full stdout, ordinary enforcing admission and exact source/index hashes are retained in the private allocation receipts. These focused results are supporting evidence, not a complete Local Verify pass. The corrected pushed candidate must still pass the normal complete gate and later installation/native proof. No existing conversation was moved or deleted.

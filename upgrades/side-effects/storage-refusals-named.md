# Side-Effects Review — machine names in disk and storage errors

**Date:** 2026-11-07
**Author:** Echo
**Tier:** 1 — reversible diagnostic wording and read-only identity lookup; no schema or policy change.
**Second-pass reviewer:** review_storage_errors — concurred after 3 review rounds; each round closed concrete completeness gaps.

## Summary of the change

Feedback fb-30fc4ffb-e4a reported an anonymous storage refusal on a Mac Studio at 95% disk usage. Resolve the originating machine's nickname from its own identity and registry, with hostname fallback if enrollment has not happened or the failing filesystem also prevents reading identity. Never use the active lease holder's identity as a substitute. Explicit production dependency injection remains available for app media. The fallback now consults the registry too, including standalone AgentServer boot paths without mesh dependencies.

## Decision-point inventory

No admission, retry, cleanup, routing, notification-selectivity, threshold or scheduling decisions change. Existing conditions pass through with named diagnostic text. The helper's storage-pattern detection only selects diagnostic wording; it has no blocking authority.

## Error-path inventory

| Surface | Origin and delivery |
| --- | --- |
| App, Slack, Telegram and reply-file admission | AppMediaStore disk floor, media-store capacity and machine upload staging; error/status codes unchanged |
| Copy between machines | AppMediaReplicator canFetch / whyNotHere names the destination whose disk is full |
| App capacity Attention notices | AppConversationService names the local machine in titles and disk-floor body; id-based dedup keys unchanged |
| Media-store damaged files / failed cleanup | Shared store degradation callback names its own machine before reporting |
| Paste storage ceiling | PasteManager 507 message names the local registry nickname |
| Install disk preflight | install preflight refusal names the host, with nickname when already enrolled |
| Browser provisioning disk preflight | linuxBrowserProvision disk refusal names the local host |
| State-volume health | HealthChecker missing/unwritable state-directory errors name the configured machine |
| Existing health-check script | Disk-low, critical and unreadable-volume messages name the local machine; existing built-in script update path delivers the changed template |
| Notification-record write failure | NotificationSelectivityGate bounded failure escalation names its local machine |
| Swap ledger write failure | SwapAntiThrash uses the ledger's own state root for its disk-error notice |
| Undated-action ledger capacity | UndatedActionResurfacer names the local machine in its capacity notice |
| Threadline append failure | ThreadMessageRecorder names the machine in its bounded Attention summary |
| Feedback workspace disk budget | FeedbackExecutorService includes the executing machine in workspace-disk failure reasons |
| Shared storage degradations | DegradationReporter qualifies legacy and structured reasons before persistence or dispatch; covers semantic.db SQLITE_IOERR guidance, heartbeat write failures, queue enqueue-storage-failure, dropped-message persistence, credential ledger corruption, and other filesystem errors reported through this funnel |
| Direct raw OS/SQLite HTTP exceptions | Local caught exception expressions across server route files now use operatorError, which adds the source nickname only for filesystem/storage errors. Backup/restore, memory, job-cost, handoff, machine, worktree, supervision and ecosystem routes cannot bypass naming just by returning err.message. Forwarded peer bodies are not rewritten. An executable AST ratchet detects any future raw caught-exception JSON response. |
| Uncaught HTTP storage failures | errorHandler returns a named storage error while keeping internal paths and raw exception details private |
| Direct storage API refusals | Mobile conversation, Telegram/Slack send, shared media claim, pairing/device/assignment/confirmation/registration writes, recommended-service choices, notification classification/ack/preferences, file saves, team access, health choices, maturation evidence, Telegram delivery-record reads, event/grade receipt/config/override saves and acknowledgment records use storageErrorResponse at their local catch boundaries. Protocol codes stay stable; human details name the source. Peer acknowledgments preserve peer response bodies and name the known peer on an RPC failure. |
| Internal typed outcomes | storage-error/storage-failure codes remain stable; their operator notices flow through the reporter rather than changing protocol discriminants |

Repository search included disk/free-space/volume errors, storage ceilings, ENOSPC/EDQUOT/EIO and SQLite errors. Silent best-effort persistence paths that produce no operator error remain silent. Memory/RAM and provider usage quotas are separate resource types. The per-machine disk-watch job is excluded by the user's explicit instruction and remains separately tracked by the operator.

## 1. Over-block
No block/allow change. No legitimate input newly rejected.

## 2. Under-block
No block/allow change. Existing storage admission and recovery conditions remain intact. If registry reads fail, the host name identifies the machine rather than claiming an unknown nickname.

## 3. Level-of-abstraction fit
Name errors at their origin. The shared reporter covers its many emitters. Capacity checks compose their own names because their refusal details are rendered directly by clients. No transport layer rewrites forwarded errors with the receiving host's identity.

## 4. Signal vs authority compliance
Complies with docs/signal-vs-authority.md. The new recognition helper produces only message wording, never block/allow authority.

## 4b. Judgment-point check
No new judgment. Names are factual identity data.

## 5. Interactions
Preserves HTTP statuses, media error codes, deduplication keys, notification budgets, queue reason discriminants and all storage thresholds. The legacy media test's new disk injection prevents actual host disk pressure from hiding the store-capacity branch. Registry nicknames are read on demand so renaming is reflected immediately.

## 6. External surfaces
Operator-facing text changes across the inventory above. Error-handler responses continue to conceal raw exception paths. The feedback workspace-disk reason retains its stable prefix and adds the machine name. No state migration.

## 6b. Operator-surface quality
Short concrete machine names replace anonymous references and raw ids. No dashboard layout changes.

## 7. Multi-machine posture
Machine-local by design: disk and storage ownership belong to the host performing the write. Name before forwarding/persistence, preserve incoming names, keep notice keys as machine ids. Existing one-voice/dedup behavior unchanged. No cross-machine replicated state or new machine watcher.

## 8. Rollback cost
Revert this patch. No migration, state repair or data deletion required.

## Class closure
Diagnostic identity loss is covered by executable tests at tests/unit/storage-machine-name.test.ts and the real paired-phone refusal in tests/e2e/mobile-native-media-alive.test.ts. No self-triggered actions are added or changed; all existing actions and timers retain their limits. The tests assert source nickname, live rename, damaged-registry fallback, capacity branches and HTTP non-disclosure.

## Self-action declaration
`defectClass: unbounded-self-action`, `closure: n/a`. This change only formats diagnostics; it introduces no autonomous action, timer, retry, kill, or loop transition. Existing decisions and execution limits remain unchanged.

## Validation
Targeted unit suites passed: initial 231 tests; helper/media/reporter/threadline/browser 141; direct route/pairing/notification/installer 238; final helper/AST/server 37. Expanded HTTP integration: 23 tests passed. The original paired-phone production AgentServer lifecycle: 8 tests passed. Build completed, and all 52 lint steps passed. Full test:all was run; this restricted session cannot pass tests that write outside the allowed workspace/temp roots or inspect real processes. A separate reproduction of ThreadResumeMap confirmed EPERM creating ~/.claude/projects/threadline-test-project; app-media-reply-files also failed creating a fixture directly under the real home. Full-run results are recorded in the PR. No failing test was disabled or assertion weakened.

## Review concurrence
review_storage_errors: “Concur with the review after round 3. The concrete gaps identified in all three passes are closed, including direct persistence responses, returned response objects, and raw OS/SQLite exceptions. Names resolve from the failing machine's state directory; peer responses retain their origin. Thresholds, statuses, protocol codes and blocking decisions remain unchanged.”

## Commit-gate contract acknowledgment
The migration-completeness gate treats any change to recordThreadMessage.ts as a producer-surface revision. Its manifest and every declared producer, consumer and validator now acknowledge threadline-inbound-canonical-store@2 in lockstep. These are comment/manifest acknowledgments only; no persisted history format or runtime migration changes. The first commit attempt was refused by MCC6, so the acknowledgments were completed rather than bypassing the gate.

## Certified dependency partition
The push gate found storageMachineName.ts and channelIdentity.ts newly reachable through existing diagnostic producers. Both are explicitly excluded with reasons: read-only local nickname/display-name formatting has no Stage-B dispatch, receipt, admission or recovery authority. The certified code set, its member hashes and its signed canary evidence remain unchanged; the manifest writer and check validate that fact. No canary evidence was restamped onto changed certified code.

Partition review: review_storage_errors concurred with both diagnostic-only exclusions, verifying unchanged roots, seven certified members, hashes, fingerprint and signed evidence digest. The dedicated code-binding suite passed all 20 tests; the manifest check passes. Existing exclusion ordering is preserved to keep review small.

Final errno coverage: local error formatting recognizes the SQLite error-code family (including locked, read-only and invalid database errors), ordinary missing/wrong-directory file errors and open-file exhaustion, alongside full-disk and I/O failures. Recognition only chooses diagnostic words. Provider-usage quotas remain unrelated. Targeted cases bind these branches to named messages.

Final coverage review: review_storage_errors concurred that SQLite/errno/syscall recognition only changes diagnostic coverage and preserves unrelated process errors. The updated helper/AST suites passed 26 tests. Path-scoped Threadline E2E passed 431 tests but two files failed from sandbox limits: a token fixture outside writable roots and denied real process inspection for the lifeline. The repository's documented local E2E opt-out is used for push only; required CI E2E remains a mandatory merge check.

## Continuation review and main reconciliation (2026-11-08)

Fresh source clone at /private/tmp/instar-storage-2946, fresh worktree /private/tmp/instar-storage-2946-work off origin/main 1f90ccd33 (JKHeadley/instar, version 1.3.1719), agent identity Echo. Main and this PR independently added the same deterministic media-disk fixture; preserve main documentation and the PR nickname assertion. Source route completeness now recognizes operatorError as central unknown-error narrowing, and explicitly verifies that narrowing. Keyword-intent ratchet recognizes storageMachineName as an error-signature cosmetic survivor; baseline stays unchanged. README explains named failures and backup recovery; this also clears the existing command-documentation coverage failure without lowering its floor. No extra runtime decision, state or authority surface.

Independent review_storage_repair: Concur with the review; no blocking issue found. Original 507 production path names Mac Studio, local registry resolves the failing host, merge fixture is deterministic, typed error handling remains checked and ratchet baseline is unchanged.

Continuation validation: 76 targeted unit assertions passed initially; the AST storage ratchet caught main's newly added pool bring-back catch. Qualify that local transport exception through operatorError (forwarded peer bodies stay untouched), then both route/AST suites passed all 11 assertions. HTTP storage integration passed; all 8 production-path media E2E tests passed; all 52 lint checks passed; documentation coverage passes after the README recovery guidance.

## Queue-wait main reconciliation (2026-11-08 07:27 UTC)

All 27 GitHub checks passed on 537842514 before current main added a top-of-file routes.ts import. A fresh worktree at /private/tmp/instar-storage-2946-refresh off current origin/main (JKHeadley/instar, version 1.3.1719, Echo identity) reconciles that import-only conflict: retain topicGoalContext and the storage formatting imports. No runtime decision or storage behavior changes in this reconciliation. The rollback remains a revert. Re-run source-ratchet/storage unit, HTTP integration and production-path media tests, lint and build before refreshing the PR.

Refresh review_storage_repair: Concur with the refresh reconciliation. Main topicGoalContext and both storage imports are preserved; storage identity helpers, media refusal behavior and regression tests are unchanged from previously green head 537842514. No conflict markers, whitespace errors or concrete blockers. Current main base: 34f219f45c1b26ea72d93bda66139cb74290f3ba. Build, all 52 lint steps, Docs Coverage, HTTP storage integration and 8 production-path media E2E tests passed on the refresh.

Refresh targeted unit run: all 77 storage/helper/media/route/keyword assertions passed. The first unit runner did not start; it was interrupted and a normal direct retry completed green in 6.25 seconds. No assertion or test was disabled.

## Final Local Verify repair (2026-11-08)

Tier 1 / SMALL continuation: two runtime route modules and two existing HTTP test modules, plus this artifact and ELI16/release evidence. Fresh worktree /private/tmp/instar-disk-2946-finish off origin/main a53bf5b99 (JKHeadley/instar, 1.3.1719, Instar Agent (echo)); existing PR head 527f96ac2 merged without conflict. One independent review pass is required. Local Verify caught raw exceptions in main's new skill-learning forwarding handlers; the fresh-main AST reproduction also caught the newly merged recovery owner-link handler. The existing ratchet is unchanged. Five HTTP regression cases fail before the repair.

Decision points: existing PIN checks, holder selection, error codes, HTTP statuses, commissioning and recovery authority are passed through unchanged. The only new branch chooses diagnostic words when the shared storage-failure detector observes a storage exception.

1. Over-block: no new block/allow surface; no legitimate request is newly rejected.
2. Under-block: no new admission surface. Both skill forwarding catches and all three recovery setup actions now cover storage failures; the unchanged whole-server AST ratchet checks direct exception responses.
3. Layer fit: reuse operatorError for local forwarding exceptions. Recovery uses the same storage detector and storageErrorResponse over its existing sanitized body, retaining its strict recovery-code allowlist and never exposing private exception text.
4. Signal vs authority: storage classification only chooses error wording. Per docs/signal-vs-authority.md, it adds no blocking authority and changes no authorization decision.
5. Interactions: successful peer response bodies are passed through byte-for-field as before; local network errors retain their original text. Recovery non-storage errors retain their previous payload and status.
6. External surfaces: actual storage failures gain the failing machine's nickname. Recovery may add a sanitized detail identifying the machine; raw paths, keys and credential exceptions stay private. No config or state format changes, so no migration is needed.
7. Multi-machine posture: machine-local diagnostics read the failing server's state directory. Forwarded holder response bodies keep the holder's origin; nothing adopts the receiving machine's name.
8. Rollback: revert this diagnostic continuation; no data, configuration or authority repair is required.

Validation and independent review results are recorded below before commit. The earlier peer retention file passed all 25 tests alone, and the loaded-run lifecycle E2E file passed alone; no failing assertion was removed or weakened. The merge-helper large-response buffer defect is separately queued as feedback fb-1f5a0506-4ec; an invocation-only larger read buffer preserves all merge checks.

Final continuation validation: all 44 targeted unit assertions (storage helper, whole-server AST ratchet, skill pending routes, route completeness and keyword-intent ratchet), all 23 HTTP integration cases and all 23 production-path media/skill-learning E2E cases passed. Build, all 52 lint steps, Docs Coverage and the Stage-B certified fingerprint check pass. The new HTTP cases failed before the code change. Full Local Verify remains the merge gate for the refreshed head.

Independent review_storage_completion: Concur with the review; no blocking issue found. PIN checks, holder routing, HTTP statuses and recovery error-code allowlisting are preserved. Storage classification only changes diagnostics. Recovery keeps raw paths and credential exceptions private; peer responses retain their original machine identity. The five HTTP cases cover both forwarding handlers and all three recovery actions, including non-storage errors and peer-origin preservation. AgentServer supplies the state directory used for local naming. git diff --check passes.

## Proactive main merge coverage (2026-11-08)

While the refreshed fix queued, main merged team requests (#2923). In a fresh worktree /private/tmp/instar-disk-2946-team-finish off origin/main a11a65659 (JKHeadley/instar, 1.3.1719, Echo identity), merge bc46f1054 without conflict. The newly sanitized team-action catch also needs a local machine name when the underlying failure is storage. Keep its generic words and error code, and use the existing diagnostic detector/formatter only for actual storage failures. Real signed-phone HTTP cases reproduce the missing name for ENOSPC and ENOENT; an ordinary private failure keeps its prior body exactly and leaks no exception text.

Strengthen the existing source ratchet to include assigned HTTP response-body objects as well as direct JSON/return expressions. This catches one older anonymous app-session-creation exception that was assembled before sending; route it through the already-imported operatorError. Logs alone remain outside the HTTP ratchet. No test assertion is weakened.

Tier1/SMALL, two runtime modules, one HTTP test module and the existing AST test. This is diagnostic coverage, with no changed authorization, signature/presence proof, HTTP status, error code or persisted format. Over-block: none, no new action rejection. Under-block: assignments now receive the same raw-exception check as direct responses. Layer/signal authority: existing diagnostic helpers choose words only. Interactions: generic/private errors and all main team-request behavior stay intact. External surface: local storage failures identify their computer without leaking private paths. Multi-machine posture: use the failing handler's own configured state directory, never a peer's identity. Rollback: revert this continuation; no state or authority repair.

Proactive continuation validation:44 targeted unit tests,98 HTTP integration tests and9 production-path media/team E2E tests pass. Build,all52 lint steps,Stage-B certified fingerprint and Docs Coverage --check pass. Main's new TeamRequests class had dropped class documentation coverage below the unchanged55% floor; README now explains its owner-request storage and signed approval boundary,restoring coverage without lowering the floor. The two storage-specific signed-phone assertions fail before the repair; ordinary private failures preserve their exact body.

Independent review_storage_completion (second continuation):Concur with the review; no blocking issue found. Team storage failures retain sanitized error codes,status and private exception handling while gaining the local name. Signed request proofs and authorization remain intact. The app-create formatter leaves settlement/retry behavior unchanged. The stronger AST check distinguishes raw exceptions,qualified responses and logs; no check was weakened. git diff --check passes.

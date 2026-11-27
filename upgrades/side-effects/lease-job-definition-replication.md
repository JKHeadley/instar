# Side-Effects Review — private job definition transfer

**Date:** 2026-11-05  
**Author:** echo

## Summary

The feature is dark by default. A source exports only an explicitly portable user job, its matching body, and declared project dependencies after PIN approval for the exact content root. The registered recipient verifies a signed, nonce-bound, key-epoch-bound encrypted answer, quarantines it, and requires its own PIN approval before activation. Git-sync and token-bearing configuration remain outside the transfer.

## 1. Over-block

A portable script or skill must declare its executable path, and any secret-like dependency name, symlink, special file, directory over the depth cap, or bundle over size limits is refused. Python 3 is required for descriptor-relative file operations; its absence causes a visible transfer gap. This may require an operator to narrow the declared dependency set.

## 2. Under-block

The source cannot identify a secret stored under an innocuous approved path, so the export preview lists each file and hash and requires an exact-root PIN approval. A local process with the same user permissions can race an imported file update; the helper checks the prior hash and protects each path component against symlinks, but no portable filesystem compare-and-swap exists for a concurrently replacing local leaf. Admission rehashes every imported file before launch; local writers remain trusted with project write access. Cross-machine exactly-once execution remains governed by the lease and promotion catch-up policy.

## 3. Level-of-abstraction fit

The coverage monitor supplies signed catalog evidence and durable gaps. The source projects and encrypts bytes; the recipient controls installation; the scheduler owns run admission. Peer data cannot directly launch a job. The private file helper is the containment boundary for project paths.

## 4. Signal vs authority compliance

A coverage observation and bundle are signals about what another machine has. Only local exact-root approval, an active import journal, an unchanged file set, and the live scheduler lease admit execution. Transfer failure or uncertainty creates an alert; it does not grant peer authority.

## 5. Interactions

The source handles at most one bounded descriptor-relative dependency collection per bundle request. A durable cursor rotates through advertised portable jobs. Transfer status is indexed so the five-minute coverage check does not scan inbox bundles. Import pauses scheduler admission, writes a pending journal and latch before file changes, installs the manifest last, commits an active journal, and refreshes before resuming. The loader withholds pending, revoked, disarmed, or changed imported manifests. Before a trigger, the scheduler verifies every imported file hash.

## 6. External surfaces

The authenticated peer route returns only recipient-encrypted bundles. Operator preview routes show file paths and hashes to the local operator; PIN-gated routes approve, revoke, roll back, and re-arm. Public pool status and alerts show slugs and gap reasons, not file bodies, token values, or raw dependency paths.

## 7. Multi-machine posture

Standby machines can stage private copies before lease promotion. Source updates change the content root and require renewed source and recipient approval. The recipient will not overwrite a separate local job or a locally changed imported file. Offline or old peers leave coverage uncertain and alert the current holder.

## 8. Rollback cost

The live PIN-gated rollback route persists a disarm latch, pauses scheduler admission, and quarantines journal-proven manifests. The packaged emergency script requires the agent to be stopped, checks the startup marker, and moves only hash-matching imported manifests. It leaves dependency bytes for inspection; the prior Instar version can then be restored without running the imported definitions. Re-arming requires a PIN and no pending apply latch.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: guard`, `enforcementType: ratchet`, `citation: tests/unit/self-action-convergence.test.ts`. The registered portable transfer controller models a five-minute non-overlapping batch with a durable cursor and rate floor. The focused tests cover source projection, secret-like path refusal, no-follow parent handling, signed recipient-bound transport, exact-root approvals, quarantine, conflict preservation, full-size updates, interrupted apply withholding, and changed-dependency admission refusal.

## Second-pass review

**Reviewer:** /root/review_transfer_resume

Current concurrence covers the incremental repairs and this artifact: bounded process scanning, reporting annotations, migration and bootstrap compatibility, and the transfer counter/fixture repairs reviewed during this session. It is not a fresh complete security audit.

Prior recorded review history: Concur with the review. Independent code and integration reviewers found no remaining peer-trust or crash-recovery merge blocker after the final pass. The same-user concurrent leaf replacement race is recorded under Under-block as a local concurrency limitation. Final focused and lint gates remain required before merge.

## Full-suite ratchet repair (2026-11-05)

The first peer full-suite run found two inventory failures. Source export approval and bundle nonce accounting now carry a machine-local write-domain story, with `.instar/state/job-portable-*` excluded from git-sync so one root's consent and staged bytes cannot appear on another. Recipient import approval, revoke, rollback, and rearm are cluster-shared because they can change runnable manifests. The new dependency and integrity fallback comments describe refusal on missing or unreadable inputs; the absent import journal still means an ordinary local job. The write-domain, file-classifier, and silent-fallback tests are queued for fresh verification; the earlier failed run remains recorded. A future live write-admission rollout must preserve standby staging before promotion; that admission mode is currently structurally dark. Independent review concurred with this narrow repair and noted the same future admission consideration.

## Resumed narrow second-pass review (2026-11-05)

Concur with the narrow repair. An independent reviewer checked actual route templates against registry prefixes, verified exclusions cover flat consent/journal files and nested inbox contents, and confirmed annotations preserve fail-closed behavior. No code or security blocker found. Completed current test evidence remains required before merge.

## HTTP, lifecycle, and counter boundary completion (2026-11-05)

Added real HTTP authorization tests for the dark default, auth middleware, exact-root source approval, missing PIN, unsigned peer refusal and preview-only import mode. The AgentServer lifecycle test verifies a live source returns approved bytes with recipient encryption and source signature, rejects the wrong decryption key, and refuses a replayed request. Real identity/coordinator dependencies replace no-op wiring. Coverage route and startup tests are inherited from the coverage branch.

Inspection found the portable receiver accepted decimal-only catalog counters while the canonical producer encodes them in hexadecimal. The receiver now accepts the same lowercase 12-digit hexadecimal counter format, including the 9-to-a boundary; malformed counters and unregistered sources remain refused. This is an over-block repair, not an expansion of peer authority. Full suite and independent second-pass remain gates.

The added roundtrip lifecycle boots real source and destination HTTP listeners. The destination production monitor pulls source coverage and recipient-encrypted bytes at a hex-letter catalog generation, stages outside scheduling, then installs only after a destination PIN approval. A modified imported body fails real run-integrity verification. The polling assertion is bounded to 20 seconds and all listeners and monitor timers are stopped on cleanup.

Second-pass concurrence: the independent reviewer verified the counter producer format, actual auth middleware, real key registration, live monitor construction, encrypted delivery and destination PIN path. No remaining code-review blocker; this does not claim test success.

## Runnable lifecycle fixture correction (2026-11-05)

The real roundtrip test refused to stage because its source fixture body omitted required agentmd YAML frontmatter. A diagnostic through the real production catalog loader returned complete:false/jobs:[] and the missing-frontmatter problem; adding valid name/description frontmatter returned complete:true with the portable entry. The fixture now verifies real loader admission at construction, and the lifecycle test asserts a complete signed portable advertisement and hex-letter generation before waiting on transfer. No runtime behavior or admission gate changed. The encrypted source export/replay test had passed; the corrected end-to-end case still requires a fresh execution result.

## Agent awareness and migration parity completion (2026-11-05)

The same shared guide machinery now delivers private-transfer instructions to fresh, full, reference-layout, AGENTS and GEMINI agents: dark/preview defaults, exact-root local operator approvals, real preview/approval/revoke/rollback APIs, explicit portability/dependencies, registry and proactive use. The guide forbids collecting a PIN in chat, approving on the operator behalf, or bypassing with git-sync/config copies. A bearer or signed peer bundle is not activation authority. Actual template and migration tests cover both coverage and transfer guidance with custom notes preserved. Independent review concurred; focused and final full verification remain merge gates.

Focused combined coverage/transfer awareness verification passed: 39 real template/migration/reference-layout tests, zero failures. TypeScript noEmit passed. The actual transfer HTTP3, encrypted source and real roundtrip E2E2, and compatibility integration57 had already passed; final full suite still required after this awareness source completion.

## Merge-time reporting-ratchet repair

Combining current main with transfer produced 495 catch-window matches against the unchanged 494 ratchet. Exact heuristic comparison isolated the transfer callback catch: it already emits error feature evidence and a warning; it does not admit a failed candidate. The added explicit annotation documents that reporting and fail-closed posture. No runtime statement, approval gate, replicated state, user surface or baseline changed. No new over-block or under-block issue identified; signed metadata remains useful even when its private transfer fails. The annotation is at the existing reporting handler, not a parallel authority. Rollback is deletion of a comment. Independent review concurred. Focused no-silent-fallback, real coverage and portable-import tests passed 28/28. The preserved combined-head full run exposed this test failure; fresh exact-head verification remains required.

## Host process-scan compatibility repair found by the final suite

The final full run exposed a deterministic diagnosis-restart failure. A direct real ps measurement returned ERR_CHILD_PROCESS_STDIO_MAXBUFFER at 1,038,731 output bytes in 93ms. The default 1 MiB allowance made an otherwise readable table unknown. The existing recovery scan now allows at most 8 MiB and keeps its two-second timeout. Output errors, overflows, ambiguous identities and live unknown children still prevent cleanup and new admission. This fixes the failure at the process-discovery layer without changing its authority or matching rules. No new under-block issue identified; legitimate tables over 8 MiB remain intentionally unknown rather than consuming unbounded memory. On each machine this scan is machine-local by design because process IDs belong to that host. There is no copied credential or replicated-state change. Rollback is a code revert; no data migration is needed.

Real child-executed ps fixtures cover a listing over 1 MiB and an overflow over 8 MiB. The overflow must preserve the durable intent and input file and refuse a distinct new attempt as busy. Independent review concurred and requested those explicit no-cleanup/no-new-admission assertions; they are included. Build passed. The new focused tests are pending normal host capacity, not claimed as passed. The earlier real-host existing lifecycle test failed in both the full suite and an isolated rerun before this repair; both logs remain preserved. A separate standards CLI/library mismatch passed all 38 tests on untouched rerun, with its cause still unknown. Final full-suite and exact-head verification remain required.

## Current verification evidence — 2026-11-05

The combined runtime source at 4009a9d28cbcf15086d1021d79513111f0f9e427 passed the full unit lane (58,591 tests) and full integration lane (5,841 tests), with zero failures. The two real subprocess buffer boundaries passed. Earlier pending-test paragraphs are chronological history. Full E2E and required exact-head verification remain pending. Naming the reviewer and refreshing the artifact-bound trace changes no runtime source or tests and replaces neither gate.

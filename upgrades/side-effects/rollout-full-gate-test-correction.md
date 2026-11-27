# Side-Effects Review — Correct the Release Repair's Full-Gate Tests

**Version / slug:** rollout-full-gate-test-correction
**Date:** 2026-11-23 UTC
**Author:** echo
**Second-pass reviewer:** /root/n78_security_r1

## Summary of the change

Only tests/unit/featureRolloutScan.test.ts and tests/unit/console-chats-page.test.ts change. The scanner wiring contract now requires the asynchronous adapter and rejects the synchronous call. The console fixture uses the pinned owner's observed-read wait correction, preserving every existing hash, reconstruction, full-pool and boot-generation assertion. No production source changes.

## Decision-point inventory

- Scanner wiring assertion — modify a test contract to require the already approved async production dependency; construction and invocation checks remain.
- Console fixture readiness — modify a test observation wait; actual reads and reconstructed content remain required, not inferred from elapsed time.
- Product admission, permissions, scanning and lease decisions — unchanged.

## 1. Over-block

No product block/allow surface. Tests retain finite deadlines. A genuinely missing quick read or incorrect reconstructed row still fails; the test no longer mistakes slow asynchronous signing/database completion for absent behavior after a fixed short sleep.

## 2. Under-block

No semantic assertion is removed. The first and second known-row hashes, absence of an after cursor, full pool reads, complete cached rows, broadcast payload and reopened reconstruction all remain checked. The scanner test additionally rejects the old synchronous injection. One focused pass cannot certify the complete new revision; normal full verification remains mandatory.

## 3. Level-of-abstraction fit

The failures are in a stale wiring expectation and missing fixture lifecycle cleanup. Changing the real server back to a synchronous adapter would defeat the repair. Waiting for actual observed asynchronous results is the fixture-level correction; no production retry, rate or concurrency tuning is introduced.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. No new product authority or brittle permission check. These tests observe existing behavior and protect the approved production wiring. Source and live configuration remain unchanged.

## 4b. Judgment-point check

The console wait is copied exactly from PR3655 head9a2baf9bff0a2ac6866642bb82ccc2c900b96ac1, blob7504b7f0c1f39abaee542b4814c2b119273bed1a. It observes the same real conditions within that owner's bounded fixture deadlines; it does not alter host semaphore settings, worker counts, production backoff or permission floors.

## 5. Interactions

Boot-generation fencing remains around focus events, preventing old pages from feeding later tests. The scanner's registered async dependency and cancellation forwarding are covered by existing lifecycle tests; this correction repairs an older static assertion missed by the first targeted file list. The retained complete-run lifecycle error passed its normal isolation rerun by the same test name, with terminal4390passed/zero failures per Throughputad64abaa; integration stopped early and is not a pass.

## 6. External surfaces

No new or changed external product surface. The draft PR description and verification evidence will be updated only after actual corrected execution. The live canonicalRefScan=false stopgap stays with its operational owner.

## 6b. Operator-surface quality

No operator surface — not applicable. No new UI, approval flow, notification, button or user-facing identifier.

## 7. Multi-machine posture

**machine-local** test execution, with results attached to the exact corrected source revision. No replicated data, machine role, lease state, credentials or custody changes. A loaded M5 worker supplied the retained failure; local focused success will not be represented as a full M5 pass.

## 8. Rollback cost

Revert the test-only correction through the normal Git path. This restores the stale wiring assertion and timing assumptions; it does not change server behavior. There is no state migration or production restart to undo.

## Conclusion

Ready for independent review and one exact allocated two-file unit run. No corrected test pass, new head, merge or deployment is claimed yet. The failed head remains held until complete normal verification of the corrected head passes.

## Second-pass review

**Reviewer:** /root/n78_security_r1
**Independent read of the artifact:** Concur. The async wiring assertion rejects the old synchronous call; the pinned console correction preserves all semantic assertions and boot-generation fencing. No edits or tests were performed by the reviewer.

## Evidence pointers

- Retained full failure: .instar/recovery/retention1961/pr3657-full-failures.json.
- Failed headca87bb32665f69d68b76ae64606cda7fe39b944e/base4f716c4be330bce7198d5220dcce70e86e9bb8ec:74212unit passed/two failed;4390lifecycle passed/zero terminal failures; integration stopped early.
- Pinned owner correction and diagnosis: worktree .instar/n79-verification/full-gate-correction/.
- Existing authorized design: docs/specs/boot-independent-rollout-scan.md and its explicit operator-bounded review history. This correction introduces no production design change or new convergence round.

## Class-Closure Declaration

The correction itself is a one-shot test/fixture edit. It introduces no self-triggered action or loop. The production reconciler's committed class-closure guard remains unchanged; the new trace will explicitly declare the test-only scope rather than invent a production control.

## First Correction Result and Diagnostic-Only Amendment

The exact allocated two-file run at manifest45fe0437 stopped with43passed/1failed: all15scanner tests passed, while the console's observed quick-read condition remained zero after ten seconds. This does not establish a timing-only cause. No wait, concurrency, policy or production setting is increased. A diagnostic-only catch now records synthetic page text, URL paths/methods, visibility/focus, and a read-only native Web Locks snapshot on that same failure, then rethrows it. It excludes headers, keys and request bodies. The owner correction remains the pinned baseline; the diagnostic wrapper is a separately disclosed byte amendment. No further test or waiter has started.

Independent diagnostic-only review concurred: the new catch preserves condition/deadline, reads lock state without changing it, excludes credentials and rethrows. No cause, correction or passing result was inferred from the static lock hypothesis.

The diagnostic also delegates the real exported renderChats call unchanged and retains its actual page object for read-only lifecycle snapshots: generation, live/leader flags, pending lock, release callback presence, connected element and open-view presence. It observes all prior boots in the same file so a retained owner is visible. It does not dispose a page, release a lock or substitute a lock implementation. The parity owner's Node22/no-native-locks versus this candidate's Node24 difference is a comparison clue; only the allocated runtime snapshot can confirm ownership.

The refined real-page observer received independent concurrence: it delegates unchanged and returns the same page, captures only booleans/identifiers, and changes neither disposal nor locks. No diagnostic execution or cause confirmation is claimed.

## Captured Cause and Lifecycle Correction

The allocated Node 24 diagnostic finished with 28 passes and one failure. Native Web Locks showed one held polling lock and six pending requests. An earlier disconnected page remained live and leader with its release callback, while the current connected page was a follower and made only pool reads. The fixture closed windows without running the router lifecycle. The correction delegates the real createLifecycle factory unchanged, retains its returned lifecycle, and calls its actual dispose method before closing a window, both between boots and after each test. Registered page cleanup releases or aborts native polling locks. Native navigator and lock behavior are unchanged. Diagnostic-only observers and failure logging are removed from the candidate; their full failed evidence remains privately retained. Existing assertions, observed-read conditions and deadlines are unchanged. This correction is prepared, not yet tested; a new exact allocation is required. The parity owner will adopt these same reviewed and tested bytes rather than create a competing fix.

Independent lifecycle-correction review: /root/n78_security_r1 concurred. The real factory is delegated unchanged; registered disposal runs before replacement or closure, including repeated boots and afterEach. Actual ChatsPage.dispose aborts work and releases leadership. Diagnostic observers are removed; assertions and deadlines remain intact. The reviewer performed no edits or tests. Exact allocated verification is still required.

## Actual Corrected Target Result

Manifest cc61e84d74938a36cadb47fb395e9084c1afadcad48e4a3d2c6220e6853337d4 passed the one allocated whole console file: 29 tests passed, zero failed, exit 0 at 2026-11-23T00:58:40.555871Z. Actual admission PID 41470, cap 6, private Node 24.14.1 ABI 137, real SQLite probe, normal HOME and enforcement 1. Tested console blob 473d0d1ed9c91a249c01cea530f84130927426f5 remains unchanged. Scanner correction has its separate 15-test pass from the earlier stopped two-file run; this does not turn that earlier 43-pass/one-failure run green. All prior failures are retained. The final document-only evidence update does not change tested source or test bytes. Complete normal verification of the pushed corrected head remains required. Main-health controls, draft status and the live scanner stopgap remain intact.

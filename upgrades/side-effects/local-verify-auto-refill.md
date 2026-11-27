# Automatic Verification Waiting Admission — Current Shipment Review

## Summary and Scope
This is a new review of the automatic waiting-list refill candidate and its latest release-note correction, based on merged main 65ea34c80ad303c935bd6eb1addce0942506a872. It does not replace, edit or re-date the earlier local-verify-automatic-waiting-refill artifact. The runtime change re-offers requests that the coordinator already saved when its queue was full. The later documentation correction removes an inherited internal-only marker and explains sign-in test isolation accurately. The one add/add note conflict from the main squash was resolved by keeping that corrected text. None of those documentation or merge steps changed the five tested runtime/test blobs.

Tier 1: reversible queue-service repair. Its runtime delta is confined to LocalVerifyService and its route refusal mapping. It adds no state-file schema, machine execution capacity, test verdict or merge authority. Reverting the new driver restores external re-offer behavior while the waiting file remains readable. The source and three-tier tests are the previously reviewed and tested bytes; this new artifact binds a fresh review to the current shipment rather than claiming a new source verification.

## Over-Block
A saved request can fail a current GitHub read. Retrying only the first five requests indefinitely would strand readable work behind them. The driver gives unreadable or invalid-SHA requests a two-minute in-memory backoff, retains their first refusal time and ignores only those temporary reservations for automatic offers. When their backoff expires, their original age restores priority. Existing ordinary caller admission rules are unchanged. A stale saved request still requires a fresh owner or watcher offer, so the existing thirty-minute freshness and six-hour healthy-idle expiry remain limitations, not newly guaranteed indefinite custody.

## Under-Block
Automatic admission is not readiness or merge approval. A trusted-author check alone cannot establish draft readiness, parent order, owner consent or an adequate test verdict. Existing explicit holds, operator controls, full-suite inventory and merge checks continue to own those decisions. The driver never removes a safety hold or manufactures a test result. A full queue response remains HTTP 429 for compatibility; its durable waiting entry is distinguishable from an admitted queue entry. This does not solve every queue-capacity limit or make the failed affected-test selection trial useful.

## Level of Abstraction
LocalVerifyService already owns the waiting file, admission path and coordinator tick. Re-offering there avoids a second scheduler, a direct queue-file editor or a polling agent with independent policy. Pending operator fronts and releases run first. The new driver fills ordinary free queue places only; it cannot claim operator overflow. The public HTTP parser still accepts only a pull-request number, so the internal waitingRefill object and its reservation identity cannot be supplied by an HTTP caller.

## Signal Versus Authority
Reference: docs/signal-vs-authority.md. The automatic driver sends ordinary admission requests and records bounded waiting-auto-offer audit signals; it is not a green-verdict authority. The existing request path still evaluates trusted author, current head and base, existing records, waiting priority and holds. After asynchronous reads, an automatic request rechecks stopped state, operator hold, identity and freshness of the exact original waiting object, main health and serving-lease ownership before any post-read run cancellation, queue replacement or index mutation. No await follows those checks before synchronous capacity evaluation and insertion. The full-suite record and existing merge gates remain the only route to merge clearance.

## Interactions and Bounds
Overlapping ticks share a single in-memory refill guard. A pass considers at most five live requests, with at least thirty seconds between passes; temporary read failures get the bounded backoff described above. The in-memory backoff map is pruned against the bounded durable waiting list. A held request removed during a GitHub read cannot resurrect because the final guard requires the same live waiting object. Ownership loss or shutdown during a read produces no automatic admission. Operator actions retain precedence, and test execution capacity remains separately enforced by the existing suite admission mechanism. An accepted waiting offer may still spend time queued; this is not a promise of immediate execution or a measured throughput improvement.

## External Surfaces and Privacy
No new endpoint, user setting, stored user content, credential or external side effect is added. Existing GET status continues to distinguish waiting and admitted requests. New audit records identify the request and result; the driver does not add message content. The latest inherited sign-in release note now contains accurate user and capability sections and no internal-only marker. Sign-in and recovery behavior is unchanged by that prose correction. Open-PR overlap is still unknown because the normal hook lookup timed out; a clean calculation against main does not certify compatibility with every open candidate.

## Multi-Machine Posture
Machine-local by design, following the existing queue and waiting-file ownership. Only a healthy serving-lease coordinator re-offers waiters. A peer-only service, a stopped service or a machine that loses the lease cannot admit through this driver. The exact waiting-object and lease rechecks handle changes during network reads. This review makes no new replication or lease-transfer recovery promise. Existing peer dispatch, source binding and full verification rules remain in force.

## Evidence and Its Limits
The sole normal-enforcing focused sequence passed 23 unit checks, nine real-router HTTP integration checks and eight production-wiring lifecycle checks, with zero failures or skips and all three process exits zero. Logs show actual INSTAR_HOST_TEST_ENFORCE=1 admission; the HTTP command waited for its normal suite slot. The final source build and ordinary dependency-hook preparation exited zero. Normal commits, including the documentation correction and main merge, passed all 55 lint steps and remaining hooks. The five committed runtime/test blobs remain identical to the tested manifest.

The first selected regression reproduced the intended missing-refill assertion but used the wrong enforcement variable and therefore ran in dry-run posture. Its original log and result are retained as diagnostic evidence only. It was not repeated or relabeled as normal-enforcing evidence. Subsequent review found and corrected first-five starvation and hold/stop races before the enforcing GREEN sequence.

The actual complete pre-push gate on 5e9cec15fda5981aacfc75bb54b1707004112906 reproduced exit one: the newest release fragment was newer than all side-effects reviews. This new substantive artifact addresses that latest work without touching the old review. Final full pre-push execution will be recorded separately on the committed successor, with its real exit and selected refs. Complete exact-head suite verification, publication and live activation are still absent and remain separate requirements.

## Rollback
Revert the refill source and route changes normally; no data migration or external compensation is needed. The waiting-file format is unchanged. Existing entries remain readable and can be offered by their owner or watcher as before. The documentation-only release-note correction can be reverted independently, although restoring its internal-only marker alongside runtime changes would again fail normal pre-push validation. No test cap, safety hold or merge rule needs to be relaxed for rollback.

## Second-pass review
**Reviewer:** /root/distributed_train.

Concur with the review. The reviewer read this entire current-shipment artifact, including signal versus authority, ownership and race bounds, the release-note correction and main merge, evidence limits and rollback. The reviewer independently checked that all five current committed runtime/test blobs equal the executed GREEN manifest hashes and that the preserved complete pre-push baseline reports the stated newest-fragment refusal. The actual 23/9/8 focused evidence is supported by the prior raw-log review. The diagnostic dry-run baseline and the absence of full-suite, publication and live claims are retained honestly. The reviewer ran no tests and made no source edits. The earlier artifact and its original review remain unchanged.

## Review correction on 64ad550c

An automatic re-offer requires a current GitHub view that is non-draft, mergeable, and targets main. It reuses the existing hold-label and hold-title rules. An ineligible or unknown view leaves the waiter and its original timestamps in place and uses the same two-minute backoff as a transient read failure. This lets a later eligible waiter proceed and preserves the earlier waiter's original age. A capacity or priority refusal also leaves the timestamps intact.

This is existing coordinator admission authority. Explicit requests, merge eligibility, and review-trace checks retain their existing paths. GitHub readiness can change after admission, so dispatch and merge still need current-head checks. The correction adds no durable fields. Reverting it restores the previous behavior without changing saved waiters.

The amended worktree passed 30 focused unit cases, including the readiness matrix and capacity-race regression. The run reported an unavailable SQLite native binding in the shared checkout. All selected waiting-list cases ran. After the two readiness fixtures were updated, all nine focused HTTP integration cases and all eight production-wiring lifecycle cases also passed. Independent review of the amended bytes is pending.

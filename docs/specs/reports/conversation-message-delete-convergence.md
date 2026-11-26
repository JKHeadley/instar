# App Delete local storage checkpoint review

The independent review examined exact target binding, immutable creation custody, raw journal reads, byte locator validation and out-of-order replay. Its final proof concern was addressed by checking the decoded conversation and event IDs on both records. The focused tests exercise a durable fact before its target, rebuild, constructor reopen, index disagreement, duplicate facts, and wrong custodian or target.

Cross-model reviews of the combined design raised future admission and projection choices. The contract now requires the original custodian and request-bound intent, a durable authoritative-read restriction, a replayable cursor boundary for unresolved authorization, and catch-up before restoring a client cache. A missing or unreadable proof remains distinct from an accepted durable writer record. This disposition covers the local storage checkpoint only. The combined route, network and native contract will need implementation evidence before it can be enabled.

Related work includes signed App Forward and Reactions custody, exact message context, App journal replay, mobile unread projection, attachment purge and native cache history.

The closing Astra review found the two remaining local index-integrity issues resolved. A read snapshot and stable file checkpoint fence concurrent appends. The integrity scan reconciles unique raw removal IDs with both indexes and verifies an invalid candidate through the same negative path. The final local suite passed 25 store tests. Existing signed HTTP and production lifecycle regression suites passed 31 and 2 cases. No claim is made about a Delete route, a peer serving a removal, or a restored client cache.

## Signed fresh admission checkpoint

The next checkpoint introduces a private signed admission helper. Independent review found owner identity namespace and custody error ordering gaps. The follow-up binds the original signed pairing and stable current person, keeps permissions separate from retry identity, and reports custody independently of target identity before looking up any row. A machine namespace mismatch cannot authorize the action. Original signed-device proof still does not establish historical person authorship, so this checkpoint admits conversation owners. The production route, reservation effects and read projections remain unmounted. The private HTTP harness runs the real device authenticator.

The closing cross-model pass found no material issue in the private admission helper. Wrong custody is settled without reading any event, and unnamed operator identities need an account identifier before selection. The production authenticator test covered signed acceptance, exact ID scope, denied or absent target, wrong machine and unavailable holder, unsigned refusal, and namespace changes after owner replacement. No persistence or production Delete action was tested or claimed.

## Local history projection checkpoint

The independent and closing cross-model reviews concurred on this unmounted scope. The initial exact projection checked removal before row authorization. The final version applies the caller's access check first, retains ambiguity for a caller who could see both occurrences, and keeps a link usable for a caller whose only visible occurrence survives. Filtered pagination matches both target identifiers and the custodian before consuming page slots. The proof intentionally checks journal checkpoint and identity consistency, with no claim of detecting content-only tampering. The cold journal scan needs a bounded or background implementation and workload evidence before request-path use.

## Local history proof cache checkpoint

The Astra review concurred on the unchanged proof identity and fail-closed behavior. Its coverage suggestion was applied. The focused regression now counts two scans for A, B, A and a third scan after removing A's message, while separately asserting the visible rows. The cache is capped at 64 entries and index rebuild clears it. Cold proof cost remains a requirement before mounting interactive routes.

## Scheduled history proof checkpoint

The independent and cross-model reviews concurred on the custody, checkpoint and descriptor lifecycle. The caller prepares a proof separately from an interactive store read, with one active scan per store. The scan yields between journal chunks and abandons its proof after either a journal append or an external index-only commit. This supersedes the prior synchronous history scan while leaving negative receipt proof unchanged. The first scheduled SQL count and readiness under sustained unrelated writes remain pre-mount performance conditions.

## Scoped plain-message invalidation checkpoint

The independent reviewer concurred on the successful plain-message transaction scope. The cross-model review asked for direct proof of duplicate handling and deterministic in-flight coverage. The test pauses after an actual batch, appends both a distinct and a conflicting message in another chat, and verifies the target proof and original exact text. A same-chat append invalidates the proof. The global message-ID constraint and ignored insert preserve the first binding. A failed or unattributed mutation and external SQLite commits keep their existing invalidation.

The same disposable 25,000-message workload that aborted ten attempts at baseline completed on the first attempt with 34 unrelated messages committed during preparation. This checkpoint is unmounted. Ordinary signed read and Delete route integration remain separate.

## Private signed execution checkpoint

Independent review concurred on the current signed owner scope, the reserve-to-append boundary and exact proof required for retry. Cross-model review found the first draft needed proof of target visibility after a prior removal, direct recovery testing for a persisted entered reservation, current message access on receipt recovery, and explicit expiry handling. The final executor verifies absence before reserving, requires exact retained row access before returning a receipt, and rejects expired requests independently of the active-entry exemption. The private fixture covers a completed reservation, a crash window both with and without a committed removal, and a handled interruption. A separate fixture tests retained and expired receipts and refuses changed intent. The production lifecycle confirms the action path remains inaccessible and the original history is still visible.

## Prepared execution checkpoint

Independent review concurred on the one-process synchronous reservation and append boundary and on positive-only receipt proof. Cross-model review asked for a process-overlap boundary, deterministic competing requests, and row revocation during preparation. Production mounting now explicitly requires the existing process lock and a two-process shared-state check. The private signed tests pause multiple requests after their initial ledger miss, and cover identical retries, different IDs for one occurrence, and conflicting targets under one ID. A changed intent returns conflict before any prior row binding check. Custody loss, row access loss and changed proof prevent a fresh append. Missing receipt recovery exercises the positive-only path without invoking the synchronous full scan.

## Private writer-lock checkpoint

The independent review concurred on lock revalidation at reserve, append, receipt persistence and unknown persistence. Cross-model review identified bypass eligibility and the distinction between the cooperative lock and an atomic ownership fence. Delete now requires a normal acquisition for the same state directory. The fixture checks wrong-directory and bypass locks, a different Node process refused by an established holder, and loss of ownership before and after append. After a durable append, the successor can confirm the original fact without appending again. Concurrent fresh acquisition and stale-reclaim hardening remain production mount requirements for the shared lock primitive.

## Atomic process-lock publication checkpoint

Independent and cross-model review concurred on publishing a fully written temporary record through an atomic no-replace hard link. The follow-up distinguishes best-effort scratch cleanup and tests an unsupported link explicitly. The unit test places a winning record at the destination immediately before publication and verifies that the record is intact. The lifecycle test coordinates two distinct Node processes against an empty state directory and verifies one acquired process and one matching disk record. Stale-holder reclamation is outside this checkpoint and remains a pre-mount requirement.

## Serialized stale process-lock recovery checkpoint

The independent and cross-model reviewers concurred on interprocess serialization for cooperating updated binaries. In the reclaim transaction, the current lock must still match the observed process, hostname, start time and heartbeat. Liveness is freshly checked before unlink. The focused tests cover new ownership and start-time changes, a busy SQLite connection, simultaneous start from stale state, and recovery after a child is killed while holding the SQLite mutex. Fresh ownership remains protected by no-replace publication. Production mounting must exclude older binaries sharing the same state directory and wire the normal boot lock.

## Private message-change sync projection checkpoint

Independent and cross-model review required the cursor to stop before unresolved target or access evidence. The final projection distinguishes allow, deny and unknown. It suppresses a removed original at its own sequence, and emits or holds the marker at the removal fact's sequence. Denied markers advance without IDs. Unreadable original locations cannot advance search past the marker, and corrupt page source locations return no page. Tests cover retained access changes, one-entry paging, reversed arrival, duplicate removal, denial, and corrupt offsets. The production lifecycle confirms the old events route still keeps raw removal facts dark. Signed cursor scope and live cache reconciliation remain production setup work.

## Private signed cursor codec checkpoint

Independent and cross-model review concurred on the scope, epoch and exact sequence MAC. The production contract now requires one shared codec lifetime per serving process, an authority revision that can recognize grants revoked and restored, and a merge-time check that rejects a stale page even after a new epoch is visible. The unit tests cover exact scope, modified and malformed tokens, codec replacement, and access changes. A production lifecycle fixture confirms the generic feed cannot interpret the private continuation. Production authority and client integration remain outside this checkpoint.

## Private Team Access revision checkpoint

The independent and cross-model reviewers concurred on the log-local change and revoke/restore behavior. The cross-model retry confirmed the revision is insufficient for verifier transitions outside the existing fold detector. Production must add a separate key-ledger and verification revision. The tests exercise signed grant loss and restoration, stable reads, log replacement, and reset of an actual issued cursor under both later revisions. No route consumes this revision yet.

## Private device-key evidence revision checkpoint

Independent review concurred on the file-checkpoint scope. Cross-model review identified detached rows, malformed evidence and descriptor/path binding for a cold read. The final cache validates the opened descriptor before and after reading and compares the canonical path before publishing. Tests cover exact byte-identical replacement, disappearance, malformed rows, cold-cache path replacement, local revocation, replication and duplicate stability. The confirming review found no further ledger implementation defect and identified production-only requirements for idle client invalidation and reconciliation of a permanently unavailable original. Both are recorded as pre-mount requirements.

## Private machine trust evidence checkpoint

Independent and cross-model review required transaction-journal refusal, descriptor/path consistency and stable revisions across alternating scopes. The private observer now couples fresh signing keys to a bounded scope cache and rejects mismatching descriptors, malformed epochs and malformed signing cutoffs. Registry evidence can invalidate the revision without governing historical key selection. Tests cover rotation and retired keys, stable alternating scopes, malformed authority data, a transaction in progress and a temporary path swap. Production still must combine this input with current access and pairing evidence, and renew display only through the current high-water mark.

## Private signed owner sync authority checkpoint

The independent and cross-model reviews required full post-evidence ownership and custody checks and a stable composite revision. The private resolver shares the recorded conversation owner rule with Delete admission. It denies a signature from a different recorded owner, a missing owner identifier, an unstable sample, or a lost holder. The signed HTTP fixture binds a cursor in the same scope and resets on changed revisions. It uses a fixture sequence and does not read or serve a sync page. The production lifecycle verifies the existing feed never returns private cursor authority.

## Private signed owner sync page checkpoint

Independent and cross-model review confirmed the prepared page and cursor boundary after requiring an exact proof comparison and preserving unresolved row access. The fixture reads real projected messages and markers, holds the exact cursor at an unresolved marker, then retries it ahead of later rows. It withholds a page on authority change during preparation or on a removal immediately after selection. A replacement proof cannot certify an earlier page. The wire allowlist excludes retained signatures and access metadata. Production remains dark and the high-water and cache deadline handshake are still required.

## Private signed high-water checkpoint

Independent and cross-model review concurred that catch-up is tied to the exact prepared snapshot and cannot be inferred from an empty page. The high-water identifier has its own MAC domain and cannot resume a continuation. The HTTP fixture checks a filtered short page, a blocked page, exact catch-up and advancement when a removal arrives. The client contract binds its deadline to request start and requires durable application before displaying cached rows. The delayed-commit and missed-removal checks remain client acceptance requirements.

## Store-backed journal revision checkpoint

Independent and cross-model review required exact descriptor growth, index continuity and short-write evidence. The final store compares the exact previous indexed length and records the same inode's expected growth only after a successful index commit. An unexpected replacement or rewrite causes a new revision. Tests cover ordinary appends, exact rollback bytes and a clean subsequent append after reopen, replacement and rebuild, and signed reset after real store rebuild. Journal restoration requires the exclusive writer boundary. The production boot test exercises the same store with Delete off. Legacy offline copies and activation enrollment are explicitly outside this checkpoint.

# Convergence Report — Messages reach the exact receiving session

Rendered complete overview: https://echo-studio.dawn-tunnel.dev/docs/721c80e1-7375-4e61-b6ec-ba9728ce5698. Published through the sanctioned script; document version2 read-back exactly matches the complete overview. This is an in-progress build record, not an approval or release request.

## Cross-model review: codex-cli:gpt-6.2-astra

**Reduced assurance: the author and reviewers all used Codex.** Actual separate bounded CLI judgment processes provided process independence, not model-family diversity. The external script's cross-family symbol assumes a Claude author; it is not asserted here. User forbade Claude/Fable; Gemini was unavailable. The sibling evidence JSON records exact provider/model, input/spec hashes, input sizes and output hashes.

## ELI10 Overview

The old safety check could reject a session for ten minutes after it started. Relaxing the clock check would also let a replacement receive text intended for its predecessor. The repair asks the receiving computer which exact session holds the role, verifies its signed answer, and binds that session before creating the message.

The sender behavior ships switched off while computers update. When enabled, unavailable proof becomes an explicit recorded failure rather than a later replacement. If typing may already have happened, the system records uncertainty and does not automatically repeat that payload. The separate proactive notification remains best-effort under its older tracked durability gap.

## Original vs Converged

Initial arithmetic tolerance was rejected because signature clock skew cannot bound network transit. Exact signed generation replaced time inference. Review then found concrete downgrade, ownership, physical uncertainty, watchdog and TTL races, requiring an authenticated wrapper, durable exclusive ownership, committed-state rereads and final expiry checks. The expanded published interface and recovery behavior require Tier2, despite the original small symptom.

## Iteration Summary

| Phase | Findings and resulting changes |
|---|---|
| Inherited arithmetic | Independent review rejected grace-based replacement admission and transit inference. |
| Signed redesign | External Codex, actual conformance route and clean scalability/decision/lessons lenses challenged proof serialization, revoked membership, physical uncertainty and durable ownership. |
| Revised full design | Clean sequential lenses found stale state, initial-owner theft, admission-tail cleanup, broadcast classification, downgrade-before-pin and incomplete metrics. |
| First closure | Fixed local-sent ownership, delayed callback versus queued pin, receiver-clock TTL, absent resolver503 and distinct mismatch outcomes. |
| Second closure | Fixed received retry-owned waits, expiry during safety inspection and missing pin evidence. |
| Third closure | Moved expiry after generation lookup and distinguished observed replacement from absent holder in timer evidence. |
| Fourth affected closure | Added final work-window fence and distinct absent/current-id lookup at physical injection. Dedicated source/artifact reviewer subsequently concurred with those exact corrections. |

Each follow-up responded to an actual substantive finding. The dedicated adversarial/source reviewer concurred with the previous targeted corrections, then the clean closure found two additional boundary issues recorded above. Root integration/deployment review is explicitly a root-process lens; root approved final Tier2 source/side-effects/deployment plan after reading actual conformance, rollback and AgentServer proof. Separate N72 security review found revokedAt membership and partial-write/Enter-timeout uncertainty; both corrected. Current source/artifact verdict is concurrence after those findings were corrected. Release readiness remains pending the reserved complete suite and root integration/deployment review.

## Findings Catalog

| Finding | Final implementation or explicit disposition |
|---|---|
| Grace admits replacements; clock skew does not prove transit | Exact precreation receiving generation, never late-bound. |
| Unsigned LAN/self-reported peer data is unauthenticated | Canonical peer registry key; request nonce; signed target/id/time digest. |
| Relay ACK extra properties are not serialized into signature | Domain-separated observation digest lives in actually signed messageId. |
| RevokedAt plus active merged status passes middleware | Endpoint independently requires canonical isMachineActive. |
| Recipient id/required fields stripped or tampered | Whole message is signed; real authenticated HTTP inner tampering tests. |
| Replacement during awaited pin/safety; stale session cache | Final synchronous lookup after last await; real warm-cache invalidation test exercises SessionManager lookup. |
| Downgrade between proof and payload or acceptance and pin | Authenticated domain-tagged wrapper and separate route; old handler rejects intact wrapper even if path rewritten. Initial state cannot trigger old by-name recovery. |
| Redirect sends private payload off registry | Manual strict transport redirects; real307 regression proves target receives zero requests. |
| Boot/timer compete with active typing or stale snapshot | Exclusive claim through persistence; fresh store reread; inherited claim in redelivery. |
| Initial accepted/local-sent work loses executor | Timer executes accepted unarmed work under claim; fresh sent remains owned by initial local executor. |
| Delayed initial callback bypasses retry budget or queued pin | Initial-only guard skips reserved received waits and queued pins. |
| Expired waiter removes predecessor admission | Cleanup awaits actual tail settlement and checks tail identity. |
| Broadcast star treated as named peer | Reserved fields stripped at ingress; only concrete machine enters proof. |
| Failed final persistence reports delivered | Caller returns committed phase; armed uncertainty survives and never automatically retypes. |
| Physical false/throw may follow paste or Enter | Explicit outcomeUnknown; retain marker; terminal status with may-have-arrived detail. |
| Watchdog requeues confirmed pinned paste | Pinned delivery cannot regress based only on subsequent liveness. |
| Retry restart resets budget or cadence | Durable reservation before action; increasing backoff, work-window and TTL fences at final injection. |
| Receiver wall clock causes immediate false expiry | Receiver-local expiry from accepted sender-measured age, reused by timer/boot/final physical fence. |
| Missing immutable pre-send proof never recovers | Immediate origin failure before payload transmission, and changed id terminal at receiver. |
| Unauthenticated first address suppresses later signed answer | Registered alternatives within total deadline, fresh nonce per attempt, bounded streamed body. |
| Audit fields/rotation unbounded or blocking | Async serialized writer, bounded fields, projected-size rotation and retained predecessor. |
| Capability status stale after live flag flip | Actual router live getter, verified with deliberately stale config snapshot. |
| Rollout uncertainty false zero or absence mislabeled replacement | Durable outcomes emit evidence across initial, retry and recovery; actual current-id lookup distinguishes absence and replacement. |

## Foundation Scope and Accepted Tradeoffs

Once-only claims concern one immutable envelope. A fresh client POST after losing its response creates another message: stable submission identity is **fb-cf81617c-e91**, owner messaging reliability / takeover-ready pool. General terminal-notice crash-before-intent and offline-origin loss is **fb-292ec9c9-9d3**, same owner, with crash-boundary recovery tests required. Adverse delivery outcome is durable; proactive display is best-effort. GET /messages/:id and GET /messages/stats undelivered counters are partial observability.

Enabled preflight deliberately reports generic unavailable proof rather than candidate-session or moved-topic detail. Old generic queued unpinned records retain inherited handling. Old senders keep their conservative time lane; it is not claimed to gain the strict guarantee. Default-off sender rollout preserves legacy sending during asynchronous upgrades.

Five-second admission, finite retry backoff and bounded diagnostics are resource policies with availability cost: a healthy peer can miss the deadline; a valid holder appearing late may not be retried. The one-day/three-sample and seven-day/ten-sample values are minimum exposure/evidence floors, not statistical proof or automatic advancement. MaturationLadder really marks hold/harmed when error metrics fail. Deliberate uncertainty/crash drills use isolated test-agent logs; development production errors are never silently relabeled or excluded. Real physical test-agent drills, recurring model review and independently agreed fleet defaults remain required. Mocked tmux checks do not complete that live rung. Root directed receiver-support verification before enabling senders.

## Conformance and Parent Fit

Actual createSpecReviewRoutes ran locally with the complete real registry and explicitly configured bounded Codex provider. This exercises the real implementation and gates. Parent principle resolved as An Instar Agent Is Always a Multi-Machine Entity; fit, nondegraded. Earlier possible concerns covered resource/rollout judgment, live-rung wording, inherited notice loss, legacy acceptance and diagnostic reduction. Live-rung and review wording corrected; policy costs and independently owned foundations disclosed rather than presented as solved. Latest actual route result: HTTP200, nondegraded, parent fit, seven possible policy/foundation flags. Its checked spec hash is in the evidence index; subsequent editorial changes clarify development-agent role and exclude induced drill uncertainty from unexplained harm. This is not described as a clean conformance pass. Root explicitly dispositioned all seven possible flags below; this is approval of the reviewed source and deployment plan, not deployed behavior.

## Verification and Rollback

Private Node24.14.1, ABI137, actual SQLite memory query passes. Fifteen real HTTP integration checks and seven AgentServer lifecycle/wiring checks pass. The AgentServer uses actual identity/key/nonce/security dependencies, verifies signed generation and strict payload ACK, invokes one pinned delivery, and rejects a canonically revoked peer. The final nine-file focused batch passed189 unit tests, including28 generation/recovery boundary tests, on private Node24. A further passing observability-only regression checks that differing remote generation ids collapse into one counter, for190 unique focused checks across the two final runs. Normal Node24 npm run build passes. Complete shared test:all awaits its assigned slot. Ordinary lifecycle teardown records an existing Codex token-ledger worker exit; this did not fail its assertions.

Actual old DeliveryRetryManager source from901d368e7 ran against current MessageStore: zero injections into reused name, one terminal notice, dead-letter true. Path rewrite of the authenticated strict wrapper is refused by old handler shape. Live rollback disables new sending without restart; already bound work remains fenced. Deployment, restart, push and PR are outside this candidate phase.

## Verdict

Source/artifact review concurs after correcting the concrete findings. The design is converged and root explicitly approves normal commit and reserved full-suite verification, with dispositioned conformance flags and reduced model-family assurance. Full test:all and physical test-agent/live rollout remain outstanding. This is not a release/deployment claim.

## Root Disposition of the Seven Possible Conformance Flags

1. One in-flight peer send and shared five seconds: accepted conservative initial resource policy, with real availability cost, not a security theorem.
2. Finite retry/backoff: inherited resource policy; does not promise ten attempts or continuous five-minute coverage.
3. Exposure/sample minima: evidence floors; actual hold/harmed metrics still apply. Deliberate failure drills stay isolated from development-canary logs until a real tagged-drill exclusion exists.
4. Verify all intended active receivers before first sender flip: accepted first-rollout sequencing to avoid mixed-version regression, not universal code eligibility.
5. Proactive notices: best-effort inherited foundation fb-292ec9c9-9d3, with durable adverse outcome and status; no guaranteed display claim.
6. Select canary by development-agent role, without hardcoded machine identity.
7. Generic proof failure: admitted diagnostic reduction, not security necessity; use durable message status plus pool/ownership reads.

Root concurrence covers source, side effects and deployment plan only. Complete suite and actual physical live behavior remain unverified here.

## Normal Commit Gate Evidence

Attempt1 ran55 lint steps:54 passed, offline carrier resolvability rejected the feedback marker because its parser requires a real CMT excerpt. Corrected through sanctioned workflow: actual CMT-2183 and CMT-2184 reference the existing feedback items and root-assigned owner/next steps; refresh-carrier-ledger.mjs generated the checked-in snapshot, and the spec freezes the actual returned excerpts. Tracking remains intact, no completion/owner acknowledgement is fabricated, and foundation work remains outstanding under the program pause. Root explicitly authorized this carrier-only correction without another source review round.

## Post-commit Full-suite Failure Follow-up

The exact318922be1 full unit run failed3 tests and stopped before integration/E2E. The separate failure-followup report preserves the original evidence and traces each root cause. A narrow corrective delta restores explicit retryable handling only for known read-only preflight errors, documents/test-proves the already observable audit-loss warning without increasing baseline494, and gives the remediation test its real typed retryable result. All three original failed files pass together plus focused boundary tests (99), HTTP integration15, lifecycle/wiring7 and build. Root concurrence on this corrective delta is pending; complete test:all is not claimed green.


## Draft Full-Verification Wiring Failure Follow-up — 2026-11-22

Draft PR #3635 at `e1bfb93811e88915b4959b9666438b7e56b8a8d7` passed its separately allocated enforced unit run: 4,018 files and 73,684 tests passed, three files and 24 tests skipped, zero failures. Its normal M5 full-verification attempt `728da5abcd4b8617aa3a1570f6cbb09d` subsequently failed the cross-machine wiring file on base `22f686b3e821d39173a5351c8a01fc471f323d29`. The E2E tier reported 4,364 passed, one failed, 33 skipped and three todo; unit/integration zero counters are not successful gates. The draft remains held.

The original raw assertion was not retained by the installed verifier. One separately allocated diagnostic file run reconstructed the exact recorded merge tree `da823ee03253b9c1775d0ac6d6f3d8f6938e775d`, used private Node24 dependencies and the ordinary enforced semaphore, and reproduced four passes and one failure. Its actual assertion at test line44 required literal `${RELAY_MACHINE_PATH}` interpolation. The sender now deliberately selects `GENERATION_RELAY_MACHINE_PATH` for a generation-required envelope and `RELAY_MACHINE_PATH` otherwise. Thus the assertion demanded the superseded unconditional source shape rather than the current shared-path contract.

The correction changes only that wiring test: it requires the strict/legacy conditional and manual redirect policy for generation-required envelopes, retains the exclusion of hardcoded router paths and leaves the other four wiring checks intact. Production code is unchanged. The separately allocated corrected-file validation passed all five checks with exit0 at07:56:55.731478Z after real enforcing cap1 admission PID11895. The original diagnostic and corrected validation files/logs remain separate. Normal full verification of the corrective exact head is pending; no additional manual suite or successful full gate is claimed. Diagnostic stdout and result are preserved in `/tmp/n73-wiring-diagnostic-2253.log` and `/tmp/n73-wiring-diagnostic-2253-result.json`; the isolation notes are `/tmp/n73-wiring-debug.md`.

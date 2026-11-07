# Side-Effects Review — Job result fixed certificate pool authority

**Version / slug:** `job-supervision-pool-authority`
**Date:** `2026-11-02`
**Author:** `Echo`
**Second-pass reviewer:** `outage_fallback_review` (focused authority path concurred; rollout gates remain open)

## Summary of the change

This dark-gated increment adds a pinned single-writer fixed-result certificate registry, signed fresh snapshots, reviewed issue and signed revocation routes, a durable monotonic reader witness, and production worker/scheduler wiring. It changes `JobSupervisionStore`, `JobSupervisionWorker`, `JobScheduler`, `AgentServer`, the job routes, the scaffold awareness text, migration and CapabilityIndex. It does not turn on Jev decisions. The decision points are exact fixed closure, registry failure hold, recovery release, and false-routine revocation.

## Decision-point inventory

- `JobFixedRegistryAuthorityStore.issue/renew/revoke` — add — only two independently signed, adequately evidenced exact shapes may enter the active set; renewal atomically retires the prior certificate with a fresh canary assertion; revocation advances a durable epoch.
- `JobFixedRegistryReader.read` — add — only a fresh pinned signer and monotonic snapshot may grant fixed decisions.
- `JobSupervisionWorker.process` — modify — exact shape uses the fixed certificate only after a fresh read; unreadable/ambiguous authority holds the slug.
- `JobSupervisionStore.resolveFixed/gradeOutcome` — modify — fixed routine closure, holds and false-routine outbox are transactional.
- `JobScheduler` admission — modify — a transient registry hold can release after independent recovery, while permanent holds remain cached.
- `POST /jobs/fixed-registry/issue/renew/revoke` — add — issuance and renewal validate two signatures; revocation validates an enrolled machine-signed false-routine proof.

## 1. Over-block

A short writer outage currently holds any result with a persisted fixed-shape projection even when that shape has never been certified. A 5-second freshness limit can also hold after clock skew or a slow link. Both leave results visible as unchecked and affect future fires. I tried using absence from the last replica snapshot to narrow this, but the independent reviewer showed that a stale snapshot cannot prove a shape was never issued and revoked. That draft was removed; the safe over-block remains until a current authority read or independent evidence can distinguish the cases.

## 2. Under-block

This increment does not implement seven-day stratified 10% surveillance, the 48-hour grade deadline, or 14-day no-outcome suspension. A signed issue request can claim evidence IDs without the authority itself dereferencing the review artifact; the independent signatures are its trust boundary. A peer whose enrollment was revoked immediately before a revocation request may be rejected even if its proof is true; its local hold/outbox remains pending. The joined provider-outage prior-runner reservation path is also not present. Therefore the rollout switch remains off.

## 3. Level-of-abstraction fit

The single pool authority owns certificate state and epoch; the machine-local store owns the evidence and transactional result state; the scheduler owns future-fire admission. This follows the approved spec's authority boundary. The replica is a rollback/equivocation witness only and cannot elect itself writer. The worker consumes a verified snapshot rather than a fan-out observability result.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No brittle semantic filter has blocking authority. Exact certificate membership, cryptographic signatures, epoch, freshness, and parser integrity are hard invariants over a finite declared contract.
- [x] Uncertified or changed results continue to the existing model judgment path while its audited cohort is active. No static heuristic judges their meaning.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. Fixed closure is permitted only for an enumerated exact shape signed by two independent principals after 300 gradable observations; ordinary results remain judgment-routed. An unreadable authority cannot safely grant a fixed closure, so fail-closed is the deterministic safety floor.

## 5. Interactions

- **Shadowing:** The worker checks evidence sufficiency before reading the registry. A revoked certificate remains in the exact-shape lookup and prevents Jev from interpreting the same bare OK text as routine.
- **Double-fire:** The revocation dispatcher may retry the same proof; writer revocation is idempotent and the outbox acknowledges only after a fresh signed snapshot proves revocation.
- **Races:** An independent grade writes the local hold and outbox in one SQLite transaction. The scheduler checks the fresh pinned writer before a script claim, after slow gates, and before executing after start offset. A stronger permanent hold promotes over an active transient hold in one transaction. A decision can race a later revocation in the normal distributed interval; the local false-routine hold is immediate and peer admissions reread the writer.
- **Feedback loops:** A successful audited Jev verdict may release only a `registry-unreadable` hold, and only after no other open registry attempt remains for that slug. It cannot release a revoked or confirmed false-routine hold.

## 6. External surfaces

The new authenticated routes expose only signed registry metadata and signed certificates, not raw job output. The ledger gains fixed-shape projections, hold release events and a revocation outbox; migrations are additive. Peers make 2-second bounded requests to the pinned authority. The issue route is a principal action and currently has no phone-completable review/issuance surface; this must be resolved before activation. No Telegram user notice is emitted by this dark increment. The dispatcher may create a HIGH attention item on pending revocation failure.

## 6b. Operator-surface quality

No dashboard renderer changed. The issue route needs an operator workflow before activation; the present API surface is not a completed operator UI.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated:** one pinned writer persists the canonical epoch and serves fresh signed snapshots; each machine durably records the highest witnessed epoch and proof digest. The replica cannot grant closure while the writer is unreachable. Machine-local false-routine grades and holds are sent to the writer through a signed durable revocation outbox. `GET /jobs/triage?scope=pool` exposes coverage and missing peers. Attention items remain machine-local; a one-voice notice must be proved before any user-facing rollout. No URLs are generated for users. Claim transfer requires the new owner to read the same pinned writer before fixed closure.

## 8. Rollback cost

The source-owned decision cohort is off. Revert code to stop new reads and writes; additive SQLite columns/tables remain inert. A deployed active cohort would need an explicit dark gate and prior-runner reservation before reverting, because a revoked or pending certificate cannot be treated as healthy. No certificate has been issued on production in this run.

## Conclusion

This review finds the authority boundary sound for a dark draft but identifies remaining over-block, surveillance, operator surface, and outage fallback gaps. It is **not clear to ship or activate** until those are closed and the production lifecycle and full suite pass. The earlier permanent outage-hold draft was removed after review; the current transient registry hold has reason-scoped release and append-only history.

## Second-pass review (required)

**Reviewer:** `outage_fallback_review`
**Independent read of the artifact:** concern

The reviewer found five blockers: revocation did not affect peer admission before the next result, a registry hold could strand after the attempt's 24-hour retry window, a stale replica cannot prove negative membership, the outbox retried without backoff, and the E2E test covered only the empty writer route. The stale-replica branch was removed. Admission now reads the writer at all three pre-execution boundaries; a held registry attempt remains retryable after 24 hours; the outbox has durable exponential backoff, a daily probe after 20 failures and one escalation; a new E2E joined scheduler test is queued. Hold promotion, numeric schema validation, writer size limits, and signed recertification release were added in response to earlier findings. The remaining concerns and test results require a new independent pass before code can ship.

The next review found that a stale active canary could still admit a fire, certificates had no renewal path, recertification could ignore the current feature state, attention delivery could be acknowledged before the send, and shutdown could clear the authority reader while a delayed run remained pending. Admission now validates every active slug certificate's signed canary age and checks the scheduler state again after the writer read. A sticky authority requirement denies admission after reader teardown. The writer has an atomic, two-signature `renew` route for a fresh canary assertion on the same exact shape. Recertification requires the current feature-state hash. Attention is acknowledged only after its asynchronous send succeeds; failed sends remain retryable. Targeted tests for these changes are queued. The reviewer has not cleared this draft, and fleet rollout remains off.

A further review found a late-grade race: a canary renewal could retire certificate A before an independent false-routine proof for A reached the writer, leaving renewal B active. The writer now persists each renewal edge in SQLite. Revoking A walks that lineage and revokes its active descendant in the same epoch transaction, even when A was routinely retired already. Unit and authenticated HTTP tests cover a delayed proof arriving after renewal. This is still a dark draft pending test results and a final review.

The reviewer then identified a separate reissue race: a new certificate C for the same exact contract could be issued after B was revoked but before a distinct old proof for A arrived. The writer now records accepted misses by source machine, attempt and certificate in the same transaction as revoking **all** active certificates for that exact contract key. Replaying an accepted miss leaves a later reviewed recovery active; a distinct newly accepted miss suspends it. Each certificate signs the latest writer miss epoch it reviewed, and the writer rejects issue or renewal if that epoch is stale. The signed registry snapshot exposes contract miss epochs for the review workflow. The authenticated HTTP test covers the new issue, replay and distinct late-miss boundaries. The independent review of this additional fix is pending.

The focused independent re-review **concurred** on the proof-aware path, including the production authority-local dispatcher. A separate limit check on new miss-contract entries was removed because refusing a critical revocation at capacity would leave peers trusting an active certificate. If the signed snapshot exceeds its reader cap, readers hold new fixed decisions and script admission until the registry is repaired. The full test gate and broader rollout requirements remain open.

The joined lifecycle test now boots a second `AgentServer` with its own machine identity and state directory, registers the writer's public identity in that peer, and uses a real authenticated HTTP fetch from the pinned writer. The peer's scheduler must route its scheduled fire to the prior session after the writer's local dispatcher accepts a false-routine proof. This closes the earlier one-machine-only test coverage gap at the production initialization boundary; the test is queued and must pass before ship.

The older active test-agent lifecycle fixture also now provisions a real machine identity and signed local registry. Its provider, redaction, timeout, and hold checks therefore run with the same authority requirement as an active production cohort. TypeScript compilation, the build, and `dev:preflight` pass after this fixture change. The queued integration, lifecycle, and full-suite results are still required.

A final admission review found that an active cohort with no configured registry reader would otherwise retain the scheduler's ordinary script default. `AgentServer` now marks authority as required whenever the result-supervision cohort is active, even when configuration cannot construct a reader. The scheduler writes a `registry-unreadable` hold and selects the prior runner. The focused scheduler suite passed 33/33 with this boundary included.

The final worker review found the matching pending-result boundary: a previously recorded fixed-shape attempt could still fall through to Jev when an active cohort booted without a registry reader. `AgentServer` now explicitly marks registry authority required on the worker too. The worker atomically leaves that attempt unchecked, holds its slug, and makes no provider call. A focused unit case covers the pending attempt and missing reader. TypeScript compilation passed; the test is queued on the shared suite lane. The independent reviewer re-read this correction and confirmed the identified bypass is closed in the current draft.

**Final independent assessment:** The reviewer concurred on the current dark authority path after the pending-result correction and found no further concrete false-routine closure or post-revocation admission bug. This is a code review result, not a test result or rollout approval. The reviewer did not run tests because the shared suite lane was occupied. The surveillance, 48-hour grade deadline, 14-day no-outcome suspension, phone review surface, prior-runner reservation, and guarded development evidence remain open.

A later source pass found a same-slug transient-hold race: resolving one pending result called `clearHoldSlugIfReason('registry-unreadable')` even while another result for that slug remained open with an unreadable registry. This could admit a future script after an otherwise valid fresh read. The release now checks `hasOpenRegistryAttempt(slug)` inside the same SQLite transaction before clearing that reason. The unit store suite has a two-result regression for the refused release and recovery boundary. TypeScript and `git diff --check` pass. The independent reviewer re-read the transaction, worker and scheduler callers and **concurred** that this identified bypass is closed; no host tests were run during that review. The queued suites remain required before ship.

The first full unit phase later passed 54,727 tests and exposed two static wiring defects in this branch: the new authority and replica WAL stores were not listed in `SqliteRegistry-wiring.test.ts`, and a malformed signed-payload catch was not tagged as an intentional fail-closed fallback. The allowlist now names both stores and a functional case checks register/unregister counts; the catch now carries its rationale. The first joined lifecycle attempt also found an incorrect test expectation: the source's independent false-routine grade had already installed a stronger hold than `certificate-revoked`. The source assertion now checks `confirmed-false-routine`, with the peer still required to show the pool revocation. These corrected gates and the complete suite remain queued, so this review does not claim a pass.

A later source review found a timestamp mismatch in the revocation proof contract: the dispatcher signs a queued proof at delivery time, while the first schema asked the key lookup about the earlier independent-grade time. The proof schema is now version 2 and signs both `gradedAt` and `signedAt`; verification resolves the pinned key at `signedAt`, and the dispatcher sets that time on every delivery attempt. A unit case verifies this contract with a lookup that distinguishes those times. The production `identityKeyLookup` does not use `validFrom` to reject old records, so this review does **not** establish that normal key rotation would have dropped a live proof. It does respect key retirement time; the new contract aligns verification with the actual signature event. Old version-1 proofs are rejected. The independent reviewer concurred on the narrow change and noted that `signedAt` remains a trusted source assertion. The focused and full test gates remain pending.

The focused joined lifecycle rerun reached the second machine but refused its registry read as `registry-unreadable`. The fixture had registered the writer in peer metadata without pinning its remote signing identity. That metadata is insufficient for signature verification, so the test now invokes `storeRemoteIdentity` through the production pairing method before booting the peer. This is a fixture correction, pending a passing E2E rerun; the fail-closed peer behavior was appropriate.

## Evidence pointers

- Approved spec: `docs/specs/job-result-supervision-v2.md`.
- Focused unit, integration, and lifecycle test paths: `tests/unit/job-fixed-certificate-registry.test.ts`, `tests/integration/job-fixed-registry-routes.test.ts`, `tests/e2e/job-fixed-registry-alive.test.ts`.
- Run evidence: `.instar/autonomous/130742-evidence.md` in Echo's agent state.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed. The revocation dispatcher is a self-triggered controller: its edge is an append-only local false-routine outbox, its steady-state bound is at most 100 rows per tick, and its settling brake is an acknowledged fresh signed authority snapshot. The pending outbox does retry every five seconds while authority is unavailable; this should be checked against `tests/unit/self-action-convergence.test.ts` before ship.

`unbounded-self-action` closure: `guard`, enforced by the registered `job-fixed-revocation-delivery` ratchet in `tests/unit/self-action-convergence.test.ts`. The dispatcher processes at most 100 durable outbox rows per tick, backs off repeated failures, and stops retrying each proof only after a fresh signed authority snapshot shows revocation. This is the human mirror of the class-closure trace declaration.

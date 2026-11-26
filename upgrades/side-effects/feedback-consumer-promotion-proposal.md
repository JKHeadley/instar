# Side-Effects Review — Feedback consumer promotion is proposal-set bound

**Version / slug:** `feedback-consumer-promotion-proposal`
**Date:** `2026-11-26`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass review)`

## Summary of the change

The operating-drain design doc (`docs/specs/feedback-factory-operating-drain.md`, Security: "Batch promotion is proposal-set bound") requires that consumer promotion approve one exact, hashed batch of at most 50 queued work ids that the operator has seen. The shipped `POST /feedback-factory/consumer/promote` only checked that `evidenceHash` looked like a SHA-256, so any 64-hex string promoted the consumer, and no surface could show the operator what they were approving. This change adds:
- a pure module `src/feedback-factory/drain/consumerPromotionProposal.ts` that derives the proposal: states, hash and precedence;
- a read-only store method `FeedbackDrainStore.claimableWork()`, using the same order as `claimNext`;
- `GET /feedback-factory/consumer/promotion/proposal`;
- a re-derivation inside the promote route, immediately before the write, that refuses a stale, replayed or invented hash with a named 409.

It also adds wiring in `AgentServer`, a docs page update, an awareness entry, and tests: unit, integration and four updated e2e lifecycles plus a shared helper.

The hash is sha256 over UTF-8 of `instar-feedback-consumer-promotion-v1\nprior:<marker>\n` followed by the sorted work ids joined with `\n`, where `<marker>` is `none` or the existing record's `recordNonce|approvedAt|revokedAt` (`recordNonce` is a random id set on every promotion, so every cycle's marker is unique even if the clock repeats). Binding the prior record means an approval made before a revoke can never be replayed after it, even for the same set.

The promotion record now stores `approvedWorkIds` and `priorRecordMarker`. A record is live only when its evidence hash equals the hash of exactly its own approved ids (`FeedbackConsumerPromotionStore.isProposalBound`). Records written by the old syntax-only route therefore never turn the consumer live; the proposal reports them as `requiresReapproval: true`.

In the live drain run, until every approved item has been attempted under this approval, the consumer claims ONLY approved items (`FeedbackDrainStore.claimNext({ onlyWorkIds })` with `outstandingApprovedWork(attemptBaselines)`), with no fallback to unseen work. A HELD approved item still counts as outstanding, so while any approved item is outstanding and none is claimable, the consumer claims nothing rather than unseen work. That direction is safe. Releasing a readiness hold does not clear it, because release re-enqueues the cluster under a new work id while the old held row still counts. The operator clears it by revoking and approving the fresh proposal. A record is live only when it carries an integer attempt baseline for every approved id. "Attempted under this approval" is judged by each item's attempt count against the baseline recorded at approval (`approvedAttempts`), not by clocks, so a failover between machines with skewed clocks cannot blur it. Queued and retryable approved items both count. After that, the promotion continues as the ongoing consumer at the approved per-run bound, and approved ids keep no lasting priority. Each claim iteration re-checks `isConsumerLive()`, so a revoke or a config change mid-run stops further claims at once.

The proposal's states are evaluated in this order:
1. `unavailable`
2. `restore`
3. `non-owner`
4. `configured-simulation`, while `consumer.dryRun` is not false or the consumer is not enabled
5. `already-live`, a valid record with dryRun false
6. `no-work`
7. `pending`, carrying `localAction: true`

## Decision-point inventory

- `POST /feedback-factory/consumer/promote` — modify — adds a deterministic equality check: the presented hash and bound must equal the freshly derived proposal. The PIN check (`feedbackMutationIntentValid`) and the restore gate are unchanged and still run first.
- `GET /feedback-factory/consumer/promotion/proposal` — add — read-only; no authority.

## 1. Over-block

While an approved item is outstanding but held, or waiting for its retry time, the consumer claims no other work. That is deliberate (safe direction) and visible in drain status. The operator resolves it by revoking and approving a fresh proposal. Releasing the hold alone does not, because a release re-enqueues the item under a new work id.

The check refuses a promote whose batch changed between the operator's read and the write. A new item being queued in that window, by the cadenced drain tick, therefore forces a re-read. That is intended: the operator must approve what will actually be claimed. It also refuses promotion when no work is queued (`no-work`), where the old route allowed it. That only matters to callers that promoted an empty queue in advance. The four e2e lifecycles did; they now run simulation ticks first through `tests/helpers/feedbackConsumerPromotion.ts`. No legitimate operator flow is blocked: Promote is offered only when a batch exists.

## 2. Under-block

The owner-epoch gap is accepted. Proposal re-derivation (which checks `holdsCanonicalLease()`) and the record write run synchronously in one request with no await between them, so no in-process tick can interleave. A lease could in principle expire inside that window; the record write is not epoch-fenced, as before this change. The existing `checkpointBackup('promotion')` that follows re-checks `isCanonicalOwner()` and revokes the record if it fails. If that revoke itself fails, the route returns the error. The record would then stay, and a later status read shows it; this window is narrow and pre-existing.

The hash binds the work ids, not their titles. A title edit to an already-queued row would not change the hash, but titles are written once at enqueue and never edited, so there is no such path. The approved bound becomes the per-run claim bound, and the drain service already claims `min(maxClaims, approvedBatchBound)`. Later queued items are claimed by later runs under the same ongoing promotion. That is the existing semantics; the docs page and the awareness entry state it ("enables the ongoing consumer at that per-run bound"). No issue beyond that.

## 3. Level-of-abstraction fit

Derivation lives in a pure module (testable without a server). The store exposes a read-only query that matches its own claim order. The route layer composes them. This matches how the triage authority proposal (`GET /feedback-factory/triage/authority/proposal`) is built, so it is the right layer. No smarter gate exists for this check: it is an integrity precondition of a PIN-bound operator mutation, not a judgment.

## 4. Signal vs authority compliance

The authority is unchanged: the operator's PIN. The new check is a deterministic equality invariant (presented hash equals recomputed hash) guarding an irreversible-in-effect operator action. It is not a brittle heuristic and not a judgment, so it is a valid deterministic floor under `docs/signal-vs-authority.md`. The GET route is a pure signal.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The state order is an enumerable precedence table (an invariant agreed with the console owner), and the hash check is a safety guard on an operator mutation, deterministic by design.

## 5. Interactions

- Restore gate: `feedbackRestorePendingGate` still answers 409 first on promote. The GET reports `restore`.
- Backup checkpoint after promote: unchanged.
- Drain service live posture: `isConsumerLive` still requires config `consumer.dryRun === false` AND a live record. The GET's `configured-simulation` precedence mirrors that exactly, so the UI never offers a promotion that would not take effect.
- Triage owner proxy: a non-owner GET uses the existing `feedbackTriage.fetchFromOwner`, forces `localAction: false` and always adds `servedBy`. A PIN is never proxied.
- No double-fire or race with the drain tick: the promote check reads and then writes the record file. The worst case is a 409 asking for a re-read.

## 6. External surfaces

- A new authenticated GET route.
- The promote route now returns 409 with `error` one of `promotion-not-pending:<state>`, `promotion-proposal-changed` or `promotion-batch-bound-mismatch`, plus `state` (and `reason` for non-pending).
- The console (echo-instar-dashboard-makeover) consumes this contract in its own PR.
- No callers outside the repo exist. In-repo callers were the four e2e tests, all updated. The integration backup-restore test uses the store directly and is unaffected.
- Titles come from already-persisted work rows. Raw report bodies are never included, which a test asserts.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface in this change (no dashboard file). The console control is built separately by the dashboard session against this contract.

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read: the proposal is derived on the canonical drain owner. A non-owner reads it through the owner over the authenticated peer transport (`fetchFromOwner`), marked `servedBy` and `localAction: false`. If the owner is unreachable, the non-owner answers its own `non-owner` state, marked `stale`. Promote stays owner-only, because the record and backup checkpoint require the canonical owner. No durable state is added.

## 8. Rollback cost

Revert the commit. The record file format (`consumer-live.json`) is unchanged, so no data migration is needed and existing records keep working. A revert restores the old syntax-only check.

## Conclusion

The review confirmed the change closes the documented gap: an invented hash could promote. It did so without changing the authority (the PIN), the record format or the live-posture rule. Design changes made during the work, from the console owner's contract additions:
- an explicit `localAction` on every response;
- `servedBy` on every proxied response;
- config dry-run wins over an existing record;
- a `promotionRecord` summary.

Clear to ship.

## Second-pass review (if required)

**Reviewer:** independent cross-model reviewer (codex-cli, read-only, bounded; a fork cannot start sub-agents)

Round 1 verdict was concern:
- the first live run could claim unseen work;
- legacy syntax-only records stayed live;
- the `unavailable` response lacked `localAction`;
- a non-owner without triage named no owner;
- the docs named the POST field wrong;
- an approval could be replayed after a revoke for the same set;
- there is no owner-epoch fence.

All but the epoch fence were fixed in code with tests. The epoch fence is accepted and documented in section 2.

Round 2 verdict was concern. It confirmed fixes 2–5 and found two remaining problems:
- the service fell back to unapproved work in the same run;
- approved ids kept priority indefinitely.

Both were fixed: approved items are exclusive until each is attempted once, then they keep no lasting priority. The prior-record marker in the hash closes replay after revoke. The unit test `FeedbackDrainService live claims honour the approved batch` and the integration test for replay after revoke cover these.

Round 3 verdict was concern:
- a retry-only approved batch was not exclusive;
- the timestamp marker could repeat;
- a revoke mid-run did not stop claims;
- section 2 overstated the posture of other routes.

All fixed: exclusivity now means "claimed since the approval" for queued and retryable items; the marker carries a random per-promotion nonce; claims re-check `isConsumerLive()`; section 2 was reworded. A unit test covers the retry case.

Round 4 verdict was concern, about two run races:
- a claim timestamped at run start could predate an approval made during that run;
- a revoke followed by a re-promotion inside one run could leave the old run claiming under the old batch.

Both were fixed. The time-based part was later replaced by attempt baselines (see round 6). Each claim checks that the approval nonce is unchanged since the run began and stops if not. A unit test covers this.

Round 5 verdict was concern about one edge: an approval in the same millisecond as the run start. Fixed by changing the check to `approvedAtMs >= now`.

Round 6 verdict was concern: after a failover, a claim timestamp from an old owner's skewed clock could make an approved retry item look already tried. Fixed by dropping time-based exclusivity. The record stores each approved item's attempt count at approval, and an item stays exclusive while its attempt count is unchanged. The run-start time check is no longer needed, because claims are judged by attempts and the per-claim nonce check still stops a run when the approval changes. A unit test with a far-future `claimed_at` covers it.

Round 7 verdict was concern:
- holding every approved item emptied the exclusive set and let unseen work be claimed;
- records missing attempt baselines could still go live.

Both were fixed. Held approved items stay outstanding, and the consumer claims nothing while the approved batch is outstanding but unclaimable. `isProposalBound` requires an integer baseline for every approved id. Unit tests cover the held case and the missing-baseline case.

Round 8 verdict was concern: releasing a hold leaves the old approved row held, so the consumer stays stalled until the operator revokes and re-promotes. This is the documented safe-direction over-block (section 1), now described accurately; unseen work is never claimed. Accepted, with the docs corrected.

Final disposition: concur that no path remains for a promotion to approve or claim work the operator did not see; the remaining items are documented trade-offs (sections 1 and 2).

## Evidence pointers

- Unit: `tests/unit/feedback-consumer-promotion-proposal.test.ts`, 12 passed.
- Integration: `tests/integration/feedback-consumer-promotion-proposal.test.ts`, 5 passed:
  - states and precedence
  - stale and invented hash 409
  - replay refused
  - dryRun-true-with-record
  - dryRun-false-with-revoked-record
  - non-owner proxy and stale
- E2E: `tests/e2e/feedback-factory-drain-lifecycle.test.ts` checks route alive (200, not 503), the real promote, and replay 409. Also updated: `feedback-triage-lifecycle`, `feedback-execute-lifecycle`, `feedback-drain-live-shapes`.
- Related unit files: 209 files with 2,770 tests. All feedback integration files: 19 with 95 tests. All feedback e2e files: 13 with 55 tests. All passing.
- `npm run lint:parallel`: 55 of 55 passed.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is a missing server check against the design doc, not a prompt, hook, config, skill or standards-text defect, and it adds no self-triggered controller.

# Side-Effects Review — Auto-expiry review ledger and honest eligibility (CMT-1118)

**Version / slug:** `auto-expiry-review-ledger`
**Date:** `2026-10-28`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1, about 8 source/test files, ~350 added lines. Both auto-expiry sweeps
(`CommitmentTracker.sweepAutoExpiry`, `EvolutionManager.runActionAutoExpirySweep`)
now append the ids they would expire (dry-run) or did expire to a per-feature
JSONL ledger under `<stateDir>/logs/`, via the new `src/core/AutoExpiryLedger.ts`.
The commitment agent-branch rule now skips any row with `blockedOn` other than
`none` and other-origin rows, measures age from the later of creation and the
last dependency probe, and replaces the "presumed completed" resolution with an
opt-out-citing or outcome-unknown note. The evolution rule now also retains
`high` actions and dated actions overdue by less than `maxAgeDays`. No defaults
change; both sweeps stay `dryRun: true`. One CLAUDE.md awareness bullet with
migration and shadow parity. Effort: one spec review round, normal commit flow.

## Decision-point inventory

- `CommitmentTracker.autoExpiryDisposition` (was `isAutoExpiryEligible`) — modify — narrows which agent-owned rows the sweep may expire; adds a class and an honest reason.
- `EvolutionManager.runActionAutoExpirySweep` eligibility loop — modify — narrows which pending actions are eligible.
- `AutoExpiryLedger.record` — add — observability only; decides nothing.

---

## 1. Over-block

The change only narrows eligibility, so it cannot expire anything that was not
already eligible. The new "retained" cases: an agent row blocked on external or
on the user (now never swept by the agent rule; external has its own dead-letter
path, user-* the operator-wait branch, which still runs by default); a row whose
dependency was probed within the bound; a peer machine's row; `high` actions; a
dated action overdue by under 21 days. Each of these is a record somebody else
(or a newer signal) is responsible for. A genuinely abandoned `high` action now
stays in the queue; it is still surfaced by the undated resurfacer or the
overdue check.

---

## 2. Under-block

- An agent row stuck at `blockedOn: external` forever is not expired here; it
  relies on the external-block dead-letter path, which surfaces but does not
  close. That is the intended owner.
- With operator-wait disabled, rows blocked on the user stay open indefinitely
  — the operator chose that by disabling the branch.
- `lastHeartbeatAt` (beacon bookkeeping) is deliberately NOT treated as
  activity: it fires automatically and would make every beacon-enrolled row
  immortal.
- The ledger's "unchanged" short row relies on an in-process hash; after a
  restart the first sweep writes the full list again, which is correct but
  repeats it once.

---

## 3. Level-of-abstraction fit

Correct layer. Each tracker owns its own eligibility and lifecycle; the ledger is
a small shared writer both call at the end of a sweep, following the existing
`StandDownAudit` JSONL pattern (`<stateDir>/logs/*.jsonl`, `.1` rotation). A
route was considered and not added: the file is the review surface the flip rule
needs, and the awareness line points agents at it.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface.

The sweeps hold narrow lifecycle authority (already existing, already dry-run by
default). This change only reduces that authority's reach and adds a signal (the
ledger) for the human review that gates the dry-run flip.

## 4b. Judgment-point check

No new static heuristic at a competing-signals point. The eligibility fields
are structured declarations the agent made itself (`blockedOn`, opt-out reason,
probe time); honoring them removes a heuristic override of those declarations.

---

## 5. Interactions

- **Operator-wait branch:** unchanged and still judged first. A user-blocked
  row that the operator-wait branch does not take (disabled) no longer falls
  through to the agent rule.
- **External-block dead-letter (`agentOwnedFollowthrough`):** now the sole owner
  of `blockedOn: external` rows.
- **Write coalescing:** the ledger append happens after the batched store write,
  outside `beginSaveBatch/finishSaveBatch`; it writes a separate file and never
  touches the commitment store. The existing "one store write per sweep" test
  still passes.
- **Evolution replication tombstones:** unchanged; only the eligible set is
  smaller.
- **Undated resurfacer / overdue check:** `high` and freshly-overdue actions now
  stay for them to surface instead of being deleted underneath them.
- **Log line:** the commitment sweep's console summary is unchanged; tests that
  count console.log calls still see exactly one.

---

## 6. External surfaces

- New files: `<stateDir>/logs/commitments-auto-expiry.jsonl`,
  `<stateDir>/logs/evolution-actions-auto-expiry.jsonl` (+ `.1`). Contents: ids,
  ages, classes, resolution text (which can quote a commitment's own opt-out
  reason, truncated to 200 chars). No user text beyond that reason, no secrets.
- Resolution text of auto-expired commitments changes wording (visible via
  `GET /commitments/:id`). Only agents that already set `dryRun: false` see it.
- One CLAUDE.md bullet appended for existing agents.

## 6b. Operator-surface quality

Not applicable — no dashboard or approval surface touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** Each machine sweeps only the records it owns (the
commitment rule now explicitly skips rows originated elsewhere, matching the
operator-wait branch), so each machine's ledger is the exact list that machine
could expire. No user-facing notices, no URLs, no state that follows a topic.

---

## 8. Rollback cost

Pure code revert, ship as next patch. The ledger files are append-only logs and
can stay on disk. The CLAUDE.md bullet would remain on migrated agents (harmless
pointer to files that stop growing). No data migration.

---

## Conclusion

The review narrowed the design once: `lastHeartbeatAt` was considered as an
activity signal and rejected (it would make every beacon row immortal). Clear to
ship as Tier 1; behavior on default installs is unchanged except for the new
ledger files.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the artifact: concern → resolved, concur**

- Concern: the commitment ledger row's `dryRun` reported only the agent branch,
  so with operator-wait live a row could read `dryRun: true` with `expired > 0`.
  Resolved: every item now carries `applied`, and the row carries
  `agentEnabled` / `operatorWaitEnabled` / `operatorWaitDryRun`; a unit test
  covers the mixed-mode case.
- Minor: the first empty sweep after a start also writes an `eligible: 0` row;
  spec and header comment now say so.
- Reviewer confirmed: narrowing only, evolution date checks correct, applied
  rows list the expired ids, side-effects claims accurate.

---

## Evidence pointers

- Live measurement before the change (this agent, 2026-10-28): commitments 412
  eligible of 1119 (398 blockedOn none, 14 external; 21 opted-out; 5 other-origin);
  evolution 44 eligible of 300 (19 high, 43 dated). After: evolution 17.
- Tests: unit `CommitmentTracker-auto-expiry`, `commitment-operator-wait-expiry`,
  `evolution-action-auto-expiry-ledger`, `evolution-manager-action-replication`,
  `PostUpdateMigrator-autoExpiryLedgerAwareness`, `feature-delivery-completeness`,
  `PostUpdateMigrator-shadowCapabilities`; integration
  `evolution-action-auto-expiry`, `commitment-auto-expiry-lifecycle`; e2e
  `commitment-auto-expiry-api-lifecycle` — all green.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (this modifies an existing
  self-triggered controller: the two expiry sweeps).
- **`closure`** — `n/a` for new authority: the change only narrows an existing
  controller's target set and adds no new action, trigger, or cadence.
  Convergence: control-loop edge unchanged (timer → sweep → expire); steady-state
  bound unchanged (commitment cap 500 per sweep, evolution ≤ maxActions); settling
  brake unchanged (dry-run default; an expired row leaves the eligible set, so a
  second sweep over the same state does nothing — covered by the existing
  idempotency test). Ratchet: `tests/unit/self-action-convergence.test.ts`.

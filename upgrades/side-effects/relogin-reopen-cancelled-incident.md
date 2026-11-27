# Side-Effects Review — Reopen an incident that admission bookkeeping cancelled while the account is still signed out

**Version / slug:** `relogin-reopen-cancelled-incident`
**Date:** `2026-11-26`
**Author:** `echo (Subscription Management, Mac M5 Pro)`
**Second-pass reviewer:** `not required (Tier 1 data-path fix; no gate, sentinel or session lifecycle change)`

## Summary of the change

`SubscriptionLoginLedger.reconcileAdmission` now reopens a cell's latest incident when that incident was closed `cancelled`, the cell has no open incident, and the pool still marks the account `needs-reauth` (a new optional `needsReauth` flag that `QuotaPoller.pollAll` passes). The incident keeps its original cause, corroboration and provenance, and a `relogin-reopened` event is written. `SubscriptionReloginStore.suggest` also re-admits, once per row, a repair that was cancelled mid-run because its incident closed (event `candidate-readmitted-source-reopened`, also an admission marker). Tier 1: 3 source files, about 80 lines, plus a unit test, spec, ELI16 and release note; 3 review rounds.

## Decision-point inventory

- Reopen-or-not for an admitted signed-out cell with a cancelled latest incident: invariant (enumerable: incident outcome by status, plus no clean coverage since).
- Re-admit a source-closed cancelled repair: invariant, at most once per row.

## 1. Over-block

None. The change only reopens; it never closes or refuses anything.

## 2. Under-block

- A cell evicted for being past the 64-cell limit and never re-admitted stays closed. That is unchanged and correct, since it is not polled.
- An incident that was closed `resolved` by a mistaken clean read is not reopened; the next real failure opens a new one, as today.
- The cause of the original drop-out is not addressed here; that is tracked as CMT-040.

## 3. Level-of-abstraction fit

The ledger owns incidents, and `reconcileAdmission` is where the cancel happens, so the restore belongs in the same transaction. The poller already reads the pool status it passes.

## 4. Signal vs authority compliance

No new authority. Reopening restores a record that existing rules (the repair admission check, the slow retry) already read. Those rules keep their own checks.

## 4b. Judgment-point check (Judgment Within Floors standard)

Not a competing-signals point: the inputs are two enumerable states.

## 5. Interactions

- **Slow retry:** it resumes for the failed repair row, which needs an open source incident and an attempt not challenged since admission. Its existing limits apply: at most 3 retries per incident, with delays.
- **Admission check:** it is unchanged and still requires an exchange-corroborated, observed incident, which the reopened record keeps.
- **`recordStatus('active')`:** it still resolves the reopened incident on a clean read.
- **No loop:** a resolved incident is never reopened, and an open one is left alone. A repair cancelled by a closed incident is re-admitted at most once per row, which bounds a flapping cell to one extra drive.
- **Challenge reset:** the re-admission marker resets an earlier challenge on that row, once. This is accepted and stated in the spec's Risks.

## 6. External surfaces

There is no new route, setting or notice. The new ledger event `relogin-reopened` appears in `GET /subscription-pool/login-history`, and repairs may resume on cells that were stuck.

## 6b. Operator-surface quality

Not applicable: no operator surface changes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local, physical-credential-locality: each machine's ledger tracks the logins on its own disk and reopens only its own cells. It sends no notices and generates no URLs.

## 8. Rollback cost

Revert the PR. Any incident it reopened stays open until a poll resolves it, which is the correct state for a signed-out account. There is no data migration.

## Conclusion

This is a narrow fix that restores a state the existing repair rules depend on. It is clear to ship once Local Verify passes.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is a data-path bug in ledger bookkeeping, not a prompt, hook, config, skill or standards text, and it adds no self-triggered action.

## Evidence pointers

- Mac Mini: incident 32 (`/subscription-pool/login-history`), cancelled at 03:55:58Z; repair 07a05cb5's events show `slow-retry-unscheduled` at 03:56:09Z.

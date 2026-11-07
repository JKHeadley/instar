# Side-Effects Review — Executor restart hold

**Version / slug:** executor-restart-hold
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** independent Claude subagent (see below)

## Summary of the change
Tier 1, 4 runtime files plus unit and integration coverage, about 35 runtime lines. Fixes the adoption check for a finished fix waiting to be re-verified, adds `restartHolds()` registered with the AutoUpdater, and makes the executor's update brake read a waiting restart. Effort: no spec rounds; one review round changed the design and the account of the incident.

## Decision-point inventory
- Adoption of a same-machine attempt after an epoch rise — modify: one shared check; a `running` re-verify row with its review tree and publish clone is adoptable.
- Update restart admission — pass-through: the existing hold path gains one provider.
- `executorUpdatePending` brake — modify: also true while a restart deferral or activation is pending, matching Local Verify.

## 1. Over-block
An update restart can wait up to two hours per attempt. The deferral ceiling (`maxDeferralHours`, 4 by default) is per target version, so a new release during a hold starts a fresh ceiling. The brake stops new attempts while a restart waits, so one attempt's hold is the usual maximum. The brake also delays new attempts briefly around every update. Threadline connect-enable consults holds through its restart-blocker check and can give up after its 5-minute limit during a long verification. A forced restart overrides holds.

## 2. Under-block
The supervisor's unresponsive restart and other restart flag writers do not read holds, so they can still interrupt setup and verification. That is the larger real cause and is handled separately. Holds are not rechecked after the updater's check passes, so a verification can begin in that short gap. A second interruption of verification still ends the attempt as interrupted.

## 3. Level-of-abstraction fit
The hold mechanism exists for in-memory work a restart would lose. The adoption rule is now in one place instead of two that had diverged.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. Deterministic facts feed existing authorities. A provider that throws holds nothing, so a fault cannot strand an update.

## 4b. Judgment-point check
None.

## 5. Interactions
Adoption remains same-machine only. The hold reads SQLite synchronously once per check. A row from a dead process can hold only during the next tick until it is reconciled. The brake blocks claims only, after reconciliation has run, so it cannot deadlock with a hold.

## 6. External surfaces
The updater's status can report a restart deferral naming a feedback attempt. On a machine with the executor enabled, update restarts can come later.

## 7. Multi-machine posture
Machine-local BY DESIGN: a hold only applies to the process running the attempt.

## 8. Rollback cost
Plain revert. Nothing persisted.

## Second-pass review
Concern raised, then addressed (independent subagent). It found my account of the incident was wrong, which led to the adoption fix and the corrected notes; found the brake read false during a deferral (fixed); and found unit tests do not cover a real AutoUpdater with the real executor (not added; existing `AutoUpdater-restart-holds.test.ts` covers the hold path with stub providers). Its synchronous-git lead is being handled in a separate change.

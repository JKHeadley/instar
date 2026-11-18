# Desktop readiness when a check fails

Tier 1. Four production files, four test files, one implementation pass.

## Decision and operator impact

A thrown local helper check, a thrown helper check on a peer, and an unanswered peer request carry a check-failed explanation in the existing unavailableReason field. All three keep ready false. A returned probe still carries its measured reason. An unverified signing key still disables opening and reports the identity problem.

The machine picker exposes its existing Check again button in a mixed list. The user can refresh after a failed check while another machine is ready. No automatic retries or persistent state are introduced. Refresh still uses the existing target-loading and deep-link behavior. New wording for a failure inside the target helper requires updating the target. Older clients continue to receive their existing fields.

## Verification and rollback

An inert route and picker replay reproduced the false status before the change and verified both the failed check and a measured locked-screen response afterward. The three targeted unit files passed all 21 tests. The HTTP fixture for a failed peer followed by a successful check and the boot fixture covering a registered peer before discovery await CI. Returning from a session reuses the snapshot that was checked for staleness. Starting a desktop hides retry, and both manual and deep-link failures restore it when appropriate. Revert the code to restore the prior messages and button visibility.

## Class-Closure Declaration

The defect class is claim-vs-evidence. A rejected probe provides no desktop readiness result. The route regression in `tests/integration/desktop-routes.test.ts` checks that an unanswered peer carries the check-failed reason and that a subsequent ready reply clears it. The picker regression exercises the rendered reason, disabled option, retry and recovery.

## 6b. Operator-surface quality

The primary action remains Open selected machine. Check again is a separate, plainly labeled action. The picker gives each machine its name and repeats the full reason below the selector for phone-width screens. It exposes no raw probe exceptions or machine identifiers. Neither control is destructive. Both a manual open and an automatic deep-link open hide retry for the duration of the request.

The picker captures the currently selectable machine immediately before rebuilding its options. A refresh restores it only if its new row passes the existing readiness and signing-key checks. Otherwise it selects the first usable row and leaves opening it to the person. A deep link retains its existing behavior. The browser regression checks a retained selection and three fallbacks (removed, unavailable, or missing a key).

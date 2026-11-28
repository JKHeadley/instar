# Side-Effects Review — enroll carries the expected email (CMT-059)

## Summary of the change
POST /subscription-pool/enroll passes an expectedEmail to EnrollmentWizard.start: the body's value, or else the pool account's recorded email. A value that differs from a recorded email is refused (409); a non-string is refused (400). One route, one integration test file.

## Decision-point inventory
- New refusal: expected-email-mismatch (409). It is an invariant: a known account's login must be checked against that account's own email, so a caller cannot retarget it. This is deterministic by design.

## 1. Over-block
A caller that deliberately signs a known account in as a different Google identity is now refused. That is the intent: a different identity is a different account and should be enrolled under its own id. Callers that send no expectedEmail are unaffected apart from gaining the default.

## 2. Under-block
An account with no recorded email still starts with no expected email (unchanged), so its completion stays held as before.

## 3. Level-of-abstraction fit
The route already owns turning a request into a start input; the wizard and the follow-me email gate already consume expectedEmail. No new layer.

## 4. Signal vs authority compliance
The completion authority stays the existing follow-me email gate (validateEnrolledAccountEmail), which now receives the email it was built to check. The new 409 is a narrow input-validation floor.

## 4b. Judgment-point check (Judgment Within Floors standard)
Not a judgment point: a string comparison against the record.

## 5. Interactions
With an expected email, start() also records the auth-revision baseline, and the completion sweep can close a stale login when the slot already holds the expected account. Both paths already run for follow-me logins today.

## 6. External surfaces
The 201 response's login now includes expectedEmail when known. It is already on the public pending-login shape; no secret.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
No operator UI change.

## 7. Multi-machine posture (Cross-Machine Coherence)
Machine-local by design: pending logins and pool records are per machine (machine-local-justification: physical-credential-locality).

## 8. Rollback cost
Revert the route hunk; no state migration. Pending logins created with an expectedEmail simply keep it.

## Conclusion
Small, reversible fix to a gap seen live five times today.

## Second-pass review (if required)
Not required (no gate, sentinel or session lifecycle).

## Evidence pointers
tests/integration/subscription-enrollment-routes.test.ts (six new cases).

## Class-Closure Declaration (display-only mirror)
- Trace declaration: defectClass n/a, closure n/a. Reason: an input default and a validation refusal on one route; no self-triggered action.

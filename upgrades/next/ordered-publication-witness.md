<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Added a default-off source checkpoint for independently witnessed Needs-you and app message handover records. It verifies the exact operation and witness transfer against the independent journal floor and leaves mismatched restoration evidence pending. No app or Needs-you route uses this checkpoint.

## Evidence

Focused unit and integration checks cover signature binding, disabled behavior, independent acceptance, witness transfer, replay, and restored journal mismatch using disposable files and keys.

The local receiver also completes an ordered holder change only after the independent journal confirms the signed successor and sealed predecessor.

Added a byte-level verifier for authenticated predecessor seals. A missing read reports unavailable. A partial, reordered or changed prefix remains pending.

Added an exact reconciliation check for an uncertain predecessor append. A visible row or readable absence alone leaves the attempt pending.

The dark receiver can verify a fresh witness readback for the exact private Git destination and commit it observed.

The dark receiver can read the exact configured Git ref directly before requesting a witness readback. Missing refs and same-named refs elsewhere in the repository provide no confirmation.

The dark witness can answer an authenticated peer only after its independent snapshot confirms the challenged commit and witness floor.

The dark witness readback can use a durable snapshot of the accepted commit and journal floor. Reopening the witness store preserves the exact accepted pair.

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Added a default-off source checkpoint for independently witnessed Needs-you and app message handover records. It verifies the exact operation and witness transfer against the independent journal floor and leaves mismatched restoration evidence pending. No app or Needs-you route uses this checkpoint.

## Evidence

Focused unit and integration checks cover signature binding, disabled behavior, independent acceptance, witness transfer, replay, and restored journal mismatch using disposable files and keys.

The local receiver also completes an ordered holder change only after the independent journal confirms the signed successor and sealed predecessor.

Added a byte-level verifier for authenticated predecessor seals. A missing read reports unavailable. A partial, reordered or changed prefix remains pending.

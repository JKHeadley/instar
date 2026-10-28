---
bump: patch
---

## What Changed

The first converted grading job now gets an independently recorded server
receipt for each scheduled run. The scheduler checks that the script's reported
counts match the server's counts before treating that result as supported by
independent evidence. The counts are also available as structured fields to
the later Jev check. A missing or mismatched receipt leaves the result open.
The Jev result-decision gate remains off pending outcome grading and rollout
evidence.

## What to Tell Your User

The grading job now has a stronger check on its own "OK" result. The server
confirms that the requested work completed and that the reported counts match.
Jev is still off until the broader result-supervision proof is complete.

## Summary of New Capabilities

- The first converted script can provide independent evidence for a result;
  other scripts still need their own verified evidence before routine closure.

## Evidence

Unit tests cover token mismatch, count mismatch, restart persistence, schema
migration, and a late receipt. The authenticated route test covers forged and
valid receipts.
The full installed-script lifecycle test checks a real run obtains sufficient
evidence from the server-owned receipt while its supervision status remains
unchecked with the model gate dark.

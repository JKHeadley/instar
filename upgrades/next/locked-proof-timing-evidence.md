## What Changed

Internal: Before-Enter locked-Mac checks now require finite, consistent timestamps from the same approved grant and duty. Non-deadline interruptions must start and finish before the recorded Enter time; deadline checks use the approved grant expiry. Missing Enter reports unmeasured, including when the UI reports an abort. Extra diagnostic fields cannot turn a late interruption into successful proof.

## What to Tell Your User

The locked-Mac test runner now rejects timing it cannot establish, including an interruption that starts before Enter but finishes afterward. This corrects test evidence; it does not change remote desktop lock behavior or enable locked-screen access.

## Summary of New Capabilities

None. Existing proof checks now require sufficient raw timing evidence. No native helper changes, migrations, or product restarts.

## Evidence

92 targeted simulated unit tests pass across two files and cover raw identity, finite start/completion/Enter, late and equal completion, missing Enter, forged metrics, and approved grant expiry. No live Mac proof or integration/E2E execution is claimed; full verification belongs to Local Verify.

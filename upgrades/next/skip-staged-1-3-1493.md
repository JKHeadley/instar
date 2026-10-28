---
bump: patch
---

## What Changed

The next release starts at 1.3.1494 because npm accepted 1.3.1493 as a
staged publish but did not make it available for installation. Later publish
runs received a 409 conflict when they tried to reuse 1.3.1493. This version
bump lets the already merged job-supervision audit and grading changes ship.

## What to Tell Your User

The release pipeline got stuck on an unavailable npm version. The next
published release skips that number and includes the merged changes.

## Summary of New Capabilities

- Release publication can proceed past the unavailable 1.3.1493 version.

## Evidence

The earlier publish run completed its upload, then its clean-install check
could not find 1.3.1493. Later runs failed with npm E409. The registry still
reports 1.3.1492 as latest. The normal release smoke test will verify 1.3.1494.

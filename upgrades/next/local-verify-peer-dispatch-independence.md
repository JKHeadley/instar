# An idle peer can check a PR while the Studio slot is occupied

<!-- bump: patch -->

## What Changed

Local Verify's coordinator now offers an eligible queued PR to an idle peer even when an unrelated full test suite occupies its own slot. Its normal pump gets the first chance to start local work. Main-branch checks stay local, and the existing lease, update pause, peer version, eligibility, and durable reservation rules still govern dispatch.

## What to Tell Your User

The Mac Mini no longer needs the Studio to start a merge check before it can take a waiting PR. When another full suite has the Studio's only test slot, the Mini can still work on an eligible PR. The Studio remains in charge of merging and keeps main-branch checks.

## Summary of New Capabilities

- An idle peer can verify an eligible queued PR while an unrelated suite occupies Studio's local slot.
- Studio releases its next-slot priority claim as soon as no locally runnable verification remains.

## Evidence

Two regression tests reproduced the idle-peer gap before the code change and passed after it. Focused integration, production lifecycle, full-suite, and CI results are release gates.

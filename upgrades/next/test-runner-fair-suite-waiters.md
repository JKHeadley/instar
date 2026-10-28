# Waiting full test suites now take turns instead of starving

## Summary of New Capabilities

A full test suite waiting for the machine's single suite slot now gets its turn. An ordinary suite that has waited 15 minutes goes ahead of merge-gate verification for the next slot. After that comes merge-gate work, then the other waiting suites in arrival order. `GET /test-runner-limiter` now lists the waiting suites (`suiteWaiters`), next first, and a waiting run's progress line says how many are ahead of it.

## What Changed

- A suite run that has to wait now leaves a small ticket under `~/.instar/host-test-runner-waiters/` and renews it every poll (60-second lease). It removes the ticket when it starts, gives up, or fails open. Dead, expired, corrupt and other-host tickets are ignored, and the store is bounded to 64 files.
- When the slot frees, the next run is chosen by ticket order instead of by whoever polls first. An ordinary suite that has waited 15 minutes stops yielding to Local Verify's claim and goes first.
- The full-suite cap stays at one. Targeted runs (5 files or fewer) are unchanged. An older checkout on the same host ignores the tickets and behaves as before.
- New `suiteWaiters` field on `GET /test-runner-limiter`. The CLAUDE.md template, the capability index, and a CLAUDE.md migration for existing agents describe it.

## Evidence

On 2026-10-28 a live Mac desktop check waited more than 50 minutes behind three Local Verify suites in a row, and a later end-to-end stage waited 32 minutes and was stopped. A unit test replays this case: a coordinator claim stays live the whole time, the running verify finishes 20 minutes in, and the next verify asks first. The waiting ordinary suite gets the slot and the verify is refused. With the ordering code disabled, that test and two other ordering tests fail. Integration and end-to-end tests cover the new route field.

## What to Tell Your User

When I run a full test suite and the machine's test slot is busy, I now wait my turn in a fair line. A long merge-verification queue can no longer keep a live check waiting indefinitely: after 15 minutes of waiting, my run goes next.

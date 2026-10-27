<!-- bump: patch -->

## What Changed

- Fixed the Local Verify suite-priority handoff so its claim stays active while the verify child installs, builds, and lints. This prevents an ad-hoc full suite from taking the test slot during preparation and requeueing the merge-gate run.
- The service clears its preparation claim after it observes the child holding a suite slot, leaving spare slots available on hosts configured for more than one full suite. Cancellation, completion, and shutdown clear the claim.
- Updated the agent template and existing-agent migration to explain why an ordinary full suite can wait with no visible slot holder.

## What to Tell Your User

Pull requests waiting to merge now get the next full-test slot even while their verifier prepares. Other full test runs may wait until that verifier starts its tests; small targeted tests still have their own lane. A stalled reservation expires automatically.

## Summary of New Capabilities

- Merge-gate priority now covers verify setup on the coordinator and peer machines.

## Evidence

The observed Studio failure was a Local Verify child requeueing after an ad-hoc full suite took the slot during setup. Focused unit and migration tests pass (159 checks). The limiter route integration test passes (15 checks), and production lifecycle E2E tests pass (16 checks) on the M5. The full unit tier passes (51,860 checks) on the committed branch. Independent review found and closed the spare-slot issue on hosts configured for two suites.

<!-- bump: patch -->

## What Changed

When the pre-push smoke runner cannot work out which tests a change affects (the listing times out), it now exits with a code of its own (3), and the pre-push hook says the push was blocked because the smoke run could not be verified and zero tests ran. Before, the hook printed "Tests failed after smoke runner retry" for this case, which sent people looking for a failing test that did not exist. The hook also no longer says "retrying once" when no retry follows.

## What to Tell Your User

Nothing changes for agents in normal use. Developers pushing to instar now see an accurate message when the local smoke check could not run, instead of a false "tests failed".

## Summary of New Capabilities

Pre-push output now tells "a test failed" apart from "no tests could be selected, so nothing ran".

## Evidence

The hook's test block was run under `sh` with stub exits 3, 1 and 0 in both retry modes, and each printed the right message. The real script was run with a fake `npx`: a listing killed by SIGTERM exits 3 with VERIFY, and a listing that itself exits 3 now exits 1.

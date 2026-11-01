# Secret sync no longer reports a false failure for a slow machine

<!-- bump: patch -->

## What Changed

Pushing the secret set to another machine (`POST /secrets/sync-now`, and the boot-time push) now waits up to 30 seconds for each machine's answer instead of the general 5-second mesh limit. A WSL machine was storing every push while the sender reported it as aborted.

## What to Tell Your User

Nothing to do. If a secret seemed not to reach one of your machines, it may have arrived anyway; the status now says so correctly.

## Summary of New Capabilities

None; a correctness fix.

## Evidence

The receiving machine's log showed every push stored while the sender reported "aborted"; one call site now passes a 30-second timeout.

## What Changed

The migration package test reuses the build that Local Verify prepares before starting its test lanes. It no longer rewrites that build while the conversation graph test copies it.

## What to Tell Your User

The conversation graph check is less likely to report a failure caused by another test rebuilding the same files.

## Summary of New Capabilities

Parallel verifier lanes can share the prepared build without the migration package test overwriting it.

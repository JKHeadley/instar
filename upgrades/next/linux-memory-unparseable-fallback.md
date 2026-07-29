# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Linux memory parsing now rejects `/proc/meminfo` content with no parseable
`MemTotal`. The existing logged RSS fallback then supplies the reading instead
of returning a fabricated zero-percent pressure measurement.

## What to Tell Your User

Malformed Linux memory output no longer makes the host look perfectly healthy;
the same visible fallback already used for read failures now takes over.

## Summary of New Capabilities

- Parseability validation for Linux total-memory output.
- Existing conservative fallback reused for successful-but-malformed reads.

## Evidence

- Tests cover direct parser rejection and the real reader-to-fallback path.
- Restoring the zero fallback produces two direct failures.
- Twenty-five focused tests and full repository lint pass.

# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

The GitHub Actions merge tests select Actions mode and run from a private installed-agent directory. This keeps the developer’s agent configuration and live verification server outside the fixture.

## Evidence

The six existing Actions cases cover pending checks, missing checks and a complete set of checks from the required producers. The local verification fixture exercises the separate server-backed checks.

All 24 integration cases passed together on the combined change.

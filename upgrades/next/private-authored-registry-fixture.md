# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Give the standards-registry mismatch test a private authored source fixture. Preserve the real packed resolver and auditor, the live article-count invariant, and explicit checks that the checkout registry stays unchanged during the private edit. This removes a shared-file mutation that could collide with parallel registry readers.

## Evidence

Independent source review concurs. One coordinator-authorized focused invocation of both complete registry unit files passed 67 tests with zero failures, zero skips and zero unhandled errors, exit 0. Complete verification remains throughput-owned. No production behavior or live state changes.

## What to Tell Your User

Release verification is more reliable because parallel registry tests now keep their temporary edits private. No user action is needed.

## Summary of New Capabilities

No new product capability. This internal test repair preserves the real standards auditor and live article-count checks while avoiding shared authored-file edits.

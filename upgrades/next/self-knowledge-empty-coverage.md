# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Self-knowledge validation now reports `coverageScore: null` when a tree contains
no nodes. The audit result and HTTP health response preserve that state, and
the machine check renders `coverage n/a` instead of `0% coverage`.

## What to Tell Your User

An empty self-knowledge tree no longer looks like a measured zero-percent
coverage result; the health surfaces say coverage is unavailable.

## Summary of New Capabilities

- Explicit unmeasured coverage for zero-node trees.
- Consistent audit, API, and CLI presentation of the missing denominator.

## Evidence

- Validation and audit tests cover a valid zero-node tree.
- Twenty-eight focused tests and full lint pass.
- Restoring the old zero fallback makes the validation test fail.

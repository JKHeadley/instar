# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Trust-elevation acceptance statistics now return null overall and recent rates
before any proposal is decided. The existing minimum-decision gates remain in
place and explicitly reject the unmeasured state before suggesting an autonomy
or profile elevation.

## What to Tell Your User

A fresh evolution history no longer looks like it has a measured zero-percent
acceptance rate, and it still cannot authorize any trust elevation.

## Summary of New Capabilities

- Explicit unmeasured state for empty evolution acceptance history.
- Pinned no-elevation behavior for that state.

## Evidence

- Unit, integration, and end-to-end trust-elevation tests pass.
- Restoring the zero fallback fails the empty-history regression.
- Seventy-four focused tests and full repository lint pass.

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Intent-drift windows now return a null conflict rate when they contain no
decisions. Conflict-spike detection compares rates only when both windows are
measured, and CLI formatting renders an unmeasured rate as unavailable.

## What to Tell Your User

An empty decision window no longer looks like it measured a perfect
zero-percent conflict rate.

## Summary of New Capabilities

- Explicit unmeasured conflict rate for empty intent windows.
- Pinned no-comparison behavior when either window lacks decisions.

## Evidence

- Tests cover fully empty and previous-only journal shapes.
- Restoring the zero fallback produces two direct failures.
- Twenty focused tests and full repository lint pass.

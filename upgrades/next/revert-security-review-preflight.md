# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

This withdraws the optional security review evidence recorder introduced in PR 3719. Its restart verification repeatedly failed to find the expected second evidence packet.

## What to Tell Your User

Security reviews continue on their existing schedule while the optional recorder is repaired.

## Summary of New Capabilities

None. This change withdraws the optional recorder.

## Evidence

The shared main run and its isolated lifecycle retry failed the same assertion. The revert requires normal shared verification.

# Keep a held dashboard refresh from creating another post

## What Changed

When a pinned dashboard-link edit is held or its delivery is uncertain, Instar now
keeps the original message ID and reports the failed refresh. It no longer turns
that failure into a brand-new dashboard post. This reduces the extra sends that
can accumulate during repeated tunnel restarts.

A confirmed missing pinned message can still be replaced, and an unchanged link
remains a quiet no-op. Origin recording, ownership, capacity limits and recovery
budgets remain in force. This patch does not fix false wake detection or guarantee
delivery of a held message.

## What to Tell Your User

A held or uncertain pinned-link edit no longer falls back to creating a new
dashboard post. A held refresh can still leave the existing pinned link stale
until delivery recovers.

Existing agents receive the correction through their normal update and server
restart. No configuration change or queue reset is required.

## Summary of New Capabilities

- Dashboard edits preserve the existing message on held or uncertain outcomes.
- A confirmed missing message can still be replaced; unchanged content stays quiet.

## Evidence

The focused unit, HTTP integration, production-Boot lifecycle and migration tests
pass. Full-suite validation and CI are required before release.

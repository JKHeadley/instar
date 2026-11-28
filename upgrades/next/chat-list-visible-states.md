# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The interactive Conversations list now shows loading and longer-wait explanations, offers failed-read retry, keeps known rows/pins during refresh failure, and distinguishes empty pages from an empty entire list. Temporary503 responses no longer claim the feature is off. Initial, retry, paged and scheduled reads share the same signed read path, with timeout and stale-context protection.

## What to Tell Your User

Conversations now explains when its list is still loading. If it cannot load, you can try again without losing the conversations already shown.

## Summary of New Capabilities

None; this makes existing list reads visible and recoverable. Retry sends no messages and changes no approvals.

## Evidence

Original renderer tests reproduce the missing states. Expanded DOM checks cover paging, pins, partial sources, timeouts, polling, broadcasts, focus and disposal. Existing signed-client, HTTP and production lifecycle checks pass. Normal Chrome scenarios use invented data and verified signed GETs. Complete verification and release are separate requirements.
